

import { readyMessage } from "./messages";

const MTU = 1100;

export class DatachannelStreamSender{
    private __dc__: RTCDataChannel;
    private __encoder__: TextEncoder;
    private __transformStream__: TransformStream;
    private __reader__: ReadableStreamDefaultReader;
    private __ready__;
    private __resolve__;
    private __reject__;


    constructor(dc: RTCDataChannel){
        this.__encoder__ = new TextEncoder();
        this.__transformStream__ = this.__setupTransformStream__();
        this.__reader__ = this.__transformStream__.readable.getReader();
        this.__dc__ = this.__setupDataChannel__(dc);
        this.__dc__.onbufferedamountlow = this.__onbufferedamountlow__.bind(this);
        const { promise, resolve, reject } = Promise.withResolvers();
        this.__ready__ = promise;
        this.__resolve__ = resolve;
        this.__reject__ = reject;
    }

    private async __onMessage__(e: MessageEvent){
        if(e.data === readyMessage){
            this.__resolve__();
        }
    }

    private __setupTransformStream__(){
        return new TransformStream({
            transform(chunk, controller) {
                let offset = 0;
                const chunkLength = chunk.byteLength;
                while(offset < chunkLength){
                    const end = Math.min(offset + MTU, chunkLength);
                    const slicedChunk = chunk.slice(offset, end);
                    controller.enqueue(slicedChunk);
                    offset = end;
                }
            }
        });
    }

    private __setupDataChannel__(dc: RTCDataChannel){
        dc.binaryType = "arraybuffer";
        dc.bufferedAmountLowThreshold = 0;
        return dc;
    }

    private async __onbufferedamountlow__(){
        await this.__ready__;
        const { value, done } = await this.__reader__.read();
        if(done){
            this.__dc__.close();
        }else{
            this.__dc__.send(value);
        }
        const { promise, resolve, reject } = Promise.withResolvers();
        this.__ready__ = promise;
        this.__resolve__ = resolve;
        this.__reject__ = reject;
    }

    sendReadableStream(rs: ReadableStream){
        rs.pipeTo(this.__transformStream__.writable);
    }

    sendValue(value: any){
        let encodedArrayBuffer: ArrayBuffer;
        if(typeof value === "string"){
            encodedArrayBuffer = this.__encoder__.encode(value);
        }else{
            encodedArrayBuffer = this.__encoder__.encode(String(value));
        }
        const writer = this.__transformStream__.writable.getWriter();
        writer.write(encodedArrayBuffer);
        writer.close();
    }

    sendMessage(options: object){
        this.__dc__.send(JSON.stringify(options));
    }
}