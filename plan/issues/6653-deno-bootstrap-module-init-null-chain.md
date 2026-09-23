---
id: 6653
title: "deno_core bootstrap __module_init: destructure-null / in-fold / inline-class-prototype chain"
status: done
sprint: current
assignee: ttraenkler/claude
created: 2026-09-20
updated: 2026-09-20
completed: 2026-09-20
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
goal: standalone-gap
related: [4376, 862, 5221, 4618, 2660]
origin: "2026-09-20 — resumed #4376 deno bootstrap; __module_init threw 'Cannot destructure null or undefined' (post-#5202)."
loc-budget-allow:
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/binary-ops-in.ts
  # 2026-09-20 slice 2: +137 — emitCollectionMethodBody, the reflective
  # Map/Set proto method bodies over the existing __map_*/__set_add kernels
  # (the makeSafe dummy-probe blocker; turns issue-4376-deno-core-bootstrap
  # green).
  - src/codegen/array-object-proto.ts
func-budget-allow:
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
  - src/codegen/binary-ops-in.ts::compileInOperator
---

# deno_core bootstrap `__module_init` failure chain

## Problem

`tests/issue-4376-deno-core-bootstrap.test.ts` fails at `__module_init` with
`TypeError: Cannot destructure 'null' or 'undefined'`. Payload rendered via
`__exn_tag` + `__exn_render_prepare`; statement-trace localization
(`JS2WASM_TRACE_LAST_STMT`) pinned it to `00_primordials.js` `copyAccessor`
calls, culprit key `JSON.parse` (a DATA property).

## Three compiler defects, fixed in this change-set (2026-09-20)

1. **Nested-function binding-pattern params never widened (#862 gap).** Both
   param-typing derivations in `statements/nested-declarations.ts` lacked the
   `bindingPatternParamNeedsWiden` widen that top-level declarations and lifted
   closures have. A nested `function copyAccessor(dest, prefix, key,
   { enumerable, get, set })` pinned its pattern param to one nominal
   `__anon_*` struct; every caller holding a different runtime shape (here: the
   native gOPD's dynamic descriptor `$Object`) failed the guarded cast and
   passed **null**, and the pre-body destructure threw. Fix:
   `nestedBindingPatternParamNeedsWiden` applied at both sites (registration +
   fork-decision twin), routing the pattern through the externref destructure
   path. Witness: `.tmp`-class probe — nested `acc(key, {enumerable,get,set})`
   over `{a:1, get b(){}}` answers 101 (data + accessor both right).

2. **`in` fold answered true from an OPTIONAL declared property.**
   `compileInOperator`'s `tsTypeHasProperty` accepted any checker property —
   lib.es5's `PropertyDescriptor` declares `get?`, so `"get" in desc` folded
   TRUE for every data descriptor, routing every data prop through the
   primordials copier's accessor arm (breaks `ObjectSetPrototypeOf` et al —
   stored under `Get`-prefixed names, later call throws "called value is not a
   function"). Fix: an optional property (SymbolFlags.Optional) no longer
   folds positive; externref/anyref receivers take the runtime `__extern_has`
   arm. Witness probe: data-descriptor `{"get" in desc, "zzz" in desc,
   "value" in desc, typeof desc.get}` = 443 exact (was 1442).

3. **Inline (argument-position) class expression lost its prototype edge.**
   The #4618 gate materialized the class-object singleton only in ASSIGNMENT
   position; an inline `makeSafe(Map, class SafeMap extends Map {…})` value
   rode the callable-closure representation, which has no singleton identity,
   so the callee's `safe.prototype` read answered undefined and the
   bootstrap's gOPD threw "called on non-object". Fix: on standalone/wasi the
   gate widens to every value position (host lane unchanged — its inline class
   values must stay host-callable). Witness: `f(class Safe {})` +
   `safe.prototype == null` → non-null (was null); `#4618` suite stays green.

## Slice 2 (same day): collection reflective method bodies

After the three fixes `__module_init` advanced to `makeSafe`'s dummy-probe
loop and threw `Map.prototype.clear is not yet implemented`. Fixed:
`emitCollectionMethodBody` (array-object-proto.ts) gives the Map/Set proto
member closures real brand-checked bodies over the existing kernels — Map
clear/delete/get/has/set, Set add/clear/delete/has, and entries/keys/values
returning the same live `$__IterRec` record `emitLiveCollectionIterRec`
builds (so `%MapIteratorPrototype%.next`'s #6484 family check adopts it).
Members without a kernel (forEach, getOrInsert*, set algebra) keep the
catchable refusal.

**Result: `tests/issue-4376-deno-core-bootstrap.test.ts` is GREEN** — all
stages (wrappers/module/info-arrays/hello-world usage) answer the
checkpoint's expected values, host ops round-trip, hello-world output exact.
The artifact byte envelope re-centred 10 MiB → 6.46 MB (the inline-class
singleton route collapsed duplicated per-class closure machinery; measured
base-vs-head, behavioral checkpoints identical).

## Validation (2026-09-20)

- Repro probes above; bootstrap probe advances past the primordials copier.
- `tests/issue-4376-deno-primordials-runtime.test.ts` 17/17,
  `tests/issue-4618-assigned-class-host-bridge.test.ts` all green,
  `issue-5316` 22 passed.
- Pre-existing failures confirmed pre-existing by base-source A/B:
  `issue-2992` (5, host lane), `issue-4062` (2, host lane), `issue-3981`
  "links the instance to the constructor's prototype", and the
  `issue-4376-deno-infra-destructure` vitest-fork OOM.
- prettier clean; compiler `import('./src/index.ts')` LOAD OK; coercion /
  oracle / dead-exports gates green; loc/func growth granted above.
