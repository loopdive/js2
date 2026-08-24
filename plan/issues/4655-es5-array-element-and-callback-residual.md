---
id: 4655
title: "ES5 standalone: Array residual — 20 rows: undefined/null elements degrade to NaN/0 through concat/toString/toLocaleString, filter/forEach callback+hole semantics, Array.prototype.concat unreachable as a value"
status: done
completed: 2026-08-24
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: arrays
goal: standalone-gap
related: [4641, 4491, 1888, 2141]
assignee: dev-4655
# (#4655) The mechanism lives in the new leaf module `array-tolocalestring.ts`.
# What lands in the god-file is DISPATCH PLUMBING only: one import, one
# `isLocalizedJoin` call in each of the two native join lowerings, the
# separator-argument condition, and the three tail hook-ups. The dispatch
# `switch` itself is byte-identical — `localized` is derived from the property
# access inside the lowering rather than threaded through it, precisely to keep
# `compileArrayMethodCall` from growing (it is 603 lines and func-budgeted).
# (#4655 wave 2) The concat carrier fix. Its MECHANISM is the new leaf module
# `array-concat-carrier.ts`; what lands in the three tracked files is call-site
# plumbing only — one guarded early-return in `compileArrayConcat` (+14 in
# array-methods.ts), one arm in `moduleGlobalWasmType` (+9 in declarations.ts),
# and one arm plus a conservative spill bail (+16 in statements/variables.ts).
# The declarations.ts / variables.ts growth is restated here rather than
# inherited from #4491's grant: CI diffs the merge preview, so an allowance
# living only in an issue file THIS change-set does not modify is a stranded
# grant and fails `quality`.
loc-budget-allow:
  - src/codegen/array-methods.ts
  - src/codegen/declarations.ts
  - src/codegen/statements/variables.ts
# (#4655 wave 2) Same two functions, same reason — the slot decision is one
# ternary arm in each cascade, and it MUST live in the cascade rather than in
# the leaf module, because the cascade's order is what makes the slot agree with
# the value (see the lock-step comments this file's `## Fix` section cites).
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/statements/variables.ts::compileVariableStatement
# (#4655) ONE new `__extern_toString` reference, in the new module. §23.1.3.32
# step 6.c.i is literally `ToString(Invoke(elem, "toLocaleString"))`, so the
# ToString is the spec step, not a hand-rolled coercion matrix — and it is the
# SAME `__extern_toString` the join lane it sits next to already calls, so the
# two cannot disagree about how a value stringifies. Named once as `TO_STRING`
# and used from the three sites that need it.
coercion-sites-allow:
  - src/codegen/array-tolocalestring.ts
origin: "wave-6 lead sweep (2026-08-23) on the merged wave-4 tree (7,959/8,115). These 20 rows are owned by NO active lane: #4641 measured them and DECLINED the element half with a recorded +1/-2 observer trade-off; dev-4491 owns only the Object/* MOP directories."
---

# #4655 — Array element representation + callback/hole residual (20 rows)

## Read the prior measurement FIRST — this is not a fresh problem

#4641's decision matrix (in `plan/issues/4641-bare-return-mixed-return-f64-zero.md`)
already measured this territory and **declined it deliberately**:

- Of 1,031 array-construction sites in the ES5 corpus, exactly **one** mixes
  numeric literals with `null`/`undefined` — so the element half is not the
  17-row family the original issue claimed.
- The naive fix (reuse the existing `UNDEF_F64_BITS` sentinel for elements) was
  measured at **+1 / −2 observers** — it makes `typeof` right and `String()`
  and the `any`-box wrong. Do not re-derive this; read the table.
- `#4641` also isolated two of the `filter` rows away from the descriptor MOP:
  `[0,1,2,"last"].filter(...)` fails with **no `defineProperty` anywhere**, so
  those sit behind the heterogeneous-element tag lie (#1888/#2141-S4), not
  behind #4491.

Your job is the honest version of the fix, or a documented decline with a
better measurement than the one above. A third "+1/−2" is not progress.

## Affected rows (sweep-verified on the merged wave-4 tree, 2026-08-23)

**A. element representation through Array methods (9)**
```
built-ins/Array/prototype/concat/S15.4.4.4_A1_T2.js   arr[1] === y      got NaN
built-ins/Array/prototype/concat/S15.4.4.4_A1_T4.js   arr[0] undefined  got NaN
built-ins/Array/prototype/concat/S15.4.4.4_A3_T1.js   arr[1] === 1      got NaN
built-ins/Array/prototype/concat/S15.4.4.4_A3_T2.js   b[1] undefined    got NaN
built-ins/Array/prototype/concat/S15.4.4.4_A3_T3.js   b[1] undefined    got NaN
built-ins/Array/prototype/toString/S15.4.4.2_A1_T2.js Array(undefined,1,null,3).toString() → ",1,0,3" want ",1,,3"
built-ins/Array/prototype/toString/S15.4.4.2_A1_T4.js expected a throw, none
built-ins/Array/prototype/toLocaleString/S15.4.4.3_A1_T1.js  toLocaleString not consulted
built-ins/Array/prototype/toLocaleString/S15.4.4.3_A3_T1.js  same
```
Note the two `toLocaleString` rows may be a DIFFERENT root (an object element's
own `toLocaleString` override not consulted) — that is the same shape dev-4492
is chasing for `toString`/`valueOf` in the String conversion path. Measure
before grouping; hand over if it is theirs.

**B. callback / hole semantics (6)**
```
built-ins/Array/prototype/filter/15.4.4.20-5-7.js      RuntimeError: null pointer in __module_init
built-ins/Array/prototype/filter/15.4.4.20-9-b-14.js   newArr.length 4 vs 3
built-ins/Array/prototype/filter/15.4.4.20-9-b-15.js   newArr[2] NaN vs "prototype"
built-ins/Array/prototype/filter/15.4.4.20-9-b-16.js   newArr.length 2 vs 3
built-ins/Array/prototype/filter/15.4.4.20-9-b-2.js    Cannot redefine property
built-ins/Array/prototype/forEach/15.4.4.18-3-23.js    testResult !== true
```

**C. reflective / misc (5)**
```
built-ins/Array/prototype/concat/S15.4.4.4_A2_T1.js  concat not callable as a VALUE
built-ins/Array/prototype/concat/S15.4.4.4_A2_T2.js  same
built-ins/Array/S15.4_A1.1_T9.js                     x[1] === 0
built-ins/Array/S15.4_A1.1_T10.js                    RuntimeError: array element access out of bounds
built-ins/Array/isArray/15.4.3.2-1-13.js             isArray(arguments) must be false
```
The two `A2` rows are the builtin-as-value family — dev-4515 owns that root
(#4515 cluster C1). Verify and hand over rather than fixing here.

## Implementation Plan

1. Brief: `plan/method/es5-standalone-agent-brief.md` — BINDING, read fully
   before the first edit. Load-bearing here: methodology 1–7 (re-verify live;
   `.tmp/base-<file>.ts` revert copies at first edit; one probe per compiled
   module; **absent-not-wrong**; cross-lane third-arm rule;
   pin-exercises-the-shape; unfoldable pins; "N passed" never exit 0), the
   stale `compiler-bundle.mjs` trap, the `test262/` symlink-farm + **GITLINK
   hazard** (never `commit -a`; `git status -- test262` before every commit;
   `git diff <base>..HEAD --stat -- test262` EMPTY before finishing), the
   concrete-ref `try_table` trap, the verification floor, commit rules.
2. Read #4641's decision matrix and state, in your report, what your approach
   does that its declined option did not. If after measuring you also decline,
   that is an acceptable outcome — record the observer table.
3. B before A if the measurement supports it: a null-pointer crash and a
   `length` disagreement are usually cheaper and less ABI-invasive than an
   element-representation change.
4. Anything whose measured root is the heterogeneous-element tag lie belongs to
   #1888/#2141-S4 — attribute it there with evidence rather than patching
   around it.

## Acceptance

Scoped standalone sweep over `built-ins/Array` before AND after from your own
runs; per-file flip list; **zero regressions**. `tests/issue-4655.test.ts`
pinning each fixed family (executing the operation, loop-carried/unfoldable,
verified failing on base by revert); `it.fails` pins for measured residuals with
owners. Record `## Root cause` per cluster / `## Fix` / `## Test Results` /
`## Residuals` here. A decline with a measured observer table is a valid
outcome; an unmeasured fix is not.

---

# Result (dev-4655, 2026-08-23)

Every number below comes from a run **I executed**. Two worktrees are involved
because a container restart killed the first session mid-sweep:

| | |
| --- | --- |
| first session | `/workspace/.claude/worktrees/agent-aa58d929ef0455b8c`, branch `issue-4655-array-element-callback`, base `3e8adf0d8` |
| this session | `/workspace/.claude/worktrees/agent-a44258edd957935c5`, branch `issue-4655-array-element-callback-r2`, base `origin/main` @ `f6e094cdb` |

The work survived (the commit plus two uncommitted files were recovered and
committed first thing); the **branch name changed** only because the original
branch is still checked out in the dead worktree and the isolation layer refuses
both `git worktree remove` and `checkout --ignore-other-worktrees`.

**Every measurement in `## Test Results` was RE-RUN on the post-merge base**, so
nothing here is inherited from the pre-restart artifacts. Base arms are file-copy
reverts (`.tmp/base-array-methods.ts` / `-join-element` / `-join-proto-hole`,
captured from `origin/main`), swapped by `.tmp/to-base.sh` / `.tmp/to-fix.sh`,
with `git diff --stat -- src` read before each arm — it must name the same four
files the change touches, which is the brief's partial-restore detector. Probes
are in `.tmp/probes/`, one module per claim, each named for the question it
answers.

## What this does that #4641's declined option did not

#4641 declined the ELEMENT half after measuring the naive "reuse
`UNDEF_F64_BITS` for a `null` element" fix at **+1 / −2** observers, and
recorded the remaining work as "needs a third sNaN payload (`NULL_F64_BITS`),
a #4491-T8-sized slice, for ONE corpus row".

**I did not take that option, and the measurement says nobody should.** The
row it was sized for (`toString/S15.4.4.2_A1_T2`) does not need a new payload
at all:

| probe                                                         | `x.toString()` | `x[2] === null` | `typeof x[2]` |
| ------------------------------------------------------------- | -------------- | --------------- | ------------- |
| `.tmp/probes/nullelem.js` — `var x = Array(undefined,1,null,3)` | `",1,,3"` ✓  | **true** ✓      | `"object"` ✓  |
| `.tmp/probes/nullelem2.js` — the row's own shape: `var x = new Array(0,1,2,3); x = Array(undefined,1,null,3)` | `",1,0,3"` ✗ | false ✗ | `"number"` ✗ |

The compiler **already has a correct nullish element representation** — the
boxed/union element carrier answers all three observers. The failing row fails
because `x` is a REUSED variable whose wasm carrier was fixed to `f64` by the
earlier `new Array(0,1,2,3)`, so the reassignment coerces `null` into it. That
is #3580's union-collapse **at the var slot**, not a missing element payload,
and building `NULL_F64_BITS` would have been a #4491-T8-sized slice aimed at
the wrong layer. Recorded as residual R3 with the discriminating control.

Instead I took a root the prior measurement did not look for, because its two
`toLocaleString` rows were filed under the element-representation heading:
`Array.prototype.toLocaleString` asks each element for the wrong METHOD.

## Root cause — cluster A(iii), `toLocaleString` (FIXED)

`Array.prototype.toLocaleString` shares the `join`/`toString` lowering
(`array-methods.ts`, the `case "toLocaleString": case "toString":` fallthrough,
#2863 Phase 2). Sharing the separator is right; sharing the ELEMENT step is not
— §23.1.3.32 step 6.c.i is `ToString(? Invoke(nextElement, "toLocaleString"))`,
not `ToString(nextElement)`.

Measured with a **positive control that refutes the obvious root**:

```js
var n = 0, obj = { toLocaleString: function () { n++; return "L"; } };
[obj, obj].toLocaleString();   // base: n === 0, "[object Object],[object Object]"

var m = 0, o2 = { toString: function () { m++; return "T"; } };
[o2, o2].toString();           // base: m === 2, "T,T"   ← reflective dispatch WORKS
```

So it is not "an element's own method is never consulted" (which is the shape
dev-4492 owns for the String conversion path, and would have been the wrong
handover); it is the method NAME. `.tmp/probes/tls-1.js` / `tls-2.js`.

A second consequence of the aliasing, same root: `toLocaleString`'s reserved
`locales`/`options` arguments were being compiled as `join`'s **separator**.

## Fix

New leaf module `src/codegen/array-tolocalestring.ts` (the mechanism + its
rationale) and dispatch plumbing in `array-methods.ts`:

- `isLocalizedJoin(propAccess)` — read off the property access inside the two
  native join lowerings rather than threaded from the dispatcher, so the
  `compileArrayMethodCall` switch stays **byte-identical** (it is func-budgeted
  at 603 lines).
- `elementToLocaleStringTail` replaces the `__extern_toString` tail on the arms
  whose element can carry a user method: the boxed-any / GC-ref element arm
  (`buildJoinBoxedElementToString` gains an optional `tail`), the extern-receiver
  lane, and the #4491 lane-J prototype-hole fallback
  (`joinProtoHoleFallbackInstrs` gains the same optional `tail`). `join` /
  `toString` pass no tail and emit unchanged bytes.
- The separator argument is not compiled at all in localized mode.

**The Invoke is `__extern_get` + `__apply_closure`, not `__extern_method_call`.**
The first cut used the generic dispatcher and threw `TypeError: called value is
not a function` on the issue's own shape. Its method-resolution arm is gated on
`ref.test $Object(recv)` — the OPEN dynamic-object carrier — and an object
LITERAL is a CLOSED `$__anon_N` struct, which falls to the
`$Vec`/closure-own-property else arm and resolves null. Worth recording because
a JS-level probe does NOT establish this: the same object reached through a
computed member call `arr[0][k]()` works, because that spelling is a typed
member dispatch and never enters `__extern_method_call`
(`.tmp/probes/dyncall.js` answers `zzz=Z tls=L`).

**Scope, deliberately: boxed elements only.** The primitive arms (numeric,
the #2105 boolean arm) keep rendering natively. Host-free there is no `Intl`
and `Number.prototype.toLocaleString` degrades to ToString, so the reflective
Invoke would compute the same answer while putting a method dispatch in
`[1,2,3].toLocaleString()`. The case it leaves wrong — an OVERRIDDEN primitive
prototype method — is residual R1, pinned with its control.

**Absent-not-wrong on the method miss.** A null resolution falls back to
`ToString(elem)` (today's answer) rather than §23.1.3.32's TypeError: the
reflective read does not see every builtin prototype method, so a
`toLocaleString` this lowering cannot find is far more likely to be one it
cannot SEE than one genuinely absent.

## Root cause — the other 18 rows, and why none of them is fixed here

Every one was probed, not assumed. **Six of the twelve entries below refute an
attribution that was already written down somewhere — four of them mine.** That
is the most useful thing in this report, so the last column names the claim and
WHOSE it was rather than just saying "not X". It is also why the issue's own
row groupings (A/B/C) do not survive contact: the 20 rows carry **eight**
distinct roots, and the grouping that predicts them is not "which method
failed" but "which conversion or carrier decision was made before the method
ran".

| # | rows | root — as MEASURED | the attribution it REFUTES, and whose |
| --- | --- | --- | --- |
| **FIXED** | `toLocaleString/S15.4.4.3_A{1,3}_T1` | the element step asked for `toString` | **the issue's own note** ("may be a DIFFERENT root — an object element's own `toLocaleString` not consulted … the same shape dev-4492 is chasing … hand over if it is theirs"). It is NOT theirs: `[o,o].toString()` with `o = {toString: …}` calls `o.toString` TWICE on base. Element dispatch was already reflective; the method NAME was wrong. Handing it to dev-4492 would have been the wrong route |
| R1 | `toLocaleString/primitive_this_value{,_getter}` | primitive→string conversion never consults an overridden wrapper-prototype method — `String(true)` answers `"true"` with `Boolean.prototype.toString` overridden | **MINE**, written in `array-tolocalestring.ts`'s own header: "that row needs per-element boxing on the primitive arms". It does not — `typeof true.toLocaleString` is already `"function"`, and calling it still ignores the override, so a boxed element would inherit the same wrong answer |
| R3 | `toString/S15.4.4.2_A1_T2` | a `null` element assigned into a var whose wasm carrier was already fixed to `f64` (#3580 union-collapse at the var slot) | **#4641's R4**: "needs a third sNaN payload `NULL_F64_BITS`, a #4491-T8-sized slice". The SAME expression in a fresh var is fully correct — `",1,,3"`, `x[2] === null`, `typeof "object"` — so the payload would have been built at the wrong layer |
| R4 | `concat/S15.4.4.4_A1_T{2,4}`, `A3_T{1,2,3}` | the `concat` RESULT slot is still statically `number[]`, so a hole / an inherited index / an object element comes out `NaN` | **the issue title's** "undefined/null elements degrade to NaN/0 **through** concat/toString/toLocaleString" reads as one element-representation defect. Read directly, every one of these elements is already correct; only the trip through `concat` loses them. SUSPECTED-not-established beyond that: I did not falsify whether the value is already `NaN` inside the container |
| R5 | `forEach/15.4.4.18-3-23` | an array-like whose `length` object inherits `valueOf` from a constructor prototype visits no index | **#4641's R7**: "`length` is an OBJECT needing ToPrimitive". An OWN `valueOf` on the length object works end to end through the same borrow, so ToPrimitive-on-`length` is not the missing piece; inheritance is |
| R6 | `filter/15.4.4.20-9-b-{14,15,16}` | the #1888 / #2141-S4 heterogeneous-element tag lie | nothing new — this **CONFIRMS #4641's** isolation of these rows away from the descriptor MOP, and I re-measured it rather than inheriting it |
| R7 | `filter/15.4.4.20-9-b-2` | a `{}` that is both given a self-writing `length` accessor AND borrowed as an array-like is materialised carrying **Array's own** `length` (`value=0,w=true,e=false,c=false`) | **MINE** — I wrote "the descriptor MOP treats a `length` accessor as the array's" and probed it: seven single-axis probes ALL pass, only the combination fails. §10.1.6.3 step 4.a is behaving correctly; the carrier is pre-seeded. Owner is value-rep, **not #4491** |
| R8 | `toString/S15.4.4.2_A1_T4` | **`new Array(elem)` hands the element a carrier that loses the throw.** Same element, same call, three constructions: `new Array(both)` renders `""`; `[both]` throws; a loop-built `x[j] = both` throws | **MINE, TWICE.** First "ToPrimitive does not throw" — refuted, `String(o)` throws correctly. Then "the element tail and `String()` are different ToStrings" — refuted by my **own pin**, which was loop-carried for unfoldability, landed in a cell that WORKS, and reported `Expect test to fail` while the corpus row stayed red |
| R9 | `Array/S15.4_A1.1_T9` | ToPropertyKey does not use ToPrimitive's `valueOf` fallback | **MINE**, same wrong guess as R8 — `String(o)` on the same object answers `"1"`. Only the KEY position ignores the fallback |
| — | `concat/S15.4.4.4_A2_T{1,2}` | `Array.prototype.concat` read as a VALUE (#4515 cluster C1) | **the expectation that #4515's landing closed these.** It has landed; they still fail verbatim — see below |
| — | `Array/S15.4_A1.1_T10` | sparse array indexed up to 2³²−2 → `array element access out of bounds`; the dense backing store | — |
| — | `isArray/15.4.3.2-1-13` | `arguments` is materialised as a real Array, so `Array.isArray` says `true` | — |
| — | `filter/15.4.4.20-5-7` | `eval` used as a `thisArg` VALUE. **NOT MEASURED HERE** — see `## Test Results` | — |

The pattern in the four that were mine is worth naming, because it is cheap to
repeat: **every one was a plausible root read off the failure TEXT, and every
one died to a two-line probe that moved a single axis.** "Cannot redefine
property" reads as a descriptor-MOP bug; "expected a throw, none" reads as a
ToPrimitive bug; "the primitive arms render natively" reads as a boxing gap.
The probe that refutes each costs about a minute, and none of them needed the
compiler to be understood first.

### The cluster-C re-verification the task asked for

**#4515 has landed and the two `concat`-as-a-value rows still fail, unchanged.**
Measured on `origin/main` @ `f6e094cdb` (this session's base), both rows report
verbatim `TypeError: Array.prototype.concat is not yet callable as a value in
--target standalone`. Do not close them as covered by #4515. The same error
text, on the same base, also covers `Array.prototype.toLocaleString` read as a
value (residual R2), so the family is one root and it is still open.

## Residuals

Nine, every one pinned in `tests/issue-4655.test.ts` as an `it.fails` **plus a
positive control that passes**. The control is not decoration: an `it.fails`
alone protects whatever root you attributed from ever being tested, and in this
issue four attributions were wrong. The control is the cell that discriminates,
so if a future change repairs the residual for the WRONG reason — or breaks the
surrounding area so thoroughly that the residual "passes" — the control goes red.

| id | shape | owner | the control that pins it |
| --- | --- | --- | --- |
| R1 | an element whose PRIMITIVE prototype method is overridden (`Boolean.prototype.toString = …`) is still rendered natively | **primitive wrapper-prototype dispatch — NOT this lowering** (see below) | an UN-overridden boolean still renders `true`/`false` |
| R2 | `Array.prototype.toLocaleString` read as a VALUE | #4515 cluster C1 (builtin-as-value) — **still open, re-verified above** | the same method CALLED works |
| | *R2 rests on its own pin, not on a corpus row.* An earlier draft cited `toLocaleString/{resizable-buffer,user-provided-tolocalestring-grow,-shrink}`; on this base all three fail with `JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built` — this worktree's environment, not a root. | | |
| R3 | a `null` element assigned into a var already typed `number[]` | #3580 union-collapse at the var slot | the same expression in a FRESH var is fully correct, including `x[2] === null` and `typeof x[2] === "object"` |
| R4 | a hole / inherited index / object element crossing `concat` becomes `NaN` | value-rep — the concat result-carrier slice | the same hole read WITHOUT `concat` is already correct |
| R5 | an array-like whose `length` object has an INHERITED `valueOf` visits no index | unclaimed | the OWN-`valueOf` twin works end to end |
| R6 | a heterogeneous element reads back as `[object Object]` after `filter` | #1888 / #2141-S4 | the HOMOGENEOUS twin — including the mid-iteration `length` shrink a prior lane suspected — passes |
| R7 | self-writing `length` accessor + array-like borrow ⇒ the object carries Array's own non-configurable `length` | array-like borrow carrier selection (value-rep). **NOT #4491** | both single-axis halves pass; only the combination fails |
| R8 | an element passed to `new Array(elem)` renders `""` where the spec throws | value-rep, with R3/R4 — the carrier `new Array()` hands out | the same element in an array LITERAL throws; and `String()` on it throws |
| R9 | an object property KEY whose `toString` returns an object ignores `valueOf` | computed-member key coercion (core-semantics) | `String()` on the same object DOES use the fallback |

**R1's obvious next step is measurably the wrong one — and it was MY OWN
attribution, written in the fix's module header before I probed it.** The
module says the primitive arms are declined because they would need per-element
boxing. One probe on the base arm, with `Boolean.prototype.toString` overridden
to return `typeof this`, refutes that:

```
typeof true.toLocaleString   →  "function"     the reflective read RESOLVES
true.toLocaleString()        →  "true"         spec: "boolean"
String(true)                 →  "true"         spec: "boolean"
```

The read already finds the method; the CALL ignores the override, and so does
plain `String()`. Boxing the element and Invoking would therefore inherit the
same wrong answer — the defect is one level down, in primitive→string
conversion, and no amount of work in the array lowering reaches it.
(`.tmp/probes/primitive-element-invoke-feasibility.js`.) This is the fifth
attribution in this issue that a two-minute probe refuted, and the only one that
was mine; the module header's "Deliberate scope" paragraph is correct that the
primitive arms are out of scope and wrong about why.

**R8 is the one I nearly "fixed" in the wrong place, and the pin is what
stopped me.** I had it written down as "the element tail's `__extern_toString`
is not `String()`'s ToString — re-point it", which sits in the exact tail this
change already edits and looked like a one-row rider. The pin I wrote for it —
loop-carried, per this brief's unfoldability rule — **passed on the fix arm**
while the corpus row stayed red, and three probes then located the real axis:

| construction (same element, same call) | `x.toString()` |
| --- | --- |
| `new Array(both)` — the corpus row's spelling | renders `""`, no throw ✗ |
| `[both]` | TypeError ✓ |
| `x = []; x[j] = both` — my pin's spelling | TypeError ✓ |

So the element tail is CORRECT for two of the three carriers, and re-pointing
it would have moved bytes on `join` to fix nothing. R8 belongs with R3 and R4
in value-rep: what differs is the carrier `new Array()` hands out.

**The transferable lesson is narrower than "write unfoldable pins".** The rule
is right in general and was wrong here: when the defect IS the spelling,
rewriting the spelling for unfoldability moves the pin to a cell that passes.
Check that a residual pin still fails on the arm it claims to test, exactly as
you would for a fix pin — an `it.fails` that has stopped failing looks green
from every angle except the one that matters.
(`.tmp/probes/r8-newarray-literal.js`, `r8-array-literal.js`, `r8-loop-built.js`.)

## Recommendation on this issue's own status

Left at **`in-review`, not `done`** — deliberately, and the lead should decide
rather than inherit my judgement. The brief's acceptance bar IS met (two-arm
sweep from my own runs, per-file flip list, zero regressions with every apparent
flip and regression re-verified serially, pins that fail on the arm they claim,
`it.fails` residuals with positive controls and owners, all four required
sections). But **2 of the 20 rows flip**; the other 18 are rooted, pinned and
attributed rather than fixed. Closing this issue `done` would retire the only
place those 18 rows are written down together with the probes that root them.

Two clean options: close it `done` and spin the residual table into issues
(R3/R4/R8 into one value-rep carrier issue — they are the same defect seen from
three directions; R5, R7, R9 separately; R1 into wrapper-prototype dispatch;
R2 onto #4515), or keep it open as the tracking issue for the remaining 18. The
work is the same either way; what must not happen is `done` with no successor.

## Test Results

Both arms run by me, serially, in this worktree, against the same 649-file list
(`.tmp/sweepB.txt`), base = the main tip merged into this branch, `f6e094cdb`.
Arm state checked with `git diff --stat f6e094cdb -- src` before each arm: EMPTY
on base, exactly the four changed files on fix.

### Scoped standalone sweep — 649 files, `.tmp/B-base.jsonl` / `.tmp/B-fix.jsonl`

```
base:  pass 272   fail 203   skip 170   compile_error 4
fix :  pass 274   fail 199   skip 170   compile_error 6      (before re-verification)
```

**Flips to pass — 2, both re-run SERIALLY and confirmed:**

```
+ built-ins/Array/prototype/toLocaleString/S15.4.4.3_A1_T1.js
+ built-ins/Array/prototype/toLocaleString/S15.4.4.3_A3_T1.js
```

**Regressions — 0.** Two rows moved `fail → compile_error`; **both are the
contention trap, neither is a change**, and I only know that because I re-ran
them serially rather than reporting the tally:

| row | serial re-run |
| --- | --- |
| `Array/prototype/reduceRight/resizable-buffer-grow-mid-iteration.js` | back to `fail` — same eval-provider error as base |
| `TypedArray/prototype/toLocaleString/BigInt/detached-buffer.js` | still `compile_error` at the runner's 20 s bound; **with a 300 s bound it compiles in 26.2 s and reports the same `fail` as base.** `runTest262File`'s timeout is a POST-HOC check, so "compile_error" here means "slower than 20 s under load 15", not "broken" |

Had I reported the raw tally, this issue would have shipped claiming
`compile_error 4 → 6`.

### The zero-regression argument is byte-level, not just status-level

The change is gated on one thing: a property access spelled `toLocaleString`.
A module without that token must emit identical bytes, and the sweep records a
`wasm_sha` per row, so that is checkable rather than assertable:

| tier | what it is | identical `wasm_sha` | different |
| --- | --- | --- | --- |
| tier 1 | every corpus file mentioning `toLocaleString` (290) | 98 | **21** |
| tier 2 | `Array/prototype/{join,toString,concat}` + `built-ins/Array/*.js` (153) | 149 | **0** |
| tier 3 | deterministic 200-file sample of the other 2,916 `built-ins/Array` files | 199 | **0** |

- **Tier 2 = 0 different** is the load-bearing one: `join` and `toString` share
  both modified helper modules with `toLocaleString`, and their emitted bytes do
  not move at all. That is what makes "byte-neutral for `join`" a measurement.
- **Tier 3 = 0 different** is the empirical support for the ~2,700
  `built-ins/Array` files NOT swept: identical bytes ⇒ identical behaviour, so
  the un-swept remainder is covered by the gate argument plus this sample rather
  than by an assertion.
- All **21** tier-1 differences are files that call `toLocaleString` (Array,
  TypedArray, intl402). The gate is exact — nothing outside it moved.

**Scope stated plainly:** this is 366 of the 3,082 `built-ins/Array` files plus
277 files outside it, not all 3,082. The full-directory sweep was attempted
first and its shards were OOM-killed by the box under 5-lane load; the
tier-3 + `wasm_sha` design is the replacement, and it answers a stronger
question (bytes) on a smaller set.

### Pins — `tests/issue-4655.test.ts`, 29 tests, both arms

```
BASE arm:  Tests 6 failed | 23 passed (29)     exit 1
FIX  arm:  Tests 29 passed (29)                exit 0
```

`executed = passed + failed = 29 = total` on both arms, so nothing was silently
skipped. The 6 base failures are exactly the fixed family (the two corpus rows,
`element-invoke`, `nullish-elements-render-empty`,
`reserved-arguments-are-not-a-separator`, `borrowed-receiver`); the 3 controls
and all 9 residuals with their 11 controls pass on BOTH arms, which is what
makes the controls controls.

### Post-merge re-run

`origin/main` advanced 88 commits while the two arms were running, so after the
measurements I merged it in (plain `git merge origin/main`, tip `58fc17eae`,
clean) and **re-ran the pins on the combined tree: 29 passed (29), exit 0.**
Main's only touch to a file this change edits is `array-methods.ts`'s
`CLOSURE_SAFE_AMBIENT_GLOBALS` gaining `"Function"` (#4657) — no interaction —
but a sibling's change alters what is REACHABLE, not just what is correct, so
the re-run is the check rather than the reasoning.

The sweep numbers above are NOT re-run on that tree; they are stated against
`f6e094cdb`, which is the base both arms shared.

### What I could NOT measure

- `filter/15.4.4.20-5-7.js` — uses `eval` as a `thisArg` VALUE, and this
  worktree has no quickjs provider built, so the row reports
  `JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built` on BOTH
  arms. Its real root is the builtin-as-value family (#4515 C1), by inspection
  of the source, **not by measurement**. The same environment blocks
  `toLocaleString/{resizable-buffer,user-provided-tolocalestring-grow,-shrink}`
  and `reduceRight/resizable-buffer-grow-mid-iteration`. I did not build the
  provider because the adapter cache is shared with the lanes running
  concurrently and its freshness is a documented trap; an unshared measurement
  was not worth poisoning theirs.
- `toLocaleString/invoke-element-tolocalestring.js` stays red for an unrelated
  reason worth knowing: `TypeError: Cannot destructure 'null' or 'undefined'` at
  its `for (const { label, args } of testCases)` — a for-of destructuring
  failure over an array of object literals, plausibly the same #1888 tag lie as
  R6. It never reaches the element step this issue fixes.

---

# Wave 2 (senior-dev, 2026-08-24) — the `built-ins/Array/prototype` bucket

Worktree `/home/user/js2wasm/.claude/worktrees/agent-aa266c5cd1b8b9cc8`, branch
`issue-4655-array-prototype-bucket`, base = the campaign branch
`claude/es5-standalone-pass-rate-6tk9rb` @ `95d61ae34`.

Scope taken: the **concat** sub-family (5 rows). The other two sub-families of
this bucket (`filter` ×5, `toString` ×2, `forEach` ×1) were re-measured but not
touched — wave 1 already rooted them (R3, R5–R9) and my measurements agree.
Every number below comes from a run I executed on this branch.

**Two rows in this directory are NOT mine and are excluded from every claim**:
`concat/S15.4.4.4_A2_T{1,2}` fail with `Array.prototype.concat is not yet
callable as a value in --target standalone`. That refusal site is live work in
another lane (#4492 / the #4515 C1 builtin-as-value family). They still fail
verbatim on both arms of my change, which touches neither the refusal nor a
builtin read as a value.

## Root cause — two roots, both in `concat`, both measured before any edit

### C1 — the result SLOT, not the lowering (`A1_T2`, `A1_T4`)

The obvious reading of "undefined/null elements degrade to NaN **through**
concat" is that the concat lowering loses them. **It does not.** One probe pair
separates the two:

| probe | `x.concat(y)[1] === y` |
| --- | --- |
| `.tmp/probes/c3-object-arg-nostore.js` — read off the CALL EXPRESSION | **true** |
| `.tmp/probes/c4-store-vs-nostore.js` — the same call stored in a `var` first | **false** |
| …the same call stored in a var TypeScript cannot type `number[]` | **true** |

The §23.1.3.1 native spec loop (`array-concat-spec.ts`, #4446) already produces
a correct `$ObjVec` externref. TypeScript then types the binding from the lib
signature `concat(...items): number[]`, `resolveWasmType` turns that into
`(ref null $__vec_f64)`, and the `externref → ref_null` arm of `coerceType`
routes through the per-vec materializer, which **ToNumbers every element**.

The values identify the mechanism rather than merely being wrong:
`[0].concat(new Object(), new Array(1,2), -1, true, "NaN")` came out
`[0, NaN, 1, 2, -1, 1, NaN]` — `true` boxed as **1** and the string `"NaN"` as a
**real NaN**. That is a per-element ToNumber, not a lost value.

This is the defect wave 1 recorded as **R4** and explicitly left SUSPECTED — "I
did not falsify whether the value is already `NaN` inside the container". The
no-store probe is that falsification: it is not.

It is also wave 1's **R3** seen from the other side. R3 is a REUSED var whose
carrier was fixed by an earlier assignment; C1 is a FRESH var whose carrier is
fixed by a lib signature that is not true of JavaScript. Both are "the slot
decided the representation and the value did not survive it".

### C2 — the typed fast path never performs `Get(O, k)` (`A3_T1`, `A3_T2`, `A3_T3`)

§23.1.3.1 steps 5.c.i/ii are `HasProperty(E, k)` and `Get(E, k)` — full MOP
walks. `compileArrayConcat`'s fast paths `array.copy` the receiver's own backing,
so an index living on `Array.prototype`/`Object.prototype` is invisible to them.
Measured, with the control that refutes the wider reading:

| probe | result |
| --- | --- |
| `c7-proto-index-noconcat.js` — `a[2]` with `Array.prototype[2] = 2`, NO concat | `a[2] === 2` **true**, `a.hasOwnProperty("2")` false — the direct read already walks the chain |
| `c5-proto-index.js` — the same index through a 0-arg `concat` | `b[2] === 2` **false** |
| `c1b-sparse-concat.js` — a sparse receiver, NO prototype write | already fully correct (#4638's marker) — so the axis is the inherited index, not sparseness |

So it is not "the inherited index is never seen"; the READ path and the COPY
path disagree about one index. That is the shape #4491 lane J fixed for `join`
(`array-join-proto-hole.ts`), including its gate.

### A measurement trap this bucket sets, worth recording

Two probes disagreed with the corpus row for a while, both times because of the
**observation vehicle**, not the tree:

- Reporting `"" + b[1]` renders an ABSENT f64 slot as the string `"NaN"`, so a
  string-concatenation report cannot tell absent from a real NaN. Every observer
  in these probes is therefore `x === undefined` / `typeof x`, never `"" + x`.
- The inline `b[1] === undefined` is hole-aware; `assert.sameValue(b[1],
  undefined)` — the corpus row's own vehicle — boxes the element first and is
  not. `c10-a3t2-minimal-edit.js` (the row VERBATIM with exactly one assertion
  replaced) reports `inline=true` on the very tree where the row reports NaN.
  Adding a helper function or a `try`/`catch` to the probe perturbed the program
  enough to move the answer (`c9` trapped outright), which is why the settling
  probe is a one-line edit of the row rather than a rewrite of it.

## Fix

New leaf module `src/codegen/array-concat-carrier.ts` holding the ONE predicate
both sides ask, plus three call sites:

- `concatMustConsultPrototypeChain(ctx)` = `native-first && ctx.protoIndexDirty`.
  `compileArrayConcat` routes the whole call to `compileArrayConcatNativeSpec`
  when true. Flag clear ⇒ never reached ⇒ bytes unchanged. JS-host lane
  excluded (its `env::__array_concat_any` bridge already delegates the walk).
- `concatCallYieldsDynamicCarrier(ctx, initializer)` — true for **≥2 arguments**
  or `concatMustConsultPrototypeChain`. Consumed by the module-global slot typer
  (`declarations.ts` `moduleGlobalWasmType`), the function-local slot cascade
  (`statements/variables.ts`), and the generator spill typer (conservative bail).

**Why one shared predicate rather than a check at each site.** The defect is a
slot/value DESYNC; if the slot typer and the dispatcher disagree about which
concats are dynamic, the desync merely moves (a vec value in an externref slot,
or the reverse). `statements/variables.ts` carries half a dozen "MUST stay in
lock-step with …" comments for exactly this class.

**What the predicate deliberately declines.** The typed fast path also turns on
the runtime-probed receiver carrier (`receiverIsExternref`) and on the argument's
registered vec type index vs the receiver's. The **single-argument** case turns
on precisely those, so the predicate answers `false` there and that shape keeps
today's behaviour. Absent-not-wrong: a missing widening leaves a pre-existing bug
in place; a wrong widening creates a new one. None of the five rows needs it.

It also uses a SYMBOL-NAME test for "is the receiver array-shaped" rather than
`resolveArrayInfo`. The slot typers run in `collectDeclarations`, before any body
is compiled, and `resolveArrayInfo` → `resolveWasmType` MINTS vec types on
demand; minting one earlier than the base tree does would renumber the type
section for every module containing a concat — byte churn indistinguishable from
a real change in a `wasm_sha` comparison.

## What moved, and what did not

| row | base | after |
| --- | --- | --- |
| `concat/S15.4.4.4_A1_T2` | `arr[1] === y` → NaN | **pass** |
| `concat/S15.4.4.4_A1_T4` | fails at `arr[0]` (assertion 1) | fails at `arr[2]` (assertion 3) — residual R-H |
| `concat/S15.4.4.4_A3_T1` | fails at `arr[1] === 1` (VALUE) | fails at `arr.hasOwnProperty("1")` (PRESENCE) — residual R-P |
| `concat/S15.4.4.4_A3_T2` | fails at `b[1] === undefined` (VALUE) | fails at `b.hasOwnProperty("2")` (PRESENCE) — residual R-P |
| `concat/S15.4.4.4_A3_T3` | same as `A3_T2` | same as `A3_T2` |

One row flips. Three move from wrong values to correct values with wrong
presence — progress the pass/fail column cannot show, which is why each residual
pin carries a positive control asserting the value half, so a future presence fix
cannot be credited for it.

## Residuals from this wave

### R-P — own-index PRESENCE on a dynamic array carrier. Owner: value-rep, NOT this lowering.

`hasOwnProperty` answers **false for every index** of a `$ObjVec`, including one
holding a live `0` — measured **identically on BOTH arms**
(`c11-objvec-hasown.js`, `c14-hasown-controls.js`), so it is a PRE-EXISTING gap
that the carrier fix routes more values into, not one it introduces. Reading the
native: `__hasOwnProperty` (`object-runtime.ts` ~L4181) has `$Object`,
string-exotic, builtin-fn-meta and carrier-bag arms and **no dense-element arm**;
a non-`$Object` receiver falls to `bagHasIfAbsent` and answers 0. A statically
vec-typed receiver only answers correctly via the `provesDenseLiteralOwnIndex`
FOLD in `object-ops.ts` — `var plain = [10,11]; plain.hasOwnProperty("0")` is
true, and the same array after `a.length = 3` is **false**.

Deliberately not fixed here. The obvious shape — a consult-only prologue that can
only turn `false` into `true` — is monotone and looks safe, but
`__hasOwnProperty` is what the entire test262 `propertyHelper` harness runs
through, and this issue has no measurement for that blast radius. It wants its
own issue and its own sweep.

### R-H — an all-elisions array literal as a concat operand. Root NOT isolated; do not inherit it as one.

`A1_T4` is `[,1].concat([], [,])`. The measured axis is whether the elision has
a NON-HOLE SIBLING in the literal:

| operand | spread through concat |
| --- | --- |
| `[, 5]` (`c15`, `c16`) | element reads back absent ✓ |
| `[,]` inline (`c16`) | reads back a plain **number** ✗ |
| `[,]` via a `var` (`c12`) | reads back an **object** ✗ |
| `[,][0]` read directly (`c12`) | `=== undefined` **true** — the static read is correct |

The natural story — "the dynamic read chokepoint hands back the raw marker" — is
**not established**: `Array.prototype.indexOf.call([,], undefined)` answers `0`
on BOTH arms (`c17`), which is inconsistent with it, and `indexOf` has its own
scan (`array-indexof-scan.ts`). I did not determine which path answers. Recorded
as the axis plus its control, not as a root. Owner: value-rep hole-marker
carrier selection (#4491 T11 family).

### R-B — #4638's absent concat marker survives `===` and NOT a boxing boundary. Owner: value-rep.

Found by a pin that was written as a CONTROL and went red. In a module where the
gate is CLEAR and neither half of this change can execute (0 arguments, no
prototype-index write), `var a = [0,1,2]; a.length = 5; var b = a.concat();`
gives (`.tmp/probes/c18-absent-tail-boxing.js`):

```
b.length = 5   b[2] = 2   b[3] === undefined  →  true
                          assert.sameValue(b[3], undefined)  →  NaN
```

So #4638's `emitConcatResultBacking` marker is only **half** observable: the
comparison fold reads it, the `f64 → externref` box does not. **This is the root
of `A3_T{2,3}`'s BASE failure** (`b[1] expected undefined, got NaN`) — the
element was already marked absent and the boxing threw the mark away. The C2 fix
sidesteps it for gate-dirty modules by making the result an `$ObjVec`, where
absence is a null externref; it does not repair the marker, and gate-clear
modules keep it.

The seam already exists: `coerceType`'s `f64 → externref` arm selects
`undefSentinelAwareBoxInstrs` for an f64 branded `{ undefSentinel: true }`, and
that arm's own comment names "a value read from a slot that genuinely holds
`undefined`" as the intended trigger — an f64 **vec element read** is one. Not
taken here: the brand reaches every f64 vec element boxed to `any`, and this
issue has no measurement for that. (Note the arm tests `UNDEF_F64_BITS` only, so
a successor also has to decide the `HOLE_F64_BITS` twin.)

### An incidental measurement worth keeping: two spellings of "a sparse array" are not the same carrier

The first draft of the prototype-chain pins built the receiver as
`var a = []; a[0] = 0; a.length = 3` rather than the corpus spelling
`var a = [0]; a.length = 3`. **Five pins went red on the fix arm, including a
control that passes on both arms by construction.** With the loop-built
spelling, even the DIRECT read misbehaves: `a[2]` does not see
`Array.prototype[2]`, and `a[1]` reads `0` instead of absent. The literal
spelling gets both right. That is a separate defect from anything in this issue
(the grow-gap marker on an empty-literal-then-indexed-write array, #4491 T8-A
territory) and it is also a live methodology hazard: "make the pin unfoldable"
moved the pin to a different carrier, which is #4655's own R8 lesson repeating
in a new costume. The pins below keep the array LITERAL and loop-carry only the
element values (`[__n - 3]` is `[0]`).

### Re-measured, unchanged, agreeing with wave 1

`filter/15.4.4.20-9-b-{14,15,16}` (R6), `filter/15.4.4.20-9-b-2` (R7),
`forEach/15.4.4.18-3-23` (R5), `toString/S15.4.4.2_A1_T2` (R3),
`toString/S15.4.4.2_A1_T4` (R8) all fail with the identical error text on both
arms of this wave. `filter/15.4.4.20-5-7` is still unmeasurable in an agent
worktree — it needs the quickjs provider (`JS2WASM_EVAL_ENGINE=quickjs but the
quickjs provider is not built`), exactly as wave 1 reported.

## Things I considered and rejected

- **Widening the slot on the JS-host lane too.** `compileArrayConcatExternHost`
  also returns externref, so the same desync exists there. Excluded anyway: it
  would move bytes on the lane where the dogfood corpus and the npm-compat
  suites live, for zero rows in this campaign, with no measurement of the cost.
- **Making `__extern_get_idx` map the `$Hole` struct to `undefined`** — the
  first-guess fix for R-H. Dropped because the probe that would have justified
  it (`c17`) contradicts its premise. See R-H.
- **A dense-index consult arm in `__hasOwnProperty`** — the fix for R-P. See
  above; the blast radius is the whole `propertyHelper` harness.

## Test Results (wave 2)

All arms run by me in this worktree. Arm state checked before each arm with
`git diff HEAD --stat -- src` **plus an explicit presence check for the new,
untracked-at-the-time module** — `git diff` alone is blind to an untracked file,
so a "restore" that left it behind would have measured a hybrid tree and said
nothing.

### Scoped two-arm sweep — 358 files

Sized from the blast radius, not from a directory name. Both halves of the diff
are keyed on a `.concat(` CALL, so the list is:

- **`behav.txt` (233)** — every corpus file that CAN be reached: all `.concat(`
  callers, plus the whole `concat` directory and `built-ins/Array` top level.
- **`bytes.txt` (125)** — a deterministic sample of files that CANNOT be reached
  (`join`/`toString`/`toLocaleString`/`filter`/`forEach`/`slice`/`indexOf`),
  swept on both arms for **`wasm_sha` identity**. That answers a stronger
  question than pass/fail on the set where the claim is "nothing moved".

**Dropped, and why:** the remaining ~2,700 `built-ins/Array` files and the rest
of the corpus. The first cut of this sweep was 782 files and was running at ~8
rows/min under 4-lane load — ~3.3 h for two arms, for a change whose reach is
bounded by construction. The byte-identity tier is the replacement argument.

**Load** (lead ruling: ≤7 with per-arm recording, because with two sibling lanes
sweeping continuously this box never reaches <5 and the original <5 gate became
a deadlock):

```
ARM fix  START 12:01:22 load 6.24   END 12:12:45 load 7.58   358 rows
ARM base START 12:13:45 load 4.86   END 12:22:36 load 5.69   358 rows
```

```
base:  pass 189   fail 115   skip 50   compile_error 4
fix :  pass 190   fail 114   skip 50   compile_error 4
```

Denominators match exactly (358 = 358), so no row silently disappeared between
arms. The four `compile_error` rows are the SAME four files with the SAME error
text on both arms (three `Reflect.construct` NewTarget, one `__get_builtin`) —
no contention artifacts to re-verify.

**Flips to pass — 1:**

```
+ built-ins/Array/prototype/concat/S15.4.4.4_A1_T2.js
```

Independently measured twice on each arm: once in a **serial single-process**
run of the 15-row bucket list (`.tmp/base15.jsonl` / `.tmp/myrows-fix2.jsonl`)
and once in this 2-shard sweep. Both agree.

**Regressions — 0. Other status moves — 0.**

**Movement WITHOUT a flip** (recorded separately so the campaign's row count
stays auditable — these are NOT flips and must not be counted as any):

| row | base fails at | fix fails at |
| --- | --- | --- |
| `concat/S15.4.4.4_A3_T1` | `arr[1] === 1` — the inherited VALUE | `arr.hasOwnProperty("1")` — PRESENCE |
| `concat/S15.4.4.4_A3_T2` | `b[1] === undefined` — the absent VALUE | `b.hasOwnProperty("2")` — PRESENCE |
| `concat/S15.4.4.4_A3_T3` | same as `A3_T2` | same as `A3_T2` |
| `concat/S15.4.4.4_A1_T4` | assertion 1, `arr[0]` | assertion 3, `arr[2]` |

### Byte identity — the argument for everything not swept

| tier | set | identical | different |
| --- | --- | --- | --- |
| reachable (`behav`) | 179 rows with a `wasm_sha` on both arms | 171 | **8** |
| unreachable sample (`bytes`) | 125 | **124** | **1** |

All 8 reachable differences are `concat` sites (six `concat/S15.4.4.4_*`, one
`concat/15.4.4.4-5-b-iii-3-b-1`, one stray `test/__probe4638__/p-holes.js` left
in the shared checkout by another lane — it calls `.concat(`).

**The single unreachable difference is a finding about my LIST, not about the
change, and it closes exactly.** `toLocaleString/user-provided-tolocalestring-shrink.js`
contains no `concat` — but it carries `includes: [resizableArrayBufferUtils.js]`,
and that HARNESS file's line 67 is `const ctors = builtinCtors.concat(MyUint8Array,
MyFloat32Array);` — a two-argument concat in a declaration initializer, i.e. the
predicate firing exactly as designed. I built both lists by grepping the TEST
sources and forgot that `includes:` splices harness code into the same
compilation unit. Re-checking the whole sample against its includes:
**exactly 1 of the 125 pulls in a concat-calling harness, and it is the same
file.** So the byte claim is exact — 124/124 truly-unreachable files identical
— rather than 124/125 with an unexplained exception. (Also checked: the
differing `wasm_sha` is REPRODUCIBLE on one arm — two runs of the fix tree give
`8bf3ab6a2612` twice — so the cross-arm difference is not compile
nondeterminism.)

### Pins

| suite | base arm | fix arm |
| --- | --- | --- |
| `tests/issue-4655-concat-carrier.test.ts` (new) | `Tests 7 failed \| 7 passed (14)` | `Tests 14 passed (14)`, file line `(14 tests)` with no `skipped` |
| `tests/issue-4655.test.ts` (wave 1) | — | `Tests 29 passed (29)` |
| `tests/equivalence/array-zero-arg-methods.test.ts` | — | `3 passed (3)` |

`executed = passed + failed = 14 = total` on both arms of the new suite, so
nothing was silently skipped (brief tier 1, strong form). The 7 base failures are
the five fix pins plus the two arms I initially mislabelled as both-arms
controls — **the base run is what caught the mislabelling**; their notes now say
plainly that they fail on base.

**An `it.fails` that stopped failing.** Wave 1's residual
`R4-concat-loses-the-hole` **passes** on this tree, so its `it.fails` went red
with `Expect test to fail`. That is the mechanism the brief asks lanes to watch
for, working: wave 1 recorded R4's root as SUSPECTED and named the observation
that would settle it; wave 2 ran that observation, the root was right, and the
pin is now an ordinary `it`. Its corpus row `A1_T4` still fails, at a different
assertion and for the different root R-H, which the converted pin deliberately
does not assert.

### What I could NOT measure

- `filter/15.4.4.20-5-7.js` and the `toLocaleString/{resizable-buffer,
  user-provided-tolocalestring-grow,-shrink}` family need the quickjs provider,
  which is not built in this worktree; they report
  `JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built` on BOTH
  arms. Same environment limit wave 1 reported, and same reason for not building
  it: the adapter cache is shared with the lanes running concurrently and its
  freshness is a documented trap.
- The JS-host / gc lane. Nothing here was measured there; the change is gated to
  `native-first` providers, so the host lane's bytes cannot move — but that is a
  gate argument, not a measurement.

## Closed by the lead (2026-08-24) — successor named

Wave-6 landed `Array.prototype.toLocaleString` (+2). Wave-7 landed the `concat`
result-slot carrier and the prototype-index consult (+1: `concat/S15.4.4.4_A1_T2`), and
**closed wave-1's R4**, which had been left explicitly SUSPECTED — its recorded
counter-evidence ("`join` also says NaN") was not counter-evidence, because the per-vec
materializer converts on the way *in*.

`done` rather than `in-review`: I am the merger, so `in-review` would orphan it.

The remaining rows are **not** dropped — after the value half was fixed they fail on
element **presence**, which is a different root and now carries its own issue:
**[#4670](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4670-array-dense-element-presence-and-hole-markers)**
(R-P `__hasOwnProperty` has no dense-element arm · R-B #4638's absent-concat marker
survives `===` but not a boxing boundary · R-H the `[,]` operand, root **not isolated and
not claimed**). #4670 also carries the separate live grow-gap-marker defect this lane
found while making its pins unfoldable.
