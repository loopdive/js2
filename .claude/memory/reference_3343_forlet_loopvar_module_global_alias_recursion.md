---
name: reference_3343_forlet_loopvar_module_global_alias_recursion
description: block-scoped for(let i) loop counter compiled to a shared MODULE GLOBAL when a same-named module-level var exists — recursion clobbers the outer counter (root cause of
metadata: 
  node_type: memory
  type: reference
  originSessionId: f3739381-bbf1-4f5c-9036-57a3a6c8eeac
---

Root cause of #3343 (in-Wasm `$Object` recursive-read "runaway"), re-diagnosed
2026-07-17 by opus-3343 via WAT disassembly of the acorn-compiled walker. The
issue's filed hypothesis ("$Object hash/slot aliasing") was **WRONG** — the
reads are faithful; it's a **control-flow codegen bug**.

## Mechanism

A block-scoped `for (let i = 0; i < len; i++)` loop counter is compiled to a
shared **module global** (`$__mod_i`) instead of a per-invocation wasm local,
**whenever a same-named module-level variable exists**. Acorn has a top-level
`i`, so EVERY function's `for (let i)` aliases the one global. In a recursive
walk `w(node[i])` re-enters `w`, whose own loop reuses the same global —
clobbering the outer counter. An inner length-1 array leaves the global at 1,
so the outer loop reads 1 → i++ → 2 → re-reads node[2] forever = the runaway.
Single constructs don't recurse through nested arrays, so ≤15-node walks never
hit it (which is why the bug looked "scale-triggered").

## Root site + fix

`src/codegen/statements/loops.ts` `compileForStatement` bound a for-head decl
to `ctx.moduleGlobals.get(name)` when the name wasn't already a local. `let`/
`const` aren't hoisted into `localMap` (only `var` is), so the `hasLocalShadow`
guard missed block-scoped loop vars and they grabbed the module global. Fix:
skip the module-global path for a `let`/`const` for-head **inside any function**
(only `__module_init` / module-top-level keeps it); `var` unchanged. One-line
predicate.

## Why it matters beyond #3343

This is a **general correctness bug**, not acorn-specific: any recursive (or
even re-entrant) function with a block-scoped loop var whose name collides with
a module-level binding was silently clobbering its counter. So it is
**broad-impact** — likely fixes scattered test262 cases AND could regress if the
module-global path was load-bearing anywhere. Validate on **full CI /
merge_group**, not a scoped sweep (see [[project_broad_impact_validate_full_ci]]
and [[project_standalone_floor_only_on_merge_group]]). It unblocks the #2928
bytecode emitter (E2), whose in-Wasm recursive AST walk is exactly this path.

Lesson: a filed issue's root-cause hypothesis is a lead, not a fact —
deep-tracing (WAT disassembly here) beat the issue's own theory. See
[[feedback_verify_first_beats_architect_spec]].
