---
id: 7448
title: "Ordinary pipeline: a JSDoc `@param {number}` makes `x + 1` numeric for a string argument"
status: in-progress
created: 2026-11-22
updated: 2026-11-26
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

Option C fixed in this PR; the remaining rows await the project lead's B decision.

## Implementation Plan (option C)

Lead decision 2026-11-26: option C only (the omitted-argument row).

- **Cause (head 41f0654e8c).** `parameterMayBeOmitted` (`src/codegen/declarations.ts:1125`) knew only the
  optional spellings (`x?`, `{T=}`, `[x]`). For `@param {number} x` legacy `lowerParamType`
  (`declarations.ts:1160`) lowered `x` to f64 and the caller padded the omitted argument with `0`, so
  `x + 1` was `1`. The IR selector's `jsDocParamIsExternrefCandidate` (`src/ir/select.ts:2592`) excluded
  `number`, so when `h` also had `@returns {number}` the IR claimed `h` with an f64 slot.
- **Change.** A JSDoc-typed, non-rest parameter of a function declaration is also omittable when a direct
  call in the declaring file omits it (`h()`); `new F()` is not counted (the fnctor path compiles that
  body and does not read the slot).
- **Module.** The predicate moves to `src/shared/omittable-param.ts` (AST-only, a leaf both front-ends
  import, like the other `src/shared/` predicates). The call-site index it reads (`calleeNameIndex`, #4416)
  moves unchanged to `src/shared/callee-name-index.ts`, with `siteOmitsArgument`, the arity test
  `inferParamTypeFromCallSites` already used for `sawUnderApplied`.
- **Reuse / duplicates removed.** One predicate for every ABI site: legacy `lowerParamType` and the generic
  call-site arm, the closure-call wrapper (`call-identifier.ts`), the callable-property dispatch (its
  restated copy in `callable-property-omittable-param.ts` is deleted, the copy existed only to dodge the
  import cycle) and the IR selector (`jsDocParamIsExternrefCandidate` now also asks legacy for such a slot,
  so it refuses at select instead of claiming f64 and withdrawing on a typeIdx parity mismatch). The call
  index is shared, not walked twice.
- **Acceptance.** Correctness: the omitted-argument programs match node on the default and standalone
  targets. No change: every JSDoc program whose callers pass all arguments, `.ts` programs, the landing
  benchmarks (#3497) — byte-identical. Code quality: no new duplicate, no growth of `src/ir/select.ts`, no
  new import-cycle edge, `loc`/`func`/`import-cycles` gates green without grants.

## Result (option C)

Measured 2026-11-26 against origin/main 41f0654e8c (`compile`, `allowJs`, `.js`), default and standalone
give the same answers:

| program (node's answer) | main | this PR | IR-claimed (main → PR) |
| --- | --- | --- | --- |
| `/** @param {number} x */ h(x){return x+1}`, `h()` (NaN) | 1 | NaN | none |
| same, `c(){return h()}`, `c()` | 1 | NaN | none |
| `h() + h(2)` | 4 | NaN | none |
| two params, `add(1)` | 1 | NaN | none |
| `h` with `@returns {number}`, `h()` | 1 | NaN | h, b → none (refused at select, no withdrawal) |
| `@param {string} s`, `h() === "undefined!"` | trap | true | none → h, g |
| `@param {boolean} b`, `h()` is `undefined` | false | true | none → h, g |
| `h()` while `h` is also stored as a value / property | 4 | NaN | none |
| exported `h`, `h()` | 1 | NaN | none |
| `typeof x` in `h`, `h()` ("undefined") | "number" | "number" | still wrong: the checker type `number` folds `typeof` (cause 2 above) |
| `var f = h; f()` (NaN) | 1 | 1 | still wrong: a call through a value is not a direct call |
| `new P()` with `@param {number} x` | 1 | 1 | still wrong: fnctor path, unchanged |

Byte identity (153 programs, 312 compiles, default + standalone, + linear for the landing set): identical
for 75 JSDoc programs whose callers pass every argument, 30 `.ts` programs, the 13 playground examples, the
landing benchmarks, and 14 assembled test262 files (6 whose harness functions are called with fewer
arguments: their omitted parameters are object-typed, already externref). The 12 omitted-argument programs
above differ: 10 now correct, the `typeof` one still wrong, and a `for (i < n)` loop that
was already correct (its slot is now externref). Pins: `tests/issue-7448-jsdoc-omitted-argument.test.ts`
(18 of 22 fail on main; the select-time refusal pin also fails with only the legacy half applied).

Known, not touched: the `String(g0())` shape in the ordinary IR (`IR alloc-provenance check failed` for
`g`) already fails on main for `@param {string=} s`; with this change the omitted `@param {string} s`
variant reaches it too (main: a null-pointer trap; now that compile error).
