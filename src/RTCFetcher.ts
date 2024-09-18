export class RTCFetcher {
    peerConnection: RTCPeerConnection;

    constructor(peerConnection: RTCPeerConnection) {
        this.peerConnection = peerConnection;
        this.peerConnection.addEventListener("datachannel", (evt) =>{
            
        });
    }

    fetch(){

    }
}