---
id: 6921
title: "IR middle-end pass correctness: inliner splices callee slots unremapped (miscompile / CE); DCE and GVN treat dyn.to_number and loose dyn.eq as pure (drops valueOf / throws)"
status: done
sprint: current
created: 2026-10-08
updated: 2026-10-08
completed: 2026-10-08
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: compiler-internals
goal: ir-full-coverage
related: [3518, 6865, 6920]
assignee: "ttraenkler/claude-session-c-inliner-slot-capture-20261008"
---

# #6921 — IR middle-end pass correctness (Session C)

Two target-neutral middle-end defects on main `8452732f0b`, both reproduced
through the public `compile()` API on the default (gc / js-host) target and on
`--target standalone`. Both are in `src/ir/passes/*` / `src/ir/analysis/*`,
which import no backend code (`src/ir/passes/*.ts` import only
`../nodes|builder|analysis|callable-bindings|string-runtime|type-key|
../../shared/contracts|../../env`), so one fix serves every target that runs
the passes.

Claims on upstream `issue-assignments` (branch
`claude/ir-migration-completion-lf3fz0`): `6921:inliner-slot-capture`
(owner `ttraenkler/claude-session-c-inliner-slot-capture-20261008`) and
`6921:coercing-dyn-effects`
(owner `ttraenkler/claude-session-c-coercing-dyn-effects-20261008`).

Raw base-arm evidence (verbatim probe outputs, probe sources, runner):
`plan/log/6921-ir-pass-correctness/base-8452732f0b.log.txt`. Re-verified on this
worktree at `8452732f0b`, node `v22.22.0`, 2026-10-08. The runner compiles each
probe on four lanes — `gc-IR` (`experimentalIR: true`, the default),
`gc-legacy` (`experimentalIR: false`), `linear` (`target: "linear"`),
`standalone` (`target: "standalone"`) — with `trackIrOutcomes: true`, prints
`irOutcomes` as `name:kind[IR][legacy]`, instantiates via
`buildImports`/`instantiateWasm` from `src/runtime.ts`, and calls the export.

## Problem

### D1 — `inlineSmall` splices callee `slot.read` / `slot.write` into the caller without remapping slot indices

Repro `t10.ts` (a helper with a mutable `let`, inlined into a caller that has
its own mutable `let`):

```ts
function g(a: number): number {
  let x = a;
  x = x * 2;
  return x + 1;
}
export function main(): number {
  let s = 100;
  s = s + 5;
  const r = g(3);
  return s * 1000 + r;
}
```

| lane | `main()` | IR outcome |
| --- | --- | --- |
| node | **105007** | — |
| gc-legacy | 105007 | — |
| linear | 105007 | (no IR outcomes — see "Linear is out of scope") |
| **gc-IR (default)** | **6007** | `g:emitted[IR] main:emitted[IR]` |
| **standalone** | **6007** | `g:emitted[IR] main:emitted[IR]` |

`g`'s body writes callee slot 0 (`x`), which after splicing is the caller's
slot 0 (`s`): `s` becomes `6`, so `6 * 1000 + 7 = 6007`. Silent wrong answer,
default flags.

Variant `t11.ts` — the mutable state is a *parameter* (`a = a * 2`), and the
caller has no slots at all:

```ts
function g(a: number): number { a = a * 2; return a + 1; }
export function main(): number { const r = g(3); return r * 10; }
export function loop(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) acc = acc + g(i);
  return acc;
}
```

| lane | `main()` / `loop(5)` |
| --- | --- |
| node, gc-legacy, linear | 70 / 25 |
| **gc-IR, standalone** | **COMPILE FAIL** `IR path failed for main: post-inline verify: slot.write slot index 0 out of bounds (function has 0 slots); slot.read slot index 0 out of bounds (function has 0 slots); …` |

The whole module fails to compile (not a demote) because `main` is IR-first and
`integration.ts:4063` turns the post-inline verifier errors into a hard error.

Negative control `t12.ts` (same `g`, caller is only `loop`): all lanes return
25 and `loop:emitted[IR]` — the inliner does not run into a caller with a
nested buffer (`for.loop`), so the bug needs a *flat* caller
(`inlineIntoFunction`, `src/ir/passes/inline-small.ts:199-216`).

Cause:

- `canInline` (`src/ir/passes/inline-small.ts:368-446`) rejects
  body-bearing instrs (`forof.*`, `try`, loops, `if`, `switch`, …) and
  `raw.wasm`, but a top-level `slot.read` / `slot.write` passes. The #1374
  comment there already names "slot migration" as the missing piece.
- `renameInstrOperands` (`inline-small.ts:852-857`) returns `slot.read`
  unchanged and renames only `slot.write.value`; `slotIndex` is copied verbatim.
- The caller's `IrFunction.slots` (`src/ir/core/nodes.ts:1890`) is never
  extended; `inlineIntoFunction` returns `{ ...caller, blocks, valueCount }`.
- Slot-bearing single-block callees are ordinary: a mutable `let`
  (`from-ast.ts` ~L4330) and a reassigned parameter
  (`lowerMutableParameterStorage`, `from-ast.ts:1370`) both allocate slots.
- The verifier does know the invariant — `src/ir/runtime/verify.ts:2843`
  reports the out-of-bounds index — which is why `t11` fails loudly while `t10`
  (caller has a slot 0) is silently wrong.

Reached from both drivers: `inlineSmall` at `src/ir/integration.ts:4022`
(historical/whole-program integration) and in `optimizePreparedIrProgramIr`
(`src/ir/program-middleend-ir.ts`, the prepared route).

### D2 — `dyn.to_number` and loose `dyn.eq` are classified pure, so DCE drops observable `valueOf` / ToPrimitive calls and throws

Repro `t9.ts`, called from JS with `(globalThis.__c = 0, { valueOf() { globalThis.__c++; return 10 } })`:

```ts
export function tonum(o: any): number { +o; return 1; }
export function eqq(o: any): number { o == 1; return 1; }
export function twice(o: any): number { return (+o) + (+o); }
```

| lane | `tonum(o)` | `eqq(o)` | throwing `valueOf` in `tonum` |
| --- | --- | --- | --- |
| node | 1, **c=1** | 1, **c=1** | throws |
| gc-legacy | 1, c=1 | 1, c=1 | `THREW boom` |
| **gc-IR (default)** | 1, **c=0** | 1, **c=0** | **returns 1, no throw** |
| standalone | 1, c=0 (host object not observable there — see tests) | 1, c=0 | returns 1 |

IR outcomes: `tonum:emitted[IR][legacy] eqq:emitted[IR][legacy] twice:emitted[IR][legacy]`.
The survey's IR dump (`.tmp/c-probe`, copy of `src` with a dump hook) shows
`dyn.to_number` (resp. `box` + `dyn.eq loose:true`) before hygiene and only
`const 1` after.

Cause:

- `src/ir/analysis/effects.ts:123-125` lists `dyn.truthy`, `dyn.to_number`,
  `dyn.eq` in the pure group ("no heap/control effect").
- `isSideEffecting` (`effects.ts:449-585`) does not list them, so
  `deadCode.shouldKeep` (`src/ir/passes/dead-code.ts:233-237`) removes them
  when the result is unused.
- Spec: ToNumber on an Object (§7.1.4 step 1 → ToPrimitive) and loose `==`
  with an Object operand (§7.2.14 steps 10-11 → ToPrimitive) run user code
  (`valueOf` / `toString` / `@@toPrimitive`) and may throw; `+Symbol()` and
  `+1n` throw TypeError. IsStrictlyEqual (§7.2.15) never calls into user code,
  so strict `dyn.eq` (`loose: false`) is genuinely pure. `dyn.truthy`
  (ToBoolean) is genuinely pure.
- The lowering agrees that these are calls: `dyn.to_number` emits the
  canonical `__any_to_f64` sequence (`src/ir/lower-generic.ts:1835-1856`);
  `dyn.eq` calls `__any_eq` / `__any_strict_eq` (`:1858+`, node doc
  `src/ir/core/dialect/js.ts:186-194`).

### D2b — with `JS2WASM_IR_GVN=1`, GVN merges repeated ToNumber

`twice(o)`: node / gc-legacy / gc-IR (GVN off) → 20, **c=2**;
**gc-IR with `JS2WASM_IR_GVN=1` → 20, c=1**. `gvn-core.ts:225` admits an
instruction when `effectsArePure(effectsOf(instr))`; same root cause as D2,
fixed by the same classification change. GVN is off by default
(`program-middleend.ts:33`, `gvnMode: "off"` unless `JS2WASM_IR_GVN`), so
this is latent in production but blocks any plan to turn GVN on.

### Linear is out of scope

`target: "linear"` does not run these passes. Evidence: the Linear overlay
`src/ir/backend/linear-integration.ts` imports nothing from `src/ir/passes/`
or `program-middleend*` (`grep -c "passes/\|program-middleend"` → 0); it goes
`lowerFunctionAstToIr` → lower. `compiler.ts:1093-1101` routes
`backend === "linear"` to `generateLinearModule`, not `generateModule`, so no
`irOutcomes` are reported for that lane (visible as the empty outcome column
above). Linear results in the tables are legacy `codegen-linear` and are
correct for D1. Linear therefore gets only a non-regression run of
`tests/cross-backend-diff.test.ts`.

## Implementation Plan

### Scope

- D1: slot-correct inlining in `src/ir/passes/inline-small.ts`
  (`canInline`, the splice loop in `inlineIntoFunction`, and the
  `slot.read`/`slot.write` arms of `renameInstrOperands` or a sibling
  slot-offset helper). Nothing else in that file.
- D2/D2b: purity classification of `dyn.to_number` / `dyn.eq` in
  `src/ir/analysis/effects.ts` (`effectsOf` switch + `isSideEffecting`).
  Nothing else in that file. No change to `dead-code.ts` or `gvn-core.ts` —
  both already consult these two predicates.
- New test file `tests/issue-6921-ir-middle-end-pass-correctness.test.ts`.
- No `src/codegen*`, `src/ir/backend/*`, `src/ir/lower*` or from-ast edits.
  The fix is target-neutral by construction; if an implementer finds a
  backend edit "needed", that is a different bug — stop and report.
- Dependencies: none on Session A (6920 root) or Session B (6865) work. The
  only recent commit on these files is `3e137c4e00` (2026-10-06, source
  provenance through preparation; already on the base). Open PR 5748 (hold)
  touches `inline-small.ts`; its diff is unrelated to slots and it is not a
  blocker.

### D1 design — remap callee slots into the caller (chosen), reject as fallback

**Chosen: append the callee's slots to the caller's slot table and offset the
spliced slot ops.** Justification: the slot-bearing callee shape (a helper with
a mutable `let` or a reassigned parameter) is exactly the small helper the
inliner exists for; rejecting it would silently lose inlining on the most
common helper form and would also leave the `#1374` comment's "slot migration"
debt in place. The remap is mechanically small because `canInline` already
guarantees the callee is one block with no nested buffers, so every slot op in
the callee is a top-level instruction and a flat walk suffices. Lowering
assigns slot N the Wasm local `params.length + ssaLocalCount + N`
(`src/ir/lower-generic.ts:796-801`), so appending slot defs is index-stable
for the caller's existing slots.

Steps, in `src/ir/passes/inline-small.ts`:

1. In `inlineIntoFunction`, keep a mutable `callerSlots: IrSlotDef[] =
   [...(caller.slots ?? [])]` next to `nextValueId`.
2. Per inlined call, **after** every bailout (`canInline`, budget, terminator
   shape, arity) and before the splice: `const slotOffset = callerSlots.length`;
   for each `def` of `callee.slots ?? []` push
   `{ index: slotOffset + def.index, name: \`${callee.name}$${def.name}\`, type: def.type }`.
   Callee slot defs are dense (`IrFunctionBuilder.declareSlot`,
   `src/ir/builder.ts:1533`); assert `def.index === i` and bail out of this
   call site (push the call unchanged) if not — never emit a partial table.
   Each splice of the same callee gets its own fresh slots, mirroring the
   fresh SSA ids; two inlined copies must not share state.
3. In the splice loop, after `renameAllInInstr`, apply
   `offsetSlotIndex(inst, slotOffset)`: for `slot.read`/`slot.write` return
   `{ ...inst, slotIndex: inst.slotIndex + slotOffset }`; identity for every
   other kind (no deep walk needed — nested buffers are rejected upstream;
   add a defensive `forEachNestedBuffer` assertion that throws if one appears,
   so a future `canInline` relaxation cannot silently reintroduce the bug).
4. Return `{ ...caller, blocks: newBlocks, valueCount: nextValueId, slots:
   callerSlots }` — only when `anyFuncChange`; the unchanged-caller
   early return stays byte-identical.
5. `canInline`: no new rejection for slot ops. Add one guard the remap cannot
   serve: reject a callee whose slots are referenced by anything other than
   top-level `slot.read`/`slot.write` (today impossible given the nested-buffer
   rejections, but assert it rather than assume it). Verify that generator /
   async callees cannot reach `canInline` (they carry `gen.*` / `async.*`
   instrs and a `__gen_buffer` slot, `nodes.ts:1915`); if a single-block one
   can, reject it explicitly — its slot indices are consumed by lowering
   fields, not only by slot ops.
6. `effects.ts` slot facets (`readSlots`/`writeSlots`) are per-function
   indices; no change needed, but the post-inline hygiene round in
   `integration.ts` / `program-middleend-ir.ts` re-derives them on the new
   function, so nothing stale survives.

**Fallback (only if step 1-5 fails a gate within the budget):** in
`canInline`, `if (callee.slots?.length) return false;` plus the same top-level
`slot.*` kind rejection. Record the measured inlining loss (count of
`unsupported`/kept-call sites across `playground/examples/` via
`check:ir-fallbacks --verbose`) in the PR if the fallback ships.

### D2 design — classification rule

In `src/ir/analysis/effects.ts`:

1. `effectsOf`: move `dyn.to_number` out of the pure group into the call-like
   group (`readsHeap = writesHeap = true`). For `dyn.eq`, split by
   `instr.loose`: `loose === true` → call-like; `loose === false` → pure
   (stays in the pure group). `dyn.truthy` stays pure.
2. `isSideEffecting`: add `i.kind === "dyn.to_number"` and
   `(i.kind === "dyn.eq" && i.loose)`, with a comment citing §7.1.4 / §7.2.14
   step 10-11 (ToPrimitive runs user code and may throw) and §7.2.15 (strict is
   observation-free).
3. **Operand refinement is deliberately not in this slice.** `effectsOf(instr,
   cache)` sees only the instruction; the operand's `tag` refinement lives on
   the *producer's* `resultType` (`src/ir/core/types.ts:422`,
   `{ kind: "dynamic", tag? }`) and `effectsOf` has no def table. Making
   "pure when the operand's tag proves a primitive partition" precise needs
   a per-function `typeOf` threaded into `effectsOf`/`isSideEffecting` (both
   are called from `dead-code.ts`, `gvn-core.ts`, `simplify-cfg`/scheduling
   consumers). Ship the unconditional rule first; the refinement is a
   follow-up with its own measurement (see below).
4. D2b is closed by (1): `gvn-core.ts:225` admits only
   `effectsArePure(effectsOf(instr))`, and `effectsArePure` (`effects.ts:303`)
   is false once `readsHeap`/`writesHeap` is set.

### Order-preservation constraints

- Emitted Wasm for every function that contains **no** `slot.*`-bearing
  inlined callee and **no** `dyn.to_number` / loose `dyn.eq` must be
  byte-identical to base. Check with the existing identity suites
  (`tests/issue-3518-lowering-analysis-preservation.test.ts`,
  `tests/issue-3525-source-map-safe-passes.test.ts`) and a WAT diff of three
  `playground/examples/` programs chosen by the implementer and named in the
  PR.
- Inlined copies keep instruction order; the slot-offset rewrite touches only
  `slotIndex`. `renameAllInInstr`'s result/operand renaming is unchanged.
- Making `dyn.to_number` / loose `dyn.eq` call-like also makes them ordering
  barriers for `effectsConflict`; that is the correct JS semantics (ToPrimitive
  may mutate the heap) and no pass may reorder them across heap writes.
- `check:ir-fallbacks`: no unintended bucket may grow. D1 removes a hard CE
  (it can only lower counts); D2 changes DCE output, not selection.

### Acceptance criteria

- [ ] `t10.main()` → 105007 and `t11.main()` → 70, `t11.loop(5)` → 25 on the
      default target and on `target: "standalone"`, with `irOutcomes` showing
      `g`, `main` (and `loop`) `kind === "emitted"`, `irBodyEmitted === true`.
- [ ] Negative control: a slot-free single-block helper is still inlined
      (observable: the caller's compiled module has no call to the helper's
      function index, or the `irOutcomes`/`check:ir-fallbacks --verbose` count
      of kept call sites for the fixture is unchanged from base — pick one and
      cite the base number in the PR).
- [ ] `tonum(o)` and `eqq(o)` call `valueOf` exactly once on the default
      target (host object counter, as in the probe); a throwing `valueOf`
      propagates. `twice(o)` calls it exactly twice with and without
      `JS2WASM_IR_GVN=1`.
- [ ] Pass-level: `deadCode()` keeps an unused `dyn.to_number` and an unused
      loose `dyn.eq`, and still **removes** an unused strict `dyn.eq` and an
      unused `dyn.truthy` (negative control, measured by instruction count
      before/after on a builder-constructed function).
- [ ] `effectsArePure(effectsOf(dyn.eq{loose:false}))` is `true`;
      `…(dyn.to_number)` and `…(dyn.eq{loose:true})` are `false`.
- [ ] Standalone: `tonum`/`eqq`/`twice` compile, run IR-emitted, and return the
      same values as base (1 / 1 / NaN for a non-numeric carrier); the host
      counter is **not** an observable there, so standalone relies on the
      pass-level test plus this non-regression.
- [ ] `tests/cross-backend-diff.test.ts` unchanged green;
      `expectLinearUnsupported` count unchanged (Linear non-regression only).
- [ ] All gates below green, including `LOC_GATE_BASE` against upstream main.

### Regression tests

`tests/issue-6921-ir-middle-end-pass-correctness.test.ts`, compiling real
source through the public `compile()`:

- IR-path assertion: follow `tests/issue-4514.test.ts:36-56` — `compile(src,
  { fileName, trackIrOutcomes: true, ...(standalone ? { target:
  "standalone" } : {}) })`, find the unit by `displayName`, assert `kind ===
  "emitted"` and `irBodyEmitted === true`. A test that passes with the unit
  demoted to legacy proves nothing, so this assertion is mandatory on every
  positive case.
- Instantiation: `buildImports` + `instantiateWasm` from `src/runtime.ts`
  (as in `tests/ir-gvn.test.ts:36-38` and the probe runner).
- Positive cases (sources **unchanged** from the probes): `t10` (105007),
  `t11` `main`/`loop` (70 / 25), on `gc` and `standalone`; `t9` `tonum`,
  `eqq`, `twice` with a counting host object on `gc`, plus a throwing
  `valueOf` for `tonum`; `twice` additionally under `JS2WASM_IR_GVN=1`
  (`vi.stubEnv`, restored in `afterEach` as `tests/ir-gvn.test.ts` does).
- Negative controls: (a) slot-free helper still inlined (see acceptance);
  (b) `t12`-shape caller with a loop still returns 25 and is IR-emitted;
  (c) pass-level `deadCode` on `IrFunctionBuilder`-built functions
  (`src/ir/builder.ts`: `emitDynToNumber` :663, `emitDynEq` :692,
  `emitDynTruthy` :635; construction pattern in `tests/issue-3297.test.ts:72-112`)
  asserting instruction counts: unused strict `dyn.eq` / `dyn.truthy` removed,
  unused `dyn.to_number` / loose `dyn.eq` kept.
- Expected values come from running the same source in node inside the test
  (import the fixture module or evaluate the function), not from literals
  typed by hand.

### Preserved failure evidence

Base-arm outputs on `8452732f0b` are committed as raw logs in
`plan/log/6921-ir-pass-correctness/` (`base-8452732f0b.log.txt`, probe sources as
`*.txt`, runner `run.mts.txt`). The fix PR adds `fixed-<sha>.log` from the
same commands so the before/after pair is in one directory.

### Gates to run before commit (chained, bare, never piped)

```bash
node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs \
  && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet \
  && npm run -s check:dead-exports \
  && npm test -- tests/issue-6921-ir-middle-end-pass-correctness.test.ts \
  && npm test -- tests/ir-gvn.test.ts \
  && npm test -- tests/issue-3518-typed-middleend-controls.test.ts \
  && npm test -- tests/issue-3525-source-map-safe-passes.test.ts \
  && npm test -- tests/issue-3518-inline-call-allocation.test.ts \
  && npm test -- tests/cross-backend-diff.test.ts \
  && pnpm run check:ir-fallbacks
```

Also `LOC_GATE_BASE=$(git rev-parse upstream/main) node scripts/check-loc-budget.mjs`
(same for `check-func-budget`). Any growth allowance goes in this file's
frontmatter, never in `scripts/*-baseline.json`.

## Follow-ups (unconfirmed, out of scope here)

- `dyn.member_get` is call-like in `effectsOf` (`effects.ts:176`) but absent
  from `isSideEffecting`; DCE would drop an unused `o.x` and its getter. Not
  reproducible today because the selector rejects the shape
  (`param-type-not-resolvable`); add it before S5.P/U2 opens it.
- D2 operand refinement: pure `dyn.to_number` / loose `dyn.eq` when the
  operand's `dynamic.tag` proves a primitive partition. Needs `typeOf`
  threading into the effect predicates; measure the DCE delta on
  `playground/examples/` first.
- `constant-fold.ts` `i32Arith` for `i32.mul` uses `(a * b) | 0`, not
  `Math.imul`; exact only because the #3758 from-ast guard admits f64-exact
  results. One-line hardening plus a test at `|a*b| > 2^53`.
- `constant-fold.ts` `tryFoldStringConcat` builds a `string.const` without
  `storage` / `materializer`; a `"foo" + "bar"` probe was fine, but the
  post-preparation hygiene rounds in `program-middleend-ir.ts` were not
  exercised.
- DCE keeps non-side-effecting null-result instrs (`vec.set`,
  `vec.set_length`) without seeding their operands live (the hazard noted at
  `effects.ts:474-478` for `super_init`). Unreachable today because element
  stores lower as `call __ir_vec_elem_set_*`.
- Outside the passes, observed on the legacy Linear backend: `c!.v` on `null`
  returns instead of throwing (`t14`/`t15`), and the valueOf/getter probes
  (`t3`/`t4`) fail Wasm validation. Linear-owner items, not IR.

## Implementation findings (2026-10-08, fed back into this plan)

Implemented in `1c25941500` (Claude Opus 5.5 High) plus the pin update
below. Before/after evidence is in `plan/log/6921-ir-pass-correctness/`:
`issue-6921-tests-base-8452732f0b.txt` (12 of 20 failing on base),
`issue-6921-tests-fixed.txt` (20/20), `nonregression-ab.txt`.

Where the plan above was wrong:

- **Standalone `eqq` acceptance cannot hold.** Base returned 1 only because DCE
  deleted the loose `==`. On standalone, a JS object or string passed through
  an `any` parameter already traps with `illegal cast` inside loose `==`
  whenever the result is used (`return o == 1 ? 1 : 0` traps on base too). Now
  the `==` is kept, so `eqq(obj)` traps on standalone. That is a standalone
  boundary/lowering defect outside these passes; the test checks standalone
  `eqq` with a number only. Follow-up issue needed.
- **Missing gate.** `tests/issue-3518-semantic-verification-ownership.test.ts`
  pins SHA-256 hashes of `effectsOf` and `isSideEffecting`. Any intentional
  semantic change to them must repin. The project lead decided (2026-10-08)
  that this PR repins exactly those two rows; predecessor hashes are kept in
  a comment and every other row is unchanged.
- **Stale paths.** Playground examples are under `website/playground/examples`;
  `tests/equivalence.test.ts` is now the directory `tests/equivalence/`.
- **Extra guard.** The inliner also declines callees whose slots are used by
  generator/async machinery, and throws if a slot op appears in a nested
  buffer.

Non-regression, exact pass/fail sets compared base vs fix:

| Population | Base | Fix |
| --- | --- | --- |
| 40 targeted test files | 576 pass / 705 fail | 575 / 706; the one change is the effects pin, now repinned |
| `tests/equivalence/` (224 files) | 1764 / 22 | 1764 / 22, identical |
| WAT, 13 playground examples × {gc, standalone} | — | 26/26 byte-identical |

The 705 base failures are pre-existing (mostly 3518 history/receipt suites).
Gates: loc-budget, func-budget, coercion-sites, oracle-ratchet, dead-exports,
`check:ir-fallbacks` exit 0, also with `LOC_GATE_BASE=8452732f0b`; `npm run
typecheck` 0 errors.

## Composition with PR 5748 and final qualification (2026-10-08)

The project lead reassigned `canInline`, the inliner slot splice and the two
`effects.ts` functions to Session C for this issue only (claims 5387, 2949,
3518:number-method-effects keep everything else). `canInline` now keeps
PR 5748's guards verbatim: callees with a generator buffer, a closure
subtype, an async plan, or a non-regular `funcKind` are refused, as is any
`closure.cap` in the callee body. Only 5748's slot rejection is replaced by
the slot remap. 5748's `asyncRuntime` check is dropped because that field
does not exist on main's `IrFunction`.

Final run on the composed source (file-copy A/B against `8452732f0b`, same
16 files: the #6921 suite, the 3518 semantic pin suite, and every test that
mentions the inliner):

| Arm | Result |
| --- | --- |
| base | 33 failed / 197 passed / 230 |
| composed | 20 failed / 210 passed / 230 |

No test fails only on the composed arm. The 13 that fail only on base are
the 12 #6921 cases plus the effects pin. The 20 shared failures pre-exist.
`node scripts/equivalence-gate.mjs`: 1748 passing, 22 known failures, no new
regressions. All ratchet gates pass, also with `LOC_GATE_BASE=8452732f0b`;
`npm run typecheck` is clean. Raw sets are in
`plan/log/6921-ir-pass-correctness/composed-*.txt`.
