---
id: 6787
title: "codegen: `Array.prototype.push` fast path reads the length before evaluating its arguments — re-entrant mutation in the argument is lost"
status: done
sprint: Backlog
created: 2026-09-30
updated: 2026-10-01
completed: 2026-10-01
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: array-methods
goal: core-semantics
related: [1143, 840]
requested_by: ttraenkler/claude-review
assignee: "ttraenkler/claude-dev-6787"
branch: "claude/issue-6787-push-arg-order"
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H1"
---

# #6787 — `push` evaluates receiver, snapshots `len`, then evaluates the argument

## Problem

Reproduced 2026-09-30 (JS-host lane, diffed against Node):

| source | wasm | JS |
|---|---|---|
| `const a: number[] = []; const f = () => { a.push(1); return 2 }; a.push(f())` | `[2]` | `[1, 2]` |
| `const b = [1]; b.push(b.pop()!)` | `[1, 1]` | `[1]` |
| `const c = [5]; c.push(c.length, c.push(7))` | `[5, 7, 2]` | `[5, 7, 1, 2]` |

Spec order (§23.1.3.23): the receiver and **all arguments** are evaluated
before `push` runs; `len` is read inside `push`.

## Root cause

`src/codegen/array-methods.ts:4293-4299`: receiver compiled, then
`struct.get len → lenTmp`, then the argument expression is compiled. Any
argument that mutates the same array (or any array, via aliasing) sees the
stale `lenTmp` and its own writes are overwritten.

## Correction

Compile every argument into a temp local first (or in stack order before the
receiver's length read), then read `len`. For the single-scalar fast path
this is one extra `local.set`/`local.get` pair; the peephole already elides
`local.set x; local.get x` sequences where safe. Apply the same ordering
review to the other in-place fast paths that snapshot length before
arguments: `unshift`, `splice`, `fill`, `copyWithin`, `set`-style typed-array
writes (grep `lenTmp` / `struct.get.*len` in `array-methods.ts`).

## Acceptance

- The three rows above match Node.
- `tests/equivalence/array-push-reentrancy.test.ts` with the three cases plus
  a `push` inside a getter argument and a `push` from a `valueOf` on a boxed
  argument.
- `analyze-wat` on `a.push(x)` with a scalar `x` shows no extra call or
  allocation versus today (the fast path stays fast).

## Implementation Plan

1. **New module `src/codegen/array-method-arg-order.ts`** (classified in
   `scripts/compiler-boundaries.json` beside `array-method-host.ts`):
   - `callArgsNeedEarlyEvaluation(args)` — false only when every argument is
     side-effect free (identifier, `this`, literal, `±<numeric literal>`,
     `void <pure>`, through parens/`as`/`!`/`satisfies`).
   - `planCallArgs(ctx, fctx, args, early, valueHint, indexType)` → `{ value(i), index(i) }`.
     Not early: each use site compiles its argument exactly as before (no new
     instructions). Early: every argument is evaluated now, left to right, into
     a temp local (`__argord_*`), and the use site is a `local.get`. Value
     arguments use their element-type hint; an index operand whose static JS
     type is primitive (oracle `staticJsTypeOf`) is evaluated with its index
     hint, while an object/`any` operand is evaluated at its natural type and
     converted at the use site — ToIntegerOrInfinity (which may call
     `valueOf`) stays AFTER the `length` read, as §23.1.3.x specifies.
2. **Legacy lowerings in `array-methods.ts`** — `compileArrayPush`,
   `compileArrayUnshift`, `compileArraySplice`, `compileArrayFill`,
   `compileArrayCopyWithin`: decide `early` before compiling the receiver; when
   early the receiver is parked with `local.set` (not `local.tee`) so the
   operand stack is empty while the arguments run, then re-loaded for the
   length read. Every argument use goes through the plan. A counted
   (pre-sized) push keeps its proven-pure value at the store. In `splice`,
   spread items still go through `buildSpreadArgList`, now called before the
   length read (after the planned start/deleteCount).
3. **IR lane `tryLowerVecPush` (`src/ir/array-element-lowering.ts`)** — the
   vec length read (`lenF64`/`lenI32`) moved after the value is lowered; the
   SSA emitter spills the value only when it has to.

## Resolution

Before → after, JS-host lane, diffed against Node (`.tmp/probe.mts` harness):

| source | before | after = JS |
|---|---|---|
| `const a: number[] = []; const f = () => { a.push(1); return 2 }; a.push(f())` | `[2]` | `[1,2]` |
| `const b = [1]; b.push(b.pop()!)` | `[1,1]` | `[1]` |
| `const c = [5]; c.push(c.length, c.push(7))` | `[5,7,2]` | `[5,7,1,2]` |
| push via getter argument `a.push(o.v)` | `[2]` | `[1,2]` |
| push via `valueOf` on a boxed argument `a.push(+o)` | `[2]` | `[1,2]` |
| `d.push(1, (d.push(9), 2))` | `[0,9,2]` | `[0,9,1,2]` |
| argument grows the backing (10 pushes) then `a.push(f())` | `[0]1` | `[0,…,9,99]11` |
| `u.unshift(u.shift()!)` / `v.unshift(h(), 5)` | `[0,1,2]` / `[4,5,3]3` | `[1,2]` / `[4,5,9,3]4` |
| `s.splice((s.push(4), 1), 1)` / `t.splice(0, 1, (t.push(9), 7))` | `[1,2]` / `[7,2,3]` | `[1,3,4]` / `[7,2,3,9]` |
| `t.splice(f(), 0, ...src)` (f pushes) | `[1,8,9,2]` | `[1,8,9,2,3]` |
| `f.fill((f.push(0), 5))` | `[0,0,0]` | `[5,5,5]` |
| `c.copyWithin(0, (c.push(4), 3))` | `[1,2,3,4]` | `[4,2,3,4]` |
| IR-claimed `a.push(f(a))` (f pushes through its parameter) | `112` | `221` |
| standalone lane, all of the above folded into one number | `596736` | `774515` |

Fast path: the WAT of a module exercising `a.push(x)`, `a.push(1, x, -2)`,
`a.unshift(x, 0)`, `s.push("q")`, `a.splice(0, 1, x)`, `a.fill(0, 1, -1)`,
`a.copyWithin(0, 1, 2)` (legacy lane) is **byte-identical** before/after, and so
is the IR-lane `function (a: number[], x: number) { return a.push(x) }`. An
effectful argument costs one temp local and a `local.set`/`local.get` pair (plus
`local.set`+`local.get` of the receiver instead of `local.tee` in the legacy
lane); no extra call or allocation.

Sites examined (`lenTmp` / `struct.get … 0` in `array-methods.ts`, plus the push variants):

| site | verdict |
|---|---|
| `compileArrayPush` (unrolled; `number[]`/`string[]`/ref-element vecs, any arity) | same bug — **fixed** |
| `tryLowerVecPush` (IR lane, one plain argument) | same bug — **fixed** |
| `compileArrayUnshift` | same bug — **fixed** |
| `compileArraySplice` (start, deleteCount, items, spread items) | same bug — **fixed** |
| `compileArrayFill` | same bug — **fixed** |
| `compileArrayCopyWithin` | same bug — **fixed** |
| `compileTypedArraySet` | snapshots `dstLen`/`dstData` before the source/offset, but a vec-backed TypedArray's length and backing never change (no push/splice on TAs; resizable buffers take the `$__ta_view` path) — not observable, unchanged |
| `compileExternReceiverPushPop` (`any`-carrier receiver) | receiver → argument → runtime `__vec_push` reads `length` at call time — correct, unchanged |
| `compileArrayPushDynamicSpreadNative` / `…Host` (`a.push(...src)`) | receiver → source → `length` — correct, unchanged |
| `compileArrayPushSpread` (`array-push-spread.ts`, mixed spread lists) | receiver → `buildSpreadArgList` → `length` — correct, unchanged |

Deliberately left out (follow-up candidates):

- **Read-only / copying methods have the same ordering defect** (measured, not
  fixed — out of this issue's in-place scope): `a.at((a.push(4), -1))` → `3`
  (JS `4`); `indexOf`/`includes`/`lastIndexOf` of a value the argument pushes →
  `-1`/`false`/`-1` (JS `3`/`true`/`3`); `with`, `toSpliced`, `join`, `concat`
  drop the pushed element. `slice` is already correct. `planCallArgs` is the
  tool for that follow-up.
- **Coercion-time mutation**: a `valueOf` on an index operand that grows the
  receiver during ToIntegerOrInfinity still writes into the pre-coercion
  backing (`v.fill(id(7), o)` with `o.valueOf` pushing → `[1,2,3,9]`, JS
  `[7,7,7,9]`) — identical before/after; needs a live-backing re-read, not an
  argument-order change.
- **Linear backend** (`src/codegen-linear/index.ts` `push`): appends each
  argument right after evaluating it, so a multi-argument push whose later
  argument mutates the receiver interleaves (by inspection; not run).

Tests: `tests/equivalence/array-push-reentrancy.test.ts` (17 rows: the three
issue rows, getter, `valueOf`, multi-arg, `string[]`, backing growth,
class-instance elements, IR lane, pure-argument control, unshift, splice,
spread splice, fill, copyWithin, standalone lane — 16/17 fail on the base, 17/17
pass) and `tests/issue-6787-push-arg-order.test.ts` (WAT shape: pure arguments
add no spill/call/allocation on both lanes; an effectful argument runs before
the length read — 2/4 fail on the base, 4/4 pass).

Gates (exit codes, run locally on the merged branch):

- `check-loc-budget` 0, `check-func-budget` 0 (also with
  `LOC_GATE_BASE=origin/main`, 0/0), `check-coercion-sites` 0,
  `check:oracle-ratchet` 0, `check:dead-exports` 0, `typecheck` 0,
  `format:check` 0, `lint` 0. No budget allowance needed (`array-methods.ts` is
  net 0 lines; the helper lives in the new module).
- `check-compiler-boundaries --mode inventory` 0; `check:ir-dialect`,
  `ir-kind-neutrality`, `jstag-seam`, `ir-layering`, `codegen-fallbacks`,
  `any-box-sites`, `speculative-rollback`, `stack-balance`, `pushraw`,
  `host-import-policy`, `ir-only`, `ir-adoption`, `issues`,
  `done-status-integrity`, `issue-spec-coverage`, `harness-compile-budget`,
  `verdict-oracle` all 0; `check:ir-fallbacks` 0.
- New tests 0; `test:guard` 0.
- The first 15 `tests/*array*.test.ts` files (single fork, 4 GB heap): 22
  failures — the identical 22 fail on `origin/main` code (A/B with the two
  source files swapped back; `string_constants` import / #4247 / #709 rows),
  so none is from this change.
- `tests/equivalence/array-*.test.ts` (single fork) instead of the 8-minute
  `equivalence-gate`: 116/117; the one failure (`array-inline-return` "find
  does not hijack return", a TS `number | undefined` compile error in the test
  source) fails identically on `origin/main`.
