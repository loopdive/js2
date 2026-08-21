---
id: 4601
title: "IR layering S3: contain the ir/integration.ts IR→codegen bridge (42 of 92 inverted import lines)"
status: blocked
sprint: current
created: 2026-08-21
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: refactor
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
parent: 3518
depends_on: [3520, 3521]
related: [3113, 1172]
origin: "#3113 closed against amended ACs (PR #4689); S3 split out so the bridge containment is not orphaned"
# id 4601 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-21 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: open PRs were 4681,
# 4682, 4688, 4689, 4690; none introduces an issue file with an id above the
# 4592 max on the branch tree, and the assignment book's highest reservation
# was #4600.
---

# #4601 — contain the `ir/integration.ts` bridge

## Problem

#3113 fixed the shared-vocabulary half of the IR→codegen layering inversion
and (PR #4689) added the `check:ir-layering` ratchet that freezes the
boundary at its measured truth. What remains — deliberately deferred as S3 —
is the bridge itself: `src/ir/integration.ts` (7.3k LOC) is the IR→codegen
bridge but lives on the IR side, so `import "src/ir"` transitively pulls the
legacy path's internals. It accounts for **42 of the 92** remaining inverted
import lines in the ratchet baseline; the other large residuals
(`from-ast.ts` bridge imports of `dyn-ops`/`control-flow`/`loop-analysis`,
the prepared-support modules) mostly route through the same seam.

A front-end that imports the legacy path's internals can never let that path
be deleted — this is a hard prerequisite for #3518 R10 (direct front-end
deletion), which is why it stays `sprint: current` rather than backlog.

## Why blocked

The R1 (#3520) and R2 (#3521) lanes actively edit `integration.ts`; moving
or splitting the file now would conflict with every in-flight prepared-
pipeline transaction. Unblocks when #3520 and #3521 reach `done`.

## Scope (from #3113's original step 2, re-grounded)

- Move the bridge to the codegen side (`src/codegen/ir-bridge.ts`) or split
  it behind a narrow IR-side interface, so its ~42 codegen imports become
  same-layer imports.
- Re-classify the `from-ast.ts` category-(b) imports (see PR #4689's table:
  `remainder-fast-path` near-leaf pair, `ir-native-map`, `dyn-ops`,
  `loop-analysis`, `control-flow`) — each either moves down with its own
  leaf-proof or routes through the bridge interface.
- Ratchet the `check:ir-layering` baseline down with each landed step
  (`--update` in the same PR); the endgame is #3113's original "grep empty
  outside a documented exception list".

## Acceptance criteria

- [ ] `ir/integration.ts` (or its successor) no longer lives under `src/ir/`
      with codegen imports, OR its IR-side remainder imports codegen only
      through one documented narrow interface module.
- [ ] `check:ir-layering` baseline ≤ 50 total lines after landing (from 92),
      with each decrease banked in the landing PR.
- [ ] `prove-emit-identity check` IDENTICAL for every pure-motion commit;
      behavior-affecting refactors carry their own differential evidence.
- [ ] ts7 typecheck, `check:ir-fallbacks`, `check:ir-only`, equivalence gate
      all green.
