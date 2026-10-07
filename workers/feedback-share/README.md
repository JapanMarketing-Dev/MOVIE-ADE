# feedback-share

ログイン無しで誰でも Web の指摘を送れる「共有リンク」の Worker です（Cloudflare Worker）。Ferret の内蔵ブラウザで撮ったページの静止画にリンク（`https://share.ferretade.dev/s/<id>`）を付け、受け取った人は注釈（ピン・枠・ペン）と文を送れます。名前は任意です。持ち主は Ferret から届いた指摘を見て、取り込む・断るを選びます。取り込んだものは「文字で指摘」と同じ指摘になり、Agent へ渡して BEFORE / AFTER を人が確かめる流れに乗ります。

仕様（形・大きさ・code）の正本は、アプリと共有する `src/shared/feedbackShare.ts` です。頻度の上限とパスは `src/limits.ts` にあります。テストは `test/unit/feedback-share.test.ts`（Worker）と `test/unit/feedback-share-app.test.ts`（アプリ側）です。本物の Cloudflare は呼びません。

## API

| 誰が | メソッドとパス | 中身 |
| --- | --- | --- |
| 持ち主 | `POST /v1/shares` | JSON `{ title, showOthers, days?, installId? }` → `{ id, ownerToken, url, expiresAt }` |
| 持ち主 | `POST /v1/shares/<id>/pages` | multipart: `meta`（`{ url, title, viewport, width, height }`）と `image`（PNG / JPEG、4MB まで） |
| 持ち主 | `GET /v1/shares/<id>` | 中身と指摘の一覧（断ったものも） |
| 持ち主 | `POST /v1/shares/<id>/comments/<cid>` | JSON `{ status: "new" \| "imported" \| "rejected" }` |
| 持ち主 | `DELETE /v1/shares/<id>/comments/<cid>` | 指摘を消す |
| 持ち主 | `DELETE /v1/shares/<id>` | 共有を消す（静止画も） |
| 相手 | `GET /s/<id>` | 注釈の画面（静的な HTML。`/assets/share.js`・`/assets/share.css`） |
| 相手 | `GET /v1/public/<id>` | 題名・ページ・（`showOthers` のとき）ほかの人の指摘。断ったものは出さない |
| 相手 | `GET /v1/public/<id>/pages/<pid>.<ext>` | ページの静止画 |
| 相手 | `POST /v1/public/<id>/comments` | JSON `{ pageId, text, name?, shape?, live?, viewWidth? }`。Origin が `PUBLIC_BASE` のときだけ |

持ち主の操作は `Authorization: Bearer <ownerToken>` で送ります。Origin の付いた持ち主の要求（ブラウザから）は断ります。

## 守り

- `shareId` は 128 bit、`ownerToken` は 256 bit の乱数です。部屋（Durable Object `ShareRoom`、共有1つに1つ）にはトークンの SHA-256 だけを置き、定時間で比べます。トークンは URL のクエリに載せません。
- 相手の画面は CSP（`script-src 'self'`、外の CDN なし、`frame-ancestors 'none'`）、`noindex`、`Referrer-Policy: no-referrer` で配ります。ライブで元のページを開く iframe の先へ、共有の URL を漏らしません。文字はすべて JS の `textContent` で出します。
- 相手の送信は項目の許可リスト・大きさ（本文 2000 字、名前 50 字、ペンの点 200 個、要求 32KB）を確かめ、IP（HMAC。IPv6 は /64）→ 共有 → 全体の順に頻度の枠を予約します。断られたら先に取った予約を戻します（`feedback-relay` と同じ決まり）。1つの共有で受ける指摘は 500 件までです。人に見えない欄（honeypot）に何か入っていれば、保存せずに成功のふりをします。
- 静止画は中身で PNG / JPEG を確かめ、EXIF などを取り除きます（`feedback-relay` の `images.ts`）。
- 期限（既定 30 日、最長 90 日）で部屋の alarm が静止画と記録を消します。持ち主が共有を消したときも同じです。
- 失敗は短い code だけを返します。IP・本文・トークンはログに出さず、IP は保存しません。

## 公開の手順

1. R2 のバケットを作る（公開しないバケット）: `node scripts/release-tools.mjs wrangler r2 bucket create ferret-share-media`
2. 頻度の上限の HMAC の秘密を入れる: `node scripts/release-tools.mjs wrangler secret put RATE_LIMIT_SALT --config workers/feedback-share/wrangler.jsonc`（十分に長い乱数。`feedback-relay` とは別の値）
3. デプロイ: `node scripts/release-tools.mjs wrangler deploy --config workers/feedback-share/wrangler.jsonc`（`share.ferretade.dev` の custom domain も作られます）
4. 確かめる: `https://share.ferretade.dev/s/<32桁の16進>` が「見つかりません」の画面を返し、`POST /v1/shares` に Origin を付けると 403 になること
