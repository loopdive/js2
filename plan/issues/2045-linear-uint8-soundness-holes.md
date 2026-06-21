---
id: 2045
title: "linear Uint8Array (WASI): silent-corruption holes — name-keyed buffer registry, no bounds checks — plus escape-analysis demotion gaps (#1886 follow-up)"
status: in-progress
sprint: 64
created: 2026-06-10
updated: 2026-06-17
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, wasi
language_feature: typed-arrays, linear-memory
goal: standalone-mode
assignee: ttraenkler/cs-2164
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

## Partial resolution (2026-06-12) — silent-corruption routes A.1 + A.2 landed

The two **silent-corruption** routes (Part A, "fix first") are fixed. The
escape-analysis demotion gaps (Part B) and the smaller correctness items
(Part C) remain — the issue stays **in-progress**.

### A.1 — scope-blind buffer registry → symbol-keyed

`fctx.linearU8Buffers` was keyed by identifier **text**
(`linear-uint8-signatures.ts`), so a linear param `buf` plus an inner-block
`const buf = new Uint8Array(...)` (distinct symbol, same name) collided — the
inner registration overwrote the param's `(ptr,len)` entry, and element access
addressed the wrong buffer in **both** shadowing directions (verified: the
param's trailing `write(buf)` emitted the inner buffer's bytes).

Fix: key the registry by the binding's `ts.Symbol`. `registerLinearU8Buffer`
now takes a symbol; `getLinearU8Buffer(ctx, fctx, node)` resolves the symbol
via `ctx.checker.getSymbolAtLocation(node)`. Param registration
(`function-body.ts`) and `new Uint8Array(...)` registration
(`linear-uint8-codegen.ts`) both pass the symbol; a binding with no resolvable
symbol simply isn't registered (falls to the GC path — sound).

### A.2 — no bounds check on linear element access → trap like GC

`b[i]` / `b[i] = v` lowered to a raw `i32.load8_u`/`i32.store8` at
`ptr + trunc(i)` with no bounds check; an OOB index silently read/wrote
arbitrary linear memory (iovec scratch at 0..11, string-literal data, and —
under Slice C — a caller's buffer). The GC array path traps.

Fix: `emitLinearU8BoundsCheck` emits `idx (u32) >= len → unreachable` before
every linear element get/set, matching the GC trap. The index is compared
unsigned so a negative (huge-u32) index also traps. The store path checks
**before** evaluating the value, matching the GC `array.set` trap order. Index
exprs are stored once so a side-effecting index runs once. The guard is
unconditional (one compare + branch per access); eliding it for provably
in-range constant indices is a possible later perf tweak, not a soundness need.

Covered (`tests/issue-2045-linear-u8-soundness.test.ts`, 6 green): OOB read
traps, OOB write traps, negative-index traps, in-bounds access unchanged
(read-back), inner-block same-name shadow (param not corrupted), outer local
keeps its buffer after a same-name inner const. Regression-clean across
`tests/issue-1886*.test.ts` (16 green), `linear-*` (22 green), and the WASI
I/O suites; tsc + biome + prettier clean. (`real-world-wasi.test.ts` and the
`issue-1886-slice-b` escaping test have two pre-existing host-import-allowlist
failures unrelated to this change — verified identical on main.)

### Remaining (issue stays open)

- **B.3 / B.4** escape-analysis demotion gaps (untracked call-site args;
  function-value escapes of rewritten helpers) — these are fail-closed
  `reportError`s on otherwise-valid WASI programs, a larger interprocedural
  change split out from the corruption fixes.
- **C.5–C.7** loop-arena rewind ordering, the all-target while-loop
  restructure gate, `process.stdin.read` offset clamp + errno.

## C.8 — compound element write + `++`/`--` on a linear buffer (LANDED 2026-06-18, cs-2164)

**Done — another silent-corruption route.** `b[i] op= rhs` (`+=`, `-=`, `*=`,
`&=`, …) and `b[i]++` / `++b[i]` / `b[i]--` on a linear-backed `Uint8Array`
(WASI) **silently failed to update linear memory**: `b[0] = 5; b[0] += 1`
read back `5`, and the `++`/`--` forms threw a `WebAssembly.Exception` at
runtime.

**Root cause.** The plain `b[i] = v` write goes through
`compileElementAssignment`, which tries `tryEmitLinearU8ElementSet` first — but
the *compound* and *update* forms have separate lowerings that had no linear
path: `compileElementCompoundAssignment` (assignment.ts) compiled
`target.expression` as a value (materialising the GC vec) and wrote the result
through the externref/GC path — never touching linear memory; `compileMemberIncDec`
(unary-updates.ts) required a `ref`/`ref_null` array and hit
`compileExpression`'s `(ptr,len)` shape → runtime throw.

**Fix** (`linear-uint8-codegen.ts` + the two call sites). Two new emitters do a
bounds-checked read-modify-write at a single `addr = ptr + trunc(i)` (index
evaluated once), mirroring the existing get/set:
- `tryEmitLinearU8ElementCompound` — `i32.load8_u` → f64, run the caller's
  compound op (a closure over `emitCompoundOp` + the rhs, threaded to dodge the
  assignment.ts↔linear-uint8-codegen.ts import cycle), `i32.store8` the low
  byte; leaves the (untruncated) f64 result for the expression value. Wired at
  the top of `compileElementCompoundAssignment`.
- `tryEmitLinearU8ElementUpdate` — `load → ±1 → store`, leaving the **new**
  value (prefix) or **old** value (postfix) per §13.4. Wired into
  `compileMemberIncDec` (the live `++`/`--` dispatch) **before** its
  `compileExpression(operand.expression)`, plus defensive guards in the
  `compilePrefix/PostfixIncrementElement` handlers (reached via the alt postfix
  dispatch). Both fall through to the GC path for any non-linear element target.

The store truncates to the byte, so `200 += 100 → 44` and `255++ → 0` wrap
correctly (matching JS `Uint8Array` semantics).

**Validation.** New `tests/issue-2045-linear-u8-compound.test.ts` (11, WASI run
via the `runWasiMain` fd_write harness): `+=`/`-=`/`*=`/`&=`, byte-wrap on
compound, `++`/`++`-prefix/`--`, postfix-returns-old, prefix-returns-new, and
`255++`→0 wrap. The 14 #2045/#1886-slice-b and 150 linear/WASI suite cases stay
green. tsc + prettier + biome(error) + coercion-sites + any-box + stack-balance
gates clean.

**Still open:** B.3/B.4 (escape-analysis demotion) and C.5–C.7 (loop-arena
rewind ordering, all-target while-loop gate, `process.stdin.read` clamp/errno).
**#2045 stays in-progress.**
