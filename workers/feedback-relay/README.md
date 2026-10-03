# feedback-relay

Ferret のアプリから匿名で送られたフィードバックを、公開リポジトリ `JapanMarketing-Dev/ferret` の GitHub Issue にする小さな中継です（Cloudflare Worker）。アプリは main プロセスから送ります。ブラウザからの送信は受け付けません。

- `POST https://feedback.ferretade.dev/v1/issues` に multipart/form-data で送ると Issue を作ります。ラベルは `bug` か `enhancement` と、`from-app` です。
- `GET https://feedback.ferretade.dev/v1/media/<id>.png|jpg` で、Issue に貼った静止画を返します。画像は非公開の R2 バケット `ferret-feedback-media` に置きます。

仕様（フィールド・上限・code）の正本は、アプリと共有する `src/shared/feedbackRelay.ts` です（github-integration と合わせたもの）。`src/limits.ts` はそれを re-export し、中継だけの値（頻度の上限など）を足しています。テストは `test/unit/feedback-relay.test.ts` と `test/unit/feedback-relay-policy.test.ts` です。本物の GitHub と Cloudflare は呼びません。

## 受け付けるもの

| フィールド | 中身 |
| --- | --- |
| `kind` | `bug` か `enhancement` |
| `title` | 1〜200字、改行なし |
| `body` | 1〜20KB（UTF-8） |
| `appVersion` | 必須。例 `0.2.0` |
| `platform` | 任意。`darwin` / `win32` / `linux` |
| `arch` | 任意。`x64` / `arm64` |
| `osRelease` | 任意。例 `25.6.0` |
| `installId` | 任意。インストールごとの乱数の UUID v4（アプリの telemetry-install-id）。頻度の上限にだけ使い、Issue には書きません。無ければ IP だけで数えます |

マルチパートの各パートは UTF-8 です（題名と本文に日本語が入ります）。利用者が環境情報を外したときは platform・arch・osRelease が送られず、Issue の OS は `not shared` になります。
| `image` | 0〜3個。各 2MB まで、PNG か JPEG（中身で判定します） |

リクエスト全体は 8MB までです。これ以外のフィールドが1つでもあれば `unknown_field` で断ります。

## 守り

- Origin の付いた送信（ブラウザ）は `origin_not_allowed`（403）で断ります。CORS のヘッダーは出しません。
- 本文と題名の、鍵やトークンの形・メール・ホームのパスを伏せ字にします（`src/redact.ts`）。`@メンション` と `#123` は、通知や参照が起きないように崩します。
- 画像は中身の先頭のバイトと構造で PNG / JPEG を確かめます。JPEG の EXIF・XMP・コメント、PNG のテキストのチャンク・eXIf・tIME を取り除き、末尾に付け足されたものも捨てます。名前は推測できない乱数（128 bit）にし、名前から決めた Content-Type に `nosniff` と sandbox の CSP を付けて返します。
- 頻度の上限は、IP ごと・インストール ID ごと（送られたとき）に1時間5件・1日20件、全体で1日200件です。同じ題名と本文は、送り主が違っても24時間弾きます（Durable Object の `FeedbackLimiter`）。
- 上限の確かめ方の決まり（security-3 [3][4][7]。`test/unit/security-3.test.ts` で固定しています）:
  - 本文を読む・multipart を解く・画像を確かめるより前に、IP だけで決められる上限を確かめます。IP ごとの試みの数（形の悪いもの・断ったものも数える。1時間30回・1日100回、`ATTEMPT_LIMITS`）と、IP の送信の枠です。
  - 送信の枠は狭い順（IP → インストール ID → 全体）に1つずつ `hit` で予約し、断られたらそこで止めて、先に取った予約を `release` で戻します。断られた要求は全体の枠を減らしません。
  - 同じ内容の鍵は、画像の保存と Issue の作成の前に `hit`（確かめると数えるを1回で）で取ります。同時に来た同じ内容は1件だけが進みます。Issue を作れなければ `release` で戻します。
  - 新しい公開の入口を足すときも、相手が決められる大きさの読み込み・解析より前に上限を確かめ、外から見える副作用の前に `hit` で取ってください。
- IP は保存しません。数えるときは、IP とインストール ID を秘密の鍵（`RATE_LIMIT_SALT`）の HMAC-SHA256 にしてから使います。記録するのは時刻だけで、24時間で消します。Workers Logs の invocation logs（要求の URL やヘッダーを含みうるもの）は切ってあります。ログに出すのはエラーの種類だけです。
- 失敗のときは `{"ok":false,"code":"…"}` だけを返します。code の一覧は `src/limits.ts` の `ERROR_STATUS` にあります。
- GitHub のトークンは Worker の secret にだけ入れます。コード・設定・ログには出しません。

## 公開の手順（リポジトリの持ち主が行う）

wrangler は、リポジトリの devDependencies で版を固定したものを使います（`node scripts/release-tools.mjs wrangler …`）。先に `pnpm install` を済ませ、`node scripts/release-tools.mjs wrangler login` で、`ferretade.dev` のゾーンがある Cloudflare のアカウントにログインしておきます。

### 1. GitHub: ラベルとトークン

1. ラベル `from-app` を作ります（`bug` と `enhancement` は GitHub の既定のラベルです。無ければ同じように作ります）。

   ```sh
   gh label create from-app --repo JapanMarketing-Dev/ferret --color 0E8A16 --description "Sent anonymously from the in-app feedback form"
   ```

2. fine-grained の personal access token を作ります。GitHub の Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token を開きます。
   - Token name: `ferret-feedback-relay`
   - Resource owner: `JapanMarketing-Dev`（組織が fine-grained token を承認制にしているときは、組織の管理者の承認が要ります）
   - Expiration: 長くても1年。期限の前に作り直して、手順3で入れ直します
   - Repository access: Only select repositories → `ferret`
   - Permissions → Repository permissions → **Issues: Read and write** だけ（Metadata: Read-only は自動で付きます）。ほかは付けません
   - トークンの持ち主は、`ferret` に書き込める人にしてください。書き込めない人のトークンだと、GitHub はラベルを黙って付けません

   作ったトークンは画面に一度だけ出ます。次の手順で貼り付けたら、どこにも保存しないでください。

### 2. Cloudflare: 画像の置き場

```sh
node scripts/release-tools.mjs wrangler r2 bucket create ferret-feedback-media
```

公開アクセス（r2.dev・独自ドメイン）は付けません。画像は Worker が `/v1/media/` から返します。配布物のバケット `movie-ade-releases` とは別にします。

### 3. 公開と秘密の登録

```sh
# 1回目の公開。Durable Object の作成と feedback.ferretade.dev の割り当て（DNS のレコードと証明書）も、この設定から行われます
node scripts/release-tools.mjs wrangler deploy --config workers/feedback-relay/wrangler.jsonc

# GitHub のトークン。聞かれたら貼り付けます（コマンドの引数にしないので、シェルの履歴に残りません）
node scripts/release-tools.mjs wrangler secret put GITHUB_TOKEN --config workers/feedback-relay/wrangler.jsonc

# 頻度の上限の HMAC の鍵。乱数をそのまま渡し、画面には出しません
openssl rand -hex 32 | node scripts/release-tools.mjs wrangler secret put RATE_LIMIT_SALT --config workers/feedback-relay/wrangler.jsonc
```

- `feedback.ferretade.dev` は、`wrangler.jsonc` の `routes`（`custom_domain: true`）で割り当てます。`ferretade.dev` のゾーンが同じ Cloudflare のアカウントにあることが前提です。すでに同じ名前の DNS レコードがあると公開に失敗するので、そのときはレコードを消してから公開し直します。
- `*.workers.dev` では受けません（`workers_dev: false`）。
- 公開の前に中身だけ確かめるときは、`--dry-run --outdir <フォルダ>` を付けます（アップロードしません）。

### 4. 確かめる

```sh
# ブラウザからの送信は断られる（403 origin_not_allowed）
curl -s -X POST https://feedback.ferretade.dev/v1/issues -H 'Origin: https://example.com' -F kind=bug
# 知らないパスは 404 not_found
curl -s https://feedback.ferretade.dev/
```

本物の Issue を作って確かめるときは、アプリから1件送り、できた Issue を確かめてから閉じます（公開の Issue になります）。

### 運用

- トークンを作り直したとき・漏れたかもしれないとき: GitHub でトークンを取り消し（Revoke）、新しいトークンを `wrangler secret put GITHUB_TOKEN` で入れ直します。
- 中継を止めるとき: Cloudflare のダッシュボードで Worker の `feedback.ferretade.dev` の割り当てを外すか、`node scripts/release-tools.mjs wrangler delete --config workers/feedback-relay/wrangler.jsonc` で消します。アプリは送信に失敗したことを表示します。
- 載せてはいけないものが Issue に載ったとき: Issue を編集・削除し、画像は `node scripts/release-tools.mjs wrangler r2 object delete ferret-feedback-media/v1/<id>.<ext> --remote` で消します。
- 上限を変えるとき: `src/limits.ts` を直し、アプリの側（github-integration）にも知らせ、テストを直してから公開します。
- 費用: Workers・Durable Objects（SQLite）・R2 は、どれも無料の枠の中で動く量を想定しています（全体で1日200件まで）。
