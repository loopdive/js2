---
id: 1557
sprint: 53
title: "ESLint config.js direct compile: __obj_meth_tramp validate arity mismatch (need 2, got 1)"
status: done
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: methods, trampolines, object-literal-methods
goal: npm-library-support
related: [1400, 1289, 1287, 1282]
blocks: [eslint-tier-1d]
note: "Verified 2026-05-21: compileCallExpression at src/codegen/expressions/calls.ts:965 (moved from expressions.ts); trampoline emit at src/codegen/closures.ts:3019/3085"
---

# #1557 — ESLint config.js validate trampoline arity mismatch

## Problem

Pointing `compileProject` at `node_modules/eslint/lib/config/config.js`
directly fails Wasm validation with:

```
__obj_meth_tramp___anon_0_validate_16:
  not enough arguments on the stack for call (need 2, got 1)
```

This was uncovered by the #1400 partial PR (`Config_new` `extern.convert_any`
fix). The `Config_new` validation error previously masked it; once the
duplicate `extern.convert_any` pair was scrubbed, `config.js` advanced to the
next validation blocker — an object-method trampoline emitted for an inline
`validate(...)` method that is invoked with only one argument on the stack
when the trampoline expects two.

## Reproducer

```ts
import { compileProject } from "./src/index.js";

const r = compileProject(
  "/workspace/node_modules/eslint/lib/config/config.js",
  { allowJs: true },
);
expect(r.success).toBe(true);              // currently passes
expect(WebAssembly.validate(r.binary)).toBe(true); // currently fails
```

`r.binary` validation rejects function
`__obj_meth_tramp___anon_0_validate_16` at the call site that expects
`(this, args...)` but only has one operand on the stack.

A reduced repro likely sits around inline-object-literal methods invoked
through a chained property access — e.g. ESLint's config schema validators
of the shape:

```js
const schemaValidators = {
  validate(value, options) { /* ... */ },
};
schemaValidators.validate(input); // 1 arg supplied; trampoline wants (input, opts?)
```

When the codegen emits `__obj_meth_tramp_*` it includes the `this` rebind
plus the user args, but the call site is dropping (or never pushed) the
missing arg. The mismatch only surfaces in the multi-module pipeline used
by `compileProject`.

## Hypothesis

One of two root causes is most likely:

1. **Default-parameter omission in trampoline body**: the trampoline signature
   was synthesized from the method declaration with N parameters, but the
   call site translates `obj.method(a)` for an N=2 method without padding
   the missing argument with the parameter's default expression (or
   `undefined`).
2. **`this` rebind injection inconsistency**: the trampoline body pushes
   `this` from a captured cell but the caller side does not push the
   matching synthetic `this` operand, leaving the stack one short on the
   trampoline's perspective.

#705 ("Wasm validation: not enough arguments on stack") fixed a related
pattern for regular function calls — this is the object-method-trampoline
variant.

## Suggested investigation

1. `wasm-dis` the produced `config.js` binary and locate
   `__obj_meth_tramp___anon_0_validate_16`. Inspect its signature
   (expected param count) and its body's call instruction.
2. Trace the codegen call-site that emits the `call $__obj_meth_tramp_...`
   in the parent function — confirm whether the caller pushed all
   declared parameters (including defaulted/optional ones).
3. Check `src/codegen/expressions/calls.ts` around `compileCallExpression`
   (line 965, verified 2026-05-21) for the object-method path,
   specifically the branch that resolves to a generated trampoline
   rather than a direct method call. The trampoline itself is emitted
   in `src/codegen/closures.ts` (lines 3019 and 3085 — per-call-site
   and cached variants of `__obj_meth_tramp_*`). Compare with the
   single-module pipeline's equivalent path to see if the
   multi-module variant skips a padding step.

## Acceptance criteria

1. `WebAssembly.validate(r.binary) === true` for
   `compileProject("/workspace/node_modules/eslint/lib/config/config.js", { allowJs: true })`.
2. A regression test under `tests/` pins the minimal reduced repro (an
   inline object literal with a multi-parameter method, called with
   fewer arguments at a property-access call site, through the
   multi-module pipeline).
3. ESLint Tier 1c remains green; Tier 1d unskips and either passes or
   moves to its next-blocker error (#1558).
4. No regression in existing lodash/Hono Tier 1+2 stress tests.

## Notes

- This is the second of two known-next-blockers identified in the
  #1400 partial PR resolution notes.
- Pairs with #1558 (`Linter_verifyAndFix` f64.eq coercion). Both must
  land before Tier 1d (`linter.js` binary instantiates) goes green.
- Out of scope: the bare-package `import { Linter } from "eslint"`
  resolver path (covered by #1559) and the CJS class re-export linkage
  (covered by #1560).
