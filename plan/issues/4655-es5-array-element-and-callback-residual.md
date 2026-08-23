---
id: 4655
title: "ES5 standalone: Array residual — 20 rows: undefined/null elements degrade to NaN/0 through concat/toString/toLocaleString, filter/forEach callback+hole semantics, Array.prototype.concat unreachable as a value"
status: ready
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
loc-budget-allow:
  - src/codegen/array-methods.ts
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

Every one was probed, not assumed. **Four of the six roots I would have written
down from the failure text are refuted by a probe below** — that is the whole
value of this section, and it is why the issue's own row groupings (A/B/C) do
not survive contact: the 20 rows carry **eight** distinct roots, and the
grouping that predicts them is not "which method failed" but "which conversion
or carrier decision was made before the method ran".

| # | rows | root — as MEASURED | the attribution it REFUTES |
| --- | --- | --- | --- |
| **FIXED** | `toLocaleString/S15.4.4.3_A{1,3}_T1` | the element step asked for `toString` | — |
| R3 | `toString/S15.4.4.2_A1_T2` | a `null` element assigned into a var whose wasm carrier was already fixed to `f64` (#3580 union-collapse at the var slot) | #4641 R4's "needs a third sNaN payload `NULL_F64_BITS`" — the SAME expression in a fresh var is fully correct |
| R4 | `concat/S15.4.4.4_A1_T{2,4}`, `A3_T{1,2,3}` | the `concat` RESULT slot is still statically `number[]`, so a hole / an inherited index / an object element comes out `NaN` | "nullish elements have no representation" — read directly they are all correct |
| R5 | `forEach/15.4.4.18-3-23` | an array-like whose `length` object inherits `valueOf` from a constructor prototype visits no index | #4641 R7's "`length` is an OBJECT needing ToPrimitive" — an OWN `valueOf` works end to end |
| R6 | `filter/15.4.4.20-9-b-{14,15,16}` | the #1888 / #2141-S4 heterogeneous-element tag lie | the #4491 descriptor MOP — reproduces with NO `defineProperty` anywhere |
| R7 | `filter/15.4.4.20-9-b-2` | a `{}` that is both given a self-writing `length` accessor AND borrowed as an array-like is materialised carrying **Array's own** `length` (`value=0,w=true,e=false,c=false`) | the #4491 descriptor MOP again — §10.1.6.3 step 4.a is behaving CORRECTLY; seven single-axis probes all pass and only the combination fails |
| R8 | `toString/S15.4.4.2_A1_T4` | the element tail's `__extern_toString` and `String()` are different ToString implementations; only the latter throws when neither `valueOf` nor `toString` returns a primitive | "ToPrimitive is wrong" — `String(o)` on the same object throws correctly |
| R9 | `Array/S15.4_A1.1_T9` | ToPropertyKey does not use ToPrimitive's `valueOf` fallback | same — `String(o)` on the same object answers `"1"` |
| — | `concat/S15.4.4.4_A2_T{1,2}` | `Array.prototype.concat` read as a VALUE (#4515 cluster C1) | — but see the re-verification below |
| — | `Array/S15.4_A1.1_T10` | sparse array indexed up to 2³²−2 → `array element access out of bounds`; the dense backing store | — |
| — | `isArray/15.4.3.2-1-13` | `arguments` is materialised as a real Array, so `Array.isArray` says `true` | — |
| — | `filter/15.4.4.20-5-7` | `eval` used as a `thisArg` VALUE. **NOT MEASURED HERE** — see `## Test Results` | — |

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
| R1 | an element whose PRIMITIVE prototype method is overridden (`Boolean.prototype.toString = …`) is still rendered natively | #4655 follow-on — needs per-element boxing on the f64/i32/boolean arms; declined here on purpose (see "Deliberate scope") | an UN-overridden boolean still renders `true`/`false` |
| R2 | `Array.prototype.toLocaleString` read as a VALUE | #4515 cluster C1 (builtin-as-value) — **still open, re-verified above** | the same method CALLED works |
| R3 | a `null` element assigned into a var already typed `number[]` | #3580 union-collapse at the var slot | the same expression in a FRESH var is fully correct, including `x[2] === null` and `typeof x[2] === "object"` |
| R4 | a hole / inherited index / object element crossing `concat` becomes `NaN` | value-rep — the concat result-carrier slice | the same hole read WITHOUT `concat` is already correct |
| R5 | an array-like whose `length` object has an INHERITED `valueOf` visits no index | unclaimed | the OWN-`valueOf` twin works end to end |
| R6 | a heterogeneous element reads back as `[object Object]` after `filter` | #1888 / #2141-S4 | the HOMOGENEOUS twin — including the mid-iteration `length` shrink a prior lane suspected — passes |
| R7 | self-writing `length` accessor + array-like borrow ⇒ the object carries Array's own non-configurable `length` | array-like borrow carrier selection (value-rep). **NOT #4491** | both single-axis halves pass; only the combination fails |
| R8 | an element whose `valueOf` AND `toString` both return objects renders `""` instead of throwing | this lowering's neighbourhood — see the note below | `String()` on the same object DOES throw a TypeError |
| R9 | an object property KEY whose `toString` returns an object ignores `valueOf` | computed-member key coercion (core-semantics) | `String()` on the same object DOES use the fallback |

**R8 is the one I could have taken and deliberately did not.** It is one row
(`toString/S15.4.4.2_A1_T4`), it sits in the tail I was already editing, and the
fix is plausibly small — re-point the element tail at whatever `String()`
lowers to. It is declined because that tail is **shared with `join`**, and this
change's whole safety argument is that `join`/`toString` bytes do not move
(verified by `wasm_sha`, `## Test Results`). Re-pointing it forfeits that
argument and needs its own two-arm sweep, which is a slice, not a rider. Whoever
takes it: the discriminating probe pair is
`.tmp/probes/toprimitive-no-primitive-must-throw.js` (passes) and
`.tmp/probes/array-tostring-propagates-toprimitive-throw.js` (fails).
