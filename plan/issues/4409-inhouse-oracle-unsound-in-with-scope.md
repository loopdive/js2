---
id: 4409
title: "In-house oracle is unsound inside `with` — and invents a declared name for `Object.getPrototypeOf`"
status: ready
sprint: current
created: 2026-08-14
updated: 2026-08-14
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: checker
language_feature: with
goal: correctness
parent: 4218
depends_on: [4408]
---

## Problem

Two real violations of the in-house oracle's stated contract — _never widen a
guess into a fact_ — found by adjudicating the differential run against
ECMAScript semantics rather than against the TS5 checker's answers.

### 1. Identifiers inside `with` are resolved lexically (unsound)

Minimal repro:

```js
var x = 0;
var scope = { x: 1 };
with (scope) {
  x = 2;
}
```

| query                      | in-house  | TS5 checker | ECMAScript                                             |
| -------------------------- | --------- | ----------- | ------------------------------------------------------ |
| `isUnresolvableIdentifier` | **false** | `true`      | must abstain — `x` is `scope.x`, not the outer `var x`  |

`with (obj)` pushes an object Environment Record on the scope chain, so `x`
resolves to `obj.x` whenever `obj` has the property (modulo
`obj[Symbol.unscopables]`). Resolution is a **runtime property lookup**; no
static binder can answer it. The TS5 checker abstains here deliberately, and
that abstention is the correct answer.

The in-house binder walks lexical scopes and reports the enclosing `var x`.
Same defect visible on the wide corpus at:

- `language/expressions/assignment/S11.13.1_A5_T1.js` — `variableDeclarationOf(x)`
  returns the outer `var x` where the test's whole point is that `x` is
  `scope.x` until `delete scope.x` runs mid-expression.
- `language/expressions/{arrow-function,async-generator,async-arrow-function}/unscopables-with*.js`
  — `declarationsOf(count)`, `declarationsOf(v)`, `variableDeclarationOf(v)`,
  `staticJsTypeOf(count) = number`. The checker returns `[]` / `mixed`; the
  in-house backend commits.

In the `unscopables` tests the in-house answer happens to be _correct_, because
`globalThis[Symbol.unscopables].v` is set to `true` and the object binding is
therefore skipped. That is luck, not soundness — the same code with
`unscopables` unset resolves the other way, and the backend cannot tell.

`staticJsTypeOf(count) = number` is the dangerous one: it is a **lowering
decision**. A `with`-scoped name typed as `number` can be emitted as an unboxed
f64 local when the runtime value is whatever the `with` object holds.

### 2. `declaredNameOf` invents a name for an `any`-typed expression

```js
var actual = [1, 2, 3];
Object.getPrototypeOf(actual);
```

| query            | in-house             | TS5 checker | lib.d.ts                       |
| ---------------- | -------------------- | ----------- | ------------------------------ |
| `declaredNameOf` | **`ArrayConstructor`** | `undefined` | `getPrototypeOf(o: any): any`  |

The declared return type is `any`; there is no declared name to report. Seen on
the wide corpus as `ArrayConstructor` (Array/prototype/flatMap) and
`FunctionConstructor` (`Object.getPrototypeOf(Intl.DateTimeFormat)`), so the
backend appears to be naming the *receiver's* constructor rather than the
call's result.

## Acceptance criteria

- [ ] The in-house binder marks every identifier lexically enclosed by a `with`
      statement body as **unresolvable**, for all of `valueDeclarationOf`,
      `variableDeclarationOf`, `declarationsOf`, `staticJsTypeOf`, `typeFactOf`
      and `isUnresolvableIdentifier`.
- [ ] The scope is the `with` **body**, transitively through nested functions
      declared inside it — the corpus hits are in nested functions
      (`unscopables-with-in-nested-fn.js`).
- [ ] `declaredNameOf` returns `undefined` when the resolved declaration's type
      is `any` / not a named type reference; it never names the receiver.
- [ ] Regression tests: the two repros above, asserted as **abstentions**, not
      as specific answers.
- [ ] After the fix, the differential's `checker-weaker` bucket loses the
      `with` rows and the `declaredNameOf` rows (18).

## Confirmed: this costs real conformance (standalone A/B, 2026-08-14)

The emitted-code proxies said the unsound facts were harmless — on 1,804
compilable inputs, 91 differed, net box/unbox traffic **0**, bytes −219. That
was the wrong instrument. A **standalone-mode test262 A/B** (no JS host to
absorb a de-specialised value, `JS2WASM_EVAL_ENGINE=quickjs`) run under each
backend over the divergence areas — 3,137 tests,
`TEST262_PATH_FILTER=with|unscopables|eval-code|annexB|resizable-buffer|fromAsync`:

| status          | checker  | inhouse  |
| --------------- | -------- | -------- |
| pass            | **1891** | **1854** |
| fail            | 757      | 791      |
| compile_error   | 489      | 492      |

**−37 pass. 42 `pass`→`fail`, 5 `fail`→`pass`.** Where they land:

| count | family                                            |
| ----- | ------------------------------------------------- |
| 27    | `language/statements/with/S12.10_A1.*`            |
| 11    | `annexB/language/function-code/` (B.3.3 hoisting) |
| 1     | `annexB/language/expressions/`                    |
| 3     | neither — see below                               |

So the two classes this issue and #4410 B2 identified account for **39 of 42**.

A representative failure, `language/statements/with/S12.10_A1.1_T1.js`, is the
minimal repro at full size: outer `var result = "result"`, then
`with (myObj) { … }` where `myObj` carries properties of the same names
(including `eval`, `parseInt`, `NaN`). The in-house binder resolves those
lexically; ECMAScript resolves them against the object. Because
`staticJsTypeOf` feeds a lowering decision, the compiler does not merely hold
a wrong fact — it emits wrong code.

### The 3 unexplained regressions

These match the path filter on their **filenames** and contain no `with`
statement at all (verified: zero `^\s*with\s*\(` in each):

- `built-ins/Object/prototype/setPrototypeOf-with-same-value.js`
- `built-ins/Array/prototype/with/ignores-species.js` — `Array.prototype.with()`,
  the method, not the statement
- `built-ins/TypedArray/prototype/subarray/results-with-empty-length.js`

They are a **separate, undiagnosed class** and must not be assumed fixed by the
`with`-scope work. Diagnose before closing this issue.

### The 5 improvements

All TypedArray, all `fail`→`pass`: `reduce`/`reduceRight`
`empty-instance-with-no-initialvalue-throws` (×4) and
`slice/BigInt/results-with-empty-length`. Consistent with #4410 — the in-house
backend is genuinely better in places, which is why "match the checker" was
never the right gate.

## Consequence for #4218

The retirement gate is **not met**. `zero standalone-mode test262 regressions
under JS2WASM_ORACLE_BACKEND=inhouse` currently reads **−37**, and this issue
is the bulk of it.

## Notes

Scope: a full standalone pass is ~8h **per backend** on a 4-core container
(measured 98 tests/min), so this A/B was filtered to the areas where the
differential showed the backends diverge at all. 39 of 42 regressions landed
inside that filter, which is evidence the scoping was right rather than lucky —
but the remaining 3 show it is not a proof of completeness. **A full-corpus
standalone A/B belongs in CI** (`test262-sharded.yml` already runs that lane
across many runners in ~19 min); wiring `JS2WASM_ORACLE_BACKEND` in as a
`workflow_dispatch` input is the durable form of this gate.
