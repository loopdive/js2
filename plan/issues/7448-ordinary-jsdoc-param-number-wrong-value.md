---
id: 7448
title: "Ordinary pipeline: a JSDoc `@param {number}` makes `x + 1` numeric for a string argument"
status: ready
created: 2026-11-22
updated: 2026-11-22
priority: high
horizon: s
goal: core-semantics
sprint: Backlog
related: [7354]
---

# #7448 — Ordinary pipeline: a JSDoc `@param {number}` makes `x + 1` numeric for a string argument

## Problem

`/** @param {number} x */ export function h(x){ return x + 1 }` called as `h("a")` returns `NaN`; node returns `"a1"`. A JSDoc type in a `.js` file is a hint, not a guarantee, so the addition must stay dynamic unless every caller is proven numeric.

Found on 2026-11-22 during the #7354 slices (Prepared whole-program IR path).

## Acceptance criteria

- `h("a")` returns `"a1"` on the default and standalone targets.
- A function whose callers are all provably numeric keeps its numeric addition (no size regression on the playground corpus).

## Findings (2026-11-26, head 41f0654e8c) — not fixed: no local fix exists

Reproduces on both targets (default and `{ target: "standalone" }`, `allowJs`, `.js`). A literal mismatch
(`h("a")` directly) is a compile error, not a wrong value: the analyzer sets `checkJs = true`
(`src/checker/index.ts:1056`), so a JSDoc tag is a *checked* annotation. The wrong values come from the
flows TypeScript accepts: an `any` value into a JSDoc-typed position, and an omitted argument.

| program (`g()` body; node's answer is `true`) | default | standalone | IR-claimed |
| --- | --- | --- | --- |
| `/** @param {number} x */ h(x){return x+1}`, `c(v){return h(v)}`, `c("a") === "a1"` | false | false | h |
| same, `c({}) === "[object Object]1"` | false | false | h, c |
| same, `typeof x` in `h`, `c("a") === "string"` | false | false | h, g |
| `@param {number=} x`, `c("a") === "a1"` | false | false | none |
| `@param {number} x`, `function c(){return h()}`, `c()` is NaN | false (1) | false (1) | none |
| `/** @returns {number} */ h(x){return x}`, `h("a") + 1 === "a1"` | false | false | none |
| unchanged and correct: `undefined`, `null`, `true`, numeric args; `@type {number}` local; `.ts` `x: number` | ok | ok | |

Cause: the checker's JSDoc type is trusted by every consumer, not at one site.

1. The callee slot: legacy `lowerParamType` lowers the checker type (`src/codegen/declarations.ts:1160`,
   `resolveWasmType(ctx, paramType)`), so the `any` argument is converted with ToNumber at the call; the IR
   seeds the same type (`src/ir/propagate.ts:642`), and `jsDocParamIsExternrefCandidate`
   (`src/ir/select.ts:2592`) deliberately excludes `number`/`string`/`boolean`.
2. The callee body: legacy compiles `x + 1` from the checker type of `x`. Even with an externref slot (the
   `@param {number=}` case already has one, via `parameterMayBeOmitted`) it emits ToNumber then `f64.add`.
3. Downstream inference: TypeScript infers `h`'s result as `number`, then `c`'s (unannotated, `return h(v)`),
   and folds `c("a") === "a1"` to `false` in `g` ("no overlap"). Fixing `h` alone still leaves `c` with an
   f64 result and `g` with a constant.

So no change at one codegen site gives node's value; the type has to stop reaching the checker. Options:

- **A. Untrust a tag that a dynamic value reaches, before checking.** Build the program; collect each
  JSDoc primitive tag (`@param`, `@returns`, `@type`) with a dynamic inflow (an `any`/`unknown` argument, an
  omitted argument, the function used as a value; a returned `any`; an `any` store); blank those tags'
  `{type}` in the JS text (same length, positions unchanged) and re-check, to a fixpoint. Tags with only
  typed inflows are kept, so `fib(n)` and the #3497 landing programs stay typed and byte-identical. Cost:
  one more checker pass for an affected program; a new module beside `src/checker/index.ts`, applied in
  `analyzeSource`, `analyzeMultiSource` and `analyzeFiles`. Exported functions: host callers are unknown;
  counting an export as an inflow untypes every exported JSDoc signature (landing benchmarks, #3497), so this
  needs a decision.
- **B. JSDoc is a comment in the ordinary pipeline too** (the #7354 W2 rule of the Prepared path), e.g. by
  dropping primitive JSDoc types for JS files. Simple and sound, but it changes every JSDoc-typed JS
  program, removes the checkJs errors for literal mismatches, and reverses #3497's "TypeScript-effective
  JSDoc signatures". A project-lead decision, not a bug fix.
- **C. Separable local fix, the omitted-argument row only:** treat a JS-file JSDoc parameter a caller omits
  like `parameterMayBeOmitted` does (externref slot; `x + 1` then gives NaN). Does not touch the string rows.
