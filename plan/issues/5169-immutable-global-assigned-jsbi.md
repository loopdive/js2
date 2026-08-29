---
id: 5169
title: "Emitted module assigns to an immutable global — `JSBI_BigInt` fails WebAssembly.compile on the temporal polyfill"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: medium
horizon: m
feasibility: medium
task_type: bugfix
area: codegen
goal: dogfood
related: [4628, 4645, 4644]
---

# #5169 — `global.set` against an immutable global in `JSBI_BigInt`

## Problem

The linked `@js-temporal/polyfill@0.5.1` + `jsbi@4.3.0` bundle compiles cleanly
but the emitted binary does not validate:

```
CompileError: WebAssembly.compile(): Compiling function #133:"JSBI_BigInt"
failed: immutable global #988 cannot be assigned
```

`compile()` reports `success: true`; only `WebAssembly.compile(binary)` rejects.
Some producer emits a `global.set` (or a `global` init) against a global
declared non-mutable — most likely a string-constant / builtin-carrier import,
which is registered `mutable: false`.

## How it was found

Fell out of #4645. That issue fixed the compile-time/size cliff on the same
bundle; this is a **separate, pre-existing** defect on the same artifact —
verified byte-identical before and after the #4645 fix, so it is not a
regression from it.

## Reproduce

Compile a prefix of the linked bundle cut at ≥262 top-level statements (~109 KB)
with the test262 option set (`allowJs`, `skipSemanticDiagnostics`, `sourceMap`)
and call `WebAssembly.compile` on the result. Below ~109 KB the binary fails
earlier for a different reason (`__call_toString`, #4644), which masks this one.

## Why it matters

Blocks the VALIDATE half of #4628's Temporal lane. After #4645 the bundle
compiles in ~44 s, so the compile gate is green and this is now the first thing
in the way. Per `tests/dogfood/README.md`, a binary that does not validate is an
unverified workload, never a pass.

## Acceptance criteria

1. Name the producer that emits the assignment and the global it targets.
2. Either declare the global mutable at registration or stop assigning it —
   whichever is correct for that global's role, argued in the issue.
3. The ≥109 KB polyfill prefix passes `WebAssembly.compile` (or fails only for
   a different, separately-tracked reason).
4. No test262 regression.
