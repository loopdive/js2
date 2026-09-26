---
id: 6678
title: "standalone: a Date stored in an object property loses its methods on read-back (`o._d.getTime()` → undefined) — moment's next standalone-dynamic blocker"
status: done
sprint: current
created: 2026-09-24
updated: 2026-09-26
completed: 2026-09-26
loc-budget-allow:
  # 2026-09-26 (#6678/#6681): one import + one finalize call per pipeline in
  # index.ts, one mint call at the standalone `new Date` site, and the
  # `Date.now` value-closure case; the mechanism lives in
  # date-carrier-dynamic-member.ts.
  - src/codegen/index.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/builtin-value-read.ts
func-budget-allow:
  # 2026-09-26 (#6678/#6681): the same one-line hooks as above.
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/codegen/builtin-value-read.ts::ensureStandaloneBuiltinStaticMethodClosure
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
related: [6674, 6671, 5208, 6681, 6683]
---

# #6678 — standalone: Date methods vanish through an object property

## Problem

After #6674, moment's npm-compat `standalone-dynamic` lane passes module-init
and reaches the checksum, which is wrong:

```
checksum mismatch: Wasm 12, Node 10
```

`12` is `"Invalid date".length`: every moment is invalid in standalone, even
`moment(1577923200000)`. moment keeps its Date in `this._d` and validates it
with `this._d.getTime()`; in standalone that call answers `undefined`, so
`isNaN(...)` makes the moment invalid.

Minimal repro (`--target standalone`, no moment, measured 2026-09-25 on the
#6674 branch merged with main `1b733c858e`):

```js
function box(v) { var o = {}; o._d = v; return o; }
var b = box(new Date(1577923200000));
var a = [new Date(1577923200000)][0];
```

| expression | standalone | expected |
| --- | --- | --- |
| `a.getTime()` (array element) | `1577923200000` | same |
| `b._d.getTime()` | `undefined` | `1577923200000` |
| `b._d.getFullYear()` | `undefined` | `2020` |
| `typeof b._d.getTime` | `"undefined"` | `"function"` |
| `b._d.valueOf()` | the `toString()` text | `1577923200000` |
| `Object.prototype.toString.call(b._d)`, `b._d instanceof Date` | `[object Date]`, `true` | same |

So the carrier survives the property round-trip (brand and `instanceof` are
right), but a member read on the untyped property value does not reach the
`Date.prototype` methods. `valueOf` falls to the generic `Object.prototype`
path.

The earlier content of this issue (a `console.warn` VALUE read threw) was fixed
on main by #6671 before this issue was picked up; re-probed 2026-09-25:
`typeof console.warn` → `"function"`, `console.warn ? "t" : "f"` → `"t"`.

## Acceptance

- Every row above answers the expected value in `--target standalone`, with no
  new host import.
- Re-run `npx tsx scripts/generate-npm-compat-report.mjs --only moment
  --no-write --perf-only --lane standalone-dynamic` and record the next status.

## Implementation Plan (executed)

1. Mint: at the first standalone `new Date(...)` of a source file, mint the
   `Date.prototype` method closures (`ensureStandaloneNativeMethodClosure`,
   no refusal fallback) for every Date member that file names as a property
   (`.getTime`, `["valueOf"]`). Members without a native body (the string
   formatters) are not minted. Minting before finalize keeps function indices
   append-safe and lets the `__call_fn_method_N` ladders see the closure types.
2. Finalize (`unshiftDateCarrierMemberArms`, both pipelines, before the
   `__extern_get` proto-cache prefix arm), all keyed on `ref.test $__Date`:
   - `__extern_get(date, key)` → the minted `Date.prototype.<key>` singleton;
   - `__extern_method_call(date, key, args)` → resolve through that read and
     `__apply_closure` with the Date as `this` (the #4619 arm's shape);
   - `__dyn_valueOf(date)` (zero-arg `<any>.valueOf()`) → the same resolve +
     apply, instead of `Object.prototype.valueOf`'s identity.
   A member the program assigns on a builtin prototype is left out so an
   override is not hidden.

Module: `src/codegen/date-carrier-dynamic-member.ts` (classified in
`scripts/compiler-boundaries.json`).

## Resolution

Every row of the table answers the expected value, no import
(`tests/issue-6678-6681-standalone-date.test.ts`: parent 8/12 rows fail, fix
0/12).

- moment `standalone-dynamic`: `checksum mismatch: Wasm 12, Node 10` →
  runtime-error `TypeError: Array.prototype.some called on null or undefined`
  (0 imports). Number-built moments now format correctly; the string workload
  hits `<any array>.slice(0)` answering null — filed as #6683.
- Scoped standalone test262 `built-ins/Date` (594 rows, in-process
  `scripts/run-test262-paths.mts --standalone`): parent 538 pass / 56 fail,
  fix 538 / 56, identical non-pass set. `annexB/built-ins/Date` 24/24 on the fix.
- JS-host control: moment upstream suite 10/10.
- Residual: `Object.getPrototypeOf(o._d) === Date.prototype` is still false;
  the string formatters (`toString`, `toISOString`, `toJSON`, …) have no native
  closure body, so an untyped Date keeps its previous lowering for them.
