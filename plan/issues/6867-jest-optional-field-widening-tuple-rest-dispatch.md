---
id: 6867
title: "jest: optional-field struct widening + tuple rest through any-typed calls — 9 of 20 failing upstream unit tests"
status: done
completed: 2026-10-05
sprint: current
created: 2026-10-06
updated: 2026-10-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: npm-library-support
requested_by: ttraenkler/wave11-jest
related: [3995, 4394, 4529, 5329, 6735]
files:
  - src/codegen/object-model/struct-optional-widen.ts
  - src/codegen/type-coercion.ts
  - src/codegen/declarations/struct-type-registration.ts
  - src/codegen/index.ts
  - src/wasm/model/module-records.ts
  - src/codegen/closures/tuple-rest-carrier.ts
  - src/codegen/expressions/calls.ts
  - tests/issue-6867-jest-optional-field-widening.test.ts
# 2026-10-06 — the widening is a new arm of the existing struct-conversion
# ladder (`emitSafeStructConversion`, type-coercion.ts) and reuses its private
# narrowing body; the arm itself lives in struct-optional-widen.ts, leaving
# +13 lines of wiring (optional-aware `getStructNarrowInfo`, the arm call,
# the undefined default). calls.ts +6 / `buildInlineDynamicDispatch` +5 is the
# tuple-rest arm's detection + call; the builder lives in
# closures/tuple-rest-carrier.ts next to the #5329 recognizer. index.ts +1 is
# the import of the optional-field flag used at struct registration.
loc-budget-allow:
  - src/codegen/type-coercion.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/expressions/calls.ts::buildInlineDynamicDispatch
---

# #6867 — jest upstream unit suite: two compiler root causes behind 9 failures

## Problem

Jest's pinned upstream unit slice (`tests/dogfood/jest-upstream-suite.mjs`)
measured **336/356** on `42d289a96f` (2026-10-06; 2 more are
`harness-incompatible` — native also fails their snapshot). The 20 failures
group into these clusters:

| cluster | file | tests | root cause |
| --- | --- | --- | --- |
| A | `expectationResultFactory.test.ts` | 6 | a local omitting OPTIONAL members of the parameter type arrives NULL (guarded downcast between unrelated structs) |
| B | `queueRunner.test.ts` | 6 | a tuple rest formal (`...args: [Error]`) called through an any-typed callee gets a typed null / an illegal cast |
| C | `deepCyclicCopy.test.ts` | 5 | host-reflection residuals (getter executed by `getOwnPropertyDescriptors`, `new (function(){})()` prototype identity, `jest.spyOn(Array, 'isArray')`) |
| D | `diff-sequences/index.test.ts` | 3 | `boolean[]` through an `Array<unknown> \| string` param reads `0`/`1`; `diff('0', …)` under `@ts-expect-error` coerces a string into a `number` slot |

### Cluster A — reduction

```ts
type O = { a: string; b?: any };
function f(o: O) { return o.a; }
const x = { a: 's' };
f(x); // RuntimeError: dereferencing a null pointer
```

`x` lowers to `struct {a}`, the parameter to `struct {a, b}`. The struct
conversion ladder only knew **narrowing** (destination fields ⊆ source fields);
a destination that ADDS fields fell through to the guarded downcast, which can
never match two unrelated structs → `ref.null` → trap on the first read. #4394
already fixed the *literal-argument* spelling (`f({ a: 's' })`) by building the
literal as the expected struct; every other source (a local, a field, a return
value) still failed. jest's `expectationResultFactory` tests all build an
`options` local first.

### Cluster B — reduction

```ts
const next = function (...args: [Error]) { const err = args[0]; /* … */ };
const callAny = (f: any) => f();
callAny(next);               // dereferencing a null pointer
((f: any) => f(new Error()))(next); // illegal cast
```

#5329 taught the direct-call and `__call_fn_N` host-dispatch builders the tuple
rest carrier. The **inline dynamic-call ladder** (`buildInlineDynamicDispatch`,
the any-typed callee path, also used by the outlined `__dyn_call_N` helpers)
still marshalled the tuple formal as one ordinary `ref` parameter: a missing
argument became a typed null, a present one was `ref.cast` to the tuple struct.
jest's `queueRunner` calls `next()` / `next(error)` exactly this way.

## Implementation Plan

1. **Record optionality on struct fields.** Add `FieldDef.optional?: true`
   (`src/wasm/model/module-records.ts`), set from
   `prop.flags & ts.SymbolFlags.Optional` at the three registration sites:
   `collectInterface`, `collectObjectType`
   (`declarations/struct-type-registration.ts`) and `ensureStructForType`
   (`index.ts`). The flag is not part of `fieldsHashKey`, so struct dedup and
   type identity are unchanged.
2. **Widening arm (Case 4) in `emitSafeStructConversion`** (type-coercion.ts),
   after narrowing: `getStructNarrowInfo(…, allowOptional = true)` accepts a
   missing destination field only when it is `optional` (a missing REQUIRED
   field still declines → guarded cast as before), and requires at least one
   shared field. The emitted code lives in `struct-optional-widen.ts`:
   - null source → null (non-null target keeps its trailing assert);
   - `ref.test` the target struct → keep the value (identity, subtype and every
     field preserved — `base as Derived` on a real `Derived` is untouched);
   - otherwise project via the existing `emitStructNarrowBody`, whose missing
     optional externref fields now read the canonical `undefined` (f64 keeps
     the #866 sentinel; other kinds keep their null/zero default).
3. **Tuple rest arm in `buildInlineDynamicDispatch`** (calls.ts):
   `dynamicCandidateTupleRest` (tuple-rest-carrier.ts) recognizes a candidate
   whose trailing lifted formal is a registered `__tuple_N` carrier (reusing
   `classifyTupleRestCarrier`); the arm then marshals only the fixed formals
   positionally and `appendDynamicTupleRestArgument` builds the tuple from the
   saved externref args (unboxed per field slot; missing → `undefined` /
   sentinel / typed null; a non-matching ref → null instead of trapping). The
   arm guards on the candidate's concrete closure struct, like the #4616 vec
   rest arm, so a same-signature non-rest closure keeps its positional arm.
4. Regression test `tests/issue-6867-jest-optional-field-widening.test.ts`
   (two-file project fixtures; `.ts` because both triggers are type
   annotations) failing on the parent, passing with the fix, with
   literal-argument and same-struct identity controls that pass on both.

Order-preservation: all new arms are strictly additive — each fires only where
the old code produced a null/illegal cast.

## Residuals (measured, not in this change)

- `expectationResultFactory` 3 tests: `prettyFormat(x, {maxDepth: 3})`
  receives `options` NULL. `PrettyFormatOptions extends Omit<SnapshotFormat, …>`
  and `@jest/schemas` is not resolvable in the harness checkout, so the
  interface lowers to a closed 2-field struct (`compareKeys`, `plugins`) while
  the literal carries `maxDepth` → the #4394 diversion declines and the cast
  fails. Also one `toMatchSnapshot` of a compiled struct prints
  `[object Object]`.
- `queueRunner` "calls `fail` with arguments": `next.fail('miserably',
  'failed')` against a ONE-element tuple rest drops the surplus argument before
  `options.fail.apply(null, args)`; a tuple carrier cannot hold surplus args.
- A tuple-rest closure called through a TYPED callee signature
  (`(f: (e?: any) => void) => f()`) still traps with an illegal cast — the
  typed closure-call path, not the dynamic ladder.
- Clusters C and D above.

## Resolution

Implemented per the plan (2026-10-06). Measured on one HEAD (`42d289a96f`),
base vs fix, JS-host unit-test lane (`node --import tsx
tests/dogfood/<pkg>-upstream-suite.mjs`, all exit 0):

| suite | base | fix |
| --- | --- | --- |
| jest | 336/356 | **344/356** |
| prettier | 75/151 | 75/151 (per-file identical) |
| hono | 294/324 | 294/324 |
| redux | 76/82 | 76/82 |
| lodash | 60/62 | 60/62 |
| axios | 212/231 | 212/231 |
| marked | 18/30 | 18/30 |
| uuid | 75/75 | 75/75 |
| clsx | 32/32 | 32/32 |
| cookie | 63740/63740 | 63740/63740 |
| moment | 10/10 | 10/10 |

jest per file: `expectationResultFactory` 1/7 → 4/7, `queueRunner` 0/6 → 5/6.
`tests/issue-6867-jest-optional-field-widening.test.ts`: 2 failed / 1 passed on
the parent → 3 passed (the control passes on both).

Standalone lane: scoped `scripts/run-test262-paths.mts --standalone` over 170
rows (`language/rest-parameters`, half of `language/expressions/call`, 120
`verifyProperty` users — the JSDoc-optional harness options #4394 named):
137 pass / 33 fail on both base and fix, per-row identical.

Follow-ups filed: #6869 (deepCyclicCopy host reflection, 5 tests), #6870
(boolean vec brand through a union array param, 2 diff-sequences tests),
#6871 (interface extending an unresolved base → closed struct; 2
expectationResultFactory tests).
