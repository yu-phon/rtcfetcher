
import { ITransport, ICodec } from './interfaces';
import { WebRTCTransport } from '../transport/webrtc-transport';
import { QpackCodec } from '../qpack/qpack-codec';
import { QpackContext } from '../qpack/qpack-context';

import { SendStream, ReceiveStream, DataChannelController } from '../../datachannelstream';
import { ProtocolHandler } from './protocol-handler';
import { StreamFactory, IStreamFactory } from './stream-factory';
import { StreamRef } from '../types/stream-ref';
import { IncomingRequest } from '../types/message';
import { RTCResponse } from './rtc-response';
import { traverseAndOptimizeStreams } from '../utils/stream-traversal';

export interface RTCFetcherConfig {
    minBufferSize?: number;
    prefetchPoolSize?: number;
    incomingHighWaterMark?: number;
}

interface RTCFetchOptions {
    signal?: AbortSignal;
}

export class RTCFetcher {
    private transport: ITransport;
    private readonly config: RTCFetcherConfig;

    // Codec
    private codec: ICodec;
    private streamFactory: IStreamFactory;

    // Stream exposing incoming requests
    readonly incomingRequests: ReadableStream<IncomingRequest>;
    private incomingRequestsController?: ReadableStreamDefaultController<IncomingRequest>;

    readonly opened: Promise<void>;

    // Cache reserved channels (streams) to avoid collisions
    private reservedChannels: Map<number, RTCDataChannel> = new Map();

    // Pending Queue for Backpressure
    private pendingChannelQueue: { label: string, controller: DataChannelController }[] = [];

    constructor(
        pcOrTransport: RTCPeerConnection | ITransport,
        config?: RTCFetcherConfig,
        codec?: ICodec,
        streamFactory?: IStreamFactory
    ) {
        this.config = config || {};
        this.streamFactory = streamFactory || new StreamFactory();

        if ('createDataChannel' in pcOrTransport) {
            // Legacy Constructor: RTCPeerConnection
            const pc = pcOrTransport as RTCPeerConnection;
            this.transport = new WebRTCTransport(pc, { prefetchPoolSize: this.config.prefetchPoolSize });

            // Setup Default Codec (QPACK)
            // We need access to channels 1 and 2.
            // We can use the transport we just created.
            // QPACK requires two unidirectional streams in QUIC.
            // In WebRTC (P2P Symmetric), we use Bidirectional DataChannels.
            // ID 1: Encoder Instructions (Bidirectional)
            //   - Local writes Encoder Instructions here.
            //   - Remote writes Encoder Instructions here.
            //   - Local reads Remote's Encoder Instructions from here.
            // ID 2: Decoder Feedback (Bidirectional) - Reserved for future

            const qpackInstructionStream = this.transport.createChannel('qpack-instructions', 1);
            const qpackFeedbackStream = this.transport.createChannel('qpack-feedback', 2);

            const qpackContext = new QpackContext();

            // WebRTC DataChannels are bidirectional.
            // ID 1 (qpack-instructions):
            //   - We write Encoder Instructions to ID 1 (to be read by remote Decoder).
            //   - We read Remote Encoder Instructions from ID 1 (to update our Local Table).
            // ID 2 (qpack-feedback):
            //   - We write Decoder Feedback (ACKs) to ID 2 (to be read by remote Encoder).
            //   - We read Remote Decoder Feedback from ID 2 (to know what remote has processed).
            qpackContext.attachChannels(qpackInstructionStream, qpackFeedbackStream);
            this.codec = new QpackCodec(qpackContext);

        } else {
            // New Constructor: ITransport
            this.transport = pcOrTransport as ITransport;
            if (!codec) {
                throw new Error("Codec must be provided when using custom transport");
            }
            this.codec = codec;
        }

        this.incomingRequests = new ReadableStream<IncomingRequest>({
            start: (controller) => {
                this.incomingRequestsController = controller;
            },
            pull: () => {
                this.pumpIncomingRequests();
            }
        }, {
            highWaterMark: this.config.incomingHighWaterMark ?? 5
        });

        // Setup Transport callback
        this.transport.onIncomingChannel((id, channel, label) => this.handleReservedChannel(id, channel, label));

        this.opened = this.transport.opened;
    }

    public get qpackContext(): QpackContext | undefined {
        if (this.codec instanceof QpackCodec) {
            return this.codec.getContext();
        }
        return undefined;
    }

    private handleReservedChannel(id: number, channel: RTCDataChannel, label?: string) {
        try {
            // Check label to distinguish Request Channel vs Stream Channel
            if (label && ProtocolHandler.isStreamChannel(label)) {
                // This is a stream channel. Do NOT process as Request.
                console.log(`[RTCFetcher] Storing reserved channel for ID ${id} (Label: ${label})`);
                this.reservedChannels.set(id, channel);
                return;
            }

            // Request Channel Logic
            let endpoint = ProtocolHandler.parseRequestLabel(label);

            console.log(`[RTCFetcher] Handle Req Channel ID: ${id}, Label: ${endpoint}`);

            // Initialize Controller Immediately to start buffering data!
            // Pooled channels might have data arriving already.
            const controller = this.streamFactory.createController(channel);

            // Queue it (Backpressure)
            // We now queue the controller instead of raw channel
            this.pendingChannelQueue.push({ label: endpoint, controller });

            // Pump
            this.pumpIncomingRequests();

        } catch (e) {
            console.error('Error handling reserved channel:', e);
        }
    }

    private pumpIncomingRequests() {
        if (!this.incomingRequestsController) return;

        // While stream needs data AND we have pending requests
        while (this.incomingRequestsController.desiredSize !== null &&
            this.incomingRequestsController.desiredSize > 0 &&
            this.pendingChannelQueue.length > 0) {

            const item = this.pendingChannelQueue.shift()!;
            this.createAndEnqueueRequest(item.label, item.controller);
        }
    }

    private createAndEnqueueRequest(label: string, controller: DataChannelController) {
        const channel = controller.underlyingChannel; // For ID access/logging if needed
        const req: IncomingRequest = {
            label: label,
            open: async () => {
                // LAZY READ START
                console.log(`[RTCFetcher] Opening Request: ${label} (ID: ${channel.id})`);

                // Controller is already created and buffering.
                const receiveStream = this.streamFactory.createReceiveStream(controller);

                // Read Body
                const info = await this.bufferAndDecode(receiveStream.readable);
                if (!info) {
                    controller.close();
                    throw new Error("Failed to decode request body");
                }

                const { body } = info;
                const processedBody = await this.processedIncomingBody(body);

                return {
                    req: { label, body: processedBody },
                    res: {
                        send: (responseData: any) => {
                            this.sendResponse(controller, responseData);
                        },
                        close: () => {
                            controller.close();
                        }
                    }
                };
            },
            reject: (_reason) => {
                channel.close();
            }
        };

        this.incomingRequestsController?.enqueue(req);
    }

    private async sendResponse(controller: DataChannelController, data: any) {
        console.log(`[RTCFetcher] sendResponse called for channel ${controller.underlyingChannel.id}`);
        const streams: Map<number, ReadableStream> = new Map();
        // Since we are decoupling transport, we don't manage pre-created channels here as much.
        // We rely on transport.createChannel to give us the right channel.

        const excludedIds = new Set<number>();
        if (controller.underlyingChannel.id !== null) {
            excludedIds.add(controller.underlyingChannel.id);
        }

        const processed = await this.traverseAndExtractStreams(data, async (stream) => {
            // Reserve ID via Transport
            // Note: Transport manages pool.
            const id = await this.transport.reserveId(ProtocolHandler.RES_STREAM_LABEL, excludedIds);
            excludedIds.add(id);

            streams.set(id, stream);
            return new StreamRef(id);
        });

        const encoded = this.codec.encode(processed);
        console.log(`[RTCFetcher] Encoded response. Size: ${encoded.byteLength}`);

        const sendStream = this.streamFactory.createSendStream(controller, this.config.minBufferSize);

        // Open stream channels and Signal READY
        const streamReadyPromises: Promise<void>[] = [];
        streams.forEach((stream, id) => {
            const sChannel = this.transport.createChannel(ProtocolHandler.RES_STREAM_LABEL, id);
            const sStream = this.streamFactory.createSendStream(sChannel, this.config.minBufferSize);
            stream.pipeTo(sStream.writable).catch(e => console.error(e));

            streamReadyPromises.push(this.transport.sendReadySignal(id, ProtocolHandler.RES_STREAM_LABEL));
        });
        await Promise.all(streamReadyPromises);

        try {
            const lenBytes = new Uint8Array(4);
            new DataView(lenBytes.buffer).setUint32(0, encoded.byteLength, true);

            console.log(`[RTCFetcher] Writing response length...`);
            await sendStream.write(lenBytes);
            console.log(`[RTCFetcher] Writing response body...`);
            await sendStream.write(encoded);
            console.log(`[RTCFetcher] Response written successfully.`);
        } catch (e) {
            console.error('[RTCFetcher] Error sending response:', e);
        } finally {
            console.log(`[RTCFetcher] Closing request channel ${controller.underlyingChannel.id}`);
            controller.close();
        }
    }

    private async processedIncomingBody(obj: any): Promise<any> {
        if (obj instanceof StreamRef) {
            return new ReadableStream({
                start: (controller) => {
                    const channel = this.getOrOpenChannel(obj.id);
                    const s = this.streamFactory.createReceiveStream(channel);
                    s.readable.pipeTo(new WritableStream({
                        write: c => controller.enqueue(c),
                        close: () => controller.close(),
                        abort: e => controller.error(e)
                    }));
                }
            });
        }

        if (Array.isArray(obj)) return Promise.all(obj.map(o => this.processedIncomingBody(o)));
        if (obj && typeof obj === 'object') {
            if (obj instanceof Blob || obj instanceof Uint8Array || obj instanceof ArrayBuffer) return obj;
            const newObj: any = {};
            for (const k in obj) newObj[k] = await this.processedIncomingBody(obj[k]);
            return newObj;
        }
        return obj;
    }

    private getOrOpenChannel(id: number): RTCDataChannel {
        if (this.reservedChannels.has(id)) {
            console.log(`[RTCFetcher] getOrOpenChannel Hit: Reusing reserved channel for ID ${id}`);
            const channel = this.reservedChannels.get(id)!;
            this.reservedChannels.delete(id);
            return channel;
        }
        console.log(`[RTCFetcher] getOrOpenChannel Miss: Creating new channel for ID ${id}`);
        // Use default label 'stream' for anonymous streams
        return this.transport.createChannel(ProtocolHandler.STREAM_LABEL, id);
    }

    private async bufferAndDecode(stream: ReadableStream<Uint8Array>): Promise<{ label: string, body: any } | null> {
        const reader = stream.getReader();
        const readExact = async (n: number): Promise<Uint8Array | null> => {
            const buf = new Uint8Array(n);
            let offset = 0;
            while (offset < n) {
                const { done, value } = await reader.read();
                if (done) return null;

                const needed = n - offset;
                const take = Math.min(needed, value.byteLength);
                buf.set(value.subarray(0, take), offset);
                offset += take;

                if (value.byteLength > take) {
                    console.warn('Excess data in Request Channel');
                }
            }
            return buf;
        };

        try {
            console.log(`[bufferAndDecode] Reading Header (4 bytes)...`);
            const header = await readExact(4);
            if (!header) {
                console.warn(`[bufferAndDecode] Failed to read header (EOF)`);
                return null;
            }

            const len = new DataView(header.buffer).getUint32(0, true);
            console.log(`[bufferAndDecode] Header read. Body Length: ${len}`);

            const bodyBytes = await readExact(len);
            if (!bodyBytes) {
                console.warn(`[bufferAndDecode] Failed to read body (EOF). Expected ${len} bytes.`);
                return null;
            }
            console.log(`[bufferAndDecode] Body read (${bodyBytes.byteLength} bytes). Decoding...`);

            const decoded = await this.codec.decode(bodyBytes);
            console.log(`[bufferAndDecode] Decoded:`, decoded);

            if (decoded && typeof decoded === 'object') {
                return decoded;
            }
        } catch (e) {
            console.error('Error bufferAndDecode:', e);
            return null;
        } finally {
            reader.releaseLock();
        }
        return null;
    }

    public async fetch(label: string, body: any, options?: RTCFetchOptions): Promise<RTCResponse> {
        if (options?.signal?.aborted) {
            throw options.signal.reason || new Error('Aborted');
        }
        await this.opened;

        // 1. Reserve Request ID (via Transport, manages pool)
        // Note: Transport needs to know excluded IDs?
        // Negotiator inside transport knows about its own pool + getStats.
        // It might NOT know about "ids we are about to use for streams" in this very request.
        // But here we reserve Req ID first.
        const reqLabel = ProtocolHandler.formatRequestLabel(label);
        const reservedId = await this.transport.reserveId(reqLabel, new Set());

        // 2. Prepare Body
        const streams: Map<number, ReadableStream> = new Map();
        const streamCache: Map<ReadableStream, StreamRef> = new Map();

        const excludedIds = new Set<number>([reservedId]);

        const processedBody = await this.traverseAndExtractStreams(body, async (stream) => {
            if (streamCache.has(stream)) return streamCache.get(stream)!;

            const streamId = await this.transport.reserveId(ProtocolHandler.STREAM_LABEL, excludedIds);

            excludedIds.add(streamId);
            streams.set(streamId, stream);
            const ref = new StreamRef(streamId);
            streamCache.set(stream, ref);
            return ref;
        });

        // 3. Create Channel
        console.log("Reserved ID (Local):", reservedId);
        const mainChannel = this.transport.createChannel(reqLabel, reservedId);
        const controller = this.streamFactory.createController(mainChannel);

        // Abort Logic
        const signal = options?.signal;
        const abortHandler = () => {
            console.log(`[RTCFetcher] AbortSignal fired. Closing request channel ${reservedId}`);
            controller.close();
        };
        if (signal) {
            signal.addEventListener('abort', abortHandler);
            controller.underlyingChannel.addEventListener('close', () => {
                signal.removeEventListener('abort', abortHandler);
            });
        }

        const sendStream = this.streamFactory.createSendStream(controller, this.config.minBufferSize);

        // 4. Signal Ready
        await this.transport.sendReadySignal(reservedId, reqLabel);

        // Create ReceiveStream AFTER signaling ready (ensures Server knows about channel before Credit arrives)
        const responseReader = this.streamFactory.createReceiveStream(controller);

        const encoded = this.codec.encode({ label, body: processedBody });

        if (controller.readyState !== 'open') {
            await new Promise<void>((resolve, reject) => {
                const onOpen = () => { cleanup(); resolve(); };
                const onError = (_e: Event) => { cleanup(); reject(new Error('DataChannel error while waiting for open')); };
                const cleanup = () => {
                    controller.underlyingChannel.removeEventListener('open', onOpen);
                    controller.underlyingChannel.removeEventListener('error', onError);
                }
                controller.underlyingChannel.addEventListener('open', onOpen);
                controller.underlyingChannel.addEventListener('error', onError);
            });
        }

        const streamReadyPromises: Promise<void>[] = [];
        streams.forEach((stream, id) => {
            const channel = this.transport.createChannel(ProtocolHandler.STREAM_LABEL, id);
            const sStream = this.streamFactory.createSendStream(channel, this.config.minBufferSize);
            stream.pipeTo(sStream.writable).catch(e => console.error(e));
            streamReadyPromises.push(this.transport.sendReadySignal(id, ProtocolHandler.STREAM_LABEL));
        });
        await Promise.all(streamReadyPromises);

        try {
            const lenBytes = new Uint8Array(4);
            new DataView(lenBytes.buffer).setUint32(0, encoded.byteLength, true);
            await sendStream.write(lenBytes);
            await sendStream.write(encoded);
        } catch (e) {
            controller.close();
            throw e;
        }

        return new Promise<RTCResponse>((resolve, reject) => {
            const reader = responseReader.readable.getReader();
            const readExact = async (n: number): Promise<Uint8Array> => {
                const buf = new Uint8Array(n);
                let offset = 0;
                while (offset < n) {
                    const { done, value } = await reader.read();
                    if (done) throw new Error('Unexpected EOF reading response');
                    const needed = n - offset;
                    const take = Math.min(needed, value.byteLength);
                    buf.set(value.subarray(0, take), offset);
                    offset += take;
                }
                return buf;
            };

            (async () => {
                try {
                    const lenBuf = await readExact(4);
                    const len = new DataView(lenBuf.buffer).getUint32(0, true);
                    const bodyBuf = await readExact(len);

                    const resData = await this.codec.decode(bodyBuf);
                    resolve(new RTCResponse(resData, (ref) => {
                        return new ReadableStream({
                            start: (c) => {
                                const ch = this.getOrOpenChannel(ref.id);
                                const rs = this.streamFactory.createReceiveStream(ch);
                                rs.readable.pipeTo(new WritableStream({
                                    write: x => c.enqueue(x),
                                    close: () => c.close(),
                                    abort: e => c.error(e)
                                }));
                            }
                        });
                    }, { encodedSize: len, requestEncodedSize: encoded.byteLength }));
                } catch (e) {
                    reject(e);
                } finally {
                    reader.releaseLock();
                    // Close the request channel as we have received the full response
                    controller.close();
                }
            })();
        });
    }

    private async traverseAndExtractStreams(obj: any, replacer: (s: ReadableStream) => Promise<StreamRef>): Promise<any> {
        return traverseAndOptimizeStreams(obj, replacer);
    }
}
