# RTCFetcher

Fetch API on RTCPeerConnection

## Concept
WebRTCのDatachannel上で構築されたFetch APIです。
このライブラリは主にP2Pアプリケーションに使用されます。

### 特徴 (Features)
- **モダンなAPI**: 標準のFetch APIライクなインターフェースを提供。
- **ストリーミング**: Fetch Upload Streaming機能により、Backpressureに対応したストリーミングが可能。
- **共存性**: 既存の `RTCPeerConnection` の上に構築されるため、シグナリングロジックの変更が不要。既存のDataChannelやMediaStreamと共存可能。
- **IDネゴシエーション**: `getStats` を利用した衝突回避ロジックにより、`negotiated: true` なDataChannelを安全に動的生成。
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

## Architecture

### ID Negotiation via WebRTC Stats
`negotiated: true` (ondatachannelを発火させない) を維持しつつ、ID衝突を避けるために以下のロジックを採用しています。

1. **Master Channel**: ID `255` を制御用のMaster Channelとして常時使用。
2. **Dynamic ID Reservation**:
   - 新しい通信を開始する際、`pc.getStats()` を実行して現在使用中のDataChannel IDを確認。
   - 未使用のIDを検索し、Master Channel経由で相手に「予約(RESERVE)」を要求。
   - 相手も `getStats()` で競合がないか確認し、「承認(ACK)」を返信。
   - 双方で合意したIDを使って `createDataChannel` を実行。

これにより、RTCFetcher管理外で作成されたDataChannelとのID競合を確実に防ぎます。

### Backpressure Control
WebRTC (SCTP) 標準のフロー制御に合わせて、効率的なBackpressureを実現しています。

- **送信側**: `RTCDataChannel.bufferedAmount` を監視。
- **制御**: バッファ量が閾値 (`minBufferSize`) を超えた場合、送信ストリームの読み込み(`pull`)を一時停止します。`bufferedamountlow` イベント発火時に再開することで、ネットワーク帯域に応じた適切な転送速度を維持します。
