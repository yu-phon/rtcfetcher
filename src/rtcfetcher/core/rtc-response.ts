import { StreamRef } from '../types/stream-ref';

export class RTCResponse {
    private _body: any;
    private _streamReplacer: (ref: StreamRef) => ReadableStream<Uint8Array> | null;

    constructor(body: any, streamReplacer: (ref: StreamRef) => ReadableStream<Uint8Array> | null) {
        this._body = body;
        this._streamReplacer = streamReplacer;
    }

    get ok(): boolean {
        // In simple P2P fetch, assuming delivery means OK unless error thrown.
        // Or we can add status code to the response payload.
        // For now, always true if instantiated.
        return true;
    }

    async json(): Promise<any> {
        return this.processBody(this._body);
    }

    async text(): Promise<string> {
        const processed = await this.processBody(this._body);
        if (typeof processed === 'string') return processed;
        return JSON.stringify(processed);
    }

    async blob(): Promise<Blob> {
        const processed = await this.processBody(this._body);
        if (processed instanceof Blob) return processed;
        if (processed instanceof Uint8Array) return new Blob([processed]);
        if (processed instanceof ArrayBuffer) return new Blob([processed]);
        throw new Error('Body is not a Blob or binary data');
    }

    // Recursively replace StreamRef with actual ReadableStreams
    private async processBody(obj: any): Promise<any> {
        if (obj instanceof StreamRef) {
            const stream = this._streamReplacer(obj);
            if (!stream) throw new Error(`Stream ID ${obj.id} not found`);
            return stream;
        }

        if (Array.isArray(obj)) {
            return Promise.all(obj.map(item => this.processBody(item)));
        }

        if (obj && typeof obj === 'object') {
            if (obj instanceof Blob || obj instanceof ArrayBuffer || obj instanceof Uint8Array) {
                return obj;
            }
            // POJO
            const newObj: any = {};
            for (const key in obj) {
                newObj[key] = await this.processBody(obj[key]);
            }
            return newObj;
        }

        return obj;
    }
}
