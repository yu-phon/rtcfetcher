
import { DynamicTable } from './dynamic-table';
import { qpack_static_table_entries } from './static-table';
import { encodeEncoderInstruction, EncoderInstruction } from './instruction';
import { decodeVarInt } from './utils';
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
        // console.log(`[QpackContext] Attached Channels. Encoder: ${encoderStream.id}, Decoder: ${decoderStream.id}, ReadyState: ${decoderStream.readyState}`);
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

    private pendingWaiters: { count: number, resolve: () => void }[] = [];

    public waitForInsertCount(required: number): Promise<void> {
        if (this.localTable.getInsertedCount() >= required) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            // console.log(`[QpackContext] Waiting for Insert Count ${required} (Current: ${this.localTable.getInsertedCount()})`);
            this.pendingWaiters.push({ count: required, resolve });
        });
    }

    private checkWaiters() {
        const current = this.localTable.getInsertedCount();
        const remaining: { count: number, resolve: () => void }[] = [];

        for (const w of this.pendingWaiters) {
            if (current >= w.count) {
                w.resolve();
            } else {
                remaining.push(w);
            }
        }
        this.pendingWaiters = remaining;
    }

    // Decoder Logic: Handle incoming instructions from Remote Encoder
    private setupDecoderStreamHandler() {
        if (!this.decoderStream) return;
        this.decoderStream.onmessage = (ev) => {
            // console.log(`[QPACK Decoder] Received ${ev.data.byteLength} bytes on stream ${this.decoderStream?.id}`);
            const data = new Uint8Array(ev.data as ArrayBuffer);
            let pos = 0;
            while (pos < data.length) {
                const byte = data[pos];
                // Insert Without Name Reference: 01NHxxxx
                // 0100xxxx (N=0, H=0 for now)

                if ((byte & 0xC0) === 0x40) {
                    // 1. Name Length (5-bit prefix)
                    const nameLenDec = decodeVarInt(data, 5, pos);
                    const nameLen = nameLenDec.value;
                    let curr = nameLenDec.next;

                    if (curr + nameLen > data.length) {
                        console.warn("[QPACK Decoder] Name truncated");
                        return;
                    }

                    const nameBytes = data.subarray(curr, curr + nameLen);
                    const name = new TextDecoder().decode(nameBytes);
                    curr += nameLen;

                    // 2. Value Length (7-bit prefix)
                    if (curr >= data.length) return;

                    const valLenDec = decodeVarInt(data, 7, curr);
                    const valLen = valLenDec.value;
                    curr = valLenDec.next;

                    if (curr + valLen > data.length) {
                        console.warn("[QPACK Decoder] Value truncated");
                        return;
                    }

                    const valBytes = data.subarray(curr, curr + valLen);
                    const value = new TextDecoder().decode(valBytes);
                    curr += valLen;

                    // Update Local Table
                    // console.log(`[QPACK Decoder] Insert: ${name}: ${value}`);
                    const idx = this.localTable.insert(name, value);
                    // console.log(`[QPACK Decoder] Inserted at Abs ${idx}`);

                    this.checkWaiters();

                    pos = curr;
                } else {
                    // Unknown or unimplemented instruction for this MVP
                    // Skip rest to avoid infinite loop or errors
                    console.warn(`[QPACK Decoder] Unknown instruction byte: ${byte.toString(16)}`);
                    break;
                }
            }
        };
    }
}
