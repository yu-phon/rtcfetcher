
export interface ITransport {
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

export interface ICodec {
    encode(data: any): Uint8Array;
    decode(data: Uint8Array): any | Promise<any>;
}
