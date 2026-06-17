---
id: 2176
title: "template-literal / concat of an ambient-shadowed top-level const (`name`, `length`) interpolates as undefined"
status: done
sprint: 62
created: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/agent-a8fb202e
priority: high
feasibility: medium
task_type: bug
area: codegen
language_feature: template-literals
goal: correctness
related: [2005, 2006, 1931]
---

## Problem

On `main`, a top-level `const`/`let`/`var` whose name collides with an ambient
`lib.dom.d.ts` global (notably `name`, also `length`, `status`, `origin`, …)
produced the **wrong value** when used as a *value operand* — template
interpolation, `+` concatenation, or even a copy-init:

```js
const name = "world";
const n = 42;
console.log(`hello ${name}, n=${n}`);   // → "hello undefined, n=42"  (should be "hello world, n=42")
console.log("hi " + name);              // → "hi undefined"
const y = name; console.log(y);         // → "0"   (y was registered as an i32 global)
const length = 5; console.log(`L=${length}`); // → "L=NaN"
```

Surfaced by the differential corpus fixture
`tests/differential/corpus/string/13-template-literal.js`, which produced
`hello undefined, n=42` vs. V8's `hello world, n=42`. Masked from CI only
because the diff-test baseline is 26 days stale (chore #51).

It is NOT universal: `console.log(name)` (value passed straight to the host
import, no type-driven coercion) prints `world` correctly, and the same code
inside a function works (function-local `name` is never ambient-shadowed). Only
**module top-level** reads of a name that collides with an ambient lib global,
**as an operand**, break — which is why test262 (heavy on template literals)
never cratered.

## Root cause

js2wasm analyzes a top-level program as a **script** (no `import`/`export` ⇒
not an ES module). In script mode a top-level `const name = "world"` does NOT
shadow the writable global `var name: string` declared in `lib.dom.d.ts` —
both live in the global scope and TypeScript resolves a bare reference to the
**ambient** symbol. So:

- `getTypeAtLocation` on the `name` operand returns the ambient type (`void`
  for `name`, `number` for `length`), not `string`/`5`.
- The template-span stringifier (`compileTemplateExpression` /
  `compileNativeTemplateExpression` in `src/codegen/string-ops.ts`) sees
  `spanTsType.flags & Void` set, hits the undefined/void branch
  (`drop` the real value, push the literal `"undefined"`), → `undefined`.
- The module-global declared-type computation (`src/codegen/declarations.ts`)
  types `const y = name` as `void` → registers `$__mod_y` as an **i32** global,
  so the externref string round-trips to `0`.

The runtime *value* under `$__mod_name` is stored correctly; only the **type**
is poisoned, which is why `console.log(name)` survives but every type-driven
coercion does not.

## Fix

`resolveIdentifierType(ctx, id)` in `src/codegen/index.ts`: when a bare
identifier binds **purely** to ambient lib (`.d.ts`) declarations but a
same-name **user** binding shadows it (found by walking enclosing AST scopes —
`getSymbolsInScope` only surfaces the ambient symbol in script mode), re-derive
the type from the user declaration. Genuine ambient reads (no user binding) are
unchanged.

Routed through:
- `src/codegen/declarations.ts` — `moduleVarDeclType()` for the module-global
  declared type (covers `const y = name`).
- `src/codegen/string-ops.ts` — `valueExprTsType()` applied to every
  stringification operand-type lookup in the JS-host and native template paths
  and the binary `+` concat path (covers `` `${name}` `` and `"x" + name`).

No host imports added; no module-detection / strict-mode change (which would
risk top-level-`this` / redeclaration regressions across test262). Behavior for
non-colliding names, genuine `undefined`/`null` spans, numbers, and booleans is
byte-identical.

## Test Results

`tests/issue-2176-template-literal-interp.test.ts` — 13 cases, all pass.
Confirmed FAILING (6/13) on `main` before the fix (the colliding-name cases),
passing after. Neighbors that must not change (real `undefined`/`null` spans,
non-colliding name, number/boolean spans, function-local name) pass on both.

- `string/13-template-literal.js` differential fixture → **match** (`hello
  world, n=42`).
- Existing suites green: `issue-2005`, `issue-2006`, `issue-1988`, `issue-2059`,
  `template-literals-extended`, `template-literal-type-coercion`.
- `npx tsc --noEmit` clean.

Standalone `--target wasi` shares the same `valueExprTsType` routing in the
native template path; the in-process `nativeStrings`-without-WASI harness can't
instantiate (`__str_to_extern` host bridge missing — a pre-existing limitation
unrelated to this fix, reproduces with a non-colliding name on clean `main`).
