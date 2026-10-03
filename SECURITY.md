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

The installers are not code-signed by Microsoft yet, and the download server (Cloudflare R2) holds both the installers and their manifest. So every release also has `SHA256SUMS` and `SHA256SUMS.sig`, signed with the Ferret release key. The key is kept apart from the download server: only the release workflow job that has no R2 credentials (and the maintainer's machine) can sign, and publishing stops if the signature is missing or does not match. Ferret's update check verifies the signature with the key built into the app before it offers a new version.

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

These come from security reviews. `test/unit/security-3.test.ts` (and the tests it points to) fail when one is broken.

- **Agent trust.** Registering or cloning a project is not a decision to trust it. Agents start in their normal mode, with permission prompts, approvals and sandbox on. Ferret writes Claude Code / Codex folder trust and adds skip-permission flags only for a project the user turned on in Settings → Agent → Skip permission prompts after a confirmation that shows the path, and never for agents started automatically when a project opens. The main process decides this (`resolveAgentLaunchPolicy`), not renderer defaults.
- **Release authenticity.** Anything users download must be checkable against a key that is not stored with the download. A release without a valid signature is not promoted and not offered by the update check.
- **Project-driven network requests.** Opening or previewing project files must not make network requests the user did not choose. Remote images in Markdown previews stay blocked until the user clicks "Load remote images" for that page.
- **Public endpoints.** On the anonymous feedback relay, rate limits are checked before reading or parsing attacker-sized input, narrower limits are checked before shared ones (a denied request never uses up the global limit), and idempotency keys are claimed in one atomic step before any visible side effect.
- **Crash reports.** Every kind of data listed above as removed has a scrub sample in the tests, including IPv4 and IPv6 addresses.

