import { StreamRef } from '../types/stream-ref';

export interface RTCResponseStats {
    encodedSize: number;
}

export class RTCResponse {
    private _body: any;
    private _streamReplacer: (ref: StreamRef) => ReadableStream<Uint8Array> | null;
    private _stats?: RTCResponseStats;
    // Cache for rehydrated streams to ensure we return the same instance
    private _streamCache: Map<number, ReadableStream<Uint8Array>> = new Map();

    constructor(
        body: any,
        streamReplacer: (ref: StreamRef) => ReadableStream<Uint8Array> | null,
        stats?: RTCResponseStats
    ) {
        this._body = body;
        this._streamReplacer = streamReplacer;
        this._stats = stats;

        // Return a proxy to handle arbitrary property access
        return new Proxy(this, {
            get: (target, prop, receiver) => {
                // 1. Priority: Return RTCResponse class members (methods like json, ok, etc.)
                if (prop in target) {
                    const value = (target as any)[prop];
                    if (typeof value === 'function') {
                        return value.bind(target);
                    }
                    return value;
                }

                // 2. Fallback: Access property on _body
                console.log(`[RTCResponse Proxy] Accessing: ${String(prop)}`);
                const bodyVal = target._body ? target._body[prop] : undefined;
                console.log(`[RTCResponse Proxy] Value:`, bodyVal);
                return target._wrapValue(bodyVal);
            }
        });
    }

    // Helper to wrap values in Proxy recursively or rehydrate streams
    private _wrapValue(value: any): any {
        if (value instanceof StreamRef) {
            return this._getOrHydrateStream(value);
        }

        if (value && typeof value === 'object') {
            // Recursive Proxy for nested objects
            return new Proxy(value, {
                get: (target, prop) => {
                    const val = (target as any)[prop];
                    return this._wrapValue(val);
                }
            });
        }

        return value;
    }

    private _getOrHydrateStream(ref: StreamRef): ReadableStream<Uint8Array> {
        if (this._streamCache.has(ref.id)) {
            return this._streamCache.get(ref.id)!;
        }

        const stream = this._streamReplacer(ref);
        if (!stream) {
            throw new Error(`Stream ID ${ref.id} not found`);
        }
        this._streamCache.set(ref.id, stream);
        return stream;
    }

    get qpackStats(): RTCResponseStats | undefined {
        return this._stats;
    }

    get ok(): boolean {
        return true;
    }

    async json(): Promise<any> {
        return this.processBodyAndBufferStreams(this._body);
    }

    async text(): Promise<string> {
        const processed = await this.processBodyAndBufferStreams(this._body);
        if (typeof processed === 'string') return processed;
        if (processed instanceof Uint8Array) return new TextDecoder().decode(processed);
        return JSON.stringify(processed);
    }

    async blob(): Promise<Blob> {
        const processed = await this.processBodyAndBufferStreams(this._body);
        if (processed instanceof Blob) return processed;
        if (processed instanceof Uint8Array) return new Blob([processed as unknown as BlobPart]);
        if (processed instanceof ArrayBuffer) return new Blob([processed]);

        // If it's an object, JSON stringify it and make it a blob?
        // Standard fetch behavior for .blob() on JSON response is blob of that JSON text.
        return new Blob([JSON.stringify(processed)], { type: 'application/json' });
    }

    // Recursively replace StreamRef with buffered content (Uint8Array)
    private async processBodyAndBufferStreams(obj: any): Promise<any> {
        if (obj instanceof StreamRef) {
            const stream = this._getOrHydrateStream(obj);
            return this._consumeStream(stream);
        }

        // Avoid infinite recursion on cyclic structures (schema-less JSON usually DAG)
        // Check array
        if (Array.isArray(obj)) {
            return Promise.all(obj.map(item => this.processBodyAndBufferStreams(item)));
        }

        if (obj && typeof obj === 'object') {
            if (obj instanceof Blob || obj instanceof ArrayBuffer || obj instanceof Uint8Array) {
                return obj;
            }
            if (obj instanceof ReadableStream) {
                return this._consumeStream(obj as ReadableStream<Uint8Array>);
            }

            // POJO
            const newObj: any = {};
            for (const key in obj) {
                newObj[key] = await this.processBodyAndBufferStreams(obj[key]);
            }
            return newObj;
        }

        return obj;
    }

    private async _consumeStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
        if (stream.locked) {
            // Already locked? If it was locked by our proxy getReader() usage, we might fail here.
            // But standard fetch `.json()` fails if body used.
            // We should check if we can check locked state.
            throw new Error('Stream is locked. Cannot buffer content for json().');
        }

        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        let totalLength = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                totalLength += value.byteLength;
            }
        } finally {
            reader.releaseLock();
        }

        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return combined;
    }
}
