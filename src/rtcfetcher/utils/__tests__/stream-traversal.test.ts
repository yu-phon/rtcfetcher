import { traverseAndOptimizeStreams } from '../stream-traversal';
import { StreamRef } from '../../types/stream-ref';
// Mock ReadableStream if not available in checking environment (though standard now)
// We assume checking environment has ReadableStream or polyfill.

describe('traverseAndOptimizeStreams', () => {
    const mockReplacer = jest.fn(async (stream: ReadableStream) => {
        return new StreamRef(123);
    });

    beforeEach(() => {
        mockReplacer.mockClear();
    });

    test('should return primitives as is', async () => {
        const input = { a: 1, b: 'small', c: true, d: null };
        const result = await traverseAndOptimizeStreams(input, mockReplacer);
        expect(result).toEqual(input);
        expect(mockReplacer).not.toHaveBeenCalled();
    });

    test('should replace ReadableStream', async () => {
        const stream = new ReadableStream();
        const input = { data: stream };
        const result = await traverseAndOptimizeStreams(input, mockReplacer);
        expect(result.data).toBeInstanceOf(StreamRef);
        expect(mockReplacer).toHaveBeenCalledWith(stream);
    });

    test('should convert large Uint8Array to stream', async () => {
        const largeData = new Uint8Array(16 * 1024 + 1); // > 16KB
        const input = { buffer: largeData };
        const result = await traverseAndOptimizeStreams(input, mockReplacer);

        expect(result.buffer).toBeInstanceOf(StreamRef);
        expect(mockReplacer).toHaveBeenCalled();
        // Check passed stream
        const passedStream = mockReplacer.mock.calls[0][0];
        expect(passedStream).toBeInstanceOf(ReadableStream);
    });

    test('should keep small Uint8Array as is', async () => {
        const smallData = new Uint8Array(16 * 1024); // == 16KB (Threshold is >)
        const input = { buffer: smallData };
        const result = await traverseAndOptimizeStreams(input, mockReplacer);

        expect(result.buffer).toBe(smallData);
        expect(mockReplacer).not.toHaveBeenCalled();
    });

    test('should convert large String to stream', async () => {
        const largeString = 'a'.repeat(16 * 1024 + 1);
        const input = { text: largeString };
        const result = await traverseAndOptimizeStreams(input, mockReplacer);

        expect(result.text).toBeInstanceOf(StreamRef);
        expect(mockReplacer).toHaveBeenCalled();
    });

    test('should traverse nested objects and arrays', async () => {
        const stream = new ReadableStream();
        const input = {
            list: [
                { deep: stream },
                'normal'
            ]
        };
        const result = await traverseAndOptimizeStreams(input, mockReplacer);

        expect(result.list[0].deep).toBeInstanceOf(StreamRef);
        expect(result.list[1]).toBe('normal');
        expect(mockReplacer).toHaveBeenCalledWith(stream);
    });
});
