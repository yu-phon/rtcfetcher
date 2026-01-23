
import { ITransport, ICodec } from './interfaces';
import { WebRTCTransport } from '../transport/webrtc-transport';
import { QpackCodec } from '../qpack/qpack-codec';
import { QpackContext } from '../qpack/qpack-context';

import { SendStream } from '../../datachannelstream/streams/sendStream';
import { ReceiveStream } from '../../datachannelstream/streams/receiveStream';
import { DataChannelController } from '../../datachannelstream/framing/channel-controller';
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

    // Stream exposing incoming requests
    readonly incomingRequests: ReadableStream<IncomingRequest>;
    private incomingRequestsController?: ReadableStreamDefaultController<IncomingRequest>;

    readonly opened: Promise<void>;

    // Cache reserved channels (streams) to avoid collisions
    private reservedChannels: Map<number, RTCDataChannel> = new Map();

    // Pending Queue for Backpressure
    private pendingChannelQueue: { label: string, channel: RTCDataChannel }[] = [];

    constructor(
        pcOrTransport: RTCPeerConnection | ITransport,
        config?: RTCFetcherConfig,
        codec?: ICodec
    ) {
        this.config = config || {};

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
            // const qpackFeedbackStream = this.transport.createChannel('qpack-feedback', 2);

            const qpackContext = new QpackContext();

            // We attach the SAME channel for both "Encoder Stream" (sending instructions) 
            // and "Decoder Stream" (receiving instructions) because in our symmetric setup,
            // ID 1 carries instructions in both directions.
            qpackContext.attachChannels(qpackInstructionStream, qpackInstructionStream);
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

    private handleReservedChannel(id: number, channel: RTCDataChannel, label?: string) {
        try {
            // Check label to distinguish Request Channel vs Stream Channel
            if (label && (label === 'stream' || label === 'res-stream')) {
                // This is a stream channel. Do NOT process as Request.
                console.log(`[RTCFetcher] Storing reserved channel for ID ${id} (Label: ${label})`);
                this.reservedChannels.set(id, channel);
                return;
            }

            // Request Channel Logic
            let endpoint = label || 'default';
            if (endpoint.startsWith('req::')) {
                endpoint = endpoint.substring(5);
            }

            console.log(`[RTCFetcher] Handle Req Channel ID: ${id}, Label: ${endpoint}`);

            // Queue it (Backpressure)
            this.pendingChannelQueue.push({ label: endpoint, channel });

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
            this.createAndEnqueueRequest(item.label, item.channel);
        }
    }

    private createAndEnqueueRequest(label: string, channel: RTCDataChannel) {
        const req: IncomingRequest = {
            label: label,
            open: async () => {
                // LAZY READ START
                console.log(`[RTCFetcher] Opening Request: ${label} (ID: ${channel.id})`);

                const controller = new DataChannelController(channel);
                const receiveStream = new ReceiveStream(controller);

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
            const id = await this.transport.reserveId('res-stream', excludedIds);
            excludedIds.add(id);

            streams.set(id, stream);
            return new StreamRef(id);
        });

        const encoded = this.codec.encode(processed);
        const sendStream = new SendStream(controller, this.config.minBufferSize);

        // Open stream channels and Signal READY
        const streamReadyPromises: Promise<void>[] = [];
        streams.forEach((stream, id) => {
            const sChannel = this.transport.createChannel('res-stream', id);
            const sStream = new SendStream(sChannel, this.config.minBufferSize);
            stream.pipeTo(sStream.writable).catch(e => console.error(e));

            streamReadyPromises.push(this.transport.sendReadySignal(id, 'res-stream'));
        });
        await Promise.all(streamReadyPromises);

        try {
            const lenBytes = new Uint8Array(4);
            new DataView(lenBytes.buffer).setUint32(0, encoded.byteLength, true);

            await sendStream.write(lenBytes);
            await sendStream.write(encoded);
        } catch (e) {
            console.error('Error sending response:', e);
        } finally {
            controller.close();
        }
    }

    private async processedIncomingBody(obj: any): Promise<any> {
        if (obj instanceof StreamRef) {
            return new ReadableStream({
                start: (controller) => {
                    const channel = this.getOrOpenChannel(obj.id);
                    const s = new ReceiveStream(channel);
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
        return this.transport.createChannel('stream', id);
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
            const header = await readExact(4);
            if (!header) return null;

            const len = new DataView(header.buffer).getUint32(0, true);
            const bodyBytes = await readExact(len);
            if (!bodyBytes) return null;

            const decoded = await this.codec.decode(bodyBytes);
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
        const reqLabel = 'req::' + label;
        const reservedId = await this.transport.reserveId(reqLabel, new Set());

        // 2. Prepare Body
        const streams: Map<number, ReadableStream> = new Map();
        const streamCache: Map<ReadableStream, StreamRef> = new Map();

        const excludedIds = new Set<number>([reservedId]);

        const processedBody = await this.traverseAndExtractStreams(body, async (stream) => {
            if (streamCache.has(stream)) return streamCache.get(stream)!;

            const streamId = await this.transport.reserveId('stream', excludedIds);

            excludedIds.add(streamId);
            streams.set(streamId, stream);
            const ref = new StreamRef(streamId);
            streamCache.set(stream, ref);
            return ref;
        });

        // 3. Create Channel
        console.log("Reserved ID (Local):", reservedId);
        const mainChannel = this.transport.createChannel(reqLabel, reservedId);
        const controller = new DataChannelController(mainChannel);

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

        const responseReader = new ReceiveStream(controller);
        const sendStream = new SendStream(controller, this.config.minBufferSize);

        // 4. Signal Ready
        await this.transport.sendReadySignal(reservedId, reqLabel);

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
            const channel = this.transport.createChannel('stream', id);
            const sStream = new SendStream(channel, this.config.minBufferSize);
            stream.pipeTo(sStream.writable).catch(e => console.error(e));
            streamReadyPromises.push(this.transport.sendReadySignal(id, 'stream'));
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
                                const rs = new ReceiveStream(ch);
                                rs.readable.pipeTo(new WritableStream({
                                    write: x => c.enqueue(x),
                                    close: () => c.close(),
                                    abort: e => c.error(e)
                                }));
                            }
                        });
                    }, { encodedSize: len }));
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
