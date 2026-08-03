---
id: 4126
title: "MISCOMPILE: an OWN function-valued field called through a parameter returns null, even though the property is present — dynamic call bridge, not the escape gate"
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
language_feature: dynamic dispatch, closures
goal: core-semantics
related: [4123, 4125]
origin: "residual found while fixing #4123, independently reproduced 2026-08-03"
---

# #4126 — own function-valued field through a parameter returns null

## Severity

**Silent wrong answer.** Distinct root cause from #4123 / #4125 — do not fold
this into them.

## The defect

```js
function K(){ this.k = function(){ return 3; }; }
function f(o){ return o.k(); }
export function main(){ return f(new K()); }   // → null, JS says 3
```

Reproduced on the **#4123 fix branch**, so it is not the escape-gate
classification bug: #4123's fix flips this site to `reconstruct` and it *still*
returns `null`.

What rules the escape gate out as the cause:

- the property is genuinely **present** — `o.k === undefined` is `false`;
- the **same call with a direct receiver works**:
  `let o = new K(); o.k()` → `3`;
- it is an **own** field assigned in the constructor, not a prototype
  property, so no prototype walk is involved at all.

So the failure is in the dynamic call bridge — `__extern_method_call` /
`__apply_closure` — mishandling a **closure-valued own field** reached through
an opaque (parameter) receiver. The property read succeeds and the *call* is
what produces nothing.

## Why this matters

`function K(){ this.method = function(){…} }` is the pre-class idiom for
per-instance methods, and it is pervasive in older npm packages — the exact
corpus the standalone `runtime-dynamic` lanes compile. A silent `null` here is
indistinguishable from a missing method at the call site.

## Acceptance criteria

- [ ] `f(new K())` returns `3` for the program above.
- [ ] Equivalence tests covering: own function field via parameter receiver, via
      a locally-bound receiver (currently passing — keep it passing), and with
      arguments and a return value that is not a number (so no numeric coercion
      can mask the result).
- [ ] Confirm whether the same bridge mishandles an own function field reached
      through other opaque receivers (array element, object property) once
      #4125 lands — they may share this second defect underneath.
- [ ] No equivalence-suite regressions, compared as failing **sets** from a
      full-capture run.

## Reproduce

```js
import { compile } from "./src/index.ts";
const src = `
function K(){ this.k = function(){ return 3; }; }
function f(o){ return o.k(); }
export function main(){ return f(new K()); }`;
const res = await compile(src, { fileName: "t.mjs", skipSemanticDiagnostics: true, target: "standalone" });
const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(res.binary), {});
console.log(exports.main()); // null — JS says 3
```
