---
id: 4125
title: "MISCOMPILE: three sibling escape positions still classify keep-static — `[new K()]`, `{ v: new K() }` and `return new K()` all lose the prototype chain (one returns null, one traps)"
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
language_feature: prototype chain, object representation
goal: core-semantics
related: [4123, 2660, 1888]
origin: "residuals left undone by #4123's fix, independently reproduced 2026-08-03"
---

# #4125 — the escape gate's remaining keep-static positions

## Severity

**Silent wrong answers, plus one trap.** Same class as #4123 and the same root
cause; #4123 fixed the *call-argument* position only.

## The defect

#4123 fixed one arm of the #2660 fnctor escape gate: a `new F()` passed
**inline as a call argument** to an `any` parameter was classified `keep-static`,
so it lowered to a bespoke `$__fnctor_K` struct that carries own fields but
**no prototype chain**. `__extern_get`'s own+prototype walk then finds nothing,
the method resolves to `undefined`, and the call yields `null`.

Three sibling escape positions still classify `keep-static` and miscompile
identically. All reproduced on the #4123 fix branch (i.e. these are *not* fixed
by it):

```js
function K(){} K.prototype.k = function(){ return 3; };
function f(o){ return o.k(); }
```

| escape position          | program                                                | result                              | JS |
| ------------------------ | ------------------------------------------------------ | ----------------------------------- | -- |
| array-literal element    | `let a = [new K()]; return f(a[0]);`                   | **null**                            | 3  |
| object-literal property  | `let t = { v: new K() }; return f(t.v);`               | **null**                            | 3  |
| return-escape            | `function g(){ return new K(); } return f(g());`       | **traps** — null pointer dereference | 3  |

Controls that pass on the same build: a locally-bound receiver
(`let o = new K(); o.k()`), and #4123's now-fixed call-argument position.

## Why they were left out of #4123

`classifyUse` explicitly returns `"neutral"` for `ReturnStatement` (marked "S1
conservative"), and has no rule at all for aggregate literals. Closing these
means either extending the single-level analysis to those positions, or
inverting the gate's conservative default.

**The second option is the risky one and should not be taken casually**: the
gate's conservatism is what keeps reads on `struct.get` rather than
`__extern_get`, and inverting it risks the #1888 `__extern_get` perf floor.
#4123 deliberately stayed a bug fix rather than becoming a wide representation
change unmeasured against the standalone floor guard — that judgement still
stands, and whoever takes this issue owns the floor measurement.

## Acceptance criteria

- [ ] All three positions produce the JS answer, including the return-escape
      case that currently traps.
- [ ] An equivalence test per position, alongside #4123's, including the
      **direct `return o.k()` form** for each — the one no numeric coercion
      hides.
- [ ] The standalone floor / net guards (#1888, #1897, #2097) measured before
      and after, since the plausible fix widens `reconstruct` classification.
- [ ] No equivalence-suite regressions, confirmed by comparing failing **sets**
      from a full-capture run, not counts.

## Reproduce

```js
import { compile } from "./src/index.ts";
const K = `function K(){} K.prototype.k = function(){ return 3; };`;
const src = `${K}
function f(o){ return o.k(); }
export function main(){ let a = [new K()]; return f(a[0]); }`;
const res = await compile(src, { fileName: "t.mjs", skipSemanticDiagnostics: true, target: "standalone" });
const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(res.binary), {});
console.log(exports.main()); // null — JS says 3
```

`JS2WASM_LOG_FNCTOR_GATE=1` prints the gate's verdict (`keep-static` vs
`reconstruct`) and is the fastest way to confirm a shape belongs to this issue.
