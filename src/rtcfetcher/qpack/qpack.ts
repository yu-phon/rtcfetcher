
import { decodeVarInt, encodeInt, concatUint8Arrays } from './utils';
import { decodeHuffman, huffmanEncode } from './huffman';
import { qpack_static_table_entries } from './static-table';
import { QpackContext } from './qpack-context';

export interface Header {
    name: string;
    value: string;
}

export function encodeQpack(headers: Header[], context?: QpackContext): Uint8Array {
    const out: number[] = [];

    // Prefix Calculation
    // Required Insert Count: Needs to effectively "lock" the state required for this block.
    // If we use dynamic table entries, we must specify the `ReqInsertCount` that covers those entries.
    // For now, if we insert new items *during* this encoding, we might increment.

    // Simplification: We will try to create dynamic entries for repeated items, 
    // OR we will reference existing ones.

    let requiredInsertCount = 0;
    // Delta Base = ReqInsertCount (S=0, Sign=+) for simplicity if we don't do complex delta logic.

    const fieldLines: number[] = [];

    // We need to determine ReqInsertCount before writing the prefix.
    // So we assume we encode first, tracking max index used.

    let maxDynamicIndexUsed = -1; // -1 means none

    for (const h of headers) {
        const nameLc = h.name.toLowerCase();
        const valueStr = String(h.value);

        // 1. Static Table Search
        let bestStaticIndex = -1;
        let bestStaticNameMatch = -1;

        // Note: This is O(N) scan. 
        for (let i = 0; i < qpack_static_table_entries.length; i++) {
            const entry = qpack_static_table_entries[i];
            if (entry[0] === nameLc) {
                if (entry[1] === valueStr) {
                    bestStaticIndex = i;
                    break;
                }
                if (bestStaticNameMatch === -1) bestStaticNameMatch = i;
            }
        }

        // 2. Dynamic Table Search (if context available)
        // We check remoteTable because that represents what the Encoder (us) has sent/established.
        let bestDynamicIndex = -1; // Absolute Index
        let bestDynamicNameMatch = -1; // Absolute Index

        if (context) {
            const match = context.remoteTable.search(nameLc, valueStr);
            if (match) {
                if (match.valueMatch) bestDynamicIndex = match.index;
                else if (match.nameMatch) bestDynamicNameMatch = match.index;
            }
        }

        // Decision Logic
        // Prefer Full Match (Static > Dynamic usually, but Static is cheaper)

        if (bestStaticIndex !== -1) {
            // Indexed Field Line (Static)
            // 1Txxxxxx, T=1
            const enc = encodeInt(bestStaticIndex, 6);
            fieldLines.push(0x80 | 0x40 | enc[0], ...enc.slice(1));
            continue;
        }

        if (bestDynamicIndex !== -1) {
            // Indexed Field Line (Dynamic)
            // 1Txxxxxx, T=0
            // Index needs to be Relative.
            // Relative Index = Base - 1 - Absolute Index
            // Let Base be current Insert Count (of remote table)
            const currentInsertCount = context!.remoteTable.getInsertedCount();

            // To reference this, we need 'ReqInsertCount' to be at least (AbsoluteIndex + 1)
            // maxDynamicIndexUsed tracks the max absolute index we reference.
            if (bestDynamicIndex > maxDynamicIndexUsed) {
                maxDynamicIndexUsed = bestDynamicIndex;
            }

            // Base = ReqInsertCount (Simplest strategy)
            // But we need to decide Base properly.
            // RFC: Base Index is the value of the 'Insert Count' ...
            // Let's use Base = currentInsertCount.

            const relativeIndex = currentInsertCount - 1 - bestDynamicIndex;
            const enc = encodeInt(relativeIndex, 6);
            fieldLines.push(0x80 | 0x00 | enc[0], ...enc.slice(1));
            continue;
        }

        // No Full Match.
        // Should we insert into Dynamic Table?
        // Heuristic: If we have context, and it's not a StreamRef, insert it.
        // (StreamRefs are unique, bad for compression)
        const isStreamRef = valueStr.startsWith("::streamref::");

        if (context && !isStreamRef) {
            // Insert into Dynamic Table
            // This sends instruction on dedicated stream
            const absIndex = context.insertToDynamicTable(nameLc, valueStr);

            // And now we reference it immediately as a POST-BASE Index? 
            // Or just reference it normally if we assume it's "in the table" for this block?
            // "The encoder ADDS the entry to the dynamic table... effectively sending the instruction."
            // The Header Block can reference it.

            if (absIndex > maxDynamicIndexUsed) {
                maxDynamicIndexUsed = absIndex;
            }

            // Use Indexed Field Line (Dynamic)
            const currentInsertCount = context.remoteTable.getInsertedCount();
            const relativeIndex = currentInsertCount - 1 - absIndex;
            // Since we just inserted, relativeIndex should be 0 (if Base == currentCount)

            const enc = encodeInt(relativeIndex, 6);
            fieldLines.push(0x80 | enc[0], ...enc.slice(1));
            continue;
        }

        // Fallback: Literal

        // Name Reference?
        if (bestStaticNameMatch !== -1) {
            // Literal with Name Ref (Static)
            // 01N0xxxx, N=1 (Static)
            const enc = encodeInt(bestStaticNameMatch, 4);
            fieldLines.push(0x40 | 0x10 | enc[0], ...enc.slice(1));

            const valBytes = new TextEncoder().encode(valueStr);
            const valLen = encodeInt(valBytes.length, 7);
            fieldLines.push(...valLen, ...valBytes);
        }
        else if (bestDynamicNameMatch !== -1) {
            // Literal with Name Ref (Dynamic)
            // 01N0xxxx, N=0 (Dynamic)
            // Check ReqInsertCount
            if (bestDynamicNameMatch > maxDynamicIndexUsed) maxDynamicIndexUsed = bestDynamicNameMatch;

            const currentInsertCount = context!.remoteTable.getInsertedCount();
            const relativeIndex = currentInsertCount - 1 - bestDynamicNameMatch;

            const enc = encodeInt(relativeIndex, 4);
            fieldLines.push(0x40 | 0x00 | enc[0], ...enc.slice(1));

            const valBytes = new TextEncoder().encode(valueStr);
            const valLen = encodeInt(valBytes.length, 7);
            fieldLines.push(...valLen, ...valBytes);
        }
        else {
            // Literal with Literal Name
            // 0010xxxx
            const nameBytes = new TextEncoder().encode(nameLc);
            const nameLen = encodeInt(nameBytes.length, 3);
            fieldLines.push(0x20 | nameLen[0], ...nameLen.slice(1), ...nameBytes);

            const valBytes = new TextEncoder().encode(valueStr);
            const valLen = encodeInt(valBytes.length, 7);
            fieldLines.push(...valLen, ...valBytes);
        }
    }

    // Calc Prefix
    // maxDynamicIndexUsed is 0-based absolute index.
    // Required Insert Count = maxDynamicIndexUsed + 1
    requiredInsertCount = (maxDynamicIndexUsed === -1) ? 0 : (maxDynamicIndexUsed + 1);

    // Wire RIC
    // RFC 4.5.1: Encoded Required Insert Count
    // If RIC == 0, wire is 0.
    // If RIC > 0, wire is (RIC % (2*MaxEntries)) + 1 ? No, just RIC.
    // "The value is encoded as an integer with an 8-bit prefix."

    // Base Delta
    // Base Index = ReqInsertCount.
    // Delta Base = Base Index - ReqInsertCount = 0.
    // Sign = 0 (+)

    // Prefix Byte 1: Required Insert Count
    const ricEnc = encodeInt(requiredInsertCount, 8);
    out.push(...ricEnc);

    // Prefix Byte 2+: Delta Base
    // 0Sxxxxxx (S=0)
    const dbEnc = encodeInt(0, 7);
    out.push(0x00 | dbEnc[0], ...dbEnc.slice(1));

    out.push(...fieldLines);

    return new Uint8Array(out);
}

export function decodeQpack(buf: Uint8Array, context?: QpackContext): Header[] {
    let pos = 0;
    const headers: Header[] = [];

    // 1. Required Insert Count
    const ric = decodeVarInt(buf, 8, pos);
    pos = ric.next;
    const requiredInsertCount = ric.value;

    // 2. Delta Base
    const db = decodeVarInt(buf, 7, pos);
    const sign = (buf[pos] & 0x80) !== 0; // S bit
    pos = db.next;

    // Calculate Base Index
    // If S=0 (+), Base = ReqInsertCount + Delta
    // If S=1 (-), Base = ReqInsertCount - Delta - 1
    let baseIndex: number;
    if (!sign) {
        baseIndex = requiredInsertCount + db.value;
    } else {
        baseIndex = requiredInsertCount - db.value - 1;
    }

    // Sync Check:
    // Receiver needs to have at least `requiredInsertCount` entries in the dynamic table.
    // If context.localTable.insertedCount < requiredInsertCount, we must BLOCK.
    // Since we can't async block here easily without logic change, we assume
    // DataChannel ordering (Context updates arrive before Header Block) 
    // OR we throw "HolBlockingError" if strictly needed.
    // For this implementation, we throw if missing.

    if (context && context.localTable.getInsertedCount() < requiredInsertCount) {
        // Critical: The instruction describing the entry hasn't arrived/processed yet.
        throw new Error(`QPACK Blocked: Required Insert Count ${requiredInsertCount} > Local ${context.localTable.getInsertedCount()}`);
    }

    while (pos < buf.length) {
        let byte = buf[pos];

        // A. Indexed Field Line (1xxxxxxx)
        if ((byte & 0x80) === 0x80) {
            const hasT = (byte & 0x40) !== 0;
            const idxRes = decodeVarInt(buf, 6, pos);
            pos = idxRes.next;

            if (hasT) {
                // Static
                if (idxRes.value < qpack_static_table_entries.length) {
                    const e = qpack_static_table_entries[idxRes.value];
                    headers.push({ name: e[0], value: e[1] });
                } else throw new Error("QPACK Static Index Error");
            } else {
                // Dynamic
                // Absolute Index = Base Index - Relative Index - 1
                const absIndex = baseIndex - idxRes.value - 1;
                if (!context) throw new Error("QPACK Dynamic Entry without Context");
                const entry = context.localTable.getEntry(absIndex);
                if (!entry) throw new Error(`QPACK Dynamic Entry Not Found: Abs ${absIndex}`);
                headers.push({ name: entry.name, value: entry.value });
            }
            continue;
        }

        // B. Literal with Name Ref (01xxxxxx)
        if ((byte & 0xC0) === 0x40) {
            const hasT = (byte & 0x10) !== 0;
            const nameIdxRes = decodeVarInt(buf, 4, pos);
            pos = nameIdxRes.next;

            let name = "";
            if (hasT) {
                if (nameIdxRes.value < qpack_static_table_entries.length) {
                    name = qpack_static_table_entries[nameIdxRes.value][0];
                } else throw new Error("QPACK Static Name Index Error");
            } else {
                const absIndex = baseIndex - nameIdxRes.value - 1;
                if (!context) throw new Error("QPACK Dynamic Name Ref without Context");
                const entry = context.localTable.getEntry(absIndex);
                if (!entry) throw new Error(`QPACK Dynamic Entry Not Found: Abs ${absIndex}`);
                name = entry.name;
            }

            // Value
            const valH = (buf[pos] & 0x80) !== 0;
            const valLenRes = decodeVarInt(buf, 7, pos);
            pos = valLenRes.next;
            const valBytes = buf.subarray(pos, pos + valLenRes.value);
            pos += valLenRes.value;
            const value = valH ? decodeHuffman(valBytes) : new TextDecoder().decode(valBytes);
            headers.push({ name, value });
            continue;
        }

        // C. Literal with Literal Name (001xxxxx)
        if ((byte & 0xE0) === 0x20) {
            const nameH = (byte & 0x08) !== 0;
            const nameLenRes = decodeVarInt(buf, 3, pos);
            pos = nameLenRes.next;
            const nameBytes = buf.subarray(pos, pos + nameLenRes.value);
            pos += nameLenRes.value;
            const name = nameH ? decodeHuffman(nameBytes) : new TextDecoder().decode(nameBytes);

            const valH = (buf[pos] & 0x80) !== 0;
            const valLenRes = decodeVarInt(buf, 7, pos);
            pos = valLenRes.next;
            const valBytes = buf.subarray(pos, pos + valLenRes.value);
            pos += valLenRes.value;
            const value = valH ? decodeHuffman(valBytes) : new TextDecoder().decode(valBytes);
            headers.push({ name, value });
            continue;
        }

        throw new Error(`Unknown QPACK instruction at byte ${pos}`);
    }

    return headers;
}
