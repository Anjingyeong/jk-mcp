# Attribution and compliance notes

_Last reviewed: 2026-09-29. This is a maintainer record, not legal advice._

## License

JK is released under the MIT License (`LICENSE`, copyright Anjingyeong). `NOTICE` records the project's origin and must travel with copies and forks.

## JK project identity

JK is designed, built, and maintained by **Anjingyeong** as an independent local MCP coding runtime. Its current product identity, orchestration, persistent work/session model, guarded edits, task workspaces, approval and lease coordination, MASS ULW execution, Control Center, executor routing, E2E tooling, packaging, and ongoing engineering are maintained as JK.

The earliest codebase incorporated work originating from [ezBuilder/chatgpt2codex](https://github.com/ezBuilder/chatgpt2codex). The original author permitted free use of that work, without a separate license, on the condition that the original GitHub repository is credited. That credit is kept in `README.md`, `README.ko.md`, `ACKNOWLEDGEMENTS.md`, and `NOTICE`; do not remove it. The upstream project's name and branding are not used as JK's product name.

Permission records themselves are private maintainer records and are not committed to this public repository.

## Contributions

Contributions to the public repository are accepted under the same MIT License (inbound = outbound) and require a Developer Certificate of Origin sign-off (`git commit -s`). See `CONTRIBUTING.md`.

## OpenAI / ChatGPT / MCP boundary

JK is a user-directed MCP/Actions execution harness. It does not represent itself as an OpenAI product and is not affiliated with, endorsed by, sponsored by, or partnered with OpenAI.

JK is not intended to bypass product usage limits, safety systems, authentication, access controls, or other protective measures. Users remain responsible for the terms and policies of services they connect to JK.

`OpenAI`, `ChatGPT`, `GPT`, and `Codex` are marks or products of OpenAI. References in JK documentation describe compatibility or integration only.

## Distribution boundary

Release artifacts should use the **JK** name and Anjingyeong maintainer identity. Legacy internal names may remain only where they are required for backward compatibility with existing configuration, state, protocol readers, or migration paths.

Before publishing a release, maintainers should still run the repository's test, typecheck, build, packaging, security-audit, and clean-install verification gates. Historical permission does not replace normal third-party dependency license and security checks.
