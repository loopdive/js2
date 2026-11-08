---
id: 7336
title: "WASI: static eval splices bailed to an unlinkable provider after joining the native regime"
status: done
completed: 2026-11-08
sprint: current
created: 2026-11-08
updated: 2026-11-08
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: architecture
related: [6979, 4195, 6774, 7106, 2928]
assignee: "ttraenkler/opus-s7c-eval-remerge"
---

# #7336 — WASI static eval inlining after the #6979 S7-c regime flip

## Problem

#6979 S7-c moved WASI into the native semantic regime and folded the
`ctx.standalone &&` guards in `tryStaticEvalInline`
(`src/codegen/expressions/eval-inline.ts`) away as always-true. Those guards
were not regime questions. Each one marked a **provider bail**: "hand this
constant eval body to the runtime-eval provider, which owns
EvalDeclarationInstantiation". WASI cannot link that provider
(`runtimeEvalProviderLinkable`), so on WASI each bail turned a working
compile-time splice into the #4195 refusal (a catchable TypeError at run time).

A second regression has the same root. `tryCompileStandaloneEvalSpread`
(`eval-spread-args.ts`) lost its `ctx.standalone` gate. On WASI,
`emitStandaloneGlobalEvalRuntime` declines, and the fallback leaves the source
string on the stack. `eval(...["1+5"])` therefore returned the string `"1+5"`
instead of evaluating it or refusing.

Measured on WASI under node:wasi with the eval-probe corpus (19 programs):

| program | JS | upstream/main 7133f25946 | S7-c before fix (f3450acfb9) | after fix |
| --- | --- | --- | --- | --- |
| `eval("var q = 5"); q` | 5 | 5 | refusal (throws) | 5 |
| `eval("function h() { return 9; }"); h()` | 9 | 9 | refusal (throws) | 9 |
| `"use strict"; eval("let z = 4; z * 2")` | 8 | 8 | refusal (throws) | 8 |
| `eval(...["1+5"])` | 6 | refusal (throws) | `"1+5"` (wrong value) | refusal (throws) |

## Fix

- `tryStaticEvalInline`: the five provider bails apply only when
  `runtimeEvalProviderLinkable(ctx)` is true. They cover strict scoped
  declarations, Annex B block functions with a caller collision, sloppy global
  var/function declarations, a function-scope top-level function declaration,
  and an eval-as-value reference. WASI keeps the static splice it had before
  S7-c. gc and standalone still bail to the provider exactly as before. Those
  builds link the provider, which models EvalDeclarationInstantiation fully, so
  their outputs are byte-identical.
- `tryCompileStandaloneEvalSpread`: declines when the provider is not
  linkable. A WASI `eval(...args)` then reaches the call site's #4195 refusal,
  as on main, with the same warning. Folding to 6 was not the natural outcome:
  the spread source is a runtime array, not a static string, so no static
  splice applies.
- `tests/issue-7106-runtime-eval-unit-boundary.test.ts`: the WASI row pinned
  main's whole-program `(uncached-push)` withdrawal. Under the regime the
  global push publishes cached function values on WASI too, and the selection
  is now identical to standalone. The row is re-pinned to that outcome with a
  `(#6979 S7-c)` note.

## Measurement

The 19-program eval corpus (`.tmp/eval-probe.mts`) was compiled on
gc/standalone/wasi against f3450acfb9:

- gc and standalone: 19/19 byte-identical.
- wasi: 4 programs changed, the four rows above. The other 15 are
  byte-identical. Each changed row now gives main's answer on node:wasi, with
  main's diagnostics.
