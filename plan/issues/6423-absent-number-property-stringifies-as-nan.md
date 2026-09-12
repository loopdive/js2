---
id: 6423
title: "An ABSENT number-typed property stringifies as `\"NaN\"` instead of `\"undefined\"` — the f64 absence sentinel leaks through `String()`"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

```js
// untyped .js half
export function readProp(o) {
  return String(o.maxAge);
}
export function readPropWithField(o) {
  return String(o.path) + "/" + String(o.maxAge);
}
```

| call                                | node                    | compiled                |
| ----------------------------------- | ----------------------- | ----------------------- |
| `readProp({})`                      | `"undefined"`           | **`"NaN"`**             |
| `readProp({ path: "/" })`           | `"undefined"`           | **`"NaN"`**             |
| `readPropWithField({})`             | `"undefined/undefined"` | **`"undefined/NaN"`**   |
| `readProp(Object.assign({}))`       | `"undefined"`           | **`"NaN"`**             |

The third row is the diagnosis in one line: the same absent-property read gives
the right answer for a **string**-shaped slot and the wrong one for a
**number**-shaped slot. So the absent numeric slot is carrying the f64 absence
sentinel (`UNDEF_F64`) and `String()` stringifies the sentinel as `NaN` instead
of mapping it back to `undefined`.

Measured on `cf82f78d6d` (2026-09-12) through an untyped two-file fixture, the
dogfood `compileAndRunUpstreamModule` lane.

## What is NOT broken (measured in the same run — do not re-derive)

These all answer correctly for an absent numeric property, so the fix belongs
at the value→string boundary, not in the property read or the type predicates:

* `typeof o.maxAge === "undefined"` ✓
* `o.maxAge === undefined` ✓
* `"maxAge" in o` ✓ (false)
* a `typeof o.maxAge === "number" && o.maxAge >= 0` guard is NOT taken ✓
* anti-vacuity: a PRESENT `maxAge: 0` answers `"number"`, is `>= 0`, and the
  guard IS taken ✓

## Acceptance criteria

1. `String(o.p)` / `` `${o.p}` `` / `o.p + ""` answer `"undefined"` for an
   absent number-typed property, on an empty and a non-empty object literal and
   on an object that reached the reader through an `any` parameter.
2. Anti-vacuity, and this is the whole risk: a PRESENT `p: 0` still stringifies
   as `"0"`, and a genuine `NaN` still stringifies as `"NaN"`. The sentinel and
   a real NaN are the same f64 bit pattern family — a fix that maps all NaN to
   `undefined` is worse than the bug.
3. Regression test under `tests/`, untyped `.js` two-file fixture, failing on
   the parent and passing with the fix, exact counts both ways.
4. A/B over the 17 dogfood suites at one HEAD.
5. Standalone lane status recorded.

## Two adjacent measurements, NOT claimed as this defect

Both came out of the same probe. Each needs its own bisect; neither is
explained by the diagnosis above, and attributing them here would be a guess:

1. **hono serializes a spurious `Max-Age=0`.** `src/utils/cookie.ts:196` guards
   with `typeof opt.maxAge === "number" && opt.maxAge >= 0` and compiled hono
   takes that branch for an options object with no `maxAge`, emitting
   `; Max-Age=0`. It costs `Should serialize cookie` outright and is the second
   of the two defects in `Should serialize a signed cookie` (the first being
   [#6421](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6421-spread-into-static-builtin-drops-arguments)).
   **Two hypotheses were tested and BOTH refuted**: it is not `typeof` on an
   absent property (works, above) and it is not the guard shape (works, above).
   So the trigger involves hono's real `CookieOptions`-typed parameter rather
   than the `any`-typed literal a minimal fixture produces — bisect from the
   real module, not from a reconstruction.
2. **An empty object literal `{}` passed as an argument then read** throws
   `TypeError: Cannot access property on null or undefined` — the no-field
   literal appears to lower to a null struct. `readProp({})` above does NOT
   throw, so the trigger is narrower than "`{}` argument"; it showed up only in
   the longer `serializeLike(name, value, {})` form.

## Dispatch

Model: **opus**. The defect itself is one boundary; criterion 2 is the reason
this is not an easy ticket.

## Implementation Plan

**Diagnosis (verified on 23a0ddaa26, WAT of `String(o.maxAge)`):** the dynamic read is correct — `property-access-dispatch.ts` ~L5042 (#5251) narrows the `__extern_get` result to `{ kind: "f64", undefSentinel: true }` and emits `select(UNDEF_F64_BITS, __unbox_number)`; that brand is what makes `typeof`/`=== undefined` right. The four ToString arms then ignore the brand and `call number_toString` on the raw f64, and the host import is `String(v)` → `"NaN"`. **JS-host lane only**: the same probe compiled `target: "standalone", hostBridge: "off"` answers all 7 cases (127/127) because its ToString goes through `$__any_to_string`, not the narrowed f64. The IR path (`src/ir/from-ast.ts:8206`) is not involved — untyped `any` params take the legacy lowering.

1. **Probe first** (`.tmp/6423/`): `lib.js` with `readProp`/`readPropWithField`/`tmpl`/`plusEmpty`; `run.mjs` calls `compileAndRunUpstreamModule` (needs `node --import tsx`). Parent: wasm `[F,F,F,F,F,F,T,T,T]`, native 9/9.
2. **Add one helper** in `src/codegen/coercion-engine.ts` next to `emitToString`: `emitNumberToStringSentinelAware(ctx, fctx, valType, toStrIdx)`. Brand-gated: when `valType.kind === "f64" && valType.undefSentinel === true` emit `local.tee $tmp; emitIsUndefF64 (value-tags.ts); if (result externref) then pushStringLiteral "undefined" else local.get $tmp; call number_toString`; otherwise the plain call, byte-for-byte as today. Test the exact `UNDEF_F64_BITS` i64 pattern (`i64.eq` after `i64.reinterpret_f64`), never `f64.ne` self-compare — that is criterion 2: a real NaN (quiet `0x7ff8…`, e.g. from `__unbox_number`) must still print `"NaN"`. Do not add `HOLE_F64_BITS` here: reads already map HOLE→UNDEF at the boundary (`vec-f64-hole-presence.ts`).
3. **Route the four arms through it, in this order** (each is a pure substitution of `fctx.body.push({op:"call", funcIdx: toStrIdx})`, no stack-shape change): (a) `emitToString` f64 arm, `coercion-engine.ts` ~L251–270 (the native branch keeps its `emitNativeStringRefFromExternref` tail after the helper); (b) `String(x)` f64 arm, `src/codegen/expressions/call-identifier.ts` ~L1425–1432, before `emitStringBuiltinNumberResult`; (c) `+` concat left/right f64 arms, `src/codegen/string-ops.ts` ~L2170–2182 and ~L2245–2257; (d) template-span f64 arm in `compileTemplateExpression` (js-host branch, `string-ops.ts` ~L682–720) and `compileStringRaw` ~L1039–1052. Order constraint: the helper reads the operand from a scratch local it allocates itself (`allocLocal`) — never reuse a caller local — and must leave exactly one externref (host) so the surrounding `concat`/`emitStringBuiltinNumberResult` tails are untouched; do NOT call `ensureLateImport` inside it (funcMap is read-only mid-body, same rule as `canonicalUndefinedExternInstrs`).
4. **Regression test** `tests/issue-6423-absent-number-stringify.test.ts`: mkdtemp two-file untyped fixture (`lib.js` + generated `.test.ts` with `UPSTREAM_TEST_SHIM`/`UPSTREAM_TEST_EXPORTS`) through `compileAndRunUpstreamModule`; assert native 9/9 and wasm 9/9 (parent: wasm 3/9, exactly the six absent-read cases). Anti-vacuity controls in the same module: present `maxAge: 0` → `"0"`, present `NaN` → `"NaN"`, present `5` → `"5"`. Second `it`: the standalone probe (`compile(..., { target: "standalone", hostBridge: "off" })`, `probe() === 127`) pins the lane that already works.
5. **A/B over the 17 dogfood suites** at one HEAD. Expectation: **no anchor moves** (webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740 · lodash 59/62 · redux 67/82 · axios 208/231 · stylelint 108 · tailwindcss 13 · jsdom 6 · styled-components 9 · uuid 75 · marked 16/30 · moment 10 · prettier 107/151 · jest 335/356 · hono 259/324). hono's spurious `Max-Age=0` is explicitly NOT this defect (the guard, not ToString, misfires there) — if hono moves, record it but do not claim it. Any drop = the helper changed an unbranded arm; diff WAT of an unbranded `String(n)` before/after (must be identical).
6. **Standalone lane**: record "already correct on parent, unchanged" with the probe number; the `emitToString` native branch is touched only in that the helper sits before its existing unwrap tail.
7. Gates before commit: `check-loc-budget`, `check-func-budget`, `check-coercion-sites` (new f64→string site count may need a grant in this issue file), `check:oracle-ratchet`, `check:dead-exports`.

## Dispatch

Model: **opus** — four mechanical call-site substitutions behind one brand-gated helper, but criterion 2 (sentinel vs. real NaN) and the mid-body funcMap/stack-shape constraints need someone who reads the surrounding arms rather than pattern-replacing.
