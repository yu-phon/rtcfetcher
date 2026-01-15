export interface IncomingRequest {
    endpoint: string;
    open(): Promise<{
        req: object;
        res: { send: (data: any) => void };
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