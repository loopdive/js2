---
id: 7622
title: "IR planning identity context is built only with experimentalIR or trackIrOutcomes, so a diagnostic flag changes the answer"
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
related: [7620, 7558]
---

# #7622 — the IR identity context gate makes IR-off namespace calls throw

## Problem

With `experimentalIR: false`, a call through a namespace (`d.bump()` behind `import * as d`, or `N.f()` on a
TypeScript `namespace`) throws a `WebAssembly.Exception`. Adding `trackIrOutcomes: true`, a diagnostic flag, makes the
same program return the right answer. Found while planning #7620 (side finding R1, also reported by S7).

### Repro

```ts
// entry.ts
import * as d from "./dep";
export function main(): number { d.bump(); return d.g * 10 + 3; }
// dep.ts
export let g = 1; export function bump(): void { g = 2; }
```

### Measured

Measured on 2026-11-28 on `ada18e6bb6` (head of PR #7558) and on origin/main `01c9284f78`, with node v22.23.5. The
two bases give identical answers. Probe: `.tmp/p7620/side.mts` in the c8-7620 worktree (`compileMulti` or `compile`,
then `main()`).

| program | node | IR on | IR off | IR off + `trackIrOutcomes: true` |
| --- | --- | --- | --- | --- |
| the repro above | 23 | 23 | throws | 23 |
| `import * as d; d.f(); return 5;` (dep exports only `f`) | 5 | 5 | throws | 5 |
| single file: `namespace N { export function f() { return 4; } }`, `return N.f() + 1` | 5 (TS semantics) | 5 | throws | 5 |
| `import { f } from "./dep"; return f() + 1;` (named import) | 5 | 5 | 5 | 5 |

Each cell is the same on standalone and on gc.

### Cause (read from the code, confirmed by the `trackIrOutcomes` column)

- `generateMultiModule` (`src/codegen/index.ts:9767`, condition at 9769-9777) and `generateModule` (`index.ts:5435`)
  build the IR planning identity context, and with it the Program ABI session, only when
  `options.experimentalIR || options.trackIrOutcomes`.
- Four exact callable lookups resolve a declaration to its function through
  `ctx.programAbiSourceCallables.identityContext`, and decline without it:
  - `tryRuntimeNamespaceMemberCall` (`src/codegen/expressions/calls.ts:2800`);
  - the function arm of `moduleSymbolNamespaceExports` (`src/codegen/module-namespace-value.ts:498-509`), which then
    declines the whole namespace object;
  - `currentNamespaceFunctionHandle` (`module-namespace-value.ts:756`);
  - `exactImportedTopLevelFunction` (`src/codegen/expressions/identifiers.ts:858`).
- With IR off, the static member call declines, the namespace object declines, and the receiver compiles to the null
  fallback, so the call throws. A named import survives because its call takes the name-keyed `funcMap` path.
- The lines are at `ada18e6bb6`.


## Implementation Plan

Measured on 2026-11-28 on origin/main `c00c91962d`, the head at the time. Line numbers below are on that head.

### Which build step is gated, and should not be

- **The step that should not be gated:** building the IR planning identity context, and with it the Program ABI
  session. Two sites gate it on `options?.experimentalIR || options?.trackIrOutcomes`:
  - `generateModule`: `src/codegen/index.ts:5426`;
  - `generateMultiModule`: `index.ts:9884`.
- **Why it should not be gated.** The identity context is not IR lowering. It is the declaration → unit → function
  map that exact legacy lookups need, so its presence must not depend on whether the IR overlay or telemetry is on.
- **What stays gated, unchanged:** the IR overlay itself.
  - `makeIrPlanningAuthority` (`index.ts:2968`) is passed `options?.experimentalIR`.
  - `initializeMultiPreparedProgram` sets `irProgramCallableCutoverEnabled` from `!!options?.experimentalIR`
    (`multi-prepared-callable-orchestration.ts:160`).
  - `overlayEnabled` is `!!options?.experimentalIR && !ctx.fast` (`multi-prepared-program.ts:464`).
- **The second, coupled gate.** `multi-prepared-program.ts:466` seals the body boundary for the "identity context
  without IR" case:
  `if (options?.trackIrOutcomes === true && options.experimentalIR !== true) owner.sealBodyBoundary();`.
  Its condition repeats the first gate's telemetry half.
  - Measured: un-gating only the two `index.ts` sites makes **every** IR-off `compileMulti` fail, 55 of 55 probe
    graphs, with `multi-prepared-program:completion-order: owner is collecting, expected body-boundary-sealed`.
  - So `:466` asks the value two lines above it, instead of re-deriving one: `if (!overlayEnabled)
    owner.sealBodyBoundary();`. `overlayEnabled` is hoisted into a local that both the owner argument and the seal
    use.
  - This adds one case the throwaway patch did not test: `fast` mode with `experimentalIR` on, where the overlay is
    already off and the owner now seals. The byte gate's IR-on × `fast` lane covers it.

**Change.** Three conditions:

1. `index.ts:5426` builds the context unconditionally.
2. `index.ts:9884` builds the context unconditionally.
3. `multi-prepared-program.ts:466` seals whenever `overlayEnabled` is false.

A throwaway patch (since reverted) made every row of the Measured table answer like
node with IR off: `nsImport_bump` 23, `import * as d; d.f()` 5, TS `namespace` 5. No `trackIrOutcomes` is needed.
Its third edit was the equivalent `options?.experimentalIR !== true`. It differs from `!overlayEnabled` only in
`fast` mode.

### Readers that change

These readers already exist; with the IR overlay off, they now see a context or session where they saw `undefined`.

**Exact declaration → function lookups** (`programAbiSourceCallables.identityContext`). Each declines today with IR
off; after the change it answers. This is the intended change.

- `tryRuntimeNamespaceMemberCall` (`expressions/calls.ts`);
- `moduleSymbolNamespaceExports`' function arm and `currentNamespaceFunctionHandle` (`module-namespace-value.ts`,
  three reads);
- `exactImportedTopLevelFunction` (`expressions/identifiers.ts`);
- `runtimeNamespaceFunctionValueReceiver`'s caller path (`property-access.ts`);
- `named-this-call.ts`, `declarations.ts` and `multi-prepared-string-leaf.ts` (one read each).

**IR-planning readers** of the same field. With IR off they are reached only if the overlay runs, and the overlay
stays gated:

- `ir-fnctor-parameter-planning.ts` (3 reads);
- `ir-imported-call-planning.ts`;
- `program-abi-source-callable-planning.ts` (3 reads).

**Program ABI session readers** (`ctx.programAbiGlobals` / `programAbiExports` / `programAbiCallables` /
`programAbiSession`, created whenever the session exists, `context/create-context.ts:521-530`). These now run with
IR off. The counts are from `grep` on `c00c91962d`:

- `program-abi-planning.ts` (7);
- `index.ts` (7);
- `module-global-registration.ts` (6), the `assertModuleBindingsOpen` checks;
- `multi-prepared-string-leaf.ts` (5);
- `program-abi-import-planning.ts` (4);
- `multi-prepared-module-init-batch.ts` (4);
- `program-abi-finalization.ts` (3);
- `multi-prepared-scalar-leaf.ts` (3);
- `compiler-support-abi.ts` (3);
- `vec-access-exports.ts`, `native-promise-number-boundary.ts`, `multi-prepared-fibonacci-pair.ts`,
  `ir-overlay-finalize.ts`, `ir-imported-call-planning.ts`, `identifier-module-storage.ts` (2 each);
- `vec-define-writeback.ts`, `property-access.ts`, `program-abi-declared-globals.ts`, `multi-prepared-program.ts`,
  `multi-prepared-module-init-census.ts` (1 each).

The byte measurement below is the evidence that, outside the namespace lookups, these readers do not change output.
It covers the corpus, not a proof for every reader. The PR keeps the list and checks each reader that the gate's
corpus does not reach.

### Measured gc byte effect

Measured with the throwaway patch on `c00c91962d`, `experimentalIR: false`, sha256 of the binary, base vs patched.
Probe: `.tmp/p7620/idhash.mts`.

| corpus | gc | standalone |
| --- | --- | --- |
| `website/playground/examples/**/*.ts` (13 files, `compile`) | 13 / 13 identical | 13 / 13 identical |
| test262 `language/block-scope` + `language/statements/switch`, script files with their harness includes prepended (256 files; 87 compile on both base and new, 169 fail to compile on both) | 87 / 87 identical | 87 / 87 identical |
| 55 multi-file probe graphs (`cases`, `cases6`, `cases10`, `c-cases`, `a-cases`, `y-cases`; `compileMulti`) | 40 identical, 15 changed | 40 identical, 15 changed |

- **The 15 changed graphs are exactly the namespace-function ones:** `gap1c_importStarFnOnly`, `nsImport_bump`,
  `N0_nsReassignedFn`, `N_nsReassignedFnOwnF`, `N0c_nsNoCall`, `Na_thirdFileF`, `N0_noReassign`, `ns_cycle_read`, and
  `y-cases` `N0`, `Nb_entry_own_f`, `Na_third_file_f`, `N_value`, `N_no_reassign`, `N0_before_swap`, `Y_ns`.
  These are the intended diffs: the namespace object or static member call now resolves.
- **Success set: equal.** No program that compiles on the base fails on the patched compiler. The count of
  "compiles only on the base" is 0 in each corpus: playground 0, test262 sample 0, graphs 0, on gc and standalone.
  Every compile error is a compile error on both.
- **The IR-on lane is unaffected by construction.** It already builds the context. Edit 3 changes nothing when the
  overlay is enabled, except `fast` mode (see above).
- **Compile time** for this corpus, one run each, IR off: 3 min 10 s base, 3 min 27 s patched, about +9 %. A single
  run is noisy, so the acceptance asks for a proper measurement.

### Not measured (the implementer measures these; see the acceptance criteria)

- S7's 389-file sample.
- lodash-es.
- The full equivalence suite.
- Compile time over three or more runs.

## Acceptance criteria

- **Pin test.** A new `tests/issue-7622-ir-identity-context.test.ts` holds the four rows above, × standalone/gc × {IR on, IR off,
  IR off + `trackIrOutcomes`}, and compares each with node's answer (TS semantics for the `namespace` row).
  - It is red on the base: the IR-off rows throw.
  - It is green after the fix.
  - Every row answers the same with and without `trackIrOutcomes`.
- **Equivalence suite first.** `node scripts/equivalence-gate.mjs` is the most important gate. It runs both on the
  base and on the change, and must report no new failure.
- **Success-set equality.** Every program that compiles on the base still compiles. The PR reports the count of
  programs that compile only on the base, per corpus; each count must be 0.
- **gc output byte-identical** for programs that use no namespace function call, base vs new, gc and standalone, IR
  off and on, plus IR on with `fast`:
  - S7's 389-file sample: S7's `.tmp/sample3.txt` (the copy #7530's plan names `.tmp/7530/sample3.txt`), the #7470
    single-file corpus;
  - the playground examples;
  - the test262 block-scope/switch sample above;
  - `tests/equivalence/`;
  - #7470's multi-file graphs.

  The expected diffs are listed in the PR: graphs with a namespace call of a function, as in the 15 above.
- **Compile time.** At least 3 runs each for base and new, on the corpus above. Report IR off and IR on separately,
  with the median and range. The IR-on delta must be about 0. The IR-off delta is reported against the measured
  single-run +9 %.
- **Code quality.**
  - One predicate governs "identity context present, IR overlay off": `overlayEnabled`, reused at `:466`, with no
    new flag.
  - No IR-only branch is added, and no second declaration → function map.
  - The budget gates pass.
  - An adversarial review verdict goes in the PR body.
- **No test262 regression** in the scoped `language/module-code|import|export` per-test diff, on standalone.
