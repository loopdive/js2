---
id: 7369
title: "Prepared IR path: a native RegExp provider (pure VM bodies, then create / test / exec)"
status: in-progress
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir, compiler
goal: ir-full-coverage
depends_on: []
related: [7354, 682, 1539, 7364]
---

# #7369 — Prepared IR path: a native RegExp provider

## Problem

A RegExp on the Prepared whole-program path (the IR-only path the site
measures, #7354) needs a native provider: there is no JS host to construct one,
and nothing on that path can call the in-module engine.

The engine exists (#682, #1539): a pattern compiler in TypeScript and a
backtracking VM written as Wasm. The compiler half is pure. The runtime half
was not: the VM `__regex_run`, its class matcher, the search loop
`__regex_search` and the `$NativeRegExp` struct were all emitted by functions
that take a `CodegenContext` (the legacy compiler's module state). The Prepared
path has no `CodegenContext`, so it could not register any of them.

Measured on main `ee3fcdd610` with the S9 stand-in census (2026-11-19): **259
ES5 test262 files crashed on a RegExp** on the Prepared path: 220 on `.exec`,
32 on `.test`, 6 on `.source`, 1 on both `.exec` and `.test`. #7364 turns those
crashes into named refusals; this issue makes them compile.

## Implementation Plan

Three steps. Each lists where the code lives, what it reuses, the duplicate it
removes, and the code-quality criterion a reviewer checks next to correctness.

### R0 — extract the runtime emitters into pure body builders (this PR)

No behaviour change: the compiled output is byte-identical.

- **Target modules** (`native-runtime` and `runtime-contracts` layers of
  `scripts/compiler-boundaries.json`):
  - `src/runtime/wasmgc/values/regexp-vm-bodies.ts`:
    `buildRegExpClassMatchBody`, `buildRegExpRunBody` (entry, main loop,
    dispatch chain).
  - `src/runtime/wasmgc/values/regexp-vm-arms.ts`: the opcode arms of
    `__regex_run`, its local indices and its operands type.
  - `src/runtime/wasmgc/values/regexp-search-body.ts`: `buildRegExpSearchBody`.
  - `src/runtime/wasmgc/values/regexp-carrier-layouts.ts`: the `$NativeRegExp`
    struct, its field indices, and the backtrack frame struct and array.
  - `src/runtime/contracts/regexp-bytecode.ts`: the opcode enum, the
    instruction width, the literal-alternation marker and the step-budget
    numbers.
- **Shape.** `build<Thing>Body(operands: Readonly<<Thing>Operands>)` returns
  `{ locals, body }`. Operands are type, function and global indices, plus one
  flag and the caller-owned instruction sequences listed below. No
  `CodegenContext`, no checker, no import from `src/codegen`.
- **Reuses.** `registerStructType` (`src/codegen/registry/types.ts`) for both
  struct registrations, in place of two hand-written copies of it. The
  `regex/{parse,compile,unicode,casefold}.ts` compiler half is untouched.
- **Adapters.** `ensureRegexRun`, `emitClassMatch`, `ensureRegexSearch` and
  `ensureFrameTypes` stay in `src/codegen/native-regex.ts`, and
  `ensureStandaloneRegExpStruct` in `src/codegen/regexp-standalone.ts`. Each
  resolves indices from `ctx`, calls the builder and registers exactly as
  before: same names, same order of type, global and function registration,
  same locals.
- **Duplicates removed.**
  - The VM, class-matcher and search bodies are moved, not copied.
  - `STANDALONE_REGEXP_STRUCT_NAME` was declared twice
    (`regexp-standalone.ts`, `string-isregexp-guard.ts`); both now import
    `NATIVE_REGEXP_STRUCT_NAME`.
  - `host-regexp-search.ts` repeated three `RE_FIELD_*` indices "so this helper
    does not import the RegExp god-file"; it now imports them from the layout.
  - The `-1` "budget exhausted" result was produced in `linear-search.ts` and
    consumed through two instruction-returning helpers; it is now one constant,
    `REGEXP_RUN_BUDGET_EXHAUSTED`, written by the VM body and read by the search
    body.
- **Three things the brief did not foresee**, decided here:
  1. *The opcode numbering had to move.* The VM body dispatches on `ReOp`, which
     lived in `src/codegen/regex/bytecode.ts`; the `native-runtime` layer may
     not import `src/codegen`. The numbering is a contract between the compiler
     and the VM, so it now lives in `src/runtime/contracts/regexp-bytecode.ts`.
     `bytecode.ts` and `vm.ts` re-export the moved names, so no importer
     changed. The alternative, passing the opcode table in as an operand, would
     leave R1's binder unable to reach it for the same layering reason.
  2. *Three body files instead of one.* The function budget is 300 lines and
     the file budget 1,500. `__regex_run` alone is about 1,300 lines, so its
     arms are module-level functions in their own file, and the search loop has
     its own file because its local indices (`CAPS = 8`, `PC = 10`) collide
     with the VM's (`CAPS = 7`, `PC = 10`) at module scope.
  3. *Two operands are instruction sequences, not indices.* `stepCapThrow` and
     `poisonThrow` build a JS error through the caller's error constructor and
     exception tag. `indexedLiteralAlt` is the matcher for a program
     representation only the legacy runtime pattern compiler produces
     (`regex-anchored-alt-index.ts`); the search body splices it in and gives
     it the locals after its own.
- **Code-quality criterion.** No function over 300 lines and no file over
  1,500 in the new modules; `native-regex.ts` and `regexp-standalone.ts`
  shrink; no instruction literal exists in two places; the boundaries check
  accepts the new modules as `clean`; no budget grant.
- **Correctness criterion.** `scripts/check-regexp-byte-identity.mjs` reports
  0 differences between `origin/main` and the branch over every test262 file
  that mentions a RegExp, for the default, `standalone` and `linear` targets.

### R1 — `js.regexp.create` and `js.regexp.test`

- **Target modules.**
  - `src/ir/runtime/regexp-callables.ts` (new): the two callable contracts,
    next to `vector-callables.ts` and `ordinary-object-callables.ts` and in
    their shape.
  - A realm row per callable in the `ADAPTERS` table of
    `src/backend/wasmgc/resources/native-source-objects.ts` (lane S3's binding
    arm, branch `claude/7354-realm`), in that table's row shape
    `{ signature, body(dependencies, fill) }`. The row resolves the R0 operands
    from the physical ledger and calls the R0 builders.
  - Admission: `src/ir/regexp-literal-admission.ts` decides which literals the
    Prepared producer lowers to `js.regexp.create`.
- **Reuses.** The R0 builders and layouts; the shared admission rule
  `src/ir/regexp-literal-admission.ts` (branch `claude/7354-crashes`, #7364),
  so the Prepared producer and the selector ask one question; the pattern
  compiler `compilePattern`.
- **Open point to settle first.** The pattern compiler is in `src/codegen/regex`.
  A clean-layer binder cannot import it, exactly as in R0 item 1. Either the
  compiler half moves below the backend as a unit, or `create` receives the
  compiled program as a constant from an unmigrated module. Decide before
  writing the row; do not import `src/codegen` from the backend.
- **Duplicate removed.** The Wasm signatures of `__regex_run`,
  `__regex_class_match` and `__regex_search` are written out in the three
  legacy adapters. When the binding row needs them too, they move into one
  signature owner beside the bodies (as `numberFormatSignatures` does for
  number formatting) and both callers use it. `declare…Type` variants of the
  layouts (ledger keys instead of indices, as in `bigint-carrier-layouts.ts`)
  are added at the same moment, not before.
- **Code-quality criterion.** One admission rule, one signature owner, no
  second copy of any body; the row has the same fields and helper pattern as
  its siblings in `ADAPTERS`; no new branch in `from-ast.ts` beyond the call to
  the shared rule.
- **Correctness criterion.** The 32 `.test` files compile and run on
  `TEST262_COMPILER_PATH=ir`; the yield is measured on main at that date, not
  taken from this plan.

### R2 — `js.regexp.exec`

- **Target modules.** `src/ir/runtime/regexp-callables.ts` (third contract) and
  its `ADAPTERS` row; the capture-array builder that today is
  `ensureRegexCaptureArray` in `native-regex.ts` is extracted the R0 way.
- **Depends on.** Prepared arrays (lane S13): `exec` returns an array with
  `index`, `input` and `groups`.
- **Reuses.** R1's contracts file, signature owner and row shape; S13's array
  carrier in place of the legacy match-vec struct where they agree.
- **Duplicate removed.** `ensureRegexMatchVecType` and
  `ensureRegexMatchFlatVecType` describe the match array for legacy only; if
  S13's carrier covers it, the legacy side stores that carrier and the two
  match-vec layouts go.
- **Code-quality criterion.** `exec` adds an arm beside `test`, not a second
  provider; the capture-array body is moved, not copied; nothing in the
  contract mentions a legacy slot type.
- **Correctness criterion.** The 220 `.exec` files and the one that uses both;
  the 6 `.source` files need a property read and are counted separately.

## Result (R0)

Measured 2026-11-19 on branch `claude/7369-regexp-vm-bodies`, base
`origin/main` `89e47482`.

**Byte identity.** `node scripts/check-regexp-byte-identity.mjs --base <origin/main
tree> --head . --jobs 1 --cache .tmp/bi-cache`: 2,691 files × 3 targets = 8,073
comparisons, **0 differences**.

| Target       | Compiled on base | Failed on base | Differ on head |
| ------------ | ---------------: | -------------: | -------------: |
| default      |            2,159 |            532 |              0 |
| `standalone` |            2,160 |            531 |              0 |
| `linear`     |            2,130 |            561 |              0 |

The script exits `INCONCLUSIVE` (code 2), not `IDENTICAL`, for one file:
`staging/sm/RegExp/regress-yarr-regexp.js` exhausts a 3 GB compiler heap on
both trees, so its process dies and all three of its outcomes are recorded as
`crash SIGABRT`. Compiled one target at a time with `.tmp/one.mjs`, `linear` is
identical on both trees (`bf29245d…`), and default and `standalone` run out of
heap on both trees. The file asks for `x{2147483648}`. That is a crash on
`main` already, in the compile-time half this PR does not touch. Net: 8,071
comparisons proven identical, 2 not comparable on either tree.

The first full run, at `--jobs 2` with V8's default heap and 150-file chunks,
died at the last base chunk on V8's heap limit. The script now gives each
compiler process a 3 GB heap and 100-file chunks. When a process dies, the
script reruns the file it died on alone, in a fresh process, and then the rest
of the chunk. `--cache` keys finished chunks by tree content, so a head-only
edit recompiles only the head.

**Tests.** The 65 `tests/*regex*` / `*regexp*` files, `npx vitest run
--maxWorkers=1`, on the branch and on the base tree: 1,133 tests, 1,084 pass and
the same 12 fail on both sides. The failure-set diff is empty.

**Size.** The new modules hold 2,433 lines; `src/` grows by a net 294.

| File                                                | Before | After |
| --------------------------------------------------- | -----: | ----: |
| `src/codegen/native-regex.ts`                       |  4,396 | 2,489 |
| `src/codegen/regexp-standalone.ts`                  |  6,659 | 6,616 |
| `src/codegen/regex/bytecode.ts`                     |    172 |   111 |
| `src/codegen/regex/vm.ts`                           |    313 |   303 |
| `src/codegen/regex-runtime/linear-search.ts`        |    539 |   500 |
| `src/codegen/regex-scratch-pool.ts`                 |    226 |   153 |
| `src/codegen/helpers/host-regexp-search.ts`         |    246 |   241 |
| `src/codegen/string-isregexp-guard.ts`              |    179 |   177 |
| `src/runtime/wasmgc/values/regexp-vm-arms.ts`       |      — | 1,041 |
| `src/runtime/wasmgc/values/regexp-vm-bodies.ts`     |      — |   647 |
| `src/runtime/wasmgc/values/regexp-search-body.ts`   |      — |   527 |
| `src/runtime/wasmgc/values/regexp-carrier-layouts.ts` |    — |   107 |
| `src/runtime/contracts/regexp-bytecode.ts`          |      — |   111 |

The largest new function is `rawLiteralAltSearch` at 172 lines, and no new file
exceeds 1,500 lines. The LOC and function budgets pass with no grant, against
both the merge base and `LOC_GATE_BASE=origin/main`.
