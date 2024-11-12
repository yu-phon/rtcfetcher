import { DatachannelStreamSender } from "./DatachannelStreamSender";
import { protocolFetchRequest, RTCFetchRequest } from "./RTCFetchRequest";
import { protocolFetchResponse } from "./RTCFetchResponse";

class pendingRequest{
    resolve;
    reject;
    constructor(resolve, reject){
        this.resolve = resolve;
        this.reject = reject;
    }
}

export class RTCFetcher {
    peerConnection: RTCPeerConnection;
    pendingRequests: Map<string, pendingRequest>;
    incomingRequests ;

    constructor(peerConnection: RTCPeerConnection) {
        this.peerConnection = peerConnection;
        this.peerConnection.addEventListener("datachannel", async (event) =>{
            const dc = event.channel;
            await this.__handleMessage__(dc);

        });
    }

    private async __handleMessage__(dc: RTCDataChannel){
        switch (dc.protocol) {
            case protocolFetchRequest:
                const message = await this.__getMessage__(dc);
                try {
                    const messageJSON = JSON.parse(message as string);
                    const request = new RTCFetchRequest(messageJSON);
                    
                } catch (error) {
                    throw new Error("Invalid message");
                }
                break;
            case protocolFetchResponse:
                if (this.pendingRequests.has(dc.label)){
                    const pr = this.pendingRequests.get(dc.label);
                }
                break;
            default:
                break;
        }
    }

    private async __getMessage__(dc: RTCDataChannel){
        return new Promise((resolve, reject) => {
            dc.onmessage = (event) => {
                resolve(event.data);
            };
        });
    }

    async fetch(resource: string, options: object){
        let request: RTCFetchRequest;
        try {
            request = new RTCFetchRequest(resource, options);
        } catch (error) {
            throw error;
        }
        const id = crypto.randomUUID();
        request.id = id;

        const dc = this.peerConnection.createDataChannel(resource, {
            protocol: protocolFetchRequest
        });
        const rtcFetchRequest = new DatachannelStreamSender(dc);
        rtcFetchRequest.sendMessage(options);
        if (request.body != null) {
            if (request.body instanceof ReadableStream) {
                rtcFetchRequest.sendReadableStream(request.body);
            }else{
                rtcFetchRequest.sendValue(request.body);
            }
        }

        const {promise, resolve, reject} = Promise.withResolvers();
        const pr = new pendingRequest(resolve, reject);
        this.pendingRequests.set(id, pr);

        return await promise;

    }
}
