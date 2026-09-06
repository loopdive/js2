---
id: 5342
title: "lodash residual: the last 9 of 62 — two traps, two Symbol-keyed nulls, two deepEqual misses — never investigated"
status: done
completed: 2026-09-06
sprint: current
created: 2026-09-05
updated: 2026-09-06
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

lodash is **53/62** on clean main `c9a8b48616` (50 at the start of this
effort). Nobody has looked at the remaining nine. All are in the single
`test.js` file lodash's suite admits, so grouping by file tells nothing; the
error lines do:

```
 2  RuntimeError: dereferencing a null pointer
 2  assertion 1: deepEqual mismatch; object != object
 2  assertion 2: strictEqual mismatch; object:null !== string:Symbol(a)
 1  assertion 1: expected truthy value; got boolean:false
 1  assertion 6: strictEqual mismatch; boolean:true !== boolean:false
 1  assertion 1: deepEqual mismatch; object:null != string:-0,-0,0,0
```

Two of these are recognisable on sight:

- **`object:null !== string:Symbol(a)` (2)** — a `Symbol` reaching a
  string-typed slot and being dropped to `null`. lodash's `toString`/`isSymbol`
  paths, or a `Symbol`-keyed property read through `__extern_get` that the
  compiled side typed as string.
- **`object:null != string:-0,-0,0,0` (1)** — an array of signed zeros joined
  to a string answered `null`; `-0` handling in `String()`/`join` over an
  `f64` vec, or `Object.is`-style zero comparison (`_.eq`, `_.isEqual`).

## Acceptance criteria

1. lodash ≥ 58/62.
2. Regression test per fixed cause, failing on parent, passing with fix,
   untyped `.js` two-file fixtures, anti-vacuity control.
3. A/B at one HEAD, 17 suites, per test file — lodash improves, nothing else
   moves (anchors in #5338).
4. All ratchet gates green including `pnpm run check:dogfood-validation`.

## Implementation Plan

1. Run the suite, read the report immediately, and for each of the nine pull
   the test **name** and the full `wasmError`. The names identify the lodash
   function under test (`_.toString`, `_.isEqual`, `_.eq`, …); that is the
   real grouping.
2. **Two null-pointer traps first** — traps are the cheapest to bisect (WAT
   shows the exact `struct.get`/`ref.as_non_null`). Reduce with a negative
   control (standalone `.mjs`, `compileAndRunUpstreamModule`, harness
   sanity-checked). Check the #5320/#5323/#5333 capture-cell family before
   treating as new.
3. **Symbol → null (2):** reduce `String(Symbol("a"))`-shaped code and a
   `Symbol`-keyed property read on an object literal. The slot that receives
   the symbol is typed string; find the coercion (`type-coercion.ts`) or the
   `__extern_get` result typing that drops it.
4. **`-0` (1):** reduce `[-0, -0, 0, 0].join()` / `String(-0)` /
   `_.eq(-0, 0)`. Check the `f64 → string` lowering for the `-0` special case
   and `Object.is` lowering.
5. deepEqual (2) and the two booleans last — likely downstream of the above.
6. Fix each at its site; **one PR per independent cause**; regression tests;
   A/B.

## Dispatch

Model: **opus**. Nine unexamined failures with at least four distinct
mechanisms; needs diagnosis before any fix.

## Outcome

**lodash 53/62 → 58/62** on `upstream/main` `01ce47aba7`. Four residuals
remain, all newly diagnosed and all distinct from the six fixed here (see
"Residuals" below).

The spec's grouping was WRONG on two of its three named mechanisms, and the
correction is the useful part of this write-up:

| spec said | actually was |
| --- | --- |
| 2 × trap: "check the #5320/#5323/#5333 capture-cell family" | Not capture cells at all. A **host builtin stored in an object-literal callable property**; the dispatcher guard-casts it to the closure-wrapper root, the cast nulls, and `struct.get` on that null traps. |
| 2 × `object:null !== string:Symbol(a)`: "a Symbol reaching a string-typed slot and dropping to null" | The `null` had nothing to do with symbols. EVERY `_.toString(x)` answered `null`, including `_.toString('x')` — the property is named `toString`, whose field carries `eqref`, a carrier the callable-property dispatcher did not admit. The Symbol part is a SEPARATE defect that only became visible once the null was gone. |
| 1 × `object:null != string:-0,-0,0,0`: "`-0` in `f64 → string` / `join` / `Object.is`" | Same `eqref` defect. `-0` handling is fine: with the carrier admitted, `_.toString([-0, Object(-0), 0, Object(0)])` returns `'-0,-0,0,0'` with no `-0`-specific change. |
| 2 × `deepEqual object != object` | One (`_.toString` nullish values) was the same `eqref` defect. The other (`_.toArray` iterables) is unrelated and still open. |

Reduction harness: `.tmp/l5342/probe.mjs` + per-cause case files, each run with
a deliberately-false control test that must fail in BOTH lanes (it did, in
every run quoted below).

## Cause A — host builtin in an object-literal callable property (2 tests)

`_.isArray([1,2,3])` where `isArray` is lodash's published
`var isArray = Array.isArray; module.exports = isArray` trapped with
`RuntimeError: dereferencing a null pointer`. Minimal repro, no lodash:

```js
var o = { f: Array.isArray };
o.f([1, 2, 3]);        // trap
```

`compileCallablePropertyCall`'s externref branch does
`any.convert_extern` + `emitGuardedRefCast(root)`. For a genuine host function
the `ref.test` fails, so the cast yields `ref.null`, and `emitNullCheckThrow`
deliberately rethrows ONLY when the PRE-cast value was nullish (#789 — a wrong
struct type is meant to fall through to a multi-struct dispatch). A live host
function is not nullish, so the null cast reached `struct.get` and trapped.
Because a wasm trap is not catchable, the whole lodash test file died at that
point.

The remedy already existed: `callablePropertyIsExtractedHostBuiltin` routes
such values to the host method bridge, and its own comment describes exactly
this trap. It proved only one shape — a shorthand whose value is a binding
element of `const { isArray } = Array`. It could not see lodash's shape because
`valueDeclarationOf` stops at the import clause. The predicate now follows
import aliases (new oracle query `aliasedValueDeclarationOf`) and
single-initializer hops, admits a plain `PropertyAssignment` initializer, and
accepts an ambient (`.d.ts`) binding, which covers `parseInt` / `isNaN` /
`Math.max` / `Object.keys` as well. The whole proof moved out of
`calls-closures.ts` into the subsystem module
`src/codegen/expressions/callable-property-host-value.ts` — a god-file
allowance was available and deliberately not taken; the move leaves
`calls-closures.ts` 83 lines SMALLER than before this change.

Probe `.tmp/l5342/c2-hostfn.mjs`, 11 rows + control: **4/12 → 11/12 wasm**
(the 12th is the control, which fails in both lanes by construction).

**Why static and not a runtime fallback.** The general question ("is this
externref a wasm closure?") is a runtime one, and #4618 established the runtime
answer for the `__call_fn_N` dispatchers. Doing the same here means wrapping
the whole dispatch — inline ladder AND the shared `__call_cprop_deferred_N`
helper, whose ABI passes only the already-cast root and so has no access to the
raw externref — in a runtime branch, on the hottest object-literal call path in
the compiler. The declaration-proven route is byte-identical for every shape it
does not claim, and it reuses a bridge that was already proven for
`Array.isArray`. The residual (a host function that arrives dynamically, e.g.
through a parameter) is recorded below.

## Cause B — own `toString` / `valueOf` property answered `null` (4 tests)

```js
const _ = { toString: fn };
_.toString('x');       // null, silently
```

`{ toString: fn }` types that one field **`eqref`** on purpose (#4394) so the
ToPrimitive dispatchers can `ref.test` the stored closure without an externref
round-trip. `compileCallablePropertyCall` admitted `externref`, `ref` and
`ref_null` — not `eqref` — so every arm of the method-call ladder declined and
the call fell through to `calls.ts`'s graceful tail: compile the callee, `drop`,
push `ref.null.extern`. Green compile, no diagnostic, wrong answer.

Measured (`.tmp/l5342/c5-namecheck.mjs`): `toString` and `valueOf` answered
`null`; `toStr` and `toLocaleString` — same function value, different name —
were correct. That name-dependence is the tell, and it is the field CARRIER,
not an Object.prototype interception.

The fix admits `eqref` into the same branch and skips only the
`any.convert_extern` the externref carrier needs (an `eqref` already IS a
WasmGC ref, so `emitGuardedRefCast` takes it directly).

lodash effect: 54 → 56, and it is what made the two symbol failures legible —
they had been masked by the same `null`.

## Cause C — the capability-probe idiom bound `null` (2 tests)

```js
var Symbol = typeof globalThis.Symbol === 'function' ? globalThis.Symbol : undefined;
var symbol = Symbol ? Symbol('a') : undefined;
```

Two independent defects compose; **either one alone leaves the idiom wrong**,
which is why they ship together.

**C1 — `globalThis.Symbol` read the module global it was defining.** The #4500
Slice A arm answers `globalThis.<name>` / `this.<name>` from `<name>`'s wasm
module global. That is right for SCRIPT goal (§9.1.1.4.18 CreateGlobalVarBinding
makes a script's top-level `var` a property of the global object) and wrong for
a MODULE (§16.2.1.6.4 puts it in the module environment record, creating no
global-object property). `receiverIsRealmGlobalObject` refuses a shadowed
`globalThis` but never checked module-ness. The emitted `__module_init` was
literally:

```wat
i32.const 1                 ;; typeof globalThis.Symbol === "function" — folded TRUE
(if (result externref)
  (then global.get 10)      ;; <-- the not-yet-initialised `Symbol` global itself
  (else call $__get_undefined))
global.set 10               ;; Symbol = null
```

so the shadow bound `null`, stayed falsy for the rest of the module, and
poisoned every later read off it. The gate is now script-goal only, judged on
the RECEIVER's own source file (not `ctx.sourceIsModule`, which multi-file
linking sets unconditionally) and honouring `inferModuleStrictArguments ===
false`, because the test262 harness's synthetic `export function test()` wrapper
marks genuinely script-goal sources as modules and Slice A's own witnesses
(`var p1 = 7; this.p1`) are script tests. Applied to all four Slice A arms — dot
read, bracket read, nullish-comparison read, and the bracket WRITE — because
that file's own header records that a half-fixed read/write pair is worse than
neither half.

**C2 — the ternary join dropped the symbol brand.** `compileSymbolCall` returns
the js-host symbol id as a bare `i32` on purpose (#4626: branding it globally
routed mid-emission coercions through a late `__box_symbol` import whose index
shift corrupted baked `ref.func` operands — 216 regressions). Joining `symbol`
with `undefined` coerces that `i32` to `externref`, and unbranded it took
`__box_number` while the `symbol`-typed sink unboxed with `__unbox_symbol`,
which answers 0 for a JS number — hence `Symbol(wasm_0)`. The brand is
re-attached at the JOIN only. That site is already prepared for a
coercion-time late import: both arms are parked in `fctx.savedBodies` precisely
so the shift walker sees them, and the file says so.

lodash effect: 56 → 58.

## Residuals (not fixed here, each a distinct new cause)

1. **`_.constant`** — `expected truthy; got false`. `constant.call({})` /
   identity of the captured object across `lodashStable.map` over a sparse
   `Array(2).concat(...)`.
2. **`_.isArray(args)`** — the `arguments` object answers `true`. The compiled
   `arguments` carrier is materialised as a real array at the host boundary.
   (Newly visible: this test used to trap before cause A.)
3. **`_.isBoolean(_)`** — assertion 6 answers `true` for a plain object.
   lodash's `baseGetTag` goes through `getRawTag`, which writes and deletes
   `Symbol.toStringTag` on the receiver.
4. **`_.toArray(object)`** with `object[Symbol.iterator] = arrayProto[Symbol.iterator]`.
5. **Own `hasOwnProperty` property** — `{ hasOwnProperty: fn }` then
   `o.hasOwnProperty('x')` still reaches the Object.prototype host import and
   answers `false` instead of calling the own function. Same family as cause B
   but a different mechanism (interception, not carrier); no lodash test needs
   it.
6. **Host function reaching a callable property dynamically** (via a parameter
   or a later write) still traps — cause A's declaration-proven route cannot
   see it. The runtime fallback sketched above is the fix when a case appears.
7. **`symbol | undefined` has no `undefined` in the `i32` symbol carrier.** A
   local of that declared type round-trips `externref → __unbox_symbol → i32`,
   and the false arm lands on id 0. Pre-existing; cause C2 changes how it
   RENDERS (`"0"` → `"Symbol(wasm_0)"`), not whether it is wrong. Not reached by
   lodash, which only takes the true arm.

## Evidence

Base: `upstream/main` `01ce47aba75222b98484d4beea3ebde0d93577ca`
(`git merge-base --is-ancestor 68e1c0c2cb HEAD` → yes; tree clean at every
measurement).

**Regression tests** — untyped `.js` two-file fixtures, each with an
anti-vacuity control, run at one head both ways:

| lane | result |
| --- | --- |
| parent (`01ce47ab`, all fixes reverted by file copy) | **3 failed / 1 passed** — cause A `dereferencing a null pointer`; cause B `expected null to be 'v:x'`; cause C `expected +0 to be 1` |
| with the fixes | **3 files / 4 tests passed** |

The one test that passes on BOTH lanes is deliberate: it is the #4500
script-goal preservation control (`var p1 = 7; globalThis.p1 === 7` in a
sloppy script), i.e. the behaviour cause C must NOT take away.

**A/B, one head, 17 suites, one suite at a time, per test file:**

```
  webpack            base 16/16       new 16/16        delta 0
  three              base 17/18       new 17/18        delta 0
  clsx               base 32/32       new 32/32        delta 0
  cookie             base 63740/63740 new 63740/63740  delta 0
+ lodash             base 53/62       new 58/62        delta +5
  redux              base 64/82       new 64/82        delta 0
  axios              base 200/231     new 200/231      delta 0
  stylelint          base 108/108     new 108/108      delta 0
  tailwindcss        base 13/13       new 13/13        delta 0
  jsdom              base 6/6         new 6/6          delta 0
  styled-components  base 9/9         new 9/9          delta 0
  uuid               base 75/75       new 75/75        delta 0
  marked             base 9/30        new 9/30         delta 0
  moment             base 10/10       new 10/10        delta 0
  prettier           base 101/151     new 101/151      delta 0
  jest               base 329/356     new 329/356      delta 0
  hono               base 244/324     new 244/324      delta 0

net wasmPassed delta = +5; individually REGRESSED tests = 0
test files that moved: lodash/test.js  (pass 53→58, fail 9→4)
```

Every anchor in #5338 reproduced exactly. Both lanes exited 0 on all 17.

The god-file extraction (cause A's proof into its own module) happened AFTER
that A/B, so it was separately proven byte-neutral: four repro inputs covering
all three causes compile to byte-identical wasm before and after the move
(`4/4` sha256 match), and lodash re-measured 58/62 at the shipped head.

Gates at the shipped head: `check-loc-budget` OK · `check-func-budget` OK ·
`check-coercion-sites` OK · `check:oracle-ratchet` OK (+0/+0) ·
`check:dead-exports` OK · `check:dogfood-validation` OK (6/6 compiled,
6/6 validated).
