
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
    const ops: { type: 'indexed' | 'literal_nameref' | 'literal', index?: number, name?: string, value?: string, static?: boolean }[] = [];

    // Pass 1: Determine Insertions and Indices
    let maxDynamicIndexUsed = -1; // -1 means none

    for (const h of headers) {
        const nameLc = h.name.toLowerCase();
        const valueStr = String(h.value);

        // 1. Static Table Search
        let bestStaticIndex = -1;
        let bestStaticNameMatch = -1;

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

        // 2. Dynamic Table Search
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
        if (bestStaticIndex !== -1) {
            ops.push({ type: 'indexed', index: bestStaticIndex, static: true });
            continue;
        }

        if (bestDynamicIndex !== -1) {
            if (bestDynamicIndex > maxDynamicIndexUsed) maxDynamicIndexUsed = bestDynamicIndex;
            ops.push({ type: 'indexed', index: bestDynamicIndex, static: false });
            continue;
        }

        const isStreamRef = valueStr.startsWith("::streamref::");
        if (context && !isStreamRef) {
            // Insert
            const absIndex = context.insertToDynamicTable(nameLc, valueStr);
            if (absIndex > maxDynamicIndexUsed) maxDynamicIndexUsed = absIndex;
            ops.push({ type: 'indexed', index: absIndex, static: false });
            continue;
        }

        // Fallback: Literal
        if (bestStaticNameMatch !== -1) {
            ops.push({ type: 'literal_nameref', index: bestStaticNameMatch, static: true, value: valueStr });
        } else if (bestDynamicNameMatch !== -1) {
            if (bestDynamicNameMatch > maxDynamicIndexUsed) maxDynamicIndexUsed = bestDynamicNameMatch;
            ops.push({ type: 'literal_nameref', index: bestDynamicNameMatch, static: false, value: valueStr });
        } else {
            ops.push({ type: 'literal', name: nameLc, value: valueStr });
        }
    }

    // Pass 2: Encode Logic
    const requiredInsertCount = (maxDynamicIndexUsed === -1) ? 0 : (maxDynamicIndexUsed + 1);
    const baseIndex = requiredInsertCount; // Base = RIC (S=0, Delta=0)

    // Prefix
    const ricEnc = encodeInt(requiredInsertCount, 8);
    out.push(...ricEnc);
    const dbEnc = encodeInt(0, 7); // Delta Base 0, Sign +
    out.push(0x00 | dbEnc[0], ...dbEnc.slice(1));

    // Field Lines
    for (const op of ops) {
        if (op.type === 'indexed') {
            if (op.static) {
                // 1Txxxxxx, T=1
                const enc = encodeInt(op.index!, 6);
                out.push(0x80 | 0x40 | enc[0], ...enc.slice(1));
            } else {
                // 1Txxxxxx, T=0
                // Relative = Base - 1 - Abs
                const relativeIndex = baseIndex - 1 - op.index!;
                const enc = encodeInt(relativeIndex, 6);
                out.push(0x80 | 0x00 | enc[0], ...enc.slice(1));
            }
        } else if (op.type === 'literal_nameref') {
            if (op.static) {
                // 01N0xxxx, N=1
                const enc = encodeInt(op.index!, 4);
                out.push(0x40 | 0x10 | enc[0], ...enc.slice(1));
            } else {
                // 01N0xxxx, N=0
                const relativeIndex = baseIndex - 1 - op.index!;
                const enc = encodeInt(relativeIndex, 4);
                out.push(0x40 | 0x00 | enc[0], ...enc.slice(1));
            }
            const valBytes = new TextEncoder().encode(op.value!);
            const valLen = encodeInt(valBytes.length, 7);
            out.push(...valLen, ...valBytes);
        } else {
            // Literal
            // 0010xxxx
            const nameBytes = new TextEncoder().encode(op.name!);
            const nameLen = encodeInt(nameBytes.length, 3);
            out.push(0x20 | nameLen[0], ...nameLen.slice(1), ...nameBytes);

            const valBytes = new TextEncoder().encode(op.value!);
            const valLen = encodeInt(valBytes.length, 7);
            out.push(...valLen, ...valBytes);
        }
    }

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
                // console.log(`[decodeQpack] Indexed Dynamic: ${entry.name} = ${entry.value}`);
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
