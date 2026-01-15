import { encodeNegotiationMessage, decodeNegotiationMessage, NegotiationMessage } from './messages';
import { RTCFetcherError } from '../rtcfetcher/errors/rtc-fetcher-error';

export class Negotiator {
    private static readonly SIGNALING_CHANNEL_ID = 0;
    private static readonly MAX_CHANNEL_ID = 65534; // SCTP limit 65535, 255 reserved

    private pendingReservations: Map<number, { resolve: () => void, reject: (err: Error) => void }> = new Map();

    // Callback when a reservation is acknowledged by the peer (Receiver side)
    public onReserved?: (id: number, channel?: RTCDataChannel, label?: string) => void;

    constructor(
        private readonly signalingChannel: RTCDataChannel,
        private readonly pc: RTCPeerConnection
    ) {
        this.setupSignalingChannel();
    }

    /**
     * Reserve a new DataChannel ID.
     * Uses getStats to find an unused ID, then performs a handshake with the peer.
     */
    async reserveId(label: string): Promise<number> {
        let attempts = 0;
        const maxAttempts = 5;

        const excludedIds = new Set<number>();
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

    private async performHandshake(id: number, label: string): Promise<void> {
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
        let isUsed = await this.isIdUsed(id);

        let probeChannel: RTCDataChannel | undefined;

        // Double check by trying to create (Probe)
        // Some browsers report "unused" in stats but fail to create
        if (!isUsed) {
            try {
                // Keep this channel open to prevent race condition when reusing the ID
                probeChannel = this.pc.createDataChannel('probe', { negotiated: true, id });
            } catch (e) {
                console.warn(`ID ${id} probing failed, marking as used.`, e);
                isUsed = true;
            }
        }

        if (isUsed) {
            this.send({ type: 'NACK', id });
        } else {
            // Tentatively "reserve" by sending ACK.
            // The peer will open the channel immediately.
            // If we also open immediately upon ACK, conflict is avoided because both agree it was free.
            this.send({ type: 'ACK', id });

            if (this.onReserved) {
                this.onReserved(id, probeChannel, message.label);
            }
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

    private async findUnusedId(excludedIds?: Set<number>): Promise<number> {
        const usedIds = await this.getUsedIds();

        // Dynamic limit check
        // Check both maxChannels (standard) and maxDataChannels (legacy/polyfill)
        const sctp: any = this.pc.sctp;
        const max = sctp?.maxChannels ?? sctp?.maxDataChannels;

        // Use detected max, or fallback to 256 if undefined/null to be safe (Chrome default in some cases is 256)
        // If the browser supports more, it usually reports it. If it doesn't report, we assume the lower common limit.
        const limit = (max && max > 0) ? max : 256;

        // Simple strategy: Sequential search to respect SCTP stream/negotiated limits
        // We start from 1 (0 is Signaling) and find the first gap.
        // This avoids hitting high IDs that might be outside the negotiated stream count (even if < maxChannels).
        let candidate = -1;
        for (let i = 1; i < limit; i++) {
            if (i !== Negotiator.SIGNALING_CHANNEL_ID && !usedIds.has(i) && !excludedIds?.has(i)) {
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
