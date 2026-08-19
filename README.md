<p align="center">
  <img src="assets/readme-hero.png" alt="JK local coding bridge" width="100%" />
</p>

# JK

**Local coding hands for ChatGPT, with project-scoped safety and verifiable execution.**

[English](README.md) | [한국어](README.ko.md)

JK is an independent, unofficial modified fork of [ezBuilder/chatgpt2codex](https://github.com/ezBuilder/chatgpt2codex). It connects ChatGPT to a local MCP / Actions runtime so ChatGPT can inspect a selected project, edit files, run tests, operate Git, launch E2E checks, and return execution evidence without uploading an entire repository to a separate coding-agent service.

This fork focuses on making the local coding loop more durable and practical on Windows: persistent work sessions, fast resume, hash-checked patches, JK-native orchestration, optional OMO delegation, Windows browser E2E, and explicit development/portable runtime modes.

> **Unofficial project:** JK is not affiliated with, endorsed by, sponsored by, or partnered with OpenAI. ChatGPT, GPT, Codex, and other OpenAI marks belong to OpenAI.
>
> **Licensing notice:** the upstream repository currently does not expose a root software `LICENSE` and its package metadata states `Copyright 2026 ezBuilder. All rights reserved.` This repository therefore does **not** claim that the upstream-derived code is MIT, Apache, or otherwise open-source licensed. See [Attribution & Compliance](docs/ATTRIBUTION_AND_COMPLIANCE.md) before redistributing derived source or binaries.

## 30-Second Usage

JK is designed around **natural-language goals and completion criteria**, not memorizing internal tool names.

```text
@jk Inspect this project and explain how it works. Do not edit anything.
@jk Find the cause of this bug, fix it, and run the relevant tests.
@jk Continue the previous task and finish it.
@jk Run E2E and show desktop/mobile screenshots.
@jk Review the current diff and commit it if everything looks correct.
@jk If verification passes, commit and push to jk-mcp.
```

For larger tasks, state **project + goal + constraints + verification/finish condition**. Internal state such as `goal_loop`, `workSessionId`, leases, and file hashes normally does not need to be managed by the user.

See the [JK Usage Guide](docs/USAGE.md) for practical patterns, resume behavior, hierarchical `AGENTS.md` rules, E2E, Git, and when to use OMO.

## How It Works

JK is not a second AI model. The current ChatGPT session remains the reasoning layer; JK supplies project-scoped local tools, durable state, safety gates, and execution evidence.

```text
User
  -> ChatGPT web session (reasoning / planning)
  -> MCP or GPT Actions
  -> JK HTTP runtime
  -> shared tool registry
  -> project lease + safety guards
  -> code / state / shell / Git / E2E
  -> selected local project
```

`goal_intake` and `goal_loop` coordinate the coding loop inside the current ChatGPT session. OMO is an optional delegation path for users who want a separate local agent runtime; normal JK-native coding does not depend on OMO or a second model-provider credential.

## What JK Adds

### 1. Persistent work sessions

JK can keep project-scoped and work-session-scoped state so a follow-up request can continue the previous task instead of rediscovering the repository from scratch.

It can retain information such as:

- active artifact and recently touched files
- current goal and task
- completed and pending work
- implementation decisions
- latest checkpoint and verification result
- remembered line ranges for fast source hydration

A `workSessionId` isolates multiple workflows inside the same repository.

### 2. Safe resume with CAS-style patching

Resume is validated against the current files on disk.

```text
resume
  -> validate the active artifact
  -> read the current source slice
  -> return the current full-file SHA-256
  -> use that hash as a patch precondition
  -> reject the patch if the file changed in between
```

This reduces accidental overwrites when the repository changes between turns.

### 3. JK-native orchestration

JK now keeps orchestration inside the current ChatGPT web session by default. It does not need a second model provider, API key, or separate agent runtime for normal coding loops.

`goal_intake` and `goal_loop` route each turn through reasoning roles such as:

- Explorer: inspect/search/read before claims or edits
- Oracle: challenge assumptions and choose the smallest sound strategy
- Implementer: apply one coherent scoped change
- Reviewer: check regressions, security, maintainability, and goal fit
- Verifier: require targeted test/typecheck/build/E2E evidence
- Recovery: stop repeating the same failed approach and form a new evidence-backed hypothesis

Verification failures escalate structurally: inspect the first failure, switch approach on the second, and enter recovery after three or more failed attempts.

### 4. Optional OMO delegation

JK can delegate a coding or analysis pass to a locally installed OMO / Oh My OpenAgent CLI.

The runner:

- discovers installed OMO versions
- probes `omo run --help` for JK-required flags
- selects the newest compatible version
- falls back to an older compatible version if a newer CLI breaks the contract
- passes prompts as argv rather than shell text
- defaults to the `general` agent when no agent is specified
- preserves OMO session IDs for resumable agent runs

The current JK runner expects OMO to expose:

```text
--json
--directory
--agent
--model
--session-id
--verbose
```

OMO still uses whichever model provider/authentication is configured for OMO itself. A provider outage can therefore fail an OMO run even when JK and the local OMO CLI are healthy.

### 5. Local MCP / Actions execution bridge

Once connected, ChatGPT can use JK to:

- discover and select local projects
- read repository rules
- search source code
- read narrow file slices
- create files and apply guarded patches
- run allowlisted project commands
- run guarded local shell commands
- inspect Git status and diffs
- commit and push when explicitly requested
- start development servers
- run E2E checks
- capture browser / app screenshots where supported
- save generated image assets into a project

The execution model is intentionally simple:

```text
User
  -> ChatGPT
  -> MCP / Actions
  -> JK local runtime
  -> files / shell / Git / E2E / OMO
```

ChatGPT remains the main reasoning surface. JK is the local execution harness.

### 6. Windows-first development workflow

This fork contains significant Windows work, including:

- JK-branded Windows launcher and installer paths
- project folder selection
- Owner Token approval flow
- ChatGPT web connector support
- stale process cleanup
- Edge / Chrome based local-web E2E capture
- desktop and mobile viewport screenshot proof
- browser console / failed-network capture in the E2E path
- development-runtime auto-sync back to the source checkout

For an exact implementation history, see [docs/HARNESS_DEVLOG.md](docs/HARNESS_DEVLOG.md).

## Local Performance Snapshot

The following numbers were measured on the maintainer's Windows development machine on **2026-08-13**, with the JK runtime already running locally. They are implementation measurements, not a cross-machine SLA.

| Operation | Result |
| --- | ---: |
| `goal_intake` direct handler | 1.35 ms avg |
| `goal_loop` first-turn handler | 1.43 ms avg |
| 50-turn `goal_loop` continuation | 2.11 ms early avg -> 2.74 ms late avg |
| `file_read_slice` (100 lines + hashes) | 2.32 ms avg / 3.39 ms p95 |
| persisted session read + validation | 0.634 ms avg / 1.045 ms p95 |
| `code_search` via ripgrep | 48.62 ms avg / 60.15 ms p95 |
| local `gitRepositoryStatus` | 182.18 ms avg / 191.03 ms p95 |
| localhost `/healthz` | 14.20 ms avg |
| localhost Actions OpenAPI | 15.13 ms avg |

The live Node runtime was approximately **124 MB working set** with 13 threads during the same inspection. The practical latency bottleneck is usually not JK-native orchestration itself; repeated ChatGPT-tool round trips, child-process startup, Git, typecheck/test/build, and browser E2E dominate real task time.

## Safety Model

JK is intended for trusted local development, not arbitrary public automation.

- Project access is scoped to the selected workspace/project.
- Local-only state, MCP configuration, logs, `.env` files, and generated runtime state are ignored from Git.
- Secret-looking values are redacted from tool output.
- Existing-file edits can use hash preconditions.
- Network, destructive, commit, push, and other sensitive actions require explicit user intent or approval gates.
- Remote ChatGPT access uses an Owner Token approval model.
- The connector defaults to local/loopback behavior unless web connector/tunnel mode is enabled.

Treat the Owner Token like a password. Do not publish it in issues, screenshots, logs, or documentation.

## Build From Source

### Requirements

- Node.js 22 or newer
- npm
- PowerShell on Windows
- Optional: an externally managed HTTPS reverse proxy or tunnel when your ChatGPT client cannot reach localhost directly
- Optional: a compatible OMO installation for `omo_run`

The public repository is the MCP harness/core. Persistent cloud hosting, provider-specific provisioning, private domains, and automatic deployment are intentionally kept out of the public distribution. Host-specific behavior can be added through the local override boundary documented in `docs/LOCAL_OVERRIDES.md`.

### Install and verify

```bash
npm ci
npm run typecheck
npm test
npm run build
```

### Run on Windows

```powershell
npm run chatgpt:windows
```

### Run on macOS / Linux source environments

```bash
npm run chatgpt
```

or:

```bash
npm run chatgpt:linux
```

See [docs/INSTALL.md](docs/INSTALL.md) and [windows/README.md](windows/README.md) for the inherited installation/runtime documentation.

## Useful Verification Commands

```bash
npm run typecheck
npm test
npm run build
```

Targeted OMO runner tests:

```bash
npx vitest run src/exec/omo-runner.test.ts
```

MCP / Actions catalog tests:

```bash
npx vitest run src/server/tools-catalog.test.ts src/server/http-actions.test.ts
```

## Repository Layout

```text
src/
  auth/       OAuth / Owner Token support
  code/       search, read and patch operations
  control/    optional desktop-control safety path
  e2e/        local E2E automation and screenshot proof
  exec/       command, shell and OMO runners
  server/     MCP tools and Actions bridge
  state/      persistent project/work-session state
  workspace/  project registry and lease handling

windows/      Windows launcher / tray / installer code
macos/        macOS status-bar application
linux/        Linux launch/install path
scripts/      build, packaging and verification scripts
docs/         install, engineering log and compliance notes
assets/       public UI / README assets
```

## Recommended First Prompts

Basic repository check:

```text
@jk Select my project, inspect its status and rules, run the safest relevant check,
and summarize the result with exact evidence.
```

OMO delegation:

```text
@jk Use OMO to analyze this project and return the highest-priority issues.
```

Visual verification:

```text
@jk Run E2E, capture the passing screenshots, and show me the proof.
```

## Attribution and Licensing

The original project and base runtime were created by **ezBuilder**:

- Upstream: [ezBuilder/chatgpt2codex](https://github.com/ezBuilder/chatgpt2codex)
- Original package metadata: `Copyright 2026 ezBuilder. All rights reserved.`

This fork is maintained as **Anjingyeong/jk-mcp** and contains substantial follow-on harness engineering, including persistent work sessions, fast resume, CAS patch handoff, Windows E2E work, JK branding, explicit development/portable runtime separation, and optional OMO integration.

As of the latest review, the upstream GitHub repository does not expose a root software license. Public source visibility or GitHub forkability should not be interpreted as an independent redistribution/relicensing grant. This repository does not publish a new license over the combined upstream-derived work.

For details, read [docs/ATTRIBUTION_AND_COMPLIANCE.md](docs/ATTRIBUTION_AND_COMPLIANCE.md).

## Status

JK is an active engineering fork. Source-level workflows are the primary focus. Modified binary redistribution should be treated separately from source development because of the upstream licensing uncertainty described above.
