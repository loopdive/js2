---
id: 3576
title: "deepEqual.js `format` closure fails Wasm validation — call_ref arity mismatch (need 4, got 3)"
status: ready
sprint: current
created: 2026-07-24
priority: high
feasibility: hard
model: opus
horizon: l
reasoning_effort: high
task_type: bugfix
area: codegen, closures, array-methods, emit
language_feature: compiler-internals
goal: test262-conformance
related: [3378, 2043]
---

# #3576 — `deepEqual.js` `format` closure: `call_ref` arity mismatch (need 4, got 3)

## How this was found

Surfaced by #3378 (PR #3559). #3378 fixed a stale-LOCAL-index binary-emit crash
in `deepEqual.js` (a spurious property-name capture). That crash **masked** a
SECOND, independent defect: once compilation proceeds past binary emit, the
module fails **WebAssembly validation**:

```
CompileError: WebAssembly.compile(): Compiling function #NN:"__closure_6"
failed: not enough arguments on the stack for call (need 4, got 3) @+15349
```

`__closure_6` is `assert.deepEqual.format` (locals `join`,
`getOwnPropertyDescriptor`, `basic`, `usage`, `format`, `contents`, `tag`,
`keys` — format's body). The failing instruction is a `call_ref` whose target
funcref TYPE has **4 params** but only **3** values are on the stack. The
4-param types in play are the array-callback wrapper ABI
(`(ref null <closure_struct>) externref externref externref` — i.e.
`env, value, index, array`), so the most likely shape is a `.map`/`.filter`
callback trampoline calling a callback closure with `env + value + index`
(3) where the callback's funcref type expects `env + value + index + array`
(4) — or the inverse mismatch between how the callback closure's type is built
vs. how it is invoked.

## Proven INDEPENDENT of #3378 (controlled experiment)

This is NOT a regression from #3378 and NOT caused by the `join` property-name
collision. Controlled experiment (2026-07-24), 4 cells:

| capture-fix | harness `join` var | result |
| ----------- | ------------------ | ------ |
| ON  | original | `need 4, got 3` (validation fail) |
| ON  | renamed (`joinFn`, collision removed) | `need 4, got 3` |
| OFF (main) | original | stale-local crash (#3378) — aborts before validation |
| **OFF (main)** | **renamed** | **`need 4, got 3`** |

The bottom-right cell is decisive: with the #3378 fix OFF and the `join`
VARIABLE renamed so the member-name collision cannot occur, the stale-local
crash disappears (nothing to crash on) but the `need 4, got 3` arity error
**still reproduces**. So the arity bug is pre-existing on `main` and was simply
never reached — the stale-local `RangeError` aborted binary emit before
`WebAssembly.compile` could run.

## Repro (current main OR #3559 branch)

```ts
import { compile } from "./src/index.ts";
import { readFileSync } from "fs";
const rd = (f) => readFileSync("test262/harness/" + f, "utf8");
const stub = `function assert(x, m){ if(!x) throw new Error(m); }\nassert.x=1;\n`;
const src = `export function test() {\n${stub + rd("deepEqual.js")}\nconsole.log("x");\n}`;
const r = await compile(src, { target: "gc", fileName: "test.ts",
  skipSemanticDiagnostics: true } as any);
// r.success === true  (compiler emits a binary)
await WebAssembly.compile(r.binary); // throws: need 4, got 3 at __closure_6
```

On `main` the same input throws the #3378 stale-local RangeError first; on the
#3559 branch (or after #3559 merges) it reaches the arity failure. The full
real-harness combo (`assert.js + sta.js + propertyHelper.js + compareArray.js +
deepEqual.js` + a trivial `Object.entries` body) fails identically at
`__closure_28`.

## Why `feasibility: hard` — resists minimization

The arity mismatch did NOT reproduce in any of 6 targeted minimal snippets
(plain `.map`, nested-fn `.map`, tagged-template-basic, a mapper-in-`.map`
pattern, `.map` with a 3-arg callback, `filter+map` over an object) NOR in a
faithful `format → lazyResult → acceptMappers → toString → stringFromTemplate`
skeleton (with and without outer-frame padding) — all compile to valid
binaries. So the trigger needs most of `format`'s real structure (the
tagged-template `lazyResult`/`lazyString` machinery returning a mapper-accepting
function, the `subs.map((sub,i) => (mappers[i]||String)(sub))` mapper
application, the `.filter(...).map(...)` over `Reflect.ownKeys`, the
TDZ-flagged `usage`/`format` captures, etc.). Localizing needs a WAT/`call_ref`
trace of the specific failing site in `format` (the byte offset is `@+15349`),
then determining whether the arity is wrong on the callback CONSTRUCTION side
(funcref type built with too many params) or the INVOCATION side (trampoline
pushing too few args). Likely lives in `src/codegen/array-methods.ts`
(callback-wrapper / trampoline ABI) and/or `src/codegen/closures/*`
(funcref-as-closure wrapper types).

## Acceptance criteria

- The `stub-assert + deepEqual.js` repro compiles to a binary that PASSES
  `WebAssembly.compile` / `WebAssembly.validate` (no `need 4, got 3`).
- The full real-harness combo (`assert.js + sta.js + propertyHelper.js +
  compareArray.js + deepEqual.js` + trivial body) validates.
- Together with #3378 this closes deepEqual.js's AC (`deepEqual.js` → valid
  binary); update #3378 accordingly.
- No regression in the JS-host test262 pass rate; validate on the full
  equivalence suite (broad closure/array-method codegen surface).
