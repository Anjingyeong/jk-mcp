# JK production dependency audit — 2026-08-14

This note records the production dependency triage performed during Roles v1.1 hardening.

- `fast-uri@3.1.3` is present in the installed production tree through AJV. GHSA-v2hh-gcrm-f6hx affects the installed release; the patched 3.x release is `3.1.4`. A normal lockfile refresh should resolve this without a direct JK API change.
- `@hono/node-server@1.19.14` is present through `@modelcontextprotocol/sdk@1.29.0`. GHSA-frvp-7c67-39w9 is fixed on the 2.x line, while the installed MCP SDK constrains this adapter to 1.x. Do not force a major override without MCP SDK compatibility verification.
- JK does not intentionally import Hono's `serve-static` helper in its application code. The remaining Hono finding is therefore tracked as upstream-constrained audit debt rather than silently force-upgraded.
- The live `npm audit --omit=dev` network call was blocked by JK's explicit-approval gate in this session. No package-lock integrity values were hand-edited to bypass that control.

## Follow-up

When network approval is available:

1. Refresh the lockfile normally so `fast-uri` resolves to `>=3.1.4`.
2. Run `npm audit --omit=dev` again.
3. Re-evaluate the Hono adapter finding against the current `@modelcontextprotocol/sdk` release before considering any override.
