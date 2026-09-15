---
id: 6491
title: "standalone: a heterogeneous array literal traps at CONSTRUCTION — element zero's closed struct carrier is guard-cast onto a string/number/boolean/vec sibling, and `ref.as_non_null` on the null answer dereferences a null pointer"
status: done
completed: 2026-09-15
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
assignee: ttraenkler/s26-lane
created: 2026-09-15
loc-budget-allow:
  # 2026-09-15 (#6491): INHERITED red, restated here — not growth this change
  # made. This PR touches only `src/codegen/**` (+ this issue file and one
  # test); `src/runtime.ts` measures 19,822 against a 19,601 ceiling under
  # `LOC_GATE_BASE=origin/main` because main's post-merge baseline refresh has
  # not caught up with an earlier slice's landed growth. The grant lives in an
  # issue file this PR does not modify, so CI's merge-preview base would report
  # it as a STRANDED grant and fail `quality` (the #6490 precedent). Restated
  # verbatim rather than fixed: re-splitting `runtime.ts` is not this slice's
  # work, and lowering the number by editing the baseline is forbidden (main is
  # its sole writer, #3131).
  - src/runtime.ts
  # 2026-09-15 (#6491): GENUINE growth this change makes — `literals.ts`
  # 6,761 > 6,734 (+27), all of it at the ONE call site this fix adds. 21 of the
  # 27 lines are the comment that records the measured trap and the reason the
  # widening is standalone-gated; the predicate itself lives in
  # `struct-carrier-inhabits.ts`, beside the #4289 proof whose documented gap it
  # fills, precisely so the god-file takes the call and not the logic.
  - src/codegen/literals.ts
func-budget-allow:
  # 2026-09-15 (#6491): same inherited red, same rationale — `buildImports` is
  # 308 against a 300 ceiling under `LOC_GATE_BASE=origin/main`. Untouched by
  # this PR.
  - src/runtime.ts::buildImports
  # 2026-09-15 (#6491): the twin of the `literals.ts` grant above —
  # `compileArrayLiteral` 1,332 > 1,305 (+27), the same 27 lines. The function
  # is already the project's element-carrier decision table (six widenings
  # before this one); a seventh entry belongs in the table, and extracting the
  # table wholesale is a refactor, not this slice.
  - src/codegen/literals.ts::compileArrayLiteral
---

## Problem

Under `--target standalone` (and WASI), an array literal whose **element zero is
an identifier bound to an object** and which holds **any non-object sibling**
traps while the literal is still being CONSTRUCTED. Four lines, ONE module, no
Temporal, no provider, no link:

```js
const obj = { year: -271821, month: 4, day: 18 };
[obj, "str"].length; // RuntimeError: dereferencing a null pointer
```

`.length` is enough — the value is never read. The trap is in the literal's own
`array.new_fixed`, so **every** later use of that array is unreachable.

Disassembled (`wasm-dis`, this tree, base):

```wat
(array.new_fixed $13 2
  (ref.as_non_null (global.get $global$9))          ;; obj — the closed $7 struct
  (ref.as_non_null
    (if (result (ref null $7))                      ;; the STRING, tested against $7
      (ref.test (ref $7) (local.tee $0 (global.get $global$14)))
      (then (ref.cast (ref null $7) (local.get $0)))
      (else (ref.null none)))))                     ;; ⇒ null ⇒ ref.as_non_null TRAPS
```

`compileArrayLiteral` keys the vec to element zero's carrier and guard-casts
every later element into it. For a sibling that is not a struct **at all** the
guard can only answer null, and the element slot is non-nullable.

## Why the existing widenings did not catch it

`literals.ts` already widens to the universal externref vec in six separate
cases (`hasDynamicOrCallableElement`, `hasHostPathObjectLiteralElement`, the
`null`-literal rule of #1021, the object-in-a-numeric-vec rule of #786, the
native-string rule of #2190b/#4394, and #4289/#5327's
`hasIncompatibleElementCarrier`). None covered this one, and #4289's own doc
comment says why — in so many words:

> It stays narrow on purpose: only elements that themselves resolve to a closed
> data struct are consulted (**a string / number / vec element is another
> widening's business**)

There was no other widening. `hasIncompatibleElementCarrier` reaches the line

```ts
const structIdx = closedDataStructCarrierIdx(ctx, carrierOf(…));
if (structIdx === null) continue;      // ← the hole
```

and `continue`s past exactly the elements that cannot inhabit the carrier.

Two adjacent facts, both measured, that explain why this survived so long:

- **The inline spelling already worked.** `[{ year: 1 }, "str"]` widens, because
  the first-object arm rejects any non-object sibling outright. Only the
  BINDING spelling (`const obj = {…}; [obj, "str"]`) reached the hole —
  `unwrapObjectLiteralElement` does not resolve an identifier to its
  initializer. The two spellings of the same array disagreed.
- **The JS-host/GC lane does not trap for a string sibling** (measured: `2`),
  because there a string element is plain `externref`. It DOES trap for a
  NUMBER or BOOLEAN sibling — a separate, host-lane residual left filed, not
  fixed, by this standalone-scoped slice (§Residuals).

## Reduction (measured on this tree, `--target standalone`, one module each)

| literal | base | branch |
| --- | --- | --- |
| `[obj, "str"].length` | TRAP null deref | `2` |
| `[obj, 1].length` | TRAP null deref | `2` |
| `[obj, true].length` | TRAP null deref | `2` |
| `[obj, [1, 2]].length` | TRAP null deref | `2` |
| `["str", obj].length` | `2` | `2` |
| `[obj, undefined].length` | `2` | `2` |
| `[obj, null].length` | `2` | `2` |
| `[{ a: 1 }, "s"].length` | `2` | `2` |
| `[obj, obj].length` / `["a","b"]` / `[1,2]` | `2` | `2` |
| `for (const v of [obj, "str"]) s += typeof v` | TRAP null deref | `"objectstring"` |
| `[obj, "str"].map((v) => typeof v).join("\|")` | TRAP null deref | `"object\|string"` |

The last two rows matter beyond the trap: the widened vec also answers
CORRECTLY on read-back, so this is not a trap traded for a wrong value.

## The fix

`src/codegen/struct-carrier-inhabits.ts` — new
`hasNonStructElementForStructCarrier(ctx, expr, carrier)`: with element zero's
carrier a closed data struct, return true as soon as an element's own carrier is
an `f64`/`i32` scalar, or a `ref`/`ref_null` that is neither that struct nor any
closed data struct (a native string, a nested vec). Spreads, holes and
`undefined`-like elements are skipped exactly as #4289's proof skips them; an
`externref` element is skipped because the dynamic widenings own it.

`src/codegen/literals.ts` — call it immediately after #4289's call, under the
same `!hasSpread && !hasContextualRefCarrier` guards, and gate it on
`ctx.standalone || ctx.wasi`.

The gate is deliberate, not incidental: the predicate is lane-agnostic (it skips
`externref`, which is what a string is on the host lane), but the explicit gate
makes it IMPOSSIBLE for this slice to move a host-lane byte, and the host lane's
numeric-sibling residual is a different defect with a different fix.

A NEW module was not created: the predicate belongs beside the proof whose
documented gap it fills, and the shared `carrierOf` helper is now one function
instead of a closure re-created per call — so the module's raw-checker site
count is UNCHANGED at one (the oracle-ratchet rationale in that file's header
already covers it: the question is which WasmGC carrier an element lowers to, a
`ValType` fact above what `ctx.oracle` models).

## Corpus footprint

The four-family Temporal sample scores this as ONE row
(`Temporal/PlainDate/from/limits.js`). That undercounts the defect the same way
#6490's "4 rows" undercounted a missing spec step:

- `limits.js` is 23 files corpus-wide, `infinity-throws-rangeerror.js` 74,
  `overflow-wrong-type.js` 20 — but the defect is not keyed to a file NAME, it
  is keyed to a SHAPE.
- The shape is `const table = [objectCase, "stringCase", …]` — the standard
  test262 wrong-type table. A grep for an array literal that opens with an
  identifier and continues with a string or numeric literal matches **427**
  files under `test262/test`. That is an upper bound (not every match binds an
  object, and many do not run standalone), and the one-row sample score is a
  lower bound; the true figure is between them.

## Measured result (S26, 2026-09-15)

Four-family standalone sample, first 120 files each, provider linked,
sequential, fresh `JS2WASM_TEMPORAL_CACHE` per label (`cacheHit: false` both
prewarms, key `a11c84e5…`, 3,307,526 B), 60 s per-row budget from the start —
**no `compile_error` and no `timeout` cell in the 960**.

| family | base | branch | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `PlainDate/**` | 103 | 104 | +1 | 0 | 1 |
| `Duration/**` | 99 | 99 | 0 | 0 | 0 |
| `PlainDateTime/**` | 106 | 106 | 0 | 0 | 0 |
| `ZonedDateTime/prototype/**` | 102 | 102 | 0 | 0 | 0 |
| **total** | **410** | **411** | **+1** | **0** | **1** |

The base reproduces S25's 410 family for family. Aggregating all 960 rows by
digit-normalised message: 38 buckets on each side and **exactly one moves**,
`dereferencing a null pointer in __closure_N()` 7 → 6. The moved row is
`Temporal/PlainDate/from/limits.js`.

**Must-not-move — 604 rows, six groups, per file, 0 flips.** A (100),
B (116), C1 (133), C2 (100) are the hand-off's groups; **D1 (75:
`language/expressions/array` + `Array/prototype/join`) and D2 (80:
`Array/prototype/{map,forEach}`) were added for THIS change** — the inherited
groups were chosen for a different hypothesis and are insensitive to a carrier
widening. Four `compile_error` cells (C1, C2) are identical on both labels.

**Byte A/B**, both directions:

| artifact | base | branch | |
| --- | --- | --- | --- |
| standalone, `[obj, "str"]` | `de5b9fe1…` 51,209 B | `68da276d…` 50,859 B | **moved** |
| standalone, `[obj, 7]` | `0693c3ec…` 51,161 B | `be25d351…` 50,889 B | **moved** |
| standalone, `[obj, obj]` | `1a6399b8…` 51,165 B | identical | |
| standalone, `[{year:1}, "str"]` | `ee6bfe28…` 136,190 B | identical | |
| standalone, no array literal | `fb2f7abd…` 49,625 B | identical | |
| gc lane, the SAME armed source | `97d908fc…` 2,856 B | identical | the lane gate |
| linked provider | `f9c3d1e4…` 155,696 B | identical | |

Both armed artifacts got SMALLER (−350 B, −272 B): the externref vec drops the
per-element guard-cast-and-assert the closed carrier needed.

**Corpus byte A/B**: 42 modules × {gc, standalone} = 84 artifacts, **0 move** —
a NULL control (no corpus module writes a mixed literal), stated as one.

**Temporal provider**: byte-identical between the two labels (same sha256), so
the family delta is entirely in the TEST module.

**Equivalence gate**: 22 failing / 1,720 passing / 22 known-failures — baseline.

**Witness**: base 3 fail / 1 pass, branch 4 pass.

## Residuals — measured here, deliberately NOT fixed, each with its reduction

1. **Numeric/string-first vec, read through an array HOF or `for-of`** —
   `[1, "a"]` CONSTRUCTS fine (`.length` → 2, `a[1]` → `"a"`, `.join("|")` →
   `"1|a"`), but
   - `for (const v of [1, "a"]) s += typeof v` → TRAP `illegal cast`
   - `[1, "a"].forEach((v) => { s += typeof v; })` → TRAP null deref
   - `[1, "a"].forEach((v) => { s += String(v); })` → `"nullnull"` (wrong, silently)
   - `const a = [1, "a"]; typeof a[0]` → **INVALID MODULE**:
     `return_call[0] expected type (ref null 60), found if of type externref`
   - `for (const v of [1, true]) …` → **INVALID MODULE**:
     `local.set[0] expected type (ref null 60), found local.get of type f64`

   Element zero is not a struct, so this slice's predicate correctly declines.
   This is the `typeof`-of-a-union-element lowering plus the #6480 family
   (array-HOF callback parameter), and the two invalid-module spellings are
   strictly worse than a trap: nothing in the module runs at all.

2. **Object-literal spread carrier** — `for (const v of [obj, "str"])` was fixed
   here, but `mixed_forof` on the BASE tree also produced an invalid module
   (`struct.get[0] expected type (ref null 6), found local.get of type
   (ref null 120)`), which the widening removes as a side effect. Recorded
   because an invalid-module diagnosis that disappears is easy to mistake for
   one that was never there.

3. **The `toPrimitiveObserver` shape** (`Temporal/**/infinity-throws-rangeerror.js`,
   5 rows, and `overflow-wrong-type.js`, 3 rows) is NOT this defect. Reduced to
   one standalone module: an object-literal METHOD that returns an object whose
   GETTERS return closures over the method's parameters —

   ```js
   const H = { mk(calls, v, name) { return { get valueOf() { calls.push(name); return function () { return v; }; } }; } };
   H.mk([], 5, "year")            // → "Cannot access property on null or undefined"
   ```

   The plain-FUNCTION spelling of the same helper returns the right value but
   **loses the getter's side effect** (`calls` stays empty), and a one-getter
   version answers `[object Object]` for `o.valueOf()`. Three distinct
   getter/closure defects on one shape; a slice of its own.

4. **`illegal cast in __class_construct_dispatch()`** (4 rows,
   `calendar-undefined.js` / `calendar-wrong-type.js`) is also not this defect,
   and the hand-off's hypothesis for it was WRONG — see §Hand-off correction.

## Hand-off correction — the construct ladder is NOT structural

The S26 brief's leading hypothesis was that `__class_construct_dispatch` "tests
classes structurally (S21's problem on the CONSTRUCT side), so a same-shaped
instance/class of another polyfill class is cast to the wrong struct", and that
the fix was to apply #6486's `__tag` nominal guard to the construct ladder.

That is not what the dispatcher does. `ensureStandaloneClassConstructDispatch`
(`src/codegen/standalone-class-construct.ts`) discriminates by **identity**:
`ref.eq` against each class-object singleton global, each arm guarded by a
`ref.test` on the lazily-materialised global. Its own header says so — "keyed by
the class's IDENTITY (its class-object singleton global) rather than by type —
the same discriminator #5383 S2f R13 had to use for `typeof`". S21's structural
hazard was fixed here before it could exist.

The real cause, reduced to ONE module with no link (`.tmp/s26/p2.mjs`):

```js
class PD { constructor(y, m, d, cal = "iso8601") { this.cal = cal; } }
function mk(C, a, b, c, d) { return new C(a, b, c, d); }
mk(PD, 2020, 12, 24, undefined); // TRAP illegal cast
mk(PD, 2020, 12, 24, null);      // TRAP illegal cast
mk(PD, 2020, 12, 24, 1);         // TRAP illegal cast
mk(PD, 2020, 12, 24, {});        // TRAP illegal cast
mk(PD, 2020, 12, 24, "gregory"); // "gregory"  ← only a matching type survives
mk3(PD, 2020, 12, 24);           // "iso8601"  ← a MISSING argument is fine
```

The cast is `externArgCoercionInstrs`' one strict arm
(`src/codegen/extern-arg-marshal.ts`): for a `ref`/`ref_null` formal it emits
`any.convert_extern` + a **hard** `ref.cast`. `f64` and `i32` formals are
lenient (they unbox to NaN / 0); a ref formal traps. A parameter whose type was
INFERRED from its default (`cal = "iso8601"` ⇒ `string`) is unsound for a
dynamic caller, and the trampoline is where that unsoundness becomes a trap.

Filing note for whoever takes it: the fix is not obviously "cast softly". For
`calendar-wrong-type.js` the SPEC answer is a TypeError for all ten values, so a
checked coercion that throws TypeError would pass that file — but it would be
wrong for a class whose formal is merely inferred and whose JS caller may
legitimately pass anything. The honest options are (a) widen such formals to
`externref` when the class is reachable as a dynamic construct target, or (b)
throw at the boundary only when the formal's type came from a default rather
than an annotation. Both are bigger than a guard.

## Witness

`tests/issue-6491-heterogeneous-array-literal.test.ts` — single-module and
linked-pair cases, every one of them measured FAILING on the base tree by
file-copy revert before being asserted here.
