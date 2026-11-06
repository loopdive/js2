---
id: 7268
title: "IR: closure literals without a return-type annotation refuse as `closure-return-type` — measured; needs closure source-plan sites, not an inferred-return admission"
status: blocked
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
parent: 7106
related: [7195, 7198, 7130, 7254]
depends_on: [7195]
---

# IR: closure literals without a return annotation (`closure-return-type`)

## Problem

`closureLiteralIsBuildable` (`src/ir/select-closure-literal.ts`) admits an
**unplanned** closure literal only when it has an explicit return annotation
that `annotationToResolvedKind` resolves:

```ts
if (!plan && (!expr.type || host.annotationToResolvedKind(expr.type) === null))
  return host.shapeNo("closure-return-type", expr.type ?? expr);
```

Test262 JS never has annotations, so every unplanned closure refuses here. The
proposed fix was a bounded admission: when `expr.type` is absent, take the
return kind from the checker's inferred signature (`ctx.oracle.signatureOf`)
and continue into the existing body proof.

## Measurement (step 1)

**Setup.**

- Base: `origin/main` 9129f7e1.
- Census: `JS2WASM_IR_SHAPE_DIAG=1 npx tsx scripts/ir-claim-ledger.mts --wrapped
  --stride 40 --target standalone --jobs 3 --files-json …`.
- Population: 1118 test262 files compiled; 32 already zero-legacy.

**Totals.**

- 35 `closure-return-type` first-refusal parts in 35 files.
- 10 files have it as their only legacy unit.
- Inferred return types: measured with `checker.getReturnTypeOfSignature` on
  the wrapped source, in `.tmp/` probes only. The compiler would ask the oracle.

| Group | Parts | Position | Params | Inferred return | Sole blocker |
| --- | --: | --- | --: | --- | --: |
| `assert.throws(C, () => { … })` arrow callbacks | 7 | call argument of `assert.throws` | 0 | `void` ×5, `string` ×1 (`() => Date.prototype.toString()`), `any` ×1 (`() => Temporal.Instant.from()`) | 5 |
| `assert.throws(C, function () { … })` | 2 | call argument of `assert.throws` (no #7195 plan: body fails the plan's proof) | 0 | `void` | 1 |
| harness `matchValidator` returned closure | 14 | `return function (match) { … }` in a harness function | 1 | `void` | 0 |
| harness `asyncHelpers` `assert.throwsAsync = function (C, func, msg) { return new Promise(…) }` | 6 | member assignment in `<module-init>` | 3 | `Promise<void>` | 0 |
| `var f; f = (pattern) => …` / `var ref; ref = function (a, b,) { … }` | 3 | assignment to a script var, then called directly | 1–2 | `void` | 3 |
| `then: function () { return returnedThenable; }` | 1 | member assignment, returns an object | 0 | `{ then: () => void }` | 0 |
| `.then(_ => { throw … })` | 1 | call argument of a dynamic method | 1 | `never` | 0 |
| `return function () {};` inside test function `fn` | 1 | returned closure | 0 | `void` | 1 |

**22 of 35 parts have at least one unannotated parameter.** An inferred return
alone does not admit them: the next check refuses `closure-param-type`. On the
unplanned route only a source plan supplies dynamic parameter slots.

**The admission wins nothing.** Experiment in `.tmp/` copies, now reverted:

- I removed the return-annotation requirement completely, in both the selector
  and from-ast, so a missing annotation lowers as `void`.
- I recompiled the 10 sole-blocker files wrapped, on standalone.
- **0 of 10 became zero-legacy.** Each unit stops at its next refusal:

| File | Next refusal with the check removed |
| --- | --- |
| `Array/prototype/with/this-value-nullish.js` | `tail-unhandled` on `Array.prototype.with.call(null, 0, 0);` |
| `Object/defineProperties/…-not-undefined.js` | `tail-unhandled` on `Object.defineProperties({}, …)` |
| `Object/defineProperty/…-not-bigint.js` | `tail-unhandled` on `Object.defineProperty({}, 'a', 0n)` |
| `Object/defineProperty/15.2.3.6-4-196.js` | `call-resolution-unsupported` |
| `Date/prototype/toString/non-date-receiver.js` | `expr-ident-not-in-scope` «Date» |
| `Temporal/Instant/from/argument-wrong-type.js` | `expr-ident-not-in-scope` «Temporal» |
| `arrow-function/dstr/ary-ptrn-elem-obj-id.js` | `closure-param-type` |
| `function/dstr/ary-ptrn-elem-obj-id.js` | `closure-param-type` |
| `function/params-trailing-comma-multiple.js` | `closure-param-type` |
| `module-code/top-level-await/…-literal-number.js` (`fn`) | `move-only[stmt]` on `return function() {};` |

**The unplanned route is also the wrong carrier for these values.**

- Unplanned closures lower to a typed IR closure, with the signature taken from
  annotations.
- Every closure above flows into a dynamic slot: a harness callee parameter, a
  dynamic member, a script-var dynamic home, or a returned value.
- The source plan exists to prove that boundary. `notePreparedAllocation`
  checks that the IR `closure.new` uses exactly legacy's
  `computeClosureWrapperSig` wrapper struct and funcref type (#7195).
- An inferred-return admission on the unplanned route skips that proof.
- Admitting there would also not keep annotated typed-corpus closures and
  their gc output byte-identical by construction.

## Conclusion

Per the dispatch's stop rule, no code lands here. Each refusal is closed by a
**site in the closure source plan** (`src/codegen/function-member-closure-planning.ts`,
the one planner). An inferred-return arm in the selector would not close any
of them. In order of sole-blocker yield:

1. **Arrow call-argument callbacks** (5 sole files, the #7195 follow-up). This
   widens the plan's `expression` beyond `FunctionExpression`. Each of the 5
   still needs its own body proof: `X.call(…)` tail statements, `Object.*`
   static calls, and ambient `Date`/`Temporal` identifiers.
2. **Closures assigned to a script var, with parameters** (3 sole files). This
   extends #7198's `script-var` site from the `var f = …` initializer to a
   later `f = …` assignment, plus dynamic parameter slots
   (`dynamicParameterIndices`) and binding-pattern parameters.
3. **Returned closures**: `matchValidator` (14 parts, the harness of every
   RegExp property-escape file) and `fn`. This needs a new `return` site plus
   the move-only return path.
4. **Member assignment with parameters and a non-void return**
   (`asyncHelpers.throwsAsync`, 6 parts). This needs a Promise result and is
   the largest site.

Status is `blocked` on #7195 (call-argument site, in progress), which owns the
plan shape these sites extend.

## Acceptance (for the follow-up sites)

- **Correctness.** Each site makes its sole-blocker files zero-legacy on the
  stride, with zero post-claim withdrawals. IR = legacy = node on those files.
- **Byte-identity.** gc and typed-corpus output are byte-identical.
- **Code quality.** One planner with one site function per position, all in
  the same shape. No new selector or from-ast arm. No inferred-return path on
  the unplanned route.
