---
id: 4123
title: "MISCOMPILE: a prototype method called on a PARAMETER receiver silently returns null/0 in standalone — `f(o){ return o.k(); }` gives null where JS gives 3"
status: ready
sprint: current
created: 2026-08-03
updated: 2026-08-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: prototype methods, receiver flow
goal: core-semantics
related: [3685, 3683, 4122]
origin: "found incidentally while building a guard test for #4122, 2026-08-03"
---

# #4123 — prototype method on a parameter receiver returns null

## Severity

**Silent wrong answer.** No trap, no compile error, no diagnostic — the program
runs and produces a different value than JavaScript specifies. This is the worst
failure class we have, and the shape is ordinary: pass an object to a function,
call one of its prototype methods.

Reproduced on **unmodified `upstream/main` (`d369562d7`)**, verified by stashing
all local changes and re-running.

## Reproduction

```js
function K() {}
K.prototype.k = function () { return 3; };

function f(o) { return o.k(); }
export function main() { return f(new K()); }
```

Compiled with `{ target: "standalone" }`:

| program                                              | js2      | JS  |
| ---------------------------------------------------- | -------- | --- |
| `function f(o){ return o.k(); }`                     | **null** | 3   |
| `function f(o){ let n = o.k(); return n; }`           | **null** | 3   |
| `function f(o){ let n = 1; n = o.k(); return n; }`    | **0**    | 3   |
| `function f(o){ let n = 1; n = n + o.k(); return n; }`| **1**    | 4   |
| `function f(o){ return 1 + o.k(); }`                  | **1**    | 4   |
| `function f(){ let p = new K(); … p.k() … }`          | 4        | 4   |

The **last row is the control**: the identical call with a receiver bound by a
local `new K()` produces the correct answer. So the defect is specific to the
receiver arriving as a **parameter**, not to the method, the prototype, or the
export boundary (which the control crosses too).

The `null` → `0` → `1` progression is consistent with the call yielding
*nothing usable* and the consumer coercing it: `null` returned directly, `0`
when stored into a numeric slot, and `1` when added to `1`.

## Why this matters beyond the repro

`f(obj)` where `obj` carries prototype methods is the shape of nearly every
library API — every npm package that takes an options object, a parser, a
stream, a node. The standalone `runtime-dynamic` npm lanes are exactly this
shape, so this may be depressing correctness (and masking perf) far more
broadly than one benchmark.

It should be checked against the npm-compat correctness harness immediately:
a package whose result is silently wrong will still "pass" any check that only
compares against a checksum computed the same wrong way.

## Where to look

`#3685`'s `analyzeReceiverFlow` classifies a receiver by `source`:
`"new-binding" | "call-return" | "parameter" | "this"`. The control (local
`new K()`) is `new-binding` and works; the failing case is `parameter`. So the
`parameter` arm of receiver-flow → dispatch is the first place to look — either
the verdict is not reaching the call site, or the dispatch it selects is reading
the wrong carrier for a parameter-held instance.

Note `#4122` (in flight) documents that `staticJsTypeOf` answers `"mixed"` for
these dynamically-dispatched calls, which is consistent with the parameter
receiver not being resolved anywhere in this path.

## Acceptance criteria

- [ ] All six rows in the table above produce the JS answer.
- [ ] An equivalence test covering the parameter-receiver shape, including the
      `null`-returning direct form, which is the one no numeric coercion hides.
- [ ] A check of whether any npm-compat correctness result changes once fixed —
      if a package's expected checksum was computed from js2 output rather than
      from node, it would have locked in the wrong answer.
- [ ] Confirm whether the JS-host lane has the same defect or only standalone.

## Reproduce

```js
import { compile } from "./src/index.ts";
const src = `
function K(){} K.prototype.k=function(){return 3;};
function f(o){ return o.k(); }
export function main(){ return f(new K()); }`;
const res = await compile(src, { fileName: "t.mjs", skipSemanticDiagnostics: true, target: "standalone" });
const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(res.binary), {});
console.log(exports.main()); // null — JS says 3
```
