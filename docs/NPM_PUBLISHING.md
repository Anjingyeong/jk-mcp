# npm publishing for JK

JK's primary public distribution path is the `jk-mcp` npm package. The Windows Setup/Portable builds are optional GUI distributions, not the default install path.

## Package safety goals

- Publish JavaScript/runtime output and the small set of public docs/assets needed by npm users.
- Do not bundle a JK-specific unsigned Windows executable into the npm package.
- Do not use `postinstall` to download or execute PowerShell, EXE, or other native payloads.
- `cloudflared` is not bundled by npm. `jk start --quick-tunnel` only launches an already-installed official Cloudflare binary.
- Keep `package.json.repository` pointed at `Anjingyeong/jk-mcp` so npm provenance can match the public source repository.

## Before the first publish

1. Confirm the npm package name `jk-mcp` is still available. If it is taken, choose a scoped name and update `package.json` before publishing.
2. Use an npm account with 2FA enabled.
3. Verify the package locally:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

4. Inspect the dry-run file list. It should contain `dist/`, the README files npm includes automatically, the selected public docs, and the README hero asset. It should not contain local state, secrets, `.env` files, installers, or bundled native executables.
5. Perform the initial public publish interactively:

```bash
npm login
npm publish --access public
```

The first package version must exist on npm before npm Trusted Publishing can be attached to it.

## Configure npm Trusted Publishing

After the first publish, open the `jk-mcp` package settings on npmjs.com and add a GitHub Actions trusted publisher with:

- GitHub user/organization: `Anjingyeong`
- Repository: `jk-mcp`
- Workflow filename: `npm-publish.yml`
- Allow direct `npm publish` for this workflow (or use staged publishing later if preferred)

The repository workflow is `.github/workflows/npm-publish.yml`. It uses a GitHub-hosted runner, OIDC (`id-token: write`), Node 24, a current npm 11 CLI, clean dependency installation, verification, and `npm publish --access public`.

For a public repository and public package, npm Trusted Publishing automatically attaches provenance. No long-lived npm publish token is required by the workflow.

## Subsequent releases

1. Update `package.json` / `package-lock.json` to a new version.
2. Run the full local verification and inspect `npm pack --dry-run` again.
3. Commit and push the release changes.
4. Create a GitHub Release for the matching version/tag.
5. The trusted workflow publishes to npm.

After Trusted Publishing is confirmed, npm's package settings should disallow traditional automation tokens where practical. Keep interactive account 2FA enabled.

## Upstream permission and attribution

The JK maintainer has obtained direct permission from the upstream author to redistribute this modified fork. The private correspondence is retained by the maintainer rather than copied into the public repository. This does not convert the upstream source into an MIT/Apache/open-source grant; retain the existing attribution and compliance notices in public distributions.
