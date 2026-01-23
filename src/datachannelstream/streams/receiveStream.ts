import { DataChannelController } from '../framing/channel-controller';
import { DEFAULT_INITIAL_WINDOW } from '../framing/constants';

export class ReceiveStream {
    private readonly stream: ReadableStream<Uint8Array>;
    private controller: DataChannelController;
    private unacknowledgedBytes = 0;
    private readonly initialCredit = DEFAULT_INITIAL_WINDOW;


    constructor(
        channelOrController: RTCDataChannel | DataChannelController
    ) {
        // Use duck typing to avoid instanceof issues with dual module loading
        if ('sendCredit' in channelOrController && typeof (channelOrController as any).sendCredit === 'function') {
            this.controller = channelOrController as DataChannelController;
        } else {
            this.controller = new DataChannelController(channelOrController as RTCDataChannel);
        }

        this.stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
                const init = () => {
                    // Initial credit grant
                    this.controller.sendCredit(this.initialCredit);
                    // console.debug(`[ReceiveStream] Sent initial credit: ${this.initialCredit}`);

                    this.controller.onData = (data) => {
                        controller.enqueue(data);
                        this.unacknowledgedBytes += data.byteLength;

                        // If stream is hungry, replenish credits immediately
                        if (controller.desiredSize !== null && controller.desiredSize > 0) {
                            this.flushCredits();
                        }
                    };
                };

                if (this.controller.readyState === 'open') {
                    init();
                } else {
                    const onOpen = () => {
                        this.controller.underlyingChannel.removeEventListener('open', onOpen);
                        init();
                    };
                    this.controller.underlyingChannel.addEventListener('open', onOpen);
                }

                this.controller.underlyingChannel.onclose = () => {
                    // console.debug("channel close");
                    try {
                        controller.close();
                    } catch (e) {
                        // Controller might be already closed or errored
                    }
                }
                this.controller.underlyingChannel.onerror = (event) => {
                    const err = event instanceof ErrorEvent ? event.error : event;
                    // "OperationError" often happens during close race conditions in WebRTC.
                    if (err && err.name === 'OperationError') {
                        // console.warn("[ReceiveStream] Ignoring OperationError on DataChannel (likely close race).", err);
                        return;
                    }
                    try {
                        controller.error(err || new Error("RTCDataChannel error"));
                    } catch (e) {
                        // Controller might be already closed
                    }
                };

                // this.controller.underlyingChannel.addEventListener('open', () => console.log("channel open"));
            },
            pull: (_controller) => {
                // Stream has capacity, flush any pending credits
                this.flushCredits();
            },
            cancel: () => {
                this.controller.close();
            }
        }, new ByteLengthQueuingStrategy({ highWaterMark: this.initialCredit }));
    }

    private flushCredits() {
        if (this.unacknowledgedBytes > 0) {
            // console.debug(`[ReceiveStream] Flushing credits: ${this.unacknowledgedBytes}`);
            this.controller.sendCredit(this.unacknowledgedBytes);
            this.unacknowledgedBytes = 0;
        }
    }

    get readable(): ReadableStream<Uint8Array> {
        return this.stream;
    }
}

