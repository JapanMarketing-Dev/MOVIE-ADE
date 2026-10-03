# MOVIE-ADE

[English](README.md) | 日本語

Web画面を操作しながら、変更したい場所を囲む・話す・書く。録画を止めると、画像・原文・URLを添えた指摘をプロジェクト内へ保存し、Codex / Claude Codeへ渡せるデスクトップアプリです。

- **できること**: 内蔵ブラウザで開いた画面の録画と書き込み、発話・テキストからの指摘づくり、指摘の編集・結合・削除、内蔵ターミナルで動く Agent（Codex / Claude Code）への送信
- **費用は各自持ち**: 開発者側のサーバーやAPIキーはありません。文字起こしは端末内（whisper.cpp、無料）、自分の OpenAI の API キー、自前の GPU などで動かす OpenAI 互換サーバーから選びます。Agent は各自が契約している CLI を使います
- **対応OS**: macOS（Apple Silicon / Intel）、Windows（x64 / arm64。Preview）、Linux（x64。Preview）。実際の操作を確かめているのは macOS（Apple Silicon）です。0.1.0 では、Windows のインストーラを Mac の上で作りました。Linux の AppImage / deb は x64 の Linux コンテナで作り、そこで単体テストが通ること、同梱のターミナルがシェルを開けることを確かめました。Intel Mac 版のターミナルは Rosetta で確かめました。Windows / Linux の上で人が操作した確認はまだです。配布物はまだ署名していません
- **ライセンス**: [MIT](LICENSE)。移植したコードと同梱する依存のライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にまとめます

不具合の報告や開発への参加は [CONTRIBUTING.md](CONTRIBUTING.md)、脆弱性の連絡は [SECURITY.md](SECURITY.md) を見てください。

## インストール・起動

配布物はまだ無いので、Node.js 22 と pnpm を使い、ソースから起動します。Linux では `pnpm install` のときにターミナル用のネイティブモジュール（node-pty）をビルドするので、先に `build-essential` と `python3` を入れてください。Windows は同梱のビルド済み node-pty を使うので、コンパイラは要りません。

```sh
git clone https://github.com/JapanMarketing-Dev/MOVIE-ADE.git
cd MOVIE-ADE
pnpm install
pnpm dev
```

アプリでプロジェクトフォルダとURLを開きます。録画→テキスト→画面をクリックして要望を入力→Enter→停止で、音声を使わずに最初の指摘を残せます。設定でマイクをOFFにできます。

録画中は対象画面を大きく表示します。ペンボタン、またはOption / Altを押している間だけ描画できます。録画の開始・停止は⌘⇧R、モード切替は⌘⇧M（Windows / Linux では Ctrl+Shift+R / Ctrl+Shift+M）。一時停止中は書き込みを止め、経過時間も進めません。

停止すると指摘一覧へ戻ります。画像の拡大・差し替え、録画の見返し、編集・送信対象の選択・確定・結合・削除・前の編集に戻す操作ができます。設定で停止後もフィードバックモードに留められます。

## 文字起こしとAgent

音声まわりのAIは、各自が自分のキーか自前のGPUで、自分のコストで使います。設定の「文字起こし」で接続先を選びます。

- **この端末（無料・既定）**: `whisper.cpp`のCLIとGGMLモデルを準備し、「端末内モデルを選ぶ」で指定します。モデルや音声認識精度は別途確認が必要です。
- **OpenAI（自分のAPIキー）**: 音声がOpenAIへ送られます。
- **OpenAI互換**: Base URL・モデル名・APIキー（省略可）を入れます。自宅のGPUで動かすfaster-whisper-server / speaches / whisper.cpp server / vLLM、Groqなどへ`/v1/audio/transcriptions`の形式で送ります。Base URLの末尾の`/v1`は有っても無くても構いません。
- **ほかの提供元（自分のAPIキー）**: Groq、Deepgram、ElevenLabs Scribe、Google Gemini、Mistral Voxtral、Azure OpenAI、OpenRouterは、Base URLとモデル名を埋めたプリセットから選べます。Base URL・モデル・タイムアウト・追加のヘッダーは変えられます。OpenAI互換でないAPI（Deepgram、ElevenLabs、Gemini、OpenRouterの音声入力）は、提供元ごとの小さなアダプタで送ります。

「接続を確認」で1秒の無音を送り、認証・URL・モデル名の誤りを確かめられます。APIキーはOSの鍵（macOS: キーチェーン / Windows: DPAPI / Linux: libsecret・KWallet）で暗号化し、設定とは別のファイルに保存します。暗号化できない環境（Linuxで鍵束が無い場合など）では保存せず、その起動中だけ保持します。開発起動では無視対象の`.env`の`OPENAI_API_KEY`も使えます（配布版は環境変数・`.env`のキーを読みません）。キーをソースへ書かないでください。キーが無いときに別のキーや接続先へ切り替えることはなく、端末内の文字起こしを案内します。開発者が運営する中継サーバーは無く、通信は利用者の端末から選んだ接続先へ直接行います。

1レビューの概算の費用上限は既定$1で、設定で変えられます（検証起動では$0.05）。料金の分からない互換サーバーでは$0.006/分で概算し、上限を「なし」にもできます。上限に達したら送信を止め、音声を保存します。APIエラーでも自動再送しません。

「指摘を整理」は、各自が契約しているCLI（Claude Code / Codex）を非対話モードで使います。音声・動画・画像を渡さず、文字と操作情報を整理します。編集前に実行します。整理できなくても原文と画像を使えます。APIキーへ自動で切り替えません。代わりに、自分のAPIキーでLLMを直接呼ぶこともできます（Anthropic、OpenAI、Google Gemini、OpenRouter、OpenAI互換のエンドポイント）。設定の「指摘の整理」でモデル名を自由に入れ、「整理」ボタンの横で選びます。対応する提供元ではJSON Schemaで出力を縛り、どの提供元でも返ったJSONを検証します。キーは提供元ごとに保存し、文字起こしと整理で共有します。どれも利用者の端末から自分のキーで直接送り、中継サーバーはありません。配布版は環境変数のキーを読みません。

内蔵ターミナルでAgentを起動して「Agentへ送信」を押すと、保存先を読む指示を入力・実行します。権限確認中・送り先不明のときは止めます。外部のAgentには「Agent向けにコピー」で同じ指示を渡します。動画は指示に含めません。

## 保存

`<project>/.ade-movie/reviews/<日時>/`に`feedback.md`、画像、`session.json`、操作ログ、録画を保存します。Gitのローカル除外設定へ追加します。途中の記録が残っていれば履歴から復元でき、欠落の可能性を表示します。

完成したレビューの作業用画像・音声・動画は、設定した期間（既定7日）を過ぎた起動時に削除します。出力した指摘・画像は残します。未完成レビューは削除しません。

## 外部との通信

外部と通信するのは次の場合だけです。

- 自分のAPIキーでの文字起こし・「指摘を整理」（選んだ提供元・接続先）
- Whisperモデルのダウンロード（Hugging Face）
- フッターの利用量の表示（各提供元のAPI。自分のClaude / Codexのログインを使う）
- 「GitHubへ送信」（自分の`gh` CLI経由）
- 「更新を確認」を押したときだけ（Cloudflare R2の配布サーバー）
- **クラッシュレポート（Sentry）**: 配布版が、クラッシュと未処理のエラーを送ります。既定はONで、設定の「プライバシー」か初回起動時の案内からOFFにできます。送るのはスタックトレースとOS・CPU・アプリの版です。パス、URL、ターミナルの出力、文字起こし、指摘、メールアドレス、APIキー、IPアドレスは除くか集めません。開発起動とE2Eでは送りません。フォークした人は`MOVIE_ADE_SENTRY_DSN`で自分のDSNに向けるか、空にして止められます。詳しくは[Data and privacy](https://movie-ade.pages.dev/docs/privacy.html#crash-reports)。

## 開発・検証

```sh
pnpm typecheck
pnpm test:unit
pnpm build:mac:dev    # dist/dev/mac-arm64/MOVIE-ADE Dev.app
pnpm build:win:dev    # dist/dev/win-unpacked/MOVIE-ADE-Dev.exe
pnpm build:linux:dev  # dist/dev/linux-unpacked/movie-ade-dev（Linux の上でだけ作れる）
pnpm lp:dev
```

`build:*:dev` は、署名なし・展開済みの dev アプリを作ります（確認用）。設定は`electron-builder.dev.cjs`で、本番版と混ざらないよう識別子を分けています。本番の配布用の設定は`electron-builder.config.cjs`です。Windows 版は Mac でも作れます。Linux 版は、node-pty のビルド済みバイナリが Linux 用には無いため、Linux（またはコンテナ）の上で作ります。LPは`http://127.0.0.1:4173/`です。アプリに`.env`は含めません。製品名は MOVIE-ADE ですが、利用者のデータはこれまでどおり `ade-movie` フォルダに置きます。

### 配布

インストーラはまだ署名していません。置き場所は Cloudflare R2（バケット `movie-ade-releases`）で、GitHub には置きません。`pnpm dist:mac` / `pnpm dist:win` / `pnpm dist:linux`（Linux の上で）で `MOVIE-ADE-<version>-<os>-<arch>.<ext>` を作ります。Mac での手順は `pnpm release:build`（型検査と単体テストのあと、6本を `dist/release` に作る。Linux は x64 の podman / docker コンテナで作る）→ `pnpm release:r2 stage --preview win,linux` → 確認 → `pnpm release:r2 promote --version <version>` です。公開は2段階です。まず `node scripts/release-r2.mjs stage --dir dist/release --preview win,linux` で、公開前の置き場 `staging/<version>/` に上げます。ここでは索引を変えないので、サイトにも更新確認にも出ません。確認が済んだら `node scripts/release-r2.mjs promote --version <version>` で `releases/<version>/` へ移し、`versions.json`・`latest.json` を更新します。同じ版は上げ直しません。最新10版を超えた古い版は、表示してから消します。`v*` のタグを push すると、`.github/workflows/release.yml` が staging までを行い、ファイルを添付しないリリースノートの下書きを作ります。公開は、同じワークフローを Actions の画面から手動で起動して行います。必要な secrets（`CLOUDFLARE_API_TOKEN`：Account → Workers R2 Storage → Edit だけを許可したカスタムトークン、`CLOUDFLARE_ACCOUNT_ID`、`SENTRY_AUTH_TOKEN`：ソースマップを Sentry へ上げる組織トークン）の作り方は英語の README を見てください。`SENTRY_AUTH_TOKEN` を GitHub の secrets に登録すると、CI でソースマップが上がります（未登録の間は警告だけで続けます。登録したら `release.yml` の env に `SENTRY_SOURCEMAPS: required` を戻せます）。手元では、ログイン済みの `sentry` CLI でソースマップを上げます。公開リポジトリなので標準のランナーは無料で、`cross-platform.yml` は push / PR のたびに3つのOSで動きます（macOS は1ジョブ）。非公開に戻すときは、実行時間（とくに macOS）の費用が持ち主にかかるので、手動だけにしてください。

要件・設計は[docs/02_requirements.md](docs/02_requirements.md)、[docs/03_design.md](docs/03_design.md)。main はリリース用です。develop で開発し、PR は develop へ出してください。

## ダウンロードサイトの公開

`site/` はビルド不要の静的サイトで、Cloudflare Pages（https://movie-ade.pages.dev）で公開します。ヘッダーは `site/_headers`、短縮 URL は `site/_redirects`、404 は `site/404.html` です。`pnpm lp:dev` で `http://127.0.0.1:4173/` に表示します。公開は `pnpm site:deploy`（Pages のプロジェクト movie-ade へ `site/` を上げる。`wrangler login` が必要）か、ダッシュボードで movie-ade を GitHub に接続し、ビルドコマンドは空、出力は `site` にします。配布ファイルは Cloudflare R2 に置き、サイトは `site/js/config.js` の `DOWNLOAD_BASE` から `versions.json`・`latest.json`・`releases/<version>/manifest.json` を読みます。
