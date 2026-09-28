# Contributing to JK

Thanks for helping improve JK. Bug reports, fixes, docs, and features are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Keep one topic per pull request. Small PRs are reviewed faster.
- Never include secrets (Owner Tokens, tunnel tokens, API keys, personal paths) in code, tests, logs, or screenshots.

## Development

Requirements: Node.js 22+, npm, and PowerShell on Windows.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Please add or update tests for behavior changes. The PR checks run the same typecheck, test, and build steps on Linux and Windows.

## Pull requests

1. Fork and create a branch from `main`.
2. Make your change with tests.
3. Sign off every commit (see below): `git commit -s -m "fix: ..."`.
4. Open the PR and fill in the template.

### Sign-off (DCO)

By signing off you certify the [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change or have the right to submit it under the project's license. Sign-off adds this line to the commit message:

```
Signed-off-by: Your Name <you@example.com>
```

Forgot? Run `git commit --amend -s` (last commit) or `git rebase --signoff main` (whole branch), then force-push your PR branch.

## License

JK is released under the [MIT License](LICENSE). Contributions are accepted under the same license. JK started from [ezBuilder/chatgpt2codex](https://github.com/ezBuilder/chatgpt2codex); please keep that credit ([NOTICE](NOTICE)) intact.

## How changes are released

This public repository is generated from the maintainer's canonical source tree. Merged pull requests are carried back into that tree before the next release, so your commits and authorship are preserved; you don't need to do anything extra. Releases are cut by the maintainer (tag → draft release → publish).
