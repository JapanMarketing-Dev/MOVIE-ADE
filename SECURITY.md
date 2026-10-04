# Security

## Reporting a vulnerability

Please do not report vulnerabilities in public issues. Use GitHub [private vulnerability reporting](https://github.com/JapanMarketing-Dev/MOVIE-ADE/security/advisories/new) instead ("Report a vulnerability" on the Security tab of this repository).

Include steps to reproduce, affected versions and the expected impact. We will reply as soon as we can. Please keep the details private until a fix is released.

## Supported versions

The latest release and the `develop` branch.

## How MOVIE-ADE handles sensitive data

- Transcription API keys are encrypted with the OS keystore and stored on your machine (or kept only for the current session where encryption is not available). They are never sent to the developers.
- Recordings, images and findings are saved in `.ade-movie/` inside the project you open.
- MOVIE-ADE talks to external services only for features you choose: audio for transcription when you pick OpenAI or a compatible server, agent usage display (queries each provider's API with your own Claude / Codex login), sending to GitHub (through your own `gh` CLI), update checks (GitHub Releases), and Whisper model downloads (Hugging Face).
- Crash reports: the app sends crashes and unhandled errors to Sentry (on by default; turn off in Settings → Privacy). Reports contain the stack trace and OS / CPU / app versions. Home and project paths, URLs, terminal output, transcripts, findings, email addresses, API keys and IP addresses are removed or not collected. Development builds (`pnpm dev`) also send, tagged `development`; E2E runs and unit tests never send. Forks can point `FERRET_SENTRY_DSN` (old name `MOVIE_ADE_SENTRY_DSN` still works) at their own Sentry or set it empty. Details: `site/docs/privacy.html#crash-reports`.

## Release authenticity

The installers are not code-signed by Microsoft yet, and the download server (Cloudflare R2) holds both the installers and their manifest. So every release also has `SHA256SUMS` and `SHA256SUMS.sig`, signed with the Ferret release key. The key is kept apart from the download server: only the release workflow job that has no R2 credentials (and the maintainer's machine) can sign, and publishing stops if the signature is missing or does not match. Ferret's update check verifies the signature with the key built into the app before it offers a new version, then downloads the installer itself and keeps it only if its SHA-256 matches the signed `SHA256SUMS`. The download page does the same check in your browser with the same key before it saves a file.

Public key (also in `build/release-signing/allowed_signers`; fingerprint `SHA256:c7dvwwJQyY9qSstkmrO8JoVZ90DCaFZBAzjqV04N8zQ`):

```
release@ferretade.dev ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEpXERU8ST0MEOIMbzoL4zShkjIrMB4++NL3xBohKAS9
```

Verify a download:

```
ssh-keygen -Y verify -f allowed_signers -I release@ferretade.dev -n ferret-release -s SHA256SUMS.sig < SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
```

## Rules we keep (each one is pinned by a unit test)

These come from security reviews. `test/unit/security-3.test.ts`, `test/unit/security-4.test.ts` (and the tests they point to) fail when one is broken.

- **Agent permissions.** By default Ferret starts Claude Code with `--dangerously-skip-permissions` and Codex with `--dangerously-bypass-approvals-and-sandbox`, in every project and for agents started automatically or by hand, and marks registered project folders as trusted for both. This is the user's chosen default. The user can turn it off in Settings → Agents → Skip permission prompts; agents then start in their normal mode and ask before trusting a folder. Launch arguments the user types are used as written. While it is on, an agent working in a cloned repository can follow that repository's instructions (agent instruction files, hooks, settings) and edit files or run commands without asking. The main process decides this (`resolveAgentLaunchPolicy`), not renderer defaults.
- **Release authenticity.** Anything users download must be checkable against a key that is not stored with the download. A release without a valid signature is not promoted and not offered by the update check.
- **Project-driven network requests.** Opening or previewing project files must not make network requests the user did not choose. Remote images in Markdown previews stay blocked until the user clicks "Load remote images" for that page.
- **Public endpoints.** On the anonymous feedback relay, rate limits are checked before reading or parsing attacker-sized input, narrower limits are checked before shared ones (a denied request never uses up the global limit), and idempotency keys are claimed in one atomic step before any visible side effect.
- **Crash reports.** Every kind of data listed above as removed has a scrub sample in the tests, including IPv4 and IPv6 addresses.
- **Executables come from trusted places.** Built-in agents and account logins start from an absolute path found on absolute `PATH` entries outside the project, never from the project folder; on Windows every terminal also tells `cmd.exe` not to search the current folder. Logins run from the home folder, not the project.
- **Release identity comes from the signature.** Version, platform and download path are read from the names in the signed `SHA256SUMS` of that version, and the manifest must list exactly the signed files. What the user saves is the file whose bytes were checked against that signature: the app downloads and checks the installer itself, and the download page checks it in the browser. No page or app hands out an unchecked installer link.
- **Automatic updates install only signed bytes.** The background update downloads only the file named for this computer in the signed `SHA256SUMS` of that version (the macOS `.zip` in the separately signed `UPDATE-SHA256SUMS`), only from the download server, and installs it only if its size and SHA-256 match; the hash is checked again right before it is handed to the installer. The app does not read electron-updater's `latest*.yml`. Development builds and E2E runs never install (`test/unit/auto-update.test.ts`, `e2e/auto-update.spec.ts`).
- **Check the file you opened.** Project reads and writes check the opened file handle against the project's real path after opening, and never truncate before that check. Paths that were checked and then reopened are not trusted.
- **Consent is never URL state.** Loading remote images in a preview needs a one-time, unguessable grant that the main process issues to the page's own button for that document. Links, typed URLs and restored sessions cannot create it, and saved project URLs never keep it.
- **Automatic work is bounded in total.** Anything that runs when a project opens (directory listings, review history) has a count, byte and time budget, not only a per-item limit.
- **Public endpoints, continued.** The feedback relay groups source addresses (IPv6 by /64) and checks a shared budget before creating any per-source state or reading a body. The global issue quota is taken last, just before the GitHub call, and released on every rejection. User text is posted as a literal block, so it cannot create GitHub references or mentions. A GitHub call whose outcome is unknown keeps its idempotency claim and media and is not retried or sent another way.

