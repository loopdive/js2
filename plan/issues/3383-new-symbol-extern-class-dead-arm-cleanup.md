---
id: 3383
title: "Remove #3280's dead-and-wrong __new_Symbol arm in extern_class new-dispatch (boxes i32 id as Number)"
status: ready
created: 2026-07-17
priority: low
feasibility: easy
reasoning_effort: low
task_type: cleanup
area: runtime
language_feature: symbol, object-coercion
goal: correctness
related: [1568, 2728, 3280]
---
# #3383 — `__new_Symbol` extern_class arm boxes the raw i32 id as a Number

## Problem

#3280 restored the `Object(BigInt)`/`Object(Symbol)` wrapper handler as a single
early-return in the `extern_class` `"new"` dispatch (`src/runtime.ts`, ~line 7451):

```ts
if (intent.className === "BigInt" || intent.className === "Symbol") {
  return (v: any): any => Object(v);
}
```

For **BigInt** this is correct: JS-BigInt-integration delivers the i64 arg as a
real JS `bigint`, so `Object(v)` yields the proper BigInt-wrapper.

For **Symbol** it is **wrong**: the compiler lowers `Object(symbol)` to
`__new_Symbol(i32 symbol-id)` (a bare i32 counter id — symbols are not real JS
symbols inside wasm). So `Object(v)` here boxes the **id as a Number** →
`typeof` is `"object"` (looks right) but it is a **Number-wrapper**, not a
Symbol-wrapper: `.description` / symbol identity are lost.

## Why it is currently harmless (but a latent trap)

#2728 (PR #3275) added the `Object(symbol)` **emit site** (the `isSymbolType`
branch in `calls-guards.ts`) plus its **own** correct `__new_Symbol` handler that
resolves the i32 id → real JS Symbol (via the per-instance symbol cache) → then
`Object(sym)`, and routes `__new_Symbol` through the dedicated `builtin` handler
(`import-manifest.ts`). So `__new_Symbol` never reaches #3280's `extern_class`
arm — the Symbol branch there is **dead code** today.

It remains a latent trap: if anything ever routes `__new_Symbol` through
`extern_class` again (e.g. the `import-manifest.ts` builtin route is removed or
refactored), the wrong Number-boxing silently returns.

## Fix (1-line)

Restrict #3280's early-return to BigInt only:

```ts
if (intent.className === "BigInt") {
  return (v: any): any => Object(v);
}
```

(Leave Symbol to the dedicated `builtin` `__new_Symbol` handler from #2728.)
Optionally add an `assert.sameValue(typeof Object(Symbol("x")), "object")` +
`.description` check to lock in the correct-wrapper behavior against a future
regression.

## Acceptance

- The `extern_class` `"new"` arm no longer references `"Symbol"`.
- `Object(Symbol("hi")).description === "hi"` (already true via #2728) stays true.
- `tests/issue-1568.test.ts` (BigInt) and `tests/issue-2728.test.ts` (Symbol)
  both remain green.
