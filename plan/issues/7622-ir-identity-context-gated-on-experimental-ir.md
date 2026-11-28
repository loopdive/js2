---
id: 7622
title: "IR planning identity context is built only with experimentalIR or trackIrOutcomes, so a diagnostic flag changes the answer"
status: done
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
completed: 2026-11-28
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

## Resolution

Fixed on `claude/7622-ir-identity-context-ungated`, merged up to origin/main `ea628a7874` (2026-11-28). Pin test:
`tests/issue-7622-ir-identity-context.test.ts` (4 programs × gc/standalone × IR on, IR off, IR off +
`trackIrOutcomes`, IR on + `fast`, IR off + `fast`, each checked against node). On the base 12 of 40 rows fail (the
three namespace rows × gc/standalone × IR off, IR off + `fast`); with the change 40 of 40 pass.

- `generateModule` and `generateMultiModule` build the identity context and the Program ABI session
  unconditionally. The two `irPlanningIdentityContext!` assertions went with the gate.
- **IR-only planning stays gated on `experimentalIR`, not on the context.** Three consumers used "the context
  exists" as their proxy for "IR is on":
  - the single-file module-init plan (`buildIrModuleInitPlan` + `reconcileIrModuleInitPlan`), an observer that only
    IR-first routing consumes;
  - the two #3522 forward-class finalizers (`finalizeForwardClassFieldLayouts`, `finalizeForwardClassCallableAbis`).
    Ungated, they changed IR-off bytes: a field naming a later class became `(ref null $Value)` instead of
    `externref` (`tests/issue-3522-ir-class-compile-once.test.ts`, 4 tests). Their own presence checks are gone.
  - IR off + `trackIrOutcomes` therefore now emits the same bytes as IR off.
- `createMultiPreparedProgramOwner` seals the body boundary when `experimentalIR` is off, not on `!overlayEnabled`.
  - **Why not `overlayEnabled`.** With IR on and `fast`, the overlay is off but `planMultiPreparedProgramEarlyRoutes`
    still runs, needs the owner `collecting`, and seals the boundary itself. Sealing on `!overlayEnabled` made all 55
    graphs fail to compile in that lane (`completion-order: owner is body-boundary-sealed, expected collecting`), and
    6 pin rows with it. So the seal fires only where the overlay is missing for a non-`fast` reason (lead's rule).
- Tests that pinned the old gate: `issue-3525-multi-prepared-program-census` (IR off without telemetry had no owner)
  and `issue-3520-context-integration` (IR off without telemetry built no inventory).

### Measured (2026-11-28, base `ea628a7874`, file-copy A/B, node v22.23.5, 4-core container)

Bytes, sha256 of the binary, base vs new. "only base" is the count of programs that compile on the base and not on
the change; it is 0 in every corpus, lane and target. gc and standalone give the same counts unless noted.

| corpus | IR off | IR on | IR on + `fast` | IR off + `fast` |
| --- | --- | --- | --- | --- |
| playground (13) | 13/13 identical | 13/13 identical | identical (gc 13; standalone 12, 1 CE on both) | 13/13 identical |
| test262 block-scope + switch (256; 84 compile) | 84/84 identical | 84/84 identical | 256 CE on both | 256 CE on both |
| test262 class/async/generator/arrow/for-of/try sample (490; 320 compile) | 316 identical, 4 changed | 320/320 identical | not run | not run |
| 55 multi-file graphs | 40 identical, 15 changed | 54/54 identical (1 CE on both) | 55/55 identical | 40 identical, 15 changed |
| IR-off toolchain compiles (runtime-eval interpreter, refusal provider, runtime provider, QuickJS adapter) | 3 identical, interpreter changed | — | — | — |

- **The 15 changed graphs** are exactly the 15 namespace-function graphs listed in the plan.
- **The 4 changed class programs** (wider sample: every 40th `language/{statements,expressions}/class` file, every
  3rd-15th of the other directories, with `assert.js` + `sta.js` + includes):
  - `statements/class/dstr/meth-static-dflt-ary-ptrn-rest-obj-prop-id.js` and
    `.../private-gen-meth-dflt-ary-ptrn-rest-obj-prop-id.js`: **throw on the base with IR off, pass with the
    change** (gc and standalone). The diff is only the order in which function-value wrappers are created. A bisect
    showed it comes from the Program ABI session itself, not from `ctx.irPlanningIdentityContext` or the source
    callable registries; the exact reader is not identified.
  - `expressions/class/accessor-name-static/literal-string-double-quote.js` and
    `.../private-accessor-name/inst-private-escape-sequence-ZWNJ.js`: pass on both. An unannotated setter
    parameter becomes the dynamic carrier (`externref`) instead of `(ref null 6)`. Cause:
    `resolveClassAccessorParameterType` (`class-bodies.ts`) reads `ctx.irPlanningIdentityContext`; hiding that field
    alone restores the base bytes. The 10-program probe's `a1.ts` (a class with a setter nested in a function) is
    the same reader.
- **The runtime-eval interpreter** (`buildRuntimeEvalProviderSource()`, compiled with IR off) changes from
  `21c32bb86895a312` (7,154,870 bytes) to `bdd4b624beb2babe` (7,155,044). The interpreter-backed unit tests pass
  with it: `issue-4376`, `issue-1102`, `issue-4197`, `issue-7190`, `issue-2928-refusal-provider`,
  `es5-standalone-harness-selftests` (96 pass). `issue-4162` (2), `issue-4737` (1) fail, and `issue-4504` times out
  in `beforeAll`, identically on the base.
- **Equivalence gate**, `SHARD=1..8/8` run in sequence and merged: base and new both 20 failing / 4,856 passing,
  the same 20 tests, all in the baseline; no new failure.
- **Other unit tests:** `issue-3523` passes; `issue-3522-ir-class-compile-once` has 3 failures, the same 3 on the
  base.

Compile time, 3 interleaved runs per side (base, new, base, new, ...), median (range), in seconds:

| corpus | IR off base | IR off new | delta | IR on base | IR on new | delta |
| --- | --- | --- | --- | --- | --- | --- |
| test262 block-scope + switch | 142.6 (140.0-145.9) | 155.6 (152.8-178.7) | +9.1 % | 168.4 (157.4-191.1) | 178.9 (164.3-194.2) | +6.3 % |
| playground | 6.3 (5.7-7.3) | 7.1 (6.8-7.9) | +13 % | 7.3 (6.4-8.1) | 7.2 (7.0-7.9) | -1.4 % |
| graphs | 14.0 (13.9-14.4) | 13.0 (11.5-14.3) | -6.9 % | 12.5 (12.3-13.8) | 13.0 (11.3-16.0) | +4.1 % |

- The IR-off delta (+9 % on the test262 sample) matches the plan's single-run +9 %. It is the cost of building the
  inventory, identity context and session for every compile.
- The IR-on code path is unchanged by construction (the context was already built), so its +6.3 % is noise: the
  runs overlap, and the paired per-run deltas are -2.4 %, +13.7 %, +1.6 %. A second implementer's jobs shared the
  4 cores for part of run 3.

### Follow-up: where the IR-off byte changes come from (2026-11-28, base origin/main `4aa8ea4c46`)

The lead chose to keep IR-off gc output byte-identical outside the 15 namespace graphs. Each remaining IR-off
change was traced to one reader with a temporary env-gated toggle: switching off only that reader on the new
compiler restores the base sha256 for exactly the programs it owns. A clean base worktree at `4aa8ea4c46` was the
comparison.

| IR-off change | reader | what it reads | answer on base: IR off / IR off + `trackIrOutcomes` / IR on | answer with the change |
| --- | --- | --- | --- | --- |
| 2 class setter tests + probe `a1.ts`: unannotated setter parameter `(ref null 6)` → `externref` | `resolveClassAccessorParameterType` (`class-bodies.ts`), branch `terminal?.containingTerminalOwnerId !== undefined` | `ctx.irPlanningIdentityContext` | pass / pass / pass | pass |
| 2 `class/dstr` tests: wrapper order | `compileExactAmbientShadowedModuleBinding` (#2176, `expressions/identifiers.ts`) | `ctx.programAbiGlobals?.moduleBinding(declaration)` (Program ABI session) | **throw** / pass / pass | pass |
| runtime-eval interpreter, +174 bytes | `declarationOwnsHandle` (`named-this-call.ts`, #3796) | `ctx.programAbiSourceCallables.identityContext`, the registry the namespace readers use | **throw** / pass / pass (repro below) | pass |

- **Setter.** CodegenContext has no "IR is on" signal. `experimentalIR` lives only in `CodegenOptions`
  (`context/types.ts:277`), and `createCodegenContext` copies no IR flag into the context. The selector's result
  does not exist yet when the reader runs: the reader runs inside `collectDeclarations` (`index.ts:5869`), and
  `planIrOverlay` runs later (`index.ts:5985`). So the only gate available is a new context field, which the lead
  must approve first.
- **Wrapper order is a real fix, not luck.** In the two `dstr` tests, TypeScript resolves the script's
  `let length = "outer"` to lib's ambient `length`. Without the session, #2176's exact read falls through to
  `tryEmitAmbientRegistryCollisionRead`, which reads `globalThis.length`. That materializes the native globalThis
  seed early, which is why the wrapper order moves. Deleting only the
  `assert.sameValue(length, "outer", …)` line makes base IR off pass. Base IR off + `trackIrOutcomes` passes, so on
  the base the diagnostic flag changes the answer: the bug class of this issue.
- **Interpreter.** The one new function is `__named_this_call_finishNodeAt_214`, the receiver trampoline for
  acorn's `finishNodeAt.call(this, …)`. Repro: `function f() { return this.v; } f.call({ v: 7 }) === 7` throws on
  base IR off, passes on base IR off + `trackIrOutcomes` and IR on, and passes with the change. It is the same
  registry lookup as the namespace fix, so no gate can keep it and the namespace fix apart without an IR signal.
- **Compile time (IR off, test262 block-scope + switch, 512 compiles).**
  - 5 interleaved runs per side: base 141.7 / 156.2 / 162.0 / 153.3 / 171.8 s, new 148.1 / 172.3 / 177.1 /
    192.5 / 187.8 s. Median 156.2 → 177.1 s (+13 %); new is slower in all 5 pairs. Not noise.
  - The identity build is not the cost: inventory 0.1 s, identity context 0.0 s, session and context creation 0.2 s
    over the 168 compiles that reach `generateModule`.
  - A CPU profile (one run per side, 144.7 → 166.6 s) puts the growth in Program ABI finalization, which now runs
    for IR-off compiles. `eliminateDeadLayoutAndPlanProgramAbi` grows +3.1 s; inside it `ProgramAbiSession.publish`
    takes 3.9 s (`buildSealedAbi` 2.7, `bindAndPublish` 2.3, `materializeTypeContract` 1.9, `sealPlan` 1.6,
    inclusive). Garbage collection grows +5.3 s. Nothing in an IR-off compile consumes the published ABI except the
    namespace and receiver lookups, which need the session only to answer `handleForUnit`.

### Open

- **Blocked on a lead decision: IR-off bytes are not identical outside namespace calls** (see the follow-up
  above). Gating the setter reader needs an "IR is on" field in `CodegenContext`, which does not exist. Gating the
  other two readers would keep two known wrong IR-off answers that `trackIrOutcomes` already fixes on the base.
- Program ABI finalization now runs in IR-off compiles (+13 % on the test262 sample). Not addressed.
- Other direct `ctx.irPlanningIdentityContext` readers (`async-*-planning.ts`, `prepared-class-body-cutover.ts`,
  `compiler-support-abi.ts`, `program-abi-fnctor-producer.ts`) were not audited one by one; the 490-file sample is
  the evidence for them.
- Not measured: S7's 389-file sample (`sample3.txt` is not on this machine), lodash-es, a byte comparison of
  `tests/equivalence/` sources, and the scoped test262 `language/module-code|import|export` diff. Note: the test262
  runner compiles with IR on by default, so only its IR-off sub-compiles (the eval interpreter and the QuickJS
  adapter) can move a verdict.
- The adversarial review for the PR body has not been run.
