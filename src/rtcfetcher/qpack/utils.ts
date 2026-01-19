
// Variable Integer utilities for QPACK/QUIC

// Writes a number as a VarInt into a Uint8Array
export function writeVarInt(value: number): Uint8Array {
    if (value < 64) {
        return new Uint8Array([value]);
    } else if (value < 16384) {
        const buffer = new Uint8Array(2);
        buffer[0] = (value >> 8) | 0x40;
        buffer[1] = value & 0xff;
        return buffer;
    } else if (value < 1073741824) {
        const buffer = new Uint8Array(4);
        buffer[0] = (value >> 24) | 0x80;
        buffer[1] = (value >> 16) & 0xff;
        buffer[2] = (value >> 8) & 0xff;
        buffer[3] = value & 0xff;
        return buffer;
    } else {
        const buffer = new Uint8Array(8);
        buffer[0] = 0xc0; // Or logic for 8-byte
        const bufView = new DataView(buffer.buffer);
        // Note: Javascript bitwise ops are 32-bit. For >32bit, need BigInt or split.
        // Assuming values fit in safe integer range for now, but 8-byte encoding is needed.
        // Simplified for our use case (likely small pointers/IDs).
        // If needed, implement BigInt support.
        bufView.setUint32(4, value % 4294967296);
        bufView.setUint32(0, 0xc0 | Math.floor(value / 4294967296));
        return buffer;
    }
}

// Reads a VarInt from a buffer at a specific offset
export function readVarInt(buf: Uint8Array, offset: number): { value: number; byteLength: number; next: number } | null {
    if (offset >= buf.length) return null;
    const first = buf[offset];
    const prefix = first >> 6;
    const length = 1 << prefix;

    if (offset + length > buf.length) return null;

    let value = 0;
    if (prefix === 0) {
        value = first & 0x3f;
    } else if (prefix === 1) {
        value = ((first & 0x3f) << 8) | buf[offset + 1];
    } else if (prefix === 2) {
        value = ((first & 0x3f) << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
    } else {
        // 62-bit integer
        const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
        const hi = view.getUint32(0) & 0x3fffffff;
        const lo = view.getUint32(4);
        value = (hi * 4294967296) + lo; // Potential precision loss if > MAX_SAFE_INTEGER
    }

    return { value, byteLength: length, next: offset + length };
}

export function encodeInt(value: number, prefixBits: number): number[] {
    const max = (1 << prefixBits) - 1;
    if (value < max) return [value];
    const bytes = [max];
    value -= max;
    while (value >= 128) {
        bytes.push((value & 0x7F) | 0x80);
        value >>= 7;
    }
    bytes.push(value);
    return bytes;
}

export function decodeVarInt(buf: Uint8Array, prefixBits: number, pos: number): { value: number; next: number } {
    const maxPrefix = (1 << prefixBits) - 1;
    let byte = buf[pos];
    let value = byte & maxPrefix;
    pos++;

    if (value < maxPrefix) {
        return { value, next: pos };
    }

    let m = 0;
    while (true) {
        if (pos >= buf.length) throw new Error("Incomplete integer encoding");
        byte = buf[pos++];
        value += (byte & 0x7f) << m;
        if ((byte & 0x80) === 0) break;
        m += 7;
    }
    return { value, next: pos };
}

export function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    let totalLength = 0;
    for (const arr of arrays) {
        totalLength += arr.length;
    }
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}
