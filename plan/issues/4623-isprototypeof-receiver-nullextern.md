---
id: 4623
title: "two-lane: `<plain object>.isPrototypeOf(v)` compiles the receiver/argument to ref.null extern — answers false with no constructor anywhere; blocks S13.2.2_A1_T1/_T2"
status: done
sprint: current
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: prototype-chain
goal: standalone-gap
related: [4506, 4480, 4556]
origin: "dev-4506 residual (2026-08-23): WAT-decoded — the highest-value single defect left in the fnctor/prototype families. Reproduces on --js-host too (two-lane), per #4480's 2026-08-20 record."
loc-budget-allow:
  # +14 in the driver: the arm invocation + the placement comment (see
  # func-budget rationale below); the arm's body lives in the new
  # is-prototype-of-call-arm.ts module.
  - src/codegen/expressions/calls.ts
func-budget-allow:
  # The fix is ONE arm invocation placed at the last decision point of
  # `compileCallExpression`, immediately before `compileTailDispatch` — the only
  # place where BOTH lanes converge (they reach the wrong answer from two
  # different upstream arms; see ## Root cause). Moving it earlier would put it
  # in front of receiver-typed dispatchers that answer correctly today, and
  # moving it later (into `compileCallDispatchTail`) was measured NOT to work:
  # standalone never reaches the tail for this shape. The whole grant is +13
  # lines, of which 8 are the comment that records exactly that.
  - src/codegen/expressions/calls.ts::compileCallExpression
---

# #4623 — isPrototypeOf receiver compiles to ref.null extern

## Problem (measured by dev-4506, WAT-decoded)

```js
var P = { q: 1 };
var o = Object.create(P);
P.isPrototypeOf(o)   // → false;  "q" in o → true, same module
```

No constructor involved anywhere. WAT decode on the campaign branch: the
call site emits `global.get <P>; …; ref.null extern; call
$__isPrototypeOf` — the ARGUMENT (or receiver, verify which slot) is
compiled to `ref.null extern` instead of the object's carrier, so the
runtime chain walk starts from null and answers false.

This is the general form of the wrong boolean #4480 recorded on
2026-08-20, and it **also reproduces on `--js-host`** — a two-lane defect,
so the fix needs a two-lane test. It is what actually blocks
`language/statements/function/S13.2.2_A1_T1.js` and `_T2` (per #4506's
issue file, which has the full provenance).

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-verify
   the WAT shape on current campaign HEAD (a770288c7 or later) — #4506's
   chain-walk classification arms landed since the decode.
2. Find where the `.isPrototypeOf(x)` call site resolves its argument:
   the classifier added by #4506 (`fnctor-escape-gate.ts` /
   `classifyUse`) vs the call lowering's coercion of the argument to
   externref. The defect signature — a *proven-live* local/global
   compiled as `ref.null extern` — smells like a null-narrowing or
   default-value arm in type-coercion for an unresolved nominal type, not
   a dispatch miss. Read `src/codegen/type-coercion.ts` (`coerceType`
   ref/ref_null → externref arm) and the `__isPrototypeOf` registration.
3. Fix so the argument carries the real object reference in BOTH lanes.
4. Two-lane A/B: the probe above + S13.2.2_A1_T1/_T2 + a scoped
   `language/statements/function` + `built-ins/Object/prototype/isPrototypeOf`
   sweep, standalone AND js-host lanes, base copies at first edit.
5. Pins: tests/issue-4623.test.ts, both lanes (host lane via the
   omit-4th-arg driver convention — passing "gc" corrupts options).

## Root cause

**Not the argument, and not `type-coercion.ts`.** The plan's hypothesis (a
null-narrowing arm coercing a proven-live operand) is wrong; the `ref.null
extern` in #4506's decode is the **whole call's result**, not an operand.
Re-decoded on this branch (`.tmp/wat.mts`, JS-host lane, module
`var P={q:1}; var o=Object.create(P); var a=P.isPrototypeOf(o)`):

```wat
global.get 3        ;; P
extern.convert_any
global.get 0        ;; "isPrototypeOf"
call 2              ;; __extern_get(P, "isPrototypeOf")
drop                ;;   <- the member read is thrown away
ref.null extern     ;;   <- THIS is the call's value
call 3              ;; __unbox_number  → NaN
i32.trunc_sat_f64_s ;; → 0
global.set 5        ;; a = false
```

The argument does not appear at all because the dead `global.get o` / `drop`
pair the fallback emits for it is elided later. And the standalone binary
contained **no `call $__isPrototypeOf` whatsoever** — the walk was never
reached on either lane.

**No dispatcher claimed the shape**, and the two lanes then failed differently
— which is why the defect reads as one thing from each side:

| lane | arm that answered | answer |
| --- | --- | --- |
| JS host | the graceful `ref.null.extern` fallback in `stored-member-closure-call.ts` (`compileCallDispatchTail`) | `undefined` |
| standalone | `compileTailDispatch`'s `ref.test`-guarded generic closure dispatch (`call-tail-dispatch.ts`, the #1298 fix-#3 arm) — the callee's lib.d.ts type has a call signature and a closure of that shape is registered, so the arm claims the call, reads the member dynamically, finds nothing, takes its `else` branch | `false` |

Both traced with a `Array.prototype.push` stack hook over the emitted `Instr`
stream (`.tmp/trace.mts`, `.tmp/trace2.mts`).

The receivers that DO work never reach either arm: a syntactic
`Object.prototype` / `<Builtin>.prototype` receiver is folded or walked by
`native-is-prototype-of.ts` (#2916/#2994) and `builtin-prototype-brand.ts`
(#4556), and an `any`-typed receiver is resolved by `tryExternClassMethodOnAny`.
What was uncovered is the ordinary spelling on a **closed** receiver shape —
an object literal, a constructed instance — i.e. the ES5 `Object.create` idiom.

The enabling fact for the fix, measured on BOTH lanes: `Object.getPrototypeOf(
Object.create(P)) === P` is already **true**. The `[[Prototype]]` edge the
predicate asks about is modelled; only the routing was missing.

## Fix

1. **`src/codegen/expressions/is-prototype-of-call-arm.ts` (new)** —
   `tryEmitIsPrototypeOfCallArm` lowers `recv.isPrototypeOf(v)` (and the
   bracket twin `recv["isPrototypeOf"](v)`) to `__isPrototypeOf(recv, v)`,
   which resolves to the WasmGC-native `$Object.$proto` walk under
   standalone/wasi (no host import) and to `env::__isPrototypeOf` — the real
   intrinsic — under the JS host. Result is a `{kind:"i32", boolean:true}`, so
   `r === true` is a boolean comparison.
   Declines (absent-not-wrong) on: an optional chain; >1 argument or a spread;
   a program that INSTALLS its own `isPrototypeOf` (`sourceHasMethodOverride`
   — assignment ∪ `defineProperty`, #1397/#4482); a program that DECLARES a
   member of that name (object-literal property, class member, type member —
   the scan `sourceHasMethodOverride` does not do).
2. **`src/codegen/expressions/calls.ts`** — one invocation at the last decision
   point of `compileCallExpression`, immediately before `compileTailDispatch`.
   That placement is load-bearing and was arrived at by measurement: an earlier
   draft sat inside `compileCallDispatchTail` (next to the fallback it
   replaces) and fixed the **host lane only** — standalone never reaches the
   tail, because the generic guarded closure dispatch claims the call first.
3. **`src/codegen/builtin-prototype-brand.ts`** — §20.1.3.4's step ORDER for
   the borrowed spelling `Object.prototype.isPrototypeOf.call(<this>, V)`.
   #4556 deliberately left `isPrototypeOf` OUT of `NULLISH_THIS_THROWS` with
   the note "whether it throws depends on the ARGUMENT, not the receiver, so a
   receiver-only gate cannot decide it". It is now in the table plus the
   missing half: `ARGUMENT_MUST_BE_OBJECT` requires the argument to be
   **provably** an object (function/class/object/array literal or `new`) before
   the throw is emitted, because step 1 ("if V is not an Object, return false")
   runs before step 2's `ToObject(this value)`. An identifier argument is not a
   proof and declines.

Not touched: `call-tail-dispatch.ts` (dev-4625's lane) and `object-runtime.ts`
(dev-4624's) — see ## Lane overlap.

## Test Results

All numbers below are from runs **executed for this issue** on branch
`issue-4623` (base = campaign `9d9291db7`), with the base-state arm reverted by
file copy (`.tmp/base-calls.ts`, `.tmp/base-builtin-prototype-brand.ts`) and
re-run by the same driver. Standalone = `runTest262File(…, "standalone")`;
JS host = the same call with the 4th argument OMITTED.

### The issue's probe — the acceptance bar, met in both lanes

| probe | standalone before → after | host before → after |
| --- | --- | --- |
| `var P={q:1}; var o=Object.create(P); P.isPrototypeOf(o)` | `false` → **`true`** | `undefined` → **`true`** |
| `P.isPrototypeOf(Object.create(o))` (2 levels) | `null` → **`true`** | `undefined` → **`true`** |
| `P.isPrototypeOf(5)` / `P.isPrototypeOf(null)` | `null` → **`false`** | `undefined` → **`false`** |

### Scoped sweeps (before/after, my runs, both lanes)

| sweep | lane | before | after | flips | regressions |
| --- | --- | --- | --- | --- | --- |
| `built-ins/Object/prototype/isPrototypeOf` (10) | standalone | 6 pass / 4 fail | **8 pass / 2 fail** | +2 | **0** |
| `built-ins/Object/prototype/isPrototypeOf` (10) | host | 8 pass / 2 fail | 8 pass / 2 fail | 0 | **0** |
| `language/statements/function` (256) | standalone | 227 pass / 28 fail / 1 CE | 227 / 28 / 1 | 0 | **0** |
| `language/statements/function` (256) | host | 211 pass / 44 fail / 1 CE | 211 / 44 / 1 | 0 | **0** |
| every test262 file naming `isPrototypeOf` (63) | standalone | 52 pass / 9 fail / 2 skip | **54 pass / 7 fail** | +2 | **0** |
| every test262 file naming `isPrototypeOf` (63) | host | 39 pass / 22 fail / 2 skip | **42 pass / 19 fail** | +3 | **0** |

The 63-file cohort is `grep -rl isPrototypeOf test262/test` — the COMPLETE
at-risk population for both changes, not a sample.

Flip list:

- standalone: `built-ins/Object/prototype/isPrototypeOf/null-this-and-object-arg-throws.js`,
  `…/undefined-this-and-object-arg-throws.js` (the §20.1.3.4 step-order fix).
- host: `built-ins/Array/S15.4.1_A1.1_T3.js`, `built-ins/Array/S15.4.2.1_A1.1_T3.js`,
  `built-ins/Array/length/S15.4.2.2_A1.1_T3.js` (the routing fix; these are the
  host twins of the rows #4556 already fixed on standalone).

### Pins

`tests/issue-4623.test.ts` — **14 tests, all green** (`npx vitest run
tests/issue-4623.test.ts`): 7 two-lane behaviour pins, an override control (a
program's own `isPrototypeOf` still runs, the intrinsic does not shadow it),
3 borrowed step-order pins (both throw directions AND the primitive-argument
row that must NOT throw), and 2 `it.fails` residual pins (below) plus the
object-valued twin that shows the residual is specifically about functions.

### Neighbouring suites, and one pre-existing pin flip (NOT mine)

`tests/issue-4556-builtin-proto-member-override.test.ts`,
`tests/issue-4484.test.ts`, `tests/issue-4096-stored-member-closure-call.test.ts`
— all green. `tests/issue-4482.test.ts` has ONE failure:
`#4482 residuals … > defineProperty on a CLOSED object-literal type installs
nothing` now reports "Expect test to fail", i.e. the residual it pins was
healed. **A/B'd with the base file copies: it fails identically on the campaign
base**, so it is pre-existing on `9d9291db7` (a `defineProperty`-on-closed-struct
residual closed by other landed work, plausibly #4524) and unrelated to this
diff. Flagging it so whoever owns #4482 can flip the pin.

No `tests/equivalence/` file names `isPrototypeOf`
(`grep -rl isPrototypeOf tests/equivalence/` is empty), so none is in this
diff's plausible blast radius; per the brief, no equivalence loop was run.

### Gates

`typecheck` clean · `biome lint` clean on all 4 files · `check:coercion-sites`,
`check:oracle-ratchet`, `check:loc-budget`, `check:stack-balance`,
`check:dead-exports`, `check:codegen-fallbacks`, `check:pushraw` all OK ·
`check:func-budget` needs the `func-budget-allow` grant in this file's
frontmatter (+13 lines in `compileCallExpression`, rationale there).

## Residuals

1. **`S13.2.2_A1_T1/_T2` do NOT flip — the acceptance bar's second half is not
   met, and it is not reachable from this issue.** They need a SECOND,
   independent fact. Measured on both lanes:
   `function P(){}; function F(){}; F.prototype = P; var m = new F()` leaves
   `Object.getPrototypeOf(m) === P` **false**, while the object-literal twin
   (`F.prototype = {y:2}`) is **true** on standalone. A FUNCTION in the
   `.prototype` slot cannot be held by the `(ref null $Object)` `$proto` field
   — the fnctor-representation residual #4480 S2 already records verbatim in
   `fnctor-instance-prototype.ts` ("that family needs a function-valued
   prototype the `(ref null $Object)` field cannot hold"). With no chain edge a
   CORRECT walk still answers `false`, which is what both rows now report.
   Pinned `it.fails` in `tests/issue-4623.test.ts`. Owner: the
   fnctor-representation XL (#4506 follow-up).
   Note for the record: those rows also assert `__monster.type === "monster"`
   (CHECK#2), which fails for the same missing edge — so even a fixed CHECK#1
   would not have flipped them.
2. **`built-ins/Object/prototype/isPrototypeOf/this-value-is-in-prototype-chain-of-arg.js`**
   still fails on both lanes. `proto.isPrototypeOf(luke)` answers `null`
   (standalone) / `TypeError: isPrototypeOf is not a function` (host) — the
   call is claimed by an EARLIER receiver-typed dispatcher than the new arm, so
   the arm never sees it. Fixing it means intercepting a working dispatcher
   rather than a fallback; out of scope here. Owner: unassigned.
3. **`…/arg-is-proxy.js`** — Proxy `[[GetPrototypeOf]]`; unrelated family.
4. A `null`/`undefined` **VALUE** receiver in the ordinary spelling
   (`var u; u.isPrototypeOf(x)`) answers `false` rather than throwing. That is
   the pre-existing answer (the fallback returned `undefined`), and the
   syntactic-receiver case already throws via #4484; not widened here.

## Lane overlap (recorded per the dispatch instruction)

The standalone half of the defect is produced by an arm in
**`call-tail-dispatch.ts`**, which is dev-4625's file (element-access callee).
This fix does **not** edit it: the new arm sits one level up, in
`compileCallExpression`, before `compileTailDispatch` is called. The only
interaction is ordering — `o["isPrototypeOf"](v)` is now claimed before the
element-access-callee arm sees it, and only for that one member name, only when
the program neither installs nor declares its own. If #4625 changes the
element-access callee path, nothing in this diff needs to move.
