export class SignalingChannel {
    private pc: RTCPeerConnection;
    private dc: RTCDataChannel;

    constructor(pc: RTCPeerConnection, dc: RTCDataChannel){
        this.pc = pc;
        this.dc = dc;
    }
    
    private async createIdentifier() {
        const usedIds = new Set<number>();
        const stats = await this.pc.getStats();
        stats.forEach((report) => {
            if (report.type === "data-channel" && report.dataChannelId !== undefined) {
                usedIds.add(report.dataChannelId);
            }
        });

        if (usedIds.size === 255){
            throw new Error("No available identifier.");
        }

        for (let identifier = 0; identifier <= 255; identifier++) {
            if (!usedIds.has(identifier)) {
                return identifier;
            }
        }
    }

    


}