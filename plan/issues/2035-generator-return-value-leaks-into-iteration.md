---
id: 2035
title: "generator return value leaks into iteration: spread/for-of/Array.from/yield* include it; final {value, done:true} never materializes"
status: ready
sprint: 61
created: 2026-06-11
updated: 2026-06-11
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
