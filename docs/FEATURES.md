# JK features at a glance

The 70 MCP tools JK gives ChatGPT, grouped by what they do. You never need the tool names: say "fix this bug and run the tests" and ChatGPT picks the tools.

| Group | Tools |
|---|---|
| [Memory that carries work across sessions](#memory) | 11 |
| [Understanding the codebase](#understand) | 8 |
| [Safe edits](#edit) | 4 |
| [Running and verifying](#verify) | 9 |
| [Git](#git) | 8 |
| [Running bigger jobs](#orchestrate) | 6 |
| [Quality watch (Impulse)](#impulse) | 6 |
| [Images](#image) | 11 |
| [Desktop control (approval-based)](#desktop) | 4 |
| [Operations](#ops) | 3 |

<a id="memory"></a>
## Memory that carries work across sessions

Pick up where you left off after a disconnect. Goal, touched files, open items and decisions are saved per project, and resuming checks whether files changed in between.

| Tool | What it does |
|---|---|
| `project_select` | Select a project and take its work lease; every later call is scoped to it |
| `work_session_list` | List earlier work sessions and rank which one to resume |
| `session_resume` | Reload the previous task's goal, files, open items and decisions, checking file hashes for drift |
| `project_feedback_record` | Remember the user's feedback about this project |
| `known_fix_search` | Search fixes learned from earlier debugging |
| `known_fix_add` | Store a verified symptom and its fix |
| `analysis_cache_get` | Reuse an earlier analysis while the project fingerprint still matches |
| `analysis_cache_put` | Store an analysis result with the project fingerprint |
| `checkpoint_list` | List checkpoints captured after every file change |
| `checkpoint_show` | Show a checkpoint's redacted diff |
| `checkpoint_restore` | Roll back to a checkpoint |

<a id="understand"></a>
## Understanding the codebase

Read exactly what is needed and save context.

| Tool | What it does |
|---|---|
| `workspace_list_projects` | List registered projects |
| `workspace_get_project` | Get one project's metadata |
| `workspace_refresh_index` | Rescan the workspace for projects |
| `project_status` | Git state, rule files and runnable commands at a glance |
| `project_rules` | Read AGENTS.md / CLAUDE.md rules, scoped by path |
| `code_search` | ripgrep-backed code search inside the project |
| `code_context_pack` | Bundle the code slices relevant to one topic |
| `file_read_slice` | Read a line range with per-line hashes |

<a id="edit"></a>
## Safe edits

Never overwrite work that changed after it was read.

| Tool | What it does |
|---|---|
| `file_apply_patch` | Apply a patch only if the file still matches what was read, all or nothing |
| `file_create` | Create a file; overwriting must be explicit |
| `show_changes` | Review the current diff before commit or rollback |
| `task_workspace` | Work in a private copy and publish only verified changes back |

<a id="verify"></a>
## Running and verifying

Return what actually ran, not "should work".

| Tool | What it does |
|---|---|
| `command_list` | List allowlisted commands found in project manifests |
| `command_run` | Run an allowlisted command (never arbitrary shell) |
| `local_shell_run` | Run a shell command, confined to the project; secret paths and destructive OS commands are blocked, risky work needs owner approval |
| `e2e_start_server` | Start a dev server and wait for its URL |
| `e2e_open_target` | Open a URL or app for E2E checks |
| `e2e_run_command` | Run an E2E/test command and capture the screen |
| `e2e_test_and_show_screenshot` | One-shot: run E2E and return a screenshot |
| `e2e_screenshot` | Capture the screen (macOS / Windows) |
| `e2e_open_url_screenshot` | Open a local URL and capture the browser |

<a id="git"></a>
## Git

Reads are free; commits and pushes only for inspected changes, on request.

| Tool | What it does |
|---|---|
| `repo_status` | Repository and upstream status, read-only |
| `repo_diff_summary` | Redacted diff summary, read-only |
| `git_status` | Legacy alias of repo_status |
| `git_diff_summary` | Redacted diff summary |
| `git_commit` | Commit inspected changes |
| `git_push` | Push only when explicitly asked |
| `git_sync_start` | Prepare a clean, up-to-date checkout for remote work |
| `git_sync_finish` | Commit only the verified task paths and push |

<a id="orchestrate"></a>
## Running bigger jobs

Drive a large goal through plan, implement, review and verify until done.

| Tool | What it does |
|---|---|
| `agent_guide` | Entry point that routes a broad request |
| `goal_intake` | Turn a large goal into a plan |
| `goal_loop` | Run explorer / implementer / reviewer / verifier / recovery roles to completion; a failed check re-plans |
| `mass_ulw_step` | Split work into dependency-aware lanes run in parallel |
| `mass_ulw_execute` | Execute an approved wave plan |
| `omo_run` | Optionally delegate passes to a local OMO install |

<a id="impulse"></a>
## Quality watch (Impulse)

Record events as work progresses and look separately for costly omissions such as skipped verification.

| Tool | What it does |
|---|---|
| `impulse_event_record` | Record events such as phase done, QA failure, regression |
| `impulse_scout_run` | Scan events for costly omissions such as unverified claims |
| `impulse_wake_queue` | Prioritised list of the scout's proposals |
| `impulse_director_decide` | Decide each proposal: reject, backlog, next phase, interrupt |
| `impulse_director_policy` | Per-project policy, including protected scopes |
| `impulse_semantic_review` | Report quality gaps the deterministic checks miss |

<a id="image"></a>
## Images

Save images generated in ChatGPT straight into the project.

| Tool | What it does |
|---|---|
| `gpt_image_2_workflow` | Guide: generate an image in ChatGPT and save it to the project |
| `open_chatgpt_images_app` | Open the ChatGPT Images app |
| `save_chatgpt_image` | Import a ChatGPT-generated image |
| `save_chatgpt_image_from_url` | Import from a ChatGPT share link |
| `save_image` | Save image data, format-checked |
| `save_image_from_clipboard` | Save the clipboard image |
| `save_image_from_download` | Save the newest downloaded image |
| `save_image_from_path` | Copy a local image into the project |
| `save_image_from_url` | Save an image from a URL |
| `list_images` | List saved images |
| `retrieve_image` | Retrieve a saved image |

<a id="desktop"></a>
## Desktop control (approval-based)

One action at a time, only after the owner approves; a kill switch stops it instantly.

| Tool | What it does |
|---|---|
| `computer_screenshot` | Capture the screen or a window; no input |
| `computer_request_action` | Request one click or keystroke; runs only after owner approval, with an allowlist, a sensitive-app denylist and an audit trail |
| `computer_action_status` | Status of queued actions |
| `computer_kill_switch` | Immediately disable desktop control |

<a id="ops"></a>
## Operations

Runtime management and utilities.

| Tool | What it does |
|---|---|
| `executor_restart` | Request a supervised restart of the remote executor |
| `runtime_upgrade` | Upgrade or reload the JK runtime |
| `seo_geo_audit` | SEO/GEO audit of a public page, SSRF-guarded |

Generated from the tools actually registered by `createServer`. 한국어: [FEATURES.ko.md](FEATURES.ko.md)
