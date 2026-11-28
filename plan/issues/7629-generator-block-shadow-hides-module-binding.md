---
id: 7629
title: "In a generator, a block-scoped `let` hides a same-named module binding for the whole generator"
status: ready
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7620, 7624]
---

# #7629 — generator block shadow hides a module binding

Split out of #7624 (B), which excludes generators because their bindings are lowered by a different mechanism.

## Problem

In a generator function, a nested block that declares `let g` makes every read of `g` in the generator, before or
after the block, read the block's binding instead of the module's `let g`. The block's binding is uninitialized there,
so the result is NaN.

### Measured

Measured on 2026-11-28 with node v22.23.5, on `ada18e6bb6` (head of PR #7558) and on origin/main `c00c91962d`.

- Single file, `compile`; `main` returns `gen().next().value`.
- Probe: `.tmp/p7620/{gen-cases.mjs,rows.mts}` in the c8-7620 worktree.
- Both bases, standalone and gc, and IR on and off all agree.

| row | generator body (module `let g = 2` where noted) | node | ours |
| --- | --- | --- | --- |
| `gen_early` | module `g`: `const o = g; { let g = 5; yield o * 10 + g; }` | 25 | NaN |
| `gen_after` | module `g`: `let r = 0; { let g = 5; r = g; } yield g * 10 + r;` | 25 | NaN |
| `gen_noshadow` (control) | module `g`: `const o = g; { let h = 5; yield o * 10 + h; }` | 25 | 25 |
| `gen_local_outer` (control) | generator-local `let g = 2`, then the `gen_after` block | 25 | 25 |
| `gen_sibling_blocks` (control) | `{ let h = 2; r = h * 10; } { let h = 5; r += h; } yield r;` | 25 | 25 |

So the defect needs an outer binding that is not a generator local. A shadow among the generator's own bindings is
handled.

### Cause (read from the code; not instrumented)

- Native generator lowering (`compileNativeGeneratorFunction`, `src/codegen/generators-native.ts`) does not use the
  ordinary function prologue (`hoistLetConstWithTdz`, block-entry install). It spills the generator's bindings into
  state fields keyed by **name**: `spillTypes: Map<string, ValType>` (`generators-native.ts:416`), filled from the
  `Map<string, …>` collectors at `:624-709` (`spillDecls`, `continuationSpillTypes`, …).
- A nested block's `let g` therefore gets a field named `g` for the whole generator.
- With no generator-local `g`, every read of `g` resolves to that field. Before the block's declaration has run, the
  field is uninitialized, so the reads give NaN.
- When the generator has its own outer `g`, both declarations meet in the same name-keyed machinery, and the
  existing shadow save/restore handles it.
- That last point is inferred from the `gen_local_outer` row, not traced.

This is the same defect as #7624's B1 (a block's binding visible outside its block), but in the generator lowering's
own name-keyed field table. #7624's declaration-keyed slots do not reach it.

## Acceptance criteria

- **Pin test (red → green).** A new `tests/issue-7629-generator-block-shadow.test.ts` holds the five rows, ×
  standalone/gc × `experimentalIR` on/off, compared with node.
  - `gen_early` and `gen_after` are red on both bases and green after.
  - The controls stay green.
- **Code quality.** The fix keys the nested declaration's spill field by declaration, in the same way #7624 keys
  block slots. It must not add a second name-keyed exception list.
- **gc output byte-identical** for generators without a block-scoped shadow of a non-local binding, on the #7470
  389-file sample and the test262 `language/statements/generators` + `language/expressions/generators` files that
  compile, base vs new.
- **No test262 regression** in the scoped per-test diff over those generator directories on standalone.
