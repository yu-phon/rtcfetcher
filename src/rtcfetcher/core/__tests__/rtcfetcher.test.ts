import { RTCFetcher } from '../rtcfetcher';


jest.mock('../../../datachannelstream/streams/sendStream');
jest.mock('../../../datachannelstream/streams/receiveStream');
jest.mock('../../../negotiation/id-negotiator');

describe('RTCFetcher', () => {
    let pc: RTCPeerConnection;
    let masterChannel: RTCDataChannel;
    let fetcher: RTCFetcher;

    beforeEach(() => {
        masterChannel = {
            id: 0,
            label: 'rtc-fetcher-master',
            readyState: 'open',
            onopen: null,
            onclose: null,
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            close: jest.fn()
        } as any;

        pc = {
            createDataChannel: jest.fn((label, init) => {
                if (init?.id === 0) return masterChannel;
                return {
                    id: init?.id,
                    label,
                    readyState: 'open',
                    send: jest.fn(),
                    close: jest.fn(),
                    addEventListener: jest.fn(),
                } as any;
            }),
            addEventListener: jest.fn(),
        } as any;

        fetcher = new RTCFetcher(pc);
    });

    test('should initialize correctly', async () => {
        await fetcher.opened;
        expect(pc.createDataChannel).toHaveBeenCalledWith('rtc-fetcher-master', expect.objectContaining({ id: 0 }));
    });

    test('should refill pool on initialization', async () => {
        // Mock reserveId to return sequential IDs
        const mockReserveId = jest.fn();
        let idCounter = 100;
        mockReserveId.mockImplementation(() => Promise.resolve(idCounter++));

        // Access the mock instance
        const { Negotiator } = jest.requireMock('../../../negotiation/id-negotiator');
        Negotiator.mockImplementation(() => {
            return {
                onReserved: null,
                reserveId: mockReserveId,
                findUnusedId: jest.fn().mockResolvedValue(999),
                performHandshake: jest.fn().mockResolvedValue(undefined),
                sendReady: jest.fn().mockResolvedValue(undefined),
            };
        });

        // Re-create fetcher with new mock
        fetcher = new RTCFetcher(pc, { prefetchPoolSize: 2 });
        await fetcher.opened;

        // Allow microtasks to run (refillPool is async)
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(mockReserveId).toHaveBeenCalledTimes(2); // Should fill up to 2

        // Now fetch. Should use pooled ID (100) and trigger refill.
        // We need to mock internal traverseStreams too or pass simple body.

        // Mock private method traverseAndExtractStreams to just return body
        (fetcher as any).traverseAndExtractStreams = jest.fn((body, _replacer) => Promise.resolve(body));

        // Mock sendResponse to avoid errors
        (fetcher as any).sendResponse = jest.fn();

        // Trigger fetch but DO NOT await the result because it waits for a response from the "server" (which doesn't exist)
        // We just want to verify it consumes an ID and triggers refill.
        fetcher.fetch('test-endpoint', { data: 'hello' }).catch(() => { });

        // Allow microtasks to run (refillPool is async)
        await new Promise(resolve => setTimeout(resolve, 20));

        // reserveId should be called one more time for refill
        expect(mockReserveId).toHaveBeenCalledTimes(3);
    });
});
