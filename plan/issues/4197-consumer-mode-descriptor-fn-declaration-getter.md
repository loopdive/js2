---
id: 4197
title: "runtime-eval consumer mode: a function DECLARATION used as a descriptor get/set is a broken callable — accessor reads answer null/0 on EVERY carrier; caps ~119 propertyHelper accessor files (standalone)"
status: ready
sprint: current
created: 2026-08-07
updated: 2026-08-07
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, standalone, runtime-eval
language_feature: property-descriptors, functions
goal: runtime-eval
related: [4159, 2928, 4180, 4176, 3251]
origin: "W15 descriptor-family residue analysis, 2026-08-07 — probe chain .tmp/p13..p21 in worktree agent-a29d9657414900b64"
---

# #4197 — consumer-mode function-declaration getters are broken callables

## Summary (all measured, standalone, current main + #4159)

In **runtime-eval consumer mode** (`ctx.runtimeEvalGlobalFunctionBindings` — the
mode any module enters when it captures a builtin, e.g.
`var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);`),
a **function declaration** referenced as a descriptor `get`/`set` produces a
broken callable:

```js
var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
function getFunc() { return 12; }
getFunc();                                              // 12  ✓ direct call fine
var b = [10, 20, 30];
Object.defineProperty(b, "1", { get: getFunc });        // define lands (gOPD sees it)
b[1];                                                   // null ❌ (12 expected)
var o = {};
Object.defineProperty(o, "p", { get: getFunc });
o.p;                                                    // 0    ❌ (12 expected) — PLAIN OBJECT too
```

Controls in the same poisoned module (all pass): a **data** define reads back
(77), a **function-expression** getter works (`var g = function(){return 99}` →
99), and the define/read machinery itself is healthy — the identical program
without the bind-capture line passes everywhere.

## Why this is the single largest descriptor-family lever

test262's `harness/propertyHelper.js` opens with primordial captures
(`Function.prototype.call.bind(Object.prototype.hasOwnProperty)` et al.), so
**every `includes: [propertyHelper.js]` test compiles in consumer mode**, and
the deprecated-helper tests spell their getters as function declarations
(`function getFunc() {...}` + `{ get: getFunc }` — the `15.2.3.6-4-2xx`
pattern). Measured against the post-#4155+#4159 residue of the 558-file
descriptor lever: **373 residue → 172 are propertyHelper-including (all
consumer-mode) → 119 of those carry accessor descriptors.** This is the
mechanism W5's census surfaced as the `accessed !== true` / `Expected obj[N]
... actually null` / `to be writable, but was not` buckets.

## Evidence chain (probes preserved in worktree `agent-a29d9657414900b64/.tmp/`)

- `p13.js` — minimal real-propertyHelper repro (`verifyEqualTo` reads null).
- `p14.js` — the reader is NOT the harness function: the author's own untyped
  helper in the same module also reads null once propertyHelper is included.
- `p15/p16/p17/p18.js` — bisection: `var __defineProperty = Object.defineProperty`
  and `var __gOPD = Object.getOwnPropertyDescriptor` are harmless; the
  `Function.prototype.call.bind(...)` capture alone flips the module
  (p18 22.7 MB WAT vs p15 1.1 MB — the consumer machinery).
- `p19.js` — with the capture: `gOPD=present` (define stored), `direct=null`,
  `helper=null` (both read lanes miss), bound capture itself works.
- WAT analysis (`.tmp/w15-callmap.py` on `.tmp/p18.wat`): `__module_init` calls
  `__defineProperty_accessor` (the generic native — receiver widened in
  consumer mode); its `vecOverlayArm` delegation and the `__extern_get_idx`
  overlay prologue (`global.get 1174` matching `__vec_dp_accessor`'s
  `global.set 1174`) are BOTH present and consistent — the store/read plumbing
  is correct, which localises the defect to the **callable value** captured in
  the descriptor.
- `p20.js` / `p21.js` — the discriminating pair: function-expression getter
  works, function-declaration getter fails, on array AND plain-object
  receivers.

## Root-cause hypothesis (verified to the boundary, not past it)

Consumer mode compiles global function declarations as **mutable global
function bindings** (`runtimeEvalGlobalFunctionBindings` — see
`src/codegen/context/types.ts` ~L1986). Reading such a declaration as a VALUE
inside a descriptor literal captures something that `__call_accessor_get` /
`__call_accessor_set` cannot invoke (result: null / type-default 0). The
adjacent family is already on record: `dereferencing a null pointer in
__fnctor_Func_new()` for `<Builtin>.bind(null)` (#4196 census), and L2's
`## RESIDUAL BLOCKER` note in
`plan/issues/3251-array-descriptor-overlay-substrate.md` (consumer-mode
mixed-type-ternary miscompile capping `verifyProperty`). Lane A (runtime-eval
goal) owns this seam per `plan/method/lane-partition.md`.

## Acceptance criteria

- `p21.js` shape passes: function-declaration getter invoked on array and
  plain-object receivers in a consumer-mode module.
- The `15.2.3.6-4-2xx` accessor family moves on the 558-file descriptor lever
  (expect on the order of +50..119; re-census, don't assume).
- Non-consumer modules byte-identical.
- Secondary (same census, smaller): consumer-mode boolean results surface as
  `1`/`0` instead of `true`/`false` (`captureWorks=1` in p19), which fails
  `assert.sameValue(x, true)` — verify whether fixing the callable also fixes
  this or file separately.
