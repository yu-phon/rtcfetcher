
import { DynamicTable } from './dynamic-table';
import { qpack_static_table_entries } from './static-table';
import { encodeEncoderInstruction, EncoderInstruction } from './instruction';
// import { RTCPeerConnection } from 'wrtc'; // Removed

// QPACK Context manages the state of Dynamic Tables for a connection.
// It SHOULD own the dedicated DataChannels for instructions.

export class QpackContext {
    // Local Table: Used when *Decoding* incoming QPACK (Remote Encoder updates this)
    public localTable: DynamicTable;

    // Remote Table State: Tracks what we have sent to the Remote Decoder
    // (Used when *Encoding* outgoing QPACK)
    public remoteTable: DynamicTable;

    // Channels
    private encoderStream?: RTCDataChannel;
    private decoderStream?: RTCDataChannel;

    constructor() {
        this.localTable = new DynamicTable(4096);
        this.remoteTable = new DynamicTable(4096);
    }

    public attachChannels(encoderStream: RTCDataChannel, decoderStream: RTCDataChannel) {
        this.encoderStream = encoderStream;
        this.decoderStream = decoderStream;
        this.setupDecoderStreamHandler();
    }

    // Encoder Logic: Insert into dynamic table and send instruction
    public insertToDynamicTable(name: string, value: string): number {
        // 1. Update our view of Remote Table
        this.remoteTable.insert(name, value);

        // 2. Send Instruction to Remote
        if (this.encoderStream && this.encoderStream.readyState === 'open') {
            const inst = encodeEncoderInstruction({
                type: 'insert_without_name_ref',
                name,
                value
            });
            this.encoderStream.send(inst as any);
        } else {
            console.warn('[QPACK] Encoder stream not ready, dynamic insert skipped/queued?');
            // If we can't send instruction, the remote won't know about this entry.
            // We should technically queue or fallback to Literal.
        }

        // Return Absolute Index
        return this.remoteTable.getInsertedCount() - 1;
    }

    // Decoder Logic: Handle incoming instructions from Remote Encoder
    private setupDecoderStreamHandler() {
        if (!this.decoderStream) return;
        this.decoderStream.onmessage = (ev) => {
            const data = new Uint8Array(ev.data as ArrayBuffer);
            // Parse instructions and update localTable
            // This requires a robust stream parser (buffer management)
            // For MVP (Atomic Packets assuming WebSocket-like message boundaries for simple instructions):
            // We assume 1 message = 1 instruction for simplicity in this PoC, 
            // though in TCP/DataChannel generic they are streams.
            // We'll trust the user sends atomic instructions or implement buffering later.
        };
    }
}
