
import { ITransport } from '../core/interfaces';
import { Negotiator } from '../../negotiation/id-negotiator';
import { IdPoolManager } from '../../negotiation/id-pool-manager';
import { SIGNALING_CHANNEL_ID } from '../../negotiation/constants';

export interface WebRTCTransportConfig {
    prefetchPoolSize?: number;
}

export class WebRTCTransport implements ITransport {
    private negotiator: Negotiator;
    private poolManager: IdPoolManager;
    private masterChannel: RTCDataChannel;
    private incomingHandler?: (id: number, channel: RTCDataChannel, label?: string) => void;

    public readonly opened: Promise<void>;

    constructor(
        private pc: RTCPeerConnection,
        private config: WebRTCTransportConfig = {}
    ) {
        // Setup Master Channel (ID 0)
        this.masterChannel = pc.createDataChannel('rtc-fetcher-master', { negotiated: true, id: SIGNALING_CHANNEL_ID });
        this.negotiator = new Negotiator(this.masterChannel, pc);
        this.poolManager = new IdPoolManager(this.negotiator, pc, config);

        // Setup Negotiator callback
        this.negotiator.onReserved = (id, channel, label) => {
            if (this.incomingHandler) {
                // Negotiator guarantee: channel exists (Probe or from Pool)
                this.incomingHandler(id, channel, label);
            }
        };

        this.opened = new Promise<void>((resolve) => {
            const checkOpen = () => {
                if (this.masterChannel.readyState === 'open') {
                    // Start filling the pool once connected
                    this.poolManager.refillPool();
                    resolve();
                    return true;
                }
                return false;
            };

            if (!checkOpen()) {
                this.masterChannel.addEventListener('open', () => checkOpen());
            }
        });
    }

    public onIncomingChannel(handler: (id: number, channel: RTCDataChannel, label?: string) => void): void {
        this.incomingHandler = handler;
    }

    public async reserveId(label: string, excluded: Set<number>): Promise<number> {
        return this.poolManager.reserveId(label, excluded);
    }

    public createChannel(label: string, id: number): RTCDataChannel {
        return this.poolManager.getOrCreateChannel(label, id);
    }

    public async sendReadySignal(id: number, label: string): Promise<void> {
        return this.negotiator.sendReady(id, label);
    }
}
