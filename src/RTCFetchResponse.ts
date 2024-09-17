export const protocolFetchResponse = "rtcfetcherres" as const;

function parseRes(header: JSON): RTCFetchResponse {
    
    return new RTCFetchResponse();
}

export class RTCFetchResponse {

    content: Blob | String | ReadableStream;
}