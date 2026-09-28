# Attribution and compliance notes

_Last reviewed: 2026-09-17. This is a maintainer record, not legal advice._

## JK project identity

JK is maintained by **Anjingyeong** as an independent local MCP coding runtime. Its current product identity, orchestration, persistent work/session model, guarded edits, task workspaces, approval and lease coordination, MASS ULW execution, Control Center, executor routing, E2E tooling, packaging, and ongoing engineering are maintained as JK.

The earliest codebase incorporated work originating from `ezBuilder/chatgpt2codex`. The JK maintainer has received written permission from the original author to continue and distribute the modified work. Historical acknowledgement is preserved in `ACKNOWLEDGEMENTS.md`; the upstream project's name and branding are not used as JK's current product identity.

Permission records themselves are private maintainer records and are not committed to this public repository.

## OpenAI / ChatGPT / MCP boundary

JK is a user-directed MCP/Actions execution harness. It does not represent itself as an OpenAI product and is not affiliated with, endorsed by, sponsored by, or partnered with OpenAI.

JK is not intended to bypass product usage limits, safety systems, authentication, access controls, or other protective measures. Users remain responsible for the terms and policies of services they connect to JK.

`OpenAI`, `ChatGPT`, `GPT`, and `Codex` are marks or products of OpenAI. References in JK documentation describe compatibility or integration only.

## Distribution boundary

Release artifacts should use the **JK** name and Anjingyeong maintainer identity. Legacy internal names may remain only where they are required for backward compatibility with existing configuration, state, protocol readers, or migration paths.

Before publishing a release, maintainers should still run the repository's test, typecheck, build, packaging, security-audit, and clean-install verification gates. Historical permission does not replace normal third-party dependency license and security checks.
