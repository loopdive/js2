---
id: 7157
title: "Standalone: console.log of a number prints an empty line once the JSON helpers are linked into the module"
status: done
completed: 2026-10-27
sprint: current
created: 2026-10-25
updated: 2026-10-27
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
parent: 6979
related: [7149, 7147, 2788]
# 2026-10-27 (#7157): the scalar-to-string conversion lives in native-strings.ts,
# the coercion-sites-sanctioned owner of number_toString (a new module would be
# a new coercion site); builtins.ts gains the WASI number/boolean arm and the
# oracle boolean query at the console call site; import-collector registers
# bigint_toString for a host-free bigint console argument (+2 lines in
# unifiedVisitNode, where the console argument loop already lives).
loc-budget-allow:
  - src/codegen/native-strings.ts
  - src/codegen/expressions/builtins.ts
  - src/codegen/declarations/import-collector.ts
func-budget-allow:
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
---

# #7157 — standalone `console.log(1)` prints `""` when `JSON.stringify` is also used

Found while implementing #7149 (PR #6912); #7147's and #7148's tests worked
around the same symptom by logging strings only. Pre-existing on `origin/main`,
standalone target (`target: "standalone", hostBridge: "always"` in the test
harness; verify with and without `hostBridge`):

```js
console.log(1);                 // prints an empty line   (node: "1")
console.log("a", 1);            // prints "a "            (node: "a 1")
console.log(JSON.stringify({}));// "{}" — fine; its presence triggers the bug
```

Without the `JSON.stringify` call the same `console.log(1)` prints `1`.

## Cause (as diagnosed; verify before fixing)

Linking the JSON helpers changes which `console.log` lowering the number
argument takes (`compileConsoleCall` in `src/codegen/expressions/builtins.ts`,
the `console_${method}_number` f64 path vs. the generic externref path that
`__extern_toString`s its argument). On standalone with the JSON helpers present
the generic path appears to receive a boxed number whose standalone
`toString` arm yields the empty string, or the f64 import is shadowed by a
late-added helper (function-index shift, cf. `addUnionImports`). Diff the WAT
of the two programs (with / without the `JSON.stringify` call) around the
`console.log(1)` call to find which.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce the three programs above with `--standalone`, and with
   `hostBridge: "always"` / `"off"`; dump WAT for `console.log(1)` with and
   without the `JSON.stringify` call and name the differing instructions.
2. Fix at the lowering site so a number argument prints via the same
   number-to-string conversion `String(n)` uses on standalone, regardless of
   which other helpers are linked; multi-argument calls join with a single
   space. No new host imports.
3. Tests: `tests/issue-7157-standalone-console-number.test.ts` with the three
   programs plus `console.log(1.5, -0, NaN, Infinity)` and a number inside a
   template, on standalone (both `hostBridge` values) and gc native-first vs
   node; then drop the `String(n)` workaround in
   `tests/issue-7149-json-stringify-private-fields-only-instance.test.ts`.

Acceptance: the three programs print node's output on standalone; host-assisted
gc bytes unchanged; equivalence gate reports no new regressions.

## Addendum (2026-10-25, from #7150 / PR #6915)

Wider trigger than the JSON helpers: on standalone, `console.log` of a
boolean or a number prints an empty line whenever the module contains an
**untyped function** (a function whose parameter or return type is `any` /
unannotated):

```js
function f(x) { return x === 1 }
console.log(f(1));   // empty line   (node: true)
console.log(1);      // empty line   (node: 1)
```

Add this program to step 1 of the plan and to the test; the fix in step 2
must hold regardless of which helpers or untyped functions are linked.

## Resolution (2026-10-27)

**Diagnosis (verified).** The JSON helpers are not the cause. Diffing the
`--standalone` WAT of `console.log(1)` with and without the
`JSON.stringify({})` call: without it the IR claims `__module_init` and its
host-free console lowering formats the number; with it the module init falls
back to the legacy AST path, whose `emitStandaloneStdoutAppendValue`
(`src/codegen/native-strings.ts`) emitted `f64.const 1; drop` — every bare
scalar (f64 / i32 / i64) was dropped "best-effort", so nothing was appended.
Anything that keeps the IR from claiming the function takes the same path: an
untyped function (the addendum), and every multi-argument `console.log` (the IR
host-free console lowering takes one argument only), so `console.log(1)` and
`console.log("a", 1)` broke independently of the JSON helpers. No function-index
shift was involved.

**Fix.**

- `emitScalarToNativeString` (`src/codegen/native-strings.ts`) converts a scalar
  with the `String(x)` conversion host-free: a boolean i32 (brand, or
  `ctx.oracle.isBooleanProducing`) selects `"true"`/`"false"`, any other i32
  widens to f64, f64 goes through the native `number_toString` (minted on first
  use), a bigint i64 through `bigint_toString`. Symbol-branded i32 still drops.
- The standalone sink (`emitStandaloneStdoutAppendValue`) uses it, so
  multi-argument calls join with one space as before, now with the numbers.
- The import collector registers `bigint_toString` for a bigint console
  argument on host-free targets.
- WASI (`emitWasiValueToStdout`) printed booleans as `1`/`0` and truncated
  fractions (`1.5` → `1`). A boolean now writes the `"true"`/`"false"` data
  segment; an f64 uses the same `String(n)` conversion and
  `__wasi_write_any_string`. Non-boolean i32 keeps `__wasi_write_i32`.
- No new host imports; gc output unchanged.

**Tests.** `tests/equivalence/issue-7157-standalone-console-number.test.ts`:
the three plan programs, the addendum's untyped-function program,
`console.log(1.5, -0, NaN, Infinity)`, booleans, numbers in a template,
multi-argument joins, untyped arithmetic, int32 values, bigint, on standalone
`hostBridge: "always"` (output vs V8), standalone `hostBridge: "off"` (compiles,
validates and runs — that lane exports no stdout readout), WASI (output vs V8),
and gc native-first for the single-argument programs. The `String(n)`
workaround in `tests/issue-7149-json-stringify-private-fields-only-instance.test.ts`
is removed. Tests that pinned the old behaviour are updated:
`tests/issue-5094-ir-host-free-boolean-console.test.ts` (the legacy control now
prints the booleans), `tests/wasi-target.test.ts` and `tests/issue-1493.test.ts`
(the WASI helper names).

**Left out.**

- gc (JS host) prints each argument of a multi-argument `console.log` on its own
  line (`console.log("a", 1)` → `a` / `1`); a JS-host-lane fix, not done.
- The reference is `String(x)` per argument, so `-0` prints `0`; Node's
  `console.log(-0)` prints `-0` (util.inspect).
- `console.log(sym)` with a symbol value still prints an empty field on
  standalone; WASI prints `[object]` for bigint, `undefined` and `null`.
- `2n ** 70n` evaluates to `0` on standalone (i64 bigint carrier wraps); a
  bigint arithmetic issue, not a console one.
- `#7148`'s test keeps its `String(...)` calls: dropping them would make its
  multi-argument lines split on the gc lane (first item above).
- WASI bytes: a module that prints an f64 number now links the native string
  helpers and number formatter (+17 to +41 KB unoptimized on the sampled
  programs that were not already linking them). Standalone grows by the
  formatter (+16.6 KB) only when nothing else linked it.
