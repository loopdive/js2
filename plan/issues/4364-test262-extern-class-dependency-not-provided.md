---
id: 4364
title: "test262 harness: `No dependency provided for extern class` — 224 tests, 172 on the `ctor` fixture (successor to #1524)"
status: ready
sprint: current
created: 2026-08-11
updated: 2026-08-11
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: test-runner
language_feature: test262-harness, typed-array
goal: test-infrastructure
related: [1524, 1645, 1354, 4020]
origin: "2026-08-11 /harvest-errors of loopdive/js2wasm-baselines test262-current.jsonl (run 20260811-103533, gitHash 9268d5a5)"
---

# #4364 — harness fixture identifiers compile to unresolvable `extern class`

## TL;DR

**224 official failing tests** in the **default (JS-host)** lane fail at the
dependency-injection boundary with `error_category: missing_dependency`:

```
No dependency provided for extern class "ctor"
```

This is the direct successor to **#1524** (`status: done`, "ctors fixture not
exposed in resizable-buffer tests", scoped at 202 tests). That fix changed the
*symptom* — `ctors is not defined` is gone — but the same test family still
fails, now one layer later: the identifier now resolves to an **extern class
declaration** for which no dependency is ever supplied.

## Evidence

Source: `test262-current.jsonl` from `loopdive/js2wasm-baselines`, run
`20260811-103533` (gitHash `9268d5a5`).

Missing extern-class names (9 distinct):

| Name | Count |
|---|---|
| `ctor` | 172 |
| `badArrayType` | 23 |
| `FinalizationRegistry` | 21 |
| `nonSharedArrayType` | 3 |
| `Other` | 2 |
| `TA`, `sourceCtor`, `targetCtor`, `eval` | 1 each |
| **Total** | **224** |

By directory:

| Directory | Count |
|---|---|
| `built-ins/TypedArray/prototype` | 91 |
| `built-ins/Array/prototype` | 68 |
| `built-ins/FinalizationRegistry/prototype` | 15 |
| `language/statements/for-of` | 5 |
| `built-ins/Atomics/{wait,waitAsync,compareExchange}` | 9 |
| `built-ins/Object/defineProperty` | 3 |

Samples:

- `test262/test/built-ins/TypedArray/prototype/indexOf/coerced-searchelement-fromindex-grow.js`
- `test262/test/built-ins/Array/prototype/keys/resizable-buffer.js`
- `test262/test/built-ins/TypedArray/prototype/join/coerced-separator-grow.js`
- `test262/test/built-ins/Atomics/waitAsync/validate-arraytype-before-index-coercion.js`

## Root cause hypothesis

These are all **test-local loop variables**, not globals:

```js
testWithTypedArrayConstructors(function(TA) { ... });
// or
[Int8Array, Uint8Array].forEach(function(ctor) { ... });
```

The names (`ctor`, `TA`, `sourceCtor`, `targetCtor`, `badArrayType`,
`nonSharedArrayType`) are **callback parameters**. `FinalizationRegistry` and
`eval` are genuinely-global but unimplemented.

So the compiler appears to be treating an unresolved *binding* as an ambient
`extern class` needing host injection, rather than as a local parameter already
in scope. That points at the harness-assembly / type-resolution step rather than
at codegen: whatever declares `ctors` for #1524 is likely declaring the callback
parameter too, shadowing the real binding with an extern declaration that the
runner then can't satisfy.

Two distinct fixes are probably needed:

1. **The 200 callback-parameter names** — stop emitting an `extern class` for a
   binding that is lexically in scope. This is the bulk.
2. **`FinalizationRegistry` (21) and `eval` (1)** — genuinely missing globals;
   route to the relevant feature issues rather than fixing here.

## Acceptance criteria

- [ ] A test using `testWithTypedArrayConstructors(function(TA) {...})` compiles
      with `TA` bound to the callback parameter, no extern-class declaration
      emitted.
- [ ] The `No dependency provided for extern class` bucket drops to at most the
      genuinely-global residual (`FinalizationRegistry`, `eval`), with that
      residual re-routed to its own issue.
- [ ] #1524's resizable-buffer family is re-measured and the surviving failures
      (if any) are attributed to a real spec gap, not to fixture plumbing.

## Notes

Worth checking against **#1645** (`spec gap: ArrayBuffer resizable and TypedArray
detached`, `status: ready`) — that issue owns the *semantics* of these tests;
this one owns only the fixture plumbing that stops them from running at all.
