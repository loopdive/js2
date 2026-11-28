---
id: 7624
title: "A block-level `class g {}` stops the module's own `let g` from getting a global"
status: ready
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7620, 7470]
---

# #7624 — a block-level class of the same name hides a module `let`

## Problem

When a function contains a block that declares `class g {}`, and the module itself declares `let g`, the module's
`g` gets no global. Reads of `g` then see the class object. It also fails in a single file. Found while planning #7620
(side finding R3).

### Repro

```ts
let g = 2;
export function main(): number { let r = 0; { class g {} r = 5; } return g * 10 + r; }
```

### Measured

Measured on 2026-11-28 on `ada18e6bb6` (head of PR #7558) and on origin/main `01c9284f78`, with node v22.23.5. The
two bases give identical answers. Probe: `.tmp/p7620/side.mts` in the c8-7620 worktree (`compile` for single-file
rows, `compileMulti` for the import row).

| program | node | IR on | IR off |
| --- | --- | --- | --- |
| the repro above | 25 | compile error | NaN |
| `const o = g;` read before the block, `return o * 10 + r` | 25 | compile error | NaN |
| the block's class is used: `r = new g().v()` (`v` returns 5) | 25 | compile error | NaN |
| `g` is an imported `let` (dep: `export let g = 2`) | 25 | 25 | 25 |
| `g` is a function-local `let` | 25 | 25 | 25 |

- Each cell is the same on standalone and on gc.
- `trackIrOutcomes` does not change any answer.
- The IR-on compile error is: `IR path failed for <module-init>: module-init: supported binding 'g' has no exact
  allocator-owned module global`.
- The second row (read before the block) is not #7620's gap 2: the repro, which has no early read, fails the same
  way.

### Cause (measured in the WAT, IR off, standalone)

- The module has no `__mod_g` global. `let g = 2` compiles to a local of `__module_init` (`(local $g f64)`).
- `main` reads `g` as the lazily built class singleton `__class_g`, and `* 10` turns that into NaN.
- The guard that drops the global:
  - On `ada18e6bb6` it is in `registerModuleGlobal` (`src/codegen/module-global-registration.ts:203`).
    `isClassOfScope` (`:265`) answers true when `ctx.classDeclarationMap` holds a class named `g` from the same
    source file, and the binding then gets no global (`:246`).
  - That test assumes a same-file class of that name is the module's top-level binding, whose singleton is its
    storage. Here the class is block-scoped inside `main`.
  - On main the guard is the bare-name `if (ctx.classSet.has(name)) return;` (`module-global-registration.ts:248`),
    which has no source check at all.
- An imported or function-local `g` is unaffected, because neither goes through module-global registration.
- Not measured: whether `classDeclarationMap` keying the nested class by bare name `g` also misroutes `new g()`
  elsewhere in the module.

## Acceptance criteria

- **Pin test.** A new `tests/issue-7624-*.test.ts` holds the five rows above, × standalone/gc × `experimentalIR`
  on/off, and compares each with node.
  - It is red on the base: the first three rows give NaN or a compile error.
  - It is green after the fix.
  - The test adds one row where the class is top-level (`class g {}` at module scope, no `let g`), which must keep
    working.
- **gc output byte-identical** for programs without a block-scoped class that shares a module binding's name, on the
  #7470 single-file corpus (389 files), base vs new.
- **No test262 regression** in the scoped `language/statements/class|language/block-scope` per-test diff, on
  standalone.
