export interface StreamMessage {
    // FlowWindowUpdateの場合は'flow_window_update'、Dataの場合は'data'
    type: 'flow_window_update' | 'data';
    // データ、FlowWindowUpdateの場合はnumber、Dataの場合はArrayBuffer[]
    data: number | ArrayBuffer[];
}

export interface DataChannelStreamUpgradeMessage {
    type: 'upgrade';
    data: {
        // senderかreceiverか
        type: 'sender' | 'receiver';
        // ウィンドウサイズ
        windowSize: number;
    };
}

