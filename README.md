# Deck IDE

複数のターミナルを並列で管理できる軽量な Web IDE。AIエージェント（Claude Code、Codex CLI 等）を永続的に動かすことに最適化されています。

## 特徴

- **マルチターミナル** — 複数のターミナルを同時に起動・管理。グリッドレイアウトで自動配置
- **デッキシステム** — ワークスペースごとにターミナルをグループ化。最大3デッキまで分割表示
- **Monaco Editor** — VS Code と同じエディタエンジンによるコード編集
- **Git 統合** — ステージング、コミット、プッシュ、プル、ブランチ管理、Diff ビューア
- **マルチリポジトリ対応** — ワークスペース内の複数 Git リポジトリを自動検出
- **ファイルエクスプローラー** — ファイル・フォルダの作成、削除、コンテキストメニュー
- **ターミナルバッファ永続化** — WebSocket 切断・再接続時にターミナル出力を完全復元
- **Basic 認証** — CLI またはブラウザ設定画面から認証の有効化が可能
- **CLI ツール** — `deckide` コマンドでバックグラウンド起動・停止・設定管理
- **モバイル対応** — タッチ操作、スワイプでのデッキ切替、レスポンシブレイアウト

## クイックスタート

### npm からインストール（推奨）

```bash
npm install -g deckide
deckide
```

ブラウザが自動で `http://localhost:8787` を開きます。

### ソースから実行

```bash
git clone https://github.com/tako0614/ide.git
cd ide
npm install

# 開発モード（ホットリロード付き）
npm run dev:server   # ターミナル1: サーバー (port 8787)
npm run dev:web      # ターミナル2: Web (port 5173)

# または本番ビルド
npm run build
npm run serve
```

## CLI リファレンス

```
deckide [start]                サーバー起動（バックグラウンド）
deckide start --fg             サーバー起動（フォアグラウンド）
deckide stop                   サーバー停止
deckide restart                サーバー再起動
deckide status                 サーバー状態表示
deckide logs [-f]              サーバーログ表示

deckide port                   現在のポート表示
deckide port <number>          ポート変更（自動再起動）

deckide auth on [user] [pass]  Basic 認証を有効化
deckide auth off               Basic 認証を無効化
deckide auth status            認証状態表示

deckide config                 全設定表示
deckide config set <key> <val> 設定値変更
deckide config get <key>       設定値取得
deckide config reset           設定リセット
```

### 起動オプション

| オプション | 説明 |
|-----------|------|
| `-p, --port <port>` | ポート番号（デフォルト: 8787） |
| `--host <host>` | バインドアドレス（デフォルト: 0.0.0.0） |
| `--no-open` | ブラウザを自動で開かない |
| `--fg` | フォアグラウンドで起動 |

## 使い方

### ワークスペース

1. サイドバーのフォルダアイコンをクリック
2. 「ワークスペース追加」でディレクトリパスを指定
3. ワークスペースを選択するとエディタ・ファイルツリー・Git 操作が利用可能

### デッキとターミナル

1. ターミナルビューで「+」からデッキを作成
2. デッキ内で「+」「C」「X」ボタンからターミナルを追加
   - **+** — 通常のシェル
   - **C** — `claude` コマンド（Claude Code）
   - **X** — `codex` コマンド（Codex CLI）
3. 複数デッキをタブで切り替え。ドラッグ&ドロップで並び替え・分割表示

### Git 操作

1. ワークスペースエディタ内のソース管理パネルを開く
2. 変更ファイルを確認し「+」でステージング
3. コミットメッセージを入力してコミット
4. プッシュ / プル / フェッチで同期

## プロジェクト構成

```
ide/
├── bin/
│   └── deckide.js       # CLI エントリーポイント
├── src/                  # バックエンド (Node.js)
│   ├── index.ts          # サーバー起動
│   ├── server.ts         # Hono アプリ構築・ミドルウェア
│   ├── config.ts         # 環境変数・設定
│   ├── websocket.ts      # WebSocket サーバー・ターミナル接続
│   ├── types.ts          # 型定義
│   ├── routes/           # API ルート
│   │   ├── workspaces.ts
│   │   ├── decks.ts
│   │   ├── files.ts
│   │   ├── terminals.ts
│   │   ├── git.ts
│   │   └── settings.ts
│   ├── middleware/        # 認証・CORS・セキュリティ
│   ├── utils/            # DB・パス・UTF-8・シェル
│   └── shared/           # フロント/バック共有型・ユーティリティ
├── web/                  # フロントエンド (React)
│   └── src/
│       ├── App.tsx
│       ├── components/   # UI コンポーネント
│       ├── hooks/        # カスタムフック
│       ├── utils/        # ユーティリティ
│       └── styles.css    # Tailwind CSS + カスタムスタイル
├── data/                 # SQLite データベース
└── docs/                 # ドキュメント
```

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | React 18, Vite, Tailwind CSS 4, Monaco Editor, xterm.js 5 |
| バックエンド | Hono, node-pty, simple-git, WebSocket (ws), Zod |
| データベース | Node.js 組み込み SQLite (`node:sqlite`) |
| 言語 | TypeScript |
| ランタイム | Node.js >= 22.5.0 |

## 環境変数

| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `PORT` | サーバーポート | 8787 |
| `HOST` | バインドアドレス | 0.0.0.0 |
| `DEFAULT_ROOT` | デフォルトルートパス | ホームディレクトリ |
| `BASIC_AUTH_USER` | Basic 認証ユーザー名 | — |
| `BASIC_AUTH_PASSWORD` | Basic 認証パスワード（本番は12文字以上） | — |
| `CORS_ORIGIN` | CORS 許可オリジン（本番は必須） | — |
| `NODE_ENV` | 実行環境 | development |
| `MAX_FILE_SIZE` | 最大ファイルサイズ (bytes) | 10485760 (10MB) |
| `TERMINAL_BUFFER_LIMIT` | ターミナルバッファ上限 (bytes) | 500000 |
| `TRUST_PROXY` | プロキシヘッダーを信頼 | false |
| `DECKIDE_DATA_DIR` | データディレクトリ | ~/.deckide |

## API

### ワークスペース

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/workspaces` | 一覧 |
| POST | `/api/workspaces` | 作成 |
| DELETE | `/api/workspaces/:id` | 削除 |
| GET | `/api/config` | デフォルト設定取得 |

### デッキ

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/decks` | 一覧 |
| POST | `/api/decks` | 作成 |
| PUT | `/api/decks/order` | 並び替え |
| DELETE | `/api/decks/:id` | 削除 |

### ファイル

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/files` | ディレクトリ一覧 |
| GET | `/api/preview` | ディレクトリプレビュー |
| GET | `/api/file` | ファイル読み込み |
| PUT | `/api/file` | ファイル保存 |
| POST | `/api/file` | ファイル作成 |
| DELETE | `/api/file` | ファイル削除 |
| POST | `/api/dir` | ディレクトリ作成 |
| DELETE | `/api/dir` | ディレクトリ削除 |

### ターミナル

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/terminals` | 一覧 |
| POST | `/api/terminals` | 作成 |
| DELETE | `/api/terminals/:id` | 削除 |
| WS | `/api/terminals/:id` | WebSocket 接続 |

### Git

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/git/status` | ステータス |
| GET | `/api/git/repos` | リポジトリ一覧 |
| GET | `/api/git/multi-status` | 複数リポジトリの集約ステータス |
| POST | `/api/git/stage` | ステージング |
| POST | `/api/git/unstage` | アンステージ |
| POST | `/api/git/commit` | コミット |
| POST | `/api/git/discard` | 変更を破棄 |
| GET | `/api/git/diff` | 差分取得 |
| POST | `/api/git/push` | プッシュ |
| POST | `/api/git/pull` | プル |
| POST | `/api/git/fetch` | フェッチ |
| GET | `/api/git/remotes` | リモート一覧 |
| GET | `/api/git/branch-status` | ブランチ状態（ahead/behind） |
| GET | `/api/git/branches` | ブランチ一覧 |
| POST | `/api/git/checkout` | ブランチ切り替え |
| POST | `/api/git/create-branch` | ブランチ作成 |
| GET | `/api/git/log` | コミット履歴 |

### その他

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/health` | ヘルスチェック |
| GET | `/api/settings` | 設定取得 |
| POST | `/api/settings` | 設定更新 |
| GET | `/api/ws-token` | WebSocket 認証トークン |
| POST | `/api/shutdown` | サーバー停止 |

## WebSocket プロトコル

ターミナル接続は `/api/terminals/:id` WebSocket エンドポイントを使用します。

**クライアント → サーバー:**
- `{ type: "claim" }` — リサイズ権限を取得
- `{ type: "resize", cols, rows }` — PTY サイズ変更
- バイナリフレーム — キーボード入力

**サーバー → クライアント:**
- `{ type: "sync", offsetBase, reset }` — バッファ同期開始
- `{ type: "ready" }` — 同期完了、入力受付可能
- バイナリフレーム — ターミナル出力

再接続時はバッファオフセットを指定して差分のみ取得可能（`?bufferOffset=N&reconnect=1`）。

## ライセンス

MIT

## 作者

[tako0614](https://github.com/tako0614)
