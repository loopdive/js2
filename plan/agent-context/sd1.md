# sd1 — session context / handoff (2026-06-19)

Developer on sprint 64 (js2wasm standalone conformance). Winding down after a long
session. This captures in-flight state for resume / handoff.

## Landed or in-flight PRs (all on loopdive/js2)

| PR | issue | what | state at wind-down |
|----|-------|------|--------------------|
| #1727 | #2161 | standalone `String(re)` + template `` `${re}` `` RegExp→string coercion (13 tests) | in merge queue (CLEAN) |
| #1729 | #1322 | docs: Math.random WASI `random_get` already-done reconcile (status→done) | in merge queue (CLEAN) |
| #1736 | #2511 (was #2374) | docs: o[k] dynamic-property-read gap, needs-architect-spec | queue-locked; renumber pending (see below) |
| #1738 | #2375 | docs: object-static-method dynamic-shape CEs (Object.is/fromEntries/propertyIsEnumerable) | in CI/queue |
| #1761 | #2375 | **fix**: native `Object.is` SameValue for same-type scalar args (19 standalone `Object/is` CEs→pass; NaN/±0/string/bool) | in merge queue (CLEAN) |
| #1764 | #2200 | **fix**: Annex B B.3.3 case-A cancellation guard (Phase 1, ~93-test floor) | CI running (101 pass / 30 pending / 0 fail) |
| #1734 | #2371 | (CLOSED) for-in leak — net −89, abandoned | closed; lesson in memory |

## #2200 Phase 2 → handed to sen-1

Branch `issue-2200-annexb-phase2` (stacked on Phase-1 #1764), commit 6b511bd7d,
tsc clean, no debug traces. Scaffolding complete; **4 of 5 sub-behaviors work**:
- TDZ-var outer-binding pre-alloc (`fctx.annexBOuterBindings`, externref local +
  i32 tdz flag) in `nested-declarations.ts`;
- decl-site init (closure value → `local.set` + flag←1) in `statements.ts`
  before the `funcMap.has` early-return;
- value binding (`{ function f(){return 7} } f()`→7), in-block call→9,
  read-before-block→ReferenceError, `if(false){function f(){}}`→flag 0 all PASS.

**Remaining bug (precise pointer for sen-1):** `typeof f` AFTER the block returns
"undefined" not "function". The decl-site init DOES set the flag (verified). Ruled
out the compileStringLiteral arm-split (switched to main-body temp-locals → no
change). Root cause: the bare `typeof f` never reaches the `annexBOuterBindings`
guard in `compileTypeofExpression` (`typeof-delete.ts:~877`) in the non-ambient
case — TS resolves bare `f` to the hoisted block-function symbol and something
upstream const-folds `typeof f` first. With `declare const f` it DOES reach the
guard and works → confirms it's the resolution path, not the branch logic. Next:
trace why typeof-of-block-fn-symbol bypasses the identifier guard; the guard may
need to move earlier or also catch the function-typed symbol.

## Pending follow-up: renumber o[k] issue #2374→#2511 (task #44, unowned)

PR #1736 lands the o[k] issue with OLD `id: 2374`, colliding with sd4's #2374
(destructuring NamedEvaluation .name). After #1736 merges: rename the o[k]
dynamic-property-read-runtime-key issue file (slug
`2374-standalone-dynamic-property-read-runtime-key`, written without the `.md`
path here so the `check:issues` link gate does not treat this future-intent note
as a live issue link) → `2511-...`, `id: 2374`→`2511`, H1 `# #2374`→`# #2511`. sd1
prepared this on branch `issue-2374-dynamic-prop-read-runtime-key` (commit
187438bc0) but couldn't push while #1736 was queue-locked. `check:issues`
validates the index — do it promptly.

## Key lesson banked (in memory)

`project_standalone_leak_harness_satisfies_imports.md`: standalone host-import
"leaks" found via an **empty importObject** probe are often benign — the test262
standalone harness PROVIDES those imports, so gating/refusing one regresses real
passes (cost: #1734 net −89). Never gate/refuse a standalone leak without
validating against the real harness + a working native replacement. Pure-additive
native lowerings (Object.is, String(re)) are safe; refusals that demote a working
path are not.

## Worktrees left (clean, on branches; safe to remove after their PRs land)
- issue-2161-regex-string-coercion (#1727)
- issue-1322-mark-done (#1729)
- issue-2374-dynamic-prop-read-runtime-key (#1736 + renumber WIP)
- issue-2375-object-static-dynamic-shape-ce (#1738)
- issue-2375-object-is-native (#1761)
- issue-2200-annexb-block-fn-hoist (#1764)
- issue-2200-annexb-phase2 (Phase 2 WIP → sen-1)
