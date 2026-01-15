# RTCFetcher アーキテクチャ設計書

## パート1: RTCFetcherコア設計

### 1. 概要
RTCFetcherは、WebRTC DataChannel上でFetch APIを実装したライブラリです。HTTP/2ライクなフロー制御を実装し、効率的なP2P通信を実現します。

### 2. 技術スタック
- TypeScript
- WebRTC DataChannel
- MessagePack (データシリアライズ)
- Web Streams API

### 3. メッセージングプロトコル

#### ネゴシエーションメッセージ
```typescript
interface NegotiationMessage {
    type: 'id_request' | 'id_response' | 'id_conflict' | 'request' | 'request_rejected';
    data: {
        requestedId?: number;    // 要求するID
        assignedId?: number;     // 割り当てられたID
        availableIds?: number[]; // 利用可能なID一覧
        endpoint?: string;       // リクエストのエンドポイント
        reason?: string;        // リジェクトの理由
    };
}
```

### 3.5 IncomingRequest
IncomingRequestは、相手から送られてきた保留中のリクエストを表現するクラスです。

```typescript
interface IncomingRequest {
    // フィールド
    endpoint: string;  // リクエスト先のエンドポイント

    // メソッド
    open(): Promise<{
        req: object;  // 相手から送られてきたmsgpackエンコード済みのオブジェクト
        res: { send: (data: any) => void }  // レスポンス送信用オブジェクト
    }>;
    
    reject(reason?: string): void;  // リクエストの却下（オプションでエラーメッセージを送信可能）
}
```

リクエストの処理フロー：
1. リクエストを受信するとIncomingRequestインスタンスが生成される
2. `open()`を呼び出すとリクエストが承認され、リクエストデータとレスポンス送信用オブジェクトが返される
3. `reject()`を呼び出すとリクエストが却下され、オプションでエラーメッセージを相手に送信できる


### 4. IDネゴシエーション

#### 4.1 シグナリング用チャネル
- ID: 255
- negotiated: true
- 用途：
  - DataChannelのIDネゴシエーション
  - フロー制御メッセージの交換
  - ストリームの確立と管理

#### 4.2 ネゴシエーションフロー
1. シグナリングチャネル（ID: 255）を通じてIDのネゴシエーション開始
2. 利用可能なIDを要求
3. ID競合時は利用可能なID一覧を交換
4. IDの割り当てを確認
5. DataChannelの確立

### 5. エラーハンドリング

#### 5.1 エラーの種類
- DataChannel確立エラー
- IDネゴシエーションエラー
- シリアライズ/デシリアライズエラー
- フロー制御エラー
- タイムアウト

#### 5.2 エラー処理方針
- エラーは適切な型とメッセージで伝播
- 非同期処理のエラーはPromise.reject
- エラー発生時のリソース解放を保証
- SCTPレベルのエラーをアプリケーションレベルに適切に伝播

### 6. MessagePack統合

#### 6.1 シリアライゼーション
- フロー制御メッセージのシリアライズ/デシリアライズ
- ReadableStreamとDataChannelの対応付け
- 動的なDataChannel作成のサポート

#### 6.2 データマッピング
- リクエスト送信時のストリーム対応表の管理
- 受信側での正確なストリーム対応付けの保証
- バイナリデータの効率的な処理

#### 6.3 拡張型
MessagePack ExtensionTypeを使用して、以下の型をシリアライズ可能にします：

- Headers (Fetch API)
  - 拡張型ID: 0x01
  - シリアライズ形式: [['key1', 'value1'], ['key2', 'value2'], ...]として配列化
  - デシリアライズ時にHeadersインスタンスとして復元

- ReadableStream
  - 拡張型ID: 0x02
  - シリアライズ処理:
    1. シリアライズ時にDataChannelをシグナリング用チャネルを通じて作成
    2. 作成したDataChannelをsend-streamとして初期化
    3. 作成したsend-streamとReadableStreamの対応付けを行う
  - デシリアライズ処理:
    1. 対応するDataChannelをread-streamとして初期化
    2. 初期化したread-streamをReadableStreamとして復元

### 7. プロジェクト構造
```
src/
├── rtcfetcher/              # RTCFetcherの直接の仕様とMessagePack関連
│   ├── core/
│   │   ├── rtcfetcher.ts    # メインのRTCFetcherクラス
│   │   └── negotiation.ts   # IDネゴシエーション処理
│   ├── types/
│   │   ├── message.ts       # メッセージの型定義
│   │   └── stream.ts        # 基本的なストリーム関連の型定義
│   ├── errors/
│   │   └── rtc-fetcher-error.ts  # エラー型定義
│   └── utils/
│       └── msgpack-codec.ts  # MessagePackエンコーダー/デコーダー
│
└── datachannelstream/       # DataChannelのStream化とフロー制御
    ├── core/
    │   ├── flow-controller.ts    # フロー制御の実装
    │   └── stream-manager.ts     # ストリーム管理
    ├── streams/
    │   ├── base.ts              # 基底ストリームクラス
    │   ├── send-stream.ts       # 送信ストリーム
    │   └── read-stream.ts       # 受信ストリーム
    └── utils/
        └── frame-codec.ts       # フレームエンコーディング
```

### 8. テスト構造

#### 8.1 テストファイル構成
```
src/
├── rtcfetcher/
│   └── __tests__/
│       ├── msgpack-codec.test.ts
│       ├── rtc-fetcher-error.test.ts
│       └── negotiation.test.ts
│
└── datachannelstream/
    └── __tests__/
        ├── flow-controller.test.ts
        ├── send-stream.test.ts
        └── read-stream.test.ts
```

## パート2: ストリーム処理とフロー制御

### 1. DataChannelのストリーム化

#### 1.1 ストリーム処理方式
send-streamとread-streamは、既存のDataChannelをラップする形で実装され、以下の2つの処理方法を提供:

1. ストリーム処理
   - ユーザーが直接利用する主要な処理方式
   - データの連続的な送受信に使用
   - Web Streams APIと統合
   - 大容量データの効率的な転送をサポート

2. メッセージ処理
   - 内部実装で使用される処理方式
   - フロー制御やストリーム管理などの内部制御に使用
   - ユーザーは直接使用しない
   - システムの信頼性と効率性を確保

### 2. フロー制御システム

#### 2.1 フロー制御メッセージ
```typescript
interface FlowControlMessage {
    type: 'window_update' | 'flow_status';
    channelId: number;
    data: {
        windowSize?: number;  // window_updateの場合
        available?: boolean;  // flow_statusの場合
    };
}
```

#### 2.2 設計パラメータ
- デフォルトウィンドウサイズ: 64 KiB
- チャンクサイズ: 16 KiB
- 各DataChannelに対して独立したフロー制御を実装

#### 2.3 フロー制御インターフェース
```typescript
interface FlowController {
    private windowSize: number;
    private available: boolean;

    // ウィンドウサイズの更新
    updateWindow(size: number): void;
    
    // 送信可能状態の確認
    canSend(): boolean;
    
    // フロー状態の更新
    updateFlowStatus(available: boolean): void;
    
    // 制御メッセージの送信
    sendWindowUpdate(size: number): void;
    sendFlowStatus(available: boolean): void;
}
```

### 3. データチャネルの設定
```typescript
interface DataChannelConfig {
    id: number;
    negotiated: true;
    ordered: boolean;
    maxRetransmits?: number;
}
```

### 4. データ転送フロー

#### 4.1 データ転送処理
1. 送信側がフロー制御ウィンドウを確認
2. データを16 KiBチャンクに分割
3. 分割されたチャンクをReadableStreamを通じて転送
4. フロー制御メッセージで転送速度を調整
5. ユーザー側でReadableStreamを使用してデータを処理

### 5. パフォーマンス最適化

#### 5.1 データ転送
- 16 KiBチャンクサイズでの転送（DataChannelの制限に準拠）
- フロー制御の最適化
- 送信レートの動的調整
- ReadableStreamの効率的な利用

#### 5.2 メモリ管理
- ストリーム対応表の効率的な管理
- リソースの適切な解放
- メモリ使用量の監視

## パート3: Fetchメソッドの実装詳細

### 1. Fetchメソッドの基本設計

#### 1.1 シグネチャ
```typescript
interface Fetcher {
    Fetch(label: string, data: any): Promise<void>;
}
```

#### 1.2 パラメータ
- `label`: string型
  - リクエストの識別子として使用
  - エンドポイントの指定に相当
- `data`: any型
  - 任意のJavaScriptオブジェクト
  - オブジェクトの各フィールドは再帰的に処理

### 2. オブジェクトサイズの検出と処理

#### 2.1 サイズ検出メカニズム
```typescript
interface SizeDetector {
    // オブジェクトの各フィールドのサイズを再帰的に計算
    calculateFieldSizes(data: any): Map<string, number>;
    
    // 特定のフィールドがストリーミング閾値を超えているか判定
    shouldStreamField(size: number): boolean;
}
```

#### 2.2 ストリーミング閾値
- 基準値: 16 KB (16384 bytes)
- 閾値を超えるフィールドは自動的にストリーミング処理に移行
- バイナリデータは効率的なストリーミング処理のために優先的に評価

### 3. ストリーミング転送処理

#### 3.1 ReadableStreamへの変換
```typescript
interface StreamConverter {
    // 大きなフィールドをReadableStreamに変換
    convertToStream(data: any, fieldPath: string): ReadableStream;
    
    // 元のデータ構造を維持しながらストリームを置換
    replaceWithStream(data: any, streamMap: Map<string, ReadableStream>): any;
}
```

#### 3.2 ストリーミング処理フロー
1. オブジェクトのサイズ検出
2. 16KB以上のフィールドを特定
3. 該当フィールドをReadableStreamに変換
4. 元のデータ構造内のフィールドを変換したストリームで置換
5. ストリーミング転送の開始

### 4. Fetch Uploading Streamingサポート

#### 4.1 ストリーム検出と処理
```typescript
interface StreamProcessor {
    // データ内のReadableStreamを検出
    detectStreams(data: any): Map<string, ReadableStream>;
    
    // 検出されたストリームの処理を開始
    processStreams(streams: Map<string, ReadableStream>): void;
}
```

#### 4.2 アップロードストリーミングフロー
1. 入力データ内のReadableStreamを検出
2. 各ストリームに対して:
   - 新しいDataChannelを作成
   - フロー制御を初期化
   - ストリーミング転送を開始
3. メインのデータ転送と並行してストリーム処理を実行

#### 4.3 エラーハンドリング
- ストリーム処理中のエラーは適切に伝播
- 部分的な失敗時のリカバリ処理をサポート
- 全てのストリームが終了するまでFetchは完了しない

### 5. 実装例

```typescript
async function processFetchRequest(label: string, data: any): Promise<void> {
    // サイズ検出
    const detector = new SizeDetector();
    const fieldSizes = detector.calculateFieldSizes(data);
    
    // ストリーム変換
    const streamConverter = new StreamConverter();
    const streamMap = new Map<string, ReadableStream>();
    
    for (const [field, size] of fieldSizes) {
        if (detector.shouldStreamField(size)) {
            const stream = streamConverter.convertToStream(data, field);
            streamMap.set(field, stream);
        }
    }
    
    // 既存のストリームを検出
    const streamProcessor = new StreamProcessor();
    const existingStreams = streamProcessor.detectStreams(data);
    
    // データの変換と送信
    const processedData = streamConverter.replaceWithStream(data, streamMap);
    
    // MessagePackでのシリアライズ
    const serializedData = await msgpack.encode(processedData, {
        extensionCodec: streamExtensionCodec
    });
    
    // 全てのストリームの処理を開始
    await Promise.all([
        streamProcessor.processStreams(streamMap),
        streamProcessor.processStreams(existingStreams)
    ]);
    
    return serializedData;
}