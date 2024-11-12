import { readyMessage } from "./messages";

export const protocolFetchResponse = "rtcfetcherresponse" as const;

export class RTCFetchResponse {
    headers: Headers;
    body: ReadableStream | null;
    id: string;
    constructor(){
    }
}

