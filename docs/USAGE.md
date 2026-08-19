# JK Usage Guide

JK is not meant to be operated by memorizing tool names. **The normal workflow is to describe the development goal to ChatGPT in natural language while JK handles local project access, edits, and verification.**

Most users only need the six patterns below.

## 1. The simplest way to use JK

A useful prompt formula is:

```text
@jk [project] [goal]. [important constraints]. [verification]. [finish condition].
```

Example:

```text
@jk In chatgpt2codex, find the cause of this bug, fix it, and run typecheck plus the relevant tests.
```

If the project is already obvious from the conversation, you can omit its name.

```text
@jk Fix this bug and test it.
```

When JK is connected, ChatGPT will normally select the project, inspect the necessary code, make the change, and run the closest relevant verification.

## 2. Six common patterns

### A. Inspect without changing code

```text
@jk Explain how this project works by inspecting the code. Do not modify anything yet.
```

```text
@jk Find likely performance bottlenecks with code evidence. Do not patch them yet.
```

### B. Implement a feature

```text
@jk Add a user-visible error message for failed login requests and run typecheck plus the relevant tests.
```

Adding completion criteria makes the result more reliable.

```text
@jk Add a loading state to search results. Keep the existing UI style, make sure mobile does not break, and verify it with tests.
```

### C. Debug a bug

```text
@jk Confirm the cause from the code first, then fix it. If the first approach fails, do not repeat the same patch; form a different hypothesis.
```

JK-native orchestration can keep a longer debug loop moving through inspect -> patch -> verify -> failure analysis.

### D. Continue previous work

```text
@jk Continue the project_rules work we were doing in chatgpt2codex and finish it.
```

```text
@jk Continue the previous task, run the tests, and update the README too.
```

If several tasks were active in the same repository, include **the project name and a short task hint** so the intended work session is easier to identify.

```text
@jk Continue yesterday's VLM-description work in developer-portfolio.
```

Users do not need to remember `workSessionId`. It is an internal JK identifier used to isolate workflows.

### E. Run E2E and inspect screenshots

```text
@jk Run E2E and show me the screenshots.
```

For web projects, supported environments can capture desktop/mobile views and collect browser console errors or failed network requests.

After a UI change, a useful request is:

```text
@jk Verify the changed screen with E2E and show desktop/mobile screenshots. If something is wrong, fix it and rerun verification.
```

### F. Commit and push

JK treats commit and push as explicit user actions rather than something to do silently.

```text
@jk Review the diff and commit it if everything looks correct.
```

```text
@jk Confirm the tests pass, commit the changes, then push to jk-mcp.
```

If you only say "fix it," the safe expectation is usually implementation plus verification, not an automatic push.

### G. Choose local vs remote execution

Projects stay **local-only by default**. A remote executor is used only after it has been configured and selected for the task.

When multiple executors share a Git project, use the configured upstream as the durable source of truth.

- Use the local executor for normal work and for files or tools that exist only on that machine.
- Use a remote executor when the task intentionally targets another connected machine.
- Before editing a shared remote checkout, require a clean tree and fast-forward-only sync from upstream.
- Never auto-resolve dirty, diverged, or local-only commits with stash/reset/rebase/force operations.
- Windows is never auto-pulled. Update it only when the user explicitly asks for a manual sync.
- Do not independently modify the same branch on multiple executors at the same time.
- Public JK does not assume a specific cloud provider or built-in deployment host.

See `docs/EXECUTION_POLICY.md` for the durable policy.

## 3. Recommended prompt structure

Longer tasks are more reliable when the prompt contains four things:

```text
1. Project
2. Goal
3. Constraints / things not to touch
4. Verification and finish condition
```

Example:

```text
@jk Update the usage documentation in chatgpt2codex.
Keep the existing technical explanation, but prioritize examples users can copy and paste.
Avoid unnecessary internal implementation detail or overengineering.
Run typecheck/build and summarize the diff when finished. Do not commit.
```

## 4. Basic vs advanced usage

### Basic usage: you do not need tool names

You usually do not need to invoke or remember:

- `goal_intake`
- `goal_loop`
- `project_select`
- `session_resume`
- `workSessionId`
- file hashes / patch preconditions
- checkpoint IDs

Natural-language intent is the preferred interface.

### Advanced usage: control the workflow in natural language

```text
@jk Analyze first and do not edit anything yet.
```

```text
@jk Make small changes and verify each step.
```

```text
@jk Do not touch the existing unrelated changes; modify only this area.
```

```text
@jk If verification fails, do not repeat the same patch. Re-check the assumption first.
```

```text
@jk Do not call the task complete until typecheck, relevant tests, and build have been checked.
```

## 5. What `goal_intake` and `goal_loop` do

These are normally orchestration details rather than commands the user must type.

For a larger task, the internal flow is roughly:

```text
goal_intake / goal_loop
  -> select project
  -> read rules / status
  -> search and read narrow code slices
  -> edit
  -> run the relevant typecheck / test / build / E2E
  -> inspect failures when needed
  -> finish or report a proven blocker
```

`goal_loop` does not mean calling another AI model. Its purpose is to help **the current ChatGPT web session maintain an inspect -> edit -> verify loop without losing the task state.**

## 6. Repository rules with `AGENTS.md` / `CLAUDE.md`

Persistent project instructions can live in the repository instead of being repeated in every conversation.

Example:

```text
project/
  AGENTS.md
  src/
    AGENTS.md
    auth/
      CLAUDE.md
      login.ts
```

When working on `src/auth/login.ts`, JK can read path-scoped rules in root-to-leaf order:

```text
project/.codex/config.toml
project/AGENTS.md
project/src/AGENTS.md
project/src/auth/CLAUDE.md
```

This makes it practical to separate repository-wide rules from rules that only apply to a subsystem.

Example root rule file:

```markdown
# AGENTS.md
- Keep TypeScript strict mode enabled.
- Do not break existing public APIs without explicit approval.
- Run the relevant tests and typecheck after changes.
```

Example nested rule file:

```markdown
# src/auth/AGENTS.md
- Log authentication failure reasons without printing token values.
- Run auth-related tests after auth changes.
```

## 7. When to use OMO

OMO is not required for normal JK-native work.

The default request can simply be:

```text
@jk Implement this feature.
```

Explicitly ask for OMO only when you want a separate local agent-runtime pass.

```text
@jk Use OMO to do another analysis pass on this project.
```

OMO depends on its own provider authentication and runtime health, so **JK-native operation is the simpler default for everyday work.**

## 8. Practical cheat sheet

| Goal | Say this |
| --- | --- |
| Understand a repo | `@jk Inspect this project and explain how it works. Do not edit anything.` |
| Implement | `@jk Add this feature and run the relevant tests.` |
| Debug | `@jk Confirm the cause, fix it, and add/run a reproduction test.` |
| Continue | `@jk Continue the previous [project/task] work.` |
| UI verification | `@jk Run E2E and show desktop/mobile screenshots.` |
| Review | `@jk Review the current diff for regressions and missing verification.` |
| Commit | `@jk If verification passes, review and commit the changes.` |
| Push | `@jk Verify, commit, then push to [remote].` |
| Persistent rules | Add `AGENTS.md` to the project or a nested directory |
| OMO | Explicitly say `@jk Use OMO to ...` |

## 9. Things you usually do not need to manage

You do not need to think about these on every request:

- which internal tool should run first
- lease IDs
- loop IDs
- current SHA-256 values
- checkpoint timing
- which verification command should be selected

Those are execution details for JK and ChatGPT.

The user mainly needs to answer three questions:

```text
What do I want?
What must not be changed?
What must be true before the task is done?
```

Clear answers to those three questions are usually enough to get the most value from JK.
