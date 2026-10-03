# MOVIE-ADE

English | [日本語](README.ja.md)

MOVIE-ADE is a desktop app for giving UI feedback to coding agents. While you use a web page, you circle the spot, talk, or type. When you stop recording, MOVIE-ADE saves each finding with a screenshot, your original words and the URL into your project, and hands it to Codex or Claude Code.

- **What it does**: records and annotates a page opened in the built-in browser, turns speech and typed notes into findings, lets you edit, merge and delete findings, and sends them to an agent (Codex / Claude Code) running in the built-in terminal.
- **You bring your own resources**: there is no server or API key on the developer's side. Transcription runs on your machine (whisper.cpp, free), with your own OpenAI API key, or on an OpenAI-compatible server you host (for example on your own GPU). Agents run through the CLI subscriptions you already have.
- **Platforms**: macOS (Apple Silicon / Intel), Windows (x64 / arm64, preview) and Linux (x64, preview). Day-to-day use is verified on macOS (Apple Silicon). For 0.1.0, the Windows installers were built on a Mac, and the Linux AppImage / deb were built in an x64 Linux container where the unit tests pass and the bundled terminal opens a shell; the Intel macOS build's terminal was checked under Rosetta. Nobody has used the apps by hand on Windows or Linux yet. Builds are not code-signed yet.
- **License**: [MIT](LICENSE). Ported code and bundled dependencies are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

To report bugs or contribute, see [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Install and run

There are no prebuilt packages yet, so run it from source with Node.js 22 and pnpm. On Linux, `pnpm install` compiles the terminal's native module (node-pty), so install `build-essential` and `python3` first. On Windows, the bundled prebuilt node-pty is used and no compiler is needed.

```sh
git clone https://github.com/JapanMarketing-Dev/MOVIE-ADE.git
cd MOVIE-ADE
pnpm install
pnpm dev
```

Open a project folder and a URL in the app. To leave your first finding without using your voice: start recording, switch to text, click the page, type your request, press Enter, and stop. You can turn the microphone off in Settings.

While recording, the target page is shown large. You can draw while the pen button is on, or while holding Option / Alt. Start or stop recording with ⌘⇧R, and switch modes with ⌘⇧M (Ctrl+Shift+R / Ctrl+Shift+M on Windows and Linux). Pausing stops both drawing and the timer.

When you stop, you return to the list of findings. You can enlarge or replace images, replay the recording, edit findings, choose which ones to send, confirm, merge, delete, and undo edits.

## Transcription and agents

Speech-to-text runs on your own key or your own hardware, at your own cost. Choose the provider under Settings > Transcription.

- **This device (free, default)**: install the `whisper.cpp` CLI and a GGML model, then select the model in Settings.
- **OpenAI (your API key)**: audio is sent to OpenAI.
- **OpenAI-compatible**: enter a base URL, a model name and an optional API key. MOVIE-ADE sends audio in the `/v1/audio/transcriptions` format to servers such as faster-whisper-server, speaches, whisper.cpp server or vLLM on your own GPU, or to hosted services.
- **Other providers (your API key)**: Groq, Deepgram, ElevenLabs Scribe, Google Gemini, Mistral Voxtral, Azure OpenAI and OpenRouter come as presets with the base URL and model filled in. You can change the base URL, model, timeout and extra headers. Non-OpenAI-style APIs (Deepgram, ElevenLabs, Gemini, OpenRouter audio input) use small per-provider adapters.

"Test connection" sends one second of silence to check authentication, URL and model name. API keys are encrypted with the OS keystore (macOS Keychain / Windows DPAPI / Linux libsecret or KWallet) and stored separately from the settings. Where encryption is not available (for example Linux without a keyring), the key is kept only for the current session. In development you can also put `OPENAI_API_KEY` in the git-ignored `.env`. Never put keys in source code.

Each review has an estimated cost limit (default $1, configurable). For compatible servers with unknown pricing, MOVIE-ADE estimates $0.006 per minute; you can also set no limit. When the limit is reached, MOVIE-ADE stops sending and keeps the audio. It does not retry automatically on API errors.

"Organize findings" uses the CLI you subscribe to (Claude Code / Codex) in non-interactive mode. It receives only text and interaction data, never audio, video or images. If organizing fails, you can still use the original text and images. MOVIE-ADE never falls back to an API key on its own. You can instead call an LLM directly with your own API key (Anthropic, OpenAI, Google Gemini, OpenRouter, or any OpenAI-compatible endpoint): set it up under Settings > Organize findings, with any model name, then pick it next to the Organize button. The output is constrained by JSON Schema where the provider supports it and is always validated. Keys are stored per provider and shared between transcription and organizing. Everything is sent directly from your computer with your key; there is no relay server, and packaged builds never read keys from environment variables.

Start an agent in the built-in terminal and press "Send to Agent": MOVIE-ADE types and runs an instruction that points the agent to the saved findings. It holds off while the agent is waiting for a permission prompt or when the destination is unclear. For an external agent, "Copy for Agent" copies the same instruction. Videos are never included.

## Storage

MOVIE-ADE saves `feedback.md`, images, `session.json`, an interaction log and the recording under `<project>/.ade-movie/reviews/<timestamp>/`, and adds that folder to Git's local exclude list. If a review was interrupted, you can restore it from the history, and MOVIE-ADE tells you when something may be missing.

Working images, audio and video of completed reviews are deleted on startup after the retention period (default 7 days). Exported findings and their images are kept. Incomplete reviews are never deleted.

## What leaves your machine

MOVIE-ADE connects to outside services only for:

- transcription and "Organize" with your own API key (the provider or endpoint you choose)
- Whisper model downloads (Hugging Face)
- agent usage in the footer (each provider's API, with your own Claude / Codex login)
- "Send to GitHub" (through your own `gh` CLI)
- "Check for Updates", only when you click it (the download server on Cloudflare R2)
- **crash reports (Sentry)**: the app sends crashes and unhandled errors. It is on by default; turn it off in Settings → Privacy or from the notice at first launch. Reports contain the stack trace and OS / CPU / app versions. Paths, URLs, terminal output, transcripts, findings, email addresses, API keys and IP addresses are removed or not collected. Development builds (`pnpm dev`) also send, tagged `development`; E2E runs and unit tests never send. Forks can set `MOVIE_ADE_SENTRY_DSN` to their own DSN, or to an empty string to disable it. See [Data and privacy](https://movie-ade.pages.dev/docs/privacy.html#crash-reports).

## Development

```sh
pnpm typecheck
pnpm test:unit
pnpm build:mac:dev    # dist/dev/mac-arm64/MOVIE-ADE Dev.app
pnpm build:win:dev    # dist/dev/win-unpacked/MOVIE-ADE-Dev.exe
pnpm build:linux:dev  # dist/dev/linux-unpacked/movie-ade-dev (build on Linux only)
```

These build unsigned, unpacked dev apps for a quick check (`electron-builder.dev.cjs`, a separate app ID so they do not mix with release builds). Release settings are in `electron-builder.config.cjs`. Windows builds can also be made on a Mac. Linux builds must be made on Linux (or in a Linux container) because node-pty has no prebuilt Linux binary. The app never bundles `.env`. User data stays in the `ade-movie` folder even though the product is named MOVIE-ADE.

### Releases

Installers are not code-signed yet. They are hosted on Cloudflare R2 (bucket `movie-ade-releases`), not on GitHub.

```sh
pnpm dist:mac    # MOVIE-ADE-<version>-mac-arm64.dmg / -mac-x64.dmg
pnpm dist:win    # MOVIE-ADE-<version>-win-x64.exe / -win-arm64.exe (NSIS)
pnpm dist:linux  # MOVIE-ADE-<version>-linux-x86_64.AppImage / -linux-amd64.deb (on Linux)
node scripts/release-r2.mjs stage --dir dist/release --preview win,linux [--notes notes.md] [--dry-run]
node scripts/release-r2.mjs promote --version <version> [--dry-run]
```

On a Mac, the whole local release is `pnpm release:build` (type checks, unit tests, then all six installers into `dist/release`; Linux is built in an x64 podman or docker container) → `pnpm release:r2 stage --preview win,linux` → check → `pnpm release:r2 promote --version <version>`.

Publishing has two steps. `stage` uploads the files and `manifest.json` (file name, OS, CPU, size, sha256, date) to `staging/<version>/` without touching the indexes, so neither the site nor the app's update check sees them yet. After checking them, `promote` verifies each file's sha256, moves it to `releases/<version>/`, updates `versions.json` and `latest.json`, and removes the staging copy. Release files are cached for a year (they never change), manifests for an hour, the indexes for five minutes. Both steps refuse a version that is already released. Only the latest 10 versions are kept: `promote` prints and deletes older ones. Uploads use `npx wrangler@latest r2 object put --remote` (300 MiB per file), so log in with `npx wrangler login` first.

Pushing a `v*` tag that matches `package.json` runs `.github/workflows/release.yml`: it builds on macOS, Windows and Linux, stages the files on R2 and creates a draft GitHub release with notes only (no files). To publish, run the same workflow by hand from the Actions tab with the version (or run `promote` locally). It needs two repository secrets, plus an optional third:

1. `CLOUDFLARE_API_TOKEN`: in the Cloudflare dashboard, go to My Profile → API Tokens → Create Token → Create Custom Token. Grant **Account → Workers R2 Storage → Edit** for this account only, and set a short expiry if you can. Copy the token once.
2. `CLOUDFLARE_ACCOUNT_ID`: shown on the R2 overview page.
3. `SENTRY_AUTH_TOKEN`: uploads source maps so crash reports show readable stack traces (`scripts/sentry-sourcemaps.mjs`, run by `pnpm build:release`). In Sentry, go to Settings → Developer Settings → Organization Tokens → Create New Token (organization tokens can only upload source maps and manage releases). Until it is registered, the workflow only warns and skips the upload; once it is registered, you can add `SENTRY_SOURCEMAPS: required` to the build job's env in `release.yml` so a failed upload stops the release. Locally, a logged-in `sentry` CLI (`sentry auth login`) is used instead, and the step is skipped with a warning if neither is available. Override the target with `SENTRY_ORG` / `SENTRY_PROJECT` (default `workspacepm` / `movie-ade`).

Add them under GitHub → Settings → Secrets and variables → Actions. Optional repository variables: `PREVIEW_OS` (default `win,linux`) and `DOWNLOAD_URL` (the link in the release notes). The workflows run on free runners because the repository is public; in a private repository the minutes, especially on macOS, are billed to the owner. `.github/workflows/cross-platform.yml` runs type checks, unit tests and unpacked builds on all three OSes (one macOS job) on every push and pull request; switch it to manual-only if the repository ever becomes private.

Requirements and design documents (in Japanese) are in [docs/02_requirements.md](docs/02_requirements.md) and [docs/03_design.md](docs/03_design.md). `main` is for releases. Development happens on `develop`; open pull requests against `develop`.

## Download site

`site/` is a static site with no build step (no external CDN), published on Cloudflare Pages at https://movie-ade.pages.dev. `wrangler.jsonc` points Pages at `site/`; `site/_headers` sets security and cache headers, `site/_redirects` holds short aliases, and `site/404.html` is the not-found page. Preview it locally with `pnpm lp:dev` (`http://127.0.0.1:4173/`).

Release files are hosted on Cloudflare R2 (the 10 most recent versions), not in the repository. The site reads `versions.json`, `latest.json` and `releases/<version>/manifest.json` from the R2 URL set in `site/js/config.js` (`DOWNLOAD_BASE`, the only place to change for a custom domain). Until a release is published, the site shows build-from-source instructions.

To deploy, either run `pnpm site:deploy` (uploads `site/` to the Pages project `movie-ade`; requires `wrangler login`), or connect the Pages project `movie-ade` to `JapanMarketing-Dev/MOVIE-ADE` in the Cloudflare dashboard with an empty build command and `site` as the output directory. The site URL (`SITE_URL`) is also in `site/js/config.js`; after changing it, run `pnpm site:meta` to rewrite `og:image`, `og:url` and `canonical` in the HTML.
