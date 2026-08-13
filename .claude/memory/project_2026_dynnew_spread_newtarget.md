---
name: project_2026_dynnew_spread_newtarget
metadata: 
  node_type: memory
  type: project
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

#2026 dynamic-`new K()` follow-ups after PR-1/PR-1b landed (the tag-dispatch ABI
in `emitDynamicNewFallback`, `src/codegen/expressions/new-super.ts`):

- **PR-3 = PR #1699** (sdev-ctor, branch `issue-2026-pr3a-spread`): spread +
  new.target, ONE PR (folded after a split/reverse whipsaw — final: both in
  #1699). PR-3a flattens an array-literal spread via the shared `flattenCallArgs`
  before the arg-eval loop (`new K(...[a,b])` and `new K(4,...[5])` → work). A
  non-flattenable (variable) spread is a LOUD compile-time `reportError`, NOT a
  fall-through — because the legacy `__new_` path trips the #2043/#51
  `global index out of range — -1` BINARY-EMIT crash in standalone/wasi (verified
  on main); the loud refuse is a correctness fix, not just UX. PR-3b threads
  new.target via the shared `emitSetNewTargetBeforeCall(ctx, fctx.body,
  className)` in `buildCtorArm` (was 0; id-compare matches
  `getOrAssignClassNewTargetId`). WAT-diffed plain `new K(7,9)` byte-identical
  (new branch gated on `rawArgs.some(isSpreadElement)`).

- **PR-2 = PR #1704** (a PARALLEL session, branch
  `issue-2026-class-first-class-new`): `.constructor === A` on an externref/`any`
  receiver. NOT mine — do not duplicate. The static-typed receiver already works
  (`property-access.ts:3555`, gated on `ctx.classSet.has(typeName)` →
  `emitLazyClassObjectGet`). The externref-receiver fix reads the instance `__tag`
  (field 0) and tag-dispatches to the `__class_<Name>` singleton.

- **#53 (sdev-ctor next, branch `issue-2026-dynnew-argv`)**: make variable spread
  WORK, removing PR-3a's refuse. Design (in the #2026 issue file's impl plan):
  extend `emitDynamicNewFallback` to build a RUNTIME `$ObjVecArr` argv + `argc`
  when args contain a non-flattenable spread (reuse the vec-struct `{len,data}`
  extract pattern from `compileSpreadCallArgs`, extern.ts ~519-540; box each
  element); each tag-arm reads `argv[i]` with a runtime `i<argc ? array.get :
  null-extern` instead of compile-time-fixed `argLocals`. Reuse PR-1's flat
  tag-chain — deliberately NOT the architect's funcref-table `$UniformCtor`
  trampoline (more surface + late-import-shift hazard; only needed for a
  first-class ctor `call_ref`, e.g. `Reflect.construct`). Build on #1699's merged
  base so it replaces the refuse, not the raw crash.

KEY FACT: `compileSpreadCallArgs(ctx, fctx, expr, funcIdx, restInfo)` requires ONE
statically-known funcIdx (pushes args for an immediate `call`) — it CANNOT serve
the multi-candidate runtime tag-dispatch. That's why variable spread needs the
runtime-argv build, not a `compileSpreadCallArgs` reuse.

PROCESS: lots of parallel sessions opening #2026 PRs — always `gh pr list -R
loopdive/js2wasm --search "<id> in:title"` before claiming a follow-up. See
[[feedback_no_duplicate_issue_dispatch]] / [[feedback_verify_fix_in_git_not_narrative]].
