import { CREDIT_PAYLOAD_SIZE, HEADER_SIZE, MSG_TYPE_CREDIT, MSG_TYPE_DATA } from './constants';

export type DataHandler = (data: Uint8Array) => void;
export type CreditHandler = (amount: number) => void;

export class DataChannelController {
    public onData?: DataHandler;
    private _onCredit?: CreditHandler;
    private pendingCredit: number = 0;
    private readonly instanceId: string;

    constructor(private readonly channel: RTCDataChannel) {
        this.instanceId = Math.random().toString(36).substring(7);
        // console.debug(`[DataChannelController:${this.channel.id}:${this.instanceId}] Created.`);
        this.channel.binaryType = 'arraybuffer';
        this.channel.onmessage = this.handleMessage.bind(this);
    }

    set onCredit(handler: CreditHandler | undefined) {
        this._onCredit = handler;
        if (handler && this.pendingCredit > 0) {
            // console.debug(`[DataChannelController:${this.channel.id}:${this.instanceId}] Flushing pending credit: ${this.pendingCredit}`);
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
        const frame = new Uint8Array(HEADER_SIZE + data.byteLength);
        frame[0] = MSG_TYPE_DATA;
        frame.set(data, HEADER_SIZE);
        try {
            this.channel.send(frame);
        } catch (e) {
            console.error(`[DataChannelController:${this.channel.id}:${this.instanceId}] sendData failed`, e);
            throw e;
        }
    }

    public sendCredit(amount: number): void {
        if (this.channel.readyState !== 'open') {
            // console.warn(`[DataChannelController:${this.channel.id}:${this.instanceId}] Attempted sendCredit on non-open channel`);
            return;
        }
        const frame = new Uint8Array(HEADER_SIZE + CREDIT_PAYLOAD_SIZE);
        frame[0] = MSG_TYPE_CREDIT;
        const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        view.setUint32(HEADER_SIZE, amount, true); // Little Endian
        try {
            this.channel.send(frame);
        } catch (e) {
            console.error(`[DataChannelController:${this.channel.id}:${this.instanceId}] sendCredit failed`, e);
        }
    }

    public close(): void {
        this.channel.close();
    }

    public error(e: any): void {
        console.error(`[DataChannelController:${this.channel.id}:${this.instanceId}] Error reported:`, e);
        // Optionally close?
        // this.channel.close(); 
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
        if (buffer.byteLength < HEADER_SIZE) return;
        const type = buffer[0];

        if (type === MSG_TYPE_DATA) {
            if (this.onData) {
                this.onData(buffer.subarray(HEADER_SIZE));
            } else {
                console.warn(`[DataChannelController:${this.channel.id}:${this.instanceId}] No onData handler! Dropping data.`);
            }
        } else if (type === MSG_TYPE_CREDIT) {
            if (buffer.byteLength < HEADER_SIZE + CREDIT_PAYLOAD_SIZE) return;
            const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            const credit = view.getUint32(HEADER_SIZE, true);

            if (this._onCredit) {
                this._onCredit(credit);
            } else {
                // console.debug(`[DataChannelController:${this.channel.id}:${this.instanceId}] Buffering credit: ${credit}`);
                this.pendingCredit += credit;
            }
        } else {
            console.warn(`[DataChannelController:${this.channel.id}:${this.instanceId}] Unknown message type:`, type);
        }
    }
}
