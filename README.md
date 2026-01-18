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
- **Zero-RTT Handshake**: IDプール機能（`prefetchPoolSize`）により、バックグラウンドでIDを事前交渉。リクエスト開始時のハンドシェイク待ち時間を排除し、即座に送信を開始します。
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
// prefetchPoolSize: バックグラウンドで確保しておくIDの数 (デフォルト: 5)
const fetcher = new RTCFetcher(pc, { prefetchPoolSize: 5 });

// 3. 利用開始 (Master Channelの確立を待つ)
await fetcher.opened;
```

### Send Request (Client Side)

`fetch` メソッドでリクエストを送信します。`body` には任意のオブジェクト、Blob、ReadableStreamなどを渡せます。

```javascript
try {
    const data = { message: "Hello", stream: myReadableStream };
    
    // 標準Fetch APIと同様に AbortSignal でタイムアウト制御が可能
    // v0.6.2+: signal.abort() で即座に通信を切断し、リソースを解放します
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000);

    const res = await fetcher.fetch("my-endpoint", data, {
        signal: controller.signal
    });

    const res = await fetcher.fetch("my-endpoint", data, {
        signal: controller.signal
    });

    if (res.ok) {
        // 1. レスポンス内のストリームへ直感的にアクセス (Proxy)
        // 入れ子になったプロパティでも、StreamRef は自動的に ReadableStream に変換されます
        const stream = res.stream; 
        // const reader = stream.getReader(); ...

        // 2. または、json() で全データを自動受信 (Auto-Buffering)
        // ストリームが含まれていても、全て自動的にバッファリング・展開されます
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
    const { done, value: incoming } = await reqs.read();
    if (done) break;

    // 1. Check Label BEFORE opening (Security)
    if (incoming.label !== "my-endpoint") {
        console.warn("Unknown endpoint:", incoming.label);
        incoming.reject();
        continue;
    }

    // 2. Open to receive body/streams
    const { req, res } = await incoming.open();
    
    console.log("Received:", req.body);
    
    // レスポンスを返す
    res.send({ status: "processed", feedback: "ok" });
}
```

### Header & Body Separation (Two-Stage Await)

`RTCFetcher` は標準Fetch APIと同様に、**ヘッダー（軽量なメタデータ）** と **ボディ（大容量データやストリーム）** の受信を分離できます。
これにより、大容量データの転送を待つことなく `status` や `meta` 情報を即座に確認できます。

**(1) Server Side (Sending)**
ヘッダー情報と、Auto-Streamingの対象となる大容量データ（または `ReadableStream`）を同時に返します。重いデータは自動的に「参照(StreamRef)」に変換されるため、ネットワーク上では軽量なメッセージとして即座に送信されます。

```javascript
// (受信側からのリクエスト処理中...)
res.send({
    // --- Header (即座に届く) ---
    status: 200,
    meta: { type: 'video', length: 1024 * 1024 * 100 },

    // --- Body (参照のみ届く・データは後から) ---
    // 16KBを超えるデータは自動的にストリーム化されます
    body: hugeUint8ArrayData 
});
```

**(2) Client Side (Receiving)**
`fetch` の完了時点ではまだ重いデータの転送は始まっておらず、メインチャンネルの帯域も消費していません。

```javascript
// Step 1: ヘッダー情報の受信 (await fetch)
// 重いデータはまだ転送されません。
const res = await fetcher.fetch("endpoint", { ... });

// ここでステータスチェックなどを即座に行えます
if (res.status !== 200 || res.meta.type !== 'video') {
    throw new Error("Invalid response");
}

// Step 2: ボディの実転送 (await json)
// ここではじめてストリーム接続が確立され、データ転送が開始されます
const data = await res.json(); 
console.log(data.body); // -> 全データ受信完了後に解決
```

## API Reference

### `RTCFetcher`
- `constructor(pc: RTCPeerConnection, config?: RTCFetcherConfig)`
  - `pc`: 既知の `RTCPeerConnection` インスタンス。

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

### Credit-Based Flow Control
`bufferedAmount` に依存した従来の制御に加え、アプリケーションレベルでの **クレジットベース** のフロー制御を導入しました。

- **Window Size**: 送信可能な残りのバイト数。
- **Credit**: 受信側がデータを消費（`read()`）するたびに、送信側へ「クレジット（送信許可量）」を補充します。

これにより、WebRTCのバッファ溢れを防ぎつつ、受信側の処理能力に合わせたスムーズな転送を実現しています。また、MTUに合わせてデータを適切にチャンク分割して送信します。
