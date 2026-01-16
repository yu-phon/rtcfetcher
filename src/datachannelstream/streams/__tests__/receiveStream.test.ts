import { ReceiveStream } from '../receiveStream';
import { MSG_TYPE_DATA, MSG_TYPE_CREDIT } from '../../framing/channel-controller';

describe('ReceiveStream', () => {
    let mockChannel: any;
    let receiveStream: ReceiveStream;

    beforeEach(() => {
        mockChannel = {
            send: jest.fn(),
            onmessage: null,
            onclose: null,
            onerror: null,
            close: jest.fn(),
            readyState: 'open',
            addEventListener: jest.fn(),
            removeEventListener: jest.fn()
        };
        receiveStream = new ReceiveStream(mockChannel);
    });

    test('should push data to readable stream', async () => {
        const reader = receiveStream.readable.getReader();
        const data = new Uint8Array([1, 2, 3]);

        // Simulate message
        // Needs HEADER
        const frame = new Uint8Array(1 + data.byteLength);
        frame[0] = MSG_TYPE_DATA;
        frame.set(data, 1);

        // ReceiveStream wraps channel in DataChannelController, which listens to onmessage
        // BUT we mocked onmessage as "null" initially.
        // DataChannelController sets it.
        // We need to trigger the handler SET by DataChannelController.
        mockChannel.onmessage({ data: frame.buffer });

        const { value, done } = await reader.read();
        expect(value).toEqual(data);
        expect(done).toBeFalsy();
    });

    test('should handle stream cancel', async () => {
        const reader = receiveStream.readable.getReader();
        await reader.cancel();
        expect(mockChannel.close).toHaveBeenCalled();
    });

    test('should close stream on channel close', async () => {
        const reader = receiveStream.readable.getReader();
        const readPromise = reader.read();

        mockChannel.onclose();

        const { done } = await readPromise;
        expect(done).toBeTruthy();
    });
});