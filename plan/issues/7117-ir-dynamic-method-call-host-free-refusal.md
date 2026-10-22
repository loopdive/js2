---
id: 7117
title: "IR: dynamic method calls answer `undefined` off the host lane — keep them legacy until brand dispatch exists"
status: in-review
sprint: current
created: 2026-10-22
updated: 2026-10-22
priority: high
horizon: s
feasibility: medium
reasoning_effort: max
task_type: bugfix
area: ir
goal: ir-full-coverage
parent: 7106
assignee: "ttraenkler/session-d"
# 2026-10-22 (#7117): one guard line in the scan's dynamic method arm plus the
# `dynamicMethodCallIsExact` predicate it calls.
loc-budget-allow:
  - src/ir/select.ts
func-budget-allow:
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::scanExprInner
---

# IR: dynamic method calls answer `undefined` off the host lane

Parent: [#7106](7106-ir-test262-harness-units.md). This is live wrong code on
origin/main, found while doing #7106 Stage 4.

## Problem

The move-only scan admits `recv.m()` and `recv.m(x)` on a dynamic receiver
(#3053 U2 / #2949). from-ast lowers that through the generic
`__ir_dyn_method_call_N` → `__extern_method_call`:

- On the host lane, `__extern_method_call` is the real JS call.
- Off it (standalone, wasi, the native regime), the native object runtime
  (`object-runtime.ts` §`__extern_method_call`) dispatches only open-`$Object`
  methods and the instance/vec/closure property bags. The source comment
  says so: the brand arms for primitives, vecs and Map/Set are "Slice-4 …
  they return undefined here for now". Only the string runtime's
  `charCodeAt`/`slice`/`concat` fast path is exact for a string receiver.

Legacy handles the same call sites with brand dispatch by method name
(`standalone-primitive-tail.ts`, the array and string method compilers), so
the IR and legacy disagree.

**Measured on origin/main (bcfdc55a5e), JS module, standalone.** In
`tests/issue-7117-ir-dynamic-method-call-host-free.test.ts`, `t(x) {
return x.toString(); }`, `u(s) { return s.toUpperCase(); }` and
`k(list) { return list.indexOf(2); }` were all IR bodies. Each was called
with a vec or string and also with an object literal, so legacy keeps the
parameter as externref and ABI parity holds. `run()` returned **101010**;
node returns 111111. Every vec or string receiver was wrong, and every
object-literal receiver was right.

## Fix (stopgap)

There is a new backend capability, `host-dynamic-method-call` (wasmgc with
host imports). Without it, the scan's dynamic method arm refuses the call,
so the function stays legacy. Two forms stay admitted:
- `charCodeAt`, which only a string receiver answers, through the exact fast
  path;
- the narrow literal `replace(/_/g, "")`, which has its own native helper.

The host lane is unchanged.

The real fix is a per-(method, arity) runtime wrapper with legacy's brand
dispatch, after which this refusal can be lifted. That is a follow-up
(#7106 Stage 4, option (a)).

## Not fixed here

`j(list) { return list.join(", "); }`, called with a vec and with an object,
is ALSO wrong in legacy on standalone: legacy's own any-receiver `join` misses
the vec brand. With this fix the result is legacy's, which is wrong in the
same way. Measured: `j([1, 2])` returns `undefined`-shaped.

## Acceptance

`tests/issue-7117-ir-dynamic-method-call-host-free.test.ts`:
- On standalone, `t`, `u` and `k` are not IR bodies and `run()` equals node
  (111111).
- On the host lane, the same source still runs to 111111.
