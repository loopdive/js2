---
id: 5332
title: "REGRESSION on main: `export default <identifier>;` in a multi-file project fails to compile"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-05
completed: 2026-09-05
assignee: ttraenkler/senior-dev
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Symptom (live on `main`, not introduced by any open PR)

Any project of two or more files in which a **dependency** uses the
`export default <identifier>;` statement form fails to compile outright:

```
Codegen error: multi-prepared-module-init-census:terminal-join:
executable source ir-source:v1:0000000000000000:source:dep.js
lost its exact module-init terminal
```

Minimal reproduction (`allowJs`, `target: "gc"`, `platform: "node"`, via
`compileProject`):

```js
// dep.js
function g(input) { return 42; }
export default g;

// main.js
import g from './dep.js';
export function a() { return g(5); }
```

Measured shapes (same harness, one run each):

| shape | compiles |
| --- | --- |
| `export default g;` in a `.js` dep | **NO** |
| `export default g;` in a `.ts` dep | **NO** |
| `export default function g(…)` (inline) | yes |
| `export function g(…)` (named) | yes |
| `export { g as default }` | yes |

The return type is irrelevant — a dep that never returns `undefined` fails
identically.

## Cost, measured

jest dogfood suite, same machine, same day:

- `4946cf70fe` — **299/356**; `packages/jest-config/src/__tests__/stringToBytes.test.ts` **6/28**
- `6d0ae7531d` — **293/356**; `stringToBytes.test.ts` **0/28**, because
  `packages/jest-config/src/stringToBytes.ts` ends in `export default stringToBytes;`
  and the module no longer compiles at all.

**prettier is worse hit — this is the whole of its remaining collapse.** Measured
on `b67ab1fc0e` with the #5333 invalid-Wasm fix applied
(`node --import tsx tests/dogfood/prettier-upstream-suite.mjs`): `compile.validated`
**3 of 16**, **2/151** admitted tests. Thirteen of the sixteen modules raise this exact
`terminal-join` error and never produce a binary — `src/common/ast-path.js`,
`src/document/*`, `src/utils/*`. prettier was **61/151** at `4946cf70fe`. So of
prettier's 61 → 2 drop, #5333 accounts for none of the residual and this issue
accounts for all of it.

So this is a **−6 regression on the jest suite by itself**, and it additionally
**masks** [#5328](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5328-dynamic-dispatch-extern-result-dropped)
(worth a further +21 on the same file), whose only reproducing shape is exactly
the one that now fails to compile.

## Root cause — two sides disagree about what an `ExportAssignment` is

- `src/ir/identity.ts` (~line 903): an `ExportAssignment` gets an
  `addSupportUnit("export-assignment", …)` and is **NOT** pushed into
  `modulePopulation`. A source whose only module-level work is
  `export default g;` therefore gets **no `module-init` terminal unit**, so
  `planning-identity.ts` never records it in `moduleInitUnitIdBySourceFile`.
- `src/ir/module-init-plan.ts` (~line 453): every `ExportAssignment` **is**
  pushed as an `evaluation` (`kind: "export-assignment"`), so
  `executable = evaluations.length > 0` is **true**.
- `src/codegen/multi-prepared-module-init-census.ts` (~line 448) then asserts
  that an `executable` source has an exact module-init terminal, finds none, and
  raises `terminal-join`.

Introduced by the #3525 census work (`feat(ir): retain ordered multi-source
module-init census`, commit `2c18cd7a6f`) — the invariant is new; the underlying
disagreement between the two files is what it caught.

## Two candidate fixes (not attempted here — this belongs to the #3525 lane)

1. **Make the plan agree with identity.** Stop counting an `ExportAssignment` as
   a module-init evaluation, keeping the `pushExportIntent` call that follows it.
   Narrowest variant: only when the expression is a bare `Identifier`
   (a hoisted-binding reference that performs no runtime work), leaving
   `export default someCall()` alone. Risk to check: whether anything downstream
   relies on that evaluation existing to emit the expression.
2. **Make identity agree with the plan.** Push the `ExportAssignment` into
   `modulePopulation` so a module-init terminal is minted. More conservative for
   emission (it adds a unit rather than removing an evaluation), wider in its
   effect on the unit inventory.

The census's own re-check (`~line 626`) only compares `plan.unitId` against
`moduleInitUnitIdBySourceFile` and the terminal denominator, so either
reconciliation keeps it self-consistent; no evaluation COUNT is compared.

## Implementation notes (2026-09-05) — candidate 2, and WHY not candidate 1

**The diagnosis above is right about the mechanism and wrong about which side
is at fault. The plan is correct; identity was under-reporting.**

The decisive evidence is `src/codegen/declarations.ts` (the
`__default_expr_N` snapshot-cell arm, ~line 4011):

```ts
if (ts.isExportAssignment(stmt) && !stmt.isExportEquals &&
    (!isEntryFile || !ts.isIdentifier(stmt.expression)) && …) {
  …allocate the default-export snapshot globals…
  ctx.moduleInitStatements.push(stmt);   // ← REAL module-init work
```

So the direct front end really does queue `export default g;` into
`__module_init` for a linked module, and emits a `global.set` for it.
`reconcileIrModuleInitPlan` compares the plan's evaluation order against
**exactly that queue** (`moduleStatements: ctx.moduleInitStatements`), which is
why `buildIrModuleInitPlan` records an `export-assignment` evaluation. Removing
that evaluation (candidate 1) would have made the plan **lie about work that is
emitted**, and the lie is load-bearing: `planMultiPreparedModuleInit` admits M2
only when `executable.length === 1`, so suppressing one source's executability
can promote a *different* source to sole contributor and silently drop the
export-assignment write from the emitted `__module_init`. Candidate 1 also does
not even fix the bug — it was scoped to a bare `Identifier`, and
`export default 41 + 1;` in a two-file project fails identically (measured).
The entry file fails too, not only dependencies.

Taken: **candidate 2 — mint the terminal** (3 source files, +52/−5).

- `src/ir/module-init.ts` — new `moduleInitExportAssignment()` and
  `sourceOwnsModuleInitUnit()`, with the full rationale. All the mechanism
  lives here so neither god-file grows.
- `src/ir/identity.ts` — the module-init terminal's anchor falls back to the
  export assignment, so the terminal is minted. The scanned population is
  **unchanged**: the statement keeps its own `export-assignment` support unit.
- `src/ir/select-identity.ts` — `sourceHasModuleInitUnit` shares the one
  predicate. This is required, not tidiness: `assessIdentityModuleInit` raises
  `invalid-module-init` for an inventory terminal the selector did not predict,
  so minting in identity alone trades one hard error for another.

**Why this does not move emission.** The export assignment is deliberately kept
OUT of `collectModuleInitPopulation` — that population becomes a synthetic
function BODY (`makeModuleInitSynthetic`), and an export assignment is not a
statement that can appear in one. An export-assignment-only source therefore
still reports `assessModuleInit → {stmtCount: 0, reason: null}`, and every
module-init consumer requires `stmtCount > 0`, so no IR body is ever claimed and
the direct path stays the emitter. Confirmed empirically: the three shapes that
already compiled (`export default function g`, `export { g as default }`,
`export default g` beside another module statement) return identical values
before and after.

The alternative reading of candidate 2 — adding the statement to
`collectModuleInitPopulation` itself — was rejected: it would force
`body-shape-rejected` on every source that has both real module statements and
an export assignment, which is an IR-adoption regression and an
`ir-fallback-baseline` growth for no behavioural gain.

`missing-module-init-unit` stays in the plan as a fail-closed guard; with the
two predicates aligned, no ordinary source shape reaches it any more. The
`#3523` test rung that pinned that gap for `export default sideEffect();` was
pinning this defect, and now asserts the terminal joins instead.

### Measured, A/B at one head (`02ae5866be`, file-copy swap, same machine)

The regression was **much wider than the report** — five suites beyond jest and
prettier were affected, three of them scoring **zero**:

| suite | before | after | delta |
| --- | --- | --- | --- |
| prettier | 2/151 | **101/151** | +99 |
| axios | 116/231 | **200/231** | +84 |
| uuid | 1/75 | **75/75** | +74 |
| lodash | 0/62 | **53/62** | +53 |
| clsx | 0/32 | **32/32** | +32 |
| jest | 302/356 | **329/356** | +27 |
| stylelint | 106/108 | **108/108** | +2 |
| cookie | 63740/63740 | 63740/63740 | 0 |
| hono | 244/324 | 244/324 | 0 |
| redux | 61/82 | 61/82 | 0 |
| three | 17/18 | 17/18 | 0 |
| webpack | 16/16 | 16/16 | 0 |
| tailwindcss | 13/13 | 13/13 | 0 |
| marked | 9/30 | 9/30 | 0 |
| styled-components | 9/9 | 9/9 | 0 |
| jsdom | 6/6 | 6/6 | 0 |
| moment | 0/10 | 0/10 | 0 |

**+371 admitted tests, no suite regressed.** `moment` stays at 0/10 for a
**different**, unrelated cause — all 6 of its modules compile but none
validates: `Compiling function #721:"__closure_47" failed: call[25] expected
type (ref null 84), found struct.get of type i32`. No census error appears
anywhere in its report, before or after. That is someone else's regression and
is untouched here.

## Related

`tests/issue-5328-dynamic-dispatch-extern-result.test.ts` detects this exact
compile error and **skips with a pointer to this issue**, so #5328's fix can
land now and its assertions start enforcing the moment this is fixed. #5328
merged first (PR #5615); with this fix its two tests no longer skip and pass —
that is where 21 of jest's +27 come from.
