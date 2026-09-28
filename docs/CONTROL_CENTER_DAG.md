# Control Center DAG primitives

The Control Center renders the persisted MASS ULW execution plan as a read-only directed acyclic graph inside the existing workflow panel. The graph is presentation-only: it does not mutate execution state, change polling cadence, or add a graph/runtime dependency.

## JK visual contract

The graph belongs to the same product language as the rest of JK rather than looking like a separate diagnostics widget. The web Control Center and the native Windows app share one look: a charcoal navigation rail, a light canvas, white rounded cards, and the warm JK amber accent. When a MASS ULW run exists, the DAG is the first thing on the dashboard: a full-width `.dag-stage` card above the work/attention columns.

The DAG stage is built to be read at a glance:

- a segmented progress bar (completed / running / problem / waiting) and a completion percentage;
- a dotted canvas with one column band per wave (`.run-dag-wave`, `data-wave-state` = `done` | `current` | `idle`) labelled `WAVE n` with a done/total count;
- nodes coloured by semantic state (left accent bar, tinted icon, pulsing ring while running, striped when blocked);
- edges coloured by `data-edge-state` (see below), with an animated flow on edges that feed a running lane;
- a legend, and hover/focus on a node dims everything except that node, its direct dependencies/dependents, and the connecting edges.

These presentation choices must not change execution semantics. Keep the existing lane/status attributes, navigation hooks, accessibility labels, responsive overflow behavior, and runtime/approval boundaries intact when polishing the visuals.

## Data contract

The renderer consumes `TaskExecutionView.massUlw.lanes` from `src/control-center/execution.ts`.

Each lane supplies:

- `id`: stable node identity.
- `task`: user-facing task text.
- `status`: persisted execution status (`planned`, `in-flight`, `completed`, `failed`, or `blocked`).
- `dependsOn`: predecessor lane IDs. Each dependency becomes a directed edge from the dependency node to the dependent node.
- `wave`: persisted topological wave. Waves are laid out as left-to-right columns.
- `attempts` and `completedAt`: execution metadata; they remain part of the projection even when the compact graph node does not display every field.

Malformed or absent persisted MASS ULW documents are rejected by the execution projection and surface as no graph. A valid run with no lane details renders a status message rather than an empty/broken SVG.

## Node primitive

A graph node uses `.run-dag-node` and carries both `data-lane-id` and `data-lane-status`. The rendered status is semantic rather than merely cosmetic:

| Semantic state | Source | UI meaning |
| --- | --- | --- |
| `planned` | persisted `planned` with unfinished dependencies | waiting |
| `ready` | persisted `planned` with every dependency completed | ready to start |
| `in-flight` | persisted `in-flight` | running |
| `review` | reserved renderer state | review |
| `completed` | persisted `completed` | accepted |
| `failed` | persisted `failed` | failed |
| `blocked` | persisted `blocked` | blocked |

`ready` is intentionally derived in the browser from the same persisted dependency/status snapshot; it is not written back to execution state. `review` is a reserved presentation primitive so a future projection can expose review without redesigning the graph vocabulary.

Each state has a small inline JK-style SVG glyph. Icons are decorative (`aria-hidden=true`); the node itself carries the accessible lane/status label. No icon font, image asset, or graph package is required.

## Edge primitive

A dependency edge uses `.run-dag-edge` inside `.run-dag-edges` and includes:

- `data-edge-from`: predecessor lane ID.
- `data-edge-to`: dependent lane ID.
- `data-edge-state`: `done` (predecessor completed), `active` (predecessor completed and the dependent is running; animated), `blocked` (predecessor failed or blocked), or `pending`. Derived in the browser from the same snapshot; never written back.
- an SVG cubic path from the predecessor card's right edge to the dependent card's left edge.
- `marker-end="url(#run-dag-arrow)"` to make direction explicit. The arrowhead uses `fill: context-stroke`, so it takes the edge colour.

Edges are presentation-only and `aria-hidden`; dependency meaning is already encoded by node identity/status and the persisted execution model. Missing dependency positions are skipped instead of emitting malformed paths.

## Layout and responsiveness

`massUlwGraphHtml()` groups lanes by persisted wave and places each wave in a left-to-right column. Nodes within the same wave stack vertically, which preserves the execution model's parallel grouping without a separate layout library.

The graph lives inside `.run-dag-scroll`, a focusable horizontal/vertical overflow viewport. On wide screens the graph occupies the available workflow-panel width. On narrow screens it keeps readable node dimensions and scrolls instead of shrinking labels or overlapping edges. Mobile spacing is reduced, but the node/edge semantics stay identical.

## Integration contract

`dashboard()` renders `massUlwStatusHtml(e)` inside `<section class="dag-stage" data-dashboard-region="dag">` directly under the page heading whenever the active execution has a MASS ULW document. The workflow panel keeps the phase strip, wait reason, and recent events. Dashboard polling (`refreshExecution`) re-renders the whole dashboard from one execution snapshot, so the stage and the workflow panel stay consistent.

QA: `bun scripts/qa/jk-command-center-server.mjs dist mass-ulw` serves a synthetic 9-lane / 4-wave run covering every node and edge state.

When changing these primitives:

1. Keep the graph read-only and derived from `TaskExecutionView`.
2. Preserve `data-lane-*` and `data-edge-*` attributes for behavior/QA assertions.
3. Preserve a visible empty state when lane data is unavailable.
4. Verify desktop and narrow/mobile overflow behavior.
5. Run the focused Control Center tests, TypeScript typecheck, and build before release.
