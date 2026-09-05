---
id: 5290
title: "Two signature derivations ignore `parameterMayBeOmitted` — an omitted argument arrives as `0`, and the bracketed JSDoc spelling emits an invalid module"
status: done
sprint: current
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/closures.ts
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
---

## Problem

`parameterMayBeOmitted` (declarations.ts) widens `size?: number`,
`@param {number=} size` and `@param {number} [size]` to externref on the callee
side. Its comment names the reason and the witness:

> A JSDoc/TypeScript optional parameter may be omitted by a caller that is
> compiled in another source module. … Without this, `@param {number=} size`
> receives `0` from pushDefaultValue and `typeof size`/Number.isNaN guards
> observe the wrong value (webpack's formatSize is the regression witness).

Two other derivations of the same signature did not honour it, and webpack's
`formatSize` was still red because of them.

### 1. The declared-signature wrapper on the identifier call path

`compileIdentifierCall` builds `sigParamWasmTypes` from the DECLARED parameter
types (`resolveWasmType`), with a single existing carve-out for binding
patterns — added for exactly this reason, "so the call site agrees with the
compiled callee". An omittable parameter needed the same carve-out: without it
the wrapper asks for a scalar the compiled callee never declared, and the
missing-argument pad re-introduces the `0` the callee's widening exists to
prevent.

Reached through a **default export**, so:

```js
/** @param {number=} size */
const f = (size) => { if (typeof size !== "number") return "unknown"; if (size <= 0) return "zero"; return "n"; };
export default f;          // f() → "zero"    ✗
export const g = f;        // g() → "unknown" ✓  (byte-identical function)
```

### 2. The closure boundary's own JSDoc check

```ts
const jsdocOptional =
  jsdocType !== undefined
    ? ts.isJSDocOptionalType(jsdocType)
    : ts.getJSDocParameterTags(p).some((tag) => tag.isBracketed === true);
```

The two JSDoc spellings of "optional" are independent, not alternatives:
`@param {number=} size` puts the optionality in the TYPE, `@param {number}
[size]` puts it in the TAG and leaves the type a plain `number`. Testing the
tag only when there is **no** type node therefore missed every bracketed
parameter that also carries a type — which is all of them.

That one is not merely a wrong answer. The `typeof` lowering takes an
externref, so a bracketed parameter guarded by `typeof` emitted an **invalid
module**:

```
Compiling function "__closure_0" failed:
  call[0] expected type externref, found local.get of type f64
```

## Fix

- `compileIdentifierCall`: widen an omittable parameter to externref when
  building `sigParamWasmTypes`, next to the existing binding-pattern carve-out.
  `parameterMayBeOmitted` is exported for this.
- `closures.ts`: OR the two JSDoc spellings instead of treating them as
  alternatives, matching `parameterMayBeOmitted`.

## Measured

- **webpack 15/16 → 16/16** — `test/formatSize.unittest.js` is now 13/13 and
  the package's whole admitted suite passes.
- **lodash 50/62 → 53/62**, **jest 294/356 → 299/356**.
- Sixteen packages re-run three ways (main / +#5288 / +#5290): every other
  number is unchanged, so all nine recovered tests are attributable to this
  change and nothing regressed. hono 213/324, cookie 63740/63740, axios
  108/231, redux 60/82, prettier 51/151, three 17/18, clsx 32/32, stylelint
  108/108, tailwindcss 13/13, jsdom 6/6, styled-components 9/9, uuid, marked
  0/30 and moment 0/10 all held.
- `tests/omittable-param-abi.test.ts`: 4 of its 6 cases fail on the parent
  commit; all 6 pass here. The two that already passed are the guards — the
  `{number=}` named-export spelling, and a supplied argument still taking the
  numeric arms.

## Depends on

Stacked on [#5288](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5288-typeof-param-narrowed-to-f64):
the same `formatSize` shape needs `typeof` to stop narrowing the parameter to
f64 in the first place. The two together are what take webpack to 16/16.
