# @deck-ide/shared

共有型定義とユーティリティ関数を提供するDeck IDEの共有パッケージです。

## 概要

このパッケージは、Deck IDEモノレポ全体(web, server, desktop)で使用される共通のTypeScript型定義とユーティリティ関数を提供します。

## 構成

### types.ts (130行)

コアドメイン型:
- `Workspace` - プロジェクトワークスペース定義
- `Deck` - ターミナルとエディタを持つワークスペースビュー
- `FileSystemEntry` - ファイルとディレクトリエントリ
- `FileTreeNode` - UI状態を持つ拡張ファイルツリー
- `EditorFile` - エディタファイル表現
- `TerminalSession` - ターミナルセッション
- APIリクエスト/レスポンス型

### utils.ts (196行)

ブラウザ互換のユーティリティ関数:
- パス操作 (normalize, workspace key, workspace name)
- ファイル操作 (拡張子取得, 言語検出, ソート)
- エラー処理 (エラーメッセージ, HTTPエラー)
- 文字列ユーティリティ (切り詰め, 短縮ID)
- ファイルサイズフォーマット

### utils-node.ts (50行)

Node.js専用ユーティリティ:
- `normalizeWorkspacePath()` - Node.js pathモジュールを使用した絶対パス正規化
- Node.js環境専用のパス操作関数
- ブラウザ互換ユーティリティの再エクスポート

## 使用方法

### Webアプリケーション

```typescript
import type { Workspace, Deck } from '@deck-ide/shared/types';
import { getLanguageFromPath, sortFileEntries } from '@deck-ide/shared/utils';
```

### サーバー (Node.js)

```typescript
import type { Workspace, Deck } from '@deck-ide/shared/types';
import {
  normalizeWorkspacePath,
  getWorkspaceKey,
  sortFileEntries
} from '@deck-ide/shared/utils-node';
```

## プラットフォーム対応

- **utils.ts** - ブラウザとNode.js両方で動作
- **utils-node.ts** - Node.js専用 (Node.js APIを使用)

Webアプリケーションでは`utils.ts`を、サーバーでは`utils-node.ts`を使用してください。

## 開発

このパッケージはDeck IDEワークスペースの一部であり、npm workspacesにより自動的に他のパッケージにリンクされます。

詳細は `/docs/shared-package.md` を参照してください。
