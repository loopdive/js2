---
id: 6683
title: "standalone: `<any array>.slice(0)` answers null (`id([1,2,3]).slice(0)`) — moment's next standalone-dynamic blocker"
status: done
sprint: current
created: 2026-09-26
updated: 2026-09-26
completed: 2026-09-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6678, 6447, 2717, 6676]
loc-budget-allow:
  # 2026-09-26 (#6683) — the mechanism is the new module
  #   `src/codegen/array-slice-native.ts`. string-ops.ts gains one import and
  #   the widened gate condition (+3-line comment) at the guarded
  #   native-string call; closed-method-dispatch.ts gains the one-line
  #   Array-subclass own-method shadow test on the #6447 producer arm.
  #   any-helpers.ts +18 is the documented `reserveAnyToF64Handle` helper
  #   (4 code lines + its rationale) and its one call in `ensureAnyHelpers`:
  #   the reservation has to live beside the helper registry it pre-empts.
  - src/codegen/string-ops.ts
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/any-helpers.ts
func-budget-allow:
  # 2026-09-26 (#6683) — `ensureAnyHelpers` +1 (the call to the new
  #   `reserveAnyToF64Handle`, whose rationale lives on that helper; the
  #   addHelper line is changed, not added). `fillClosedMethodDispatch` +1,
  #   the shadow-test spread on the producer arm, same as #2927's mutator arm.
  - src/codegen/any-helpers.ts::ensureAnyHelpers
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
coercion-sites-allow:
  # 2026-09-26 (#6683) — `__unbox_number` +1 in array-slice-native.ts: the
  #   ToIntegerOrInfinity of slice/at arguments, a CALL into the engine's
  #   runtime entry point (the same token and the same simplification #2717's
  #   `flat` depth argument uses), not a hand-rolled matrix.
  - src/codegen/array-slice-native.ts
---

# #6683 — standalone: `.slice(0)` on an `any` array receiver answers null

## Problem

After #6678, moment's npm-compat `standalone-dynamic` lane gets past
validation (`moment(1577923200000).format("YYYY-MM-DD")` is right) and fails
the checksum phase on the string-input workload with (verbatim):

```
TypeError: Array.prototype.some called on null or undefined
```

moment's string parser ends `configFromStringAndFormat` with
`getParsingFlags(config).parsedDateParts = config._a.slice(0);` and `isValid`
then runs `some.call(flags.parsedDateParts, …)`. `config` is a parameter, so
`config._a` is an `any` array, and its `.slice(0)` answers null.

Minimal repro (`--target standalone`, measured 2026-09-26 on the #6678 branch):

```js
function id(v) { return v; }
id([1, 2, 3]).slice(0);            // null        (expected: a 3-element copy)
function run2(c) { c._a = [2020, 0, 2]; return c._a.slice(0); }
run2({});                          // null
var c = {}; c._a = [1, 2, 3]; c._a.slice(0);   // ok (length 3) — receiver typed locally
```

## Acceptance

- The rows above answer a copied array in `--target standalone`, no new host
  import.
- Re-run `npx tsx scripts/generate-npm-compat-report.mjs --only moment
  --no-write --perf-only --lane standalone-dynamic` and record the next status.

## Implementation Plan

Executed as written, 2026-09-26.

1. **Why null.** `slice` and `at` are also `String.prototype` names, so an
   `any`-receiver call is claimed by `compileGuardedNativeStringMethodCall`
   (string-ops.ts). Its `ref.test $AnyString` miss arm answers the string
   method's sentinel (`ref.null $AnyString` ⇒ null). `reverse` is not a string
   name; it reaches the closed-method dispatcher, whose open-`$Object` arm
   answers `undefined` for a vec brand. (`concat`/`map`/`filter` were already
   right: #6447 / #3098 arms.)
2. **Native bodies** — new `src/codegen/array-slice-native.ts`:
   `__arrprod_slice` (§23.1.3.28), `__arrprod_at`, `__arrprod_reverse`
   (§23.1.3.26, in place) on the #6447 array-like substrate
   (`__extern_length`/`__extern_get_idx`/`__extern_set`/`__objvec_*`), minted
   at reserve time. Registered in `DYN_ARRAY_PRODUCER_METHODS` the way #2717
   routed `flat`, so the dispatcher's `$__vec_base` producer arm serves them.
3. **Route the string-name collision** — the guarded string call's #3673
   "widen to the dispatcher" arm now also fires, in standalone, for
   `STRING_ARRAY_SHARED_METHODS` (`slice`, `at`): string receivers keep the
   native arm; everything else goes through `__call_m_<name>_<n>`, whose vec
   arm is step 2 and whose `$Object` arm keeps user methods.
4. The producer arm also takes the #2917 Array-subclass own-method shadow test
   (byte-identical unless a subclass declares the name).

## Resolution

Measured with the moment lane; two defects sat IN FRONT of the slice on
current main and are fixed here too, because the lane cannot reach the
slice without them:

- **`ensureAnyHelpers` re-entrancy** (the lane's CE on main since
  2026-09-26 ~08:00, verbatim prefix: `stack-balance (#2090): cannot supply a
  missing stack value in function "__native_globalThis_ensure"`).
  `ensureAnyHelpers` claims `anyHelpersEmitted`, then calls
  `ensureObjectRuntime`, whose seeder flush can build the globalThis seed; the
  `Math` carrier's `max`/`min` value closures need `__any_to_f64`, which was
  not registered yet, so they declined and the seed kept `max`/`min` keys with
  no value. Fix: `reserveAnyToF64Handle` mints the stable handle up front
  (physical layout unchanged — a 28-file × 3-config corpus stays
  byte-identical).
- **`runtimeEvalProvider: false` still imported `js2wasm:runtime-eval`**
  (`__runtime_indirect_eval`, `__runtime_apply_interpreted`) for moment's bare
  `Function` read (reached from `Object.prototype.toString`'s `@@toStringTag`
  read during module init). `moduleReadsBareFunctionValue` now answers false
  when no provider is linked (#6676 precedent), so every `%Function%` read
  takes the self-contained carrier together and identity stays one reference.

moment `standalone-dynamic` (`--no-write --perf-only`):

| | status |
| --- | --- |
| before (main 36f92e8917) | `compile-error` — `stack-balance (#2090) … "__native_globalThis_ensure"` |
| after | `measured` — checksum right; Wasm 12,941 µs vs Node 5.3 µs per op |

A/B: with the two companion fixes but WITHOUT the slice fix the lane's
workload throws (the #6683 `some.call(null)` path); with it, 10 per op.

- Regression tests: `tests/issue-6683-any-array-slice.test.ts` (7) and
  `tests/issue-6683-any-helpers-reentry.test.ts` (1): 7 of 8 fail on the
  parent, 8 of 8 pass (the string/user-slice control passes both ways). The
  #6447 residual pin now asserts slice/reverse/flat right and pins `splice`.
- Scoped standalone test262 (Array.prototype.{slice,at,reverse},
  String.prototype.{slice,at}, Math.{max,min}, Object.getPrototypeOf,
  Function.prototype.constructor — 211 rows): parent 176 pass, fix 176 pass,
  identical failing set, no losses.
- acorn standalone-dynamic (the `slice` tokenizer hot path now widens):
  152 ms → 142 ms per parse (noise-level), binary +7 KB (0.3%).
- JS-host moment dogfood control: 10/10.

Residuals: [#6701](./6701-standalone-any-receiver-array-residuals.md)
(`splice`, `[].slice.call(arguments, k)`, `Math.max.apply`), and
[#6702](./6702-moment-standalone-dynamic-perf.md) (lane is ~2400× slower than
Node). Holes inside a sliced range come back as `undefined` and species is a
plain Array (documented in the module header).
