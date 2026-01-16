export type NegotiationMessageType = 'RESERVE' | 'ACK' | 'NACK' | 'READY';

export interface NegotiationMessage {
    type: NegotiationMessageType;
    id: number;      // Candidate ID
    label?: string;  // Optional: Context or intended label
}

export const encodeNegotiationMessage = (message: NegotiationMessage): string => {
    return JSON.stringify(message);
};

export const decodeNegotiationMessage = (data: string): NegotiationMessage => {
    return JSON.parse(data) as NegotiationMessage;
};
