
import { QpackCodec } from '../qpack/qpack-codec';
import { StreamRef } from '../types/stream-ref';

describe('QpackCodec', () => {
    let codec: QpackCodec;

    beforeEach(() => {
        codec = new QpackCodec();
    });

    it('should encode and decode flat primitive objects', () => {
        const obj = {
            label: 'test-endpoint',
            status: 200,
            success: true,
            message: 'hello world'
        };

        const encoded = codec.encode(obj);
        expect(encoded).toBeInstanceOf(Uint8Array);
        expect(encoded.length).toBeGreaterThan(0);

        const decoded = codec.decode(encoded);
        expect(decoded).toEqual(obj);
    });

    it('should encode and decode nested objects', () => {
        const obj = {
            meta: {
                version: 1,
                author: {
                    name: 'yuphon',
                    admin: false
                }
            },
            tags: ['a', 'b', 'c']
        };

        const encoded = codec.encode(obj);
        const decoded = codec.decode(encoded);

        expect(decoded).toEqual(obj);
    });

    it('should handle StreamRef', () => {
        const obj = {
            stream: new StreamRef(123),
            other: 'data'
        };

        const encoded = codec.encode(obj);
        const decoded = codec.decode(encoded);

        // Verify StreamRef is restored (instance check or structure check)
        expect(decoded.stream).toBeInstanceOf(StreamRef);
        expect(decoded.stream.id).toBe(123);
        expect(decoded.other).toBe('data');
    });

    it('should handle deep nesting with arrays', () => {
        const obj = {
            data: [
                { id: 1, val: 'one' },
                { id: 2, val: 'two' }
            ]
        };

        const encoded = codec.encode(obj);
        const decoded = codec.decode(encoded);

        expect(decoded).toEqual(obj);
    });
});
