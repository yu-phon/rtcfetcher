import { RTCFetcher } from '../rtcfetcher';
import { RTCResponse } from '../rtc-response';
import { SendStream } from '../../../datachannelstream/streams/sendStream';

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

    // We need more complex mocks to test full fetch flow (negotiation, messaging).
    // Given the complexity of mocking Negotiator + Streams + MsgPack + DataChannels,
    // this test file will be a placeholder for now to ensure basic instantiation works.
});
