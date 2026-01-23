import { DataChannelController } from '../framing/channel-controller';
import { DEFAULT_INITIAL_WINDOW } from '../framing/constants';

export class SendStream {
    private readonly stream: WritableStream<Uint8Array>;
    private writer?: WritableStreamDefaultWriter<Uint8Array>;
    private controller: DataChannelController;
    private sendWindow: number = 0; // Starts at 0, waits for initial credit from Receiver.

    private creditResolvers: (() => void)[] = [];


    constructor(
        channelOrController: RTCDataChannel | DataChannelController,
        private readonly highWaterMark: number = DEFAULT_INITIAL_WINDOW
    ) {
        // Use duck typing to avoid instanceof issues with dual module loading
        if ('sendCredit' in channelOrController && typeof (channelOrController as any).sendCredit === 'function') {
            this.controller = channelOrController as DataChannelController;
        } else {
            this.controller = new DataChannelController(channelOrController as RTCDataChannel);
        }

        this.controller.onCredit = (amount) => {
            // console.debug(`[SendStream] Received credit: ${amount}. Window: ${this.sendWindow} -> ${this.sendWindow + amount}`);
            this.sendWindow += amount;
            this.processPendingWrites();
        };

        this.stream = new WritableStream({
            write: this.writeChunk.bind(this),
            close: async () => {
                // Wait for bufferedAmount to be 0
                if (this.controller.bufferedAmount > 0) {
                    await this.waitForBufferedAmountLow();
                }
                await new Promise(r => setTimeout(r, 50)); // Short grace period
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
            if (this.stream.locked) {
                // Stream is locked by another writer (e.g. pipeTo), we cannot close via writer.
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
                const onError = (e: Event) => {
                    cleanup();
                    const err = (e as any).error || new Error('DataChannel error during wait for open');
                    reject(err);
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

            while (this.sendWindow === 0) {
                // console.debug(`[SendStream] Waiting for credit.`);
                await this.waitForCredit();
            }

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

