# Control Center DAG primitives

The Control Center renders the persisted MASS ULW execution plan as a read-only directed acyclic graph inside the existing workflow panel. The graph is presentation-only: it does not mutate execution state, change polling cadence, or add a graph/runtime dependency.

## JK visual contract

The graph belongs to the same product language as the rest of JK rather than looking like a separate diagnostics widget. The web Control Center uses a graphite shell with the warm JK accent, layered rounded surfaces, pill status treatments, and a visually elevated DAG viewport. The native Windows app uses the embedded JK executable icon as its visible brand mark, a dark branded navigation rail, and a light workspace/console hierarchy that mirrors the web product.

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
- an SVG cubic path from the predecessor card's right edge to the dependent card's left edge.
- `marker-end="url(#run-dag-arrow)"` to make direction explicit.

Edges are presentation-only and `aria-hidden`; dependency meaning is already encoded by node identity/status and the persisted execution model. Missing dependency positions are skipped instead of emitting malformed paths.

## Layout and responsiveness

`massUlwGraphHtml()` groups lanes by persisted wave and places each wave in a left-to-right column. Nodes within the same wave stack vertically, which preserves the execution model's parallel grouping without a separate layout library.

The graph lives inside `.run-dag-scroll`, a focusable horizontal/vertical overflow viewport. On wide screens the graph occupies the available workflow-panel width. On narrow screens it keeps readable node dimensions and scrolls instead of shrinking labels or overlapping edges. Mobile spacing is reduced, but the node/edge semantics stay identical.

## Integration contract

`massUlwStatusHtml(e)` is called from the existing workflow panel after the workflow strip and wait-reason block. Keep that integration point stable so the existing dashboard polling (`refreshExecution`) updates strip, wait reason, graph, and recent events from one execution snapshot.

When changing these primitives:

1. Keep the graph read-only and derived from `TaskExecutionView`.
2. Preserve `data-lane-*` and `data-edge-*` attributes for behavior/QA assertions.
3. Preserve a visible empty state when lane data is unavailable.
4. Verify desktop and narrow/mobile overflow behavior.
5. Run the focused Control Center tests, TypeScript typecheck, and build before release.
