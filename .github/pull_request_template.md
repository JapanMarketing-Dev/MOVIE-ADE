<!-- Adapted from Orca's .github/pull_request_template.md (MIT, Copyright 2026 Lovecast Inc.). -->
<!-- Open pull requests against `develop`. Japanese or English is fine. -->

## Summary

<!-- In plain words: what changes for the user, before and after. -->

## Why

<!-- The problem this solves, and why this approach. -->

## Linked issue

<!-- e.g. Fixes #123. For small fixes, an issue is optional. -->

## Screenshots or recording

<!-- For UI or behavior changes, attach a before and after (drag and drop into this field; do not commit them).
     Check that they show no API keys, tokens, private URLs or personal information.
     If nothing visible changes, write N/A. -->

## Testing

<!-- How you checked it, and on which OS (macOS / Windows / Linux). -->

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test:unit` passes
- [ ] Tested by hand on: <!-- macOS / Windows / Linux -->

## Checklist

- [ ] The change is small and focused
- [ ] No API keys or tokens in code, tests or screenshots
- [ ] User-facing text is added for all 15 languages in `src/shared/i18n/` (or N/A)
- [ ] Code ported from another project names its source and is listed in `THIRD_PARTY_NOTICES.md` (or N/A)
