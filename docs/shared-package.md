# 共有パッケージの構成

## 概要

プロジェクト全体で共有可能な型定義とユーティリティ関数を `packages/shared` パッケージに抽出しました。これにより、コードの重複を削減し、保守性を向上させます。

## パッケージ構造

```
packages/shared/
├── package.json          # パッケージ定義
├── tsconfig.json         # TypeScript設定
├── README.md            # パッケージドキュメント
├── types.ts             # 共通型定義
├── utils.ts             # ブラウザ互換ユーティリティ
└── utils-node.ts        # Node.js専用ユーティリティ
```

## 主要ファイル

### types.ts (130行)

プロジェクト全体で使用される型定義:

- **ドメイン型**
  - `Workspace` - ワークスペース定義
  - `Deck` - デッキ(ワークスペースビュー)定義
  - `FileSystemEntry` - ファイルシステムエントリ
  - `FileTreeNode` - ファイルツリーノード(UI状態付き)
  - `EditorFile` - エディタファイル
  - `TerminalSession` - ターミナルセッション

- **UI状態型**
  - `WorkspaceState` - ワークスペースUI状態
  - `DeckState` - デッキUI状態

- **API型**
  - `ApiError`, `ApiConfig`, `ApiFileResponse` など
  - リクエスト型: `CreateWorkspaceRequest`, `CreateDeckRequest` など

### utils.ts (196行)

ブラウザとNode.js両方で使用可能なユーティリティ関数:

- **パス操作**
  - `getWorkspaceKey()` - ワークスペースキー生成(プラットフォーム対応)
  - `getWorkspaceName()` - ワークスペース名抽出
  - `normalizePathSeparators()` - パス区切り文字正規化

- **ファイル操作**
  - `getFileExtension()` - 拡張子取得
  - `getLanguageFromPath()` - Monaco言語マッピング
  - `sortFileEntries()` - ファイルエントリソート
  - `isHidden()` - 隠しファイル判定

- **エラー処理**
  - `getErrorMessage()` - エラーメッセージ抽出
  - `createHttpError()` - HTTPエラー生成

- **文字列操作**
  - `truncate()` - 文字列切り詰め
  - `shortId()` - 短縮ID生成
  - `formatFileSize()` - ファイルサイズフォーマット

### utils-node.ts (50行)

Node.js専用ユーティリティ:

- `normalizeWorkspacePath()` - 絶対パス正規化(Node.js path使用)
- `getWorkspaceKey()` - Node.js版ワークスペースキー
- `getWorkspaceName()` - Node.js版ワークスペース名
- ブラウザ互換ユーティリティの再エクスポート

## 使用方法

### Webアプリケーション (apps/web)

```typescript
// 型のインポート
import type { Workspace, Deck, FileTreeNode } from '@deck-ide/shared/types';

// ブラウザ互換ユーティリティのインポート
import { getLanguageFromPath, sortFileEntries } from '@deck-ide/shared/utils';
```

### サーバー (apps/server)

```typescript
// 型のインポート
import type { Workspace, Deck } from '@deck-ide/shared/types';

// Node.js専用ユーティリティのインポート
import {
  normalizeWorkspacePath,
  getWorkspaceKey,
  sortFileEntries
} from '@deck-ide/shared/utils-node';
```

## 既存コードの更新

### apps/web/src/types.ts

重複型定義を削除し、共有パッケージから再エクスポート:

```typescript
export type {
  FileEntryType,
  Workspace,
  Deck,
  // ... その他の型
} from '@deck-ide/shared/types';
```

**削減**: 56行 → 24行 (32行削減)

### apps/server/src/types.ts

重複型定義を削除:

```typescript
export type { Workspace, Deck } from '@deck-ide/shared/types';
```

**削減**: 29行 → 16行 (13行削減)

### apps/web/src/utils/

既存のユーティリティファイルを共有パッケージ使用に更新:

- `errorUtils.ts` - 共有パッケージから再エクスポート
- `fileUtils.ts` - `getLanguageFromPath`を共有版に委譲

### apps/server/src/utils/

既存のユーティリティファイルを共有パッケージ使用に更新:

- `error.ts` - 共有関数を使用
- `path.ts` - 共有関数を使用
- `files.ts` - `sortFileEntries`を共有版に統合

## 利点

1. **重複コード削減**
   - 型定義の一元管理
   - ユーティリティ関数の共有

2. **保守性向上**
   - 型変更が一箇所で完結
   - バグ修正が全体に反映

3. **一貫性向上**
   - 同じロジックを複数箇所で実装しない
   - API型定義の統一

4. **ブラウザ/Node.js対応**
   - `utils.ts` - ブラウザ互換
   - `utils-node.ts` - Node.js専用
   - プラットフォームに応じた使い分け

## ビルド確認

### Webアプリケーション
```bash
cd apps/web && npm run build
# ✓ built in 1.05s (警告なし)
```

### サーバー
```bash
cd apps/server && npm run build
# ✓ ビルド成功
```

## 今後の拡張

必要に応じて以下を追加可能:

1. **バリデーション関数**
   - 入力検証ロジック
   - 型ガード関数

2. **定数定義**
   - 共通定数の共有
   - マジックナンバー排除

3. **テストユーティリティ**
   - モックデータ生成
   - テストヘルパー関数

4. **API クライアント型**
   - API レスポンス型の拡充
   - リクエストビルダー
