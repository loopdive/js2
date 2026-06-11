---
id: 2045
title: "linear Uint8Array (WASI): silent-corruption holes — name-keyed buffer registry, no bounds checks — plus escape-analysis demotion gaps (#1886 follow-up)"
status: ready
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, wasi
language_feature: typed-arrays, linear-memory
goal: standalone-mode
related: [1886, 817]
origin: "2026-06-10 sprint-61 code review of merged PR #1288 (#1886 Slice C): two pre-existing Slice-B silent-corruption routes were materially widened to function parameters, and the new interprocedural escape analysis has two fail-closed demotion gaps that break previously-valid WASI programs."
---

# #2045 — Linear Uint8Array soundness holes (#1886 follow-up)

## Problem

The #1886 Slice-C signature rewrite (params become `(ptr, len)` pairs) is
well-engineered on the happy path, but review of merged PR #1288 found two
**silent-corruption** routes and two **fail-closed regression** gaps. The
corruption routes must be fixed before the linear path widens further
(Slice D subarray views would compound the aliasing surface).

### A. Silent corruption (fix first)

1. **Name-keyed, scope-blind buffer registry** —
   `src/codegen/linear-uint8-signatures.ts:113`: `fctx.linearU8Buffers` is
   keyed by identifier **text**, with no block-scope save/restore (contrast
   `localMap`'s #817 shadow handling). With Slice C registering *params*,
   shadowing is now easy: a linear param `buf` plus an inner-block
   `const buf = <GC Uint8Array>` makes
   `tryEmitLinearU8ElementGet/Set/Length`
   (`src/codegen/linear-uint8-codegen.ts:148/184/224`) address the wrong
   buffer in **both** shadowing directions — silent wrong reads/writes.
   Fix: key by symbol (or scope-push/pop the registry like `localMap`).
2. **No bounds checks on linear element access** —
   `linear-uint8-codegen.ts:151-156, 195-207`: `b[i]` / `b[i] = v` lower to
   raw `i32.load8_u`/`i32.store8` at `ptr + trunc(i)`. The GC path
   bounds-checks and traps; the linear path silently reads/writes arbitrary
   linear memory (iovec scratch at 0..11, string-literal data). With Slice C,
   an OOB index inside a helper corrupts the **caller's** memory. Fix: emit
   `i32.ge_u len → trap/throw RangeError-equivalent` matching GC-path
   semantics; measure perf, consider eliding only when the index is provably
   in-range.

### B. Escape-analysis demotion gaps (fail-closed, but regress valid programs)

3. **Untracked arguments at rewritten call sites** —
   `src/codegen/linear-uint8-analysis.ts:207` +
   `src/codegen/expressions/calls.ts:8955-8965`: a helper param stays
   linear-safe even when a call site passes an untracked `Uint8Array`
   (function result, `new Uint8Array(arrayBuffer)` view, conditional
   `f(c ? a : b)`). Codegen then hits the
   "linear Uint8Array helper argument is not backed by linear memory"
   `reportError` — previously-compiling valid WASI programs now fail. Fix:
   demote param safety when any call-site arg is not a provably
   linear-backed identifier.
4. **Function-value escapes of rewritten helpers** — only direct-identifier
   calls (`calls.ts:8886`) thread `(ptr,len)`; `const g = fill`,
   `fill.call(...)`, `arr.map(fill)` lower against the source-level GC
   signature → mismatch. Fix: demote a function's `linearParams` when its
   name appears in any non-direct-call position.

### C. Smaller correctness items

5. Loop-arena rewind vs `var b = new Uint8Array(n)` declared in a loop but
   read **after** it (`loops.ts:70/773/1024` resets) — stale/corrupt reads.
6. Unconditional `while`-loop restructure on **all targets**
   (`src/codegen/statements/loops.ts:59-140`) — semantically equivalent
   (verified) but contradicts the PR's "non-WASI byte-identical" claim; gate
   it on `ctx.wasi` or document the all-target change.
7. `process.stdin.read(b, off)`: no `off ≤ len` clamp (negative → huge u32)
   and `fd_read` errno dropped (`linear-uint8-codegen.ts:273-290`).
8. Compound element writes (`b[i] += 1`, `b[i]++`) have no linear lowering
   and no GC fallback once a buffer is linear — likely compile error on
   valid code; add a targeted test.

## Acceptance criteria

- Shadowing test (param `buf` + inner `const buf`) reads/writes the correct
  buffers in both directions.
- OOB linear access traps (or throws) exactly like the GC path; no silent
  write outside the arena allocation.
- The three untracked-argument shapes and the three function-value-escape
  shapes either work or demote the helper to GC representation — no
  compile errors on valid programs, no signature mismatches.
- `real-world-wasi.test.ts` and `tests/issue-1886*.test.ts` stay green;
  new regression tests for findings 1, 2, 3, 4, 8.
