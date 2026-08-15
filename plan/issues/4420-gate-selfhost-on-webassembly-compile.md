---
id: 4420
title: "A compile can report success:true and emit a module the engine rejects — gate on WebAssembly.compile"
status: in-progress
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

## Implementation Plan (Fable, 2026-08-15)

Reproduced on current main (worktree
`/home/user/js2wasm/.claude/worktrees/compiler-speedup`, harness
`.tmp/selfhost-repro.mts` — note it must shim `globalThis.require` via
`createRequire` because `analyzeFiles` calls bare `require()`, and must not
use top-level await alongside it): `success: true`, `errors` length 5
(warning-severity IR-fallback diagnostics), 269,241 bytes,
`WebAssembly.validate` false, engine error
`function #103:"encodeInstr": struct.get[0] expected (ref null 2), found
local.tee of type f64 @+128058`.

### Part 1 — the validate gate (do this first; it is the durable half)

The CLI is already honest: `src/cli.ts:503` validates before writing and
exits 1, constructing a `WebAssembly.Module` to surface the engine's detail
string. The programmatic API (`compileFiles`/`compile` → `CompileResult`) is
what lies. Plan:

1. Extract the CLI's validate-with-detail idiom into a small exported helper
   (suggest `validateEmittedBinary(binary): { valid: boolean; detail?: string }`
   in `src/optimize.ts` next to `optimizedBinaryValidates`, which already has
   the `BufferSource` cast pattern — check both call sites and reuse, don't
   duplicate a third copy).
2. Add opt-in `validate?: boolean` to `CompileOptions`. When set and a binary
   was produced: run the helper; on failure flip `success: false` and push a
   `CompileError` (`severity: "error"`, message carrying the engine detail).
   Wire it in `compileFilesSource` (src/compiler.ts:1806) AND the single-file
   `compile`/`compileSource` path — grep for where `success: true` results
   are assembled (src/compiler.ts:1232 area) and apply at the common exit
   point, not per-caller. CLI keeps its own existing check (it runs post-
   optimize; do not double-report).
3. Point the scoreboard consumers at it: `tests/dogfood/*.mjs` harnesses and
   `scripts/generate-npm-compat-report.mjs` — wherever they treat
   `success`/compile-OK as "compiled", pass `validate: true` or call the
   helper on the binary. Do not rewrite their reporting formats; just make
   "compiled OK" mean "engine-valid".

### Part 2 — the encodeInstr miscompile (root-cause with a procedure)

The failing construct is in `encodeInstr` (`src/emit/binary.ts`): codegen
emits `(struct.get $T 0 (local.tee $t <f64 value>))` — a member read off a
value it typed as a struct ref while the local it allocated is f64. Suspect
class: a checker/oracle type says "object" while the ValType map says f64
(or a union collapse), likely from an expression of the form
`(x = <numeric expr>).<member>` / compound assignment feeding a member
access, or a vec `.length` read (field 0) off a numeric local.

Procedure (do not skip to guessing):

1. Localize: compile `src/emit/binary.ts` with the WAT emitter (CLI `--wat`
   or the analyze-wat script path) and find in `encodeInstr`'s body the
   `struct.get` whose operand is a `local.tee` of an f64 local. The WAT names
   give you the source construct.
2. Minimize into a standalone repro file in `.tmp/` (extract the construct
   with only the types it needs) and confirm it still emits invalid Wasm via
   the Part-1 helper. THEN reduce to the smallest program that flips
   valid/invalid.
3. Fix at the type-decision site, not by casting at the emission site —
   follow where the ValType for that local was chosen (likely
   `src/codegen/expressions/*` assignment/member paths; check `ctx.oracle`
   usage rules in CLAUDE.md — do NOT reach for raw `checker.*`, the
   oracle-ratchet gate blocks it).
4. Regression tests: (a) the minimized construct as a normal
   `tests/issue-4420*.test.ts` equivalence-style test (compile + validate +
   run, assert correct value); (b) the AC test — compile
   `src/emit/binary.ts` via `compileFiles` with `validate: true` and assert
   `success === true` and `WebAssembly.compile` resolves. Both must pass at
   PR time, so Part 2's fix lands in the same PR as Part 1.
   ⚠ Test (b) compiles a real compiler source file inside vitest — check its
   runtime cost; if it exceeds ~60 s in the suite, scope it to the file-level
   test timeout and note the cost in the test header.

### Out of scope (stays with the parent lane)

The full `src/**/*.ts` self-compile sweep/scoreboard — run separately by the
planner after this lands; results recorded here.

### Acceptance criteria (restated, unchanged from above)

The three checkboxes in this issue; the regression test is (b) in Part 2.
