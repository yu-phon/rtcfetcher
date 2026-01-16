# RTCFetcher

Fetch API on RTCPeerConnection

## Concept
WebRTCのDatachannel上で構築されたFetch APIです。
このライブラリは主にP2Pアプリケーションに使用されます。

### 特徴 (Features)
- **モダンなAPI**: 標準のFetch APIライクなインターフェースを提供。
- **ストリーミング**: Fetch Upload Streaming機能により、Backpressureに対応したストリーミングが可能。
- **Auto-Streaming**: 16KBを超えるBlob, Uint8Array, Stringは自動的にストリームに変換され、メインチャンネルをブロックしません。
- **共存性**: 既存の `RTCPeerConnection` の上に構築されるため、シグナリングロジックの変更が不要。既存のDataChannelやMediaStreamと共存可能。
- **IDネゴシエーション**: 3-way handshake (`RESERVE` -> `ACK` -> `READY`) とProbingにより、競合と再利用を安全に管理。
- **スキーマレス**: メッセージボディはスキーマレス(`any`)であり、MsgPack拡張により `ReadableStream` や `Blob` も透過的に送信可能。

## Installation

```bash
npm install rtcfetcher
# or
yarn add rtcfetcher
```

## Usage

### Initialize

`RTCFetcher` は `RTCPeerConnection` をラップしますが、接続管理（シグナリング、ICE Candidateの交換など）は既存の `RTCPeerConnection` に委譲します。

```javascript
import { RTCFetcher } from 'rtcfetcher';

// 1. 通常通り RTCPeerConnection を作成・接続
const pc = new RTCPeerConnection(config);
// ... シグナリング処理 ...

// 2. RTCFetcher を初期化
// オプションでタイムアウトやバッファ設定が可能
const fetcher = new RTCFetcher(pc, {
    minBufferSize: 64 * 1024, // Backpressure制御の閾値
});

// 3. 利用開始 (Master Channelの確立を待つ)
await fetcher.opened;
```

### Send Request (Client Side)

`fetch` メソッドでリクエストを送信します。`body` には任意のオブジェクト、Blob、ReadableStreamなどを渡せます。

```javascript
try {
    const data = { message: "Hello", stream: myReadableStream };
    
    // 標準Fetch APIと同様に AbortSignal でタイムアウト制御が可能
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000);

    const res = await fetcher.fetch("my-endpoint", data, {
        signal: controller.signal
    });

    if (res.ok) {
        const result = await res.json();
        console.log("Success:", result);
    }
} catch (err) {
    if (err.name === 'RTCTimeoutError') {
        console.error("Request timed out");
    } else {
        console.error("Fetch failed:", err);
    }
}
```

### Receive Request (Server Side)

受信側では `incomingRequests` ストリームからリクエストを取り出します。

```javascript
const reqs = fetcher.incomingRequests.getReader();

while (true) {
    const { done, value } = await reqs.read();
    if (done) break;

    const { req, res } = value.open();
    
    // req.label で分岐
    if (req.label === "my-endpoint") {
        console.log("Received:", req.body);
        
        // レスポンスを返す
        res.send({ status: "processed", feedback: "ok" });
    } else {
        res.close(); // ハンドルしない場合は閉じる
    }
}
```

## API Reference

### `RTCFetcher`
- `constructor(pc: RTCPeerConnection, config?: RTCFetcherConfig)`
  - `config.minBufferSize`: Backpressure が発動する `bufferedAmount` の下限値。

### `fetch(label: string, body: any, options?: RTCFetchOptions): Promise<RTCResponse>`
- **label**: リクエスト識別子。
- **body**: 送信データ。MsgPackでシリアライズ可能なもの（Object, Array, String, Number, Blob, ArrayBuffer, ReadableStream等）。
  - *注意*: `Function` や循環参照を含むオブジェクトは送信できません。
- **options.signal**: `AbortSignal`。タイムアウトやキャンセルに使用。

## Error Handling

RTCFetcherは以下の専用エラーをスローします。

- **`RTCTimeoutError`**: 指定時間内にレスポンスが返ってこなかった場合。
- **`RTCConnectionError`**: 通信中に `RTCPeerConnection` が切断された場合。
- **`RTCSerializationError`**: データのシリアライズ/デシリアライズに失敗した場合。

## Protocol

### Message Framing
`msgpack-lite` によるシリアライズに加え、**4バイトのLength-Prefix** (Little Endian) を付与することで、ストリーム境界を明確化しています。これにより、「無限読み込み」を防ぎ、確実にメッセージ全体を受信してからデコードを行います。

### Stream Handling & Auto-Streaming
`RTCFetcher` は `ReadableStream` を透過的に転送します。
さらに、v0.5.0以降では **Auto-Streaming** 機能により、以下のデータがペイロード内で検出されると、自動的に別のDataChannelストリームに切り出されます：
- 16KB を超える `String`, `Uint8Array`, `ArrayBuffer`
- `Blob`, `File`

これにより、巨大なデータがメインの制御チャンネルをブロックするのを防ぎます。

## Architecture

### ID Negotiation (3-Way Handshake)
初期の `getStats` チェックに加え、堅牢な **3-way handshake** (`RESERVE` -> `ACK` -> `READY`) を採用しています。

1. **RESERVE**: 送信側が未使用ID候補を提案。
2. **ACK**: 受信側がIDをチェックし、一時的な "Probe Channel" を作成して承諾。
3. **READY**: 送信側がDataChannelを確立し、準備完了を通知。受信側はここで `onReserved` を発火。

このプロセスと "Probe Channel" の待機メカニズムにより、動的なID競合、Race Condition、およびチャンネルの不整合を完全に防ぎます。

### Credit-Based Backpressure
WebRTC標準の `bufferedAmount` 監視に加え、アプリケーションレベルでの **クレジットベース** のフロー制御を実装しています。

- **Window Size**: 送信可能な残りのバイト数。
- **Credit**: 受信側がデータを消費（`read()`）するたびに、送信側へ「クレジット（送信許可量）」を補充します。

これにより、受信側の処理速度に合わせて送信速度を自動調整し、メモリ溢れを防ぎます。また、MTUに合わせて内部でデータを16KBごとのチャンクに分割送信します。
