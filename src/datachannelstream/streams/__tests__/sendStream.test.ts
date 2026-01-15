import { SendStream } from '../sendStream';

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
        await sendStream.write(data);
        expect(mockChannel.send).toHaveBeenCalledWith(data);
    });

    test('should wait if bufferedAmount is high', async () => {
        mockChannel.bufferedAmount = 200; // > 100

        // Mock addEventListener to capture the handler
        let activeHandler: () => void;
        mockChannel.addEventListener.mockImplementation((event: string, handler: () => void) => {
            if (event === 'bufferedamountlow') activeHandler = handler;
        });

        const writePromise = sendStream.write(new Uint8Array([1]));

        expect(mockChannel.send).not.toHaveBeenCalled();

        // Simulate bufferedamountlow event
        mockChannel.bufferedAmount = 0;
        activeHandler!();

        await writePromise;
        expect(mockChannel.send).toHaveBeenCalled();
    });

    test('should close channel', async () => {
        await sendStream.close();
        expect(mockChannel.close).toHaveBeenCalled();
    });
});