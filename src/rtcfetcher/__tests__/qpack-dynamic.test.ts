
import { QpackCodec } from '../qpack/qpack-codec';
import { QpackContext } from '../qpack/qpack-context';

describe('Qpack Dynamic Table', () => {
    let context: QpackContext;
    let codec: QpackCodec;

    beforeEach(() => {
        context = new QpackContext();
        // We can mock channels if we want to verify instructions are sent,
        // but for loopback decoding (localTable vs remoteTable sync), 
        // we might need to manually pipe encoderStream to decoderStream 
        // OR rely on the fact that 'insertToDynamicTable' updates 'remoteTable' instantly,
        // and 'decode' uses 'localTable' which usually requires Update Instructions.

        // ISSUE: 
        // In my current implementation of `qpack.ts`, `decodeQpack` uses `context.localTable`.
        // `encodeQpack` uses `context.remoteTable`.
        // `encodeQpack` inserts into `remoteTable` and sends instructions.
        // `decodeQpack` expects `localTable` to be updated via instructions.

        // In a real network, Encoder(Peer A) -> Channel -> Decoder(Peer B).
        // Here, we differ.
        // If we use ONE codec instance to encode AND decode (Loopback),
        // The Encoder updates 'remoteTable'.
        // The Decoder reads from 'localTable'.
        // They are separate tables in `QpackContext`.
        // So `localTable` starts empty.
        // We must sync them for the test to pass if we use Dynamic Table.

        // Sync Logic for Test:
        // Mock the channels so that what Encoder writes to encoderStream 
        // gets fed into Decoder's processing logic (which updates localTable).

        const mockEncoderChannel = {
            readyState: 'open',
            send: (data: Uint8Array) => {
                // Manually trigger "Receive" on context (which we haven't exposed well for generic input)
                // But wait, `QpackContext.setupDecoderStreamHandler` attaches to `decoderStream.onmessage`.
                // So if we pass a mock decoderStream, we can verify.
            },
            addEventListener: () => { },
            removeEventListener: () => { }
        } as unknown as RTCDataChannel;

        const mockDecoderChannel = {
            readyState: 'open',
            onmessage: null,
            addEventListener: () => { },
            removeEventListener: () => { }
        } as unknown as RTCDataChannel;

        context.attachChannels(mockEncoderChannel, mockDecoderChannel);

        // Hook up loopback: Encoder Send -> Decoder OnMessage
        mockEncoderChannel.send = (data: Uint8Array) => {
            if (mockDecoderChannel.onmessage) {
                // Simulate event
                mockDecoderChannel.onmessage({ data: data.buffer } as MessageEvent);
            }
        };

        codec = new QpackCodec(context);
    });

    it('should compress repeated headers using dynamic table', async () => {
        // Object 1
        const obj1 = {
            "x-custom-header": "very-long-value-that-should-be-indexed",
            "x-repeated": "data"
        };

        // Encode 1
        const encoded1 = codec.encode(obj1);

        // Decode 1 (Should work effectively, assuming instructions processed)
        // Note: Instructions sent during encode() must be processed before decode() 
        // if the block refers to them.
        // Since our loopback is synchronous but 'onmessage' might be async in browser, 
        // here it is direct function call so it is sync.

        const decoded1 = codec.decode(encoded1);
        expect(decoded1).toEqual(obj1);

        // Object 2 (Same keys/values)
        const obj2 = {
            "x-custom-header": "very-long-value-that-should-be-indexed",
            "x-repeated": "other"
        };

        const encoded2 = codec.encode(obj2);

        // Expect compression:
        // 'x-custom-header': '...' should be indexed.
        // So encoded2 should be smaller than encoded1 for that field (key+value vs index).
        // (encoded1 has overhead of literal name+value)
        // (encoded2 has overhead of index)

        console.log(`Size 1: ${encoded1.length}, Size 2: ${encoded2.length}`);

        // Verify 'x-custom-header' was dynamic (size check)
        // With simple overhead approx:
        // Obj1: Name(15) + Val(35) + Overhead ~ 50+
        // Obj2: Index(2) ~ 2
        // It should be significantly smaller if other fields don't dominate.

        // Note: 'x-repeated' is DIFFERENT value, so value is literal, but NAME might be indexed?
        // We implemented name reference logic too.

        expect(encoded2.length).toBeLessThan(encoded1.length);

        const decoded2 = codec.decode(encoded2);
        expect(decoded2).toEqual(obj2);
    });
});
