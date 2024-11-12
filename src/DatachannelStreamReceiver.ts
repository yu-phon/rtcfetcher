

import { readyMessage } from "./messages";

export class DatachannelStreamReceiver {
    private __dc__: RTCDataChannel;
    private __transformStream__: TransformStream;
    private __writer__: WritableStreamDefaultWriter;

    constructor(dc: RTCDataChannel){
        this.__dc__ = dc;
        this.__setupDataChannel__();
        this.__transformStream__ = this.__setupTransformStream__();
        this.__writer__ = this.__transformStream__.writable.getWriter();
        this.__dc__.onmessage = async (e) => this.__onMessage__(e);
    }
    
    private async __onMessage__(e: MessageEvent){
        this.__writer__.write(e.data);
        await this.__writer__.ready;
        this.__sendReady__();
    }

    private __setupTransformStream__(){
        return new TransformStream({
            transform(chunk, controller){
                controller.enqueue(chunk);
            }
        });
    }

    private __setupDataChannel__(){
        this.__dc__.binaryType = "arraybuffer";
    }


    private __sendReady__(){
        this.__dc__.send(readyMessage);
    }

    public get_stream(){
        return this.__transformStream__.readable;
    }
}