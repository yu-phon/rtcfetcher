import { Negotiator } from './id-negotiator';
import { POOLED_CHANNEL_LABEL } from './constants';

interface PooledChannel {
    id: number;
    channel: RTCDataChannel;
}

export interface IdPoolManagerConfig {
    prefetchPoolSize?: number;
}

export class IdPoolManager {
    private idPool: PooledChannel[] = [];
    private pooledChannelMap: Map<number, RTCDataChannel> = new Map();

    constructor(
        private readonly negotiator: Negotiator,
        private readonly pc: RTCPeerConnection,
        private readonly config: IdPoolManagerConfig = {}
    ) { }

    public async reserveId(label: string, excludedIds: Set<number>): Promise<number> {
        // 1. Try to use a pooled ID
        if (this.idPool.length > 0) {
            const pooled = this.idPool.shift()!;
            console.log(`[IdPoolManager] Using Pooled ID: ${pooled.id}`);

            // Trigger background refill
            this.refillPool();

            return pooled.id;
        }

        // 2. Determine all IDs currently known to be "in use" or "reserved"
        // This includes whatever the caller knows (excludedIds), plus our internal pool
        // (though if pool is empty, this is just empty list, but good for correctness if logic changes)
        console.log(`[IdPoolManager] Pool Empty. Negotiating directly...`);

        const allExcluded = new Set(excludedIds);
        this.idPool.forEach(p => allExcluded.add(p.id));

        // 3. Negotiate a fresh ID
        return await this.negotiator.reserveId(label, allExcluded);
    }

    /**
     * Retrieves a channel for the given ID. 
     * If the ID was from the pool, returns the pre-created channel.
     * Otherwise, creates a new one.
     */
    private earlyDataMap: Map<number, MessageEvent[]> = new Map();

    /**
     * Retrieves a channel for the given ID. 
     * If the ID was from the pool, returns the pre-created channel.
     * Otherwise, creates a new one.
     */
    public getOrCreateChannel(label: string, id: number): RTCDataChannel {
        if (this.pooledChannelMap.has(id)) {
            const channel = this.pooledChannelMap.get(id)!;
            this.pooledChannelMap.delete(id);

            // Unhook temporary listener
            channel.onmessage = null;

            // Transfer early data if any
            const earlyData = this.earlyDataMap.get(id);
            if (earlyData && earlyData.length > 0) {
                console.log(`[IdPoolManager] Transferring ${earlyData.length} early packets for ID ${id}`);
                // @ts-ignore
                channel.__earlyData = earlyData;
            }
            this.earlyDataMap.delete(id);

            return channel;
        }

        return this.pc.createDataChannel(label, { negotiated: true, id });
    }

    public async refillPool() {
        const targetSize = this.config.prefetchPoolSize ?? 5;
        if (this.idPool.length >= targetSize) return;

        console.log(`[IdPoolManager] Refilling ID Pool (Current: ${this.idPool.length}, Target: ${targetSize})`);

        while (this.idPool.length < targetSize) {
            try {
                // Must exclude current pool + QPACK (1, 2) + caller known IDs?
                // We rely on Negotiator checking getStats().
                // But we must exclude what we hold in memory (this.idPool)
                // Also 1 & 2 are system reserved in RTCFetcher protocol, ideally passed in config or constants.
                // For now, hardcode 1, 2 as they are part of protocol assumption.
                const excluded = new Set<number>([1, 2, ...this.idPool.map(p => p.id)]);

                const id = await this.negotiator.reserveId(POOLED_CHANNEL_LABEL, excluded);
                const channel = this.pc.createDataChannel(POOLED_CHANNEL_LABEL, { negotiated: true, id });

                // Attach temporary listener to buffer early data (e.g. Credits)
                // IMPORANT: Attach BEFORE sending READY to ensure we don't miss immediate response
                channel.onmessage = (event) => {
                    if (!this.earlyDataMap.has(id)) {
                        this.earlyDataMap.set(id, []);
                    }
                    console.log(`[IdPoolManager] Buffering early packet for ID ${id} (${event.data.byteLength || 0} bytes)`);
                    this.earlyDataMap.get(id)!.push(event);
                };

                // CRITICAL: Complete handshake so receiver knows it's reserved and keeps it open
                await this.negotiator.sendReady(id, POOLED_CHANNEL_LABEL);

                console.log(`[IdPoolManager] Created Pooled Channel ID: ${id}`);

                const pooled = { id, channel };
                this.idPool.push(pooled);
                this.pooledChannelMap.set(id, channel);

            } catch (e) {
                console.warn('[IdPoolManager] Failed to refill ID pool:', e);
                break;
            }
        }
    }
}
