# Contributing

Thanks for your interest in improving the FluxNova REST Client Plugin.

## Developer Certificate of Origin (DCO)

Every commit must be signed off, certifying you wrote the change (or have the right to submit it)
under the project's Apache-2.0 license — see the [DCO](https://developercertificate.org/). Sign off
by adding a line to your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

The easy way is the `-s` flag:

```bash
git commit -s -m "Add response history"
```

Commits without a sign-off will be asked to amend. This project is structured to be proposable
upstream to FINOS later, which requires DCO (and possibly an EasyCLA) — keeping commits signed now
avoids rework.

## Development

```bash
npm install
npm run build     # or: npm run dev  (watch)
npm test          # vitest — keep it green
```

Please:

- Keep the `client/lib/` modules **framework-free and pure**, and cover new logic with tests.
- Match the surrounding code style (no new lint config; small, focused modules).
- Rebuild `dist/` is **not** required in PRs — CI builds it; `dist/` is gitignored.

## Reporting bugs / proposing features

Open an issue with steps to reproduce (and the modeler + OS version). Security issues: see
[SECURITY.md](SECURITY.md) — please do **not** open a public issue for those.
