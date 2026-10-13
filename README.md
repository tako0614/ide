# Deck IDE

ブラウザで複数の shell を並べて操作する端末ツール。作業ディレクトリごとにデッキを作り、通常の shell や任意の CLI を動かせます。

## 特徴

- **マルチターミナル** — shell をグリッドに並べ、必要な端末を最大化
- **デッキ** — 作業ディレクトリごとのグループ、並び替え、最大3デッキの分割表示
- **再接続** — 出力の増分再生、長い切断後も上限30秒の間隔で再試行
- **通信圧縮** — 対応ブラウザと WebSocket 圧縮を交渉し、端末出力を内容を変えずに送信
- **端末描画** — xterm.js 6 の同期描画、文字サイズの保存、連続リサイズの抑制
- **セッション認証** — ログイン画面、HttpOnly Cookie、ログアウト時の接続失効
- **モバイル対応** — 端末切り替えとソフトキーボードに合わせた表示

出力の再生はサーバー内のリングバッファ（既定500KB）の範囲です。ブラウザを閉じても
shell は動作しますが、DeckIDE サーバーの停止・再起動で shell プロセスは終了します。
再起動をまたぐ shell の継続は現在の実装では保証しません。

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

deckide auth on [user] [pass]  セッション認証を有効化
deckide auth off               セッション認証を無効化
deckide auth status            認証状態表示

deckide config                 全設定表示
deckide config set <key> <val> 設定値変更
deckide config get <key>       設定値取得
deckide config reset           設定リセット

# 起動中のサーバーを CLI から操作（Web UI にリアルタイムで反映）
deckide ls [--json]            ワークスペース・デッキ・端末の一覧
deckide open [dir] [opts]      dir（既定: カレント）をデッキとして開き端末を作成
deckide new [opts]             今いるデッキに端末を追加
    -d, --deck <deck>          デッキ（既定: この端末のデッキ / カレントのデッキ）
    -t, --title <title>        端末タイトル
    -c, --command <cmd>        シェルの代わりに実行するコマンド
    -a, --attach               作成後すぐ attach
    -s, --show                 開いているブラウザでその端末を前面に
deckide attach [terminal]      この端末から Deck IDE の端末を操作（Ctrl+] でデタッチ）
deckide send <terminal> <text> 文字列 + Enter を入力（-n で Enter なし、"-" で標準入力）
deckide show <terminal>        開いているブラウザでその端末を前面に
deckide kill <terminal>        端末を閉じる
deckide resize <t> <c> <r>     全クライアント共通のサイズを指定
deckide events                 状態変化を JSON Lines で購読
```

`<terminal>` は `deckide ls` の番号・ID（先頭一致）・タイトルのいずれか。
Deck IDE の端末の中では `deckide new` で同じデッキに兄弟端末を開けます
（`DECKIDE_TERMINAL_ID` / `DECKIDE_DECK_ID` が設定されています）。

CLI はサーバー起動ごとにデータディレクトリへ書き出される `cli.json`
（モード 0600、同じ OS ユーザーのみ読める）のトークンで認証するため、
セッション認証が有効でもログイン不要です。別ホストのサーバーへは
`DECKIDE_URL` と `DECKIDE_TOKEN` で接続先を指定します。

### 複数クライアントでの端末サイズ

PC・スマホ・`deckide attach` が同じ端末を同時に開いても TUI が崩れないよう、
PTY のサイズはサーバーが一元管理します。

- **最後に操作したクライアント**（入力・フォーカス・タップ）のサイズに PTY が追従し、
  プログラムには SIGWINCH で通知されます。
- ほかのクライアントは同じ cols×rows のまま描画し、画面に収まらなければ縮小表示します
  （ヘッダに「閲覧中 120×40 · ここで操作」）。押す・入力すると操作を引き継ぎます。
- 再接続やリロード時は、サーバー側のヘッドレス端末が保持している現在の画面
  （スナップショット）を送るため、過去の出力が別サイズで再生されて崩れることがありません。

### 起動オプション

| オプション | 説明 |
|-----------|------|
| `-p, --port <port>` | ポート番号（デフォルト: 8787） |
| `--host <host>` | バインドアドレス（デフォルト: 127.0.0.1 = ループバックのみ） |
| `--no-open` | ブラウザを自動で開かない |
| `--fg` | フォアグラウンドで起動 |

### ネットワーク公開について

Deck IDE のターミナル API は**任意のコマンドを実行ユーザー権限で実行**します。
そのため、ループバック以外のアドレス（`0.0.0.0` や LAN IP）にバインドする場合は
セッション認証が必須です。認証なしでの公開バインドはサーバー起動時に拒否されます。

認証を有効にしてローカルで起動する場合:

```bash
deckide auth on <user> <password>   # 12文字以上のパスワード
deckide config set host 127.0.0.1
deckide restart
```

ログインは HTTPS または同じマシンの loopback HTTP で行います。LAN IP・公開DNS名での
平文 HTTP ログインは拒否します。他端末からは HTTPS のリバースプロキシを通し、
DeckIDE 自体を loopback に bind してください。プロキシを使う場合だけ
`TRUST_PROXY=true` と `DECKIDE_ALLOWED_HOSTS` を設定します。
本番の`CORS_ORIGIN`にはブラウザで開くHTTPSのOriginを指定します。

信頼できるリバースプロキシ配下などで意図的にこの検査を無効化する場合のみ、
`DECKIDE_ALLOW_INSECURE_HOST=true` を設定してください。

## 使い方

### Shell を開く

1. 「作業ディレクトリを登録」で shell の開始ディレクトリを指定
2. 最初のデッキと shell が開く
3. 「＋ 端末」で同じディレクトリに shell を追加
4. 任意の CLI は shell 内で起動（例: `codex`、`claude`）

スマホなどタッチ端末では、端末の下に Esc / Tab / Ctrl / Alt / 矢印 / ^C / ⇧Tab などの
キーバーが出ます（Ctrl・Alt は次に打つキーに 1 回だけ掛かります）。端末をスクロールしても
キーボードは開かず、タップしたときだけ入力モードになります。

デッキタブの「+」から別のデッキを作成できます。タブをドラッグして並び替え、
メイン領域へドロップして分割表示します。各端末の最大化ボタンで一つに集中できます。
タブの × は表示を閉じる操作です。端末の × またはデッキの削除はプロセスを終了します。

メイン画面は端末操作に絞っています。Deck Drive、code-server、ファイル編集、Git 操作の
画面はありません。共有 Agent Browser の既存 HTTP/MCP API は別の利用経路です。

### デスクトップ（GUI アプリ）

ツールバーの ▣ から、Deck IDE が管理する**共有デスクトップ**を開きます。エージェント用
ブラウザ（CDP 9222 の Chrome）、自分で起動した GUI アプリ（Grok Bot・ChatGPT・Chrome・
端末など）、MCP の `deckide.computer.*` がすべて同じ画面を共有します。

- 画面は VNC（x11vnc → WebSocket → noVNC）で表示し、マウス移動・クリック・右クリック・
  ドラッグ・ホイール・キーボードをそのまま操作できます。「⛶」で端末を隠して大きく表示。
- 「アプリ ▾」で `.desktop` に登録されたアプリを起動、コマンド欄で任意のコマンドを実行。
  root で動いている場合、Chromium / Electron 系アプリには `--no-sandbox` を付けて起動します。
- 「文字を送る」は日本語も送れます（xdotool で入力）。「貼付」で手元のクリップボードを
  デスクトップへ、デスクトップ側でコピーした内容はパネル下部からコピーできます。
- スマホでは全画面表示になり、⌨ でソフトキーボード、Esc/Tab/Ctrl/Alt/矢印などのキーバー、
  タップ＝クリック、長押し／2本指タップ＝右クリック、2本指ドラッグ＝スクロール、
  ピンチ＝ズーム（アプリ側）で操作できます。「等倍」で 1:1 表示＋パン。
- デスクトップは Deck IDE とは別プロセス（Xvfb + openbox、既定 `:99`・1600×900）で動き、
  Deck IDE を再起動しても開いているアプリは残ります（次回起動時に再接続）。止めるのは
  「停止」ボタンか `deckide gui --stop`。すでに他のプログラムが同じディスプレイを使って
  いる場合はそれに相乗りし、止めません。
- VNC サーバは 127.0.0.1 のみで待ち受け、起動ごとのランダムパスワードを認証済みの
  Deck IDE クライアントにだけ渡します（外からは WebSocket ブリッジ経由のみ）。

```
deckide gui                     # デスクトップの状態と起動できるアプリ
deckide gui grok-bot            # アプリを起動
deckide gui -- xeyes            # 任意のコマンドを起動（カレントディレクトリで）
eval "$(deckide gui --env)"     # このシェルの GUI プログラムをデスクトップに表示
```

MCP の `deckide.computer.*` は同じ共有デスクトップを観測・操作します。スクリーンショットは
画像と観測 ID を返し、入力には同じログインセッション／MCP grant の30秒以内の未使用の
観測 ID が必要です（エージェント向けの安全ゲート）。`DECKIDE_DESKTOP=false` にすると
共有デスクトップを無効にし、従来どおりエージェント用ブラウザは xvfb-run、computer ツールは
専用の隔離デスクトップを使います。

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
| フロントエンド | React 18, Vite, Tailwind CSS 4, xterm.js 6 |
| バックエンド | Hono, node-pty, simple-git, WebSocket (ws), Zod |
| データベース | Node.js 組み込み SQLite (`node:sqlite`) |
| 言語 | TypeScript |
| ランタイム | Node.js >= 22.5.0 |

## 環境変数

| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `PORT` | サーバーポート | 8787 |
| `HOST` | バインドアドレス | 127.0.0.1 |
| `DEFAULT_ROOT` | デフォルトルートパス | ホームディレクトリ |
| `DECKIDE_AUTH_USER` | ログインユーザー名（環境変数で設定する場合） | — |
| `DECKIDE_AUTH_PASSWORD` | ログインパスワード（本番は12文字以上） | — |
| `CORS_ORIGIN` | CORS 許可オリジン（本番は必須） | — |
| `NODE_ENV` | 実行環境 | development |
| `MAX_FILE_SIZE` | 最大ファイルサイズ (bytes) | 10485760 (10MB) |
| `TERMINAL_BUFFER_LIMIT` | ターミナルバッファ上限 (bytes) | 500000 |
| `DECKIDE_DESKTOP` | 共有デスクトップ（Linux のみ）。`false` で無効 | true |
| `DECKIDE_DESKTOP_DISPLAY` | 共有デスクトップの X ディスプレイ | :99 |
| `DECKIDE_DESKTOP_SIZE` | 共有デスクトップの解像度（新規起動時） | 1600x900 |
| `TERMINAL_MIRROR_SCROLLBACK` | 再接続スナップショットに含めるスクロールバック行数（端末あたり概ね 行数×桁数×12 バイト） | 3000 |
| `TRUST_PROXY` | プロキシヘッダーを信頼 | false |
| `DECKIDE_ALLOWED_HOSTS` | リバースプロキシ等から届く許可DNS名（カンマ区切り） | — |
| `DECKIDE_DEV_API_URL` | Vite開発用API proxyの接続先 | http://localhost:8787 |
| `DECKIDE_ALLOW_INSECURE_HOST` | 認証なしで非ループバックへのバインドを許可 | false |
| `DECKIDE_DATA_DIR` | データディレクトリ | ~/.deckide |
| `AGENT_BROWSER_CHROME` | Chromium / Chrome 実行ファイル | Playwright Chromium または PATH から自動検出 |
| `AGENT_BROWSER_PROFILE_DIR` | ブラウザプロファイル | ~/.local/share/agent-browser/profile |
| `AGENT_BROWSER_OUTPUT_DIR` | ブラウザログ出力先 | ~/.local/share/agent-browser/output |
| `AGENT_BROWSER_FFMPEG` | ffmpeg 実行ファイル | PATH から自動検出 |
| `AGENT_BROWSER_PACTL` | pactl 実行ファイル | PATH から自動検出 |
| `AGENT_BROWSER_AUDIO_SOURCE` | 音声キャプチャ元 | 既定 sink の monitor source |
| `AGENT_BROWSER_WEBRTC` | エージェントブラウザ映像を WebRTC 配信（`true`/`auto`/`false`、現状はオプトイン） | false |
| `AGENT_BROWSER_WEBRTC_BITRATE` | WebRTC ビットレート（ffmpeg `-b:v` 形式） | 3M |
| `AGENT_BROWSER_WEBRTC_FPS` | WebRTC フレームレート | 30 |
| `AGENT_BROWSER_WEBRTC_ICE_SERVERS` | ICE サーバ（JSON配列）。空ならホスト候補のみ（同一ホスト/LAN） | — |
| `AGENT_BROWSER_DISPLAY` | キャプチャする X ディスプレイ（未設定なら Chrome から自動検出） | — |
| `AGENT_BROWSER_CDP_PORT` | 共有ブラウザの CDP ポート | 9222 |
| `AGENT_BROWSER_REAP_MCP` | リークした chrome-devtools-mcp スタックを自動回収 | true |
| `AGENT_BROWSER_MAX_MCP_PER_AGENT` | 1エージェントが保持できる MCP スタック上限（超過分の古いものを回収） | 3 |
| `AGENT_BROWSER_MCP_IDLE_MS` | 回収対象とみなすアイドル閾値 (ms) | 600000 |

## MCP / OAuth

Deck IDE は MCP Streamable HTTP エンドポイントを提供します。

| 用途 | URL |
|------|-----|
| MCP | `http://localhost:8787/mcp` |
| Protected Resource Metadata | `http://localhost:8787/.well-known/oauth-protected-resource/mcp` |
| Authorization Server Metadata | `http://localhost:8787/.well-known/oauth-authorization-server` |
| Dynamic Client Registration | `http://localhost:8787/oauth/register` |
| Authorization Endpoint | `http://localhost:8787/oauth/authorize` |
| Token Endpoint | `http://localhost:8787/oauth/token` |

OAuth は Authorization Code + PKCE (`S256`) を使用します。MCP クライアントは Dynamic Client Registration でクライアント登録し、`deckide:all` scope の Bearer トークンを取得して `/mcp` に接続します。

セッション認証が有効な場合、OAuth の認可画面 (`/oauth/authorize`) はログイン後に開きます。
MCP 呼び出し自体は `Authorization: Bearer <access_token>` を使用し、ブラウザのCookieで
MCPの権限を取得することはできません。

### 認証の移行

既存の Basic 設定のユーザー名・パスワードは初回起動時に読み取り、セッション認証の
設定と scrypt の検証用ハッシュへ移行します。設定ファイルに平文パスワードを残しません。
従来の `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` 環境変数も移行用の入力として読み取ります。
HTTP の Basic ヘッダーは認証手段として受け付けません。

CookieはHttpOnly・SameSite=Strictで、HTTPSではSecureを付けます。セッションは
サーバー内に保持し、期限切れ・ログアウト・認証設定変更・サーバー再起動で失効します。
ログアウトはWebSocketを閉じますが、shellプロセスはサーバー上で動作し続けます。
CookieやパスワードをブラウザのlocalStorageへ保存しません。

ブラウザAPIの変更操作は同一Originと`X-DeckIDE-CSRF: 1`を要求します。
WebSocketはログイン中に発行した短時間・一回限りのticketと同じセッションのCookieを
使います。既存のAPIクライアントはこの認証方式への対応が必要です。

MCP tools からはワークスペース、ファイル、ディレクトリ、デッキ、端末、Git、WebSocket 管理、設定、サーバー停止、低レベル API 呼び出しを利用できます。端末はMCP専用に `write` / `read_buffer` / `resize` も提供します。

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
| GET | `/api/terminals` | 一覧（`?deckId=` で絞り込み。サイズ・接続クライアント・動的タイトル付き） |
| POST | `/api/terminals` | 作成 |
| GET | `/api/terminals/:id` | 詳細 |
| PATCH | `/api/terminals/:id` | deckId / title metadata update (keeps the process alive) |
| POST | `/api/terminals/:id/input` | 入力を送る `{ data }` |
| POST | `/api/terminals/:id/resize` | 全クライアント共通のサイズを設定 `{ cols, rows }` |
| POST | `/api/terminals/:id/focus` | 開いている Web UI でこの端末を前面に |
| DELETE | `/api/terminals/:id` | 削除 |
| WS | `/api/terminals/:id` | WebSocket 接続 |

### ブラウザ

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/browser/status` | 状態取得 |
| POST | `/api/browser/start` | 起動 |
| POST | `/api/browser/stop` | 停止 |
| POST | `/api/browser/navigate` | URL へ移動 |
| WS | `/api/browser/ws` | 画面・入力ストリーム |
| WS | `/api/browser/audio/ws` | 音声ストリーム |

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
| GET | `/api/desktop` | 共有デスクトップの状態 |
| POST | `/api/desktop/start` / `stop` | 起動 / 停止 |
| GET | `/api/desktop/apps` | 起動できるアプリ一覧 |
| POST | `/api/desktop/launch` | アプリ `{ appId }` またはコマンド `{ command, cwd? }` を起動 |
| POST | `/api/desktop/type` | フォーカス中のウィンドウへ文字を入力 `{ text }` |
| POST | `/api/desktop/vnc` | VNC ビューア用の資格情報（WS `/api/desktop/vnc` で接続） |
| GET | `/api/events` | 状態変化の Server-Sent Events（デッキ・端末の作成/削除、前面化要求） |
| POST | `/api/shutdown` | サーバー停止 |

## WebSocket プロトコル

ターミナル接続は `/api/terminals/:id` WebSocket エンドポイントを使用します。ブラウザ接続は `/api/browser/ws` で JPEG screencast とマウス・キー入力イベントを送受信します。ブラウザ音声は `/api/browser/audio/ws` で WebM/Opus のバイナリチャンクを送ります。

PTY のサイズはサーバーが決め、全クライアントがそのサイズで描画します。
主クライアント（最後に操作したもの）の表示可能サイズに PTY が追従します。

**接続クエリ:** `proto=2`（スナップショット対応）、`cols`/`rows`（このクライアントの表示可能サイズ）、
`claim=1`（接続と同時に主クライアントになる）、`cid`（再接続をまたいで同一のクライアントID）、
`client=web|cli`、`bufferOffset=N`（再接続時、処理済みバイト数）。

**クライアント → サーバー:**
- `{ type: "resize", cols, rows }` — 表示可能サイズの通知（主クライアントのときだけ PTY に反映）
- `{ type: "claim", cols?, rows? }` — 主クライアントになり PTY をこのサイズへ
- `{ type: "resync" }` — 現在の画面を送り直してもらう
- バイナリフレーム — キーボード入力

**サーバー → クライアント:**
- `{ type: "sync", offsetBase, reset, cols, rows, snapshot? }` — 再生開始。`cols`×`rows` を適用してから書き込む。
  `snapshot: true` のとき次のバイナリフレームは画面のスナップショット（オフセットに数えない）
- `{ type: "ready" }` — 再生完了、以降はライブ出力
- `{ type: "primary", value }` — 主クライアントかどうか（主だけが端末クエリに応答する）
- `{ type: "size", cols, rows }` — PTY がリサイズされた。以降このサイズで描画
- バイナリフレーム — ターミナル出力

再接続時、`bufferOffset` 以降に PTY のリサイズがなければ差分のみ、あればスナップショットを送ります。

## ライセンス

MIT

## 作者

[tako0614](https://github.com/tako0614)

Move/rename CLI commands and optional tmux persistence: [session metadata](docs/session-metadata.md).
