---
id: 2956
title: "Linear backend consumes the IR front-end: wire the selector + LinearEmitter into generateLinearModule"
status: done
completed: 2026-08-16
sprint: 78
created: 2026-07-02
updated: 2026-08-18
assignee: ttraenkler/fable-epsilon
branch: symphony/porffor/2956-after-pr-3203
priority: medium
horizon: xl
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: ir, codegen-linear
language_feature: compiler-internals
goal: backend-agnostic-ir
depends_on: [2953, 2954]
related: [1585, 1713, 2710, 1852]
origin: "2026-07-02 July Fable audit §5 (production linear compilation consumes zero IR; #1585 is investigation-only)"
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/codegen-linear/runtime.ts
  - src/codegen-linear/index.ts
last_ci_retry_head: null
last_merged_pr: 3203
claimed_by: porffor-codex-developer
claimed_at: 2026-07-17T11:27:47.591Z
pr: 3232
---

# #2956 — the backend fork sits ABOVE the IR

## Problem

`--target linear` branches at `src/compiler.ts:861` and hands the **AST**
to `generateLinearModule` (src/codegen-linear/index.ts, 5.5k lines) — the
IR selector and from-ast never run for linear compiles. "Backends differ
only at lowering" is therefore true for **no shipping code path**: the
linear backend is a second direct AST→Wasm front-end (15.9k lines,
maintained but far behind on parity: fail-loud rejects for typeof/await/
spread/regex, no dynamic-value representation, no closures-via-IR).
#1585 (dual-target IR architecture) is the investigation umbrella; no
implementation issue existed.

## Approach (architect spec is the first deliverable)

Mirror the WasmGC overlay pattern (#2138 shape), not a big-bang port:

1. **Spec:** a linear `IrLowerResolver` twin — `integration.ts` is today
   hardwired to the WasmGC codegen context (imports 8 codegen modules,
   patches `ctx.mod.functions` slots). Extract the context-facing surface
   (funcMap/typeIdx/slot-patch/import registration) into an interface both
   backends implement. #2710 (late-bound module indices) reduces the
   index-shift hazard here.
2. **Slice 1:** for IR-claimed _numeric/control-flow_ functions under
   `--target linear`, build IR once and lower via LinearEmitter into the
   linear module's slots; everything else stays on the linear direct path
   (its own demote channel, bucketed + ratcheted like #1376).
3. **Slice 2+:** widen families as LinearEmitter grows (aggregates via
   codegen-linear/layout.ts, the #1852-G4 f64+tag dynamic cell, strings).
   Async/closures explicitly deferred (blocked on linear closure + Promise
   runtime — do not promise them here).

## Acceptance criteria

- Architect spec recorded here (resolver interface + slice map) before dev
  dispatch.
- A claimed numeric function compiles once via IR into the linear module;
  cross-backend corpus rows flip from expectLinearUnsupported to executed
  parity.
- Linear fallback reasons bucketed against a baseline (clone of
  check-ir-fallbacks), so parity progress banks.

## Implementation Plan (fable-arch, 2026-07-09 — the requested architect spec)

> Verified against `origin/main @ 928c85179`. Re-grep symbol anchors before
> editing (`generateLinearModule`, `compileIrPathFunctions`,
> `IrLowerResolver`, `LinearEmitter`). #2954 (LinearEmitter core-op
> coverage) is **done**; #2953 (pushRaw gap) is **in-progress** — slice L2
> below depends on the refcell/aggregate groups it moves behind the trait,
> but L0/L1 do not: they can start once #2953's _vec + core_ groups are
> stable (already true today).

### Current seam, precisely

- **Fork point**: `src/compiler.ts` (`useLinear = options.target ===
"linear"`, ~line 871) → `generateLinearModule(ast, opts)`
  (`src/codegen-linear/index.ts:74`). The IR planner never runs on this
  path.
- **The WasmGC integration** (`src/ir/integration.ts:131`
  `compileIrPathFunctions(ctx: CodegenContext, …)`) is hardwired to the
  WasmGC context: it imports ~20 `src/codegen/*` modules, and its
  `IrLowerResolver` implementation delegates every `resolve*` hook to the
  legacy WasmGC registries (`getOrRegisterVecType`, `ensureAnyValueType`,
  boxing/closure/refcell/class registries), then patches
  `ctx.mod.functions[localIdx].body` in place.
- **`IrLowerResolver`** (`src/ir/lower.ts:99-200`) is ALREADY the right
  abstraction boundary: `lower.ts` reaches the module exclusively through
  it (+ the `BackendEmitter` for op emission). Nothing in `lower.ts` needs
  to change for linear — what is missing is (a) a **linear implementation**
  of the resolver's Phase-1 subset, (b) a **slot/patch surface** on the
  linear module, and (c) a **capability gate** narrowing claims to what
  `LinearEmitter` can lower.
- **`LinearContext`** (`src/codegen-linear/context.ts:7`) already has the
  pieces the integration needs: `funcMap: Map<string, number>`,
  `numImportFuncs`, `mod.functions[]` (name-keyed slots registered at
  `index.ts:100-170`).

### Design decision: ONE integration, TWO context adapters (not a twin)

Do **not** clone `integration.ts` into a linear twin (2.6k lines of
selection/typeMap/report logic that would drift — the exact #2713 parity
bug class). Instead split `compileIrPathFunctions` into:

1. **Backend-neutral core** (stays in `integration.ts`): selection
   consumption, calleeTypes map, per-function `lowerFunctionAstToIr` →
   verify → passes → `lowerIrFunction`, error/report handling.
2. **A `IrBackendIntegration` adapter interface** — the context-facing
   surface the core calls:

```ts
export interface IrBackendIntegration {
  /** Backend identity — picks the BackendEmitter + legality profile (#1851). */
  readonly backend: IrBackendKind; // "wasmgc" | "linear"
  /** The resolver lower.ts consumes. Linear: Phase-1 subset (below). */
  readonly resolver: IrFromAstResolver & IrLowerResolver;
  /** Pre-allocated slot lookup (name → funcIdx); mirrors ctx.funcMap. */
  lookupFunc(name: string): number | undefined;
  numImportFuncs(): number;
  /** Replace the body/locals of a pre-allocated slot (the overwrite step). */
  patchFunction(localIdx: number, patch: { body: Instr[]; locals: ValType[] }): void;
  /** Late helper/import registration (linear: runtime.ts helpers; must
   *  follow the name-based repoint discipline — funcIdx shifts, #2710). */
  ensureHelper(name: string): number;
}
```

The existing WasmGC behavior becomes `WasmGcIntegration` (a thin wrapper
over today's code — behavior-identical, byte-identical refactor, proven
by the corpus hash harness `scripts/byte-diff-corpus.mts` from #2138).

3. **`LinearIntegration`** implements the adapter over `LinearContext`:
   - `resolver`: Phase-1 linear subset — `resolveFunc/resolveGlobal/
resolveType/internFuncType` over the linear module tables;
     `resolveString()` returns the linear string rep; **every optional
     hook (`resolveUnion/Boxed/Object/Closure/RefCell/Class/Vec…`) is
     initially ABSENT** — per the documented resolver contract, a function
     whose IR demands a missing hook fails at lowering, and the gate
     (below) must have rejected it first.
   - `patchFunction` writes `mod.functions[localIdx]` exactly like the
     WasmGC patch site (`integration.ts:718` family).

### The linear capability gate (what slice 1 claims)

Reuse two EXISTING mechanisms — do not write a new predicate family
(#2135's lesson):

- **Per-backend legality verifier (#1851, `src/ir/backend/legality.ts`)**:
  run the claimed function's IR through the linear legality profile
  _before_ lowering; any instr outside the profile → structured reject.
- **Reject reasons bucketed** into a NEW `scripts/linear-ir-baseline.json`
  ratchet (clone of `check:ir-fallbacks` — acceptance criterion 3), reason
  = the first illegal instr kind. This measures parity progress per family.

Slice-1 legal set = exactly what `LinearEmitter` implements post-#2954:
const/binary/unary/locals/globals/drop/select/return/unreachable/
if/br/br_if/block/loop/direct-call + vec len/get (reads). Everything else
(vec construction #1804-linear, aggregates, refcells, exceptions,
call_ref/closures, strings, dynamic/boxed) rejects to the linear direct
path — which remains the module driver and default.

### Slice map (each independently landable)

| #      | Slice                                                                                                                                                                                                                    | Scope                                                                                                | Gate                                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L0** | Adapter extraction (`IrBackendIntegration` + `WasmGcIntegration`) — refactor only                                                                                                                                        | `src/ir/integration.ts`; no linear code                                                              | byte-identical corpus hash (2,692-compile harness); full merge_group                                                                                 |
| **L1** | `LinearIntegration` + overlay wiring in `generateLinearModule` (after slot registration ≈ `index.ts:170`, before body finalization) behind `JS2WASM_LINEAR_IR=1`; legality-gated numeric/CF claims; the ratchet baseline | `codegen-linear/index.ts`, new `src/ir/backend/linear-integration.ts`, `scripts/check-linear-ir.mjs` | flag-off byte-identical; flag-on: cross-backend corpus rows (#1854 harness) flip `expectLinearUnsupported` → executed parity for claimed numeric fns |
| **L2** | Widen: vec construction (#1804 linear arm), refcells (needs #2953's group), aggregates via `codegen-linear/layout.ts`                                                                                                    | `linear-emitter.ts`, `linear-integration.ts`                                                         | ratchet decreases bank; differential harness rows                                                                                                    |
| **L3** | Strings (blocked on #2955 de-polymorph — the IR front-end currently builds string-mode-specific IR at 5 from-ast sites; linear must not inherit that fork)                                                               | after #2955                                                                                          | corpus string rows                                                                                                                                   |
| **L4** | Default-ON for the claimed families + fold the linear direct path's per-function reject list into the same ratchet                                                                                                       | `compiler.ts`                                                                                        | one soak window on main, then flip                                                                                                                   |

**Explicitly deferred (do not promise here):** closures/`call_ref` (linear
dispatches through a table — needs a table-based `emitCallRef` design),
exceptions (no linear EH lowering), async/Promise (no linear runtime),
dynamic/boxed-any (#1852-G4 f64+tag cell is the design seed, but it is a
value-rep decision that must be made jointly with #2949's dynamic IrType —
file separately when L2 lands).

### Risks / edge cases

- **funcIdx shifts**: linear registers runtime helpers up-front
  (`index.ts:100-116`) then user funcs — the overlay must patch
  pre-allocated slots only, never append (same placeholder discipline as
  #2138). `ensureHelper` additions before finalize follow the name-based
  repoint rule (#2710, memory `project_standalone_hostimport_gate_index_shift`).
- **Two type-numbering passes do not exist on linear** (no hoist pass) —
  simpler than WasmGC; but `internFuncType` must dedupe against the linear
  module's type section, not grow it per call.
- **Multi-module linear** (`generateLinearMultiModule`, second context at
  `index.ts:235`) — out of scope for L1 (single-module only), mirror later.
- **The linear backend's own fail-louds** (typeof/await/spread/regex) are
  UNCHANGED — the IR overlay only ever _adds_ capability; a claim the gate
  rejects lands exactly where it lands today.

### Effort

XL total; L0+L1 ≈ one senior-dev budget window (Fable for L0's interface
cut + L1's gate; the LinearIntegration itself is mechanical); L2+ are
M-sized Opus slices banked by the ratchet.

## Execution status — L1 LANDED (2026-07-10, fable-2938)

**Slice L1 shipped** (this PR): `--target linear` consumes the IR front-end
for selector-claimed numeric/control-flow top-level functions, gated on
`JS2WASM_LINEAR_IR=1` (flag off ⇒ `generateLinearModule` byte-identical,
proven in `tests/issue-2956.test.ts`).

- **`src/ir/backend/linear-integration.ts`** (new) — the linear driver:
  `planIrCompilation` → shared `lowerFunctionAstToIr` → `verifyIrFunction`
  → `verifyIrBackendLegality("linear")` (#2954, the capability gate) →
  `lowerIrFunctionBody` via `LinearEmitter` → ready-to-insert
  `WasmFunction`s at the pre-assigned `funcMap` slots. Slice-1 resolver =
  the four REQUIRED `IrLowerResolver` methods, name-based over
  `ctx.funcMap`/`ctx.moduleGlobals`/`ctx.mod.types` (deduped
  `internFuncType`); all optional shape hooks absent by design.
- **Cross/self/mutual recursion works**: `calleeTypes` is pre-seeded from
  annotations via from-ast's own `typeNodeToIr` (now exported — additive)
  plus a bounded fixpoint over successful builds. `fib`, `even`/`odd`,
  callers-of-claims all IR-compile.
- **Demotion channel + ratchet** (acceptance criterion 3):
  `pnpm run check:linear-ir` (`scripts/check-linear-ir.ts` +
  `scripts/linear-ir-baseline.json`) — compiled count may not DECREASE, no
  demotion bucket may INCREASE; `--update` banks progress. Seeded at
  compiled=6 / `build:4` on the playground corpus.
- **Validation**: `tests/issue-2956.test.ts` (5 cases: IR-claim + run
  parity, flag-off byte-identity, collatz value parity, demote-and-
  direct-compile, mutual recursion); full linear suite + cross-backend
  diff 182/182; tsc clean.

**L0 deviation (recorded for review):** L1 deliberately did NOT execute the
L0 adapter extraction first. Every primitive the driver calls is already
backend-neutral in its own module — nothing duplicates integration.ts's
selection/typeMap/report logic (the forbidden drift-clone), and touching
integration.ts would have collided with in-flight #3029-S3 (same
extraction, owned there: "do it once, here"). When S3 lands, this driver
becomes the `LinearIntegration` adapter implementation nearly verbatim —
and the interface gets cut with TWO live consumers in view instead of one.

**Remaining after this sub-slice:** L2 refcells and aggregates via
`layout.ts`, L3 (strings, after #2955), L4 (default-ON flip + fold the direct
path's reject list into the ratchet). Acceptance criterion 2
(cross-backend corpus rows flip `expectLinearUnsupported`) rides the L4
default-ON flip — under the L1 flag the corpus rows are unchanged by
construction.

## Execution status — L2 vec-construction sub-slice implemented (2026-07-16, codex/2956-l2-vec)

The #1804 `vec.new_fixed` arm now lowers selector-claimed fixed `number[]`
literals through the production linear-IR overlay under
`JS2WASM_LINEAR_IR=1`. The implementation stays on the shared AST-to-IR path;
it does not clone array-literal analysis and does not change `BackendEmitter`,
`lower.ts`, or the WasmGC emitter owned by the concurrent #2953 slice.

- `LinearEmitter.emitVecNewFixed` allocates through the existing `__arr_new`
  runtime, consumes the already-stacked values from last to first, and writes
  each f64 value to its original slot through one value-first indexed helper.
  It publishes `length` only after initialization and leaves the canonical i32
  arena pointer on the stack. The linear resolver supplies the direct backend's
  numeric OOB carrier (`0`) to the shared safe-read builder.
- The linear resolver now threads the existing from-ast vec hooks, supplies an
  i32 vec value representation, and recognizes TypeScript `number[]`
  expressions before allowing scalar-carried `.length` / indexed reads. The
  shared lowerer's GC-shaped construction scratch is normalized to an i32
  pointer only in the returned linear function.
- The linear legality profile admits `vec.new_fixed`, `vec.len`, and `vec.get`.
  Other element layouts, mutation (`push`/set), for-of, aggregates, refcells,
  strings, spread/sparse/hintless construction, and unsupported control-flow
  shapes continue to demote to the direct linear path.
- `tests/issue-2956.test.ts` adds flag-on differential value, strict-alias,
  length/index, and out-of-bounds non-trapping coverage; a hintless-empty
  build rejection proves direct fallback; and `JS2WASM_LINEAR_IR=0` is
  SHA-256 byte-identical to an unset flag for the vec module.

Measured ratchet result: `compiled 6 -> 6`, `build 4 -> 4` on the fixed
playground corpus. There is no measured corpus improvement, so
`scripts/linear-ir-baseline.json` is intentionally unchanged. The next L2
work is the separately owned refcell/aggregate surface; this sub-slice does
not claim it.

## Execution status — L2 vec-MUTATION sub-slice (2026-07-17, fable-epsilon)

Element store (`a[i] = v`) and single-arg `a.push(v)` on selector-claimed
`number[]` receivers now lower through the linear-IR overlay under
`JS2WASM_LINEAR_IR=1`. No new IR instr kinds and no emitter changes — the
sub-slice rides the existing C2 element-store helper call:

- `src/ir/from-ast.ts`: the element-store and push receiver gates admit the
  linear scalar-i32 vec receiver via the same `isVecValueExpression` probe
  the read arms (`.length`, element access) already use. WasmGC lane
  unaffected (its vec receivers are always refs; `check:ir-fallbacks` OK).
- `src/ir/backend/linear-integration.ts` `resolveFunc`: intercepts the
  `__vec_elem_set_<typeIdx>` helper name (sentinel 0 on linear) and maps it
  to the direct runtime's `__arr_set(ptr:i32, idx:i32, val:f64)` — same
  signature, same grow-on-OOB / zero-fill-gap / len-extension semantics as
  the WasmGC `ensureVecElemSet` helper (negative-idx no-op + #1977
  forwarding resolution are safe supersets). Name-based, funcIdx-shift safe.

Validated: `tests/issue-2956.test.ts` 11/11 (parity vs direct for
setInBounds/setGrow/pushStmt; OOB-growth len-extension 507; flag-off SHA
byte-identity; multi-arg push demotes to direct); linear-array/basic +
cross-backend-diff 43/43; tsc clean; ratchet 6→6 / build 4→4 (corpus has
no mutation-gated rows — baseline intentionally unchanged).

**Found + filed #3332**: the DIRECT linear path returns 0 from
expression-position push (spec: new length) and drops multi-arg push
extras — the overlay is spec-correct where claimed, so the tests document
the divergence with #3332-referencing assertions instead of masking it.

**Remaining after this sub-slice**: refcells + aggregates via `layout.ts`
(the L2 remainder), L3 strings (after #2955), L4 default-ON flip.

## Execution status — L2 aggregate/ref-cell sub-slice implemented (2026-07-17, porffor-codex-developer)

Selector-claimed numeric objects now lower through the flag-gated linear-IR
overlay as i32 arena pointers. The resolver computes field offsets with the
direct backend's `computeClassLayout`, and `LinearEmitter` realizes
`object.new/get/set` plus primitive `refcell.new/get/set` as allocation calls
and typed linear-memory loads/stores.

- Aggregate constructors are deferred defined functions with signatures
  `(field0, ...fieldN) -> i32`. They are discovered lazily but appended only
  after every pre-assigned class/top-level function slot; the assembler checks
  the predicted absolute index before insertion. This preserves the #2710
  name/slot discipline and avoids a scratch-local change to the frozen emitter
  contract.
- Layout handles carry only target-neutral memory facts (field offset + Wasm
  scalar type). Numeric (`f64`), boolean/pointer (`i32`), and nested-object
  fields are admitted; other field carriers fail the linear legality gate and
  demote before lowering.
- The linear TypeConverter now maps object and primitive boxed/refcell IR types
  to their i32 pointer carrier. WasmGC and bytecode conversion paths are
  unchanged.
- Primitive refcell allocation/get/set is wired and emitter-tested. No closure
  promise is added: the selector does not claim closure/nested-function shapes
  on linear today, and lifted closure slots/`call_ref` remain explicitly
  deferred as the architect spec requires.
- Focused coverage proves direct-path parity for numeric/boolean/nested reads,
  mutation + strict aliasing, deferred helper index stability, and flag-off
  SHA-256 byte identity. The overlay additionally compiles anonymous-object
  mutation that the direct linear path currently rejects.

Validation: `tests/issue-2956.test.ts` 15/15; `tests/issue-1850.test.ts`
11/11; complete linear + cross-backend + IR proof matrix 184/184; typecheck
clean; `check:ir-fallbacks`, `check:loc-budget`, and `check:oracle-ratchet`
clean. Linear-IR ratchet remains `compiled=6`, `build=4` because the fixed
playground corpus has no aggregate/refcell row, so
`scripts/linear-ir-baseline.json` is intentionally unchanged.

**Remaining after L2:** L3 strings (after #2955) and L4 default-ON + direct
reject-list folding. The issue remains `in-progress` for those later slices.

## Execution status — L3 strings implemented (2026-07-17, porffor-codex-developer)

Selector-claimed strings now use the direct linear backend's canonical i32
arena pointer while staying on the shared representation-abstract IR
front-end. The prerequisite #2955 capstone removed `nativeStrings` from the
from-ast resolver surface before this slice began.

- `resolveString` and the linear TypeConverter map `IrType.string` to i32;
  linear legality now admits `string.const/concat/eq/len`, string signatures,
  and string fields in L2 aggregates.
- Literal materialization shares the direct backend's UTF-8 data-segment
  registry and `__str_from_data` path. Concat, equality, UTF-16 `.length`, and
  relational comparison resolve by name onto the existing linear runtime;
  fully specified/one-arg `slice` uses the same runtime path as direct codegen.
- A flag-gated `(string pointer, UTF-16 index) -> f64` helper adds the
  previously unsupported `charCodeAt` surface. It decodes the linear UTF-8
  storage, returns BMP code units or the requested half of an astral surrogate
  pair, and returns NaN out of bounds.
- String iteration and prototype methods without a representation-complete
  linear runtime mapping remain explicit build demotions to the direct path.
  Async, closures/`call_ref`, exceptions, and dynamic/boxed-any remain deferred
  exactly as specified.

Focused validation: `tests/issue-2956.test.ts` 18/18; linear + legality +
cross-backend matrix 176/176; typecheck clean. The flag-off string module is
SHA-256 byte-identical for unset vs `JS2WASM_LINEAR_IR=0`.

The measured linear-IR ratchet improved and was banked:
`compiled 6 -> 8`, `build 4 -> 2`. L4 (default-ON plus direct reject-list
folding) is the only issue-defined slice remaining, so status stays
`in-progress` for the next fresh continuation branch.

## Execution status — L4 default-on + unified fallback ratchet implemented (2026-07-17, porffor-codex-developer)

The selector/LinearEmitter overlay is now the default single-module
`--target linear` path for the numeric/control-flow, fixed-number vec,
aggregate/ref-cell, and string families landed in L1-L3.
`JS2WASM_LINEAR_IR=0` remains the byte-identical direct-backend rollback switch;
`=1` remains accepted for explicit CI and probe runs.

- `compileLinearIrFunctions` requests the selector's existing
  `trackFallbacks` list and folds every pre-claim direct-path decision into
  `LinearIrResult.rejected` as `select:<IrFallbackReason>`. Post-claim
  `build`/`verify`/`illegal:*` demotions retain their existing buckets, so one
  ratchet now measures both sides of the fallback seam without a second
  predicate family.
- The baseline now records `compiled=8`, `build=2`, and selector buckets
  `async-function=4`, `body-shape-rejected=24`,
  `call-graph-closure=12`, `non-export-modifier=15`. Future growth in any
  bucket fails `check:linear-ir`.
- The default-on differential run retired two baselined gaps:
  `numeric/math-trunc` and `string/charcode` no longer carry
  `expectLinearUnsupported`, so their values execute and compare on both
  backends.
- Fail-loud coverage now distinguishes the still-deferred dynamic/boxed
  `typeof` surface (`any`) from statically typed `typeof`, which the shared IR
  can lower safely.

All issue-defined slices and acceptance criteria are implemented; the issue is
`in-review` for the final PR and merge-queue validation.

Validation: complete linear + cross-backend + IR proof matrix 196/196;
`tests/issue-2956.test.ts` 20/20; typecheck and production library build clean;
`check:linear-ir`, `check:ir-fallbacks`, `check:loc-budget`, and
`check:oracle-ratchet` clean; changed-file Prettier and Biome checks have no
errors.
