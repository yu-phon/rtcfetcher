import { encode, decode, ExtensionCodec } from '@msgpack/msgpack';
import { RTCFetcherError, RTCSerializationError } from '../errors/rtc-fetcher-error';
import { StreamRef } from '../types/stream-ref';

// ExtensionTypeの定義
const HEADERS_EXT_TYPE = 0x01;
const STREAM_REF_EXT_TYPE = 0x02;

export class MsgPackCodec {
    private extensionCodec: ExtensionCodec;

    constructor() {
        this.extensionCodec = new ExtensionCodec();
        this.initializeExtensions();
    }

    private initializeExtensions(): void {
        // Headers型の処理
        this.extensionCodec.register({
            type: HEADERS_EXT_TYPE,
            encode: (object: unknown) => {
                if (object instanceof Headers) {
                    const entries: [string, string][] = [];
                    object.forEach((value, key) => {
                        entries.push([key, value]);
                    });
                    return encode(entries);
                }
                return null;
            },
            decode: (data: Uint8Array) => {
                const entries = decode(data) as [string, string][];
                const headers = new Headers();
                for (const [key, value] of entries) {
                    headers.append(key, value);
                }
                return headers;
            },
        });

        // StreamRef型の処理 (ReadableStreamのプレースホルダー)
        this.extensionCodec.register({
            type: STREAM_REF_EXT_TYPE,
            encode: (object: unknown) => {
                if (object instanceof StreamRef) {
                    return encode(object.id);
                }
                return null;
            },
            decode: (data: Uint8Array) => {
                const id = decode(data) as number;
                return new StreamRef(id);
            },
        });
    }

    encode(data: any): Uint8Array {
        try {
            return encode(data, { extensionCodec: this.extensionCodec });
        } catch (error) {
            throw new RTCSerializationError('Failed to encode data with MessagePack', error);
        }
    }

    decode(data: Uint8Array): any {
        try {
            return decode(data, { extensionCodec: this.extensionCodec });
        } catch (error) {
            throw new RTCSerializationError('Failed to decode MessagePack data', error);
        }
    }
}

export const msgpackCodec = new MsgPackCodec();
