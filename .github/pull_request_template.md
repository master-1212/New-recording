## Change

Describe the user-visible behavior and the smallest code surface changed.

## Security and privacy

- [ ] No recording, credential, token, `.env` file, model cache, or local database is included.
- [ ] New dependencies and GitHub Actions are justified and pinned.
- [ ] Audio remains local; any new network request is documented.
- [ ] Browser security headers and runtime-asset hashes still pass.

## Verification

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] Tested upload, play/pause, seek, A/B, relevant toggles, and iPad-sized layout.
