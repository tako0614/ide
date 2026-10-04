# Deck IDE 設計仕様

## コンセプト

ブラウザで複数の shell を並べて操作する端末ツール。メイン UI は作業ディレクトリ・デッキ・端末の作成と配置に絞る。ファイル編集、Git 操作、Deck Drive、code-server の画面は提供しない。任意の CLI は通常の shell 内で起動する。任意の Computer パネルから専用 Linux デスクトップを操作できる。

## コア概念

| 概念 | 説明 |
|------|------|
| **ワークスペース** | shell の開始ディレクトリ。既存 API では workspace として保持する |
| **デッキ** | ワークスペースに紐づくターミナルのグループ。タブで切り替え、最大3つまで分割表示 |
| **ターミナルセッション** | private socket と安定 ID を持つ tmux shell。node-pty は表示クライアントを接続し、headless xterm の画面を再接続時に復元する |

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
│  HTTP (Hono + tmux display clients)                    │
│  ┌───┴───┐ ┌───┴───┐ ┌───┴───┐              │
│  │ view1 │ │ view2 │ │ view3 │              │
│  └───────┘ └───────┘ └───────┘              │
│  ┌──────────────────────────────┐            │
│  │  SQLite (node:sqlite)        │            │
│  │  ワークスペース・デッキ永続化       │            │
│  └──────────────────────────────┘            │
└──────────────────────────────────────────────┘
```

## ターミナルの所有と同期

shell は各端末専用の tmux server が所有する。HTTP は node-pty で表示クライアントを
接続し、headless xterm で出力を解析する。通常画面・代替画面、未完了の UTF-8／ANSI
列、live output offset を順番に同期する。リングバッファは同期中の出力差分用で
既定500KB、入力の再送や shell の再起動には使わない。

再接続時は `{ type: "sync", offsetBase, reset: true, cols, rows, epoch, snapshotBytes }`、
全画面スナップショット、未完了の parser tail、同期後の出力、`ready` の順に送る。
画面 capture と出力の間に欠落があれば capture をやり直す。画面同期の前に切断した
viewer を登録しない。端末問い合わせへの応答は headless xterm が一度だけ送る。

復元 registry は端末 UUID、deck、title、サイズ、native ID、PID、生成 ID、socket など
必要な lifecycle メタデータだけを owner-only で保存する。環境値と launch command は
保存・ログ出力しない。生成 ID、所有者、socket、native ID の不一致は拒否し、未知の
セッションを自動再作成・終了しない。同一ユーザー専用の broker は stdin と private
Unix socket で新規作成の環境を受け渡し、独立したサービス cgroup 内で tmux を起動する。

## 描画と明示的なサイズ変更

初期サイズは明示的に120列32行を選ぶ。tmux は `window-size manual` と明示的な
`resize-window` を使い、内部 client は `ignore-size` で attach する。小さな外部 client が
通常の attach をしても共有グリッドを縮小しない。API／MCP による明示的なサイズ変更は
整数1〜500に制限し、WebSocket では `explicit: true` が必要になる。

xterm.js 6 の標準 DOM renderer と DEC 2026 の同期描画を使う。フォントはローカルの
等幅フォントと日本語 fallback、既定14px、11〜22pxで変更できる。viewport と文字サイズ
の変更は既存 xterm と接続を維持したまま全フレームを同一倍率でローカル拡縮する。
共有 PTY サイズは変えない。文字サイズの保存、既存のヘッダー、順序、分割、手動配置
コントロールは維持する。追加の zoom／lock 操作は設けない。

外部 tmux attach、detach、固定サイズポリシー、更新と rollback の具体的な手順は
[terminal-tmux.md](docs/terminal-tmux.md) に定義する。

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

- workspace と deck は SQLite に保存する。shell は tmux、画面 snapshot は HTTP が保持する。
- ブラウザの切断と開発 HTTP プロセスの再起動は shell を終了しない。
- 本番 systemd の HTTP 停止をまたぐには独立 broker cgroup が必要。unit と updater は同梱するが、ここでは未適用・未実証。
- 旧方式の実行中端末を自動移行・終了しない。更新前に利用者が終了するまで旧 HTTP を維持する。
- 接続失敗は1秒から最大30秒へ間隔を伸ばし、端末を閉じるまで再試行する。
- 端末の削除・終了・不存在は再試行対象ではない。
- WebSocket 圧縮を対応クライアントと交渉する。出力・入力の意味は変更しない。
- 端末問い合わせへの応答は headless xterm が一度だけ送り、viewer の履歴再生では送らない。
