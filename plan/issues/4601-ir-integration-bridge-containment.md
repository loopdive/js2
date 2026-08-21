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
# Rename-rekeying grant, NOT a growth allowance. `collectI32CoercedLocals` was
# already 422 LOC and is byte-identical after the move (git reports 99%
# similarity; the only changed line is a doc-comment pointer). The func-budget
# gate keys on `path::name`, so relocating the file below the IR reads as a
# brand-new over-budget function. Splitting it is real work that belongs to
# #3399, not to a pure-motion layering PR — see the 2026-08-21 progress log.
func-budget-allow:
  - src/ir/analysis/i32-coerced-locals.ts::collectI32CoercedLocals
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

## Progress log

### 2026-08-21 — `analysis/` pair move ATTEMPTED, NOT LANDED (leaf-proof fails)

The follow-up PR #4689 teed up — "move the `remainder-fast-path` /
`static-numeric-range` pair below the IR together" — **does not hold on current
main**. Nothing moved; the baseline stays at **92**.

**Why.** #4689's S2 table (row 3) recorded `remainder-fast-path`'s own deps
(`ts-api` + `codegen/analysis/static-numeric-range.js`) but never recorded
`static-numeric-range`'s. Measured on `7a3724747`:

```
codegen/analysis/remainder-fast-path.ts  →  ts-api, ./static-numeric-range.js
codegen/analysis/static-numeric-range.ts →  ts-api, checker/oracle.js,
                                            ../statements/loop-analysis.js   ← not a leaf
```

That third edge is **not** drift since #4689 measured — it was added by
`8e77e6740` ("perf(array): accelerate hot indexOf scans", 2026-08-09), twelve
days *before* #4689 merged and an ancestor of it. So the pair was already
non-leaf when it was classified as the "obvious first candidate"; the table
simply did not carry the second module's deps.

`loop-analysis.js` is #4689's own row 6 — classified **(b) bridge, left** —
because it imports `codegen/closures.js` (3,984 LOC, 54 imports, `CodegenContext`
throughout) and `codegen/statements/tdz.js`. The chain does not terminate in a
leaf, so no relocation-only move set exists that clears the edge.

**Measured effect of doing it anyway** (move performed, measured, reverted):

| | files | import lines |
| - | - | - |
| main @ `7a3724747` | 19 | 92 |
| pair moved to `src/ir/analysis/` | 19 | **90** |

`from-ast.ts` 5→4, `fmod-selection.ts` 2→1, `ir/remainder-fast-path.ts` 1→0,
**new** `ir/analysis/static-numeric-range.ts` 0→1. Ten consumer import lines
rewritten (3 IR-side, 7 codegen-side). Typecheck / emit-identity were not run:
the gate itself rejects the result first —

```
ir-layering ratchet: FAIL — src/ir/ must not grow its dependency on src/codegen/.
  - NEW file with codegen imports: ir/analysis/static-numeric-range.ts (1 import line)
```

**Why the −2 was not banked.** The scalar improves; the invariant does not. The
IR's transitive reach into codegen is **unchanged** — `from-ast.ts:62` and
`ir/analysis/i32-slots.ts:67` already import the same `loop-analysis.js`, so
relocating a third importer inside `src/ir/` moves the edge rather than removing
it, and leaves a module that still blocks legacy-path deletion while looking as
though it does not. Silencing a `NEW file with codegen imports` FAIL with
`--update` is exactly the signal the ratchet exists to raise.

**What would actually unblock it.** `staticIntegerRange` needs one pure-AST
predicate, `loopBodyMutatesIndexOrArray` (a whole-line call at
`static-numeric-range.ts:136`). Two routes, both beyond pure relocation and so
deliberately not taken here:

1. **Extract the pure-AST subset of `loop-analysis.ts` below the IR.** Its two
   deps are `collectReferencedIdentifiers` (pure AST walk, `closures.ts:375`)
   and `collectPatternBindingNames` (`tdz.ts`); a leaf closure exists only if
   both are lifted out of their `CodegenContext`-typed homes. This also clears
   `from-ast.ts:62` and `i32-slots.ts:67` — worth ~4 lines, not 2.
2. **Inject the predicate** as a member of the existing
   `StaticIntegerRangeContext` interface. Cheaper, but changes the module's
   public contract at all 8 call sites and needs its own differential evidence.

Route 1 is the one consistent with #3113's "move vocabulary BELOW the IR".

Issue stays `blocked`: the bridge (#3520/#3521) is the blocker for the main
scope, and this near-leaf branch turns out to need its own decomposition step
rather than a relocation.

### 2026-08-21 — route 1 LANDED: leaf closure lifted, baseline 92 → 83

Route 1 above ("extract the pure-AST subset of `loop-analysis.ts` below the
IR") was executed. The decomposition step the previous entry called for is the
new `src/ir/analysis/ast-scope.ts`.

**What moved** (all pure motion — no signature, no call site, no behavior
change; old homes re-export so no codegen consumer's import changes meaning):

| from | to | why it is a leaf |
| - | - | - |
| `codegen/closures.ts` (5 walks) | `ir/analysis/ast-scope.ts` (new) | `ts-api` + `binding-info` only |
| `codegen/statements/tdz.ts` `collectPatternBindingNames` | same file | pure generator over `ts.BindingName` |
| `codegen/binding-info.ts` | `ir/analysis/binding-info.ts` | `import type { ts }` only |
| `codegen/statements/loop-analysis.ts` | `ir/analysis/loop-shape.ts` | now `ts-api` + `ast-scope` |
| `codegen/analysis/static-numeric-range.ts` | `ir/analysis/static-numeric-range.ts` | `ts-api`, `checker/oracle` (type-only), `loop-shape` |
| `codegen/analysis/remainder-fast-path.ts` | `ir/analysis/remainder-fast-path.ts` | `ts-api` + `static-numeric-range` |
| `codegen/analysis/i32-coerced-locals.ts` | `ir/analysis/i32-coerced-locals.ts` | `ts-api` only |

The five walks lifted out of the 3,984-LOC `closures.ts` are
`isFunctionScopeBoundary`, `collectBindingPatternNames`,
`collectFunctionOwnLocals`, `collectVarAndTopLevelDecls` and
`collectReferencedIdentifiers`. `binding-info.ts` had to travel with them
because it holds the memoized own-locals oracle they register into — leaving it
under `src/codegen/` would have made `ast-scope.ts` itself a new inverted edge,
which is the `NEW file with codegen imports` FAIL the previous attempt hit.

**Ratchet**, banked in the landing PR:

| | files | import lines |
| - | - | - |
| main @ `83973b6e3` | 19 | 92 |
| after route 1 | **15** | **83** |

Four files clear their codegen dependency entirely and drop out of the
baseline: `ir/analysis/i32-slots.ts`, `ir/char-read-loop.ts`,
`ir/fixed-literal-loop-proof.ts`, `ir/remainder-fast-path.ts`. `from-ast.ts`
5→3, `fmod-selection.ts` 2→1, `i32-pure-bitwise.ts` 2→1. **No new file with
codegen imports** — the gate's own PASS is the leaf-proof the previous attempt
could not produce.

**The pair move landed too.** Once `loop-shape.ts` was below the IR,
`static-numeric-range`'s third edge (the one the earlier attempt tripped on)
resolved below the boundary, so the `remainder-fast-path` / `static-numeric-range`
pair became genuinely leaf and moved with the same commit. `i32-coerced-locals.ts`
was already a `ts-api`-only leaf and rode along; it is what empties
`ir/analysis/i32-slots.ts`.

**Evidence.** `prove-emit-identity check` → IDENTICAL, all 60 (file,target)
pairs, run after each of the two commits. ts7 typecheck clean.
`check:ir-fallbacks`, `check:ir-only`, `check:linear-ir`, `check:ir-dialect`
unchanged; LOC budget green (net +69, the new `ast-scope.ts` header).

One **func-budget grant** was needed and is in this file's frontmatter:
`i32-coerced-locals.ts::collectI32CoercedLocals`. It is a rename-rekeying
artifact, not growth — the function was already 422 LOC, git reports 99%
similarity across the move, and the only changed line is a doc-comment pointer.
The gate keys on `path::name`, so relocating the file makes an existing
over-budget function read as a brand-new one. Splitting it belongs to #3399.

**Not done, deliberately.** Route 2 (injecting the predicate through
`StaticIntegerRangeContext`) was not taken — it is a public-contract change
needing its own differential evidence, and route 1 makes it unnecessary. The
`integration.ts` bridge (41 of the remaining 83 lines) is untouched: it is the
`blocked`-on-#3520/#3521 main scope. The AC target of ≤50 total lines is not
met by this PR alone and still needs the bridge containment.
