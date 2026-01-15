# RTCFetcher 開発ガイドライン

## 開発環境のセットアップ

### 必要要件
- Node.js >= 14.0.0
- npm >= 7.0.0

### 環境構築
```bash
# リポジトリのクローン
git clone https://github.com/yourusername/rtcfetcher.git
cd rtcfetcher

# 依存関係のインストール
npm install

# 開発サーバーの起動
npm run dev
```

## 開発プロセス

### ブランチ戦略
- `main`: リリースブランチ
- `develop`: 開発ブランチ
- `feature/*`: 機能追加
- `bugfix/*`: バグ修正
- `refactor/*`: リファクタリング

### コミットメッセージ規約
```
type(scope): 変更内容の要約

変更内容の詳細な説明
```

#### タイプ
- `feat`: 新機能
- `fix`: バグ修正
- `docs`: ドキュメントのみの変更
- `style`: コードの意味に影響しない変更（空白、フォーマット等）
- `refactor`: バグ修正や機能追加を含まないコードの変更
- `test`: テストの追加・修正
- `chore`: ビルドプロセスやドキュメント生成の変更

### コード規約

#### TypeScript
- インデント: 2スペース
- セミコロン: 必須
- クォート: シングルクォート
- 型定義: 明示的な型付けを推奨

```typescript
// Good
interface Config {
  windowSize: number;
  timeout: number;
}

// Bad
interface Config {
    windowSize: any;
    timeout: any;
}
```

#### テスト
- ユニットテストは必須
- テストカバレッジ80%以上を維持
- テストケースは機能単位でグループ化

```typescript
describe('FlowController', () => {
  describe('windowSize', () => {
    it('should not exceed maximum', () => {
      // テストケース
    });
  });
});
```

## ビルドとテスト

### スクリプト
```bash
# 型チェック
npm run type-check

# リント
npm run lint

# テスト実行
npm run test

# テスト（ウォッチモード）
npm run test:watch

# ビルド
npm run build
```

### CI/CD
プルリクエスト時に以下が自動実行されます：
1. 型チェック
2. リント
3. テスト
4. ビルド

## リリースプロセス

### バージョニング
[セマンティックバージョニング](https://semver.org/lang/ja/)に従います：
- MAJOR: 互換性を破壊する変更
- MINOR: 後方互換性のある機能追加
- PATCH: 後方互換性のあるバグ修正

### リリース手順
1. バージョン番号の更新
   ```bash
   npm version <major|minor|patch>
   ```
2. CHANGELOGの更新
3. ドキュメントの更新確認
4. mainブランチへのマージ
5. タグの作成
6. npm公開
   ```bash
   npm publish
   ```

## デバッグ

### ログ出力
開発時は`DEBUG`環境変数でログレベルを制御できます：
```bash
DEBUG=rtcfetcher:* npm run dev
```

### デバッグツール
- Chrome DevTools
- WebRTC Internals (`chrome://webrtc-internals/`)

## パフォーマンス

### 測定指標
- メモリ使用量
- CPU使用率
- レイテンシ
- スループット

### プロファイリング
```bash
# メモリプロファイリング
node --prof app.js

# プロファイルデータの解析
node --prof-process isolate-*.log > profile.txt
```

## セキュリティ

### レビュー項目
- 入力値の検証
- バッファオーバーフロー対策
- メモリリーク対策
- エラーハンドリング

### 脆弱性報告
セキュリティの脆弱性を発見した場合は、Issue作成前に以下のアドレスに報告してください：
security@example.com

## ヘルプとサポート
- Issue作成前に既存のIssueを確認
- 再現手順を明確に記載
- 必要に応じてログやスクリーンショットを添付