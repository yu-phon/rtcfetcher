import * as WebStreams from 'web-streams-polyfill';
import { TextEncoder, TextDecoder } from 'util';

// タイムアウト設定
jest.setTimeout(10000);

// グローバルスコープにWebStreams APIとテキストエンコーディングAPIを追加
Object.assign(global, {
    TextEncoder,
    TextDecoder,
    TransformStream: WebStreams.TransformStream,
    ReadableStream: WebStreams.ReadableStream,
    WritableStream: WebStreams.WritableStream,
    CountQueuingStrategy: WebStreams.CountQueuingStrategy,
    ByteLengthQueuingStrategy: WebStreams.ByteLengthQueuingStrategy,
    setImmediate: (fn: Function) => setTimeout(fn, 0)
});