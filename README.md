# Deck IDE

複数のターミナルを並列で管理できる軽量なWeb IDE。AIエージェント（Claude Code、Codex CLI等）を永続的に動かすことに最適化されています。

## 特徴

- **マルチターミナル** - 複数のターミナルを同時に起動・管理
- **Monaco Editor** - VS Codeと同じエディタエンジンによるコード編集
- **Git統合** - ステージング、コミット、プッシュ、プル、ブランチ管理
- **マルチリポジトリ対応** - ワークスペース内の複数Gitリポジトリを自動検出
- **ファイルエクスプローラー** - ファイル・フォルダの作成、削除、名前変更
- **Diffビューア** - 変更ファイルの差分表示
- **Windowsデスクトップアプリ** - Electronベースのネイティブアプリ（自動アップデート対応）

## スクリーンショット

```
┌─────────────────────────────────────────────────────────────┐
│ [エクスプローラー] [Git] [設定]    Deck IDE                  │
├─────────┬───────────────────────────────────────────────────┤
│ ファイル │  Monaco Editor                                    │
│ ツリー   │                                                   │
│         │                                                    │
│         ├───────────────────────────────────────────────────┤
│         │  Terminal 1        │  Terminal 2                  │
│         │  $ claude          │  $ codex                     │
│         │  ...               │  ...                         │
└─────────┴───────────────────────────────────────────────────┘
```

## インストール

### Windowsデスクトップアプリ（推奨）

[Releases](https://github.com/tako0614/ide/releases)から最新の`Deck-IDE-Setup-x.x.x.exe`をダウンロードしてインストール。

### ソースから実行

```bash
# リポジトリをクローン
git clone https://github.com/tako0614/ide.git
cd ide

# 依存関係をインストール
npm install

# 開発モードで起動（Web + Server）
npm run dev:server   # ターミナル1
npm run dev:web      # ターミナル2

# またはビルドして起動
npm run serve
```

ブラウザで http://localhost:3210 を開く。

## プロジェクト構成

```
ide/
├── apps/
│   ├── web/          # フロントエンド (React + Vite)
│   ├── server/       # バックエンド (Hono + node-pty)
│   └── desktop/      # Electronアプリ
├── packages/
│   └── shared/       # 共有型定義
└── docs/             # ドキュメント
```

## 技術スタック

### フロントエンド
- React 19
- Vite
- Monaco Editor
- xterm.js (WebGL対応)
- TypeScript

### バックエンド
- Hono (高速HTTPフレームワーク)
- node-pty (疑似ターミナル)
- simple-git (Git操作)
- WebSocket (ターミナル通信)
- SQLite (データ永続化)

### デスクトップ
- Electron 40
- electron-builder
- electron-updater (自動アップデート)

## 使い方

### ワークスペースの追加

1. 左サイドバーの「+」ボタンをクリック
2. ディレクトリパスを入力（例: `C:\Projects\myapp`）
3. ワークスペースが追加される

### デッキの作成

1. ワークスペースを選択
2. 「デッキ作成」ボタンをクリック
3. デッキ名を入力

### ターミナルの使用

- 「ターミナル追加」: 新しいターミナルを開く
- 「Claude」: `claude` コマンドを実行するターミナルを開く
- 「Codex」: `codex` コマンドを実行するターミナルを開く

### Git操作

1. サイドナビでGitアイコンをクリック
2. 変更ファイルを確認
3. 「+」でステージング、「−」でアンステージ
4. コミットメッセージを入力してコミット
5. プッシュ/プル/フェッチボタンで同期

## 開発

```bash
# 依存関係のインストール
npm install

# 開発サーバー起動
npm run dev:server   # サーバー (port 3210)
npm run dev:web      # Web (port 5173)

# ビルド
npm run build:web    # Webのみ
npm run build:server # サーバーのみ
npm run build:desktop # デスクトップアプリ

# デスクトップアプリの開発
npm run dev:desktop
```

## 環境変数

サーバーは以下の環境変数をサポートします:

| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `PORT` | サーバーポート | 3210 |
| `HOST` | バインドアドレス | localhost |
| `BASIC_AUTH_USER` | Basic認証ユーザー名 | (なし) |
| `BASIC_AUTH_PASSWORD` | Basic認証パスワード | (なし) |
| `CORS_ORIGIN` | CORS許可オリジン | * (開発時) |
| `DEFAULT_ROOT` | デフォルトルートパス | (なし) |

## API

### ワークスペース
- `GET /api/workspaces` - ワークスペース一覧
- `POST /api/workspaces` - ワークスペース作成

### デッキ
- `GET /api/decks` - デッキ一覧
- `POST /api/decks` - デッキ作成

### ファイル
- `GET /api/files` - ファイル一覧
- `GET /api/file` - ファイル読み込み
- `PUT /api/file` - ファイル保存
- `POST /api/file` - ファイル作成
- `DELETE /api/file` - ファイル削除

### ターミナル
- `GET /api/terminals` - ターミナル一覧
- `POST /api/terminals` - ターミナル作成
- `DELETE /api/terminals/:id` - ターミナル削除
- `WS /api/terminals/:id` - ターミナル接続

### Git
- `GET /api/git/status` - Gitステータス
- `GET /api/git/repos` - リポジトリ一覧
- `POST /api/git/stage` - ステージング
- `POST /api/git/unstage` - アンステージ
- `POST /api/git/commit` - コミット
- `POST /api/git/push` - プッシュ
- `POST /api/git/pull` - プル
- `GET /api/git/diff` - 差分取得
- `GET /api/git/branches` - ブランチ一覧
- `POST /api/git/checkout` - ブランチ切り替え

## ライセンス

MIT

## 作者

[tako0614](https://github.com/tako0614)
