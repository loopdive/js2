---
id: 6703
title: "lodash standalone-dynamic `optimization-error` is an invalid RAW module, not a wasm-opt failure (classify + fix #6679/#6680; `--inspect-binary` keeps the unoptimized module)"
status: done
sprint: current
created: 2026-09-26
completed: 2026-09-26
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6673, 6679, 6680, 6154]
---

# #6703 — lodash standalone-dynamic: `wasm-opt -O4 did not produce …`

## Problem

After [#6673](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6673-standalone-lodash-closure-capture-stack-balance)
merged, lodash 4.18.1's npm-compat **standalone-dynamic** lane reported

```
optimization-error: wasm-opt -O4 did not produce the measured artifact: wasm-opt -O4 failed:
[wasm-validator error in function baseUpdate] global.set value must have right type, on
(global.set $global$636 (ref.null none))
```

The status reads like an optimizer crash/timeout. It is not: the question
was which of the two it is — an invalid raw module (codegen type bug) or a
wasm-opt crash (report; consider retrying at -O2).

## Implementation Plan

Executed 2026-09-26:

1. **Get the raw module.** `--inspect-binary` wrote nothing on an
   optimization-error, because every lane returned before the write. Added
   `writeUnoptimizedInspectBinary(result)` to
   `scripts/generate-npm-compat-report.mjs` and called it on the three
   standalone optimization-error returns (runtime-dynamic lane, static stage,
   static-dynamic lane).
2. **Classify.** V8 rejects the unoptimized module on its own —
   `Compiling function #1000:"baseUpdate" failed: global.set[0] expected type
   externref, found ref.null of type (ref null 517)` — and
   `wasm-opt --all-features raw.wasm` reports 24 validator errors in 9
   functions. So: **invalid raw module**; wasm-opt only relayed the validator.
   A -O2 retry would not help (the validator runs before any pass).
3. **Two independent bugs** behind the 24 errors, both already filed on
   2026-09-24 and unclaimed:
   - 6 errors (`baseUpdate` `global.set`, 5x closure `struct.new` operand 2 =
     `ref.null none` into an `externref` field) —
     [#6679](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6679-return-call-arg-null-retype-across-global-set):
     `locateOperandProducers` refused `return_call`, so every tail call fell
     back to `fixups.ts`'s one-instruction-per-argument backward walk, which
     paired the bare-call receiver reset's `ref.null.extern` (between
     `global.get`/`global.set $__current_this`) with a struct-typed param.
   - 18 errors (`call param types must match` on `$basePullAt` in three
     closures) —
     [#6680](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6680-lodash-pullat-basepullat-extra-stack-value):
     the no-op arm of `Array.prototype.sort` (non-numeric elements, comparator
     not a compilable closure, native strings) `local.tee`d the receiver and
     never consumed it, so `arrayMap(…).sort(compareAscending)` left TWO values
     and every `basePullAt` operand shifted by one.
4. Fix both (see their files), reduce each to a regression test.

## Resolution

- Classification: invalid raw module (codegen type bugs), not a wasm-opt
  crash/timeout. After both fixes the unoptimized module validates in V8 and
  `wasm-opt --all-features` (0 errors), and `wasm-opt -O4` succeeds.
- `tests/issue-6703-lodash-raw-module-validity.test.ts`: parent 2/5 (the two
  standalone reductions are invalid Wasm, the `locateCallArgProducers` unit
  case has no `return_call` entry; the two `gc` cases are both-lane guards
  that already validate there), fix 5/5.
- Scoped standalone test262 (`built-ins/Array/prototype/sort`,
  `language/expressions/call`, `language/statements/return`; 162 rows,
  `scripts/run-test262-paths.mts --standalone --isolate`): parent 101 pass /
  61 fail, fix 101 / 61, identical non-pass sets.
- JS-host control: lodash dogfood suite 59/62 before and after. The JS-host
  lodash project compile (`--target gc`, `platform: node`) was ALSO invalid on
  the parent (`"baseUpdate" failed: global.set[0] expected type externref,
  found ref.null of type (ref null 42)`); with the fix it validates, and the
  binaries differ by exactly that one operand (`ref.null none` →
  `ref.null noextern`), same byte length.
- lodash standalone-dynamic lane: `optimization-error` → `runtime-error`
  (optimization verified, 2,388,869 bytes, 0 imports); next blocker verbatim:
  `TypeError: Cannot access property on null or undefined at 1468:21`
  (`phase: module-init`, lodash.js `var coreJsData = context['__core-js_shared__'];`
  — `context` is lodash's resolved root object).
- Residual: the no-op sort arm stays a no-op (a comparator sort over
  externref elements whose comparator is not a compilable closure still does
  not sort in standalone) — now valid Wasm, still semantically incomplete.
