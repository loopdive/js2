---
id: 3973
title: "Issue 3973: standalone — dynamic element read `x[k]` on an `any`-typed receiver holding a string returns `undefined`"
status: done
assignee: ttraenkler/sendev-untagged
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-01
goal: standalone-gap
sprint: 78
priority: high
horizon: m
feasibility: hard
loc-budget-allow:
  - src/codegen/property-access.ts
func-budget-allow:
  - src/codegen/property-access.ts::compileElementAccess
---

<!--
loc-budget rationale (#3102): the 126-line helper does NOT live in the god-file.
It was split into the new subsystem module `src/codegen/string-element-read.ts`,
next to its siblings `emitGuardedNativeStringLength` and
`compileGuardedNativeStringMethodCall`. That took the growth from +148 to +23.
The remaining +23 is the irreducible dispatch wiring plus one import: the guard
has to be CHOSEN inside `compileElementAccess`, which is in property-access.ts
by definition. (`string-ops.ts`, the other natural home, is itself exactly at
its own cap of 3717, so moving there would just relocate the breach.)

func-budget rationale (#3400): `compileElementAccess` +12. It is a DISPATCHER —
its body is a sequence of "is the receiver shape X?" arms (#1910-R4, #3027,
#3057 dyn-TA-view, …) — and this adds exactly one more arm plus a 3-line
pointer comment. The emission it dispatches to is 126 lines and lives in
string-element-read.ts, not here. Splitting the dispatcher itself is #3399's
job and is deliberately out of scope for a correctness fix.
-->


# Issue 3973: standalone — dynamic element read on an `any`-typed string receiver returns `undefined`

## Status: done

## Summary

In `--target standalone` (host-free, native strings), a bracket element read
`x[k]` where `x` is **statically** `any`/`unknown` and holds a **string** at
runtime evaluates to `undefined`. Arrays and plain objects reached through the
same `any` receiver work correctly; only the string carrier is missing.

This is a **value-representation / dynamic-dispatch substrate defect**, not a
`Function.prototype.toString` bug. It was FOUND through four
`built-ins/Function/prototype/toString/` failures, but that directory is only
the symptom surface — filing it under `toString` would hide it from anyone
sizing string-indexing work.

## Evidence

Positive control, all inside ONE compiled program (so "the value never arrived"
and "standalone is generally broken" are both excluded):

| read | receiver static type | standalone result |
| --- | --- | --- |
| `s[i]`, `s[0]` | `any` param | **`undefined`** |
| `s.charAt(i)` / `s.length` / `s.slice(0,3)` | *same* `any` param | `f` / `29` / `fun` |
| `lit[0]`, `lit[j]`, `lit.charAt(j)` | `string` local | `f` |
| `s[k]`, a `string` local passed *into* an `any` param | `any` param | **`undefined`** |

So the runtime value is intact and the receiver's **static type** is what
decides. Reach, measured the same way: `any`←array ✓, `any`←object ✓,
`any`←string ✗ (primitive, `String` wrapper, numeric or string key alike).

Paired lane arm on identical source isolates the lane:

| lane | `any`-param `s[0]` | test262 harness `validateNativeFunctionSource("function () { [native code] }")` |
| --- | --- | --- |
| host (gc) | `f` | **ACCEPTED** |
| standalone | **`undefined`** | **REJECTED: SyntaxError** |

## Root cause

Two halves, both confirmed by reading the code:

1. **Compile site** — `src/codegen/property-access.ts` (the #1910-R4/#3304 arm)
   emits the fast native `__to_primitive` → `__str_flatten` → `__str_charAt`
   sequence, but its gate is purely STATIC
   (`isStringWrapperType(...) || ctx.oracle.staticJsTypeOf(recv) === "string"`).
   An implicitly-`any` parameter never satisfies it.
2. **Runtime helper** — the read therefore falls through to
   `compileElementAccessBody`'s standalone numeric arm → `__extern_get_idx`,
   whose receiver dispatch (`buildExternGetIdxBody`, `src/codegen/object-runtime.ts`)
   is `$Object`-array-like / typed `__vec_<k>` / `$ObjVec` only. A `$AnyString`
   receiver matches none of them and lands on the miss → the `undefined`
   singleton.

Host/gc mode never saw this because there `__extern_get_idx` is a **JS host
import** doing a real `obj[idx]`.

Note `src/codegen/dyn-read.ts`'s doc comment already *asserts* that
`__extern_get` has "the native-string indexed/`.length` arm". It does not; the
comment is aspirational and should be treated as stale.

## Why `.length` and `.charAt` work on the same value

Because they carry the runtime guard this path was missing:
`receiverMayBeNativeStringAtRuntime` + `emitGuardedNativeStringLength`
(property-access.ts) and `compileGuardedNativeStringMethodCall`
(string-ops.ts). The element-read path was the one member of that family
without it. **The fix follows the established pattern rather than inventing
one.**

## Fix

`emitGuardedNativeStringElementGet` in the new subsystem module
`src/codegen/string-element-read.ts`, wired into `compileElementAccess`
(property-access.ts) directly after the static-string arm:

- receiver and index each compiled **once** into locals (no re-evaluation of
  side-effecting operands);
- `ref.test $AnyString` on the receiver;
- **then**: canonical-integer-index test (`f64(i32(idx)) === idx`, which rejects
  `1.5` / `NaN` / `±Infinity` / out-of-i32-range) **and** an unsigned
  `i < len` bound, then `__str_flatten` → `__str_charAt`. Deliberately does NOT
  reuse `__str_charAt`'s own bounds behaviour, which answers `""` out of range
  whereas `s[oob]` must be `undefined` (§10.4.3.5 StringGetOwnProperty);
- **else**: the byte-identical prior lowering (`__extern_get_idx`), so arrays /
  `$ObjVec` / array-like `$Object` are unaffected.

Chosen at the **compile site**, not by adding an arm to `buildExternGetIdxBody`,
because that helper's body is re-derived at finalize; baking new
`call __str_flatten` / `__str_charAt` funcIdxs there would re-trip the
late-import funcIdx double-shift that regressed ~120 modules under #2190
(memory `reference_no_rebuild_helper_body_at_finalize`).

Skipped when `ctx.moduleUsesDynTaView` so #3057's `emitTaDynViewElementGet`
keeps first claim on the same arm — a `$__ta_dyn_view` is never a `$AnyString`,
so this only defers the guard in modules that have both.

## Known limitation (deliberate, this slice)

The gate requires `isNumericIndexExpression`, so an **`any`-typed index**
(`x[k]` where `k` is itself `any`) is not yet covered — that read routes
through a different arm (`__extern_get` + positional retry). Measured still
`undefined`. Tracked as follow-up work; the numeric-index case is what the
harness scanners and the enumerated population use.

## Enumerated population (trigger-shape, positive-controlled)

test262's own `harness/nativeFunctionMatcher.js` scans with `source[pos]` on an
implicitly-`any` parameter, so every test including it is gated:

- **71** tests include `nativeFunctionMatcher.js` → baseline standalone:
  **0 pass**, 66 fail, 2 compile_error, 3 not in baseline.
- **29** of those fails render the EXACT valid string
  `"function () { [native code] }"` — i.e. gated purely by this defect.
- The other 37 render `"undefined"` / `"null"` / `"[object Object]"` — separate
  defects, NOT predicted to move, and used as in-sweep controls.
- **Positive control: 4/4** of the ground-truth cluster-C files fall inside the
  enumerator. (An earlier version of the enumerator scored 0/4 because a `sed`
  prefix silently did not fire — the control is what caught it.)

**71 / 29 are populations GATED, not a flip forecast.** Measured flips are
recorded in `## Test Results`.

## Residual, NOT fixed here (needs its own issue)

With the fix applied, the harness validator provably works
(`VALIDATE=OK`; guard fires at all 16 harness element-read sites), yet the four
`private-*-method-*` files still fail. Bisected: the same
`assertToStringOrNativeFunction(fn, expected)` call **succeeds** when the test
body itself first calls `validateNativeFunctionSource(actual)`, and **fails**
when it does not — with an identical set of guard sites in both. So a second,
independent defect sits downstream in how `"" + fn` is produced/typed when `fn`
is an `any` parameter (or in `assert.sameValue`). It was previously **masked**
by this one. Do not fold it in here.

## Test Results

**Paired per-file A/B, both arms in ONE process** (arm A = guard bypassed via a
temporary kill-switch = pre-fix; arm B = guard active), so the arms cannot drift
relative to each other. The kill-switch doubles as attribution-by-removal.

Population = the enumerated 71 tests including `nativeFunctionMatcher.js`.

```
rows FLOORED: 71 (list had 71)
arm A (guard OFF = pre-fix): pass  0/71
arm B (guard ON  = fix):     pass 23/71
FLIPPED fail->pass: 23
REGRESSED pass->fail: 0
compile_timeout rows needing solo re-run: 0
```

**23 / 71 flipped, 0 regressions.** Against the pre-registered prediction
(files rendering the exact valid placeholder in arm A — 30 by arm-A rendering;
the baseline jsonl counted 29, the small difference being fresh-run vs baseline
error text):

- 22 of the 23 flips fall INSIDE the prediction;
- the 1 "outside" flip is **test262's own harness self-test**
  `test/harness/nativeFunctionMatcher.js` (`"function(){[native code]}" should
  pass`) — the most on-mechanism file in the corpus, simply not in the `toString`
  directory I enumerated from;
- **in-sweep controls: 40 of 41 non-predicted files did not move at all.**

8 predicted files did NOT flip, and this is informative rather than a shortfall:
6 of them (`*-class-statement-static`, `*-method-object`, `generator-method`,
computed-property-name shapes) now surface a DIFFERENT error (`"null"` /
`"undefined"`) — the placeholder render was itself downstream of this defect, so
fixing it exposes their real, separate bug. The remaining 2 are
`private-method-class-{statement,expression}.js`, the documented masked residual
above.

**FINAL ARM — scaffold DELETED** (no env var, no kill-switch, nothing to
toggle), re-run over the 23 flipped files:

```
rows FLOORED: 23 (list had 23)
pass: 23/23
```

so the shipped code, not the measurement harness, produces the result.

Gates pre-run locally: `check-speculative-rollback-sites` OK,
`check-oracle-ratchet` OK (`getTypeAtLocation +0, ctx.checker +0` — the fix
routes through the existing `receiverMayBeNativeStringAtRuntime` helper rather
than adding a raw checker query), `tsc --noEmit` clean.
