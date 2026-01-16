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
    private waitingForReady;
    onReserved?: (id: number, channel?: RTCDataChannel, label?: string) => void;
    constructor(signalingChannel: RTCDataChannel, pc: RTCPeerConnection);
    sendReady(id: number): Promise<void>;
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

declare class MsgPackCodec {
    private extensionCodec;
    constructor();
    private initializeExtensions;
    encode(data: any): Uint8Array;
    decode(data: Uint8Array): any;
}
declare const msgpackCodec: MsgPackCodec;

export { type IncomingRequest, Negotiator, RTCConnectionError, RTCFetcher, RTCFetcherError, RTCResponse, RTCSerializationError, RTCTimeoutError, ReceiveStream, SendStream, msgpackCodec };
