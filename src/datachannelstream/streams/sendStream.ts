export class SendStream {
    private readonly stream: WritableStream<Uint8Array>;
    private writer?: WritableStreamDefaultWriter<Uint8Array>;

    constructor(
        private readonly channel: RTCDataChannel,
        private readonly highWaterMark: number = 64 * 1024 // 64KB
    ) {
        this.stream = new WritableStream({
            write: this.writeChunk.bind(this),
            close: () => channel.close(),
            abort: () => channel.close(),
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

    private async writeChunk(chunk: Uint8Array): Promise<void> {
        if (this.channel.readyState !== 'open') {
            await new Promise<void>((resolve, reject) => {
                if (this.channel.readyState === 'open') return resolve();
                const onOpen = () => {
                    cleanup();
                    resolve();
                };
                const onError = (e: Event) => {
                    cleanup();
                    reject(new Error('DataChannel error during wait for open'));
                };
                const onClose = () => {
                    cleanup();
                    reject(new Error('DataChannel closed before open'));
                };
                const cleanup = () => {
                    this.channel.removeEventListener('open', onOpen);
                    this.channel.removeEventListener('error', onError);
                    this.channel.removeEventListener('close', onClose);
                };
                this.channel.addEventListener('open', onOpen);
                this.channel.addEventListener('error', onError);
                this.channel.addEventListener('close', onClose);
            });
        }

        // Backpressure check
        if (this.channel.bufferedAmount > this.highWaterMark) {
            await this.waitForBufferedAmountLow();
        }

        try {
            this.channel.send(chunk as any);
            console.log("chunk sent")
        } catch (error) {
            console.error('SendStream failed to send:', error);
            throw error;
        }
    }

    private waitForBufferedAmountLow(): Promise<void> {
        return new Promise((resolve) => {
            const handler = () => {
                this.channel.removeEventListener('bufferedamountlow', handler);
                resolve();
            };
            this.channel.addEventListener('bufferedamountlow', handler);
        });
    }
}

