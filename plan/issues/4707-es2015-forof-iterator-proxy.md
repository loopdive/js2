---
id: 4707
title: "ES2015 for-of iterator-as-proxy dispatch"
status: done
sprint: current-main
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: high
task_type: bugfix
area: codegen, runtime
language_feature: for-of, iterator, proxy
es_edition: es2015
source_loc_budget: 180
loc-budget-allow:
  - src/codegen/closures.ts
  - src/codegen/declarations.ts
  - src/codegen/iterator-native.ts
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/iterator-native.ts::fillNativeIteratorLateArms
---

# ES2015 for-of iterator-as-proxy dispatch

## Baseline (live current main)

The baseline is the freshly fetched `upstream/main` commit
`d455e14cc37583221a682810123f7878f5185f8f` (2026-08-25). The linked Test262
submodule is `b363f29d3c43c626dc852744ad64a0b48a003693`.

The exact target is
`test262/test/language/statements/for-of/iterator-as-proxy.js`. It fails in both
execution lanes with the same null-closure symptom:

| lane | result | diagnostic | wasm sha |
| --- | --- | --- | --- |
| host | fail | `RuntimeError: dereferencing a null pointer in __closure_61() at source L27 (via __call_fn_method_0@L35 <- __\\0js2_call_fn_method_argc_0@L35 <- __module_init@L30) \\| at L32: assert.sameValue(x, 23);` | `641abe5101d6` |
| standalone | fail | `RuntimeError: dereferencing a null pointer in __closure_72() at source L27 (via __call_fn_method_0@L35 <- __apply_closure@L300 <- __module_init@L30) \\| at L32: assert.sameValue(x, 23);` | `b60f31b6a516` |

Known-good synchronous iterator controls, run against the same commit, pass in
both lanes:

- `test262/test/language/statements/for-of/generic-iterable.js` (host sha
  `3b9b9f0b74bd`, standalone sha `6ba6e722b18b`)
- `test262/test/language/statements/for-of/head-expr-obj-iterator-method.js` (host sha
  `8d5ae71ef7a6`, standalone sha `11ff3bff4cf8`)

The baseline command used `runTest262File` for the target and controls with a
120-second per-file timeout and both the default host and `standalone` targets.

## Scope and exclusions

This is limited to synchronous `for (var x of iterable)` iterator acquisition
and `next` dispatch when the iterator returned by `Symbol.iterator` is a Proxy.
It excludes Proxy `ownKeys` (#4685/#4902), destructuring, async iteration,
Set/Map iteration, IteratorClose, and lexical bindings. The upstream GitHub
issue number is already used by an unrelated merged documentation issue; this
file tracks the delegated local #4707 work item only.

## Working hypothesis

The ordinary iterator object path works, but a Proxy returned as the iterator is
not recognized by the native iterator dispatcher (and the host bridge reaches a
null closure environment). A bounded fix should route Proxy iterator property
reads/calls through the existing Proxy/runtime dispatch while preserving the
ordinary object and generic iterable paths.

## Plan

1. Add focused Proxy iterator controls and inspect generated WAT/runtime paths
   for host and standalone dispatch.
2. Implement the smallest shared synchronous Proxy iterator dispatch fix,
   keeping the compiler source change under 180 lines.
3. Run the exact target plus the two passing controls in both lanes and run
   focused direct Proxy/iterator controls.
4. Fetch and merge the latest upstream `main` (no rebase), rerun scoped checks,
   push, and open the upstream PR without merging it.

## Acceptance

- The exact target passes in host and standalone lanes.
- The two known-good iterator controls remain passing in both lanes.
- Focused synchronous Proxy/get and iterator controls pass without changing
  excluded Proxy protocols or iteration features.
- No broad Proxy protocol behavior is introduced; changed compiler source stays
  at or below 180 lines.
- The plan records scoped test results after implementation and after merging
  latest upstream `main`.

## Test Results

Implementation on the same current-main base passes the exact target and the
two synchronous iterator controls in both lanes:

| file | host | standalone |
| --- | --- | --- |
| `iterator-as-proxy.js` (exact) | pass (`be27fa697eac`) | pass (`5d0851a2b0e0`) |
| `generic-iterable.js` | pass (`3b9b9f0b74bd`) | pass (`d3e6c92d5118`) |
| `head-expr-obj-iterator-method.js` | pass (`8d5ae71ef7a6`) | pass (`1cece8af4638`) |

The fix keeps Proxy iterator carriers dynamic at each representation boundary:
module-level `new Proxy` bindings remain externref, closures returning those
bindings preserve externref, and native iterator kind/result dispatch accepts
the `$Proxy` carrier alongside `$Object`. No runtime protocol code changed.

After merging `upstream/main` at `2ac130ac4e` (merge commit
`26210087e`), the same six scoped runs remained green:

| file | host | standalone |
| --- | --- | --- |
| `iterator-as-proxy.js` (exact) | pass (`be27fa697eac`) | pass (`75a688c4a418`) |
| `generic-iterable.js` | pass (`3b9b9f0b74bd`) | pass (`c3676b2ca790`) |
| `head-expr-obj-iterator-method.js` | pass (`8d5ae71ef7a6`) | pass (`04df90f9ac4d`) |

The TypeScript 5 typecheck and scoped Prettier/Biome checks also pass.
