# feedback-share

ログイン無しで誰でも Web の指摘を送れる「共有リンク」の Worker です（Cloudflare Worker）。Ferret で見てほしいページの URL を選ぶとリンク（`https://share.ferretade.dev/s/<id>`）ができます。受け取った人は元のページをライブで開いて触りながら、Ferret と同じ道具（ペン・枠・文字で指摘・声）で録画して送れます。画面共有や、スマホの画面収録の動画も送れます。名前は任意です。同じリンクを開いた人は誰でも届いた指摘を見られます。持ち主は Ferret から届いた録画を取り込む・断るを選びます。取り込んだものは mtg の取り込みと同じ流れ（文字起こし・コマ・書き込み → 指摘の整理）で、送った人の名前付きの指摘の候補になります。

共有にはメモとパスワードを付けられます。パスワードはサーバーへ届きません（相手のブラウザが PBKDF2 で作った証明の SHA-256 だけを比べます）。パスワードのある共有のメモは、アプリが暗号化して暗号文だけを置き、相手の画面が手元で復号します（`src/shared/shareCrypto.ts`）。

仕様（形・大きさ・code）の正本は、アプリと共有する `src/shared/feedbackShare.ts` です。頻度の上限とパスは `src/limits.ts`、相手の画面は `client/`（`node scripts/build-share-page.mjs` で `src/generated.ts` にまとめる）にあります。テストは `test/unit/feedback-share.test.ts`（Worker）・`test/unit/feedback-share-app.test.ts`（アプリ側）・`test/unit/share-page-build.test.ts`（まとめ忘れ）です。本物の Cloudflare は呼びません。

## API

API の一覧と守りの決まりは `src/index.ts` の先頭にあります。持ち主の操作は `Authorization: Bearer <ownerToken>` で送り、Origin の付いた持ち主の要求（ブラウザから）は断ります。

## 守り（要点）

- `shareId` は 128 bit、`ownerToken` は 256 bit の乱数です。部屋（Durable Object `ShareRoom`、共有1つに1つ）にはトークンの SHA-256 だけを置きます。トークンは URL のクエリに載せません。
- 相手の画面は厳しい CSP（自分のスクリプトだけ、外の CDN なし）、`noindex`、`Referrer-Policy: no-referrer` で配ります。文字は JS の `textContent` で出します。
- 録画は宣言した大きさで枠を予約し（1本 300MB、共有の合計 3GB）、R2 の multipart で順に受け、最初の回の先頭のバイトで形式を確かめます。頻度の上限は狭い順に予約し、断られたら先に取った予約を戻します（`feedback-relay` と同じ決まり）。
- 期限は 7 日です。部屋の alarm が録画と記録を消し、R2 のライフサイクル（8 日）でも消えます。持ち主が共有を消したときも同じです。
- 失敗は短い code だけを返します。IP・本文・トークン・メモはログに出さず、IP は保存しません。

## 公開の手順

1. R2 のバケットを作る（公開しないバケット）: `node scripts/release-tools.mjs wrangler r2 bucket create ferret-share-media`
   取り残しを消すライフサイクル（8 日）: `node scripts/release-tools.mjs wrangler r2 bucket lifecycle add ferret-share-media expire-8d --expire-days 8`
2. 頻度の上限の HMAC の秘密を入れる: `node scripts/release-tools.mjs wrangler secret put RATE_LIMIT_SALT --config workers/feedback-share/wrangler.jsonc`（十分に長い乱数。`feedback-relay` とは別の値）
3. デプロイ: `node scripts/release-tools.mjs wrangler deploy --config workers/feedback-share/wrangler.jsonc`（`share.ferretade.dev` の custom domain も作られます）
4. 確かめる: `https://share.ferretade.dev/s/<32桁の16進>` が画面を返し（中身は「見つかりません」）、`POST /v1/shares` に Origin を付けると 403 になること
5. 相手の画面（`client/`）やアプリの部品を変えたら、デプロイの前に `node scripts/build-share-page.mjs` で作り直す
