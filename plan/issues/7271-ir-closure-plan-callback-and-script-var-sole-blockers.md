---
id: 7271
title: "IR closure source plan: arrow call-argument callbacks and `var f; f = (…) => …` script vars — measured; needs new machinery, yield 0 for a bounded extension"
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
related: [7195, 7198, 7130, 7268]
depends_on: [7195, 7198]
---

# IR closure source plan: the 8 sole-blocker files from #7268

## Problem

#7268 measured `closure-return-type` on the wrapped stride-40 standalone census
(main 9129f7e1). It ranked two follow-up sites in the closure source plan
(`src/codegen/function-member-closure-planning.ts`):

1. Arrow call-argument callbacks: 5 sole-blocker files.
2. `var f; f = (…) => …` script-var assignments with parameters: 3 files.

This issue measures whether a **bounded** extension of the existing sites
admits those 8 files:

- `memberAssignmentSite`, `argumentPositionSite` (#7130),
  `callArgumentSite` (#7195), `scriptVarSite` (#7198);
- `openBodyKey` and the parameter proof in `planMemberClosure`.

## Measurement (step 1)

**Method.**

- I rewrote the test source in a `.tmp/` probe before the wrapped compile.
  `compile`, the harness assembly and the options are exactly the ledger's
  (`.tmp/probe7271.mts`).
- **Variant `arrow`:** every arrow becomes the function expression the plan
  already accepts (`() => X` → `function () { return X; }`). This isolates
  what remains once the plan's `expression` is widened to arrows.
- **Variant `arrow+init`:** additionally `var f;\nf = …` → `var f = …`. This
  is the exact `scriptVarSite` shape (#7198).
- Each cell is the `<module-init>` first refusal (`JS2WASM_IR_SHAPE_DIAG=1`),
  the only legacy unit in all 8 files.

| File | Today | Variant `arrow` | Variant `arrow+init` |
| --- | --- | --- | --- |
| `Array/prototype/with/this-value-nullish.js` | `closure-return-type` | `operand-coercion-unsupported` (`Array.prototype.with.call(null, 0, 0)` in the planned body) | same |
| `Date/prototype/toString/non-date-receiver.js` | `closure-return-type` | `expr-ident-not-in-scope` «Date» | same |
| `Object/defineProperties/…-not-undefined.js` | `closure-return-type` | `expr-ident-not-in-scope` «Object» | same |
| `Object/defineProperty/…-not-bigint.js` | `closure-return-type` | `call-resolution-unsupported` | same |
| `Temporal/Instant/from/argument-wrong-type.js` | `closure-return-type` | `closure-return-type`: no plan, the oracle return is `any` | same |
| `arrow-function/dstr/ary-ptrn-elem-obj-id.js` | `closure-return-type` | `closure-return-type`: no site matches `f = …` | `vardecl-let-closure`: no plan |
| `function/dstr/ary-ptrn-elem-obj-id.js` | `closure-return-type` | `closure-return-type` | `vardecl-let-closure` |
| `function/params-trailing-comma-multiple.js` | `closure-return-type` | `closure-return-type` | `vardecl-let-closure` |

**Zero-legacy yield of a bounded extension: 0 of 8**, in either variant.

### What each group needs (all new machinery)

**Arrow callbacks (5 files).**

- **Arrow sites.** Widening the plan's `expression` from `FunctionExpression`
  to arrows touches several places at once:
  - the plan type;
  - `resolve` in the selector, which today checks `ts.isFunctionExpression`;
  - the from-ast entry;
  - `computeSignature`;
  - the identity unit kind (`function-expression`);
  - `captureMemberClosureSyntax` / `bodyReadsThis`, because an arrow's
    `this` is lexical.

  That alone wins nothing: once the arrows are rewritten, every file stops at
  a body proof.
- **Ambient intrinsics in a planned body.** `Object`, `Date` and `Temporal`
  are `expr-ident-not-in-scope` inside a planned closure, which is selected
  over an empty outer scope. Admitting them needs an intrinsic-global
  resolution for planned bodies. Neither the selector nor `openBodyKey` has
  one today. This blocks 2 files and is the dominant shape.
- **`X.prototype.m.call(recv, …)`.** The planned-closure operand walk refuses
  it (`operand-coercion-unsupported`): 1 file.
- **`Object.defineProperty({}, 'a', 0n)`.** The callee does not resolve in
  module-init (`call-resolution-unsupported`): 1 file.
- **A dynamic-result callback** (`() => Temporal.Instant.from()`, oracle
  `any`). The plan admits only `void`/`boolean`/`string` results. A
  call-argument site's result is unused, so it could take the void ABI once
  arrows are planned; but it also needs the intrinsic-global resolution
  above: 1 file.

**Script vars assigned later (3 files).** `scriptVarSite` refuses all three
even in the `var f = …` initializer form, for four independent reasons:

- **Called through the dynamic home.** `ref(42, 39, 1)` and
  `f([{ x: 11, … }])` call the binding. `scriptVarReferencesAreValueUses`
  admits only argument, `typeof` and `=` uses. A call needs a dynamic
  invocation of the boxed closure, which #7198 deliberately did not plan.
- **Function-object identity.** `assert.sameValue(ref.length, 2)` reads a
  property of the function object. #7198 records that the boxed closure is
  not legacy's function object: its `name` and own properties differ. So
  admitting the reference would change behaviour, not just route.
- **A script-level write in the body.** `callCount = callCount + 1` is
  refused by `openBodyKey` (`isScriptLevelBinding`) unless the site sets
  `moduleGlobals`. Only `argumentPositionSite` (#7130) does.
- **A binding-pattern parameter with a default.** `[{ x, y, z } = { … }]`
  hits the parameter proof, which admits identifier parameters only (2 files).

Moving the site from the initializer to the later `f = …` assignment is the
small part. The rest is a dynamic-call plan plus a function-object carrier
(`length`/`name`).

## Conclusion

Per the dispatch's stop rule (yield 0, needs new machinery), no code lands.
The next pieces, ordered by how many of the 8 files each one unblocks:

1. **Intrinsic globals in planned closure bodies** (`Object`, `Date`,
   `Temporal`, …), resolved as module-init resolves them. This is a
   prerequisite for 3 of the 5 arrow files. It is a selector and from-ast
   seam, not a planner site.
2. **Arrow sites in the plan**: one widening of
   `IrFunctionMemberClosurePlan.expression`, shared by every site. It is
   worth doing only together with 1.
3. **A dynamic call of a script-var closure plus function-object `length`/`name`**
   (the 3 script-var files). This is a function-object carrier question,
   adjacent to the callable-carrier work. It is not a planner extension.

## Acceptance (for the follow-ups)

- **Correctness.** Each piece names its sole-blocker files and makes them
  zero-legacy on the stride, with zero post-claim withdrawals. IR = legacy =
  node on those files.
- **Byte-identity.** gc and typed-corpus output are byte-identical.
- **Code quality.** Arrows widen the one plan type. No parallel arrow
  planner, and no second site per position.
