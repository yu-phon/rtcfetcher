interface IncomingRequest {
    endpoint: string;
    open(): Promise<{
        req: object;
        res: {
            send: (data: any) => void;
        };
    }>;
    reject(reason?: string): void;
}

declare class StreamRef {
    readonly id: number;
    constructor(id: number);
}

declare class RTCResponse {
    private _body;
    private _streamReplacer;
    constructor(body: any, streamReplacer: (ref: StreamRef) => ReadableStream<Uint8Array> | null);
    get ok(): boolean;
    json(): Promise<any>;
    text(): Promise<string>;
    blob(): Promise<Blob>;
    private processBody;
}

interface RTCFetcherConfig {
    minBufferSize?: number;
}
interface RTCFetchOptions {
    signal?: AbortSignal;
}
declare class RTCFetcher {
    private pc;
    private negotiator;
    private masterChannel;
    private readonly config;
    readonly incomingRequests: ReadableStream<IncomingRequest>;
    private incomingRequestsController?;
    readonly opened: Promise<void>;
    private reservedChannels;
    constructor(pc: RTCPeerConnection, config?: RTCFetcherConfig);
    private handleReservedChannel;
    private processIncomingMessage;
    private sendResponse;
    private processedIncomingBody;
    private getOrOpenChannel;
    private bufferAndDecode;
    fetch(label: string, body: any, _options?: RTCFetchOptions): Promise<RTCResponse>;
    private traverseAndExtractStreams;
}

declare class Negotiator {
    private readonly signalingChannel;
    private readonly pc;
    private static readonly SIGNALING_CHANNEL_ID;
    private static readonly MAX_CHANNEL_ID;
    private pendingReservations;
    onReserved?: (id: number, channel?: RTCDataChannel, label?: string) => void;
    constructor(signalingChannel: RTCDataChannel, pc: RTCPeerConnection);
    /**
     * Reserve a new DataChannel ID.
     * Uses getStats to find an unused ID, then performs a handshake with the peer.
     */
    reserveId(label: string): Promise<number>;
    private performHandshake;
    private handleReserveRequest;
    private handleAck;
    private handleNack;
    private setupSignalingChannel;
    private send;
    private findUnusedId;
    private isIdUsed;
    private getUsedIds;
}

declare class RTCFetcherError extends Error {
    code: string;
    cause?: any | undefined;
    constructor(message: string, code: string, cause?: any | undefined);
}
declare class RTCTimeoutError extends RTCFetcherError {
    constructor(message?: string);
}
declare class RTCConnectionError extends RTCFetcherError {
    constructor(message?: string);
}
declare class RTCSerializationError extends RTCFetcherError {
    constructor(message?: string, cause?: any);
}

declare class SendStream {
    private readonly channel;
    private readonly highWaterMark;
    private readonly stream;
    private writer?;
    constructor(channel: RTCDataChannel, highWaterMark?: number);
    get writable(): WritableStream<Uint8Array>;
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    private writeChunk;
    private waitForBufferedAmountLow;
}

declare class ReceiveStream {
    private readonly channel;
    private readonly stream;
    constructor(channel: RTCDataChannel);
    get readable(): ReadableStream<Uint8Array>;
}

declare class MsgPackCodec {
    private extensionCodec;
    constructor();
    private initializeExtensions;
    encode(data: any): Uint8Array;
    decode(data: Uint8Array): any;
}
declare const msgpackCodec: MsgPackCodec;

export { type IncomingRequest, Negotiator, RTCConnectionError, RTCFetcher, RTCFetcherError, RTCResponse, RTCSerializationError, RTCTimeoutError, ReceiveStream, SendStream, msgpackCodec };
