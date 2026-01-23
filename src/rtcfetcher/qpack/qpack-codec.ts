import { ICodec } from '../core/interfaces';
import { encodeQpack, decodeQpack, Header } from './qpack'; // Update qpack.ts exports later
import { StreamRef } from '../types/stream-ref';
import { RTCSerializationError } from '../errors/rtc-fetcher-error';
import { QpackContext } from './qpack-context';

const STREAM_REF_PREFIX = "::streamref::";

export class QpackCodec implements ICodec {
    private context: QpackContext;

    constructor(context?: QpackContext) {
        this.context = context || new QpackContext();
    }

    public getContext() {
        return this.context;
    }

    // Flattens an object into headers
    private flattenObject(obj: any, prefix: string = '', headers: Header[]) {
        if (obj === null || obj === undefined) return;

        if (obj instanceof StreamRef) {
            headers.push({ name: prefix, value: STREAM_REF_PREFIX + obj.id });
            return;
        }

        if (Array.isArray(obj)) {
            obj.forEach((item, index) => {
                this.flattenObject(item, `${prefix}[${index}]`, headers);
            });
            return;
        }

        if (typeof obj === 'object') {
            if (obj instanceof Uint8Array || obj instanceof ArrayBuffer) {
                // Should be handled better, but consistent with v1
            }

            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    const newKey = prefix ? `${prefix}.${key}` : key;
                    this.flattenObject(obj[key], newKey, headers);
                }
            }
            return;
        }

        headers.push({ name: prefix, value: String(obj) });
    }

    private inflateHeaders(headers: Header[]): any {
        const result: any = {};
        for (const h of headers) {
            const key = h.name;
            let value: any = h.value;
            if (typeof value === 'string' && value.startsWith(STREAM_REF_PREFIX)) {
                const id = parseInt(value.substring(STREAM_REF_PREFIX.length), 10);
                value = new StreamRef(id);
            } else if (!isNaN(Number(value)) && value.trim() !== '') {
                value = Number(value);
            } else if (value === 'true') value = true;
            else if (value === 'false') value = false;

            this.setPath(result, key, value);
        }
        return result;
    }

    private setPath(obj: any, path: string, value: any) {
        const normalizedPath = path.replace(/\[(\d+)\]/g, '.$1');
        const parts = normalizedPath.split('.').filter(p => p !== '');
        let current = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            const nextPart = parts[i + 1];
            const isNextIndex = /^\d+$/.test(nextPart);

            if (!(part in current)) {
                current[part] = isNextIndex ? [] : {};
            }
            current = current[part];
        }
        const last = parts[parts.length - 1];
        if (Array.isArray(current) && /^\d+$/.test(last)) {
            current[parseInt(last)] = value;
        } else {
            current[last] = value;
        }
    }

    encode(data: any): Uint8Array {
        try {
            const headers: Header[] = [];
            this.flattenObject(data, '', headers);
            // Pass context to encoder
            // This requires updating qpack.ts
            return encodeQpack(headers, this.context);
        } catch (error) {
            throw new RTCSerializationError('Failed to encode data with QPACK', error);
        }
    }

    async decode(data: Uint8Array): Promise<any> {
        while (true) {
            try {
                // Pass context to decoder
                const headers = decodeQpack(data, this.context);
                return this.inflateHeaders(headers);
            } catch (error: any) {
                // Check for HolBlocking
                // Error message format: "QPACK Blocked: Required Insert Count X > Local Y"
                const msg = error.message || "";
                if (msg.startsWith("QPACK Blocked")) {
                    const match = msg.match(/Required Insert Count (\d+)/);
                    if (match) {
                        const required = parseInt(match[1], 10);
                        // Wait for context to have this count
                        await this.context.waitForInsertCount(required);
                        continue; // Retry
                    }
                }
                throw new RTCSerializationError('Failed to decode QPACK data', error);
            }
        }
    }
}

// Global instance needs to be able to accept Connection Context eventually.
// For now, single instance is tricky if we want per-connection state.
// RTCFetcher should own the Codec instance.
export const qpackCodec = new QpackCodec();
