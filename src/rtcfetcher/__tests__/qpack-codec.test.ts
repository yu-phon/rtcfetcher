
import { QpackCodec } from '../qpack/qpack-codec';
import { QpackContext } from '../qpack/qpack-context';
import { StreamRef } from '../types/stream-ref';

class MockChannel {
    onmessage: ((event: any) => void) | null = null;
    peer: MockChannel | null = null;
    readyState = 'open';
    send(data: any) {
        if (this.peer && this.peer.onmessage) {
            this.peer.onmessage({ data });
        }
    }
}

describe('QpackCodec', () => {
    let codec: QpackCodec;
    let context: QpackContext;

    beforeEach(() => {
        // Instruction Channel (ID 1): Loopback for "Encoder -> Decoder" instructions
        const instructionChannel = new MockChannel();
        instructionChannel.peer = instructionChannel;

        // Feedback Channel (ID 2): Loopback for "Decoder -> Encoder" feedback (not used in these tests yet)
        const feedbackChannel = new MockChannel();
        feedbackChannel.peer = feedbackChannel;

        context = new QpackContext();
        context.attachChannels(instructionChannel as any, feedbackChannel as any);
        codec = new QpackCodec(context);
    });

    it('should encode and decode flat primitive objects', async () => {
        const obj = {
            label: 'test-endpoint',
            status: 200,
            success: true,
            message: 'hello world'
        };

        const encoded = codec.encode(obj);
        expect(encoded).toBeInstanceOf(Uint8Array);
        expect(encoded.length).toBeGreaterThan(0);

        const decoded = await codec.decode(encoded);
        expect(decoded).toEqual(obj);
    });

    it('should encode and decode nested objects', async () => {
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
        const decoded = await codec.decode(encoded);

        expect(decoded).toEqual(obj);
    });

    it('should handle StreamRef', async () => {
        const obj = {
            stream: new StreamRef(123),
            other: 'data'
        };

        const encoded = codec.encode(obj);
        const decoded = await codec.decode(encoded);

        // Verify StreamRef is restored (instance check or structure check)
        expect(decoded.stream).toBeInstanceOf(StreamRef);
        expect(decoded.stream.id).toBe(123);
        expect(decoded.other).toBe('data');
    });

    it('should handle deep nesting with arrays', async () => {
        const obj = {
            data: [
                { id: 1, val: 'one' },
                { id: 2, val: 'two' }
            ]
        };

        const encoded = codec.encode(obj);
        const decoded = await codec.decode(encoded);

        expect(decoded).toEqual(obj);
    });
});
