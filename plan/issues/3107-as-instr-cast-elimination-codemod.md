---
id: 3107
title: "Cast-debt codemod: eliminate 10,678 'as Instr' + 129 'as unknown as Instr' + shrink 579 'as any'"
status: ready
sprint: Backlog
created: 2026-07-09
updated: 2026-07-09
priority: medium
horizon: m
feasibility: medium
model: opus
reasoning_effort: medium
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
related: [1095, 1172, 3105]
---

# #3107 — Cast-debt codemod (`as Instr` epidemic)

**Source:** 2026-07-09 compiler consolidation audit (fable-refactor). See
`plan/log/compiler-consolidation-plan.md`.

## Problem (measured, current main)

#1095 eliminated the `as unknown as Instr` double-casts, but the single-cast
form has since exploded:

| Pattern                         | Count      | Top files                                                                                                                |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `as Instr` (single assert)      | **10,678** | builtins.ts 1,027 · index.ts 996 · array-methods.ts 869 · dataview-native.ts 839 · calls.ts 472 · property-access.ts 380 |
| `as Instr[]`                    | 104        | object-runtime 14, index 11, any-helpers 11                                                                              |
| `as unknown as Instr` (regrown) | 129        | —                                                                                                                        |
| `as unknown as` (all types)     | 341        | —                                                                                                                        |
| `as any`                        | 579        | runtime.ts 92 · fixups.ts 60 · stack-balance.ts 59 · calls.ts 39                                                         |

Sample (representative — the op IS in the `Instr` union, the cast is
cargo-cult): `fctx.body.push({ op: "extern.convert_any" } as Instr)`,
`wasmOut.push({ op: "any.convert_extern" } as Instr)` (`ir/lower.ts:2826`).

Why it matters: `as Instr` **suppresses excess-property and discriminant
checking** — a typo'd field (`typeIdx` vs `typeidx`) or a field from the
wrong variant silently type-checks and becomes a runtime emit bug. CLAUDE.md's
own guidance ("the `Instr` union now covers every emitted opcode … `as Instr`
single-assertions remain for the few computed-`op` sites") is contradicted by
10.6k sites — this is exactly the drift the emitter's `never` exhaustiveness
check was meant to prevent.

## Fix (mechanical, phased)

1. **Codemod**: strip `as Instr` / `as Instr[]` / `as unknown as Instr` where
   the expression is an object/array literal with a constant `op` string —
   a regex-assisted or ts-morph pass. One file (or file-cluster) per commit.
2. `npx tsc --noEmit` after each file: three outcomes per site —
   - compiles clean → cast was pure noise, done;
   - **contextual-typing gap** (e.g. literal built in a `const` then pushed):
     add `satisfies Instr` or type the variable `const x: Instr = …` — keeps
     the check, drops the assertion;
   - **genuine type error surfaced** → STOP for that site: record it in the
     PR description, keep the cast, and file a bug. Do NOT "fix" emit logic
     inside this refactor (behavior-preservation rule).
3. Computed-`op` sites (op chosen at runtime) keep a documented cast — target
   end-state ≤ ~50 asserted sites, each with a `// computed-op` comment.
4. `as any` shrink is a stretch goal, scoped to `fixups.ts`/`stack-balance.ts`
   walker typing (use `instrChildren`-style typed accessors from #1172 C3 if
   landed); runtime.ts `as any` is host-JS interop and mostly legitimate.

## Safety story

Type assertions are **erased at compile time** — removing one cannot change
the emitted JS, so the compiled compiler behaves identically as long as tsc
passes. Byte-identity: trivially preserved; still run
`prove-emit-identity check` once per batch as the cheap invariant. Danger is
only in step-2c (surfaced real errors) — the protocol above quarantines those
instead of hot-fixing them.

## Estimated LOC delta

≈ **−0 LOC** direct (casts are intra-line) but −10k assertion sites; real
value is restoring compile-time checking to every instruction literal.
Follow-on: newly-visible dead branches and mis-typed fields get their own
issues.

## Acceptance criteria

1. `grep -rc 'as Instr' src` < 200 (from 10,782 incl. arrays).
2. Zero new `as unknown as Instr`.
3. Every retained cast has a `// computed-op` or `// TODO(#bug)` marker.
4. `tsc --noEmit` clean, full vitest green, no test262 regression.
5. Surfaced-real-error list attached to the PR (even if empty).
