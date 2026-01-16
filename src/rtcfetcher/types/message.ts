export interface IncomingRequest {
    label: string;
    open(): Promise<{
        req: { label: string, body: any };
        res: { send: (data: any) => void; close: () => void };
    }>;
    reject(reason?: string): void;
}

export interface NegotiationMessage {
    type: 'id_request' | 'id_response' | 'id_conflict' | 'request' | 'request_rejected';
    data: {
        requestedId?: number;
        assignedId?: number;
        availableIds?: number[];
        endpoint?: string;
        reason?: string;
    };
}