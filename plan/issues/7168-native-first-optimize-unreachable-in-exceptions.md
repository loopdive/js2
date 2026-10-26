---
id: 7168
title: "Native-first exception code traps `unreachable` after wasm-opt: Binaryen types a try_table `(result (ref extern))`, which V8 12.4 mis-executes"
status: done
sprint: current
created: 2026-10-26
updated: 2026-10-26
completed: 2026-10-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: correctness
parent: 6979
related: [6899, 2787]
---

# #7168 — Native-first exception code traps `unreachable` after wasm-opt

## Problem

Found while unblocking PR #6899 (its `Differential test` optimize gate,
`scripts/diff-test-optimize-gate.ts`). On the default native-first gc profile
the corpus programs `control/07-try-catch`, `builtins/10-error-classes` and
`builtins/09-async-await` trap `RuntimeError: unreachable` inside
`__module_init` when compiled with `optimize: true` (wasm-opt `-O3`), and run
correctly without it. Reproduces on `origin/main` on Node 22 — `--target
standalone` and `--target wasi` too. Main's diff harness pinned
`semanticProviders: "host-assisted"`, so CI never saw it.

Smallest reproducer (traps only optimized, every lane):

```js
try { throw new Error("boom"); } catch (e) { console.log("caught"); }
```

## Root cause

Two pieces combine:

1. **Binaryen `remove-unused-brs`** rewrites a `throw $tag X` that an
   enclosing `try_table (catch $tag $b)` in the same function catches into
   `br $b X`. When the try_table is the last child of `$b`, a later
   `remove-unused-brs` round (after `dce` removes the now-dead `br` that skipped
   the catch body) drops the branch so `X` falls through, and refinalize types
   the try_table with X's refined type: `try_table (result (ref extern))`.
   This is valid Wasm and semantically equal. Isolated in a 15-line WAT
   (`--dce --remove-unused-brs` alone reproduces it); the throw only becomes
   local after inlining (`__new_Error` returns `(ref extern)`), which is why
   `inlining-optimizing` is the first pass of `-O3` that shows it.
2. **V8 12.4 (Node 22, the `engines` floor)** executes a `try_table` whose
   block type is not a single-byte value type — `(ref $T)`, `(ref null $T)`,
   `(ref extern)`, `(ref any)`, or a type-index (multi-value) block type — as
   `unreachable` on entry. `i32`, `externref`, `anyref` and empty block types
   run fine. Confirmed with hand-built modules, no compiler involved. Codegen
   already avoids the shape (#4620 `named-this-call.ts`, #5141
   `generators-native.ts`: empty try_tables, values parked in locals), but
   wasm-opt re-creates it.

So the compiler emits correct, engine-safe Wasm, and wasm-opt turns it into
valid Wasm that Node 22 mis-executes. Not checked on Node 24/25 here: this
container cannot run downloaded Node binaries.

## Fix

`src/optimize-try-table-shape.ts` + `src/optimize.ts`: after a successful
wasm-opt run, rewrite each unsafe result-typed try_table in Binaryen's printed
text (names, not depths, so no branch retargeting):

```
(try_table $l? (result R) CATCHES BODY...)
→ (block $__js2_ttN (result R)
    (try_table CATCHES (br $__js2_ttN (block $l? (result R) BODY...)))
    (unreachable))
```

The CLI run appends `--print` as its last pass (one process; the text is the
final module). Only when the text has an unsafe try_table is it re-assembled
with no passes, and any custom sections the text dropped are re-appended. A
module without one keeps its optimized bytes exactly. If re-assembly fails, the
unoptimized binary is shipped with a warning. The in-process binaryen-module
fallback applies the same rewrite through `emitText`/`parseText`.

No codegen change, so unoptimized output is byte-identical in every lane.
Optimized output changes only for modules that contained the unsafe shape.

Measured 2026-10-26 (Node 22.22.0, Binaryen 132), `-O3`, on 20 corpus
programs (17 evenly spaced plus the three above) × 4 lanes, base vs. fix:

| lane | identical | changed |
| --- | --- | --- |
| gc host-assisted | 20/20 | — |
| gc native-first | 17/20 | the 3 exception programs, +40 / +42 / +166 B |
| standalone | 17/20 | same 3, +32 / +34 / +154 B |
| wasi | 17/20 | same 3, +28 / +30 / +166 B |

Before the fix all 9 changed binaries trapped. Wall time for the 80
optimized compiles went from 146 s to 168 s: `--print` costs about 5 % per
run, and the 9 re-assemblies account for the rest.

Optimize gate (`scripts/diff-test-optimize-gate.ts`, run with the
host-assisted pin removed locally as PR #6899 does): 0 regressions, 114/120
match in both lanes. The six non-matching programs fail the same way
unoptimized and are out of scope here: `builtins/07-promise-basic`,
`08-promise-chain`, `09-async-await` and `object/06-delete` mismatch,
`builtins/14-spread-args` has a runtime error, and
`generators/04-sent-values` fails to compile.

probe/test reference: `tests/issue-7168-optimize-exceptions.test.ts` (the rewriter, then the two minimised programs and the three corpus programs with `-O3`, on gc native-first, standalone and wasi; each must match its unoptimized run).
