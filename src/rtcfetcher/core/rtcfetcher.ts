import { Negotiator } from '../../negotiation/id-negotiator';

import { SendStream } from '../../datachannelstream/streams/sendStream';
import { ReceiveStream } from '../../datachannelstream/streams/receiveStream';
import { DataChannelController } from '../../datachannelstream/framing/channel-controller';
import { msgpackCodec } from '../utils/msgpack-codec';
import { StreamRef } from '../types/stream-ref';
import { IncomingRequest } from '../types/message';
import { RTCResponse } from './rtc-response';
import { traverseAndOptimizeStreams } from '../utils/stream-traversal';

export interface RTCFetcherConfig {
    minBufferSize?: number;
}

interface RTCFetchOptions {
    signal?: AbortSignal;
}

export class RTCFetcher {
    private negotiator: Negotiator;
    private masterChannel: RTCDataChannel;
    private readonly config: RTCFetcherConfig;

    // Stream exposing incoming requests
    readonly incomingRequests: ReadableStream<IncomingRequest>;
    private incomingRequestsController?: ReadableStreamDefaultController<IncomingRequest>;

    readonly opened: Promise<void>;

    // Cache reserved channels (streams) to avoid collisions
    private reservedChannels: Map<number, RTCDataChannel> = new Map();

    constructor(
        private pc: RTCPeerConnection,
        config?: RTCFetcherConfig
    ) {
        this.config = config || {};

        // Setup Master Channel (ID 0)
        this.masterChannel = pc.createDataChannel('rtc-fetcher-master', { negotiated: true, id: 0 });
        this.negotiator = new Negotiator(this.masterChannel, pc);

        this.incomingRequests = new ReadableStream<IncomingRequest>({
            start: (controller) => {
                this.incomingRequestsController = controller;
            }
        });

        // Setup Negotiator callback for Receiver side
        this.negotiator.onReserved = (id, channel, label) => this.handleReservedChannel(id, channel, label);

        this.opened = new Promise<void>((resolve) => {
            const checkOpen = () => {
                if (this.masterChannel.readyState === 'open') {
                    resolve();
                    return true;
                }
                return false;
            };

            if (!checkOpen()) {
                this.masterChannel.onopen = () => checkOpen();
            }
        });
    }

    private handleReservedChannel(id: number, existingChannel?: RTCDataChannel, label?: string) {
        try {
            // Check label to distinguish Request Channel vs Stream Channel
            if (label && (label === 'stream' || label === 'res-stream')) {
                // This is a stream channel. Do NOT process as Request.
                // Store it for getOrOpenChannel to find later.
                if (existingChannel) {
                    console.log(`[RTCFetcher] Storing reserved channel for ID ${id} (Label: ${label})`);
                    this.reservedChannels.set(id, existingChannel);
                } else {
                    console.warn(`[RTCFetcher] Stream ID ${id} reserved but no existing channel passed! (Label: ${label})`);
                }
                return;
            }

            // Receiver: Peer reserved this ID. We must open it to receive "Request".
            // If Negotiator passed an existing channel (from probe), use it to avoid Close/Open race.
            console.log("Reserved ID:", id);
            const channel = existingChannel || this.pc.createDataChannel('rtc-fetcher-req', { negotiated: true, id: id });
            console.log("Created/Reused channel:", channel.id);

            // Wait for data (The Request Body)
            // It will be MsgPack encoded.

            const controller = new DataChannelController(channel);

            // The sender sends encoded body via SendStream.
            // The receiver reads via ReceiveStream.

            const receiveStream = new ReceiveStream(controller);
            // We start reading immediately to buffer/decode.

            // We need to decode the MsgPack stream.
            // Since MsgPack libraries usually decode synchrounously from buffer, 
            // or asynchronously from iterator.

            this.processIncomingMessage(receiveStream.readable, controller);

        } catch (e) {
            console.error('Error handling reserved channel:', e);
        }
    }

    private async processIncomingMessage(stream: ReadableStream<Uint8Array>, controller: DataChannelController) {
        // Collect chunks? Or streaming decode?
        // Simple approach: Collect chunks until we can decode.
        // BUT if it contains streams (StreamRef), the body object itself is small (just refs), 
        // the streams are side-channels.
        // So likely we can buffer the main body.
        // But what if the body is HUGE? (e.g. big string).
        // For 'fetch' API, usually we buffer request unless it is explicitly a stream request.

        const info = await this.bufferAndDecode(stream);
        if (!info) return; // Decode failed or closed

        const { label, body } = info;

        // Traverse body to find StreamRefs and wrap them
        const processedBody = await this.processedIncomingBody(body);

        const req: IncomingRequest = {
            endpoint: label, // We use endpoint property in IncomingRequest interface
            // We match IncomingRequest interface from src/rtcfetcher/types/message.ts?
            // "open(): Promise<{ req: object, res: { send } }>"

            open: async () => {
                // Return req and res object
                return {
                    req: { label, body: processedBody }, // Adjust structure as needed
                    res: {
                        send: (responseData: any) => {
                            // Send response back on SAME channel?
                            // Yes, Request->Response flow.
                            // We need to encode response.
                            // Traverse response body for streams?
                            // TODO: Implement Response Stream traversal if needed.
                            // For now assuming simple response or similar traversal.
                            this.sendResponse(controller, responseData);
                        },
                        close: () => {
                            controller.close();
                        }
                    }
                };
            },
            reject: (_reason) => {
                controller.close();
            }
        };

        if (this.incomingRequestsController) {
            this.incomingRequestsController.enqueue(req);
        }
    }

    private async sendResponse(controller: DataChannelController, data: any) {
        const streams: Map<number, ReadableStream> = new Map();

        // Exclude the current channel ID to be safe, though getStats might already cover it.
        // Also we need to accumulate reserved IDs to pass to subsequent reserveId calls
        const excludedIds = new Set<number>();
        // Note: 'controller.underlyingChannel.id' might be null if not yet open/assigned? 
        // But here it should be open.
        if (controller.underlyingChannel.id !== null) {
            excludedIds.add(controller.underlyingChannel.id);
        }

        const processed = await this.traverseAndExtractStreams(data, async (stream) => {
            const id = await this.negotiator.reserveId('res-stream', excludedIds);
            excludedIds.add(id);
            streams.set(id, stream);
            return new StreamRef(id);
        });

        const encoded = msgpackCodec.encode(processed);
        // Reuse controller
        const sendStream = new SendStream(controller, this.config.minBufferSize);

        // Open stream channels and Signal READY
        const streamReadyPromises: Promise<void>[] = [];
        streams.forEach((stream, id) => {
            const sChannel = this.pc.createDataChannel('res-stream', { negotiated: true, id });
            const sStream = new SendStream(sChannel, this.config.minBufferSize);
            stream.pipeTo(sStream.writable).catch(e => console.error(e));

            streamReadyPromises.push(this.negotiator.sendReady(id));
        });
        await Promise.all(streamReadyPromises);

        try {
            const lenBytes = new Uint8Array(4);
            new DataView(lenBytes.buffer).setUint32(0, encoded.byteLength, true);

            await sendStream.write(lenBytes);
            await sendStream.write(encoded);
        } catch (e) {
            console.error('Error sending response:', e);
            // controller.close(); // Keep open for streams?
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
        return this.pc.createDataChannel('stream', { negotiated: true, id });
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

            const decoded = msgpackCodec.decode(bodyBytes);
            if (decoded && typeof decoded === 'object' && 'label' in decoded) {
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

    public async fetch(label: string, body: any, _options?: RTCFetchOptions): Promise<RTCResponse> {
        await this.opened;

        // 1. Find ID
        const reservedId = await this.negotiator.findUnusedId();

        // 2. Prepare Body (Traverse streams)
        // We do this BEFORE creating channel? Or after?
        // Doesn't matter, but better before if it fails.
        // Traverse needs negotiator to stream ids? Yes.

        const streams: Map<number, ReadableStream> = new Map();
        const streamCache: Map<ReadableStream, StreamRef> = new Map();

        // Exclude the Main Channel ID from stream ID selection.
        const excludedIds = new Set<number>([reservedId]);

        const processedBody = await this.traverseAndExtractStreams(body, async (stream) => {
            if (streamCache.has(stream)) return streamCache.get(stream)!;
            const streamId = await this.negotiator.reserveId('stream', excludedIds); // This reserves and handshakes. 

            // Add newly reserved stream ID to excluded list for next iterations
            excludedIds.add(streamId);
            // Wait. streams also have race condition? 
            // Yes. Receiver opens stream channel immediately.
            // We should use findUnusedId here too?
            // For now let's fix Main Channel first. Stream channels are simpler (one way?).
            // stream.pipeTo(sendStream).
            // Actually, if Peer creates stream channel and sends credit...
            // Yes, same race.
            // But let's fix Main first.

            streams.set(streamId, stream);
            const ref = new StreamRef(streamId);
            streamCache.set(stream, ref);
            return ref;
        });



        // 4. Perform Handshake
        // Now if peer sends immediately, we are ready.


        // 5. Handshake
        await this.negotiator.performHandshake(reservedId, 'req::' + label);

        // 6. Create Channel & Controller (Sender Side) - POST HANDSHAKE
        console.log("Reserved ID (Local):", reservedId);
        const mainChannel = this.pc.createDataChannel(label, { negotiated: true, id: reservedId });
        const controller = new DataChannelController(mainChannel);

        const responseReader = new ReceiveStream(controller);
        const sendStream = new SendStream(controller, this.config.minBufferSize);


        // 6. Signal Channel Ready
        // This tells the receiver we are ready to accept messages (like Credit).
        await this.negotiator.sendReady(reservedId);

        const encoded = msgpackCodec.encode({ label, body: processedBody });

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
            const channel = this.pc.createDataChannel('stream', { negotiated: true, id });
            const sStream = new SendStream(channel, this.config.minBufferSize);
            stream.pipeTo(sStream.writable).catch(e => console.error(e));

            // Signal readiness for this stream channel too!
            // We push to promise array to await them in parallel if needed, 
            // OR we can just fire and forget if order doesn't matter (Wait, Receiver needs READY before Body processing?)
            // Receiver processes body -> open stream.
            // Body processing happens after bufferAndDecode.
            // bufferAndDecode starts receiving immediately.
            // If body arrives before READY(stream), getOrOpenChannel fails.
            // So we MUST ensure READY arrives.
            // Sequential await inside forEach is bad.
            streamReadyPromises.push(this.negotiator.sendReady(id));
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
                    if (value.byteLength > take) console.warn('Excess data in response channel');
                }
                return buf;
            };

            (async () => {
                try {
                    const lenBuf = await readExact(4);
                    const len = new DataView(lenBuf.buffer).getUint32(0, true);
                    const bodyBuf = await readExact(len);

                    const resData = msgpackCodec.decode(bodyBuf);
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
                    }));
                } catch (e) {
                    reject(e);
                } finally {
                    reader.releaseLock();
                }
            })();
        });
    }

    private async traverseAndExtractStreams(obj: any, replacer: (s: ReadableStream) => Promise<StreamRef>): Promise<any> {
        // This method is deprecated and replaced by traverseAndOptimizeStreams from utils.
        // Keeping it temporarily if needed or just removing it as per plan.
        return traverseAndOptimizeStreams(obj, replacer);
    }

}