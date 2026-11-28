---
id: 7494
title: "Native boundary leaks opaque structs: thrown string/undefined/boolean, and runtime-eval shim return values"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
goal: runtime-eval
related: [7491, 2960, 6980]
---

# #7494: native boundary leaks opaque structs for primitive throws and shim results

Found by the review of PR #7443
([#7491](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7491-runtime-eval-child-native-error-boundary)).
Both defects were already on main before #7443; that PR fixed native *error*
objects only.

## Problem 1: a thrown primitive other than a number or null crosses as a struct

Under the native core, a thrown string, `undefined` or boolean is a boxed Wasm
struct. `moduleExceptionToHost` (`wrapExports`, and since #7443 the
runtime-eval shims) removes the tag envelope and translates native error
structs, but passes every other payload through raw. The JS caller gets an
object with a null prototype and no keys.

Repro on main c3b7be66, through `wrapExports`:

```ts
const r = await compile(`export function test(): number { throw "boom"; }`, { skipSemanticDiagnostics: true });
const imports = buildImports(r.imports, undefined, r.stringPool);
const { instance } = await WebAssembly.instantiate(r.binary, imports);
imports.setExports?.(instance.exports);
wrapExports(instance).test(); // throws an object, Object.getPrototypeOf(e) === null; expected "boom"
```

Same result for `throw undefined;` and `throw true;`.

Through the `new Function` shim (main, and unchanged on the #7443 branch):

| body               | thrown value seen by JS | expected    |
| ------------------ | ----------------------- | ----------- |
| `throw 'boom';`    | null-prototype object   | `"boom"`    |
| `throw undefined;` | null-prototype object   | `undefined` |
| `throw true;`      | null-prototype object   | `true`      |
| `throw null;`      | `null`                  | ok          |
| `throw 5;`         | `5`                     | ok          |

## Problem 2: runtime-eval shim return values are not unmarshalled

`callChildExport` in `src/runtime-eval.ts` returns the child export's raw
result. Native strings, booleans and objects reach JS untranslated.

Repro on main c3b7be66:

| call                                              | result                  | expected       |
| ------------------------------------------------- | ----------------------- | -------------- |
| `createEvalShim()('"hi"', 0)`                     | null-prototype object   | `"hi"`         |
| `createEvalShim()('true', 0)`                     | `1`                     | `true`         |
| `createEvalShim()('({a:1})', 0)`                  | null-prototype object   | `{a: 1}` view  |
| `createEvalShim()('[1,2]', 0)`                    | null-prototype object   | array view     |
| `createNewFunctionShim()('', 'return "hi";')()`   | null-prototype object   | `"hi"`         |
| `createNewFunctionShim()('', 'return {a:1};')()`  | null-prototype object   | object view    |
| numbers, `undefined`, `null`                      | correct                 |                |

## Direction (not a plan)

- `runtime.ts` already has the pieces: `_nativePrimitiveToHost` and
  `_wrapForHost` (`_nativeBoundaryToHost`). Problem 1 is most likely one more
  step in `moduleExceptionToHost`: after the error translation, map a
  primitive box back. That changes `wrapExports` too, so the JS environment's
  output must be checked for every caller, not only for the shims.
- Problem 2 should reuse the same result-side translation `wrapExports`
  applies, not a third copy. The shim has no TS signature metadata, so the
  `dynamic` result path is the one to share.
- When a shim is called from a parent Wasm module, the value must still map
  back to the child's struct (`_hostProxyReverse`), or the parent's `catch` /
  `instanceof` checks change. Add a test for that once the
  `js2wasm:runtime-eval` child instantiation works in the test environment
  (it fails today on main for tests 1164, 1229, 2973 and 3632).

## Acceptance

- [ ] The repros above give the expected values; tests pin each one and fail
      on main.
- [ ] One shared translation helper, no duplicate in `runtime-eval.ts`.
- [ ] Compiled Wasm bytes unchanged on a 100-file sample (runtime-only change).
