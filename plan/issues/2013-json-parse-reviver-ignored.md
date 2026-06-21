---
id: 2013
title: "JSON.parse reviver argument silently ignored (parse arm compiles only arguments[0]; host import drops it)"
status: blocked
blocked_on: [23]
sprint: 65
created: 2026-06-10
updated: 2026-06-14
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: host-interop
language_feature: json
goal: core-semantics
related: [787]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2013 — reviver never invoked, side effects lost

## Problem

```ts
JSON.parse('{"a":1,"b":2}', (k, v) => typeof v === "number" ? v * 10 : v)
// wasm: {"a":1,"b":2}   node: {"a":10,"b":20}
```

## Root cause

`src/codegen/expressions/calls.ts:5516-5604` — the `JSON.parse` arm
compiles only `arguments[0]` (the stringify arm handles extra args; the
parse arm doesn't), and the host import `src/runtime.ts:4938` is
`(s) => JSON.parse(s)`, dropping the reviver entirely.

## Fix direction

Compile the reviver through the closure→host-callback bridge (same
machinery as array HOF callbacks) and forward it in the import.

## Acceptance criteria

- Repro matches Node; reviver `this`/key/value per §25.5.1
- No-reviver calls unchanged

## Dupe check

Only #787 (done, one test262 reviver test in a wrong-values bucket). New.

## Resolution (2026-06-14, dev-a)

Reproduced on current main: `JSON.parse('{"a":1,"b":2}', reviver)` returned the
unfiltered object (reviver never invoked).

### Fix

- `src/codegen/expressions/calls.ts` — the host-import `JSON.parse` arm now
  forwards the reviver (arg 2) coerced to externref, or `ref.null.extern` when
  absent (mirroring how the `stringify` arm forwards replacer/space). A WasmGC
  closure reviver coerces like any other ref and is bridged host-side.
- `src/codegen/declarations.ts` + `src/codegen/index.ts` — the `env::JSON_parse`
  import signature changed from `(externref) -> externref` to
  `(externref, externref) -> externref`. **This 2-param bump is load-bearing:**
  calls.ts always pushes the reviver slot now, so a 1-param import desyncs the
  Wasm call arity (caught locally — the no-reviver path broke until both
  declaration sites were updated).
- `src/runtime.ts` — `JSON_parse` is now `(s, reviver) => …`: parse via host
  `JSON.parse`, then if the reviver is callable (JS function OR WasmGC closure
  via `__call_fn_2`, guarded by `_isCallableReviver`) apply §25.5.1.1
  `_internalizeJSONProperty` over the plain JS result tree (array indices in
  order, then object keys in source order; recurse child-first; reviver return
  substitutes, `undefined` deletes; root visited under the `""` key). The
  reviver is dispatched through the existing `_invokeJsonCallable` bridge.

### Test results

`tests/issue-2013.test.ts` — 7/7 pass: numeric-leaf transform (headline repro),
undefined→delete, nested objects + array indices, root empty-string key,
no-reviver unchanged (access + round-trip), bottom-up (child before parent).
No regressions: `issue-1342-json`, `issue-1636-json-stringify`,
`json-parser-test` green; `json.test.ts`/`json-stringify.test.ts` each have ONE
pre-existing failure ("compiles JSON.stringify to host import call" — a stale
WAT-snapshot assertion, fails identically on baseline main, unrelated to this
change).

## HELD on #23 (2026-06-14) — net-negative test262 gate

PR #1454's `check for test262 regressions` came back **net -1**: +3 improvements
(reviver-call-err / reviver-call-order / reviver-get-name-err — the reviver is
finally invoked) but -4 (reviver-{object,array}-non-configurable-prop-{create,
delete}). All 4 regressions do `Object.defineProperty(this, …)` inside the
reviver — they require the reviver's `this` to be the holder.

Attempted the `__call_fn_method_N` receiver-binding fix (#2015): `_invokeJsonCallable`
now dispatches the reviver via `__call_fn_method_<arity>` with the holder as
receiver, installing it into `__current_this` (committed — correct plumbing,
no NEW regression, forward-compatible). But the 4 still fail: the reviver
closure is compiled **without `readsCurrentThis`** (the compiler can't tell at
compile time that a closure passed to `JSON.parse` will be method-invoked), so
its body's `this` doesn't read the installed `__current_this` →
`Object.defineProperty(this,…)` still gets `undefined`. Marking
reviver/replacer-arg closures `readsCurrentThis` is the genuine Slice-C work —
filed as senior task **#23**. Per the do-not-bypass-the-conformance-gate policy,
#2013 is **held (status: blocked, blocked_on: 23)**; the impl is committed on
branch `issue-2013-json-parse-reviver` and lands net-positive once #23 marks the
closures. The same #23 fix also unblocks the JSON.stringify replacer-`this`
Slice-C `.skip`.
