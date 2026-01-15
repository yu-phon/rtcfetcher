import { ReceiveStream } from '../receiveStream';

describe('ReceiveStream', () => {
    let mockChannel: any;
    let receiveStream: ReceiveStream;

    beforeEach(() => {
        mockChannel = {
            onmessage: null,
            onclose: null,
            onerror: null,
            close: jest.fn()
        };
        receiveStream = new ReceiveStream(mockChannel);
    });

    test('should push data to readable stream', async () => {
        const reader = receiveStream.readable.getReader();
        const data = new Uint8Array([1, 2, 3]);

        // Simulate message
        mockChannel.onmessage({ data: data.buffer });

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