import { DataChannelController } from '../framing/channel-controller';

export class SendStream {
    private readonly stream: WritableStream<Uint8Array>;
    private writer?: WritableStreamDefaultWriter<Uint8Array>;
    private controller: DataChannelController;
    private sendWindow: number = 0; // Initial window is 0, waiting for grant? Or start with some?
    // Plan said: "Initial window: determined by config (e.g., 64KB? or 0 and wait for initial grant?)."
    // To match common behavior, maybe start with 0 and wait for receiver to say "I'm ready"?
    // Or assume receiver starts with some buffer?
    // Let's assume 0 and wait for initial credit from Receiver (who sends it on start).

    private creditResolvers: (() => void)[] = [];


    constructor(
        channelOrController: RTCDataChannel | DataChannelController,
        private readonly highWaterMark: number = 64 * 1024 // 64KB
    ) {
        // Use duck typing to avoid instanceof issues with dual module loading
        if ('sendCredit' in channelOrController && typeof (channelOrController as any).sendCredit === 'function') {
            this.controller = channelOrController as DataChannelController;
        } else {
            this.controller = new DataChannelController(channelOrController as RTCDataChannel);
        }

        this.controller.onCredit = (amount) => {
            console.log(`[SendStream] Received credit: ${amount}. Current Window: ${this.sendWindow} -> ${this.sendWindow + amount}`);
            this.sendWindow += amount;
            this.processPendingWrites();
        };

        this.stream = new WritableStream({
            write: this.writeChunk.bind(this),
            close: async () => {
                // Wait for bufferedAmount to be 0
                // And give a small grace period for in-flight ACKs or protocol shutdown
                if (this.controller.bufferedAmount > 0) {
                    await this.waitForBufferedAmountLow();
                }
                await new Promise(r => setTimeout(r, 100)); // Grace period
                this.controller.close();
            },
            abort: () => {
                this.controller.close();
            },
        });
    }

    get writable(): WritableStream<Uint8Array> {
        return this.stream;
    }

    async write(data: Uint8Array): Promise<void> {
        if (!this.writer) {
            this.writer = this.stream.getWriter();
        }
        return this.writer.write(data);
    }

    async close(): Promise<void> {
        if (!this.writer) {
            // If not writing manually, acquire writer temporarily to close
            if (this.stream.locked) {
                // If locked by someone else (e.g. pipeTo), we can't close via writer.
                // But underlying channel close is handled by abort/close defined in WritableStream sink.
                // If we want to force close the stream?
                // Usually we just return.
                return;
            }
            this.writer = this.stream.getWriter();
        }
        return this.writer.close();
    }

    private readonly maxChunkSize = 16 * 1024; // 16KB MTU limit

    private async writeChunk(chunk: Uint8Array): Promise<void> {
        if (this.controller.readyState !== 'open') {
            await new Promise<void>((resolve, reject) => {
                if (this.controller.readyState === 'open') return resolve();
                const onOpen = () => {
                    cleanup();
                    resolve();
                };
                const onError = (_e: Event) => {
                    cleanup();
                    reject(new Error('DataChannel error during wait for open'));
                };
                const onClose = () => {
                    cleanup();
                    reject(new Error('DataChannel closed before open'));
                };
                const cleanup = () => {
                    this.controller.underlyingChannel.removeEventListener('open', onOpen);
                    this.controller.underlyingChannel.removeEventListener('error', onError);
                    this.controller.underlyingChannel.removeEventListener('close', onClose);
                };
                this.controller.underlyingChannel.addEventListener('open', onOpen);
                this.controller.underlyingChannel.addEventListener('error', onError);
                this.controller.underlyingChannel.addEventListener('close', onClose);
            });
        }

        let offset = 0;
        while (offset < chunk.byteLength) {
            const remaining = chunk.byteLength - offset;

            // Wait for credit if we have NONE
            while (this.sendWindow === 0) {
                console.log(`[SendStream] Waiting for credit. Needed > 0, Current: ${this.sendWindow}`);
                await this.waitForCredit();
            }

            // Determine size to send
            // We limit by BOTH the credit window AND the MTU size
            const toSendSize = Math.min(remaining, this.sendWindow, this.maxChunkSize);
            const slice = chunk.subarray(offset, offset + toSendSize);

            // Backpressure check (Safety Net)
            if (this.controller.bufferedAmount > this.highWaterMark) {
                await this.waitForBufferedAmountLow();
            }

            try {
                this.controller.sendData(slice);
                this.sendWindow -= toSendSize;
                offset += toSendSize;
                console.log(`[SendStream] Sent fragment ${toSendSize} bytes. Offset: ${offset}/${chunk.byteLength}`);
            } catch (error) {
                console.error('SendStream failed to send:', error);
                throw error;
            }
        }
    }

    private waitForCredit(): Promise<void> {
        return new Promise((resolve) => {
            this.creditResolvers.push(resolve);
        });
    }

    private processPendingWrites() {
        while (this.creditResolvers.length > 0 && this.sendWindow > 0) {
            // We wake up ALL waiters? 
            // Better: wake them up one by one or all, they will check condition again.
            // Since they are in a loop (while), waking them ensures they re-check.
            const resolver = this.creditResolvers.shift();
            if (resolver) resolver();
        }
    }

    private waitForBufferedAmountLow(): Promise<void> {
        return new Promise((resolve) => {
            const handler = () => {
                this.controller.underlyingChannel.removeEventListener('bufferedamountlow', handler);
                resolve();
            };
            this.controller.underlyingChannel.addEventListener('bufferedamountlow', handler);
        });
    }
}

