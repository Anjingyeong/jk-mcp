# JK Execution Location and Git Policy

This document defines JK's one-way hybrid flow: Windows publishes to GitHub, and OCI safely follows GitHub for runtime deployment.

## Source of truth

GitHub is the durable source of truth for any project that is enabled for OCI work.

- GitHub is the durable source of truth.
- Windows is the primary interactive development workspace and never auto-pulls.
- OCI is the deployment/always-on follower for GitHub `main`.
- OCI may fast-forward only when its checkout is clean, on the expected branch/upstream, and has no local-only commits or divergence.
- Do not edit the same branch independently on Windows and OCI at the same time.

## Project modes

### local-only — default for new/local projects

Use this until the user explicitly asks to use the project from OCI or another executor.

- No automatic GitHub repository creation.
- No automatic upload of local code.
- Windows/local remains the only working copy unless the project already has its own remote.

### hybrid — opt-in

Promote a project to hybrid when the user says things such as `OCI에서도 작업해`, `PC 꺼져도 작업되게 해`, or explicitly asks to synchronize it.

For hybrid projects:

- GitHub is the shared source of truth.
- Windows does not automatically pull from GitHub or OCI. Pull there only when the user explicitly requests it.
- OCI polls GitHub `main` and may update only by guarded fast-forward.
- After an OCI update, JK builds, reloads the runtime, and runs health/auth/tunnel QA.
- OCI stops instead of stashing, resetting, rebasing, or force-updating when the tree is dirty, diverged, or contains local-only commits.
- Windows remains mandatory for Android Studio/emulators, Windows packaging, local GUI/device access, signing state, and local-only files.

## Handoff rule

When publishing from Windows to OCI:

1. Finish or checkpoint the Windows task.
2. Verify the relevant tests/build.
3. Commit and push the intended changes to GitHub.
4. OCI detects the updated `main` and fast-forwards only if all safety gates pass.
5. OCI builds, reloads JK, and runs health/auth/tunnel QA.

This keeps a single branch history and avoids copying arbitrary working directories between machines.

## Default decision

Use the following order:

1. Use Windows/local for normal interactive coding and Windows-specific work.
2. Use OCI for deployment, always-on/server automation, cron, Cloudflare/server work, and long-running services.
3. Treat automatic synchronization as one-way: `Windows -> GitHub -> OCI`.
4. Never auto-pull changes back into Windows.
5. Never promote a local-only project to hybrid or upload its source without explicit user intent.

## Current examples

- SongSong: hybrid.
- CleanTube: hybrid; general code may run on OCI, while Android Studio/emulator and Windows-specific packaging stay on Windows.

This policy intentionally keeps the system simple: Windows publishes, GitHub is the hub/source of truth, and OCI safely follows for deployment and always-on runtime work.
