import { StreamRef } from '../types/stream-ref';

const THRESHOLD = 16 * 1024; // 16KB

type StreamReplacer = (stream: ReadableStream) => Promise<StreamRef>;

export async function traverseAndOptimizeStreams(obj: any, replacer: StreamReplacer): Promise<any> {
    if (obj instanceof ReadableStream) {
        return replacer(obj);
    }

    // Convert large Blob/File to stream
    if (typeof Blob !== 'undefined' && obj instanceof Blob) {
        if (obj.size > THRESHOLD) {
            return replacer(obj.stream());
        }
        return obj;
    }

    // Convert large Uint8Array/ArrayBuffer to stream
    if (obj instanceof Uint8Array) {
        if (obj.byteLength > THRESHOLD) {
            return replacer(uint8ArrayToStream(obj));
        }
        return obj;
    }
    if (obj instanceof ArrayBuffer) {
        if (obj.byteLength > THRESHOLD) {
            return replacer(uint8ArrayToStream(new Uint8Array(obj)));
        }
        return obj;
    }

    // Convert large String to stream
    if (typeof obj === 'string') {
        // Rough estimate of byte size (assuming UTF-8, worse case 3 bytes per char for common non-ascii, but length is good proxy for huge strings)
        if (obj.length > THRESHOLD) {
            return replacer(stringToStream(obj));
        }
        return obj;
    }

    if (Array.isArray(obj)) {
        return Promise.all(obj.map(item => traverseAndOptimizeStreams(item, replacer)));
    }

    if (obj && typeof obj === 'object') {
        const newObj: any = {};
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                newObj[key] = await traverseAndOptimizeStreams(obj[key], replacer);
            }
        }
        return newObj;
    }

    return obj;
}

function uint8ArrayToStream(data: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            // Split into chunks if needed? 
            // SendStream handles chunking, so we can enqueue the whole thing or chunks.
            // But to be "streaming", we should probably chunk it if we were generating it.
            // Since it's already in memory, enqueuing it all at once is fine, 
            // the pipeTo logic downstream will handle backpressure on the chunks it writes to transport.

            // However, to mimic streaming behavior more closely effectively, let's chunk it
            const chunkSize = 16 * 1024;
            for (let i = 0; i < data.byteLength; i += chunkSize) {
                controller.enqueue(data.subarray(i, i + chunkSize));
            }
            controller.close();
        }
    });
}

function stringToStream(str: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    // If encoding makes it huge, we already have it in memory anyway.
    return uint8ArrayToStream(data);
}
