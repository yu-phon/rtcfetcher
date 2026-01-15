export class ReceiveStream {
    private readonly stream: ReadableStream<Uint8Array>;

    constructor(
        private readonly channel: RTCDataChannel
    ) {
        this.stream = new ReadableStream({
            start: (controller) => {
                this.channel.onmessage = (event) => {
                    console.log("channel message")
                    if (event.data instanceof ArrayBuffer) {
                        controller.enqueue(new Uint8Array(event.data));
                    } else if (event.data instanceof Uint8Array) {
                        controller.enqueue(event.data);
                    } else {
                        // Handle other types or ignore? 
                        // For MsgPack codec, we expect binary.
                        // String might be a JSON control message in other contexts, 
                        // but here we likely only deal with binary stream data.
                        // If necessary convert string to Uint8Array.
                        // console.warn("Received non-binary data in ReceiveStream", event.data);
                    }
                };
                this.channel.onclose = () => { console.log("channel close"); controller.close(); }
                this.channel.onerror = (err) => controller.error(err);
                this.channel.onopen = () => console.log("channel open")
            },
            cancel: () => {
                this.channel.close();
            }
        });
    }

    get readable(): ReadableStream<Uint8Array> {
        return this.stream;
    }
}

