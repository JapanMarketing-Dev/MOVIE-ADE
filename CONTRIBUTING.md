# Contributing

Issues and pull requests are welcome. Japanese or English is fine.

## How to contribute

- Report bugs and ideas in Issues. Steps to reproduce, your OS and the MOVIE-ADE version (shown in the footer) help a lot.
- Before attaching recordings, screenshots or logs, check that they show no API keys, tokens, or personal or customer information.
- For large changes, open an issue first to discuss the approach.
- Open pull requests against `develop`. `develop` is the development branch; `main` holds releases only.

## Setup

```sh
pnpm install
pnpm dev
```

Before sending a pull request, make sure type checking and unit tests pass:

```sh
pnpm typecheck
pnpm test:unit
```

## Ground rules

- Never put API keys or tokens in source code or tests. Keep development keys in the git-ignored `.env`.
- Do not add features that need a server or API key provided by the developers. Anything that costs money must run on the user's own key, CLI subscription or GPU.
- When you port code from another project, check its license, note the source at the top of the file, and add it to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Do not port copyleft code such as GPL.
- Contributions are released under the same [MIT License](LICENSE) as this repository.
