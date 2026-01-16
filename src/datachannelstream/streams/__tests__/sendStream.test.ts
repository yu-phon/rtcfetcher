import { SendStream } from '../sendStream';
import { MSG_TYPE_DATA, MSG_TYPE_CREDIT } from '../../framing/channel-controller';

const createCreditFrame = (amount: number) => {
    const frame = new Uint8Array(5);
    frame[0] = MSG_TYPE_CREDIT;
    new DataView(frame.buffer).setUint32(1, amount, true);
    return frame;
};


describe('SendStream', () => {
    let sendStream: SendStream;
    let mockChannel: any;

    beforeEach(() => {
        mockChannel = {
            send: jest.fn(),
            close: jest.fn(),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            bufferedAmount: 0,
            readyState: 'open'
        };
        sendStream = new SendStream(mockChannel, 100); // Low threshold for testing
    });

    test('should write data to channel', async () => {
        const data = new Uint8Array([1, 2, 3]);
        const writePromise = sendStream.write(data);

        // Give credit
        const creditFrame = createCreditFrame(100);
        // Simulate receiving credit
        if (mockChannel.onmessage) {
            mockChannel.onmessage({ data: creditFrame });
        }

        await writePromise;

        // Expect Framed Data
        // [0x01, 1, 2, 3]
        const expected = new Uint8Array([MSG_TYPE_DATA, 1, 2, 3]);
        expect(mockChannel.send).toHaveBeenCalledWith(expected);
        expect(mockChannel.send).toHaveBeenCalledWith(expected);
    });

    test('should fragment data if window is small', async () => {
        const data = new Uint8Array([1, 2, 3, 4, 5]);
        const writePromise = sendStream.write(data);

        // Give partial credit (3 bytes)
        const creditFrame1 = createCreditFrame(3);
        if (mockChannel.onmessage) mockChannel.onmessage({ data: creditFrame1 });

        // Wait for first fragments (1 tick)
        await new Promise(r => setTimeout(r, 0));

        // Expect fragment 1 (3 bytes)
        // [0x01, 1, 2, 3]
        expect(mockChannel.send).toHaveBeenCalledWith(new Uint8Array([MSG_TYPE_DATA, 1, 2, 3]));

        // Give remaining credit (2 bytes)
        const creditFrame2 = createCreditFrame(2);
        if (mockChannel.onmessage) mockChannel.onmessage({ data: creditFrame2 });

        await writePromise;

        expect(mockChannel.send).toHaveBeenCalledWith(new Uint8Array([MSG_TYPE_DATA, 4, 5]));
    });

    test('should fragment data exceeding MTU limit', async () => {
        // Send window is large enough, but MTU limit (16KB) should force fragmentation
        const largeData = new Uint8Array(20000); // ~20KB
        // Give enough credit
        const creditFrame = createCreditFrame(30000);
        if (mockChannel.onmessage) mockChannel.onmessage({ data: creditFrame });

        const writePromise = sendStream.write(largeData);

        // Wait for async processing
        await new Promise(r => setTimeout(r, 0));

        await writePromise;

        // Metric: 16KB = 16 * 1024 = 16384 bytes
        // Expected calls:
        // 1. 1 + 16384 bytes (Header + 16KB)
        // 2. 1 + (20000 - 16384) bytes = 1 + 3616 bytes
        expect(mockChannel.send).toHaveBeenCalledTimes(2);

        // Check first chunk size
        const firstCallArg = mockChannel.send.mock.calls[0][0];
        expect(firstCallArg.byteLength).toBe(1 + 16384);

        // Check second chunk size
        const secondCallArg = mockChannel.send.mock.calls[1][0];
        expect(secondCallArg.byteLength).toBe(1 + (20000 - 16384));
    });

    test('should wait if bufferedAmount is high', async () => {
        // Provide Credit first, so we hit the bufferedAmount check
        if (mockChannel.onmessage) {
            mockChannel.onmessage({ data: createCreditFrame(1000) });
        }

        mockChannel.bufferedAmount = 200; // > 100

        // Mock addEventListener to capture the handler
        let activeHandler: () => void;
        mockChannel.addEventListener.mockImplementation((event: string, handler: () => void) => {
            if (event === 'bufferedamountlow') activeHandler = handler;
        });

        const writePromise = sendStream.write(new Uint8Array([1]));

        // Note: write() is async. We need to wait a tick for it to execute up to "await".
        await new Promise(r => setTimeout(r, 0));

        // Should have NOT sent yet due to bufferedAmount
        // BUT mockChannel.send is a jest.fn. We check if called with data?
        // Wait, did it send credit frame? No, Receiver sends credit.
        // Did we send anything? No.
        expect(mockChannel.send).not.toHaveBeenCalledWith(expect.objectContaining({ 0: MSG_TYPE_DATA }));

        // Simulate bufferedamountlow event
        mockChannel.bufferedAmount = 0;
        if (activeHandler!) activeHandler();

        await writePromise;
        expect(mockChannel.send).toHaveBeenCalled();
    });

    test('should close channel', async () => {
        await sendStream.close();
        expect(mockChannel.close).toHaveBeenCalled();
    });
});