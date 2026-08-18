---
id: 4481
title: "ES5 standalone: prototype-method VALUE identity — `x.toString === X.prototype.toString` family across Object/Array/Number literals (~20 rows)"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-08-15
updated: 2026-08-18
loc-budget-allow:
  # +6 lines (one import + a 4-line dispatch arm) in the property-access
  # dispatcher. The subsystem itself is a NEW module
  # (`src/codegen/instance-proto-method-identity.ts`, ~290 lines incl. the
  # record) exactly as #3102 asks; the six lines are the minimum needed to
  # reach it from the dispatch chain, and they sit immediately above the
  # host-lane #3368 arm they are the standalone analogue of, which is the only
  # position where the ordering argument is readable.
  - src/codegen/property-access-dispatch.ts
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: method-identity
goal: standalone-gap
related: [4442, 3006, 4426]
origin: "2026-08-15 ES5-standalone session — root-cause fan-out. language/expressions/array (8 rows), language/expressions/object (7), plus Array/Number/Boolean scattered rows all assert `instance.method === Builtin.prototype.method`."
---

# #4481 — prototype-method value identity

## Problem

The `S15.x` corpora assert method IDENTITY, not behavior:
`var a = []; a.toString === Array.prototype.toString`,
`({}).toString === Object.prototype.toString`, `array.join === Array.prototype.join`.
Standalone answers false (or null on one side): reading a builtin method off
an INSTANCE and off the PROTOTYPE produce different carriers (or a fold on
one side and a runtime value on the other). ~20 measured rows: all 8
`language/expressions/array` failures, 6 of 7 `language/expressions/object`,
plus `x.toString() must return "[object Array]"` rows where the transferred
identity matters.

## Implementation Plan

1. Re-verify live (brief: `plan/method/es5-standalone-agent-brief.md`).
   Probe matrix first: for each of {Object,Array,Number,Boolean,String} ×
   {toString,valueOf,join,hasOwnProperty}: `inst.m === Proto.m`,
   `Proto.m === Proto.m` (self-stability), `typeof Proto.m`. Record which
   cells are false/null — the fix is per-cell routing, not one hammer.
2. #4442's `function-intrinsic-carrier.ts` is the PROVEN pattern: ONE
   module-level emitter per intrinsic value, dispatched on a module-level
   fact, so both sides of `===` route through the same singleton. #3006's
   `BUILTIN_CTOR_ARITY` carriers and `tryCompileStandaloneBuiltinProtoMemberMeta`
   (property-access.ts) are the existing read sites that currently answer
   with per-site values — unify them onto per-(builtin,method) singletons.
3. Mind the call side: the singleton must still be CALLABLE through the
   existing reflective dispatch (`array-object-proto.ts` arms) — identity
   must not trade a working call for a passing `===` (the #4442 lesson:
   provider-linked vs self-contained arms, module kind is the switch).
4. Controls: the reflective String/Array method call suites stay green
   (issue-4427/4439/4465 pins); byte-identity on modules that never read a
   builtin method as a value.

## Acceptance criteria

- ≥12 of the ~20 identity rows flip; `Proto.m === Proto.m` stable for every
  probed cell; zero regressions in reflective-dispatch pins.

## Root cause

**The premise in "Problem" above is wrong, and the correction is the fix.** The
issue assumed both sides mint different carriers. Step 1's probe matrix — the
real `runTest262File` standalone lane, one module per cell, base `0e47b7ae0` —
says the PROTOTYPE side was already correct:

| cell (base)                                                                | `inst.m === Proto.m` | `Proto.m === Proto.m` | `typeof Proto.m` | `typeof inst.m` |
| -------------------------------------------------------------------------- | -------------------- | --------------------- | ---------------- | --------------- |
| {Object,Array,Number,Boolean,String} × {`toString`,`valueOf`,`hasOwnProperty`} | **false**            | **true**              | function         | `"function"`    |
| `Array.join`                                                               | **false**            | true                  | function         | `"function"`    |
| `Number.join` / `Boolean.join`                                             | false                | true                  | undefined        | `"object"`      |
| `Object.join` / `String.join`                                              | true (both absent)   | true                  | undefined        | undefined       |

`Proto.m === Proto.m` holds in **every** cell: #2175 V2-S2's
`pushBuiltinFnSingletonValueInstrs` already gives one value per (brand, member).
So "the fix is per-cell routing" was also wrong — there is one defect, on the
INSTANCE side, and it is not "a different function object":

```
[].toString      → undefined        ({}).toString  → undefined
"s".charAt       → undefined        (5).toString   → null
```

**`typeof` reported `"function"` over `undefined`.** That column is folded from
the receiver's TS type, not the emitted value, so the cheapest probe reports the
defect as fixed. It is #4234's `undefined === undefined` trap one level up, and
it is why the `Object.join`/`String.join` rows read `true` on base — both sides
absent.

#4248's `__extern_get` arm (why `new Number(5).toString === Number.prototype.
toString` IS true on base) cannot reach these rows: it keys on a `$Object`
carrying `[[PrimitiveValue]]`, or on a `$NativeProto`. An array literal is a
vec, an object literal is a `$Object` with no such slot, `(5)` is an i31/box.

## Fix

New subsystem `src/codegen/instance-proto-method-identity.ts`, spliced into
`tryPrototypeMethodAndArityReads` (property-access-dispatch.ts, +6 lines)
directly above the host-lane #3368 arm it is the standalone analogue of. It
routes the instance-side read through the SAME
`resolveStandaloneProtoMemberValueClosure` + `pushBuiltinFnSingletonValueInstrs`
the prototype side already uses, so identity holds by construction (#4442's
rule) rather than by two emitters agreeing.

Receiver brand: `ctx.oracle.typeFactOf` for array/tuple/number/string/boolean.
**The object case needed a syntactic proof instead**, and this cost a full
measure-and-retry cycle worth recording: an anonymous object-literal type takes
its symbol name from the variable it initializes, so `var a = {}` reports
`{ kind: "class", name: "a" }` — indistinguishable from a class instance, which
this arm must keep declining. With only the TypeFact path, all four `Object.*`
cells still declined while the other four brands flipped. The object receiver is
therefore proved from the initializer AST (`ctx.oracle.variableInitializerOf`,
never the raw checker), which is *stronger* for the shadowing question because
the literal's own keys are visible.

Two decline layers, both measured:

1. **static** — the receiver's own shape/literal must not declare the member;
2. **module-wide** — no assignment, `delete`, object-literal or class member,
   `defineProperty` key, or prototype relink (`Object.create` /
   `setPrototypeOf` ⇒ every brand off at once) names it anywhere.

Layer 2 needs ONE carve-out, and without it the fix reaches no test262 file at
all: `sta.js` — prepended to every test in the corpus — contains
`Test262Error.prototype.toString = function () {…}`. A write onto a **user**
constructor's `.prototype` cannot be on the chain of an array literal, an object
literal or a primitive, so it is exempt; `<BuiltinCtor>.prototype.m = …` is not.
Measured: `toString` false in all 20 cells with the blanket gate, true in 4 of 5
brands with the carve-out.

The arm never fires in CALLEE position, so `arr.toString()` / `({}).toString()`
keep their existing lowerings.

## Test Results

All numbers below are from runs executed on this branch (base copies captured
at first edit; A/B by file copy, never `git stash`).

**Probe matrix, 20 cells** (`.tmp/matrix2.mts`, real runTest262File standalone):
`inst.m === Proto.m` **2 → 18 of 20 true**. The two remaining are
`Number.join`/`Boolean.join`, where the member is genuinely absent on both sides
and the instance read answers `"object"` instead of `undefined` — a dynamic-read
defect with nothing to do with identity (residual R1). `Proto.m === Proto.m`
stayed true in all 20.

**Scoped standalone sweeps, before and after, zero regressions:**

| directory                                     | base    | after   | flips                      |
| --------------------------------------------- | ------- | ------- | -------------------------- |
| `language/expressions/array` (52, recursive)   | 35/52   | 43/52   | +8, −0                     |
| `language/expressions/object` (306, top-level) | 235/306 | 239/306 | +4, −0                     |
| `built-ins/Object/prototype` (248, recursive)  | 135/248 | 135/248 | **0 files changed status** |

The third row is the adjacent-corpus control, not a win: 248 files where the
arm is expected to change nothing, and the per-file status maps are identical.

**All four arms of the first two rows were re-run, sequentially, under ONE eval
tier with the FINAL source.** The first pass had been measured before the local
quickjs adapter existed, and one semantic change landed afterwards (a
`__proto__` write now forces the relink decline — the docblock had claimed it
did and it did not). Those numbers therefore no longer described the committed
code, which is the exact defect this campaign's brief names, so they were
discarded rather than carried forward. The tier shift moved the object BASE from
234 to 235; the delta is +4 either way, and every flip is identical.

Flip list — every one an identity row, and every previously-failing
`S11.1.4_A*` row in the array directory:
`array/S11.1.4_A1.1 A1.2 A1.3 A1.4 A1.5 A1.6 A1.7 A2`,
`object/S11.1.5_A1.1 A1.2 A1.3 A1.4`. **12 rows, meeting the ≥12 bar.**

**Shadowing controls — 12 shapes, byte-for-byte identical to base** (own literal
key, later assignment, a same-named write on a DIFFERENT receiver, array method
shadow, `delete`, `defineProperty`, `setPrototypeOf`, `Object.create`, builtin-
prototype write, reassigned binding, ctor-instance `this.toString`, user-
prototype method). Each declines AND still observes the own value (`own`, `7`,
`1,2`).

**Callability — improved, never traded.** The instance-side value now behaves
exactly as the prototype-side value does:

| probe                                    | base                              | after                          |
| ---------------------------------------- | --------------------------------- | ------------------------------ |
| `({}).toString.call([])`                 | **uncatchable** `illegal cast`    | `[object Array]` (= proto side)|
| `"abc".charAt.call("xyz",1)`             | **uncatchable** `illegal cast`    | `y` (= proto side)             |
| `[1,2].join.call(a,"-")`                 | **uncatchable** `illegal cast`    | catchable TypeError            |
| `a.join("-")` / `a.toString()` / `n.toString(16)` / `s.charAt(1)` | 1-2 / 1,2 / ff / b | unchanged        |

**Pins** (all after the local quickjs eval provider was built —
`npx tsx scripts/build-quickjs-eval-provider.mjs`; run it under `tsx` or the
build no-ops with "no usable compiler"):

- `tests/issue-4481.test.ts` — **41 passed** (new).
- `issue-4442` / `issue-4464` / `issue-4439` / `issue-4437` — **70 passed**.
- `issue-2175-v2s2-singleton-identity`, `issue-2193-builtin-proto-value-read`,
  `issue-2374-…-proto-value-read`, `es5-standalone-wrapper-prototype`,
  `array-prototype-methods` — **49 passed**.
- `issue-1472`, `issue-2660-s2`, `issue-2580-m3-protochain`, `issue-2376`,
  `issue-2377`, `issue-2378`, `issue-2861-arraybuffer-dataview` — **73 passed**.
- `issue-2580-m3-protoextend` — 5 failing, **identical on base** (A/B'd; a
  host-lane inherited-index gap, untouched by this standalone-only arm).
- `tests/equivalence/` per-file loop (the directory OOMs in one invocation) over
  the 18 files this diff plausibly touches — **146 passed, 0 failed**:
  `arguments-object`, `array-prototype-methods`, `array-zero-arg-methods`,
  `empty-array-join`, `empty-object-widening`,
  `issue-4123-param-receiver-proto-method`, `issue-799-prototype-chain`,
  `object-create`, `object-keys`, `object-mutability`, `object-to-primitive`,
  `tostring-valueof`, `string-methods`, `number-statics`,
  `object-define-property`, `numeric-key-object`,
  `object-literal-getters-setters`, `json-stringify`.

**Gates**: typecheck, biome (changed files), oracle-ratchet (+0), func-budget,
coercion-sites, dead-exports, pushraw, any-box-sites, ir-fallbacks all OK.
loc-budget needs the `+6` allowance granted in this file's frontmatter.

## Residuals

- **R1 — an ABSENT member on a primitive receiver reads as an object, not
  `undefined`.** `(5).join` / `(true).join` answer `typeof "object"` while
  `Number.prototype.join` is correctly `undefined`; the two `join` cells are the
  only ones still false. This arm declines them (tier 3 of
  `resolveStandaloneProtoMemberValueClosure` — unknown member), so the defect is
  the dynamic primitive-receiver read's. Owner: standalone-gap, unclaimed.
  Note the lane dependence: reproduces in the **test262** lane, not in the plain
  vitest module lane — so pin it with a test262 probe, not a unit test.
- **R2 — `typeof <expr>.<method>` is folded from the TS type, not the value.**
  Not fixed here (the fold now happens to agree). It is the reason this issue's
  original diagnosis was wrong, and it will mask the next defect of this family
  the same way. Any probe of an absent/instance-side member must assert the
  VALUE, never `typeof`. Worth its own issue.
- **R3 — an instance-borrowed `hasOwnProperty` is still not callable.**
  `o.hasOwnProperty.call(x,k)` now reaches the same catchable refusal the
  prototype spelling's VALUE reaches (`… not yet implemented in --target
  standalone`) instead of `Cannot read properties of undefined`. Both are
  TypeErrors; the native value-call body is simply unwired. Pinned `it.fails`.
- **R4 — equal values do NOT make the two `.call` SITES equivalent.**
  `Array.prototype.join.call(a,"-")` succeeds while `a.join.call(a,"-")` throws,
  measured `21` on base AND after — unchanged. The prototype spelling is claimed
  *syntactically* by calls.ts's reflective `.call` route, which never
  materializes the value (native-proto-value-read.ts records that it bypasses
  the resolver on purpose). Recorded because it is the obvious over-claim to
  make from an identity fix; pinned so a later change cannot silently alter it.
- **R5 — the shadow scan should adopt #4482's `member-override-scan.ts`.**
  #4482 landed on the session branch (`b7d946cbe`) after this work was measured,
  with the same problem solved at two precisions: `sourceOverridesMethodOnReceiver`
  (SAME-BINDING) for declining a static arm, and `sourceHasMethodOverride`
  (whole-file, assignment ∪ defineProperty) for admitting a dynamic exit. This
  issue's `moduleTouchedPropNames` is the whole-file form used for the DECLINE —
  i.e. the over-declining one, which is safe but loses folds it need not lose
  (its own docblock argues the trade: over-declining costs a `false` that was
  already `false`, under-declining produces a wrong `true`). Switching the
  decline to the same-binding precision is a strict improvement and a natural
  follow-up; deliberately NOT done here, because it would invalidate every sweep
  above and those are the evidence this issue rests on. Note the two gates are
  not interchangeable: the whole-file form is also what carries the
  prototype-RELINK verdict (`Object.create`/`setPrototypeOf`/`__proto__`), which
  is genuinely module-wide and must survive any narrowing.
- **Not attempted:** widening the fold to `class`/`function`/`any` receivers, or
  to accessor members (a plain read must INVOKE those). Both decline today.
