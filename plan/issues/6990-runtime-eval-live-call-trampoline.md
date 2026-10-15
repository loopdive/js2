---
id: 6990
title: "Runtime-eval modules inline a live-binding read + dynamic dispatch at every top-level call (Octane mandreel: ~1.2M locals in one function)"
status: done
sprint: current
created: 2026-10-14
completed: 2026-10-14
assignee: ttraenkler/session-d
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: runtime-eval
language_feature: eval, function-calls
goal: standalone-gap
related: [6988, 6989, 2928, 4307]
import-cycles-allow:
  - largestSccSize: 707 # 2026-10-14 (#6990): runtime-eval-live-call.ts joins the codegen SCC — it is called from call-identifier/runtime-eval-provider/runtime-eval-callable and itself uses global-environment, object-runtime and shared coercion, exactly like its runtime-eval siblings already in the SCC
loc-budget-allow:
  # 2026-10-14: +20 — the eligibility hand-off at the live-binding site, the
  # inline-gate exclusion and the post-compile site recorder around
  # `compileBoundIdentifierCall`; all logic lives in runtime-eval-live-call.ts.
  - src/codegen/expressions/call-identifier.ts
---

# #6990 — out-of-line live-binding calls in runtime-eval modules

## Problem

A standalone module that links the runtime-eval provider treats every script
function binding as live, because eval may rebind it
(`eval("function f(){…}")`). Every call of a top-level function was therefore
lowered inline as:

1. a global-lexical sidecar lookup;
2. a module-binding read;
3. a value-unwrap ladder;
4. a dynamic `__apply_closure` dispatch.

That is ~375 WAT lines and ~8 fresh locals per call site. Octane mandreel has
one `eval(next)` (in `Mandreel_flushTimeouts`, never actually executed), and
its `global_init` makes ~150k calls. That function needed ~1.2M locals (V8
caps a function at 50k), and the compile ran out of time and memory first
(#6988).

## Fix

An eligible call is compiled as an ordinary direct call. Eligible means: an
unshadowed call of an ordinary top-level function declaration, not spread,
that is live *only* because of eval (`evalOnlyLiveFuncBindings`); Annex B and
syntactically reassigned bindings keep the inline lowering. At finalize, its
`call` is retargeted to a per-callee trampoline with the callee's final
signature:

```
if (__runtime_eval_ever_entered) <live read + __apply_closure, boxed args>
else                             call $f(params)
```

- `__runtime_eval_ever_entered` is set at every provider entry
  (`emitRuntimeEvalGlobalBindingSeed`). Before it is set, no evaluated code
  has run, so the binding still holds the declaration and the direct call is
  exact.
- Retargeting happens at finalize because the callee's Wasm signature can
  still change during compilation. Only calls still aimed at the callee's
  current index are moved.
- Call-site inlining is disabled for these sites, since an inlined body
  would ignore a rebinding.
- If the plain path emits no direct call, the inline live lowering is
  restored.

Module: `src/codegen/expressions/runtime-eval-live-call.ts`.

## Measured

- **Probe** (3 calls of `emit` in `g`, module contains an `eval`): `g` went
  from 480 to 137 WAT lines and from 20 to 4 locals.
- **Semantics** (`tests/issue-6990-runtime-eval-live-call-trampoline.test.ts`):
  - a direct call before any eval;
  - indirect- and direct-eval redefinition observed by later calls;
  - assignment from evaluated code observed;
  - void and mixed-type signatures round-trip.
- **Eval-related suites** (58 files): the same 32 failures in 11 files with
  and without the change, so they are pre-existing in this environment and
  the change adds none.
