---
id: 3175
title: "standalone: Number.prototype.toString(radix)/toFixed/valueOf spec semantics + prototype surface (74 gap tests)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: number
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [2860, 3078, 3081, 2861]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff"
loc-budget-allow:
  - src/codegen/expressions/calls.ts
  - src/codegen/declarations.ts
coercion-sites-allow:
  - src/codegen/declarations.ts
---

# #3175 — standalone: Number.prototype method spec semantics

## Problem

**74 host-pass tests are not host-free-standalone passes** under
`built-ins/Number/prototype/` (plus ~28 more direct `built-ins/Number/*` rows,
mostly boxed-Number-object semantics; measured 2026-07-12 lane-baseline diff,
method in #3169).

Measured signatures:

- The DOMINANT bucket (34 rows, `assert.sameValue(Number.prototype.toStr…`):
  **`toString(radix)`** — the S15.7.4.2 corpus calls
  `Number.prototype.toString.call(x, radix)` / `(n).toString(r)` for radix
  2–36 and checks digits; also radix-argument coercion order and
  `RangeError` on radix outside 2..36. The existing ryu-based formatter
  (`src/codegen/number-ryu.ts`) is decimal-only on this path.
- `hasOwnProperty`/property-surface rows (7): `Number.prototype` member
  descriptors (`length`/`name` of the methods, prototype own-property set).
- `valueOf`/brand rows: `Number.prototype.valueOf.call(nonNumber)` must throw
  `TypeError`; boxed `new Number(x)` receivers must unwrap.
- toFixed argument-coercion edges (S15.7.4.5 A1.x) beyond the
  undefined-arg fix #3078 already landed.

## ANTI-BLOAT directive

- Extend `src/codegen/number-format-native.ts` / `number-ryu.ts` in place:
  add an integer+fraction radix-N digit emitter next to the existing decimal
  path (shared digit-table with `parseInt`'s radix tables if present) — do
  NOT bolt a separate `toStringRadix` handler onto the dispatcher.
- Brand check (`valueOf`/`toString` on non-Number receivers) reuses the
  shared brand-preamble pattern (#3171/#3174) with the boxed-Number brand.
- Method `.length`/`.name`/descriptor surface rows go through the EXISTING
  builtin-fn metadata machinery (`src/codegen/builtin-fn-meta.ts`, #2896) —
  add table entries, not code.
- #3081 (Number namespace const receiver invalid-wasm) is a different,
  namespace-side bug — don't absorb it.

## Acceptance criteria

- ≥55 of the 74 measured `Number/prototype` gap tests flip to host-free
  standalone passes.
- Sample tests:
  - `test/built-ins/Number/prototype/toString/S15.7.4.2_A2_T02.js` (radix)
  - `test/built-ins/Number/prototype/toFixed/S15.7.4.5_A1.4_T01.js`
  - `test/built-ins/Number/prototype/valueOf/length.js`
- Zero host-mode regressions; zero standalone high-water regressions.
- One PR, Number family only.

## Progress (PR-1, dev-number, 2026-07-12) — PARTIAL

Local measurement via the real `wrapTest` + standalone compile over all 168
`built-ins/Number/prototype/**` files: **84 → 130 standalone passes (+46)**,
zero host-mode regressions (verified `Number.prototype.{toString,valueOf,
toFixed}` still correct in gc mode), zero standalone high-water regressions
(spot-checked; the two `issue-1320-standalone` iterator failures pre-date this
branch on `origin/main`).

**Landed (all `src/codegen/`, Number family only):**

1. **`Number.prototype` receiver → +0** (dominant bucket, ~35 tests). New
   `isNumberDotPrototype()` in `expressions/calls.ts` recovers the prototype
   object's [[NumberData]] = +0 (§21.1.3) directly, before the boxed-wrapper
   `__to_primitive`/`__unbox_number` recovery (which found no [[PrimitiveValue]]
   slot → NaN). Wired into `emitNumberMethodReceiverF64` (covers toString/
   toFixed/toPrecision/toExponential/toLocaleString) and the wrapper `valueOf`
   path. Shadow-guarded via `isDeclarationFile` (the global `Number` is
   ambient-only; a user `const Number` bails).
2. **`toString(undefined)` → base 10** (§21.1.3.6 step 2), not RangeError/trap.
   `declarations.ts` scan now also registers `number_toString` for `.toString(arg)`
   so the undefined-radix fallback resolves.
3. **`toFixed` ToIntegerOrInfinity(fractionDigits)**: `f64.trunc` toward zero +
   `normalizeNaNToZero` before the [0,100] gate, so `toFixed(-0.1)`/`toFixed(NaN)`/
   `toFixed("x")` no longer trap (matches the toPrecision arm).
4. **Real RangeError INSTANCES** from the toString-radix and toFixed out-of-range
   gates (new `buildThrowJsErrorInstrs` helper returns the terminal
   instruction sequence for splicing into an `if.then`), so raw-`try`/`catch` +
   `assert(e instanceof RangeError)` passes.

Tests: `tests/issue-3175.test.ts`.

**Remaining (NOT in this PR — each a separate slice; ~38 files still failing):**

- **Brand checks / "not generic"** (~12: toString A4_T01–05, valueOf A2_T01–05,
  toExp/toPrec `this-type-not-number`). Require materializing
  `Number.prototype.<m>` as a first-class function VALUE that brand-checks its
  receiver on transfer (`s.toString = Number.prototype.toString; s.toString()`
  must throw TypeError). Large — needs the shared brand-preamble (#3171/#3174)
  wired to extractable prototype-method values.
- **Property surface** (~12: `Number.prototype.hasOwnProperty(...)`, S15.7.4*A3.\*,
  S15.7.3.1*\*). Needs `Number.prototype` as a real object with own-property
  descriptors.
- **Method `.length`** (3: toString/valueOf/toLocaleString `length.js`). The
  `.name` fold already fires (`tryCompileStandaloneBuiltinProtoMemberMeta` in
  `property-access.ts`); `.length` is intercepted by an earlier generic
  `.length` handler and returns NaN. Needs a dispatch-order fix (fold before the
  generic handler) — deferred to avoid property-access reordering risk here.
- **toExponential / toPrecision no-arg + coercion** (~8). The standalone no-arg
  render is a documented 6-digit approximation (`number-format-native.ts`:
  "shortest round-trip out of scope"); `toPrecision(undefined)` should be
  `ToString(x)` but the delegation to `number_toString` collides with the
  `number_toString`←`number_toString_radix` emit-dependency chain (CE) — needs
  the emit-graph untangled first. Separate defect, out of the toString/toFixed/
  valueOf scope.
- **Symbol/BigInt arg ToNumber-throws** (~2). `toFixed`/`toExponential` Symbol/
  BigInt args must throw TypeError as a real instance.

## Stale-verify (2026-07-24, dev-std-4) — SUBSTANTIALLY SHRUNK, keep ready

The dominant `toString(radix)` bucket (34 rows claimed 2026-07-12) has largely
landed. MEASURED on current `main` (`--target standalone`):
`built-ins/Number/prototype/toString` = **83 pass / 7 non-pass (of 90)** — the
7 residual are radix-argument coercion edges (`S15.7.4.2_A4_T04/T05`, etc.), NOT
the ~34-row headline. Headline repros pass host-free: `(255).toString(16)`→"ff",
`(10).toString(2)`→"1010", `(1.5).toFixed(2)`→"1.50". Consistent with
dev-std-2's finding that the residual is small and substrate-walled. Keep
`ready` but RE-SCOPE: a full `built-ins/Number/prototype/**` + `built-ins/Number/**`
re-measure is needed to size the true residual (the "74 gap tests" figure is
stale — most have landed).
