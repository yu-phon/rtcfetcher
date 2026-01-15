import { Negotiator } from '../id-negotiator';
import { NegotiationMessage } from '../messages';

describe('Negotiator', () => {
    let negotiator: Negotiator;
    let mockDataChannel: jest.Mocked<RTCDataChannel>;
    let mockPC: jest.Mocked<RTCPeerConnection>;
    let sentMessages: NegotiationMessage[] = [];

    beforeEach(() => {
        sentMessages = [];
        mockDataChannel = {
            send: jest.fn((message: string) => {
                sentMessages.push(JSON.parse(message));
            }),
            onmessage: null,
            readyState: 'open',
            close: jest.fn(),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            dispatchEvent: jest.fn(),
            id: 0,
            label: 'negotiator',
        } as any;

        const stats = new Map();
        mockPC = {
            getStats: jest.fn().mockResolvedValue(stats),
            createDataChannel: jest.fn().mockReturnValue({
                id: 0,
                label: 'probe',
                close: jest.fn(),
            }),
        } as any;

        negotiator = new Negotiator(mockDataChannel, mockPC);
    });

    afterEach(() => {
        // cleanup if needed
    });

    // ... (lines 38-97 skipped)

    describe('Handling Incoming RESERVE', () => {
        test('should send ACK and trigger onReserved if ID is free', async () => {
            const onReservedSpy = jest.fn();
            negotiator.onReserved = onReservedSpy;

            const reserveMsg = { type: 'RESERVE', id: 100, label: 'req' };
            await mockDataChannel.onmessage!({ data: JSON.stringify(reserveMsg) } as MessageEvent);

            expect(sentMessages.length).toBe(1);
            expect(sentMessages[0]).toEqual({ type: 'ACK', id: 100 });
            // onReserved is now called with (id, channel, label)
            expect(onReservedSpy).toHaveBeenCalledWith(100, expect.objectContaining({ label: 'probe' }), 'req');
        });

        test('should send NACK if ID is used (via getStats)', async () => {
            // Mock getStats to show ID 100 is used
            const stats = new Map();
            stats.set('dc_100', { type: 'data-channel', dataChannelIdentifier: 100, state: 'open' });
            mockPC.getStats.mockResolvedValue(stats);

            const reserveMsg = { type: 'RESERVE', id: 100 };
            await mockDataChannel.onmessage!({ data: JSON.stringify(reserveMsg) } as MessageEvent);

            expect(sentMessages.length).toBe(1);
            expect(sentMessages[0]).toEqual({ type: 'NACK', id: 100 });
        });
    });
});