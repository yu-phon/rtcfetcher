
export const MSG_TYPE_DATA = 0x01;
export const MSG_TYPE_CREDIT = 0x02;

export type DataHandler = (data: Uint8Array) => void;
export type CreditHandler = (amount: number) => void;

export class DataChannelController {
    public onData?: DataHandler;
    private _onCredit?: CreditHandler;
    private pendingCredit: number = 0;
    private readonly instanceId: string;

    constructor(private readonly channel: RTCDataChannel) {
        this.instanceId = Math.random().toString(36).substring(7);
        console.log(`[DataChannelController:${this.channel.id}:${this.instanceId}] Created. Type: ${channel.constructor?.name}`);
        // console.trace(); // Uncomment if needed, but simple log might suffice if context is clear
        this.channel.binaryType = 'arraybuffer';
        this.channel.onmessage = this.handleMessage.bind(this);
    }

    set onCredit(handler: CreditHandler | undefined) {
        console.log(`[DataChannelController:${this.channel.id}:${this.instanceId}] Setting onCredit handler. Pending: ${this.pendingCredit}`);
        this._onCredit = handler;
        if (handler && this.pendingCredit > 0) {
            console.log(`[DataChannelController:${this.channel.id}:${this.instanceId}] Flushing pending credit: ${this.pendingCredit}`);
            handler(this.pendingCredit);
            this.pendingCredit = 0;
        }
    }

    get onCredit(): CreditHandler | undefined {
        return this._onCredit;
    }

    get readyState(): RTCDataChannelState {
        return this.channel.readyState;
    }

    get bufferedAmount(): number {
        return this.channel.bufferedAmount;
    }

    get underlyingChannel(): RTCDataChannel {
        return this.channel;
    }

    public sendData(data: Uint8Array): void {
        if (this.channel.readyState !== 'open') {
            console.warn(`[DataChannelController:${this.channel.id}:${this.instanceId}] Attempted sendData on non-open channel (${this.channel.readyState})`);
            return;
        }
        const frame = new Uint8Array(1 + data.byteLength);
        frame[0] = MSG_TYPE_DATA;
        frame.set(data, 1);
        try {
            this.channel.send(frame);
        } catch (e) {
            console.error(`[DataChannelController:${this.channel.id}:${this.instanceId}] sendData failed`, e);
            throw e; // Re-throw to let caller handle if needed, or swallow?
            // If we swallow, stream logic might get stuck. But if channel is broken, it will close/error anyway.
        }
    }

    public sendCredit(amount: number): void {
        if (this.channel.readyState !== 'open') {
            console.warn(`[DataChannelController:${this.channel.id}:${this.instanceId}] Attempted sendCredit on non-open channel (${this.channel.readyState})`);
            return;
        }
        const frame = new Uint8Array(1 + 4);
        frame[0] = MSG_TYPE_CREDIT;
        const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        view.setUint32(1, amount, true); // Little Endian
        try {
            this.channel.send(frame);
        } catch (e) {
            console.error(`[DataChannelController:${this.channel.id}:${this.instanceId}] sendCredit failed`, e);
        }
    }

    public close(): void {
        this.channel.close();
    }

    private handleMessage(event: MessageEvent): void {
        const data = event.data;
        if (data instanceof ArrayBuffer) {
            this.processBuffer(new Uint8Array(data));
        } else if (data instanceof Uint8Array) {
            this.processBuffer(data);
        } else {
            console.warn(`[DataChannelController:${this.channel.id}:${this.instanceId}] Received non-binary data, ignoring.`);
        }
    }

    private processBuffer(buffer: Uint8Array): void {
        if (buffer.byteLength < 1) return;
        const type = buffer[0];

        if (type === MSG_TYPE_DATA) {
            // console.log(`[DataChannelController] Valid DATA frame. Len: ${buffer.byteLength}`);
            if (this.onData) {
                this.onData(buffer.subarray(1));
            } else {
                console.warn(`[DataChannelController:${this.channel.id}:${this.instanceId}] No onData handler!`);
            }
        } else if (type === MSG_TYPE_CREDIT) {
            const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            const credit = view.getUint32(1, true);
            console.log(`[DataChannelController:${this.channel.id}:${this.instanceId}] CREDIT frame. Amount: ${credit}`);
            if (buffer.byteLength >= 5) {
                if (this._onCredit) {
                    this._onCredit(credit);
                } else {
                    console.log(`[DataChannelController:${this.channel.id}:${this.instanceId}] No onCredit handler! Buffering: ${credit}`);
                    this.pendingCredit += credit;
                }
            }
        } else {
            console.warn(`[DataChannelController:${this.channel.id}:${this.instanceId}] Unknown message type:`, type);
        }
    }
}
