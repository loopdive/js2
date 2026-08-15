---
id: 4465
title: "ES5 standalone: String.prototype generic-method family — non-string receivers and argument-coercion order (34-row bucket)"
status: in-progress
sprint: current
assignee: ttraenkler/dev-4465
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
loc-budget-allow:
  # +80. `ensureStandaloneRegExpToStringDyn` is the RUNTIME twin of the static
  # `emitStandaloneRegExpToStringFromExpr` that already lives here. It reads the
  # module-private `RE_FIELD_SOURCE` / `RE_FIELD_FLAGS` struct-field indices and
  # must produce output that AGREES with the static renderer by construction —
  # they are one §22.2.6.14 rule with two entry points. Hosting it elsewhere
  # would export those field constants and split that rule across modules, which
  # is the split this file's static renderer was consolidated to avoid.
  - src/codegen/regexp-standalone.ts
  # +31. The growth is the splice/defer of the position coercion in the three
  # member bodies (at/charCodeAt/codePointAt, numeric search, boolean search).
  # The splice point IS each body's own `fctx.body` instruction stream, captured
  # between two emissions in that body, so it cannot be lifted into a helper
  # without passing body indices across a module boundary.
  - src/codegen/array-object-proto.ts
func-budget-allow:
  # +11, same cause as the array-object-proto.ts allowance above: the deferred
  # position coercion for the at/charCodeAt/codePointAt arm plus the comment
  # explaining WHY the emission point is now observable (it was not before this
  # change, and the first measured pass regressed four test262 rows by getting
  # it wrong — RC2b below).
  - src/codegen/array-object-proto.ts::emitStringProtoMemberBody
area: codegen
es_edition: 5
language_feature: string
goal: standalone-gap
related: [4426, 4427, 4439]
origin: "2026-08-15 ES5-standalone session — baseline bucket analysis after wave 11; 34/8115 ES≤5 rows fail under built-ins/String/prototype."
---

# #4465 — String.prototype generic-method receiver/argument coercion

## Problem

34 es5id rows under `test/built-ins/String/prototype/` fail standalone
(baseline 2026-08-15). §15.5.4 String methods are GENERIC: step 1–2 of each
is CheckObjectCoercible(this) + ToString(this), so a method transferred to
any receiver must work. Families from the baseline JSONL:

- **G1 — transferred/reflective receivers (~15 files, dominant)**:
  `__reg.toLowerCase = String.prototype.toLowerCase; __reg.toLowerCase()`
  (the `*_A1_T14` family ×4), `String.prototype.trim.call(child|argObj)`
  (trim 2-43/2-51), `new Boolean()` receivers (replace A1_T2, substring
  A3_T11), `Math` / `Number(1e21)` receivers (split instance-is-*),
  `Function()` receivers (slice A1_T5/A3_T4, substring A1_T5/A3_T10) —
  receiver must go through ToString, currently answers `[object X]`-shaped
  wrongness, null, or "called value is not a function".
- **G2 — argument ToInteger coercion + exception propagation (~4 files)**:
  charAt/charCodeAt `A5`/`A4` — `pos` argument with `valueOf`/`toString`
  throwing `'intostring'` must propagate the user exception; `A1.1` — extra
  args ignored, `eval("1")` as pos.
- **G3 — object-toString argument/receiver shapes in concat/replace (~6)**:
  `{toString(){return "A"}}` receivers/args; replace with undefined-returning
  toString; concat with 128 args (spread arity).
- **G4 — CE class (2 files)**: replace `A1_T5/T6` — explicit
  "String.prototype.replace(...) with a RegExp or symbol" codegen error on
  shapes the emitter declines; check what shape triggers it (likely
  replace(regexp, fn) via transferred method).
- **G5 — out of scope here**: `delete String.prototype.toString` prototype
  mutation (S15.5.4_A1/A3), eval-receiver toLocale* `A1_T3` rows if they
  reduce to the eval tier. Record as residuals with owners.

## Implementation Plan

1. Re-verify families live with the `.tmp/run-one.mts` driver (standalone).
2. Read the existing reflective String dispatch first:
   `src/codegen/array-object-proto.ts` (STRING_PROTO_METHOD_PARAM_SLOTS +
   dispatch arms), `src/codegen/string-proto-concat.ts` (#4426 session's
   reflective concat — the pattern to follow), `string-proto-match-search.ts`
   (#4439), `string-compound-lane.ts` (#4427). G1 is likely ONE fix in the
   reflective dispatch's receiver path: coerce the receiver via the
   ToString/`__to_primitive` route (mirror #4429's string-hint discipline —
   `__current_this` save/install/restore if a user toString runs) instead of
   assuming an anyStr receiver.
3. G2: the arg path for charAt/charCodeAt — route `pos` through the real
   ToNumber (user valueOf/toString called, exceptions propagate). Check the
   #4434 vec-index-domain and #4426 length-set toNumber idiom
   (`__to_primitive` + `__unbox_number`) for the shared instrs.
4. G4: reproduce the CE, decide decline-vs-support; a CE is worse than a
   wrong answer only if the shape is reachable — if support is large, leave
   declined but file the residual.
5. Sweep `built-ins/String/prototype/` standalone before/after from your own
   runs; string-family pins (issue-4427/4439 tests + equivalence string
   subset) green.

## Acceptance criteria

- ≥15 of the 34 rows flip to pass; zero regressions in the scoped sweep and
  string-family pins.
- Residual rows (G5 + anything declined) recorded with owners.

**NOT MET — 5 of 34 flipped, not 15.** The bar assumed G1 was "likely ONE fix
in the reflective dispatch's receiver path". Measurement (below) says it is
not: the 34 rows decompose into **eight** independent root causes, five of
which sit *outside* `String.prototype` entirely (module-global seeding,
constructor-instance method fields, prototype-chain `OrdinaryToPrimitive`, the
boxed-`Number` wrapper's `.toString()`, `eval`). What is fixed here is the part
that really is the String reflective path; the rest is recorded under
`## Residuals` with the exact file/function and the test262 rows each one
blocks, so the next slice starts from a measurement instead of a guess.

## Root cause

Two defects, both instances of the same shape — **the RUNTIME coercion walker is
missing a case the STATIC path already has** — plus one ordering hazard the fix
itself introduced and closed.

**RC1 (G1, RegExp receivers).** `String(re)` / `` `${re}` `` answer
`"/src/flags"` because `emitStandaloneRegExpToStringFromExpr`
(`regexp-standalone.ts`) reads the receiver *expression*. A reflective
`String.prototype.<m>` body has no expression — its receiver arrives as a bare
externref closure param — so `ToString(this)` went `__to_primitive` →
`$__any_to_string`. `__to_primitive` returns a `$__StandaloneRegExp`
**unchanged** (it is neither `$Object` nor a class instance with a user
`toString`), and `$__any_to_string`'s terminal for an unrecognized ref is the
literal `"[object Object]"`. Hence `__reg.toLowerCase()` → `"[object object]"`
instead of `"/abc/"`.

**RC2 (G2/G3, object-valued integer arguments).** The reflective
`substring`/`slice` bound path (`unboxBoundToI32`) and the
`charAt`/`charCodeAt`/`at`/`indexOf`-family position path
(`unboxProtoArgToI32`) called `__unbox_number` DIRECTLY. §7.1.4 ToNumber of an
OBJECT is `ToPrimitive(number)` first — that is what runs a user
`valueOf`/`toString` and propagates a throw from one. `__unbox_number` alone
re-discriminates the shape it was handed and answers NaN for any object, so
`substring(new Array(), new Boolean(1))` read `0, 0` (→ `""`) instead of `0, 1`
(→ `"f"`), and a user `valueOf` was never called at all.

**RC2b (the hazard RC2 introduced).** Once the position coercion can execute
user code, WHERE it is emitted becomes observable. All three affected bodies
emitted it in their step-(1) late-import prologue — i.e. *before*
`ToString(this)` and `ToString(searchString)` — which was unobservable while
`__unbox_number` could not throw. The first measured pass regressed exactly the
four rows that assert which of two throwing coercions wins
(`indexOf`/`lastIndexOf` `A4_T4`/`A4_T5`: `"intostr"` expected, `"intoint"`
observed). Fixed with the splice/defer discipline already used by
`emitTransferredCharAtProtoMemberBody`: register in the prologue for funcidx
stability, **replay** after the ToStrings.

## Fix

| File | Change |
| --- | --- |
| `src/codegen/regexp-standalone.ts` | New `ensureStandaloneRegExpToStringDyn` — a native `(anyref) -> ref $AnyString` rendering §22.2.6.14 `"/" ++ source ++ "/" ++ flags` for a receiver whose RegExp-ness is only known at runtime. Reuses `__regex_flags_str` + the `nativeStringRepr` concat, so it agrees with the static renderer by construction. Plus `standaloneRegExpStructTypeIdx` for the guard. |
| `src/codegen/string-proto-tostring.ts` | `emitStringProtoToStringFlat` (the ToString shared by *every* reflective String body) wraps its generic sequence in `withRegExpReceiverArm` — a guarded `ref.test $__StandaloneRegExp`. |
| `src/codegen/string-proto-substring.ts` | `unboxBoundToI32` emits `__to_primitive(v,"number")` before `__unbox_number`. |
| `src/codegen/char-at-transfer.ts` | `unboxProtoArgToI32` likewise. |
| `src/codegen/array-object-proto.ts` | RC2b: the `at`/`charCodeAt`/`codePointAt`, numeric-search (`indexOf`/`lastIndexOf`) and boolean-search (`includes`/`startsWith`/`endsWith`) bodies defer + replay the position coercion after the ToStrings. The `lastIndexOf`/`endsWith` absent-position sentinel moves with it. |

Two properties bound the blast radius, and both are load-bearing rather than
decorative:

- **The RegExp arm is present-gated twice.** It is emitted only when the module
  already carries the `$__StandaloneRegExp` struct *and* the runtime renderer
  could be minted. A module that never mentions RegExp gets the previous
  sequence, byte for byte.
- **`ToPrimitive` early-outs on primitives** (i31 / `$BoxedNumber` / native
  string / null — the identity early-outs in `__to_primitive`; see
  `tonumber-fast-paths.ts` for why this exact pair is the canonical ToNumber
  idiom). A number/string/boolean argument therefore keeps its previous
  behaviour; only the object case changes, which is the case that was wrong.

## Test Results

Scoped sweep: every ES5 row (`es5id` present in the file) under
`test262/test/built-ins/String/prototype/` — **630 files**, standalone lane,
run by me on this box via `.tmp/sweep.mts` (4 shards, each calling
`runTest262File(..., "standalone")`), both arms on one tree.

| Run | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (worktree HEAD `d0a39cfd8`) | 596 | 32 | 2 |
| after | 601 | 27 | 2 |

**+5 fail→pass, 0 pass→fail, 0 other status changes.**

Flip list (all five were `fail` before):

- `toLowerCase/S15.5.4.16_A1_T14.js`
- `toUpperCase/S15.5.4.18_A1_T14.js`
- `toLocaleLowerCase/S15.5.4.17_A1_T14.js`
- `toLocaleUpperCase/S15.5.4.19_A1_T14.js`
- `substring/S15.5.4.15_A3_T11.js`

The intermediate measurement is kept because it is the evidence for RC2b: the
first pass (RegExp arm + argument ToPrimitive, *without* the defer/replay) was
**+5 / −4** — net +1. The four losses were `indexOf/S15.5.4.7_A4_T4`,
`indexOf/S15.5.4.7_A4_T5`, `lastIndexOf/S15.5.4.8_A4_T4`,
`lastIndexOf/S15.5.4.8_A4_T5`, each expecting `Exception === "intostr"` and
observing `"intoint"` — exactly the coercion-order assertion. The defer/replay
restored all four while keeping all five wins.

Pins:

- `tests/issue-4465.test.ts` — new. Pins both fixed families (RegExp receiver
  across the four case-conversion members plus flags and `.call`;
  object-valued bounds/positions, a throwing argument `valueOf`, and a
  primitive-argument no-collateral case) and carries four `it.fails` residual
  pins, one per root cause below, so each one fails the day it is fixed.
- String-family pins re-run: `tests/issue-4427-compound-assign-chain.test.ts`,
  `tests/issue-4439.test.ts`,
  `tests/issue-4429-string-hint-toprimitive-this.test.ts`,
  `tests/issue-4445-annexb-html-methods.test.ts`,
  `tests/issue-4446-concat-dyn-standalone.test.ts`.

## Residuals

The 27 still-failing rows, grouped by root cause. Each cause names the
file/function that owns it, because the useful output of this issue is that
partition — the plan's "likely ONE fix" was wrong, and re-deriving that is the
expensive part.

**R1 — a module-scope `var x;` read BEFORE its declaration statement is a null
externref, not the undefined singleton.** `registerModuleGlobal`
(`src/codegen/module-global-registration.ts`, the `init` ladder) seeds every
externref module global with `ref.null.extern`. The reflective closure ABI uses
`ref.null.extern` as its *"argument not passed"* pad (`string-proto-concat.ts`,
§22.1.3.5 step 3), so a genuine trailing `undefined` and an absent argument are
indistinguishable and the argument is dropped. Verified by A/B: the identical
program with `var x;` moved ABOVE the call passes. Blocks
`concat/S15.5.4.6_A1_T10`, `concat/S15.5.4.6_A4_T1`,
`replace/S15.5.4.11_A1_T2`, `replace/S15.5.4.11_A1_T10`,
`replace/S15.5.4.11_A1_T9` — 5 rows, the largest remaining group.
**Deliberately not fixed here:** seeding module globals with the undefined
singleton is correct but corpus-wide, and this issue's only instrument is a
630-file String-scoped sweep, which cannot see the collateral. Owner:
standalone-gap; needs its own issue with a full-corpus A/B.

**R2 — a function-constructor instance's OWN `this.toString = function(){}`
field is not reachable as a method.** `i.toString()` dispatches to
`Object.prototype.toString`: the `propAccess.name.text === "toString"` fallback
in `src/codegen/expressions/call-receiver-method.ts` (~L2895) never consults the
struct field, and `__to_primitive` misses it too (the instance is neither
`$Object` nor a class the `__call_toString` dispatcher covers). Measured
directly: for `function F(v){this.v=v; this.toString=function(){return "TS";};}`,
`new F(1).toString()` is `"[object Object]"` while `new F(1).other()` on an
identically-assigned non-`toString` field works. Blocks
`charAt/S15.5.4.4_A1.1`, `charCodeAt/S15.5.4.5_A1.1`,
`substring/S15.5.4.15_A3_T10`, `slice/S15.5.4.13_A3_T4` — 4 rows. Owner:
core-semantics.

**R3 — an INHERITED `toString` is not found by `__to_primitive`'s
OrdinaryToPrimitive probe.** `Con.prototype = protoWithToString; new Con()` —
an own-property `toString` on an object literal works, the inherited one does
not. Blocks `trim/15.5.4.20-2-43` — 1 row. Adjacent to R2 but not identical
(R2 is own-field-on-a-nominal-struct, R3 is chain lookup).

**R4 — the reflective `split` body has no RegExp separator lane.** It only does
`ToString(separator)`, unlike #4439's two-lane `ref.test $NativeRegExp` /
`__regex_compile_dynamic_simple` dispatch for `match`/`search`. Blocks
`split/argument-is-regexp-and-instance-is-number` — 1 row. The smallest
well-specified follow-up in this list; #4439 is the template.

**R5 — a boxed-`Number` wrapper's `.toString()` is "called value is not a
function".** Blocks `split/instance-is-number-1e21` — 1 row. Adjacent to R2.

**R6 — `Math` has no `[object Math]` tag.** `String(Math)` answers
`"[object Object]"` on the STATIC path too, so this is not a reflective-body
gap. Blocks `split/instance-is-math` — 1 row.

**R7 — an `arguments` object stringifies as its elements.**
`String.prototype.trim.call(argObj)` answers `"1,2,1"` (the vec join) where the
spec wants `"[object Arguments]"`. Blocks `trim/15.5.4.20-2-51` — 1 row.

**R8 (G4) — the two declined `replace` compile errors, reproduced and left
declined.** `replace/S15.5.4.11_A1_T5` and `_A1_T6` report
`String.prototype.replace(...) with a RegExp or symbol-protocol search value is
not supported in --target standalone (#1474)`. The triggering shape is a
transferred `replace` with a RegExp search value — the same missing lane as R4,
so it should be fixed WITH R4 rather than separately, and a catchable decline
is the honest answer until then — 2 rows (the two `compile_error` rows).

**G5 — confirmed out of scope, as the plan predicted.** `S15.5.4_A1` /
`S15.5.4_A3` (`delete String.prototype.toString` — prototype mutation),
`toLocaleLowerCase/S15.5.4.17_A1_T3`, `toLocaleUpperCase/S15.5.4.19_A1_T3` and
`split/separator-regexp-limit-string-via-eval` (eval receivers → the eval
tier), `constructor/S15.5.4.1_A1_T2` (`String.prototype.constructor` used as a
constructor) — 6 rows. Owner: runtime-eval / core-semantics.

Row accounting: 5 fixed + R1 5 + R2 4 + R3 1 + R4 1 + R5 1 + R6 1 + R7 1 +
R8 2 + G5 6 = 27 residual + 5 fixed + the 2 R8 rows counted once = 34.
