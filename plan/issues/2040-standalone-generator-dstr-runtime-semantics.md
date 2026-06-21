---
id: 2040
title: "standalone: generator/destructuring runtime-semantics residual — rest-pattern iterator consumption, lazy defaults, private elements (~1,750 tests)"
status: done
assignee: ttraenkler/sd-3
sprint: 64
created: 2026-06-10
updated: 2026-06-21
completed: 2026-06-21
priority: critical
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: generators, destructuring, classes, private-names
goal: standalone-mode
related: [1665, 680, 1326c, 2038, 2037]
test262_bucket: standalone-dstr-generator-runtime
test262_count: 1750
es_edition: es2015
origin: "2026-06-10 standalone-vs-host baseline diff: 1,112 dstr-directory + 639 generator/class-elements runtime assertion failures that compile and instantiate fine in standalone but compute wrong values."
---

# #2040 — standalone generator/destructuring runtime-semantics residual

## Problem

The largest *runtime* (not compile) residual in the standalone lane:
~1,750 gap tests compile, instantiate, and run, but fail assertions. Host mode
passes all of them. Two clusters:

**A. `dstr/` directories (1,112 rows)** — destructuring evaluation semantics
through the native (pure-Wasm, #1665) generator/iterator machinery:

| Count | Failing assertion | Meaning |
| ---: | --- | --- |
| ~450 | `assert.notSameValue(x, values)` (assert #6, `returned 7`) | array **rest** pattern `[...x] = values` must create a *new* array from the iterator ([§8.6.2 IteratorBindingInitialization, BindingRestElement](https://tc39.es/ecma262/#sec-runtime-semantics-iteratorbindinginitialization)); standalone aliases the source array |
| ~165 | `assert.sameValue(x, <n>)` element/default values | iterator-driven element binding gets wrong value (off-by-one `next()` consumption or default applied when value present) |
| ~120 | `returned 2`/`L#:#` empty error in `meth-ary-ptrn-rest-*` | rest-pattern via method params |
| ~90 | `array element access out of bounds [in C_method()]` | rest/elision indexing past materialized length |
| rest | `dflt-*` lazy-default families | defaults evaluated eagerly or not at all |

Example: `language/statements/class/dstr/async-gen-meth-static-dflt-ary-ptrn-elem-ary-rest-iter.js`
returns 7 (assert #6 `assert.notSameValue(x, values)`) on main @ 936d1ac51 —
the rest binding `x` IS the source iterable instead of a fresh array.

**B. generator / class-elements (639 rows)** — generator-object semantics:

| Count | Failing assertion | Meaning |
| ---: | --- | --- |
| ~140 | `assert.sameValue(executed, false)` / `assert.sameValue(accessed, false)` | eager evaluation of code that must be lazy (generator body runs at call instead of first `next()`, or property getter probed during compile-time dispatch) |
| ~220 | `assert.sameValue(c.m().next().value, 42)` / `C.m().next().value` | generator **methods** (incl. static, private-name `#m`, computed) return wrong `value` — plain `function*` passes, the method/private forms diverge |
| ~50 | `assert.sameValue(inst.getPrivateReference(), 'get string')` etc. | private accessor/method references inside generator bodies |
| ~48 | `"arguments" in this === false` (eval-code/direct) | overlaps #1066 eval scope — exclude from this issue |

## Why one issue

Both clusters sit on the same machinery: the native generator state machine
(#1665) + IteratorBindingInitialization codegen. A dev fixing rest-pattern
copy semantics and `next()` consumption order will touch the same
`src/codegen` generator/destructuring lowering for A and most of B's
`next().value` rows. If the architect prefers, split A (destructuring
evaluation order, ~1,100) from B (generator-object/private-elements, ~590)
after the first WAT-level diagnosis.

## Suggested approach

1. Start with the highest-leverage single bug: **BindingRestElement must
   `ArrayCreate` + append from the iterator**, never alias. (~450 rows.)
2. Then audit `next()` consumption order for `ary-ptrn-elem-*` with defaults:
   spec order is: call `next()` once per element, use default only when
   `done` or value `undefined`.
3. For B: compare WAT of `class C { *m() { yield 42; } }` (passes) vs the
   failing `new-sc-line-gen-rs-privatename-identifier-initializer.js` form to
   find where method-position generators diverge.

## Investigation (sd-3, 2026-06-21) — cluster A rest-identity diagnosis

Reproduced on current origin/main via `runTest262File` (HOST vs STANDALONE):
`class/dstr/*ary-ptrn-rest*` → **HOST 12/12 pass, STANDALONE 6/12**; the 6 fails
are all `assert.notSameValue(x, values)` (`returned 7`, assert #6): the rest
array `x` reads as **reference-identical** to the source `values`.

**Ruled OUT — the codegen DOES build a fresh rest array in BOTH lanes:**
- Typed `method([...x]: number[])` → fresh (`array.new_default`+`array.copy`+
  `struct.new`, the `__rest_arr` build at destructuring-params.ts:1644-1681).
- UNTYPED `method([...x])` (the exact test262 shape, externref param arm) →
  the full `$C_method` WAT *also* contains `array.copy:1` + `array.new_default:5`:
  the externref param is materialized to a fresh `resultLocal` vec, then the rest
  copies that into `x`. So `x` is a copy-of-a-copy — structurally NOT the source.

**So the alias is NOT a missing rest copy. PROVED via pure-standalone probes
(no harness, bare `{}` instantiate):**
- `class C { method([...x]){ x.push(99); ... } }; method(values)` → after the
  call `values.length === 3` and `x.length === 4`: **`x` is structurally a fresh,
  independent array** (mutating it does not touch `values`).
- `Object.is(x, values)` for the rest case returns **`0` (NOT same)** — correct;
  `Object.is(distinct arrays)`=0, `Object.is(same)`=1, `===` on distinct arrays=0
  all correct standalone.

**Conclusion: the destructuring rest codegen AND `Object.is`/reference-identity
are CORRECT in pure standalone.** The `assert.notSameValue(x, values)` failure
manifests ONLY through the test262 **harness-wrapped** path (the harness
`assert.js` + `env`-import instantiate the runner provides; a bare `{}`
instantiate of the harness traps on `Import #0 "env"`). So the headline ~450-row
cluster A is most likely NOT a destructuring/generator lowering bug at all — it is
either a `harness/assert.js` `notSameValue` lowering issue or a host-bridge
marshaling-identity artifact specific to the runner, surfacing only when the two
vecs cross the `env` boundary for the assert.

**NEXT SESSION (re-scope before coding):** run ONE failing file under the runner
with the rest binding replaced by an in-wasm `Object.is(x, values)` return (no
`assert`) to confirm the codegen value is right and isolate `assert.notSameValue`;
then inspect `assert.notSameValue`/`SameValue` lowering + the runner's `env`
marshaling (`__make_iterable`, vec→JS) for an identity collapse. The fix is very
likely in the marshaling/`SameValue` path, NOT destructuring-params.ts — which
would re-scope cluster A's count substantially. The `directCastInstrs` fast-path
(destructuring-params.ts:1122-1126, `resultLocal = param` no-copy for an already-
`__vec_externref` param) was checked and is NOT the cause (the rest still builds a
fresh vec downstream: the untyped `$C_method` WAT has `array.copy:1`).

Orthogonal smaller slice found: `const [a=9] = [undefined]` → NaN (default not
applied when the element value is `undefined`); spec §8.5.3 applies the default on
`undefined`, not just `done`. Filed as **#2574**.

## ROOT CAUSE FOUND — standalone `__any_strict_eq`/`__any_eq` tag-5 number bug (sd-3, 2026-06-21, supersedes the "harness/marshaling" hypothesis above)

NOT the runner, NOT marshaling, NOT destructuring. The harness `assert._isSameValue`
(`if(a===b){return a!==0||1/a===1/b;} return a!==a && b!==b;`, `a`/`b` `any` params)
miscompiles in **standalone ONLY** (wasi + host both correct).

**Minimal repro (no if / no destructuring):**
```ts
function f(a:any,b:any){ const d=(1/a===1/b); const n=(a!==a); return n; }
f(1,2)   // standalone: true (WRONG)   wasi/host: false
```
Also breaks with `String(a)` / `a*2` / `a-1` in place of `1/a` — i.e. **ANY
`any`-op that ensures the AnyValue type before a self `===`/`!==`.**

**Mechanism (WAT-proven):**
1. `a!==a` ALONE → the correct abstract-eq cascade (`__typeof_number`→
   `__unbox_number`→`f64.eq`, 15 calls) → right answer.
2. After a preceding `any`-op, `ctx.anyValueTypeIdx >= 0`, so the gate at
   `binary-ops.ts:967-980` routes the SAME `a!==a` through
   `compileAnyBinaryDispatch` → `__any_strict_eq` instead.
3. `compileAnyBinaryDispatch` boxes each operand via `boxToAny`
   (`value-tags.ts:178-186`), which — by the **deliberate #1888 policy**
   ("box-the-externref as tag-5"; honest recovery flipped −794 baseline) — boxes a
   NUMBER externref as **tag 5 (string)**.
4. The tag-5 arm of `__any_strict_eq` / `__any_eq` (`any-helpers.ts` ~1607 / ~1339)
   compares the two field-4 externrefs with `__str_equals`. For two tag-5 boxes
   wrapping the SAME number externref that is meaningless → "unequal" → `a!==a`
   true. `_isSameValue` then wrongly returns true → EVERY `assert.sameValue`/
   `notSameValue` over a numeric `any` fails (a huge fraction of test262 — likely
   ≫ 450 rows). This is the true cluster-A driver.

**Proven-viable fix direction (but #1888-pinned — needs full-baseline validation):**
- `__any_to_f64(tag5BoxOfNumber)` DOES recover the number (its #1888 $BoxedNumber
  arm) — confirmed: `a*2; return a+0` → 5 standalone. So the tag-5 EQUALITY arm in
  BOTH helpers should disambiguate by the RUNTIME externref: `__str_equals` only
  when BOTH field-4 externrefs `ref.test ctx.anyStrTypeIdx` (genuine native
  strings); otherwise `__any_to_f64` both + `f64.eq`.
- sd-3 attempted exactly this (both helpers, nativeStrings-gated) but the emitted
  tag-5 arm still returned wrong in a way the local WAT couldn't fully explain (the
  arm appeared dead/folded even with `optimize:false`), so it was **REVERTED** to
  avoid a half-fix in the #1888-pinned representation. The boxing itself
  (`__any_box_string` for externrefs) MUST NOT change (−794). The fix belongs in the
  equality helpers' tag-5 arm and must be gated by the full standalone baseline
  (merge_group), not a scoped local check.

**ESCALATED to tech lead** — high value (top-tier standalone unlock), high risk
(#1888 794-test representation). Wants an architect spec + full-baseline gate before
landing. The `directCastInstrs` rest-copy theory was ruled out (the rest IS fresh;
the failure is purely the equality helper).

## PINPOINTED + fix attempt (sd-3, 2026-06-21 round 2) — needs architect spec for the representation matrix

**The exact dead line:** in `__any_strict_eq` / `__any_eq` (`any-helpers.ts`), the
tag-5 (string) arm is `strEqualsIdx >= 0 ? [__str_equals] : [i32.const 0]`.
`strEqualsIdx = ctx.jsStringImports.get("equals")` is **-1 in standalone** (no
JS-string imports), so the arm is the hardcoded **`i32.const 0`** → EVERY tag-5
`===`/`==` returns false. A NUMBER `any` is boxed as tag-5 by `boxToAny`
(`value-tags.ts:178`, the #1888 policy), so `5 === 5` → tag-5 → `i32.const 0` →
false. Confirmed minimal: `function f(a:any){const m=a*2; const x:any=5; const
y:any=5; return x===y;}` → false standalone.

**Fix attempt (REVERTED):** replace the standalone `i32.const 0` with a runtime
disambiguation — recover numbers via `__any_to_f64`+`f64.eq`, real strings via
native `__str_flatten`+`__str_equals`. The numeric half WORKS (`5===5` true,
`isSame(1,2)` false, all the `_isSameValue` repros pass) and a scoped broad sweep
was **net +3** (equals +2, strict-equals +2) — BUT it **regressed array-string
`indexOf`/`includes` by −1** (`["abc"].indexOf("abc")` → -1).

**Why the regression — the representation matrix is the blocker:** the tag-5 box's
field-4 is NOT one uniform type. `__any_box_string` (the `any`-literal / dispatch
path) and `__any_from_extern` (the array-search path, `any-helpers.ts:194` —
`fallbackStringAny`, field-4 = the raw externref) tag BOTH numbers AND strings as
tag-5, and the field-4 externref of an array-element string does NOT pass
`ref.test ctx.anyStrTypeIdx` (it is some other string rep — `$NativeString` /
`wasm:js-string` / cons), so the string-vs-number discriminator mis-routes it to
the numeric arm → NaN → no match. An inverted discriminator (`ref.test
nativeBoxNumberTypeIdx`) then mis-caught arrays. **Every local discriminator hits
a different field-4 representation gap** — exactly the #1888 hazard.

**What an architect spec must settle (the real work):** a single, correct
field-4 type discriminator (or a normalized box) covering ALL tag-5 producers
(`__any_box_string`, `__any_from_extern`) × ALL inhabitants (number / native
string `$AnyString` vs `$NativeString` vs cons / host-string externref / object).
The cleanest landing is probably to make `boxToAny`/`__any_from_extern` carry a
SUB-TAG (or store a `$BoxedNumber` vs string discriminant in a reserved field) so
`__any_strict_eq` can branch deterministically — but that touches the #1888
representation and MUST be gated by the full standalone baseline (merge_group),
not a scoped sweep (the scoped sweep showed +3 but hid the indexOf −1; the real
delta is large because `_isSameValue` gates a huge fraction of asserts).

**Recommend `/architect-spec` on this** (AnyValue tag-5 field-4 representation +
equality). The numeric `_isSameValue` fix is proven; only the string/array
co-existence needs the representation design.

## Acceptance criteria

- `assert.notSameValue(x, values)` family passes: rest pattern yields a fresh
  array (≥400 rows).
- `dflt-ary-ptrn-elem-*` default-evaluation rows pass (lazy, spec-ordered).
- Private/static generator-method `next().value` rows pass.
- Standalone baseline runtime-fail count in `dstr/` halves (≤550); host
  unchanged.

## Implementation Plan (arch-2040 spec → implemented by sd-3, 2026-06-21)

Cluster A's `assert.notSameValue/_isSameValue` failures were NOT a destructuring
bug (the rest array IS fresh, `Object.is` is correct in pure standalone). The
root cause is the **standalone AnyValue tag-5 equality arm**, fixed here.

**Root cause.** The tag-5 (string) arm of `__any_eq` / `__any_strict_eq`
(`any-helpers.ts`) was `strEqualsIdx >= 0 ? [host __str_equals] : [i32.const 0]`.
`strEqualsIdx = ctx.jsStringImports.get("equals")` is **-1 in standalone**, so the
arm was a **dead `i32.const 0`** → EVERY tag-5 `===`/`==` returned false. A NUMBER
`any` is boxed as tag-5 by the #1888 `boxToAny` blanket policy, so `5 === 5` →
false → the test262 harness `assert._isSameValue` (`if(a===b){…} return a!==a &&
b!==b`, `a`/`b` `any`) broke, failing every numeric-`any` sameValue/notSameValue
once any prior `any`-op set `anyValueTypeIdx`.

**Design (consumer-side ONLY — NO #1888 boxing change, preserves the −794 gain).**
The producers are already type-consistent: a tag-5 field-4 externref (after
`any.convert_extern`) is exactly one of `$__box_number` (number), an `$AnyString`
subtree (string), or a host/object externref. `__any_from_extern` already peels
number→tag3 / bool→tag4 before its tag-5 fallback (no change). We make CONSUMERS
run a 3-way discriminant instead of trusting "tag-5 ⟹ string":
1. `__any_strict_eq` / `__any_eq` tag-5 arm — **REPLACE** the dead ternary with
   `tag5NativeEqInstrs()`: both `$__box_number` → `__any_to_f64`+`f64.eq`; both
   `$AnyString` (BASE type) → flatten + native `__str_equals`; **else** →
   REFERENCE IDENTITY (`ref.eq` via the eq heap type) so `a===a` over an
   array/object `any` is true; mixed primitive → 0.
2. `__any_eq` cross-tag str⇄num, `__any_typeof`, `__any_to_string`, `__any_to_f64`
   — AUDITED: already correct (the `__any_to_f64` #1888 `$BoxedNumber` recovery is
   the precedent the whole contract follows). `typeof`(any-number)="number",
   `String`(any-number) decimal, loose `5=="5"` all verified.

**Traps avoided (from 3 reverted attempts):** (1) `ref.test` the `$AnyString`
BASE (`ctx.anyStrTypeIdx`), NOT `$NativeString` (cons/utf8 subtypes → indexOf −1);
(2) a true 3-way so objects fall to ELSE; (3) REPLACE the whole dead ternary, not
nest inside it; (4) the ELSE must be ref-identity, not `0`, or `a!==a` over arrays
mis-returns.

**Validation.** 9 scoped tests + comprehensive probe pass; broad standalone sweep
equals/strict-equals/addition/Number/indexOf/Object.is **444 vs 440 (+4, indexOf
flat)**; wider sweep includes/lastIndexOf/find/Math/Boolean **0 regressions**;
gates hard-error/any-box/coercion OK; #1461 array-search + equality/AnyValue test
suites green. The authoritative −794-catching gate is the FULL standalone
merge_group (#2097 floor) — enqueued for that.

The carved-out class/object-literal METHOD-generator host-import leak is #2571
(separate); the orthogonal `[a=9]=[undefined]→NaN` default slice is #2574.
