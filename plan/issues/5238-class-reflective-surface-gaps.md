---
id: 5238
title: "Host-lane reflective surface gaps on compiled classes: accessor descriptors lack get, Symbol.toStringTag is undefined, Object.create proto identity lost"
status: ready
sprint: current
priority: medium
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-08-31
---

# #5238 — compiled-class reflective surface gaps (host lane)

## Problem

Three measured, pre-existing gaps in the host-lane reflective surface of
compiled classes, all reproduced on plain user classes in one module
(controls in `tests/issue-5223-instance-tostring-dispatch.test.ts` and the
#4628 harness):

1. `Object.getOwnPropertyDescriptor(P.prototype, "y")` for a class accessor
   returns a descriptor with **no `get` slot** — the descriptor surface is
   separate from the #5223 dispatch surface. Standalone answers correctly
   via #4455.
2. `Symbol.toStringTag` on a compiled instance answers `undefined`, so
   `Object.prototype.toString.call(inst)` reports `[object Object]` even
   when the class declares `get [Symbol.toStringTag]()`. Recorded as the
   `instanceToStringTag` gap in `tests/dogfood/temporal-global-harness.mjs`.
   test262 asserts toStringTag on every Temporal class.
3. `Object.getPrototypeOf(Object.create(P.prototype)) === P.prototype` is
   `false` in the host lane (`true` for `new P()`, and `true` in the
   Temporal provider lane) — prototype identity is not preserved through
   the host proxy.

## Direction

All three live in the host proxy / `wasm-struct-host-semantics.ts` surface,
not codegen. (1) wire `__call_get_*` into the descriptor materialization;
(2) support symbol-keyed accessors in the member-kind surface (the current
`__member_kind_<key>` scheme is string-keyed — needs a well-known-symbol
mapping); (3) make the proxy's `getPrototypeOf` trap answer the registered
prototype object identity.

## Acceptance criteria

1. Each gap covered by tests failing on base, host lane, with the existing
   base-pinned rows flipped rather than deleted.
2. Flip the harness `instanceToStringTag` gap.
3. No regressions in issue-5223/5221/4628 files. Gates green.

## Notes

- Found by dev-5223 (PR #5339 items 2–4), each with a control proving it
  pre-existing. Split from #5237 (cross-module resolution) — these are
  single-module host-lane gaps.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.
