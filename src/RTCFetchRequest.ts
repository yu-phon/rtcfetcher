"use strict";

import { readyMessage } from "./messages";

export const protocolFetchRequest = "rtcfetcherrequest" as const;

const MTU = 1100;

export class RTCFetchRequest {
    label: string;
    headers: Headers;
    body: ReadableStream | null;
    id: string;

    constructor(options: Object){
        this.body = null;
        Object.assign(this, options);
    }

    toObject() {
        return {
            label: this.label,
            headers: Object.fromEntries(this.headers.entries()),
            body: this.body,  
        };
    }
}

