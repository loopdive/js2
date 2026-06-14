---
id: 2035
title: "generator return value leaks into iteration: spread/for-of/Array.from/yield* include it; final {value, done:true} never materializes"
status: done
sprint: 63
created: 2026-06-11
updated: 2026-06-13
completed: 2026-06-13
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: generators
goal: core-semantics
related: [1687, 1947, 729]
origin: "2026-06-10 spec-conformance sweep (iterators agent): verified on main"
---

# #2035 — return value pushed into the yield buffer as a normal element

## Problem

```ts
function* g() { yield 1; yield 2; return 3; }
[...g()]           // wasm: [1,2,3]   node: [1,2]
for (const v of g())  // wasm visits 3   node doesn't
Array.from(g())    // wasm: [1,2,3]   node: [1,2]
const it = g();
it.next(); it.next();
it.next()          // wasm: {value:3, done:false}   node: {value:3, done:true}
it.next()          // wasm: {value:NaN, done:true}  node: {value:undefined, done:true}
```

yield* delegation also leaks the inner generator's return value into the
outer stream.

## Root cause

`src/codegen/statements/control-flow.ts:107-127` — `compileReturnStatement`
deliberately pushes the generator's return value into `__gen_buffer` via
`__gen_push_*` ("so it appears as the final next() value", #729), but the
host buffer-drain `next()` (`src/runtime.ts:227-240`) treats every buffer
entry as `done:false`. Per §27.5.3.3 / §27.5.1.2, the return value belongs
only to the `{value, done:true}` result, and IteratorClose-consuming
constructs (spread, for-of, Array.from, yield* output) must exclude it.

## Fix direction

Carry the return value separately (e.g. 3rd arg to `__create_generator` /
dedicated cell) instead of pushing it into the buffer; drain `next()`
returns it once with `done:true`. Independently fixable without the #1665
coroutine rewrite.

## Acceptance criteria

- All five repros match Node; yield* stops leaking inner return values
- `gen.return(v)` early-termination semantics unchanged

## Dupe check

#1687 (blocked on #1665) covers suspension semantics (next(arg)/throw/
yield* result value), NOT return-value-in-buffer; #1947 is the 1M cap.
New.

## Suspended Work (2026-06-12, dev-c)

- **Worktree**: `/workspace/.claude/worktrees/issue-2035-gen-return`
- **Branch**: `issue-2035-gen-return` (1 WIP commit, `5f79ff4ef`, not pushed)

### Done (correct, validated)
The "carry the return value separately" mechanism is implemented for the
runtime + the lifted-function codegen path:
- `src/runtime.ts`: `_GeneratorState` gains `retVal`/`retDone`. `next()`
  surfaces `retVal` exactly once as the terminal `{value, done:true}` result,
  then `{value:undefined, done:true}`. `return()` sets `retDone`. New host
  import `__gen_set_return(buf, value)` stashes the return value on the buffer
  as a non-enumerable `__genReturn` side property; `__create_generator` reads
  it into state.
- `src/codegen/index.ts`: `__gen_set_return` registered in both
  `addGeneratorImports` sites (signature = `pushRefType`).
- `src/codegen/statements/control-flow.ts` `compileReturnStatement`: routes the
  generator return through `__gen_set_return` (coerced to externref) instead of
  `__gen_push_*`.
- `tests/equivalence/helpers.ts`: manual harness mirrors the runtime change.
- **Verified passing**: raw `it.next()` sequence (return value only on the
  `done:true` step) and `[...g()]` spread (return excluded). `tests/iterators.test.ts`
  6/6 still pass (no regression).

### Remaining (the actual blocker)
`for (const v of g())` over an **immediate generator call** STILL includes the
return value (count=3, sum=6 vs Node count=2, sum=3). Root cause is a **second
generator codegen path** that the issue's root-cause note missed: the
inline/eager generator materialization in `src/codegen/expressions/misc.ts`
(see `getReturnExpression` / `getStaticReturnValue` ~lines 475-498 and the
call-site buffer build). For this shape the lifted-function path
(`compileReturnStatement`) is **bypassed** — WAT for the for-of repro shows
3 `__gen_push_f64` calls (2 yields + return) and **no** `__gen_set_return`
import. The fix is to apply the same `__gen_set_return` routing (or equivalent
"don't push the return into the buffer") in the misc.ts inline path, then
re-validate all five repros + `yield*` delegation.

### Resume steps
1. `cd` into the worktree, `git fetch origin && git merge origin/main`.
2. Trace the inline generator path in `src/codegen/expressions/misc.ts` (grep
   `__gen_buffer` / `__gen_push` / `getReturnExpression`); find where the
   immediate `g()` call materializes its buffer and route the `return` value
   through `__gen_set_return` instead of `__gen_push_*`.
3. Re-run the repros (spread / for-of / `Array.from` / raw `it.next()` x2 /
   `yield*`) against Node via `compileToWasm`; add `tests/issue-2035.test.ts`.
4. Set `status: done` + `completed:`, open PR, self-merge.

## Resolution (2026-06-13, sdev)

### The "second codegen path" was the IR front-end, not `misc.ts`

The handoff pointed at `src/codegen/expressions/misc.ts` (`getReturnExpression` /
`getStaticReturnValue`), but those are the **object-literal ToPrimitive static
folder** — unrelated. The actual second generator-body emitter is the **IR
front-end** (`src/ir/from-ast.ts`). The `for (const v of g())` program is simple
enough to be claimed by the IR path; the spread / `Array.from` programs (with
`JSON.stringify` / host calls) fall back to the legacy direct-AST path. Proof:
the for-of program's `$g` body had `$$slot___gen_buffer`, no try/pending-throw,
**no `__gen_set_return` import**, and the `return 3` lowered to a third
`__gen_push_f64`; the spread program's `$g` body was the legacy shape (try-block,
`__gen_set_return`, `__gen_ret_*` local) and excluded the return correctly.

### Root cause (IR)

`from-ast.ts` `lowerTail` (the generator-return arm) emitted its own
`emitGenPush(<return value>)` — re-implementing the exact buffer-leak bug the
legacy `compileReturnStatement` already had (and which the prior WIP commit had
fixed there via `__gen_set_return`).

### Fix

The IR has **no number-box primitive** (it cannot coerce a numeric `return 3` to
the `externref` that the `__gen_set_return(externref, externref)` import
expects — same gap that makes `coerceReturnValue`/`lowerThrowStatement` defer
numeric returns/throws to legacy). Rather than build that primitive, the IR
generator-return arm now **throws to defer any generator carrying a
`return <expr>` to the already-correct legacy path** (which boxes via
`__box_number` and routes through `__gen_set_return`). Bare `return;` (no value)
has nothing to leak and stays on the IR path. The `lowerStmt` non-tail path
already lacks a return arm, so mid-body `return <expr>` also defers cleanly. No
`playground/examples/` example is a generator, so the IR-fallback budget gate is
unaffected.

### Validation

`tests/issue-2035.test.ts` (9 cases): spread, for-of sum + count, `Array.from`,
`yield*` delegation, raw `next()` terminal-value sequence, numeric `return`
exclusion, bare `return;`, and `gen.return(v)` early-termination — all match
Node. Standalone mode (native generator resume path) was already correct and is
untouched. `tsc` + prettier + biome lint clean. The one failing generator
equivalence test (`yield-as-expression.test.ts` "yield with value used as
expression") is a **pre-existing TS type error** (`Type 'undefined' is not
assignable to type 'number'`) reproduced identically on baseline `from-ast.ts`
— path-independent, not introduced here.

### Files

- `src/ir/from-ast.ts` — `lowerTail` generator-return arm defers to legacy (this PR).
- `src/runtime.ts`, `src/codegen/index.ts`, `src/codegen/statements/control-flow.ts`,
  `tests/equivalence/helpers.ts` — runtime `retVal`/`retDone` + `__gen_set_return`
  + legacy `compileReturnStatement` routing (prior WIP commit `5f79ff4ef`).
