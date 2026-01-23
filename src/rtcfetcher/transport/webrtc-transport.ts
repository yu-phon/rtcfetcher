
import { ITransport } from '../core/interfaces';
import { Negotiator } from '../../negotiation/id-negotiator';

interface PooledChannel {
    id: number;
    channel: RTCDataChannel;
}

export interface WebRTCTransportConfig {
    prefetchPoolSize?: number;
}

export class WebRTCTransport implements ITransport {
    private negotiator: Negotiator;
    private masterChannel: RTCDataChannel;
    private idPool: PooledChannel[] = [];
    private incomingHandler?: (id: number, channel: RTCDataChannel, label?: string) => void;

    // Store pooled channels by ID for quick retrieval in createChannel
    private pooledChannelMap: Map<number, RTCDataChannel> = new Map();

    public readonly opened: Promise<void>;

    constructor(
        private pc: RTCPeerConnection,
        private config: WebRTCTransportConfig = {}
    ) {
        // Setup Master Channel (ID 0)
        this.masterChannel = pc.createDataChannel('rtc-fetcher-master', { negotiated: true, id: 0 });
        this.negotiator = new Negotiator(this.masterChannel, pc);

        // Setup Negotiator callback
        this.negotiator.onReserved = (id, channel, label) => {
            if (this.incomingHandler) {
                // If the negotiator has a probe channel (channel argument), we should pass it?
                // The interface expects (id, channel, label).
                // Negotiator.onReserved signature: (id: number, channel?: RTCDataChannel, label?: string) => void
                // If channel is missing (e.g. ready without probe?), we might need to create it or wait?
                // In current Negotiator, channel is the Probe Channel if provided.
                // If no channel, we must create it.
                const ch = channel || this.pc.createDataChannel(label || 'unknown', { negotiated: true, id });
                this.incomingHandler(id, ch, label);
            }
        };

        this.opened = new Promise<void>((resolve) => {
            const checkOpen = () => {
                if (this.masterChannel.readyState === 'open') {
                    // Start filling the pool once connected
                    this.refillPool();
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
        // Check Pool first
        if (this.idPool.length > 0) {
            const pooled = this.idPool.shift()!;
            console.log(`[WebRTCTransport] Using Pooled ID: ${pooled.id}`);

            // Clean up from map so createChannel knows it's "consumed" from pool stash?
            // Actually createChannel needs to FIND it.
            // But we shouldn't use it again for another reserveId.
            // We keep it in pooledChannelMap until createChannel retrieves it?
            // Or better: createChannel checks if it exists in map.
            // BUT: if we use pool, we return ID. The caller acts as if it reserved it.
            // Then caller calls createChannel(label, id).

            // Trigger background refill
            this.refillPool();

            return pooled.id;
        }

        console.log(`[WebRTCTransport] Pool Empty. Negotiating directly...`);
        // Add pool IDs to excluded
        // (Caller might not know about internal pool)
        const allExcluded = new Set(excluded);
        this.idPool.forEach(p => allExcluded.add(p.id));
        // Also exclude QPACK 1 & 2 explicitly? Caller should handle this,
        // but for safety we can add them if we know about them. 
        // Ideally exclude logic is passed from caller.

        return await this.negotiator.reserveId(label, allExcluded);
    }

    public createChannel(label: string, id: number): RTCDataChannel {
        // Check if we have a pre-created channel in the pool map
        if (this.pooledChannelMap.has(id)) {
            const channel = this.pooledChannelMap.get(id)!;
            this.pooledChannelMap.delete(id);
            // Also ensure it's removed from idPool array if somehow it wasn't
            // (It should have been removed in reserveId)
            return channel;
        }

        return this.pc.createDataChannel(label, { negotiated: true, id });
    }

    public async sendReadySignal(id: number, label: string): Promise<void> {
        return this.negotiator.sendReady(id, label);
    }

    private async refillPool() {
        const targetSize = this.config.prefetchPoolSize ?? 5;
        if (this.idPool.length >= targetSize) return;

        console.log(`[WebRTCTransport] Refilling ID Pool (Current: ${this.idPool.length}, Target: ${targetSize})`);

        while (this.idPool.length < targetSize) {
            try {
                // Excluded Ids logic
                // We need to know what IDs are in use by the APP too.
                // But we don't know that here easily without caller passing it.
                // Negotiator scans `getStats` so it knows physical channels.
                // But it doesn't know about IDs reserved but not yet created?
                // The Negotiator logic handles `findUnusedId`.

                // We must exclude:
                // 1. Existing Pool
                // 2. QPACK (1, 2) - This is application specific, but strict constraint in current RTCFetcher. 
                //    Ideally we can inject reserved IDs config.
                //    For now, I'll hardcode 1, 2 exclusion here or rely on getStats if they exist.
                //    If they are created, getStats sees them.

                const excluded = new Set<number>([1, 2, ...this.idPool.map(p => p.id)]);

                const id = await this.negotiator.reserveId('__pooled__', excluded);
                const channel = this.pc.createDataChannel('__pooled__', { negotiated: true, id });
                console.log(`[WebRTCTransport] Created Pooled Channel ID: ${id}`);

                const pooled = { id, channel };
                this.idPool.push(pooled);
                this.pooledChannelMap.set(id, channel);

            } catch (e) {
                console.warn('[WebRTCTransport] Failed to refill ID pool:', e);
                break;
            }
        }
    }
}
