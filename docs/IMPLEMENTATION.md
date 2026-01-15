# RTCFetcher 実装ガイド

## アーキテクチャ概要

RTCFetcherは、WebRTC DataChannel上でFetch APIを実装したライブラリです。HTTP/2ライクなフロー制御を実装し、効率的なP2P通信を実現します。HTTP/2のストリームとフロー制御の概念を参考に、以下の点を考慮して設計されています：

- HTTP/2のストリームはWebRTC上のSCTPストリーム（DataChannel）に置き換え
- ストリームの管理と多重化処理はSCTPプロトコルに委譲
- 通常のデータ転送にはメッセージフレームを使用せず、SCTPの信頼性のあるストリーム転送を活用
- フロー制御のための制御メッセージは独自に実装

### フロー制御メッセージ

一般的なデータ転送にはメッセージフレームを使用しませんが、フロー制御のために以下の制御メッセージを実装します：

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

制御メッセージはシグナリングチャネル（ID: 255）を通じて送信され、各DataChannelのフロー制御を管理します。

### データチャネル管理

#### シグナリング用チャネル
- ID: 255
- negotiated: true
- 用途：
  - DataChannelのIDネゴシエーション
  - フロー制御メッセージの交換
  - ストリームの確立と管理

#### データチャネルの作成
- negotiated: trueで作成
- IDの割り当て：
  - WebRTCのSTATS APIを使用して未使用IDを特定
  - シグナリングチャネルを通じてIDをネゴシエーション
- 1つのリクエストに対して1つのDataChannelを作成

### ストリーム処理

#### フロー制御
- 各DataChannelに対して独立したフロー制御を実装
- デフォルトウィンドウサイズ: 64 KiB
- ウィンドウサイズの更新はFlowControlMessageを通じて通知
- バッファプレッシャーの監視と制御

#### データの分割と転送
- チャンクサイズ: 16 KiB (DataChannelの最大メッセージサイズ制限)
- データは16 KiBのチャンクに分割して送信
- 分割されたチャンクはReadableStreamを通じてユーザーに提供
- フロー制御に基づいて送信レートを調整

#### ストリームのライフサイクル
- 開始：DataChannelの確立
- 終了：DataChannelのclose()に連動
- エラー処理：SCTPレベルのエラーを適切にアプリケーションレベルに伝播

### シリアライズ処理

#### MessagePack統合
- msgpackを使用したデータのシリアライズ/デシリアライズ
- ReadableStreamとDataChannelの対応付けをパース時に実行
- 必要に応じて新しいDataChannelを動的に作成
- フロー制御メッセージもMessagePackでシリアライズ
- 分割されたチャンクのストリーミングをReadableStreamで提供

#### ストリーム対応付け
- リクエスト送信時にDataChannel IDとReadableStreamの対応表を送信
- 受信側での正確なストリーム対応付けを保証
- 対応表の管理と更新

## プロジェクト構造

```
src/
├── rtcfetcher.ts              # メインのRTCFetcherクラス
├── types/
│   ├── message.ts              # フロー制御メッセージの型定義
│   └── stream.ts              # ストリーム関連の型定義
├── errors/
│   └── rtc-fetcher-error.ts    # エラー型定義
├── utils/
│   └── msgpack-codec.ts        # MessagePackエンコーダー/デコーダー
├── negotiation/
│   ├── id-negotiator.ts        # DataChannel ID ネゴシエーター
│   └── messages.ts            # ネゴシエーション用メッセージ定義
└── streams/
    ├── send-stream.ts          # 送信ストリーム
    └── read-stream.ts          # 受信ストリーム
```

## コンポーネント実装

#### ID ネゴシエーション

```typescript
// negotiation/messages.ts
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

// negotiation/id-negotiator.ts
class Negotiator {
    private static readonly SIGNALING_CHANNEL_ID = 255;
    private static readonly MAX_CHANNEL_ID = 254;
    private usedIds: Set<number>;
    private pendingRequests: Map<number, (id: number) => void>;
    private requestHandlers: Map<string, (data: any) => Promise<any>>;

    constructor(private signalingChannel: RTCDataChannel) {
        this.usedIds = new Set([SIGNALING_CHANNEL_ID]);
        this.pendingRequests = new Map();
        this.requestHandlers = new Map();
        this.setupSignalingChannel();
    }

    /**
     * リクエストハンドラの登録
     */
    registerRequestHandler(endpoint: string, handler: (data: any) => Promise<any>): void {
        this.requestHandlers.set(endpoint, handler);
    }

    /**
     * リクエストの処理
     */
    private async handleRequest(message: NegotiationMessage): Promise<void> {
        const { endpoint } = message.data;
        const handler = this.requestHandlers.get(endpoint!);

        if (!handler) {
            this.sendNegotiationMessage({
                type: 'request_rejected',
                data: {
                    endpoint,
                    reason: 'Unknown endpoint'
                }
            });
            return;
        }

        try {
            await handler(message.data);
        } catch (error) {
            this.sendNegotiationMessage({
                type: 'request_rejected',
                data: {
                    endpoint,
                    reason: error.message
                }
            });
        }
    }

    /**
     * 新しいDataChannelのIDを要求
     */
    async requestChannelId(): Promise<number> {
        const availableId = this.findAvailableId();
        return new Promise((resolve) => {
            this.pendingRequests.set(availableId, resolve);
            this.sendNegotiationMessage({
                type: 'id_request',
                data: { requestedId: availableId }
            });
        });
    }

    /**
     * IDの要求に応答
     */
    private handleIdRequest(message: NegotiationMessage): void {
        const { requestedId } = message.data;
        if (!this.usedIds.has(requestedId!)) {
            this.usedIds.add(requestedId!);
            this.sendNegotiationMessage({
                type: 'id_response',
                data: { assignedId: requestedId }
            });
        } else {
            // ID競合時は利用可能なID一覧を送信
            this.sendNegotiationMessage({
                type: 'id_conflict',
                data: {
                    availableIds: this.getAvailableIds()
                }
            });
        }
    }

    /**
     * 利用可能なIDを探索
     */
    private findAvailableId(): number {
        for (let id = 0; id < this.MAX_CHANNEL_ID; id++) {
            if (!this.usedIds.has(id)) {
                return id;
            }
        }
        throw new Error('No available DataChannel IDs');
    }

    /**
     * WebRTC statsから使用中のIDを同期
     */
    async syncWithStats(pc: RTCPeerConnection): Promise<void> {
        const stats = await pc.getStats();
        stats.forEach(stat => {
            if (stat.type === 'data-channel') {
                this.usedIds.add(stat.id);
            }
        });
    }

    /**
     * シグナリングチャネルのセットアップ
     */
    private setupSignalingChannel(): void {
        this.signalingChannel.onmessage = (event) => {
            const message = msgpack.decode(event.data) as NegotiationMessage;
            switch (message.type) {
                case 'id_request':
                    this.handleIdRequest(message);
                    break;
                case 'id_response':
                    this.handleIdResponse(message);
                    break;
                case 'id_conflict':
                    this.handleIdConflict(message);
                    break;
                case 'request':
                    await this.handleRequest(message);
                    break;
                case 'request_rejected':
                    this.handleRequestRejected(message);
                    break;
            }
        };
    }

    /**
     * ネゴシエーションメッセージの送信
     */
    private sendNegotiationMessage(message: NegotiationMessage): void {
        this.signalingChannel.send(msgpack.encode(message));
    }
}
```

### フロー制御

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

### DataChannel管理

```typescript
interface DataChannelConfig {
    id: number;
    negotiated: true;
    ordered: boolean;
    maxRetransmits?: number;
}

class DataChannelManager {
    private static readonly SIGNALING_CHANNEL_ID = 255;
    private static readonly MAX_CHUNK_SIZE = 16 * 1024; // 16 KiB

    private signalingChannel: RTCDataChannel;
    private activeChannels: Map<number, RTCDataChannel>;
    private flowControllers: Map<number, FlowController>;

    async createDataChannel(config: DataChannelConfig): Promise<RTCDataChannel>;
    private async findUnusedChannelId(): Promise<number>;
    private setupSignalingChannel(): void;
    private handleFlowControlMessage(msg: FlowControlMessage): void;
}
```

### ストリーム管理

```typescript
interface StreamMapping {
    channelId: number;
    streamId: string;
    direction: 'send' | 'receive';
    flowController: FlowController;
}

class StreamManager {
    private mappings: Map<string, StreamMapping>;
    
    registerStream(channelId: number, stream: ReadableStream): string;
    getChannelForStream(streamId: string): RTCDataChannel | undefined;
    handleFlowControl(channelId: number, message: FlowControlMessage): void;
}
```

## テスト構造

各コンポーネントに対応するテストファイル：

```
src/
└── __tests__/
    ├── msgpack-codec.test.ts
    ├── rtc-fetcher-error.test.ts
    ├── flow-controller.test.ts
    ├── send-stream.test.ts
    └── read-stream.test.ts
```

## 次のステップ

1. RTCFetcherクラスの実装
   - シグナリングチャネルの確立
   - ストリームIDとDataChannelの対応付け
   - フロー制御メッセージの実装
   - MessagePackによるデータシリアライズ

2. ストリーム管理
   - 16 KiBチャンク分割の実装
   - 動的なDataChannel作成
   - フロー制御の統合
   - ストリーム対応表の管理

3. エラー処理とリカバリー
   - SCTPレベルのエラーハンドリング
   - ストリーム再接続
   - フロー制御の回復処理
   - タイムアウト処理

4. パフォーマンス最適化
   - フロー制御パラメータの調整
   - メモリ使用量の最適化
   - 並行ストリーム数の調整
   - ReadableStreamの効率的な利用