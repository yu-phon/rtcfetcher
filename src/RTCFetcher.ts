export class RTCFetcher {
    peerConnection: RTCPeerConnection;

    constructor(peerConnection: RTCPeerConnection) {
        this.peerConnection = peerConnection;
    }
}