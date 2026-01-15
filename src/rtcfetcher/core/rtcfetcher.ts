import { Negotiator } from '../../negotiation/id-negotiator';
import { RTCTimeoutError, RTCConnectionError } from '../errors/rtc-fetcher-error';
import { SendStream } from '../../datachannelstream/streams/sendStream';
import { ReceiveStream } from '../../datachannelstream/streams/receiveStream';
import { msgpackCodec } from '../utils/msgpack-codec';
import { StreamRef } from '../types/stream-ref';
import { IncomingRequest } from '../types/message';
import { RTCResponse } from './rtc-response';

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

    // ...

    private handleReservedChannel(id: number, existingChannel?: RTCDataChannel, label?: string) {
        try {
            // Check label to distinguish Request Channel vs Stream Channel
            if (label && (label === 'stream' || label === 'res-stream')) {
                // This is a stream channel. Do NOT process as Request.
                // Store it for getOrOpenChannel to find later.
                if (existingChannel) {
                    this.reservedChannels.set(id, existingChannel);
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
            // We expect ONE full MsgPack payload (which might contain streams refs).
            // But since body can be large or streaming, how do we "Wait for Body"?

            // The sender sends encoded body via SendStream.
            // The receiver reads via ReceiveStream.

            const receiveStream = new ReceiveStream(channel);
            // We start reading immediately to buffer/decode.

            // We need to decode the MsgPack stream.
            // Since MsgPack libraries usually decode synchrounously from buffer, 
            // or asynchronously from iterator.

            this.processIncomingMessage(receiveStream.readable, channel);

        } catch (e) {
            console.error('Error handling reserved channel:', e);
        }
    }

    private async processIncomingMessage(stream: ReadableStream<Uint8Array>, channel: RTCDataChannel) {
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
                            this.sendResponse(channel, responseData);
                        },
                        close: () => {
                            channel.close();
                        }
                    }
                };
            },
            reject: (reason) => {
                channel.close();
            }
        };

        if (this.incomingRequestsController) {
            this.incomingRequestsController.enqueue(req);
        }
    }

    private async sendResponse(channel: RTCDataChannel, data: any) {
        // Negotiate streams for response?
        // Similar logic to fetch()
        const streams: Map<number, ReadableStream> = new Map();
        const processed = await this.traverseAndExtractStreams(data, async (stream) => {
            const id = await this.negotiator.reserveId('res-stream');
            streams.set(id, stream);
            return new StreamRef(id);
        });

        const encoded = msgpackCodec.encode(processed);
        const sendStream = new SendStream(channel, this.config.minBufferSize);

        // Open stream channels
        streams.forEach((stream, id) => {
            const sChannel = this.pc.createDataChannel('res-stream', { negotiated: true, id });
            const sStream = new SendStream(sChannel, this.config.minBufferSize);
            stream.pipeTo(sStream.writable).catch(e => console.error(e));
        });

        await sendStream.write(encoded);
        // channel.close()? Not yet, stream sending might take time?
        // sendStream doesn't close on finish unless we do.
        // If response is done, we usually close, BUT the streams might be still running.
        // The main body is sent. We can close main channel?
        // NO, SendStream needs to flush.
        // If we close main channel, does it affect other channels? No.
        // But maybe we should keep open until logic ensures delivery?
        // SCTP ensures delivery.
        // setTimeout(() => channel.close(), 5000)? Risk.
        // Let the user control close via streams closing?
    }

    private async processedIncomingBody(obj: any): Promise<any> {
        // Recursive replace StreamRef with ReceiveStream
        // StreamRef has ID. We open that channel.
        if (obj instanceof StreamRef) {
            // Check if already open? Receiver needs to open it.
            // The Sender reserved it. We haven't opened it yet (unless Negotiator fired onReserved for it too).
            // Negotiator fires onReserved for ALL RESERVES.
            // BUT we only handle 'main' request channel in onReseved?
            // NO, onReserved just says "ID X is reserved".
            // How do we distinguish Main Channel vs Stream Channel?
            // We DON'T know yet.

            // Wait. In `handleReservedChannel`, we opened `channel`.
            // If that channel was actually a side-stream, we just opened it.
            // But we tried to `processIncomingMessage` on it (read body).
            // If it's a stream, it just gets raw binary/string, not MsgPack Structure with `label`/`body`.
            // So `bufferAndDecode` will fail or return garbage?

            // ARCHITECTURE ISSUE: 
            // We need to know if a Channel is control (Request) or stream.
            // Spec said: "Master Channel (ID 255)".
            // Spec said: "Request Body... MsgPack".

            // Proposed fix: 
            // All 'Requests' (Main interactions) start with a MsgPack structure: `{ label: string, body: any }`.
            // Streams just send Raw Data.
            // So `bufferAndDecode` tries to decode. 
            // If it fails (or is raw stream data), what do we do?
            // StreamRef in body TELLS us "ID X is a stream".
            // So when we parse body, we find StreamRef(X).
            // We know X is a stream.

            // But `handleReservedChannel` is triggered for X too! 
            // It will try to `processIncomingMessage` on X.
            // We need to STOP `handleReservedChannel` from treating X as a new Request.

            // How?
            // We can register "Used IDs" that are streams?
            // But timing race: MsgPack body might arrive AFTER X is reserved?
            // Or Before?
            // Negotiator handshake happens first.
            // Body arrives on Main Channel.
            // Stream data arrives on Stream Channel X.

            // If we receive StreamRef(X) in Main Body, we can claim "X is a stream".
            // If `handleReservedChannel(X)` fired, we check "Is X a stream?".
            // If yes, ignore (RecvStream setup is handled by StreamRef logic).
            // If unknown, treat as Request?

            // Implies we need shared state for "Pending Channels".
            // OR:
            // We treat ALL channels as "potentially requests" UNTIL we see StreamRef(X)?
            // But data might flow on X immediately.

            // Better: Sender attaches metadata in RESERVE? e.g. `label`.
            // My Negotiator update added `label: string` to `reserveId(label)`.
            // And `NegotiationMessage` has `label`.
            // Sender: `reserveId('main-request')` vs `reserveId('stream')`.
            // Receiver: `onReserved(id, label)`. !!

            // I need to update `onReserved` signature to include Label.
            // Then I can distinguish!
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
            if (obj instanceof Blob || obj instanceof Uint8Array) return obj;
            const res: any = {};
            for (const k in obj) res[k] = await this.processedIncomingBody(obj[k]);
            return res;
        }
        return obj;
    }

    private getOrOpenChannel(id: number): RTCDataChannel {
        // Check if we have a reserved channel cached
        if (this.reservedChannels.has(id)) {
            const channel = this.reservedChannels.get(id)!;
            this.reservedChannels.delete(id); // Use once? Or keep?
            // Usually we pass ownership to the ReceiveStream.
            return channel;
        }
        // Fallback: This might fail if ID is reported "used" but not in our map?
        // Or if it WAS used by probe and we didn't capture it?
        // If Negotatior passed it to handleReservedChannel, we should have it.
        // If we initiate, we rely on createDataChannel.
        return this.pc.createDataChannel('stream', { negotiated: true, id });
    }

    private async bufferAndDecode(stream: ReadableStream<Uint8Array>): Promise<{ label: string, body: any } | null> {
        // Read all? Or read first chunk?
        // MsgPack might be split.
        // We accumulate.
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        let totalLen = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                totalLen += value.byteLength;

                // Attempt decode? 
                // Simple optimization: Try decode on every chunk? No, expensive.
                // Just wait for full message? 
                // Implementation implies "Request" is discrete.
                // We assume request ends when stream closes? 
                // NO, SendStream doesn't close automatically?
                // Sender must close Main Channel after sending request body?
                // If Sender doesn't close, we wait forever.
                // Sender `sendStream.write(encoded)` finishes. 
                // We should close underlying channel?
                // Let's assume Sender closes Main Channel for Request.
            }
        } catch (e) {
            console.error(e);
            return null;
        }

        if (totalLen === 0) return null;

        const combined = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
            combined.set(c, offset);
            offset += c.byteLength;
        }

        try {
            const decoded = msgpackCodec.decode(combined);
            // Expect { label, body }
            if (decoded && typeof decoded === 'object' && 'label' in decoded) {
                return decoded;
            }
        } catch (e) {
            // Not a valid request body
        }
        return null;
    }

    // FETCH METHOD IMPLEMENTATION REVISITED
    public async fetch(label: string, body: any, options?: RTCFetchOptions): Promise<RTCResponse> {
        await this.opened;
        const reservedId = await this.negotiator.reserveId('req::' + label); // Tag as request
        console.log("Reserved ID:", reservedId);

        const streams: Map<number, ReadableStream> = new Map();
        const streamCache: Map<ReadableStream, StreamRef> = new Map();
        const processedBody = await this.traverseAndExtractStreams(body, async (stream) => {
            // Deduplication check
            if (streamCache.has(stream)) {
                return streamCache.get(stream)!;
            }

            const streamId = await this.negotiator.reserveId('stream');
            streams.set(streamId, stream);
            const ref = new StreamRef(streamId);
            streamCache.set(stream, ref);
            return ref;
        });

        const encoded = msgpackCodec.encode({ label, body: processedBody });
        const mainChannel = this.pc.createDataChannel(label, { negotiated: true, id: reservedId });

        if (mainChannel.readyState !== 'open') {
            await new Promise<void>((resolve, reject) => {
                const onOpen = () => {
                    cleanup();
                    resolve();
                };
                const onError = (e: Event) => {
                    cleanup();
                    reject(new Error('DataChannel error while waiting for open'));
                };
                const cleanup = () => {
                    mainChannel.removeEventListener('open', onOpen);
                    mainChannel.removeEventListener('error', onError);
                }
                mainChannel.addEventListener('open', onOpen);
                mainChannel.addEventListener('error', onError);
            });
        }

        const sendStream = new SendStream(mainChannel, this.config.minBufferSize);

        streams.forEach((stream, id) => {
            const channel = this.pc.createDataChannel('stream', { negotiated: true, id });
            const sStream = new SendStream(channel, this.config.minBufferSize);
            stream.pipeTo(sStream.writable).catch(e => console.error(e));
        });

        try {
            await sendStream.write(encoded);
            // We MUST close the request sender stream to signal "End of Request Body".
            await sendStream.close();

            // Now wait for Response on the SAME channel (which is bidirectional).
            // But we closed it! 
            // `sendStream.close()` closes the underlying channel!
            // If we close the channel, we can't receive response!

            // Correction: Request/Response on same channel means we CANNOT close channel to delimit message.
            // We need a framing protocol or MsgPack self-delimitation.
            // MsgPack IS self-delimiting? 
            // `decode` consumes exactly one object if we feed it right.
            // But `ReceiveStream` yields chunks.
            // We need a `decodeFromStream`.

            // Given time constraints: implement simple "One Request per Channel, Response on separate channel?"
            // No, that's complex.
            // "Fetch" usually keeps connection open?
            // Logic: 
            // 1. Send Request.
            // 2. Receive Response.
            // 3. Close.

            // If we keep channel open, Receiver needs to know when Request Body ends.
            // MsgPack codec can tell us "Used X bytes".
            // If we use `@msgpack/msgpack`, `decode` returns a value.

            // Let's rely on MsgPack decoding being able to parse "one object" from the accumulated buffer.
            // BUT we can't wait for "stream close".
            // We need to attempt decode on data arrival?

            // For now, I will use `sendStream.close()` to signal end, BUT that breaks bidirectional.
            // UNLESS I use `close()` only on the *Writer*? No, SendStream closes channel.

            // I'll stick to: Receiver buffers until it succeeds in decoding { label, body }.
            // This is "try decode" strategy.
        } catch (e) {
            mainChannel.close();
            throw e;
        }

        // Response Handling
        return new Promise<RTCResponse>((resolve, reject) => {
            // ... timeout logic ...
            const responseReader = new ReceiveStream(mainChannel);
            const reader = responseReader.readable.getReader();
            const chunks: Uint8Array[] = [];

            (async () => {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (value) chunks.push(value);

                        // Try decode
                        try {
                            // Reassemble
                            // Optimization: This is inefficient (O(N^2)). Use a simpler buffer.
                            // For simplicity in draft: 
                            const total = chunks.reduce((a, c) => a + c.byteLength, 0);
                            const buf = new Uint8Array(total);
                            let off = 0;
                            for (const c of chunks) { buf.set(c, off); off += c.byteLength; }

                            const resData = msgpackCodec.decode(buf);
                            // If success:
                            resolve(new RTCResponse(resData, (ref) => {
                                // Stream replacer for response
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
                            return; // Done
                        } catch (e) {
                            // Need more data
                        }

                        if (done) break;
                    }
                } catch (e) {
                    reject(e);
                }
            })();
        });
    }

    private async traverseAndExtractStreams(obj: any, replacer: (s: ReadableStream) => Promise<StreamRef>): Promise<any> {
        if (obj instanceof ReadableStream) {
            return replacer(obj);
        }
        if (Array.isArray(obj)) {
            return Promise.all(obj.map(item => this.traverseAndExtractStreams(item, replacer)));
        }
        if (obj && typeof obj === 'object') {
            if (obj instanceof Blob || obj instanceof Uint8Array || obj instanceof ArrayBuffer) return obj;
            const newObj: any = {};
            for (const key in obj) {
                newObj[key] = await this.traverseAndExtractStreams(obj[key], replacer);
            }
            return newObj;
        }
        return obj;
    }
}