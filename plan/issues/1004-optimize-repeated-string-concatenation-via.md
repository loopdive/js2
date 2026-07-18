---
id: 1004
title: "Optimize repeated string concatenation via compile-time folding and counted-loop aggregation"
status: done
assignee: ttraenkler/dev-perf
created: 2026-04-09
updated: 2026-07-17
completed: 2026-07-17
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
language_feature: strings-concat
goal: generator-model
sprint: current
es_edition: multi
loc-budget-allow:
  - src/codegen/statements/loops.ts
---
# #1004 -- Optimize repeated string concatenation via compile-time folding and counted-loop aggregation

## Status: done

The landing-page `string.ts` benchmark is currently slower in Wasm than in JS:

- Wasm: about `11.9us`
- JS: about `5.2us`

This benchmark is especially adversarial for the current lowering:

```ts
let str = "";
for (let i = 0; i < 1000; i++) str = str + "abcde";
return str.length;
```

The runtime snapshot path is compiled with `optimize: 4`, but not `fast: true`,
so repeated concat still goes through the non-fast `wasm:js-string` / helper
path. That means the emitted loop pays repeated concat operations instead of
recognizing that large parts of the final string are statically derivable.

## Goal

Make repeated string concatenation substantially cheaper by moving obvious work
out of the hot loop:

1. fold constant concat chains at compile time
2. detect counted append loops with loop-invariant string fragments
3. aggregate or unroll them into fewer concat operations
4. preserve exact JS-visible string semantics for non-optimizable cases

## Optimization directions

### 1. Constant-fold literal concat

For cases like:

```ts
"a" + "b" + "c"
```

emit a single constant string instead of a concat chain.

### 2. Aggregate counted literal append loops

For patterns like:

```ts
let s = "";
for (let i = 0; i < N; i++) s = s + "abcde";
```

where:

- the appended fragment is loop-invariant
- the destination string does not escape during the loop
- `N` is statically derivable or tightly bounded

replace per-iteration concat with one of:

- compile-time expansion when `N` is small
- chunked unrolling to reduce concat count
- a builder/repeat-style lowering that constructs the result in fewer steps

### 3. Hoist invariant concat operands

Even when full aggregation is not possible, hoist loop-invariant pieces so the
hot loop does less repeated work.

### 4. Keep the generic path as fallback

Dynamic string cases, aliasing, or semantic hazards must still use the current
safe concat lowering.

## Evidence

The benchmark itself is explicitly labeled:

- `wasm:js-string concat per iteration`

and the runtime benchmark snapshot generator compiles it with:

- `optimize: 4`
- not `fast: true`

So the current slowdown is not surprising: JS engines are extremely strong at
rope/concat optimization, while the Wasm path still executes a large number of
individual concat operations.

## Acceptance criteria

- literal-only concat chains are folded at compile time
- counted append loops with invariant literal fragments emit substantially fewer
  concat operations than one concat per iteration
- non-optimizable concat patterns remain semantically correct
- the generated WAT / helper usage for `examples/benchmarks/string.ts` is
  visibly simpler than the current repeated-concat form
- the landing-page `string.ts` benchmark no longer shows a large persistent
  Wasm slowdown relative to JS on the normal optimized path

## Notes

This issue is intentionally scoped to the non-fast path too. Fixing
`fast: true` string support is still useful, but the default optimized path
should not remain obviously inefficient for common repeated-concat patterns.

## Resolution (2026-07-17)

Directions 1 & 3 (constant-fold literal concat chains, fold adjacent constant
operands, batched N-arg concat) were already implemented in
`src/codegen/string-ops.ts` (`resolveStrictConstant`,
`foldAdjacentConstantOperands`, `compileBatchedConcat`) and in the
`nativeStrings` concat arm of `compileStringBinaryOp`.

This PR completes **direction 2 — counted-append loop aggregation** — the one
piece that hits the adversarial `string.ts` benchmark loop itself.

New pass `src/codegen/statements/counted-string-append.ts`
(`tryCompileCountedStringAppend`), hooked at the top of `compileForStatement`
(`src/codegen/statements/loops.ts`). It recognizes

```ts
let s = <string>;
for (let i = A; i < B; i++) s = s + FRAGMENT;   // or  s += FRAGMENT
```

and lowers the WHOLE loop to a single `s += FRAGMENT.repeat(N)`
(`N = max(0, B − A)`), turning O(N) per-iteration concats — each crossing the
`wasm:js-string` host boundary / calling `__str_concat` — into one
`String.prototype.repeat` + one concat.

Guard (provably-identical only; anything else falls through to the normal loop):

- counter `let`/`const`-declared in the for-head (block-scoped ⇒ unobservable
  after the loop) initialized to a compile-time integer `A`;
- condition `i < B` / `i <= B` with compile-time integer `B` ⇒ `N` is a known
  finite non-negative integer (no `Infinity` / non-integer-bound hazards);
- incrementor `i++` / `++i` / `i += 1` (unit positive step);
- body is exactly one statement `s = s + FRAGMENT` / `s += FRAGMENT`, `s` a
  plain string-typed identifier (not the counter);
- FRAGMENT is a side-effect-free loop-invariant string (string literal or
  string-typed identifier ≠ `s`/`i`) — calls/member-access (getter hazards) and
  the doubling shape `s = s + s` are declined.

All type queries route through `ctx.oracle` (`staticJsTypeOf`,
`constInitializerOf`) — the oracle-ratchet gate reports +0 net checker growth.

Works in both the default JS-host (`wasm:js-string`) and `target: "standalone"`
(native `__str_repeat`) regimes.

## Test Results

`tests/issue-1004.test.ts` — 17 cases green: canonical benchmark loop
(length + byte-identical string), seed prefix, `+=` form, braced body,
inclusive `i<=B`, invariant-identifier fragment, zero-iteration / start≥bound
(emit-nothing), N=1 normal path, nested loops; plus decline cases proving
correctness for counter-dependent / prepend / multi-statement / doubling /
runtime-bound / non-unit-step shapes. Extra probes: const bound, template
fragment, `var`-counter decline, global & closure-captured accumulator, `++i`,
`i += 1` — all correct. Host + standalone both compile and emit the `repeat`
call (source concat loop removed).
