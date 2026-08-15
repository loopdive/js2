---
id: 4420
title: "A compile can report success:true and emit a module the engine rejects — gate on WebAssembly.compile"
status: ready
sprint: current
created: 2026-08-14
updated: 2026-08-14
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
goal: correctness
---

## Problem

`compileFiles("src/emit/binary.ts")` returns **`success: true`** with 268,829
bytes of Wasm. The engine then rejects it:

```
Compiling function #103:"encodeInstr" failed:
  struct.get[0] expected type (ref null 2), found local.tee of type f64 @+128058
```

So `success` is not a statement about whether the output is a valid module. Any
scoreboard built on it — a self-hosting progress metric, an npm-compat matrix,
a conformance count — can report progress that does not exist.

## Two separate things to fix

**1. The scoreboard.** Anything that reports "compiled OK" must gate on
`WebAssembly.compile` (or `WebAssembly.validate`), not on the `success` flag.
This is cheap and should happen regardless of item 2.

**2. The underlying codegen bug.** A local holding `f64` is being fed to
`struct.get` expecting `(ref null 2)`. Not narrowed further. It is reachable
from ordinary source — `src/emit/binary.ts` is not exotic — so it is likely to
affect real user code, not just self-compilation.

## Why both

Fixing only the gate hides a real miscompile behind a red scoreboard cell.
Fixing only the codegen bug leaves the next one silent. The gate is the
durable part: it converts this whole class from "silently wrong" to "loudly
broken".

## Acceptance criteria

- [ ] A validation step exists that callers can opt into, and every
      self-host / dogfood / compat scoreboard uses it.
- [ ] A regression test compiles `src/emit/binary.ts` and asserts
      `WebAssembly.compile` resolves — currently failing, which is the point.
- [ ] The `encodeInstr` type mismatch is root-caused and fixed.

## Notes

Worth checking whether the existing `validate` paths (`src/emit/`,
`scripts/`) already have a helper for this before adding another one.

## Provenance

Found by the self-hosting investigation. Repro: `compileFiles` on
`src/emit/binary.ts`, then `WebAssembly.compile(result.binary)`.
