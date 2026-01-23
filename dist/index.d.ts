interface ITransport {
    /**
     * Promise that resolves when the transport is ready for use (e.g. master channels open).
     */
    readonly opened: Promise<void>;
    /**
     * Reserve an ID for a new channel.
     * @param label Debug label or channel purpose hint.
     * @param excluded Set of IDs to exclude from selection.
     */
    reserveId(label: string, excluded: Set<number>): Promise<number>;
    /**
     * Create a new DataChannel (or equivalent) with the specified ID.
     */
    createChannel(label: string, id: number): RTCDataChannel;
    /**
     * Send a READY signal to the peer for the specified ID, completing the handshake.
     */
    sendReadySignal(id: number, label: string): Promise<void>;
    /**
     * Register a callback to handle incoming channels (reserved by the peer).
     */
    onIncomingChannel(handler: (id: number, channel: RTCDataChannel, label?: string) => void): void;
}
interface ICodec {
    encode(data: any): Uint8Array;
    decode(data: Uint8Array): any | Promise<any>;
}

type DataHandler = (data: Uint8Array) => void;
type CreditHandler = (amount: number) => void;
declare class DataChannelController {
    private readonly channel;
    onData?: DataHandler;
    private _onCredit?;
    private pendingCredit;
    private readonly instanceId;
    constructor(channel: RTCDataChannel);
    set onCredit(handler: CreditHandler | undefined);
    get onCredit(): CreditHandler | undefined;
    get readyState(): RTCDataChannelState;
    get bufferedAmount(): number;
    get underlyingChannel(): RTCDataChannel;
    sendData(data: Uint8Array): void;
    sendCredit(amount: number): void;
    close(): void;
    error(e: any): void;
    private handleMessage;
    private processBuffer;
}

declare class SendStream {
    private readonly highWaterMark;
    private readonly stream;
    private writer?;
    private controller;
    private sendWindow;
    private creditResolvers;
    constructor(channelOrController: RTCDataChannel | DataChannelController, highWaterMark?: number);
    get writable(): WritableStream<Uint8Array>;
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    private readonly maxChunkSize;
    private writeChunk;
    private waitForCredit;
    private processPendingWrites;
    private waitForBufferedAmountLow;
}

declare class ReceiveStream {
    private readonly stream;
    private controller;
    private unacknowledgedBytes;
    private readonly initialCredit;
    constructor(channelOrController: RTCDataChannel | DataChannelController);
    private flushCredits;
    get readable(): ReadableStream<Uint8Array>;
}

interface IStreamFactory {
    createSendStream(channel: RTCDataChannel | DataChannelController, minBufferSize?: number): SendStream;
    createReceiveStream(channel: RTCDataChannel | DataChannelController): ReceiveStream;
    createController(channel: RTCDataChannel): DataChannelController;
}

interface IncomingRequest {
    label: string;
    open(): Promise<{
        req: {
            label: string;
            body: any;
        };
        res: {
            send: (data: any) => void;
            close: () => void;
        };
    }>;
    reject(reason?: string): void;
}

declare class StreamRef {
    readonly id: number;
    constructor(id: number);
}

interface RTCResponseStats {
    encodedSize: number;
}
declare class RTCResponse {
    private _body;
    private _streamReplacer;
    private _stats?;
    private _streamCache;
    constructor(body: any, streamReplacer: (ref: StreamRef) => ReadableStream<Uint8Array> | null, stats?: RTCResponseStats);
    private _wrapValue;
    private _getOrHydrateStream;
    get qpackStats(): RTCResponseStats | undefined;
    get ok(): boolean;
    json(): Promise<any>;
    text(): Promise<string>;
    blob(): Promise<Blob>;
    private processBodyAndBufferStreams;
    private _consumeStream;
}

interface RTCFetcherConfig {
    minBufferSize?: number;
    prefetchPoolSize?: number;
    incomingHighWaterMark?: number;
}
interface RTCFetchOptions {
    signal?: AbortSignal;
}
declare class RTCFetcher {
    private transport;
    private readonly config;
    private codec;
    private streamFactory;
    readonly incomingRequests: ReadableStream<IncomingRequest>;
    private incomingRequestsController?;
    readonly opened: Promise<void>;
    private reservedChannels;
    private pendingChannelQueue;
    constructor(pcOrTransport: RTCPeerConnection | ITransport, config?: RTCFetcherConfig, codec?: ICodec, streamFactory?: IStreamFactory);
    private handleReservedChannel;
    private pumpIncomingRequests;
    private createAndEnqueueRequest;
    private sendResponse;
    private processedIncomingBody;
    private getOrOpenChannel;
    private bufferAndDecode;
    fetch(label: string, body: any, options?: RTCFetchOptions): Promise<RTCResponse>;
    private traverseAndExtractStreams;
}

declare class Negotiator {
    private readonly signalingChannel;
    private readonly pc;
    private pendingReservations;
    private waitingForReady;
    onReserved?: (id: number, channel: RTCDataChannel, label?: string) => void;
    constructor(signalingChannel: RTCDataChannel, pc: RTCPeerConnection);
    sendReady(id: number, label?: string): Promise<void>;
    /**
     * Reserve a new DataChannel ID.
     * Uses getStats to find an unused ID, then performs a handshake with the peer.
     */
    reserveId(label: string, excludedIds?: Set<number>): Promise<number>;
    performHandshake(id: number, label: string): Promise<void>;
    private handleReserveRequest;
    private handleReady;
    private handleAck;
    private handleNack;
    private setupSignalingChannel;
    private send;
    findUnusedId(excludedIds?: Set<number>): Promise<number>;
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

declare class MsgPackCodec {
    private extensionCodec;
    constructor();
    private initializeExtensions;
    encode(data: any): Uint8Array;
    decode(data: Uint8Array): any;
}
declare const msgpackCodec: MsgPackCodec;

export { type IncomingRequest, Negotiator, RTCConnectionError, RTCFetcher, RTCFetcherError, RTCResponse, RTCSerializationError, RTCTimeoutError, ReceiveStream, SendStream, msgpackCodec };
