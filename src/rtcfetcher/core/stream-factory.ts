import { DataChannelController, SendStream, ReceiveStream } from '../../datachannelstream';

export interface IStreamFactory {
    createSendStream(channel: RTCDataChannel | DataChannelController, minBufferSize?: number): SendStream;
    createReceiveStream(channel: RTCDataChannel | DataChannelController): ReceiveStream;
    createController(channel: RTCDataChannel): DataChannelController;
}

export class StreamFactory implements IStreamFactory {
    createSendStream(channel: RTCDataChannel | DataChannelController, minBufferSize?: number): SendStream {
        return new SendStream(channel, minBufferSize);
    }

    createReceiveStream(channel: RTCDataChannel | DataChannelController): ReceiveStream {
        return new ReceiveStream(channel);
    }

    createController(channel: RTCDataChannel): DataChannelController {
        return new DataChannelController(channel);
    }
}
