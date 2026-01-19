
import { encodeInt, decodeVarInt, writeVarInt } from './utils';
import { huffmanEncode, decodeHuffman } from './huffman';

// --- Encoder Instructions (Sent on Encoder Stream) ---

export type EncoderInstruction =
    | { type: 'insert_with_name_ref', fromStatic: boolean, nameIndex: number, value: string }
    | { type: 'insert_without_name_ref', name: string, value: string }
    | { type: 'duplicate', index: number }
    | { type: 'set_capacity', capacity: number };

export function encodeEncoderInstruction(inst: EncoderInstruction): Uint8Array {
    const parts: number[] = [];

    if (inst.type === 'set_capacity') {
        // 001xxxxx
        const firstByte = 0x20;
        const encOut = encodeInt(inst.capacity, 5);
        parts.push(firstByte | encOut[0], ...encOut.slice(1));
    } else if (inst.type === 'insert_with_name_ref') {
        // 1Txxxxxx
        const tBit = inst.fromStatic ? 0x40 : 0x00;
        const firstByte = 0x80 | tBit;
        const nameEnc = encodeInt(inst.nameIndex, 6);
        parts.push(firstByte | nameEnc[0], ...nameEnc.slice(1));

        // Value
        const valBytes = new TextEncoder().encode(inst.value);
        const valLen = encodeInt(valBytes.length, 7);
        // H=0 (assume raw string for now)
        parts.push(...valLen, ...valBytes);
    } else if (inst.type === 'insert_without_name_ref') {
        // 01NHxxxx
        // 0100xxxx (N=0, H=0)
        const nameBytes = new TextEncoder().encode(inst.name);
        const nameLen = encodeInt(nameBytes.length, 5);
        const firstByte = 0x40; // N=0, H=0
        parts.push(firstByte | nameLen[0], ...nameLen.slice(1), ...nameBytes);

        // Value
        const valBytes = new TextEncoder().encode(inst.value);
        const valLen = encodeInt(valBytes.length, 7);
        parts.push(...valLen, ...valBytes);
    } else if (inst.type === 'duplicate') {
        // 000xxxxx
        const encOut = encodeInt(inst.index, 5); // Relative Index
        parts.push(0x00 | encOut[0], ...encOut.slice(1));
    }

    return new Uint8Array(parts);
}

// --- Decoder Instructions (Sent on Decoder Stream) ---

export type DecoderInstruction =
    | { type: 'section_ack', streamId: number }
    | { type: 'stream_cancellation', streamId: number }
    | { type: 'insert_count_increment', increment: number };

export function encodeDecoderInstruction(inst: DecoderInstruction): Uint8Array {
    const parts: number[] = [];
    if (inst.type === 'section_ack') {
        // 1xxxxxxx
        const enc = encodeInt(inst.streamId, 7);
        parts.push(0x80 | enc[0], ...enc.slice(1));
    } else if (inst.type === 'stream_cancellation') {
        // 01xxxxxx
        const enc = encodeInt(inst.streamId, 6);
        parts.push(0x40 | enc[0], ...enc.slice(1));
    } else if (inst.type === 'insert_count_increment') {
        // 00xxxxxx
        const enc = encodeInt(inst.increment, 6);
        parts.push(0x00 | enc[0], ...enc.slice(1));
    }
    return new Uint8Array(parts);
}

// Parsing Functions (Simplified for Stream Consumption)

export function parseEncoderInstruction(buf: Uint8Array, offset: number): { instruction: EncoderInstruction, nextOffset: number } | null {
    // Need full implementation similar to h3.js extraction logic
    // For now, assume packet boundaries or implement strict parsing
    return null; // Interface placeholder. In real strict stream, we need a buffer manager.
}

// For this task, we will just implement Enc->Dec logic primarily as we are the Sender logic implementer.
