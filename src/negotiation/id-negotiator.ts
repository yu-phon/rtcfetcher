import { encodeNegotiationMessage, decodeNegotiationMessage, NegotiationMessage } from './messages';
import { RTCFetcherError } from '../rtcfetcher/errors/rtc-fetcher-error';

export class Negotiator {
    private static readonly SIGNALING_CHANNEL_ID = 0;
    private static readonly MAX_CHANNEL_ID = 65534; // SCTP limit 65535, 255 reserved

    private pendingReservations: Map<number, { resolve: () => void, reject: (err: Error) => void }> = new Map();
    // Reservations that are ACKed but waiting for READY from peer
    private waitingForReady: Map<number, { channel?: RTCDataChannel, label?: string }> = new Map();


    // Callback when a reservation is acknowledged by the peer (Receiver side)
    public onReserved?: (id: number, channel?: RTCDataChannel, label?: string) => void;

    constructor(
        private readonly signalingChannel: RTCDataChannel,
        private readonly pc: RTCPeerConnection
    ) {
        this.setupSignalingChannel();
    }

    public async sendReady(id: number, label?: string): Promise<void> {
        this.send({ type: 'READY', id, label });
    }

    /**
     * Reserve a new DataChannel ID.
     * Uses getStats to find an unused ID, then performs a handshake with the peer.
     */
    async reserveId(label: string, excludedIds: Set<number> = new Set()): Promise<number> {
        let attempts = 0;
        const maxAttempts = 5;


        while (attempts < maxAttempts) {
            attempts++;
            const candidateId = await this.findUnusedId(excludedIds);

            try {
                await this.performHandshake(candidateId, label);
                return candidateId;
            } catch (error) {
                // If NACK or timeout, try next ID
                // console.warn(`ID reservation failed for ${candidateId}, retrying...`, error);
                excludedIds.add(candidateId);
                continue;
            }
        }

        throw new RTCFetcherError('Failed to negotiate DataChannel ID after multiple attempts', 'NEGOTIATION_FAILED');
    }

    public async performHandshake(id: number, label: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingReservations.delete(id);
                reject(new Error('Reservation timeout'));
            }, 3000);

            this.pendingReservations.set(id, {
                resolve: () => {
                    clearTimeout(timeout);
                    resolve();
                },
                reject: (err) => {
                    clearTimeout(timeout);
                    reject(err);
                }
            });

            this.send({ type: 'RESERVE', id, label });
        });
    }

    private async handleReserveRequest(message: NegotiationMessage) {
        const id = message.id;

        // Idempotency check: If we are already waiting for READY for this ID, just resend ACK.
        if (this.waitingForReady.has(id)) {
            console.log(`[Negotiator] Duplicate Reserve Request for ID ${id}. Resending ACK.`);
            this.send({ type: 'ACK', id });
            return;
        }

        let isUsed = await this.isIdUsed(id);
        console.log(`[Negotiator] Handle Reserve ID: ${id}. isUsed (stats): ${isUsed}`);

        let probeChannel: RTCDataChannel | undefined;

        // Double check by trying to create (Probe)
        // Some browsers report "unused" in stats but fail to create
        if (!isUsed) {
            try {
                // Keep this channel open to prevent race condition when reusing the ID
                probeChannel = this.pc.createDataChannel('probe', { negotiated: true, id });
                console.log(`[Negotiator] Probe created for ID ${id}. State: ${probeChannel.readyState}`);
            } catch (e) {
                console.warn(`ID ${id} probing failed, marking as used.`, e);
                isUsed = true;
            }
        }

        if (isUsed) {
            console.warn(`[Negotiator] Rejecting ID ${id} (Used or Probe Failed)`);
            this.send({ type: 'NACK', id });
        } else {
            // Tentatively "reserve" by sending ACK.
            // But WAIT for READY before triggering application logic.
            this.waitingForReady.set(id, { channel: probeChannel, label: message.label });
            this.send({ type: 'ACK', id });

            // NOTE: We do NOT call onReserved here anymore.
            // We wait for Sender to Create Channel -> Send READY -> handleReady -> onReserved.
        }
    }

    private handleReady(message: NegotiationMessage) {
        const id = message.id;
        const waiting = this.waitingForReady.get(id);
        if (waiting) {
            this.waitingForReady.delete(id);
            if (this.onReserved) {
                // Late Binding: Use label from READY message if provided, otherwise fallback to original label
                const finalLabel = message.label || waiting.label;
                this.onReserved(id, waiting.channel, finalLabel);
            }
        } else {
            // Received READY for unknown ID? Maybe we already processed it or timeout.
            // Ignore.
        }
    }

    private handleAck(message: NegotiationMessage) {
        const id = message.id;
        const pending = this.pendingReservations.get(id);
        if (pending) {
            this.pendingReservations.delete(id);
            pending.resolve();
        }
    }

    private handleNack(message: NegotiationMessage) {
        const id = message.id;
        const pending = this.pendingReservations.get(id);
        if (pending) {
            this.pendingReservations.delete(id);
            pending.reject(new Error('ID rejected by peer'));
        }
    }

    private setupSignalingChannel() {
        this.signalingChannel.onmessage = async (event) => {
            // console.log("signaling message")
            try {
                const message = decodeNegotiationMessage(event.data);
                switch (message.type) {
                    case 'RESERVE':
                        await this.handleReserveRequest(message);
                        break;
                    case 'ACK':
                        this.handleAck(message);
                        break;
                    case 'NACK':
                        this.handleNack(message);
                        break;
                    case 'READY':
                        this.handleReady(message);
                        break;
                }
            } catch (error) {
                console.error('Signaling channel error:', error);
            }
        };
    }

    private send(message: NegotiationMessage) {
        if (this.signalingChannel.readyState === 'open') {
            this.signalingChannel.send(encodeNegotiationMessage(message));
        } else {
            console.warn('Signaling channel is not open, cannot send message', message);
        }
    }

    public async findUnusedId(excludedIds?: Set<number>): Promise<number> {
        const usedIds = await this.getUsedIds();

        // Dynamic limit check
        // Check both maxChannels (standard) and maxDataChannels (legacy/polyfill)
        const sctp: any = this.pc.sctp;
        const max = sctp?.maxChannels ?? sctp?.maxDataChannels;

        // Use detected max, or fallback to 256 if undefined/null to be safe
        let limit = (max && max > 0) ? max : 256;

        // Clamp to 255 as requested by user to ensure maximum compatibility
        // (Chrome sometimes reports 65535 but fails above 255 or 2048 depending on version/network)
        console.log(`[Negotiator] findUnusedId. Detected max: ${max}, Using limit: ${255}`);
        if (limit > 255) limit = 255;

        // Randomized Search Strategy to avoid collisions between peers
        // Start at a random index and wrap around.
        const start = Math.floor(Math.random() * (limit - 1)) + 1;
        let candidate = -1;

        for (let offset = 0; offset < limit - 1; offset++) {
            // (start + offset - 1) % (limit - 1) + 1  mapping to range [1, limit-1]
            // Simplified:
            let i = start + offset;
            if (i >= limit) i -= (limit - 1); // Wrap around, skipping 0? 
            // Range 1..limit-1 (size limit-1).
            // Logic: i goes from start...(limit-1)...1...(start-1) (skipping 0 if carefully done)

            // Simpler: use modulo arithmetic on zero-based range then shift
            // Range of valid IDs: [1, limit - 1] -> Size: limit - 1
            const rangeSize = limit - 1;
            // zeroBased index: 0 .. rangeSize - 1
            const zeroBased = (start - 1 + offset) % rangeSize;
            i = zeroBased + 1;

            if (i === Negotiator.SIGNALING_CHANNEL_ID) continue; // Should be covered by range [1, limit-1], but safety check

            if (!usedIds.has(i) && !excludedIds?.has(i)) {
                candidate = i;
                break;
            }
        }

        if (candidate === -1) {
            throw new RTCFetcherError('No available ID found', 'NO_ID_AVAILABLE');
        }
        return candidate;
    }

    private async isIdUsed(id: number): Promise<boolean> {
        const usedIds = await this.getUsedIds();
        return usedIds.has(id);
    }

    private async getUsedIds(): Promise<Set<number>> {
        const stats = await this.pc.getStats();
        const usedIds = new Set<number>();
        stats.forEach(report => {
            if (report.type === 'data-channel' && typeof report.dataChannelIdentifier === 'number') {
                usedIds.add(report.dataChannelIdentifier);
            }
        });
        // Also add pending reservations to assumed used IDs to prevent double booking locally
        this.pendingReservations.forEach((_, id) => usedIds.add(id));
        return usedIds;
    }
}
