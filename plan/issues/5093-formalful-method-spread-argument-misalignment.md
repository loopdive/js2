---
id: 5093
title: "A spread call into a method WITH formals misaligns arguments, and one shape emits invalid Wasm"
status: done
sprint: current
created: 2026-08-27
completed: 2026-08-28
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: spread
related: [4782, 4527, 2202, 2151]
# (2026-08-28) Growth allowance for the fix. Both call sites are god-files at
# their exact ceiling, so wiring in the new lowering costs a few lines each.
# The lowering itself (~200 LOC) went into a NEW module,
# src/codegen/expressions/spread-arguments-call.ts, not into either god-file;
# what remains here is only the dispatch: a 4-condition guard that decides
# between the flattened-argument lowering and the existing positional one, plus
# the `__argc` suppression that keeps a constant from clobbering the runtime
# count. +12 lines in call-receiver-method.ts, +10 in call-identifier.ts.
loc-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
# (2026-08-27) Id reserved with `claim-issue.mjs --allocate --allow-unscanned`
# — no `gh` in this container, so the tool's open-PR scan degrades
# unconditionally. The scan was run directly against the REST API instead: the
# 18 open PRs on loopdive/js2 (#5063, #5073, #5077, #5081-#5090, #5092-#5096)
# add or modify issue files {1719, 3518, 3521, 3522, 3525, 4260, 4406, 4779,
# 4780, 4782, 4784, 4785, 4786, 4787, 5091}. 5093 collides with none of them.
---

# #5093 — spread into a method that HAS formals

## Problem

[#4782](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4782-issue-4527-mixed-spread-arguments-red-on-main)
fixed the **zero-formal** arm of a spread call (`emitSetExtrasArgv`). The other
arm — `methodParamCount > 0`, which routes to `compileSpreadCallArgs` in
`src/codegen/expressions/extern.ts` from `compileReceiverMethodCall`
(`src/codegen/expressions/call-receiver-method.ts`, the `handledSpreadNn` gate)
— is separately broken, in four distinguishable ways.

Every row below was measured on `origin/main` @ `14dfc8c105` **and** on
`655b3ab2ef`, the commit that introduced the #4527 mixed-spread row, with
identical results. This is **older than the #4782 regression** and was never
collateral from it.

| shape | correct | actual |
| --- | --- | --- |
| `class C { method(a) { return arguments.length + arguments[0] + … + arguments[3] } }` called `C.prototype.method(42, ...[1], ...tail,)` | `52` | **`null`** |
| same, but the body reads only `arguments.length` | `4` | **`1`** — the spread contributes nothing to the count on this arm |
| `class C { method(a, b) { return a + b } }`, same call | `43` (`a=42`, `b=1`) | **`44`** — `b` binds `2`, so the inline `...[1]` element is skipped: an off-by-one in the flatten into formals |
| `class C { method(a) { return a } }` called `C.prototype.method(...[7, 8])` | `7` | **invalid Wasm** — `WebAssembly.instantiate(): Compiling function "t" failed: not enough arguments on the stack for local.set` |

The last row is the serious one: the compiler emits a module that does not
validate, so the failure is a hard instantiate error, not a wrong value.

Receiver shape matters, and not in the direction one would guess:

| receiver | mixed spread, body reads `arguments` |
| --- | --- |
| `C.prototype.method` | `null` |
| `new C().method` | `null` |
| plain `function f(a) {…}` | `null` |
| object literal `{ method(a) {…} }` | **correct (52)** |

A spread of a **local** array alone (`C.prototype.method(...tail)`) binds the
formal correctly; the inline-literal spread (`...[7, 8]`) is what tips it into
the invalid-module case. Both the zero-formal arm (#4782) and this one accept
the same source, so which of the two runs is decided purely by the callee's
formal count — a caller-invisible property.

## Why it is not covered

Same structural gap as
[#4775](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4775-numeric-return-twin-suite-red-on-main)
and #4782: the spread/`arguments` suites live under `tests/`, not
`tests/equivalence/`, so no required check runs them, and none of them asserts a
formal-ful callee with a mixed spread. While validating #4782 the neighbouring
suites showed **43 pre-existing failures on clean main** (dynamic-new spread,
generator × arguments in standalone, `spread-rest`, native-generator spread) —
this issue is a slice of that surface, not the whole of it.

## Acceptance criteria

- `C.prototype.method(...[7, 8])` into `method(a)` produces a module that
  validates. No shape of a spread call may emit invalid Wasm.
- A formal-ful callee sees the same `arguments` contents as the zero-formal one
  for the same call: `52` and `4` for the rows above.
- Formals bind by position after the spread is flattened: `method(a, b)` gets
  `a=42`, `b=1`.
- Regression tests cover all four receiver shapes above (the object-literal one
  is already correct — pin it so a fix does not trade one for another), in both
  host and standalone lanes.
- Do NOT re-pin an observed-wrong value (#4743/#4747 precedent) — node is the
  oracle for each row.

## Reproduction

```js
// tests use compileMulti + buildImports/wrapExports; see tests/issue-4782.test.ts
class C {
  method(a) {
    return arguments.length + arguments[0] + arguments[1] + arguments[2] + arguments[3];
  }
}
export function t() {
  const tail = [2, 3];
  return C.prototype.method(42, ...[1], ...tail,); // 52; compiles to null
}
```

```js
class C { method(a) { return a; } }
export function t() {
  return C.prototype.method(...[7, 8]); // 7; module fails to validate
}
```

## Provenance

Found while fixing #4782 (PR #5096), by probing the near-miss variants of the
fixed shape. Not fixed there: it is a different lowering arm, and #4782's fix is
byte-identical for every shape that reaches this one.

## Implementation (2026-08-28)

All four rows reproduced on `796d8c2cd2` before any edit, and all four are
correct after. **Two root causes, not four** — and neither is the ordering shape
of #5096 nor the carrier disagreement of #4774/#5078:

### Root cause A — an inline array literal is a TUPLE, not a vec (defects 3 and 4)

`[7, 8]` in a value context lowers to `struct.new $__tuple_0` with fields
`_0`/`_1` (f64, f64) — **not** to a `__vec_` (length + data array).
`compileSpreadCallArgs` only knows the vec carrier and the externref bridge, so
`getArrTypeIdxFromVec` failed and the arm `continue`d: the literal spread
contributed **zero** arguments.

That single dropped argument explains both rows. `method(a, b)` called
`(42, ...[1], ...tail)` bound `a = 42`, skipped `...[1]` entirely, and let
`...tail` fill `b` with `2` — the "off-by-one" was a dropped argument, not a
shifted index. And when nothing later filled the slot
(`method(a)` called `(...[7, 8])`), the call was emitted with **fewer operands
than the callee's arity**, which is why the module did not validate.

Fix, in `src/codegen/expressions/extern.ts::compileSpreadCallArgs`:

- expand the tuple carrier by field (static arity, `struct.get fieldIdx`),
  reserving trailing positional slots the same way the vec arm does (#2053).
  `emitSetExtrasArgv` already recognised this carrier — the two spread readers
  had simply diverged;
- `drop` the compiled source on every bail-out path (an unconsumed operand under
  a call is invalid Wasm); and
- **pad the remaining parameter slots after the loop.** This is the structural
  guard: the loop fills slots opportunistically, so any source it cannot expand
  used to cost validity rather than a value. No caller of that function pads
  afterwards, so it cannot double-fill.

### Root cause B — the formal-ful arm never spoke the `arguments` protocol (defects 1 and 2)

`arguments` is assembled callee-side as `formals[0 .. __argc) ++ __extras_argv`
(`emitArgumentsVecTail`). The zero-formal arm publishes both (#1053, #2202); the
`methodParamCount > 0` arm published **neither** — hence `null` elements and
`arguments.length == 1`.

It cannot be fixed by calling `emitSetExtrasArgv` after the formals: with a
spread, the split between "bound to a formal" and "extra" is a **runtime**
value, and a spread source that straddles the boundary would be evaluated twice.

So the new module `src/codegen/expressions/spread-arguments-call.ts` uses the
spec's model — flatten first, then bind:

```
flat    := emitSetExtrasArgv(args, 0)     // whole list, evaluated ONCE
formals := flat[0 .. formalCount)         // missing slots get their default
extras  := flat[formalCount .. total)     // republished to __extras_argv
__argc  := min(total, formalCount)        // a runtime value, not a constant
```

Formals are pushed **before** the two globals are set, so nothing a coercion
helper might call can clobber them between the `global.set` and the `call`.
The caller therefore also skips `maybeSetArgcForKnownCall`, whose constant would
overwrite the runtime count.

Applied at both call sites that reach this shape —
`call-receiver-method.ts` (class prototype + instance receivers) and
`call-identifier.ts` (plain functions) — gated on: a spread is present, the
callee reads `arguments`, it has ≥1 formal, no rest param, no linear-U8 params,
and a target whose `emitSetExtrasArgv` actually flattens (host, or standalone's
native materializer; **WASI-without-standalone is deliberately left on the old
lowering**, since there the extras builder degrades to a non-flattening static
path). Every precondition is checked before anything is emitted, so declining
costs nothing and the positional lowering stays the fallback.

### Measurements

| lane | before | after |
| --- | --- | --- |
| the 4 issue rows (host) | `null`, `1`, `44`, invalid module | `52`, `4`, `43`, `7` |
| 14-shape probe set (host) | 8 wrong | 0 wrong |
| 18-shape oracle probe, host | 17/18 disagree with node | 1/18 (pre-existing, below) |
| 18-shape oracle probe, standalone | 17/18 | 4/18 (all pre-existing) |
| `tests/issue-5093.test.ts` | 42 of 49 red | 49/49 green |
| 31 neighbouring spread/`arguments` suites | 43 failures | the **same** 43 — 0 pass→fail, 0 fail→pass |
| guard suite (#3552) | 26 failures on this box | the same 26 (unrelated, pre-existing) |
| equivalence, all 8 shards | — | "No new equivalence regressions" ×8 |
| 10 near-miss shapes × 2 lanes (sha256) | — | **byte-identical**, including the #4782 zero-formal arm |

Gates: typecheck, lint, prettier, LOC/func budgets (allowance above),
coercion-sites, pushraw, oracle-ratchet, dead-exports, `check:ir-fallbacks`
(unchanged), stack-balance, codegen-fallbacks, any-box-sites, ir-dialect,
ir-layering, host-import-policy, test-vacuity-shapes — all green.

### Deliberately NOT fixed here (measured, pre-existing, unchanged by this PR)

- **Object-literal method + a purely dynamic spread**
  (`o.method(...tail)` where the callee reads `arguments`) answers `"104,5"` in
  host and `null` in standalone against node's `24`. That is a third lowering
  arm (the object-literal method path), broken identically before and after. The
  issue's own control — the object-literal receiver with the *mixed* spread — is
  correct and is pinned in the test file.
- **Standalone value carriers**: a string element, a `null` element, and a
  spread of a string still answer wrongly on the standalone lane. Each was
  wrong (or an invalid module) before too, so this PR improves all three and
  fixes none of them; they are pinned **host-only** rather than pinned to the
  wrong answer.

  | shape | node | before host / standalone | after host / standalone |
  | --- | --- | --- | --- |
  | `method(s)` ← `...["x", "y"]`, body `s + "\|" + arguments.length + "\|" + arguments[1]` | `"x\|2\|y"` | INVALID_MODULE / INVALID_MODULE | `"x\|2\|y"` / `{}` |
  | `method(a)` ← `...[true, null]`, body tests `a === true`, `arguments[1] === null` | `221` | INVALID_MODULE / INVALID_MODULE | `221` / `220` |
  | `method(a)` ← `..."ab"` (string spread) | `21` | `11` / INVALID_MODULE | `21` / `0` |

- **Sloppy-mode MAPPED `arguments` write-back** (`f(a) { arguments[0] = 5; return a + arguments.length }`)
  does not reflect into `a`. The proof that it is spread-independent — and so
  not this issue's to fix — is that the **no-spread** calls answer identically
  wrongly:

  | call | node | host (before == after) |
  | --- | --- | --- |
  | `f(1)` — no spread | `6` | `2` |
  | `f(1, 2)` — no spread | `7` | `3` |
  | `f(...tail)`, `tail = [1, 2]` | `7` | `3` |

All figures above were measured **before** #5126 was released (host and
standalone lanes, node as the oracle, same probe harness as the table further
up). They are recorded here through the docs lane rather than in #5126 itself
because that branch was already armed with auto-merge when the request came in;
adding a commit to it would have re-run CI and disturbed a green queued PR.

### Acceptance criteria

- [x] `C.prototype.method(...[7, 8])` into `method(a)` validates — and every
      case in the new suite asserts `WebAssembly.validate` on both lanes.
- [x] A formal-ful callee sees the same `arguments` as the zero-formal one:
      `52` and `4`.
- [x] Formals bind by position after flattening: `a = 42`, `b = 1`.
- [x] All four receiver shapes covered in host **and** standalone lanes; the
      object-literal control and the #4782 zero-formal arm are pinned as
      canaries (both were already green on base — 7 of the 49 new cases are, and
      those 7 are exactly the intended controls).
- [x] No observed-wrong value re-pinned: node is the oracle for every row, and
      the three rows node disagrees with on standalone are pinned host-only
      rather than pinned to the wrong answer.
