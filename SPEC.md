# Deck IDE 設計仕様

## コンセプト

ブラウザで複数の shell を並べて操作する端末ツール。メイン UI は作業ディレクトリ・デッキ・端末の作成と配置に絞る。ファイル編集、Git 操作、Deck Drive、code-server の画面は提供しない。任意の CLI は通常の shell 内で起動する。任意の Computer パネルから専用 Linux デスクトップを操作できる。

## コア概念

| 概念 | 説明 |
|------|------|
| **ワークスペース** | shell の開始ディレクトリ。既存 API では workspace として保持する |
| **デッキ** | ワークスペースに紐づくターミナルのグループ。タブで切り替え、最大3つまで分割表示 |
| **ターミナルセッション** | node-pty による PTY プロセス。出力はサーバー側でバッファリングされ、再接続時に再生される |

## アーキテクチャ

```
┌─────────────────────────────────────────────┐
│  Browser (React + xterm.js)                  │
│  ┌───────┐ ┌───────┐ ┌───────┐              │
│  │ Term1 │ │ Term2 │ │ Term3 │  ← xterm.js  │
│  └───┬───┘ └───┬───┘ └───┬───┘              │
│      │ WS      │ WS      │ WS               │
└──────┼─────────┼─────────┼──────────────────┘
       │         │         │
┌──────┼─────────┼─────────┼──────────────────┐
│  Server (Hono + node-pty)                    │
│  ┌───┴───┐ ┌───┴───┐ ┌───┴───┐              │
│  │ PTY1  │ │ PTY2  │ │ PTY3  │              │
│  └───────┘ └───────┘ └───────┘              │
│  ┌──────────────────────────────┐            │
│  │  SQLite (node:sqlite)        │            │
│  │  ワークスペース・デッキ永続化       │            │
│  └──────────────────────────────┘            │
└──────────────────────────────────────────────┘
```

## ターミナルバッファ管理

サーバーは各ターミナルの PTY 出力をリングバッファに保持する（上限: `TERMINAL_BUFFER_LIMIT`、デフォルト 500KB）。

### 再接続フロー

1. クライアントが `?bufferOffset=N&reconnect=1` 付きで WebSocket 接続
2. サーバーが `{ type: "sync", offsetBase, reset }` を送信
3. バッファデータをバイナリフレームで送信（UTF-8 境界・ANSI エスケープシーケンス境界を考慮）
4. `{ type: "ready" }` を送信して同期完了を通知
5. クライアントはリプレイ中のリサイズをロックし、完了後にキャッチアップ fit を実行

### バッファ安全性

- UTF-8 マルチバイト文字の途中で切断しない（`alignToUtf8Start` / `alignToUtf8End`）
- ANSI エスケープシーケンス（CSI、OSC、DCS、APC）の途中で切断しない（`skipPartialEscapeSequence`）
- リプレイ中は xterm.js のリサイズをロック（`replayResizeLock`）して描画崩れを防止

## 描画とリサイズ制御

xterm.js 6 の標準 DOM renderer を使う。DEC 2026 の同期描画中は途中の画面更新を
保留し、終了後にまとめて描画する。フォントはローカルの等幅フォントと日本語の
fallback を使い、既定14px、11〜22pxで変更できる。文字サイズの変更は既存の
xterm と接続を維持したまま適用し、ブラウザに保存する。

ターミナルの fit ロジックは以下の条件でリサイズを抑制する:

- **リプレイロック中**: バッファリプレイ完了まで全リサイズをブロック
- **連続する変更**: 通常のサイズ変更は100ms待ってまとめて fit
- **表示・文字サイズの変更**: 非表示からの復帰や文字サイズ変更では直ちに fit
- **同じ行・列数**: fit 後の行・列数が変わらなければサーバーへ送らない

再接続の増分位置は xterm の保留中の write を完了してから決める。

## 任意の Computer パネル

明示的な prepare で専用 Xvfb を起動する。ホストの画面や共有 Agent Browser には接続しない。
Xauthority と一時 profile は専用ディレクトリへ保存し、X11 TCP listener は開かない。
デスクトップは OS 権限を隔離する sandbox ではなく、端末は server の実行ユーザーに従う。
ブラウザの sandbox は無効にせず、root 実行時はブラウザ起動を拒否する。

画面は960×540のJPEGで返す。表示中だけ最大1秒ごとに取得し、同一hashの画像は再送しない。
入力の観測IDは30秒、一回限り。browser sessionまたは検証済みMCP grantに結び付ける。
成功した入力は全actorの古い観測を無効にする。座標・key・文字数を検証し、native command
はshell文字列として実行しない。実行中の重複操作とアプリ数を制限する。

HTTP `/api/computer/*` と MCP `deckide.computer.*` は同じ実装を使う。MCP screenshotは
標準image contentとmetadataを返す。private bridgeのactorは検証済みbearer grantから導出し、
外部からのheader/JSONでは指定できない。認証無効時もbrowserごとにguest Cookieを発行し、
Computer POSTにはOrigin / CSRF検証を適用する。停止・server終了・Xvfb異常終了時は
所有するprocess groupと一時状態を回収する。

## セキュリティ

- セッション認証: ログイン時に暗号学的乱数のopaque tokenを発行し、サーバーに検証状態を保持。Basic headerでの認証はしない
- CookieはHttpOnly・SameSite=Strict、HTTPSでSecure。loginはHTTPSまたはloopback HTTPに限定
- パスワードはsalt付きscrypt hashで保存し、設定のAPIではパスワードもhashも返さない。旧Basic設定は初回読み取り時に移行
- browser APIの変更操作とlogin/logoutは同一Originと専用CSRF headerを要求。OAuth認可formはセッションに紐づくCSRF tokenを使う
- セッションの期限切れ・ログアウト・認証設定変更で関連WebSocketとticketを失効。ログアウトだけではPTYを終了しない
- WebSocket ticket認証（30秒、一回限り、発行時のセッションCookieに紐づく）
- MCPのOAuth bearer認証はbrowser sessionと独立。OAuth認可画面はsessionで保護
- Origin 検証（CSRF 防止）: HTTP API（`/api/*`、`/mcp`、`/oauth/*`）と WebSocket の両方
- Host 検証（DNS リバインディング防止）: localhost と IP リテラルは常に許可。DNS 名でアクセスする場合は `DECKIDE_ALLOWED_HOSTS` に列挙する
- パストラバーサル防止（ワークスペースルート内に限定）
- 本番環境では CORS_ORIGIN の明示的指定が必須
- REP (CSI b) の繰り返し回数を 65535 に制限（DoS 防止）
- セキュリティヘッダー（X-Content-Type-Options、X-Frame-Options 等）

### 信頼境界

境界は「API に到達できるかどうか」であり、ファイルシステム上の位置ではない。

ワークスペースルートは利用者が選ぶ任意のディレクトリであり（コア概念の表を参照）、
サンドボックス境界ではない。`POST /api/terminals` は `command` を受け取って
サーバーの OS ユーザーとしてシェルを起動するため、API に到達できる呼び出し元は
そのユーザーの権限をすべて持つ。したがってワークスペースルートを `DEFAULT_ROOT`
配下に限定しても実効的な防御にはならない。`resolveSafePath()` のパストラバーサル
検証は、選択済みワークスペース内に UI の操作を留めるためのものである。

実際の防御は次の 3 点:

1. デフォルトでループバックのみに bind
2. ネットワークに bind する場合はセッション認証を必須化（`DECKIDE_ALLOW_INSECURE_HOST` で明示的に解除可能）
3. Origin / Host 検証によりブラウザ経由の到達を遮断

## モバイル対応

- 720px 以下でレスポンシブレイアウトに切り替え
- アクティビティバーが画面下部に水平配置
- デッキを左右スワイプで切り替え
- ターミナルを縦スクロールで切り替え
- ターミナルフォーカス時はグリッドスクロールを無効化
- タッチデバイスではホバー状態の残留を防止

## プロセスの寿命と再接続

- workspace と deck は SQLite に保存する。PTY と出力バッファはサーバープロセス内に保持する。
- ブラウザの切断は shell を終了しない。サーバーの停止・再起動は shell を終了する。
- 接続失敗は1秒から最大30秒へ間隔を伸ばし、端末を閉じるまで再試行する。
- 端末の削除・終了・不存在は再試行対象ではない。
- WebSocket 圧縮を対応クライアントと交渉する。出力・入力の意味は変更しない。
- 端末問い合わせへの応答は主クライアントだけが送り、履歴再生中は送らない。
