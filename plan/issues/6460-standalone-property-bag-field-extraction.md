---
id: 6460
title: "standalone: a spread whose source is a `const` array binding has no static arity, so `new Temporal.Duration(...args)` answers `null` and `new F(...args)` puts the whole ARRAY in the first parameter"
status: done
completed: 2026-09-13
assignee: ttraenkler/dev-5383-s12
sprint: current
priority: high
horizon: m
goal: standalone
parent: 5383
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-13
func-budget-allow:
  # 2026-09-13 (#6460) — `emitDynamicNewFallback` grows +7 lines: the comment
  #   that pins WHY the spread predicate widened, plus the widened expression.
  #   The mechanism itself lives in the new module
  #   `src/codegen/static-spread-arity.ts`, deliberately not in this function.
  #   The +7 is the part that cannot move: the decision "this call site has a
  #   static arity" has to be taken HERE, where the arity is about to select a
  #   construct driver, and the comment is load-bearing — a reader who tidies
  #   it away reintroduces the `new` → `null` answer that no byte A/B shows,
  #   because both spellings compile.
  - src/codegen/expressions/new-super.ts::emitDynamicNewFallback
loc-budget-allow:
  # 2026-09-13 (#6460) — restated here so the grant is not stranded in an
  #   issue file this change-set might not otherwise touch:
  #   expressions/new-super.ts        two call sites + their rationale
  #   fnctor-constructor-identity.ts  one call site + its rationale
  - src/codegen/expressions/new-super.ts
  - src/codegen/fnctor-constructor-identity.ts
oracle-ratchet-allow:
  # 2026-09-13 (#6460) — `src/codegen/static-spread-arity.ts` resolves an
  #   IDENTIFIER to its declaration in order to read the array literal it is
  #   bound to. That is name/binding resolution, which the oracle deliberately
  #   does not model ("Symbol/binding resolution … is intentionally OUT" —
  #   #1930 D3, restated at the top of scripts/check-oracle-ratchet.mjs), so
  #   `ctx.oracle` has no `symbolAt`/`declarationOf` to route through. The
  #   three `ctx.checker` occurrences are all `getSymbolAtLocation`; none of
  #   them asks a TYPE question.
  - src/codegen/static-spread-arity.ts
---

## Problem

S11 (#6457) closed the `K.prototype`-on-a-dynamic-class hole and left the
standalone linked-Temporal three-family sample at 170/360. The S12 brief
attributed the largest residual to property-bag FIELD EXTRACTION inside the
provider (`PrepareCalendarFields` / `ToIntegerWithTruncation`). **Measured, that
attribution is wrong**, and the census below says so with reductions. Field
extraction works; three other things do not.

## Attribution — measured 2026-09-13, host-free, `--target standalone`

Reductions run through the shipped path (`buildTemporalProvider` +
`compileWithTemporalGlobal` + `instantiateLinkedProject(result, {})`, empty
import object) with a FRESH `JS2WASM_TEMPORAL_CACHE`; harness
`.tmp/s12/probe.mjs`, probe sets `.tmp/s12/p-census{1..6}.mjs`. Module-local
reductions (no link at all) run through `compile()` directly,
`.tmp/s12/local.mjs` + `.tmp/s12/p-local{,2}.mjs`.

### The brief's hypothesis does NOT reproduce

`PrepareCalendarFields` (`tn` in the linked bundle, `.tmp/s12/polyfill-pretty.js`
L1710) is

```js
const i = Xt(e).extraFields(n), a = n.concat(r, i), s = Object.create(null);
a.sort();
for (let e = 0; e < a.length; e++) { const n = a[e], r = t[n]; if (r !== undefined) s[n] = (0, et[n])(r); … }
```

Every constituent answers correctly module-locally:

| module-local probe | answer | verdict |
| --- | --- | --- |
| `Object.create(null)` computed write then dot read | `1976` | ok |
| `bag[k]` with `k` from a `concat`ed array | `year=1976;day=18;` | ok |
| `bag[k]` with `k` from a `sort`ed array | `day=18;year=1976;` | ok |
| `["year","month"].concat(["day"],[]).sort()` | `3:day,month,year` | ok |
| the whole `tn` shape, untyped params | `y=1976 m=11 mc=D d=18` | ok |

So computed-key reads on an `any` receiver, `Object.create(null)` property
writes, and the sorted-concatenated key array are all fine. **`year is
required` is not a field-extraction defect.** Where it actually comes from is
NOT established here — the honest statement is that the construct the brief
named answers correctly in isolation, so the remaining candidate is the
cross-module one in the next table. Whoever takes it should reduce it
separately rather than inherit this sentence as an attribution.

### What IS broken, in order of attributed rows

| # | root cause | reduction | rows in the 360-row sample |
| --- | --- | --- | --- |
| 1 | **Every `X.from(…)` hands back an object whose reads answer `null`.** `PlainDate.from("1976-11-18").day` → `null`, `.toString()` → `null`; ditto `PlainDateTime.from`, `PlainTime.from`, `Instant.from`, `ZonedDateTime.from`. The control `new Temporal.PlainDate(1976,11,18).day` → `18`. The polyfill builds those results with `Object.create(intrinsic.prototype)` + WeakMap slots (`pn`, bundle L1946), NOT with `new`. | `.tmp/s12/p-census3.mjs` | ~40 (PlainDate `canonicalizeCalendarEra` 21 + `year is required` 7, ZDT `timeZone` 7 + `reading 'equals'` 6) |
| 2 | **A spread whose source is a `const` array binding has no static arity.** `const args=[1,1,1]; new Temporal.Duration(...args)` → **`null`**. | `.tmp/s12/p-census3.mjs`, `.tmp/s12/p-local2.mjs` | 9 (Duration `Cannot access property on null or undefined at 164:22`) |
| 3 | `typeof <provider-owned instance>` answers `"function"`, so `instance.toString()` resolves to `Function.prototype.toString` and returns `function () { [native code] }`. Known S11 residual, unchanged. | `.tmp/s12/p-census4.mjs` | folded into #1's rows |

Cause #1 is the largest and is **out of reach in one slice**: it is a
cross-module identity question (the single-module reduction —
`Object.create(C.prototype)` where `C` has a getter — answers `18` correctly),
i.e. exactly the boundary machinery S11 spent its whole slice on one facet of.
It is written down in full below rather than half-started.

**This issue therefore fixes cause #2**, which is self-contained, has a
module-local witness, and is a real correctness defect well beyond Temporal.

## Root cause of #2, and why it showed up as `null`

Two different lowerings ask the same too-narrow question, `flattenCallArgs`,
which only recognises an INLINE array literal (`new F(...[1, 2])`):

- `src/codegen/expressions/new-super.ts` — the native construct drivers are
  minted **one per call-site arity** (`native-construct.ts`,
  `reserveNativeConstructDriver`). An unresolvable arity makes the site
  `return undefined`, the `new` falls through to `ref.null.extern`, and the
  expression evaluates to `null`. That is the Temporal row: the harness's
  `assert.sameValue(duration.years, …)` then reports `Cannot access property on
  null or undefined`.
- `src/codegen/fnctor-constructor-identity.ts` —
  `emitFnctorConstructorArguments` pushes one operand per declared parameter, so
  the unexpanded `SpreadElement` degrades through `compileExpressionInner`'s
  last-resort arm (`expressions.ts` — a `SpreadElement` compiles as its own
  inner expression) and the whole ARRAY lands in the first parameter:

  | `function C(a,b,c){}` called as | before | after |
  | --- | --- | --- |
  | `const a=[1,2,3]; new C(...a)` | `1,2,3` `undefined` `undefined` | `1` `2` `3` |
  | `const a=[1,2,3]; new C(...a, undefined)` | `1,2,3` `undefined` `undefined` `undefined` | `1` `2` `3` `undefined` |

The class-`new` paths were already correct (`new K(...a)` on a declared class,
on a dynamic alias, and through a member all answered `123`), which is why this
had never been noticed: the broken shapes are the *function*-constructor one and
the arity-driver one.

## Implementation

New module `src/codegen/static-spread-arity.ts`,
`resolveStaticSpreadArgs(ctx, args)`. It flattens a spread ONLY when all four
hold:

1. the source is an identifier bound by a **`const`** declaration whose
   initializer is an array literal with no holes and no nested spread;
2. every element is a **re-evaluable literal** (number / string / bigint /
   `true` / `false` / `null` / `undefined` / a signed numeric literal) — so
   moving its evaluation from the literal site to the call site is
   unobservable;
3. **every** reference to the binding in its source file is itself a spread
   operand — no aliasing, no `xs[i] = …`, no `xs.push(…)`, no argument
   position. A `const` array is mutable *through its own reference*, so rule 1
   proves nothing about `length`; only rule 3 does;
4. the declaration is in the same source file as the call.

Rule 3 is the load-bearing one and the reason the helper is a predicate rather
than a rewrite: the failure mode of getting it wrong is not a missing answer but
a WRONG one (a mutated array expanded to its declaration-time length), which no
byte A/B would show. `tests/issue-6460-standalone-static-spread-arity.test.ts`
asserts the refusal explicitly, not just the success.

Both call sites gate on `ctx.standalone || ctx.wasi`. The JS-host lane already
repairs these shapes at runtime through `emitDynamicSpreadCall` (`__js_array_new`
+ `__call_function`), so widening the static rule there would move bytes for no
behavioural gain — and the `gc` lane must stay byte-identical.

## Residuals, with reductions, for the next slice

- **#1 above — `X.from(…)` results are inert across the link.** Anatomy
  measured (`.tmp/s12/p-census4.mjs`, `p-census6.mjs`): the result is truthy,
  is not `null`/`undefined`, `typeof` is `"object"` (whereas a `new`-built
  instance answers `"function"`), and yet every accessor and method read on it
  answers `null`. `Object.getOwnPropertyNames(Temporal.PlainDate.prototype)`
  TRAPS `illegal cast`; `Temporal.PlainDate.prototype.toString.call(d)` reports
  `called value is not a function`; `d.equals(control)` reports `invalid
  receiver: method called with the wrong type of this-object`. The single-module
  control passes, so this is boundary identity, not `Object.create`.
  Next slice should start from `Object.getOwnPropertyNames(<provider
  prototype>)` trapping — that trap is upstream of everything else in the list
  and is the cheapest handle.
- **A spread into a DYNAMIC call is still dropped**: `const g=f; const
  a=[1,2,3]; g(...a)` → `"1,2,3undefinedundefined"`. Same root cause, third
  lowering (`compileIdentifierCall` in
  `src/codegen/expressions/call-identifier.ts`, via
  `compileInternalCallArgument`), which reads `expr.arguments` positionally in
  about a dozen places; substituting a flattened list there did not fit this
  slice. PINNED by the last `it` in the test file.
- **`MAX_NATIVE_CONSTRUCT_ARITY` is 8, and two Duration rows sit above it.**
  `microseconds-undefined.js` / `nanoseconds-undefined.js` spread an 8-element
  `const args` plus a trailing `undefined`, i.e. arity 9, so
  `reserveNativeConstructDriver` still declines and those two keep answering
  `null`. That is a pre-existing ceiling, not this defect — raising it costs one
  driver FUNCTION per additional arity, so it wants its own decision. The other
  two rows left in the `164:22` bucket (`lower-limit.js`,
  `prototype/abs/basic.js`) use **no spread at all** and belong to residual #1.
- **Runtime-length spreads remain unexpanded on the arity-indexed paths.** The
  polyfill contains ~47 spread sites, of which 13 are `...arguments` and most of
  the rest are forwarded rest parameters — none of those has a static arity, so
  this fix does not reach them. The general repair is a native flatten-then-bind
  for the standalone lane (the shape `compileSpreadCallArgsWithArguments`
  already implements for statically-known callees).

## Measured

### Reduction table, base by file-copy revert on the same tree

`.tmp/base-{new-super,fnctor-constructor-identity}.ts` were captured at the
FIRST edit; every "base" number below is a run of the reverted tree, not an
inherited figure.

| reduction, `--target standalone` | base | S12 |
| --- | --- | --- |
| `function C(a,b,c){}; const a=[1,2,3]; new C(...a).s` | `1,2,3undefinedundefined` | **`123`** |
| `function C(a,b,c,d){}; const a=[1,2,3]; new C(...a, undefined).s` | `1,2,3undefinedundefinedundefined` | **`123undefined`** |
| `function C(a,b,c){}; new C(...[1,2,3]).s` | `[object Object]undefinedundefined` | **`123`** |
| LINKED: `const a=[1,1,1]; new Temporal.Duration(...a)` | `null` | **a Duration**, `.years===1`, `.months===1` |
| refusal control: `const a=[1,2]; a.push(3); new C(...a).s` | `1,2,3\|undefined` | `1,2,3\|undefined` (unchanged, on purpose) |
| refusal control: `let a=[1,2,3]; new C(...a).s` | `1,2,3undefinedundefined` | unchanged |
| refusal control: `const x=1; const a=[x,2]; new C(...a).s` | `1,2undefined` | unchanged |
| residual: `const g=f; const a=[1,2,3]; g(...a)` | `1,2,3undefinedundefined` | unchanged (PINNED) |

### Byte A/B

Fixed corpus (40 modules: `website/playground/examples/**` + `tests/fixtures/**`)
× {gc, standalone}: **80/80 artifacts sha256-identical** — that corpus contains
no spread-into-`new` at all, so it is a no-collateral control, not a positive
one. A targeted 11-shape corpus supplies the positive control:

| shape | gc | standalone |
| --- | --- | --- |
| `new C(...constArray)` | identical | **moved** |
| `new C(...constArray, undefined)` | identical | **moved** |
| `new C(...[1,2,3])` | identical | **moved** |
| `new C(1,2,3)` · mutated-source · `let`-source · non-literal-elements · `new Class(...a)` · dynamic call · plain arithmetic · plain class | identical | identical |

All 11 `gc` artifacts are identical; exactly the three repaired shapes move on
standalone, and every refusal control is byte-identical.

### Must-not-move standalone samples, tied to what this slice touched

| sample | base | S12 | pass→fail |
| --- | --- | --- | --- |
| `language/expressions/new/**` (59 rows — the whole directory) | 56 pass / 3 fail | 56 / 3 | **0** |
| `built-ins/Object/**` (first 120) | 106 pass / 14 fail | 106 / 14 | **0** |

## Acceptance

- `new Temporal.Duration(...args)` answers a real Duration host-free
  (was `null`). ✅ measured
- The three linked families do not regress, and the Duration `164:22` bucket
  shrinks 9 → 4. ✅ measured (`### S12 findings` in #5383)
- `gc` artifacts byte-identical on a fixed corpus. ✅ measured
- The three-family SCORE does not move (170 → 170): the five unblocked rows
  now fail one step later, on residual #1. That is the honest result and is
  reported as such rather than as a win.
