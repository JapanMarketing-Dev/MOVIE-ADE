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
