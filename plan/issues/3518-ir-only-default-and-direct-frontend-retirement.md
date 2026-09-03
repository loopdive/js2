---
id: 3518
title: "IR-only default and direct front-end retirement"
status: in-progress
created: 2026-07-21
updated: 2026-08-30
priority: critical
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen, codegen-linear, compiler
language_feature: compiler-internals
goal: ir-full-coverage
sprint: current
depends_on: [3519]
horizon: xl
complexity: XL
es_edition: n/a
lane: ir-retirement
model: gpt-5.6-sol
related: [1373b, 2855, 2950, 3090, 3142, 3143, 3341, 3517, 3529, 3520, 3521, 3522, 3523, 3525, 3526, 3527, 3528, 3678, 3681, 4382, 4576, 4577]
origin: "2026-07-21 explicit user directive: enable IR-only by default and retire the old direct codegen path"
oracle-ratchet-allow:
  - src/codegen/multi-prepared-array-leaf.ts
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/multi-prepared-scalar-leaf.ts
  - src/ir/backend/linear-integration.ts
  - src/ir/builder.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/nodes.ts
  - src/ir/prepared-component-dependencies.ts
  - src/ir/select.ts
  - src/ir/verify.ts
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::planIrOverlay
  - src/ir/backend/linear-integration.ts::compileLinearIrFunctions
  - src/ir/backend/linear-integration.ts::makeLinearIrResolver
  - src/ir/from-ast.ts::lowerFunctionAstToIr
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::makeResolver
  - src/ir/lower.ts::emitInstrTree
  - src/ir/lower.ts::lowerIrFunctionBody
  - src/ir/passes/inline-small.ts::renameInstrOperands
  - src/ir/prepared-component-dependencies.ts::collectFunctionEvidence
  - src/ir/select-identity.ts::planIrCompilationByIdentity
---
# #3518 — IR-only default and direct front-end retirement

> **Tracking epic, not a single developer task.** The current compiler is a
> default-on **hybrid**: some functions compile once through IR, while the rest
> still compile through the direct AST→Wasm front-end or compile twice and are
> patched by an IR overlay. This epic ends only when IR is the sole front-end,
> both WasmGC and linear consume the same prepared IR program, unsupported
> source fails explicitly, and the direct front-end is deleted.

## Product outcome

One source-language front-end builds typed IR. Backend choice happens below
that boundary:

```text
TypeScript/JavaScript source
          |
          v
  PreparedIrProgram
     /          \
WasmGC        linear
lowering      lowering
```

There is no production edge from AST nodes directly to either Wasm backend.
Runtime and builtin behavior remains shared implementation, but it is reached
through semantic IR intents rather than `compileExpression` /
`compileStatement`. Features intentionally outside the compiler's supported
language fail with a stable source-located `Unsupported` diagnostic; they do
not resurrect the direct path.

`PreparedIrProgram` is also the versioned, validated, losslessly serializable
handoff between frontend preparation and backend emission. Both backends
consume the same frozen program snapshot. Deserialization re-runs structural,
type, ABI, effect, and runtime-manifest verification before any artifact side
effect; it never reparses source, reselects features, or invokes a legacy path.

## Current truth (audited 2026-08-09)

The following measurements are independent and must not be conflated:

| Signal                                           |                  Current result | What it proves                                                         | What it does **not** prove                                                  |
| ------------------------------------------------ | ------------------------------: | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Playground function `body-shape-rejected` bucket |                           **0** | The narrow #2856 function corpus has no rejection in that bucket       | All source is IR-capable, strict mode is safe, or legacy is unreachable     |
| Playground module-level residual                 |              **1** before #3517 | The remaining measured initializer is the Algorithms `Map` initializer | Module init is compile-once or its legacy slot is dead                      |
| IR-first compile-once ceiling                    |         **441 / 1,568 (28.1%)** | The numeric/boolean allowlist can safely skip those legacy bodies      | Widening signatures can reach the remaining 71.9%                           |
| Adoption matrix                                  |       **18 / 58 rows IR-owned** | Those syntax rows have an IR implementation in measured configurations | Their legacy handlers are unreachable in mixed functions or at module scope |
| Front-end reachability                           | **59,676 legacy-only fn-lines** | Approximate final deletion opportunity                                 | Those lines are dormant today                                               |
| Runtime/builtin reachability                     |               **~47K fn-lines** | Behavior emission must gain IR-owned entry points                      | Those routines should be deleted with the front-end                         |
| Bounded host + standalone readiness              | **37/37 IR; 0 legacy in each** | Every measured playground terminal is prepared and compile-once in both lanes | Global runtime/linear/direct paths are unreachable or repository-wide IR-only is ready |

R0 is complete. After the #3522 cross-owner/Builtins transactions and the
#3523 Algorithms and Calendar function-plus-module-init transactions, the
bounded single-host playground gate is green at 5/5 entries, 37 terminal
units, 37 emitted IR bodies, 0 typed Unsupported outcomes, 0 Invariants, and 0
legacy bodies. All Algorithms and Calendar terminals now seal in exact
prepared components and compile once through IR. This is a bounded census,
not repository-wide strict IR-only readiness.

The #4577 Calendar checkpoint brings the matching standalone census to the
same 5/5 entries and 37/37 compile-once IR bodies, with zero legacy,
Unsupported, or Invariant outcomes, and promotes that bounded lane from
baseline-only to strict IR-only policy. Calendar's ten source terminals, seven
reusable callbacks, five nullable DOM globals, and exact DOM/interaction/clock
imports form one sealed transaction. This does not widen the denominator beyond
the five playground entries.

Additional blockers:

- The bounded WasmGC `classes.ts` component now prepares `main` together with
  all ten constructor/method/accessor terminals in one exact transaction.
  Explicit constructors bind their source unit to `_init`; one AST-free `_new`
  support wrapper owns allocation. Standalone `classes.ts::main` remains the
  explicit ambient-console selector boundary, while implicit, externref-backed,
  unsafe-super, forward-ABI, nested-class, and closure families retain the
  typed direct route until their complete transactions land.
- #3523 now gives Algorithms' exact host `const Map<K,V> = new Map()` and
  Calendar's gap-free initialized lexical sequence source-qualified
  compile-once ownership. Broader statements, classes/statics, live seeds,
  deferred/standalone/WASI startup, and multi-source module shapes still need
  the complete ordered R4 contract; these bounded routes are not evidence that
  generic `__module_init` compilation is dead.
- Multi-source/M0 is a per-source, post-legacy overlay; fast-mode multi-source,
  class members, module init, and IR-first body skipping are incomplete.
- Physical standalone reachability is not retired by the green bounded census:
  public direct toggles remain; non-prepared single-source units still enter
  `compileDeclarations`; multi-source is direct-first; and CJS, nested
  function/class/expression, IIFE, dynamic-code, fast, WASI, and linear roots
  retain direct AST-to-Wasm entry edges. R9 must first make the complete
  standalone program denominator fail closed; R10 then proves and deletes dead
  direct reachability without removing shared host/WASI behavior.
- The linear backend still has direct AST-reading paths and does not consume the
  same whole-program IR contract as WasmGC.
- The R0 typed gate has replaced substring-matched build-error policy. The
  bounded playground lane now passes its strict shadow with no legacy bodies;
  the wider authoritative class/module/multi-source/runtime/linear matrices
  remain the expected blockers to a repository-wide policy flip.
- The normal fallback gate now reconciles preliminary selector labels with
  source-qualified terminal outcomes. Its async-function bucket fell from four
  to zero with #4124; this does not claim that async methods, closures,
  `for await`, async generators, or AST planner deletion are complete.

## Terms used by this program

- **Claimed**: the selector predicts that a unit is lowerable. This is not
  evidence that it was emitted.
- **IR-emitted**: integration successfully patched a legacy-created slot. This
  is still not compile-once ownership.
- **Prepared**: typed IR, ABI, imports, runtime intents, and verifier results are
  complete before backend/body emission starts.
- **Compile-once**: no legacy body was emitted for a Prepared unit.
- **IR-only**: every source unit is Prepared or compilation terminates with a
  typed Unsupported/Invariant error; no direct body is available to demote to.

## Dependency spine

Every row is an independently reviewable landing. R1–R8 now have concrete
child issues; R9–R10 receive child issue IDs before dispatch. This epic owns
their order and acceptance boundaries.

| Slice                        | Outcome                                                                                               | Depends on                            | Exit evidence                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R0a — #3529 (done)**       | Restore typed-producer equivalence parity without weakening unknown-throw-to-Invariant classification | #3143; exposed by #3519               | 154 new compile failures return to the committed baseline through preclaim/typed Unsupported or true invariant fixes; no baseline expansion                     |
| **R0b — #3519 (done)**       | Typed `Prepared` / `Unsupported` / `Invariant` outcomes plus an honest `check:ir-only` readiness gate | #3143, #3529; informed by #2855/#3341 | No TypeMap or compile failures are skipped; `result.errors` and every unit outcome are accounted for; hybrid vs IR-only policy is tested                        |
| **R1 — #3520 (in progress)** | Source-qualified `IrUnitId` and a whole-program `ProgramAbiMap`                                       | R0                                    | Same-named units across files/classes cannot collide; signatures, globals, imports, types, exports, and synthetic units are planned once                        |
| **R2 — #3521 (in progress)** | `PreparedIrProgram` and prepare-before-emit compile-once pipeline                                     | #3520                                 | Prepared free functions never call legacy body compilation; the versioned validated program round-trips losslessly; unsupported units are decided before emission |
| **R3 — #3522 (in progress)** | Classes and class members are Prepared/compile-once                                                   | #3521                                 | Constructors, instance/static methods, fields, inheritance, wrappers, and type indices no longer depend on legacy body compilation                              |
| **R4 — #3523 (in progress)** | Module init is Prepared/compile-once                                                                  | #3521, #3522                          | One program-owned module-init unit replaces the compile-first/patch-later `__module_init` overlay, including top-level binding/TDZ/export effects               |
| **R5 — #3525 (blocked)**     | Whole-program single- and multi-source Prepared ownership                                             | #3520–#3523                          | Cross-file calls/imports, fast mode, collisions, module init, and class members use one `PreparedIrProgram`; no per-source overlay loop remains                 |
| **R6 — #3526 (blocked)**     | Typed semantic intrinsic/runtime-feature/host-capability contract                                     | #3521                                 | The ~47K runtime/builtin emission lines are reached from a frozen semantic manifest, never AST dispatch; families land in measured sub-slices                   |
| **R7 — #3527 (blocked)**     | AST-free async suspension plans and canonical Promise ABI                                             | #3522, #3525, #3526                   | Every supported async container uses one verified `IrAsyncPlan` and the existing frame engine; no AST callback/direct async route remains                       |
| **R8 — #3528 (blocked)**     | Linear consumes the shared Prepared program                                                           | #3525–#3527                          | WasmGC and linear receive the exact same program/ABI/runtime/async plans; `src/codegen-linear/` has no source-AST lowering path                                 |
| **R9**                       | Fail-closed IR-only default; remove escape hatches                                                    | R3–R8; #2949, #2952, #1373b, #3583   | Default policy is IR-only; hybrid demotion, `experimentalIR: false`, `JS2WASM_IR_FIRST`, `disableIrFirst`, skip allowlists, and compile-twice switches are gone |
| **R10**                      | Reachability-proven direct-front-end deletion                                                         | R9                                    | Re-run #3090 audit; delete the frontend-only fn-lines and dispatch roots; zero direct AST→Wasm reachability remains. **The ~59,676 figure is a July number that today's audit does NOT reproduce (85,609 across 107 frontend files vs 59,676 across 35) — re-derive before scoping; see `#3090`'s 2026-09-03 note**                                    |

R0a and R0b completed on 2026-07-21. R1 remains active while R2 production
preparation and the first R3 static-method transaction are now in progress.
The current cutover is deliberately component-local: sealed owners skip direct
body emission, while unsealed owners retain the typed hybrid route. R4 follows
R3 because its ordered plan consumes the class/static-intent census owned by
#3522. #3525, #3527, #3528, and R9 remain integration barriers rather than
parallel deletion opportunities. R9 also requires the explicit dynamic-value,
control-flow, async, adoption-owner, and broader-corpus coverage closure named
above.

### 2026-08-30 #4522 Math rollback checkpoint

This is a bounded pre-R9 retirement, not an IR-only policy claim. The temporary
per-method Math withdrawals used during the initial rollout are removed while
the exact ambient recognizer and target-capability boundary remain unchanged.
The production registry remains a 33-method contract, and the shared linear
legality boundary remains exactly 10/33.

The closed #4522 proof adds a literal 21-row method/arity/provider census with
42 host/standalone positive cells, 21 shadowed cells, 21 alias cells, 42
wrong-arity cells, and 21 provider mutations. It joins the independently
literal retirement population to the production registry and rejects missing,
duplicate, and synthetic foreign rows. Each positive cell uses the retained
global `experimentalIR: false` compile of the same source as an observational
direct oracle for runtime and public Wasm surface parity; it is not a production
fallback. Before the #1231 retirement, the #4522 R9 environment denominator
was fifteen readers: four global controls, the separately owned exact
mixed-primitive selector rollback, nine named Prepared cutovers, and the
default-on linear direct-backend escape hatch. Diagnostics, self-checks, and
codegen-only tuning remain separately classified. This full inventory stays
owned by #4522 until the R9 policy flip.

### 2026-08-31 #1231 object-shape rollback checkpoint

#1231 retires the one boxed-object representation escape hatch without changing
the selector, lowering, emitters, or any other R9 reader. The exact live
environment denominator is therefore now fourteen: three remaining global
controls, the exact mixed-primitive selector rollback, nine Prepared cutovers,
and the linear direct-backend reader. This is the bounded **15→14** transition;
it is not an IR-only policy flip.

## Program rules

1. **Typed policy, not message matching.** Expected capability gaps are
   `Unsupported`; compiler contract failures are `Invariant` with stable codes.
   Invariants fail in hybrid and IR-only modes. Unsupported units may use the
   old path only while the explicitly temporary hybrid policy exists.
2. **Prepare before emit.** A unit cannot be called compile-once when legacy
   body/declaration emission ran first and IR patched its slot later.
3. **Whole-program ABI first.** Source-qualified identity and ABI planning
   precede cross-file/class/module ownership; name-based patching is not an
   acceptable IR-only foundation.
4. **No telemetry blind spots.** TypeMap failure, thrown compilation,
   `CompileResult.success === false`, fatal `result.errors`, selector
   rejections, post-claim failures, unpatched slots, and backend legality all
   participate in the readiness verdict.
5. **No corpus-zero shortcuts.** A zero histogram is a regression ratchet, not
   proof that a reason is unreachable. IR-only readiness is fail-closed over
   actual compile outcomes.
6. **Runtime is rewired, not copied.** Shared coercion/string/object/collection/
   regex/async behavior stays single-sourced behind semantic IR intents.
7. **Optimizations migrate before deletion.** Every reachable direct handler
   must have its correctness behavior and optimization decisions inventoried.
   Each optimization needs an IR lowering/pass owner plus differential
   output-shape or performance evidence where semantic equivalence alone would
   miss a regression. An unmapped optimization blocks deletion; it is never
   silently discarded as cleanup.
8. **Deletion follows reachability.** No direct handler is removed until the
   new gate proves it unreachable in every supported policy/backend and the
   #3090 audit confirms the call edge is gone.
9. **One serializable backend handoff.** The prepared program schema is
   versioned and deterministic. WasmGC and linear accept the same verified
   snapshot; backend incapability is a typed pre-emission outcome, never a
   request to reparse, reselect, or fall back.

## Acceptance criteria

- [ ] `pnpm run check:ir-only` passes on the authoritative playground,
      equivalence-inline, cross-backend, multi-source, class, module-init,
      async, fast, standalone, and WASI matrices with complete unit accounting.
- [ ] Full merge-group Test262 is net-non-negative in JS-host and standalone;
      no shard may omit IR outcome or fatal `result.errors` data.
- [ ] Every supported source unit is represented in one `PreparedIrProgram`
      before backend emission; no class/module/M0 exception remains.
- [ ] WasmGC and linear consume the same IR and `ProgramAbiMap`; their only
      divergence is backend lowering/runtime representation.
- [ ] The versioned `PreparedIrProgram` serialization round-trips all semantic
      values, source identities, ABI/effect data, and frozen runtime intents
      without loss. Malformed or incompatible input fails validation before
      artifact emission.
- [ ] A differential backend-input fixture proves WasmGC and linear consume the
      exact same prepared-program snapshot. Backend incapability returns a
      typed diagnostic and cannot trigger frontend reconstruction or fallback.
- [ ] Unsupported source produces stable source-located diagnostics. There is
      no silent selector fallback, post-claim demotion, skipped-slot escape, or
      legacy catch path.
- [ ] The IR-only policy is the only production policy. All IR/legacy escape
      hatches and compile-twice switches are removed from public options, env
      handling, tests, scripts, and documentation. The env-var set to remove
      is the complete live #4522 `retire-at-R9` table, including both global
      IR switches and bounded multi-source cutover switches; do not hardcode a
      stale cardinality here. Diagnostics/self-checks classified keep there
      survive — consume that table, do not re-audit at flip time.
- [ ] `compileStatement` / `compileExpression` and the direct AST→Wasm handler
      graph are unreachable and deleted. The refreshed #3090 report records
      zero frontend-only survivors and separately records retained runtime/
      substrate code.
- [ ] The direct-handler retirement inventory maps every behavior and
      optimization to an IR lowering, pass, runtime semantic intent, or
      explicit Unsupported outcome. Differential Wasm-shape and performance
      gates show that deletion does not silently drop legacy optimizations.
- [ ] Equivalence, cross-backend, linear, typecheck, lint/format, loc/dead-
      export, full Test262, standalone-floor, and artifact-validity gates pass
      on the final merged result.

## Out of scope

- Treating IR-only as a promise that every ECMAScript feature is implemented.
  Explicit, typed unsupported diagnostics are acceptable; hidden direct
  fallback is not.
- Deleting runtime/builtin behavior merely because it is currently reachable
  through legacy dispatch. R6 must first provide IR-owned semantic entry points.
- Adding new language behavior to the direct front-end during migration.

## Standalone-lane Implementation Notes (fable, 2026-08-15)

**Deliverable 1 — the lane landed.** `scripts/check-ir-only.ts` now observes
two lanes. A generic `observeLane` helper backs both `observeSingleHostLane`
(unchanged behaviour, unchanged name, still exported for the #3519 tests) and
the new `observeStandaloneLane`, which compiles the SAME five entries with
`target: "standalone"`.

The lane carries a new `readiness: "ir-only" | "baseline"` field (absent ⇒
`"ir-only"`, so every existing caller is untouched). Under `--policy=ir-only`
a `"baseline"` lane withholds **exactly three** assertions — zero unsupported,
zero legacy bodies, IR-body count equals terminal count. Everything else stays
live for it: anti-vacuity (empty corpus / zero terminal units / zero emitted /
duplicate keys / missing telemetry), the compile-result failures, the
telemetry-consistency cross-checks against `irCompiledFuncs` /
`irFirstSkipped` / `irPostClaimErrors`, the hard `invariants > 0` rule, and
every baseline floor/ceiling. That is what keeps an honestly-red lane from
becoming a blind spot (rule 5) rather than a lane that is merely "not checked".

**Deliverable 2 — the diagnosis. It is NOT #4186.**

The collapse is a **pre-claim selector rejection**, not the patch-time typeIdx
parity demotion that #4186 owns. Every rejected `algorithms.ts` unit reports
`stage: "select"`; there are **zero post-claim demotions** in the standalone
lane (the `check:ir-fallbacks` post-claim bucket is empty, and the A/B below
adds seven IR bodies with all seven landing at `stage: "patch"`). #4186's
mechanism — lattice-typed implicit-any **object** params vs. legacy
`lowerParamType` refusing `__anon_*` — cannot be it: `algorithms.ts` has no
implicit-any object parameter at all; every parameter is explicitly annotated.
Recording this explicitly because it is useful negative evidence for that lane.

The single gate is the **caller-direction call-graph closure**, mode-keyed on
host-ness in two mirrored places:

- `src/ir/select.ts:950` — `const demoteOnLegacyCaller = options?.jsHostExterns !== true;`
- `src/ir/select-identity.ts:971` — the same line on the production identity path.

`jsHostExterns` is `irTargetProfile.allowHostImports`, so it is **false for
standalone/WASI**. With it on, the Step-2 fixpoint deletes any claimed function
that has an *unclaimed local caller*, not merely an unclaimed callee. In
`algorithms.ts` the single unclaimed root is `main` — rejected
`body-shape-rejected` because it drives `console.log` and string concat — and
`main` calls **every other function in the file**. One root rejection therefore
propagates to the whole file through the *caller* direction, which is precisely
why a file that is 100% IR-owned on host emits zero IR bodies standalone. The
same mechanism explains `calendar.ts` and `builtins.ts`; it is a whole-file
amplifier, not a per-shape gap.

The in-tree comment above that line (added by #2858) already predicted this and
named `joinNums` in `algorithms.ts` under WASI as the motivating example. Its
stated precondition for relaxing the demotion was that the offending callee
bodies be "rejected up front by the body-shape work (#2856/#2857)" — which has
since happened: `joinNums` is now cleanly rejected pre-claim with
`primitive-method-unsupported`, and `fibMemo` with `body-shape-rejected`.

**A/B sizing (probe, not a shipped change):** forcing
`demoteOnLegacyCaller = false` in both files raises the standalone lane from
**10 → 17** IR bodies (`algorithms.ts` 0 → 3) with 0 invariants, 0 post-claim
demotions and `success: true` everywhere. That measures the blocker's full
size. It was **not** shipped: the blanket flag also exempts families whose
signature genuinely can diverge, which is the hazard the closure exists for.

**Deliverable 3 — the fix shipped: prove the ABI instead of disabling the
guard.** The closure already has a sanctioned escape hatch,
`SelectionOptions.legacyCallerAbiIsProjected`, whose contract is "the direct
callable and the IR overlay share one fully certified ABI, making a legacy
caller's pre-emitted call safe". The pre-existing certifications only covered
implicit/projected parameters plus one narrow reduce-fusion family. The new
`src/codegen/ir-legacy-caller-abi.ts` adds `hasFullyAnnotatedScalarAbi`: a
declaration qualifies when **every** parameter and the return type carry an
explicit annotation from the fully-annotated scalar surface — `number`,
`boolean`, one-level `number[]`/`boolean[]` params, and `number`/`boolean`/
`void` returns.

Why that is a proof and not optimism: the guard's stated hazard is *signature
divergence* (IR replacing a legacy-allocated `typeIdx` after legacy already
compiled the caller's body). For these annotations both front-ends read the
same `ts.TypeNode` through the same mode-consistent mapping —
`resolvePositionType` gives `number → f64`, `boolean → i32`, `void → no
result`, and `T[] → irVec(...)`, which legacy `getOrRegisterVecType` interns as
the identical `(ref_null $vec_<elem>)` struct. Body lowerability is a
*separate* question and is still decided by the ordinary claim gates, which run
first.

Deliberately excluded, and each exclusion is load-bearing:

- unannotated/implicit positions — that is the #4186 split-brain surface, and
  this predicate must not pre-empt that lane's fix;
- optional / rest / defaulted params — arity is part of the ABI;
- generators and generics;
- **string and object positions**, and non-scalar or nested array elements —
  their carrier depends on `nativeStrings` / vec-element decisions this
  predicate does not reproduce. This is why the shipped fix reaches 16 rather
  than the A/B's 17: `calendar.ts::mname(m: number): string` returns a string
  and is left uncertified on purpose.

The predicate lives in its own module rather than in `src/codegen/index.ts`
because the LOC-budget gate explicitly asks for that; the remaining +2 LOC /
+1 func-line in `index.ts` (one import, one early return) is irreducible —
`legacyCallerAbiIsProjected` is a closure built inside `planIrOverlay` — and is
granted in this file's `loc-budget-allow` / `func-budget-allow` frontmatter.

**Standalone lane, before → after: 10 → 16 IR bodies** (`algorithms.ts` 0 → 3:
`fibIter`, `binarySearch`, `quicksort`; `calendar.ts` 0 → 3: `dimOf`, `fdow`,
`priceOf`). `select/call-graph-closure` fell 10 → 4. The baseline is ratcheted
to the post-fix numbers. The single-host lane is unaffected (still 37/37,
READY) — `jsHostExterns` is true there, so `demoteOnLegacyCaller` is false and
the new predicate is never consulted.

**Descoped, with reasons:**

- **Fast-mode lane (plan item 4)** — not added. Adding a third lane is
  mechanical now that `observeLane` is generic, but it needs its own honest
  measurement pass and its own blocker triage, and the budget went to the
  standalone blocker instead. Deliberately left rather than added unmeasured.
- **The remaining 21 standalone unsupported units** are genuine per-shape gaps,
  not this gate: 11 `body-shape-rejected` (`main`/`renderCal`/`el`/`fibMemo` —
  console/DOM/`Map` bodies), 4 `async-function`, 4 residual
  `call-graph-closure`, 1 `date-constructor-unsupported`, 1
  `primitive-method-unsupported` (`joinNums`, f64 `.toString()`). Each needs
  real standalone lowering; none is a mode-gating bug.
- **String-return certification** (`mname`) — the one A/B-proven remaining unit
  reachable via this gate. It needs a `nativeStrings`-aware carrier proof that
  belongs with the string-ABI work, not here.
- **The `legacyBodyEmitted` ceiling stays at 27.** The six newly-IR units are
  IR-**emitted** (the overlay patches a legacy-created slot), not
  **compile-once** — they still emit a legacy body first. Per this epic's own
  Terms that is a real but lesser tier, and the baseline records it honestly
  rather than implying compile-once ownership the lane does not have.

## Standalone-lane Test Results (fable, 2026-08-15)

Measured in worktree `agent-a560da37ac458f0fa` on main @ `7add6938`.

| Gate                                                | Result                                                                                                                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck` (ts7, the CI gate)              | **clean**                                                                                                                                                                                                       |
| `npx tsc --noEmit` (legacy tsc)                     | environmental failure only — `@types/node` is unresolvable through this worktree's symlinked `node_modules`; every error is `Cannot find name 'process'/'require'/'__filename'` in files this change never touches |
| `pnpm run check:ir-only`                            | **2 lanes reported**; single-host 37/37 IR, 0 legacy, **READY**; standalone 16 IR / 27 legacy / 21 unsupported / 0 invariants, ratcheted; verdict **READY**                                                    |
| `pnpm run check:ir-fallbacks`                       | **OK** — unintended (none), post-claim demotions (none), module-level (none)                                                                                                                                    |
| `npm run check:loc-budget`                          | OK — +2 in `src/codegen/index.ts`, granted by this file                                                                                                                                                         |
| `npm run check:func-budget`                         | OK — +1 in `planIrOverlay`, granted by this file                                                                                                                                                                |
| `npm run check:oracle-ratchet`                      | OK — `getTypeAtLocation +0`, `ctx.checker +0` (the new module makes no checker call)                                                                                                                            |
| `biome lint` (changed files)                        | clean                                                                                                                                                                                                           |
| `tests/issue-3519-ir-only-gate.test.ts`             | **14/14 pass**, including 5 new per-lane-readiness tests                                                                                                                                                        |
| `scripts/equivalence-gate.mjs`, shards **1–8 of 8** | **no new equivalence regressions** in any shard                                                                                                                                                                 |

Standalone runtime probes (`.tmp/`, gitignored):

- `algorithms.ts` compiles standalone, and the binary **instantiates and
  `main()` runs without trapping**.
- A dedicated fixture exercising the three certified shapes (`fibIter`,
  `binarySearch`, `quicksort`, plus a `boolean`-returning `isEven`) reached
  from an intentionally **unclaimed** caller returns `55414`, matching the
  hand-computed JS expectation — and returns the **identical** value on
  unmodified main. The change moves work from the direct path to IR without
  changing observable behaviour.

**Every test failure encountered was A/B'd against unmodified `main` and is
pre-existing.** Nothing in this change set regressed any of them:

- `tests/es5-standalone*` (26 files): 5 failures — harness self-tests ×3,
  descriptor bags, array-semantics dynamic HOF lane. Identical on baseline.
- `issue-1712-standalone` (the acorn case #4186 documents as red on main),
  `issue-3436-standalone-prelude-leak`, `issue-3673-standalone-gaps`,
  `issue-4034-standalone-prelude-size`: 4 failures. Identical on baseline.
- `issue-3520-ir-unit-identity`, `issue-3522-ir-class-compile-once` (×2,
  including its standalone-lane case),
  `issue-3522-ir-cross-owner-free-function`: 4 failures. Identical on baseline.
- `issue-1654-wasi-dataview-arraybuffer`: 3 failures. Identical on baseline.

The equivalence shards additionally reported **7 baseline failures that now
PASS** (`coercion-arithmetic-add` ×3, `math-pow-test262-pattern`,
`issue-1197`, `symbol-basic` ×2). These are **not** attributable to this
change: `math-pow-test262-pattern`, `coercion-arithmetic-add` and `issue-1197`
were each re-run on unmodified `main` and pass there too. The equivalence
baseline is simply stale; ratcheting it is out of scope here.

Full test262 was **not** run (per instruction). The standalone-floor / net
guards (#1897/#2097) run in the `merge_group` and remain the authoritative
check on this change's standalone conformance effect.

## Review (Fable, 2026-07-24)

Verify-first re-audit on main @ `7652f0337` (full document:
`plan/agent-context/fable-ir-review-2026-07-24.md`).

- **The "Current truth" table still holds.** Re-ran `check:ir-fallbacks`
  (all unintended buckets 0; module-level 0) and `check:ir-only` (5/5
  entries, 37 units, 31 IR-emitted, 6 typed Unsupported, 0 Invariants,
  37/37 legacy bodies, NOT READY) — identical to the 2026-07-21 audit.
  Adoption matrix: 18 ir-owned confirmed; denominator is now 58 kind rows
  (prose says 56). Compile-once ceiling and fn-line reachability were not
  re-measured; no allowlist-widening landed since 2026-07-21, so ≈28.1%
  plausibly holds.
- **Ladder gap — R9 needs an explicit coverage-closure dependency.** R9
  depends on R3–R8 only, but a fail-closed flip with `SwitchStatement` /
  `LabeledStatement` / `ForInStatement` still direct-only (#2952 `ready`,
  unstarted) and `%`/`**`/`in`/`instanceof` unlowered would hard-fail
  ordinary core-JS programs. The acceptance gate only catches this if the
  authoritative matrices contain such syntax — the playground corpus barely
  does. Recommend: (a) add "#2952 + #2949 + #1373b + #3583 coverage closure"
  to R9's Depends-on cell, and (b) grow the `check:ir-only` corpus beyond
  the playground before R9 readiness is claimed.
- **#2952 can and should start now** — its structural work (br_table +
  labeled nested-buffer exits) depends on neither R1 nor R2 and is the
  longest-lead item on the R9 critical path.
- **28 adoption-matrix rows had no live owner** (13 tracked by wont-fix
  #1131, 12 by done issues, 3 untracked) — now tracked by new issue #3583.
- R1 groundwork is confirmed landing on main (`4922ed58b`, `1a17b4458`);
  the R2–R8 `depends_on` frontmatter matches this epic's spine exactly.

## Slice: standalone readiness lane + top blockers (fable, 2026-08-15)

Live measurement on main @ `7add6938`: the `check:ir-only` gate has
exactly ONE lane (single-host WasmGC over 5 playground entries, READY at
37/37 IR bodies / 0 legacy). The SAME entries compiled with
`target: "standalone"` collapse: `js/algorithms.ts` = **0 IR / 7 legacy
bodies**, `js/classes.ts` = 10 IR / 1 legacy. The acceptance criteria
require standalone/WASI/fast/multi-source matrices; none is measured
today. This slice adds the standalone lane and attacks its top blockers.

1. **Add a `standalone` lane to `scripts/check-ir-only.ts`**: same 5
   entries, `target: "standalone"`, per-lane baseline in
   `scripts/ir-only-baseline.json` per the existing #3519 schema. Baseline
   HONESTLY at measured current truth (floors/ceilings) — the lane must
   not be required to be READY to land; it must be required not to
   regress.
2. **Diagnose the algorithms.ts 0-IR collapse.** A file that is 100%
   IR-owned on host emitting zero IR bodies standalone means a mode-gated
   capability/seal/registration decision, not per-shape gaps — find the
   single gate (selector capability rows, prepared-component sealing, or
   resolver registration keyed on host mode) and record it here.
3. **Fix the top blockers** to raise the standalone lane's IR-body floor;
   ratchet the baseline with each fix. Known hazards: standalone number
   boxing goes via `$AnyValue` not `__box_number` (#2955 notes),
   standalone-floor CI guard (#1897/#2097) — net standalone test262 must
   not go negative.
4. **Fast-mode lane** (`fast: true`) same pattern, time permitting —
   measure, baseline, do not block on READY.

Acceptance: gate reports ≥ 2 lanes; single-host stays READY; standalone
lane floors ≥ measured-at-landing values; `check:ir-fallbacks` no
growth; equivalence suite + standalone probes green; `tsc --noEmit`
clean.

### Result: caller-direction closure precision (2026-08-15)

**Landed:** standalone lane **16 → 17** IR bodies emitted;
`select/call-graph-closure` **4 → 3**; unsupported **21 → 20**. Single-host
lane unchanged at **37/37**, READY. Newly claimed unit:
`dom/calendar.ts::mname`.

**Root cause.** `legacyCallerAbiIsProjected` — the escape hatch the
standalone/WASI caller-direction closure consults — was backed by
`hasFullyAnnotatedScalarAbi`, whose certified surface **excluded `string`
positions** on the stated ground that "their carrier depends on
`nativeStrings`". That ground does not hold: legacy `resolveWasmType` and IR
`resolveString()` both pick the carrier from the SAME pair,
`ctx.nativeStrings && ctx.anyStrTypeIdx >= 0` → `(ref $AnyStr)`, else
externref. They agree **by construction**, including the `anyStrTypeIdx < 0`
corner. So `mname(m: number): string` — a leaf whose only unclaimed edge is
its legacy caller `renderCal` — was demoted for a signature divergence that
cannot occur.

**The other three `call-graph-closure` units are NOT caller-direction and are
out of reach of any closure-precision change.** Measured directly by
instrumenting the demotion (`caller=`/`callee=` per unit):

| unit | direction | blocked by |
| --- | --- | --- |
| `calendar.ts::mname` | caller only | *(fixed here)* |
| `calendar.ts::onDay` | callee only | callees `updFoot`, `renderCal` both `body-shape-rejected` |
| `builtins.ts::crd` | caller **and** callee | callee `el` `body-shape-rejected` |
| `builtins.ts::rw` | caller **and** callee | callee `el` `body-shape-rejected` |

`onDay` already had `legacyCallerAbiIsProjected === true` before this change —
its caller direction was never the blocker.

**The callee direction is not relaxable today, and this was measured, not
assumed.** Disabling the callee arm outright makes the standalone lane go
NOT READY with a hard compile failure, not a silent demotion:

```
Codegen error: IR path failed for onDay:
  ir/from-ast: direct call to "updFoot" has no exact AST-site plan in onDay
```

i.e. `from-ast` has no lowering for a direct call to an unclaimed (legacy)
local function at all — the callee-direction closure is load-bearing for
*lowerability*, not merely for signature safety. Those three units unblock
only when `el` / `renderCal` / `updFoot` themselves become claimable
(#2856/#2857 body-shape work on the standalone DOM/host surface), which is a
different slice.

**Host-lane invariance is structural, not empirical.**
`legacyCallerAbiIsProjected` is read only under `demoteOnLegacyCaller`
(`jsHostExterns !== true`, `select.ts` and `select-identity.ts` — the only two
consult sites), so widening the certified surface cannot move a JS-host claim.
The 37/37 re-measurement confirms it.

**Tightenings shipped alongside** (each strictly narrows the certified surface,
so none can regress a lane) — the predicate previously certified declarations
whose legacy signature it could not actually predict: destructuring parameters
(`bindingPatternParamNeedsWiden` widens them to externref), `async`
(`prepareAsyncCallableAbi` rewrites the ABI), and a return carrier legacy
overrides on body shape (`functionReturnsDynamicObjectCarrier`, now handed in
as explicit evidence rather than re-derived). The last one was a live hole for
the already-certified `number`/`boolean` returns, not something the `string`
extension introduced.

### Completed checkpoint: standalone Builtins DOM projection (2026-08-20)

#4576 advances the authoritative standalone lane from **27 → 31 of 37 IR
bodies** and from **10 → 6 legacy/typed Unsupported bodies**, with **0
Invariants**. The four newly prepared owners are Builtins `el`, `crd`, `rw`,
and `main`. `select/host-surface-unavailable` falls **4 → 2** and
`select/call-graph-closure` falls **3 → 1**; the remaining six outcomes are
exactly Calendar: two host-surface, two body-shape, one call-graph, and one
Date-constructor blocker. The single-host lane remains **37/37 IR**.

The family is admitted only with the exact `dom@1` embedder contract: eight
signature-checked imports, one authenticated subtree root, and an explicit
native-string boundary. The focused **14/14** Builtins suite proves the
**81-element/24-value** DOM oracle, direct-body poison, conservative near
misses, and tamper/authority failures. The optimized artifact is smaller than
the direct control in raw, gzip, compiler-WAT, function-body WAT, local, and
call counts while retaining 124 functions and the same eight imports. Literal
CSS, batched concat, immutable string-search, constant bitwise, proven-ASCII
case, and native number-format carrier optimizations are all pinned.

The frozen runtime A/B establishes parity within noise, and the complete
publication gate matrix is green. This closes the Builtins checkpoint, not the
R9 epic: Calendar's atomic six-unit retirement remains the next standalone
census step.

### Completed checkpoint: standalone Calendar capability transaction (2026-08-20)

#4577 advances the bounded standalone lane from **31 → 37 of 37 IR bodies**
and **6 → 0 legacy/typed Unsupported**, with every former reason bucket and
Invariant count at zero. The lane now enforces strict IR-only readiness rather
than the temporary baseline-only policy. The single-host control remains
37/37. This closes the exact five-entry playground census, not R9's complete
source-program denominator.

Calendar's nine functions and module init publish atomically with seven exact
reusable callbacks and five source-qualified nullable DOM globals. The frozen
`dom@1` eight-import ABI is unchanged; a separate two-import
`dom-interaction@1` provider owns listener/background mutation and the exact
one-import `clock@1` provider owns Date snapshots under the standalone
UTC/zero-offset profile. Compiler-owned import/storage/callback provenance,
complete registry contracts, instance-pinned runtime authority, multi-source
isolation, donor/tamper controls, and direct-body poison keep all of those
capabilities fail closed.

The final focused matrix is **59/59**. The same-source, same-standalone-runtime
IR-versus-legacy-direct artifact A/B records IR/direct at 30,089/32,379 raw
bytes, 18,387/19,030 gzip-9 bytes, 477,625/481,730 pre-optimization WAT
characters, 62,481/69,234 selected body characters, 155/172 locals, 172/172
calls, 156/167 functions, and 11/11 imports. All 660/660 measured executions
preserve the 12-render oracle, but bracket noise supports no runtime speedup
claim. Aggregate optimization evidence is recorded without promoting pending
per-transform performance rows.

The post-checkpoint reachability audit keeps R9/R10 open. `experimentalIR:
false`, `disableIrFirst`, and the environment kill switch still expose direct
selection; ordinary non-prepared single-source and all multi-source compilation
still enter legacy declarations/body walking before any overlay; fast
multi-source has no overlay; and CJS, nested containers, IIFEs, dynamic code,
generic class/module shapes, WASI, and linear remain outside this bounded
census. The next cutover must fail typed before body emission across that full
denominator, then prove the standalone legacy walkers unreachable before shared
direct code can be removed.

### Bounded audit: `bench_array` Prepared seam (2026-08-24)

The refreshed authoritative five-entry gate is green at **5/5 entries,
38/38 terminal units, 38/38 IR-emitted units, zero legacy bodies, zero typed
Unsupported outcomes, and zero Invariants** in both the single-host and
standalone lanes. That denominator is still bounded and does not prove
repository-wide IR-only readiness.

The exact multi-source `website/playground/examples/benchmarks/array.ts`
target remains a direct-body overlay: compiler-only standalone telemetry records
two source files, six all units, five terminal units, and **16** physical legacy
rows. `bench_array` has both `legacyBodyEmitted` and `irBodyEmitted`, with the
two direct rows exactly `compileFunctionBody` and `compileStatement`; the other
14 rows belong to helpers, DOM callback owners, `main`, declarations, and
module setup. The existing direct and IR paths agree on the target's `() -> f64`
ABI and the IR body already lowers the empty `number[]`, dense `push` fill,
`length`/indexed reduction, i32 vector carrier, in-bounds proof, and vector
allocation/access operations.

The existing scalar and function-value route primitives are sufficient for the
next bounded transaction, but the scalar candidate intentionally rejects array
syntax and the generic function-value candidate is specialized to the prior
reduction fixture. A safe implementation therefore needs one new
`src/codegen/multi-prepared-array-leaf.ts` route, wired narrowly at the shared
pre-body seam in `src/codegen/index.ts`. The route should reuse
`prepareIrBodies`, `skipBodies`/`preserveSkippedBodies`, exact UnitId/terminal
correlation, and the existing `MultiPreparedFunctionValueSupportReceipt` for
the one direct imported callback edge. Its checker proof must require the exact
exported no-parameter `number` declaration, `const arr: number[] = []`, the
literal counted `push` loop, the literal counted `length`/indexed reduction,
source-identity for every array/counter/accumulator/method use, and one stable
imported callback target. Any alias/re-export, extra candidate, capture,
reassignment, dynamic index, extra array method, callback/ABI tamper,
cross-file component, class, module-init, fast, WASI, or single-source near
miss must retain direct ownership or fail before publication.

The default-on rollback must be `JS2WASM_MULTI_PREPARED_ARRAY_CUTOVER=0` and
must restore exactly the current two target direct rows. Runtime instantiation,
raw/optimized WAT A/B, vector/bounds/call/allocation parity, and callback ABI
publication remain acceptance evidence for the implementation; this audit does
not claim those route-specific checks have passed.

### Implementation checkpoint: array leaf route after the first failed attempt (2026-08-24)

This is a design-only checkpoint. No compiler source, runtime artifact, or
heavy test result is accepted by this entry. The first implementation attempt
did not produce a safe array route: adding the route to the existing scalar
union is not enough, because the scalar recogniser rejects array syntax and the
function-value recogniser is deliberately limited to the earlier reduction
fixture. The next implementation must land as one independently reviewable
array transaction; it must not widen either generic recogniser or copy a second
array lowerer.

#### Exact candidate proof

Add `src/codegen/multi-prepared-array-leaf.ts`. Its exported candidate
collector/resolver should be named and shaped like the existing scalar leaf:
`collectMultiPreparedArrayLeafCandidates`,
`isMultiPreparedArrayLeafCandidateEligible`,
`tryPrepareMultiSourceArrayLeaf`,
`planEarlyMultiPreparedArrayLeafRoute`, and
`assertMultiPreparedArrayLeafRouteCurrent`. The route is eligible only when
all of these facts hold before any direct body is requested:

1. The shared planner is active only for `experimentalIR`, non-`disableIrFirst`,
   standalone WasmGC, non-fast, non-WASI, and a graph with more than one source;
   the candidate declaration is in the entry source and the array cutover
   switch is enabled. The resolver must use the exact `IrUnitId`, source record,
   declaration, terminal owner, claim, override, and `ProgramAbiSession`
   joins, not the spelling `bench_array`.
2. There is exactly one exported, bodyful, top-level, non-async,
   non-generator, non-generic, zero-parameter function with an explicit
   `number` return. Its five statements are exactly the benchmark shape from
   `website/playground/examples/benchmarks/array.ts:3-9`: one `const` binding
   with an explicit `number[]` annotation and empty literal; one counted loop
   beginning at numeric literal zero, with a strictly increasing update and a
   single `arr.push(i)` statement; one zero-initialised numeric accumulator; one
   counted `i < arr.length` loop with one `total = total + arr[i]` assignment;
   and a return of that same accumulator. Require the checker symbol for every
   array, counter, accumulator, `length`, `push`, and indexed access to match
   the candidate declarations. The push bound must be a safe integer literal
   (the real fixture is `10000`); do not admit an arbitrary expression merely
   because it currently lowers.
3. The proof must call the shared canonical helpers rather than duplicate their
   semantics: `canonicalCountedPushPlanForLiteral` and
   `canonicalCountedPushPlanForCall` in
   `src/ir/array-element-lowering.ts:226-264`, the empty-array inference and
   `number[]` annotation contract in `array-element-lowering.ts:292-324`, and
   the existing counted-loop/index proof in `src/ir/from-ast.ts:9278-9328`.
   Require the canonical push plan’s single-argument, non-spread, same-symbol
   receiver and pure non-aliasing value proof. Reject aliases, a `let` array,
   reassignment, additional writes/methods, a dynamic or negative bound,
   non-increasing updates, `<=`/`>=` bounds, index mutation, nested functions,
   an escaping array, an extra array literal, or any second eligible function.
4. The candidate’s local call/value graph is a singleton. The only runtime
   value observation of the candidate is the one identifier passed once as the
   fourth argument of an exact named imported call in the legacy `main` owner.
   Resolve that import through
   `resolveMultiPreparedFunctionValueImportTarget` in
   `src/codegen/multi-prepared-function-value-import-target.ts:36-102` and
   require the imported declaration to be the unique exported `addBenchCard`
   helper from the exact `helpers.ts` source record. The caller is a distinct
   top-level terminal with its own UnitId and remains direct-owned. Reject an
   alias, re-export, repeated/stored/returned value, same-source target,
   wrong-arity callback, callback type/ABI drift, an extra direct caller, or a
   callback whose owner/source identity changes.
5. The target must have the exact prepared `[] -> f64` override, one occupied
   callable with the matching source UnitId, no collision/suffix/import-alias/
   live-function binding, no class shape, no module-init/storage terminal,
   no derived owner, no cross-file target, and no late provider. A candidate
   that cannot be fully proven returns ordinary ineligibility before skip;
   drift after certification is an `IrInvariantError`, never a silent direct
   fallback after a skip was requested.

#### Route and receipt API

Reuse the common prepared body state from
`src/codegen/multi-prepared-scalar-leaf.ts:239-304` (export the route base if
needed) and add `MultiPreparedArrayLeafRoute` with `routeKind: "array"`.
`MultiPreparedArrayLeafPlan` may extend the scalar plan’s identity, claims,
overrides, and class-shape maps, but its receipt must retain an immutable shape
record: target UnitId/name/declaration, the exact array declaration, push and
reduction loop nodes, counter/accumulator declarations, source IDs, and the
canonical callback/value-edge evidence. This lets the late assertion prove
AST identity and symbol joins rather than trusting a name or a stale report.

The planner should mirror
`planEarlyMultiPreparedScalarLeafRoute` at
`multi-prepared-scalar-leaf.ts:1273-1337`: build one plan per candidate source,
compute the ordinary graph safety/selection, require exactly one eligible
entry-source candidate, and call `prepareIrBodies` with only the target
function. Reject any class-member, module-init, implicit-constructor, derived,
or second free-function result. Require the same exact skip/preserve/completed
body sets, terminal evidence, artifact evidence, nonempty prepared component,
and `[] -> f64` allocated callable checked by
`tryPrepareMultiSourceScalarLeaf` at `multi-prepared-scalar-leaf.ts:986-1104`.
Do not make a second array-specific IR builder: the prepared body must be the
existing `from-ast` result.

The array route must receive a callback
`prepareFunctionValueSupport(plan, sourceFile, unitId, legacyName)` from the
shared planner and call the existing private
`prepareTopLevelFunctionValueTargetSupport` in `src/codegen/index.ts:2265-2345`.
Store the returned `MultiPreparedFunctionValueSupportReceipt` unchanged and
revalidate it with `functionValueSupportIsCurrent` after the remaining legacy
owners run. This freezes the candidate callable plus exactly one trampoline,
cache global, support binding, locator, and Program ABI role before the direct
caller can materialise `bench_array`; it does not prepare or duplicate the
`addBenchCard` helper. The callback’s owner UnitId, imported target UnitId,
source key, call AST node, and distinct owner must be rechecked at the late
seam.

Wire the map in `src/codegen/index.ts:3570-3623` with
`JS2WASM_MULTI_PREPARED_ARRAY_CUTOVER` and an explicit route-overlap assertion.
The array route must be considered before the generic function-value route and
must never silently share a source state with scalar, Fibonacci, or bench-loop
routes. Reuse `compileMultiPreparedScalarLeafDeclarations` at
`index.ts:8718-8720`; in the late overlay at `index.ts:3665-3688`, dispatch an
array-specific current-route assertion before `completePreparedIrIntegration`.
The final assertion must check final selection, target/support allocator
identity, immutable prepared instruction sequence, exact report receipt, and
the unchanged callback/value edge. Any failed post-certification check is an
Invariant.

#### Existing IR shape that must remain load-bearing

The implementation must preserve the already measured lowerings, not replace
them with a fused hand-written body. `lowerArrayLiteral` uses the empty
`number[]` hint and canonical counted-push capacity at
`src/ir/from-ast.ts:4464-4533`; `tryLowerVecPush` emits the one-element vector
store and length increment at `src/ir/array-element-lowering.ts:368-448`;
`lowerPropertyAccess`/element access uses the counted-loop proof and only emits
unchecked `vec.get` for a proven `0 <= i < arr.length` at
`src/ir/from-ast.ts:5467-5476,5693-5781`; and `lowerForStatement` carries the
proof into the loop body at `from-ast.ts:9605-9640`. The route is correct only
when the resulting prepared body retains the i32 vector carrier, in-bounds
read, vector allocation/store/get, and f64 return conversion observed in the
baseline. If any of those facts cannot be certified, withdraw before skip.

#### Kill switch and focused test contract

Use `JS2WASM_MULTI_PREPARED_ARRAY_CUTOVER=0` as the exact pre-cutover control.
Add `tests/issue-3518-bench-array-prepared-cutover.test.ts`, following the
15/21-case structure of the existing #4589/#4590 route suites:

- default-on direct-body poison must compile with no target
  `compileFunctionBody`/`compileStatement` rows and report one `terminal-ir`
  target with `legacyBodyEmitted: false`, `irBodyEmitted: true`, and a prepared
  component; the kill switch must reproduce exactly the two target direct rows
  and fail the same poison;
- raw direct/Prepared audit rows must differ only by those two target rows;
  target raw WAT must retain the vector allocation, counted push/store, proven
  bounds/indexed get, i32 carrier, and `() -> f64` body shape; source callable,
  trampoline/cache, import/export, and callback Program ABI contracts must be
  exact and singleton;
- raw and optimized Prepared/direct A/B must instantiate and return
  `49_995_000`, preserve DTS/import helper/import/string-pool/public surfaces,
  retain callback publication, and show no optimized size or call/allocation
  regression. Runtime and WAT evidence are required for implementation
  acceptance; this design checkpoint makes no such claim;
- mutation cases must cover renamed-but-equivalent declarations (positive),
  extra candidate/extra caller, alias/re-export/stored value, `let`/reassigned
  array, non-empty or escaping array, push arity/spread/dynamic value, bound or
  index/update changes, `<=`/`>=`, additional array method, callback source or
  ABI tamper, support-name/allocator tamper, post-certification route tamper,
  class/module-init/cross-file component, and fast/WASI/IR-first-disabled
  controls. Every negative must retain the two direct rows or fail with a typed
  pre-emission Unsupported/Invariant; none may skip first and discover drift
  later;
- preserve the existing #4589, #4590, #4591, #2138, standalone-floor, and
  direct-caller suites. Add a required-route env for the positive fixture and
  a dedicated `JS2WASM_TEST_TAMPER_MULTI_PREPARED_ARRAY_LEAF` hook so the
  late fail-closed assertion is exercised without weakening production gates.

The implementation landed in #4836. The default route now removes exactly the
two `bench_array` direct rows and publishes one `terminal-ir` outcome with a
nonempty Prepared component; `JS2WASM_MULTI_PREPARED_ARRAY_CUTOVER=0` restores
the exact direct control. The focused **5/5** suite proves direct-body poison,
runtime/public-surface parity at **49,995,000**, post-certification tamper
failure, a genuinely ineligible loop-shape mutation, and the fast-lane direct
control. Typecheck, formatting, lint, IR layering, oracle ratchet, LOC/function
budgets, issue integrity, numeric local parity **18/18**, and the full PR gate
were green before the merge. This is compile-once evidence for that one
multi-source array leaf, not for the other 14 direct rows or for the wider
standalone program denominator.

### Implementation plan: counted-string semantic IR and `bench_string` cutover (2026-08-24)

The next smallest measured host-free standalone residual is
`website/playground/examples/benchmarks/string.ts::bench_string`. This is the
next residual in the benchmark cutover sequence, not a repository-wide
minimum. A fresh compiler-only census on the post-array tree ran with ten
logical cores, the strict one-minute load limit **< 8**, and a measured load of
**3.9091796875** before every compile:

| benchmark terminal | target legacy rows | current terminal outcome |
| --- | ---: | --- |
| `bench_loop` | 0 | Prepared `emitted`, IR-only body |
| `fib`, `bench_fib` | 0 each | Prepared `emitted`, IR-only bodies |
| `bench_array` | 0 | Prepared `emitted`, IR-only body |
| `bench_string` | 2 | `unsupported`, `select/string-builder-candidate` |
| `bench_dom` | 2 | `unsupported`, `select/host-surface-unavailable` |
| `bench_style` | 2 | `unsupported`, `select/host-surface-unavailable` |

`bench_string` is the only remaining host-free leaf in this measured set.
`bench_dom` and `bench_style` need the broader DOM-capability transaction and
are not interchangeable follow-up candidates.

The exact `bench_string` record is a two-source `compileProject` /
`generateMultiModule` standalone graph with six all units, five terminal
units, one owned support unit, and 16 physical legacy rows. The target source
is `ir-source:v1:0000000000000001:entry:string.ts`; its source-qualified
top-level-function UnitId owns exactly one `compileFunctionBody` row at 3:1
and one `compileStatement` row at 4:3. The other 14 rows belong to helpers,
the direct DOM caller, declarations, and module setup. The audit is
structurally complete with no violations or unattributed entries.

This residual is deliberate optimization preservation. #1004's direct
`tryCompileCountedStringAppend` recognises the exact counted literal append and
replaces 1,000 loop iterations with **one `repeat(1000)` plus one concat**.
`stringBuilderForcedLegacy` therefore withholds the source because the IR
currently has concat and length semantics but no repeat intent. Removing that
selector arm before migrating the transform would turn one aggregate
operation back into 1,000 allocations/calls and violate this epic's
optimization-retirement rule.

#### Transaction A — one shared counted-append proof

Move the semantic proof out of the direct codegen handler into
`src/ir/analysis/counted-string-append.ts`. It must return an immutable
`IrCountedStringAppendPlan`, not synthesized TypeScript AST. Like the existing
counted-push analysis, this plan owns syntax, checker-symbol, type, and
constant facts only; it must not import preparation-owned UnitIds. A separate
`PreparedCountedStringAppendReceipt` pairs the plan's exact AST/symbol identity
with the source record, owner UnitId, provider authority, and final instruction
digest during preparation. The syntax plan records the
accumulator/counter/fragment declarations and checker symbols, exact
loop/append source nodes, start/bound/comparison/unit-step, safe integer trip
count, and accumulator/fragment string types. The proof remains deliberately
tight:

1. one writable `let` integer counter initialized from an exact safe integer;
2. `i < B` or `i <= B` with an exact safe-integer literal or checker-proven
   `const`, and only `i++`, `++i`, or `i += 1`;
3. one body statement, `s = s + fragment` or `s += fragment`, with the same
   checker symbol for every `s` use;
4. a string literal/no-substitution template or a distinct, string-typed,
   source-local immutable identifier as the side-effect-free fragment; and
5. a checker-proven writable `let` accumulator; never `const`, an accessor, or
   an imported/read-only binding; and
6. no capture, alias, getter/member read, call, spread, counter dependency,
   accumulator self-fragment, extra statement, second write, or observable
   intermediate value.

Every checker-resolved constant used for the counter start, bound, or fragment
must be a source-local declaration with an initializer that lexically
dominates the loop in the same reachable scope. Forward declarations, TDZ
reads, cross-source bindings, initializer cycles, and values established only
by a later statement are rejected even if `constInitializerOf` can recover an
initializer node. Add forward-bound and forward-fragment TDZ controls; folding
must never erase the `ReferenceError` that direct JavaScript would produce.

The existing direct handler must consume this same plan while hybrid rollback
exists. It may construct its temporary AST only after the shared proof has
succeeded; it must not retain a second recognizer. Plan identity must be
revalidated immediately before either direct or IR emission so a stale checker
node, source record, UnitId, symbol, or trip count fails typed before artifact
publication.

Trip-count behavior is part of the semantic contract: zero iterations emit no
write, one iteration emits one ordinary concat without repeat machinery, and
two or more iterations emit exactly one repeat and one concat. Inclusive
bounds and nonzero starts use the same checked arithmetic as #1004. Overflow,
non-safe integers, negative/non-finite derived counts, or changed source nodes
withdraw before body skipping.

#### Transaction B — backend-neutral JS-dialect `string.repeat`

Land Transaction B as two signed, queueable checkpoints rather than one large
cutover commit:

1. **B1 — dialect/provider foundation.** Add the v5.2 JS-dialect instruction,
   verifier/effect/clone/digest coverage, exact host/native/linear provider
   ABIs, reservation/authentication, and executable provider tests. This
   checkpoint is intentionally producer-free: it must not remove the selector
   deferral or claim that `bench_string` moved. Its PR description and evidence
   say exactly that.
2. **B2 — counted-plan consumer and cutover.** Starting only after A and B1
   land, consume the shared proof in `from-ast`, implement the `N=0/1/>=2`
   shapes, reserve the linear provider from the prepared receipt before slots,
   remove only the unconditional counted-append deferral, and prove the exact
   builder-off rollback. This is the first checkpoint allowed to claim that the
   single-source counted loop is Prepared.

Transaction C remains a third PR because its source-qualified multi-module
callback composition and rollback are independently reviewable. Do not fold C
into B2 merely to make the bounded standalone census turn green sooner.

Add `string.repeat` to the typed JavaScript IR dialect rather than encoding the
optimization as a backend helper call in the frontend. “Backend-neutral” here
means that host WasmGC, native WasmGC, and linear consume one typed semantic
operation; it does not misclassify ECMAScript `ToIntegerOrInfinity`/RangeError
behavior as language-neutral core IR. The instruction owns a
typed string operand, a JS-number count operand, one string result/allocation,
producer encoding evidence, and an optional provider reference filled only by
final preparation. Extend the builder, node union, in-memory clone and digest
logic, effects, ownership, verifier, prepared-component dependency discovery,
backend legality, inliner/monomorphizer/value-use switches, and string-support
provider mapping. Append the instruction to the frozen schema table and bump
the normative IR contract from v5.1 to v5.2. Executable Prepared-program
serialization is still future work in the current contract; this transaction
must test in-memory clone/prepare/digest/tamper and must not claim an executable
serialize/deserialize round trip unless that separate prerequisite actually
lands. Verification must require `(string, f64) -> string`, exact
allocation/result typing, and provider authority before a component seals.

Add `repeat` to `IrStringRuntimeIntrinsic` with the full ECMAScript
`ToIntegerOrInfinity` contract. The counted-plan producer supplies a proven
nonnegative safe integer, but the instruction/runtime ABI must not silently
redefine dynamic `String.prototype.repeat` semantics for later producers.
Negative or `+Infinity` counts remain RangeError/trap according to each
backend's already documented exception substrate; `NaN`/`-0` normalize as the
existing direct implementations do. Because a general repeat can throw, its
effect classification is a control/full barrier: DCE may not erase it and the
scheduler may not move it across observable effects. The counted producer's
safe constant proof does not silently weaken the general instruction's effect
unless a separately verified nonthrowing-evidence field is added and tested.

Final preparation binds providers without AST inspection:

- host-string WasmGC binds the existing exact `env.string_repeat`
  `(externref, f64) -> externref` callable; it does not pretend the current
  `wasm:js-string` concat/equals provider also owns repeat;
- native-string WasmGC binds a new prepared
  `(ref null $AnyString, f64) -> (ref null $AnyString)` adapter which performs
  `ToIntegerOrInfinity` and RangeError validation before delegating the
  integer count to the existing `__str_repeat`; the unvalidated native helper
  is not itself the semantic provider;
- linear binds the existing `(linear-string, f64) -> linear-string`
  `LINEAR_STRING_REPEAT_FN` runtime from
  `src/codegen-linear/string-repeat.ts`.

The linear integration must consume the same instruction and provider plan as
WasmGC. Linear runtime functions are registered before user slots while final
IR preparation currently happens later, so the shared counted-plan receipt
must reserve the repeat provider before slot assignment and final preparation
must authenticate that same reservation. Add the missing linear
resolver/emitter path. A Prepared body must not re-run
`sourceMayUseLinearStringRepeat`, inspect a property access, or use
`compileLinearStringRepeatCall`. Backend incapability is a typed pre-emission
outcome; it cannot request a legacy AST retry.

`from-ast` consumes `IrCountedStringAppendPlan` before ordinary loop lowering.
For `N >= 2` it materializes the fragment once, emits one `string.repeat`, then
one `string.concat` using `owned-append` only when the existing ownership proof
allows it, and writes the accumulator once. It emits no IR loop. The result's
encoding/allocation evidence flows through the existing string analyses and
must not bypass concat batching, native literal materialization, or linear
memory planning. For `N == 0/1`, use the exact special cases above.

Once this path is sealed, remove only the unconditional
`containsCountedLiteralStringAppend` deferral from
`stringBuilderForcedLegacy`. The current general builder detector recognizes
only `+=`, while the benchmark uses `s = s + fragment`; therefore
`JS2WASM_IR_STRING_BUILDER=0` must explicitly consult **both** the existing
builder detector and the new shared counted-append proof. This makes the same
switch restore both accepted assignment forms without retaining unconditional
deferral or adding a second global string-builder escape hatch. Update the
#1004 test that currently requires the function to stay off IR: it must instead
require the exact Prepared `string.repeat` + concat instruction/output shape
while retaining all 18 semantic and guard cases. Add explicit `const` counter,
`const` accumulator, and read-only/imported accumulator negatives so the
shared proof does not preserve the direct handler's current over-acceptance.

##### B2 implementation checkpoint contract (2026-08-24)

B2 is a stacked implementation worktree while the independently queueable B1
provider foundation is still landing; it must not be published as a completed
cutover until its parent is on `main`. The checkpoint has five atomic proof
boundaries:

1. production selection calls the shared checker/oracle proof, retains every
   accepted loop under its exact source and terminal UnitId, and bare selector
   callers keep the historical conservative deferral;
2. `from-ast` consumes that exact plan before generic loop lowering and emits
   no write for zero trips, one concat for one trip, or exactly one
   provider-bound repeat plus one concat for two or more trips;
3. a `PreparedCountedStringAppendReceipt` survives early/late report merging,
   is removed when its owner is deferred, and is published only after the
   exact terminal patch succeeds with a digest of the final provider-bound IR;
4. single-source linear compilation runs identity selection once before user
   slots, reserves repeat only from the retained exact plan, and later
   authenticates the same source/preparation/reservation object. The direct
   AST `.repeat` heuristic remains a separate compatibility authority and the
   multi-source path remains Transaction C; and
5. focused kills cover missing proof, builder-off rollback, stale
   owner/source/provider, unconsumed or duplicate plan/receipt rows, all three
   trip-count shapes, reservation mismatch, default-on direct-body poison, and
   a multi-source direct-poison control that stays legacy-owned until
   Transaction C.

The checkpoint's runtime verdict must additionally execute WasmGC standalone
and linear artifacts and inspect the target body rather than merely finding a
repeat helper elsewhere in the module. A green selector claim, a whole-module
helper name, or a compact route summary is not acceptance evidence.

For this bounded checkpoint, the counted-loop consumer is the only producer of
`IrBuilder.emitStringRepeat`, so the final per-function repeat census is exact.
Before Transaction C or any second IR repeat producer lands, the instruction
must gain plan/site provenance and a coexistence mutation; a function-wide
count must not silently become a general association proof. After the shared
counted proof is retained, any build, legality, provider-authentication, or
lowering failure is fatal rather than eligible for direct retry. A receipt is
publishable only after its exact terminal artifact compiled; a synthetic child
artifact is not terminal-patch evidence.

The change-scoped LOC/function allowances above are limited to these explicit
B2 seams: single-source selection, exact plan consumption, final receipt
publication/filtering, and backend orchestration. They do not authorize a
second recognizer, multi-source admission, or generic direct-path growth.

#### Transaction C — exact multi-source string leaf

Transaction C is a standalone-WasmGC graph-composition transaction. It does
not claim that the current direct-only multi-source linear compiler has gained
Prepared graph identity, exact UnitId slot adapters, or authenticated receipt
composition. The linear acceptance evidence in Transaction B is the
single-source B2 control proving that the same semantic `string.repeat`
instruction lowers through the linear provider. A future multi-linear cutover
must first land graph-wide identity/options propagation, duplicate-label-safe
slot ownership, and early graph preparation as its own reviewed transaction;
finding `$__str_repeat` somewhere in a direct multi-linear module is not that
evidence.

Before the multi-source route is wired, land a small provenance foundation.
The B2 receipt census is intentionally function-wide only while the counted
consumer is the sole `IrBuilder.emitStringRepeat` producer. C introduces a
second composition boundary, so every counted `string.repeat` must retain an
immutable source-qualified site identity derived from its exact
`IrCountedStringAppendPlan`. Builder creation, verifier, clone/map/inlining,
in-memory digest, WasmGC preparation, linear preparation, and both receipt
validators must preserve and authenticate that identity. Receipt construction
must join each plan to its exact final instruction site rather than accepting
only equal per-function counts/providers. Add non-vacuous coexistence,
reorder, replacement, duplicate-site, missing-site, and borrowed-site
mutations for WasmGC and linear before the production C route can claim a
body.

Land C as three independently reviewable signed checkpoints:

1. **C0 — counted repeat site provenance.** Add the immutable site identity
   and replace both function-wide receipt associations with exact plan/site
   joins. This checkpoint changes no route policy.
2. **C1 — pure string leaf planner.** Add the structural/source-qualified
   candidate, exact retained-plan, callback/import, UnitId, Program ABI, and
   support-receipt validator with mutation-heavy pure tests, but no skip or
   production orchestration.
3. **C2 — standalone WasmGC orchestration.** Wire the planner before generic
   function-value handling, assert non-overlap with scalar/array/Fibonacci/
   bench-loop routes, prepare only the target body, revalidate after all direct
   owners, merge the exact report/receipt, add the rollback switch to #4522,
   and publish raw audit/runtime evidence.

##### C0 implementation checkpoint contract (2026-08-24)

C0 is a behavior-neutral provenance and authentication transaction. It must
not enable another source route, change the B2 direct/Prepared matrix, or claim
the multi-source cutover. Add a branded primitive
`IrCountedStringAppendSiteId` and derive it with one shared factory from the
exact `{ sourceId, ownerUnitId, loopStart, loopEnd }` tuple, using the loop's
source-file positions and a collision-free canonical encoding. Every retained
`IrCountedStringAppendLoweringPlan`, including the zero- and one-trip shapes,
owns this required site ID. Only the two-or-more-trip shape emits a
`string.repeat`, whose new `countedStringAppendSite` field is optional so
unrelated/future general repeat producers remain valid and distinguishable.
Do not reuse the diagnostic `{ line, column }` instruction `site`, which is
neither source-qualified nor unique.

Own the brand, factory/parser, and final exact-site join in a new
`src/ir/counted-string-append-provenance.ts` module. That module accepts only
identity primitives, lowering plans, and final IR artifacts; it must not import
the TypeScript checker or recreate the syntax recognizer. This keeps one
backend-independent authority callable from both WasmGC and linear without an
IR-to-codegen dependency cycle.

The factory is called at the source/UnitId projection seam after the live AST
proof has been revalidated. Both
`src/codegen/ir-overlay-identity.ts::projectIrIntegrationLoweringPlans` and
`src/ir/backend/linear-integration.ts::planLinearIrOverlay` consume that one
factory; neither may invent its own encoding. `from-ast` passes the retained
ID into the sole counted `emitStringRepeat` call. The verifier validates the
canonical ID grammar and source span, while final preparation authenticates
membership and ownership. This field is semantic, serialized contract state
and participates automatically in the canonical instruction digest, so C0
bumps the JS-dialect IR contract and JSON schema from **v5.2 to v5.3**. It does
not claim executable Prepared-program serialization, which remains a separate
prerequisite.

Replace both positional function-wide repeat censuses with one shared exact
site join:

1. build a unique `expectedBySite` over retained plans with trip count at
   least two and reject duplicate expected IDs;
2. scan every successful final artifact deeply, including artifacts without a
   counted sidecar, and ignore only generic repeats whose site field is absent;
3. for each provenance-bearing repeat require a canonical known site, its
   exact source and terminal owner, and the expected canonical provider;
4. reject foreign, borrowed, forged, or duplicate sites, then require every
   expected site exactly once;
5. require zero/one-trip plans to emit no provenance-bearing repeat but still
   publish their plan receipt; and
6. digest the final instruction list and publish receipts in canonical retained
   plan order only after backend lowering and exact terminal patch success.

`PreparedCountedStringAppendReceipt` exposes and authenticates the plan's site
ID. Report validation, deferral filtering, and merge duplicate detection use
that canonical ID as their authority; live `syntaxPlan.loop` object identity
remains only an earlier stale-proof check and cannot authorize publication.
A receipt-bearing input report must independently carry its exact terminal
artifact, so another merge input cannot launder the receipt. WasmGC and linear
must use the same join helper and failure vocabulary.

Until ownership-transfer provenance exists, reject provenance-bearing
functions from `inline-small` and `monomorphize`; preserving an enumerable
field while cloning or moving the instruction is not proof that its original
terminal owner still owns it. Other mappers/provider attachment must preserve
the field exactly, and digest mutations must prove that removing, changing, or
borrowing it changes or invalidates the authenticated evidence.

C0 focused evidence is non-vacuous and backend-paired: an unrelated generic
repeat may coexist; reordered counted repeats still join by site; replacement
with a no-site repeat, unknown/forged site, duplicate site, deleted site,
same-source different-owner borrowing, and cross-source borrowing all fail.
Zero/one-trip plans publish receipts without a repeat. Mapper/clone/provider
tests preserve the site, the verifier rejects malformed/noncanonical IDs, and
report merge rejects a duplicate canonical site even when its AST objects were
cloned or reparsed. C0 runs the existing B2 WasmGC/linear runtime controls and
proves byte/runtime route policy is unchanged before its signed checkpoint.

##### C0 current-main implementation plan (2026-08-25)

Implement C0 as one behavior-neutral signed PR on the current `main`, with no
C1 planner or C2 route wiring mixed into the delta. Preserve the reviewed
two-file site-ID draft as input, but do not publish that foundation alone: the
checkpoint is complete only when both backends and every publication boundary
use the new authority.

1. **Identity and contract surface.** Add
   `src/ir/counted-string-append-provenance.ts` as the only brand,
   factory/parser/currentness, and final association authority. The primitive
   grammar proves a source-qualified, non-derived UnitId and canonical
   fixed-width non-negative source span; the projection and final association
   additionally prove that UnitId is an inventoried terminal owner. Add
   required `siteId` to
   `IrCountedStringAppendLoweringPlan` and
   `PreparedCountedStringAppendReceipt`; add optional
   `countedStringAppendSite` to `IrInstrStringRepeat` and the builder API.
   Bump `IR_FORMAT_VERSION`, the contract prose, JSON schema, and backend
   contract assertions from v5.2 to v5.3. The optional instruction field is
   serialized semantic state; the schema must reject malformed values when it
   is present while continuing to admit unrelated generic repeats without it.
2. **Single projection and consumption.** At the WasmGC
   `projectIrIntegrationLoweringPlans` seam and the linear
   `planLinearIrOverlay` seam, create the site ID exactly once after the live
   loop/source/declaration/UnitId proof succeeds. Revalidation must recompute
   the same ID from the retained source span; it may not accept spelling,
   map position, or AST object identity. `from-ast` passes that exact ID only
   to the two-or-more-trip `emitStringRepeat`; zero/one-trip plans still retain
   their site ID and are consumed exactly once without emitting a
   provenance-bearing repeat.
3. **Shared final association.** Expose one pure helper from the provenance
   module that accepts retained plans plus successful final terminal artifacts
   and returns frozen receipts in canonical retained-plan order. It builds a
   unique expected-site index, walks every artifact deeply (including an
   artifact with no counted sidecar), selects prepared executable
   `asyncRuntime` state bodies when present and otherwise the semantic
   `asyncPlan` bodies (never both), ignores only site-less generic repeats,
   and joins each provenance-bearing repeat to the exact site, source,
   terminal owner, and canonical provider. It rejects malformed, unknown,
   borrowed, duplicate, missing, and unexpected sites; rejects a
   provenance-bearing repeat for a zero/one-trip plan; and includes the final
   provider-bound instruction digest in every receipt. WasmGC and linear call
   this same helper and use its failure vocabulary. Receipt publication stays
   after exact terminal patch/backend success; an earlier successful owner
   cannot publish if a later counted owner makes the transaction fatal.
4. **Publication and transformation boundaries.** Validate receipt `siteId`
   against its plan in `integration-report`, retain the existing exact terminal
   artifact requirement, filter deferred receipts by exact owner without
   rewriting their site, and detect merge duplicates by canonical site rather
   than `syntaxPlan.loop` identity. Provider attachment, nested-buffer maps,
   value-ID rewrites, and instruction digests must preserve/include the field.
   Until a separately reviewed ownership-transfer proof exists, `inline-small`
   must not inline from or into a function containing a provenance-bearing
   repeat, and `monomorphize` must not clone one; add explicit fail-closed
   guards rather than relying on object spread.
5. **Non-vacuous evidence.** Extend the focused C0 unit suite with canonical
   grammar/ownership/span mutations, builder and verifier checks, provider and
   mapper preservation, digest sensitivity, and pass rejection. Exercise the
   shared association helper identically for WasmGC-shaped and linear-shaped
   artifacts with: a coexisting generic repeat, reordered counted sites,
   replacement by a site-less repeat, deleted/duplicate/unknown/forged sites,
   same-source different-owner and cross-source borrowing, wrong provider,
   wrong terminal/source, and zero/one-trip receipt rows. Extend report/merge
   tests with cloned/reparsed AST objects carrying the same canonical site so
   duplicate detection cannot regress to object identity. Re-run the existing
   B2 WasmGC and linear runtime/body-attribution suites and prove route,
   artifact, and runtime behavior remain unchanged.
6. **Review and landing discipline.** Use separate non-overlapping execution
   ownership for production/authentication code and contract/tests, followed
   by an independent read-only review of their integrated bytes. Add LOC or
   function-budget allowances only for measured irreducible growth, never
   speculatively. Before the signed commit run the explicit LOC-regrowth
   ratchet, then all normal pre-commit hooks; before the non-force push run all
   normal pre-push hooks. Every heavy command and the commit/push boundary
   requires a fresh finite non-negative one-minute load strictly below
   `logical cores - 2`. Shepherd the PR through actual merge before beginning
   C1.

##### C1 current-main implementation plan (2026-08-25)

C1 is a dormant, behavior-neutral planner checkpoint that begins only after
C0 is merged on `main`. Its implementation commit adds exactly two files:

- `src/codegen/multi-prepared-string-leaf.ts`; and
- `tests/issue-3518-multi-prepared-string-leaf-planner.test.ts`.

It must not edit `src/codegen/index.ts`, `MultiPreparedEarlyLeafRoute`, any
skip/preserve set, `prepareIrBodies`, an environment switch, or #4522's
retirement inventory. It must not allocate a Wasm function, prepare a body,
or mutate a `CodegenContext`. Those belong to C2. The checkpoint is useful as
an independently signed and reviewed local commit because it freezes the exact
proof object and fail-closed currentness contract C2 must consume instead of
growing a second recognizer in the orchestrator. It is **not** independently
publishable: the dead-export audit intentionally ignores tests, so a new
unconsumed planner module would be new production dead code. Do not add a fake
import or increase `scripts/dead-export-baseline.json`. Land this issue-plan
amendment first, create and review the two-file C1 implementation commit, then
add C2's real production consumer before the branch is pushed or opened as a
PR.

1. **Minimal dormant planner API.** Define a frozen
   `MultiPreparedStringLeafShape` containing the exact proof-owned const
   declaration closure, accumulator declaration, counted loop, `.length` read,
   return statement, and exact cached shared `IrCountedStringAppendPlan` object.
   The collector invokes shared `planCountedStringAppend` read-only for the
   exact structural loop and never rebuilds that proof. Define a
   frozen `MultiPreparedStringLeafCandidateEvidence` extending the existing
   function-value evidence with `shape: MultiPreparedStringLeafShape` retained
   by exact object identity, the entry source/source ID/declaration, the exact
   projected `IrCountedStringAppendLoweringPlan`, imported target declaration/
   source ID, and exact caller declaration/UnitId. Candidate currentness must
   re-walk the body against the retained `candidate.shape`, compare every
   structural node, symbol, and proof-owned const closure by exact identity,
   and call
   `countedStringAppendPlanIsCurrent(proofContext, candidate.shape.plan)`; it
   must not allocate a fresh shape/plan and compare those wrapper identities.
   Export only
   `collectMultiPreparedStringLeafShapes`,
   `resolveMultiPreparedStringLeafCandidate`,
   `requireCurrentMultiPreparedStringLeafCandidate`, and
   `requireCurrentMultiPreparedStringLeafSupport`, plus the exact types in
   those signatures. The collector invokes the module-private structural
   eligibility predicate; the resolver consumes collector output and rechecks
   eligibility; each `requireCurrent*` wrapper calls one module-private boolean
   currentness predicate. C2 must import every exported value through that real
   production chain, and `check:dead-exports` must report zero new rows. Do not
   export redundant boolean/assertion aliases solely for tests. The resolver input carries the current
   `CodegenContext`, entry source, `MultiPreparedFunctionValuePlan`, safe
   selection, projected lowering plans, graph safety, checker/oracle proof
   context, and a `hasForeignLateProvider(unitId)` query. It requires the exact
   same `ctx.irPlanningIdentityContext`,
   `plan.identityPlan.identityContext`, and
   `projectedLoweringPlans.identityContext` object; their source/declaration/
   UnitId forward and reverse maps must join the exact retained sources,
   declarations, units, and terminals. The selector's counted-plan map for the
   candidate UnitId must be an exact singleton containing `shape.plan`, and
   the projected counted-plan map must have the exact singleton
   `shape.loop -> candidate.loweringPlan` entry for that candidate. All return
   values are immutable and every ordinary mismatch returns
   `undefined`/`false` before mutation; currentness drift after a frozen
   candidate exists throws the shared invariant vocabulary only when the caller
   explicitly requests the invariant form.

2. **Exact structural candidate.** Admit one exported, top-level, bodyful,
   non-async, non-generator, non-generic, zero-parameter entry-source function
   with an explicit `number` result. Its body contains exactly the top-level
   immutable declarations named by the retained syntax plan's transitive
   `startConstDeclarations`, `boundConstDeclarations`, and
   `fragmentConstDeclarations` union; one `let` string accumulator declaration;
   the retained counted-string loop; and
   `return <same-symbol>.length`. Every proof-owned const shares the same
   runtime owner, resolves to the exact retained declaration/symbol, and
   lexically dominates its use and the loop. Empty proof arrays retain the
   minimal accumulator/loop/return form. Resolve symbols through the checker;
   do not accept spelling equality. Reject a missing, duplicated, nested,
   reordered-after-use, or unreferenced const as well as any other declaration,
   statement, loop, call, property read, accumulator alias/reassignment/
   capture, class, module-init/storage terminal, or derived owner. Accept the
   shared counted proof's supported `+=`, assignment, braced-body,
   nonempty-seed, identifier fragment/start/bound chains, and zero/one/two-plus
   trip shapes without copying their syntax recognizer.

3. **Identity, selection, ABI, and provenance join.** Require one exact
   source-owned, self-owned `top-level-function` terminal UnitId for the
   candidate; the declaration, identity inventory, claim, safe UnitId,
   selection, source record, `functionClaimsByUnitId`, both override maps, and
   Program ABI registry must all name that same unit. The callable is the
   unique allocated empty target with exact `[] -> f64` ABI. Scope the route
   exclusions to that candidate owner: reject its module-init selection/
   storage, class ownership, derived children, local-call or cross-file call
   component, direct caller activation target, or additional runtime
   function-value target. Evaluate foreign-late-provider evidence with the
   existing `multiIrFunctionValueLeafHasForeignLateProvider(..., true)`
   semantics so the candidate's one expected function-value target does not
   reject itself. Unrelated `main` edges, the second `helpers.ts` import, and
   helper-owned arrow support remain valid graph members and must not be
   rejected as candidate dependencies. Require exactly one selector-retained
   syntax plan and one projected
   lowering plan for the same loop. The projected plan must retain the exact
   syntax-plan object, source file/source ID/terminal owner, canonical
   `String.prototype.repeat` provider, and current C0 site. Re-run
   `countedStringAppendPlanIsCurrent` and
   `requireCurrentIrCountedStringAppendPlanSite`; a same-shaped loop, copied
   AST, borrowed site, spelling match, or map position is never authority.

4. **Exact callback and import edge.** The candidate declaration has exactly
   one value use: argument index 3 of one non-optional, non-generic,
   non-spread call with exactly four arguments. Its nearest function owner is
   the exact top-level entry-source `main` declaration, with a distinct
   self-owned terminal UnitId, explicit `() -> void`, and no safe/final IR
   selection. No stored, returned, directly-called, duplicated, aliased, or
   second-caller use is accepted. Resolve the callee with
   `resolveMultiPreparedFunctionValueImportTarget`, then additionally require
   a direct unaliased named import whose exact inventory `sourceKey` is
   `helpers.ts`, exact exported declaration name is `addBenchCard`, and exact
   distinct source/UnitId/declaration joins hold. The oracle resolves exactly
   one bodyful direct named-export declaration with zero type parameters and no
   overload siblings. Its four parameters are exactly
   `HTMLElement, string, string, () => number`; all are required and none is
   optional, rest, defaulted, or generic. Its explicit result is `void`.
   Reject suffix matches, shadowing, re-export, same-source targets, duplicate
   targets, or helper ABI drift. Candidate currentness must rerun the exact
   argument-index/four-argument/nonspread/nonoptional/nongeneric call proof,
   unaliased import declaration, source key, singleton helper declaration, and
   complete helper ABI; shared function-value-use currentness alone is not
   sufficient.

5. **Graph and allocation safety.** Reuse `buildMultiIrGraphSafety`,
   `exactAllocatedNumericCallable`, and the shared Program-ABI authorities.
   Apply target-reference and occupied-target checks to the candidate's exact
   route projection, not to unrelated functions in the two-source program.
   Reject candidate/import/caller name collisions, a foreign reference to the
   candidate outside the one callback edge, import-alias collisions, any
   occupied candidate-target count other than one, `$`-suffix slots, live
   candidate bindings, preoccupied trampoline/cache namespaces, and mismatched
   callable objects or handles. C1 may inspect the allocation state but must
   prove its own calls do not change module arrays, maps, registries,
   Program-ABI plans/locators, or selection cardinalities.

6. **Three-boundary support currentness.** Wrap rather than alias
   `functionValueSupportIsCurrent` and distinguish three exact boundaries:

   - the pre-support candidate check requires the empty target body and empty
     trampoline/cache namespaces; a mismatch is an ordinary pre-mutation
     decline;
   - immediately after `prepareTopLevelFunctionValueTargetSupport`, the
     post-support/pre-body `before-prepare` check requires the target body still
     empty and authenticates the exact frozen support receipt with
     `functionValueSupportIsCurrent(ctx, candidate, receipt, true)`. The
     support namespaces are now occupied and must not be tested for emptiness.
     At this boundary the source-callable registry observation is the Program-
     ABI authority for the target; only the trampoline/cache have session
     plans and current locators. Authenticate the exact target/handle,
     trampoline function/handle/ref/binding/one-call body, cache global/handle/
     ref/binding/type/init/mutability, unique live support names, recomputed
     support role/binding references, and reverse singleton row
     `ctx.funcClosureSingletonKeyByFuncIdx.get(targetHandle) === legacyName`.
     Any mismatch is fatal because support allocation already began; and
   - `after-direct` authenticates the same receipt and current candidate/
     callback edge with
     `functionValueSupportIsCurrent(ctx, candidate, receipt, false)` while
     permitting a bodyful target. C2 must additionally authenticate the exact
     live target body-array reference and instruction-identity snapshot; this
     boundary never treats an arbitrary nonempty body as the prepared one.

   Stable candidate currentness is separate from the pre-support eligibility
   predicate and never reruns the initial namespace-emptiness checks after
   allocation.

7. **Non-vacuous pure test matrix.** Build the full in-memory
   `website/playground/examples/benchmarks/string.ts` plus `helpers.ts` graph:
   exactly two sources, six inventory units, five terminals, both entry-source
   imports, and the one helper-owned arrow support unit. Create the real checker, identity inventory/context,
   declaration allocation, safe selection, projected C0 lowering plan, and
   Program-ABI support objects. C1 is intentionally dormant, so the test
   fixture must explicitly request counted-string proof through the same
   exported planning boundary used by the enabled single-source controls; it
   must not assume current multi-source orchestration populated the plan or
   hand-forge a lowering-plan object. Pin positive controls for a renamed
   candidate, canonical fixture, unrelated `main`/helper edges retained as
   positive evidence, all shared assignment/seed/trip-count and immutable
   fragment/start/bound declaration-chain variants, and
   unchanged module/map/registry cardinalities after every planning call.
   Mutations must reject:

   - export/body/async/generator/type-parameter/parameter/result drift;
   - extra statement/local/loop/call/property, wrong return receiver/property,
     accumulator alias/reassignment/capture;
   - missing/duplicate/detached syntax or projected plan, stale/forged/
     borrowed site/span, wrong source/owner/provider;
   - missing/swapped/non-self claims, terminals, declarations, selections,
     source records, override rows, module-init/class/derived/call-component
     ownership;
   - missing/duplicate/stored/returned/directly-called callback use, second
     caller, wrong argument index/arity, spread, optional or generic call;
   - aliased/shadowed/re-exported/same-source/wrong-sourceKey import, wrong
     helper name, duplicate target, callback-parameter or result ABI drift;
   - wrong/nested/selected caller, equal/swapped/missing UnitIds, occupied
     names/suffix keys/live bindings, target/support ABI or identity drift; and
   - unfrozen/swapped support receipt members, wrong trampoline target/body,
     cache shape, binding, locator/current index, duplicate live support names,
     and final AST/selection/safety/site drift.

   Every mutation must identify the one fact it changes, retain a positive
   sibling, and assert planner cardinalities remain zero/one as expected so an
   empty detector cannot masquerade as a pass.

8. **Checkpoint gates and C2 handoff.** Measure LOC/function growth and add
   only exact #3518 allowances if a gate proves them necessary; do not add a
   speculative `total` allowance or any dead-export baseline row. Run the
   focused planner suite, TypeScript 7 and 5, Prettier, IR
   layering/dialect/fallback, oracle/coercion/optimization, LOC and function
   ratchets. Run the LOC ratchet again immediately before a normally signed C1
   commit and run every normal pre-commit hook. Keep that signed commit local
   and obtain an independent read-only review. C2 must then import only this
   frozen planner contract, add the route union/orchestration/rollback
   inventory, prepare the target, request the exact skip, and revalidate the
   same evidence after all direct owners; C2 must not duplicate or weaken any
   C1 predicate. Only the combined C1+C2 change may run the normal pre-push
   hooks, prove the production reachability audit has zero new dead exports,
   open a ready PR, and enter the merge queue. Every heavy command and every
   commit/push boundary uses a fresh finite nonnegative one-minute load
   strictly below `logical cores - 2`.

##### C2 current-main orchestration plan (2026-08-25)

C2 begins only after C0 is on live `main` and the signed C1 two-file checkpoint
has passed independent review. It turns the dormant planner into one narrowly
default-on standalone WasmGC route. The initial production boundary is:

- extend `src/codegen/multi-prepared-string-leaf.ts` with the route and
  currentness contract;
- add only a type-level string arm to `MultiPreparedEarlyLeafRoute` in
  `src/codegen/multi-prepared-scalar-leaf.ts`;
- thread the scalar-claim exclusion into the array planner in
  `src/codegen/multi-prepared-array-leaf.ts` before its first preparation;
- orchestrate it in `src/codegen/index.ts`;
- thread the frozen pre-mutation exclusion input through
  `src/codegen/multi-prepared-fibonacci-pair.ts` to the later generic route;
- add `tests/issue-3518-bench-string-prepared-cutover.test.ts`;
- extend `tests/issue-1004.test.ts` only with the exact retained callback/
  observable-result assertions;
- update #4522's bounded-switch inventory in the same behavioral commit; and
- add a durable runtime measurement driver before changing optimization
  retirement evidence.

No `src/ir/*`, public compiler option, schema/dialect, handwritten Wasm body,
linear executable route, or second planner is in scope.

1. **Exact-loop proof injection is a prerequisite, not a global mode.** The
   current multi-source call to `planMultiIrOverlaySource` never sets
   `enableCountedStringAppendProof`, so it cannot produce C0's authenticated
   plan/receipt. C1's pure preliminary collector first proves the exact
   structural/callback/import shape and caches the exact shared
   `IrCountedStringAppendPlan`. Add a private exact-loop plan resolver/map to
   `planIrOverlay` and `planMultiIrOverlaySource`; it returns that cached object
   only when `loop === chosenLoop`. Keep the existing source-wide boolean only
   for current single-source controls. Never probe or admit another loop in the
   source, and require the projected C0 lowering plan to retain the same syntax-
   plan object.

   Run this through the ordinary multi-source planning boundary, then resolve
   the full C1 selection/ABI/site/currentness contract. If full resolution
   fails, discard the provisional proof-enabled plan reference and let late
   `compileMultiIrOverlaySource` replan with proof disabled; the near miss must
   not reach a late counted-string overlay. `planIrOverlay` may perform its
   ordinary baseline type registrations, so zero-side-effect assertions begin
   at route support/allocation and compare the failed preflight with a normal
   proof-disabled planning control. Only a fully certified exact candidate with
   the explicit string-route switch off retains the proof-enabled no-route
   state, making the ordinary late overlay deterministically yield
   `legacyBodyEmitted: true` and `irBodyEmitted: true`. Builder-off is the exact
   proof-disabled direct control.

2. **Reject overlaps before allocation.** The current
   `EarlyMultiPreparedScalarLeafState.route` and entry-source route map are
   structurally singular, so this checkpoint deliberately admits at most one
   successful early route for the one entry source. It does not widen that API
   into a multi-route container. Maintain persistent frozen claimed
   source/terminal/target snapshots. Start empty; after each successful earlier
   scalar route, derive a new snapshot without mutating the old one. Extend the
   array planner's existing resolve-then-prepare call to accept that snapshot
   and reject an overlapping private candidate after resolution but before its
   first allocation/preparation; no resolver export is required. Derive the
   next snapshot, resolve the string candidate against it before string support
   allocation, then derive the snapshot supplied to generic function-value/
   Fibonacci planning. Bench-loop participates in the same exclusivity proof
   where its source graph overlaps. Thread that input through
   `planEarlyMultiPreparedFunctionValueRoutes` in
   `multi-prepared-fibonacci-pair.ts`; it likewise checks its private resolved
   candidate before its first mutation. Candidate resolution order is scalar,
   array, string, then generic function-value/Fibonacci. A conflict discovered only while
   inserting the final route map is too late because both planners may already
   have allocated support. Once an earlier route succeeds, every later family
   must see its exclusion and decline before mutation. Positive controls prove
   scalar, array, string, and generic/Fibonacci routes independently retain
   their existing behavior in otherwise disjoint fixtures; they do not claim
   simultaneous composition within one entry source. A one-fact overlap leaves
   state byte/cardinality-equal to the earlier-route-only control, not
   necessarily to the empty pre-orchestration module.

3. **Exact early route and captured projection.** Define a frozen
   `MultiPreparedStringLeafRoute extends MultiPreparedLeafRouteBase` with
   `routeKind: "string"`, the full C1 candidate, the exact
   `MultiPreparedFunctionValueSupportReceipt`, the exact
   `PreparedCountedStringAppendReceipt`, the allocated target function, the
   exact live body-array reference, and a frozen shallow snapshot of the
   prepared instruction object identities.
   `projectIrIntegrationLoweringPlans` creates a new frozen lowering-plan
   object on every projection, so project once for the
   explicit target-only early prepared selection, resolve C1 against that
   captured object, and
   pass the same projection to `prepareIrBodies`. The preparation callback
   first asserts the selection is target-only. Its report must contain exactly
   one valid receipt whose plan object, site, source, owner, component,
   artifact, provider, and signature match the captured C0 evidence. Store that
   receipt; a structurally equal late reprojection may prove currentness but may
   not replace it.

4. **Reuse shared callback support and ordinary preparation.** Call the
   existing private `prepareTopLevelFunctionValueTargetSupport` for the exact
   `[] -> f64` target/trampoline/cache graph. That call is C2's first mutation.
   Once it begins, a missing/invalid support receipt, failed C1
   `before-prepare` check, preparation withdrawal/throw, malformed preparation
   report/receipt, skip-set mismatch, or artifact/component mismatch is an
   `IrInvariantError` with no direct retry. Call ordinary `prepareIrBodies`
   only for the target, then
   retain the exact live body-array reference plus frozen `[...body]` snapshot.
   Do not freeze the allocator-owned `WasmFunction`, its live body array, or
   instruction objects; later compilation stages legitimately mutate them.
   Never prepare or duplicate direct `main` or imported `addBenchCard`; direct `main` must call
   through the same trampoline/cache receipt. Never synthesize a provider or
   install an equivalent Wasm body by hand.

5. **Use the generic direct-body skip boundary exactly.** The existing
   `compileMultiPreparedScalarLeafDeclarations` path may consume the added
   route arm without a string-specific compiler. Require free-functions
   `requestedSkipProjection`, `skipBodies`, `preserveBodies`, and
   `completedBodies` to be exact singleton sets for the target; require
   `skippedFunctionUnitIds` to be exactly `{route.unitId}`. No class member,
   module init, implicit constructor, caller, import, or support function may
   enter the skip. The default route removes only the target's physical
   `compileFunctionBody` and `compileStatement` rows; the other 14 raw audit
   rows stay exact.

6. **Revalidate after every direct owner.** After direct body compilation and
   `finalizeMethodTrampolines`, recompute the final safe selection and require
   the C1 candidate, callback/import edge, source/UnitId, C0 site and plan
   currentness, support receipt in `after-direct`, the same live target
   body-array reference, the expected final length and per-index instruction
   object identities from the shallow snapshot, and exact skipped UnitId. Then
   call
   `completePreparedIrIntegration` and require the stored counted-string
   receipt to occur exactly once in the merged report before
   `consumeIrOverlayReport` performs the terminal audit. After support
   allocation starts, any missing, duplicate, foreign, or drifted fact is
   `IrInvariantError` with no direct retry and no target legacy rows. Ordinary
   mismatches may decline to direct only before that first mutation.

7. **One rollback switch with two distinct controls.** Add internal
   `JS2WASM_MULTI_PREPARED_STRING_CUTOVER`, default on only for
   experimental-IR, non-disabled, standalone WasmGC, non-fast, non-WASI,
   multi-source graphs. `=0` restores the two target direct rows and must retain
   the exact proof-enabled plan so the late overlay produces
   `legacyBodyEmitted: true` and `irBodyEmitted: true`.
   `JS2WASM_IR_STRING_BUILDER=0` is the true direct artifact with those two rows
   and `irBodyEmitted: false`. Add the new switch atomically to #4522's
   `retire-at-R9` table, update the live `JS2WASM_MULTI_*` count from four to
   five, and leave the separate original four `JS2WASM_IR_*` count unchanged.

8. **Focused orchestration and anti-widening tests.** Use
   `website/playground/examples/benchmarks/string.ts` and require result 5000
   with a renamed-function positive sibling. Keep
   `tests/issue-3518-counted-string-cutover.test.ts` as an anti-widening
   control: its multi-source fixture lacks the exact `addBenchCard` callback
   edge and stays direct. C2 owns mutations for selection/source/UnitId/site/
   receipt/artifact/component/body/instruction/support drift; exact skip/
   preserve/completed mismatch; callback/direct-caller/ABI drift; second
   candidate; overlap with scalar/array/bench-loop/generic-function/Fibonacci;
   and missing/duplicate/foreign post-merge receipts. Host-GC, fast, WASI,
   IR-first-off, IR-off, unsupported backends, and pre-certification shape
   mutations remain direct with zero route allocation/preparation side effects;
   ordinary proof-disabled planning registrations are the control baseline. Add
   `JS2WASM_TEST_REQUIRE_MULTI_PREPARED_STRING_LEAF=1` so every positive route
   test fails if detection is empty. Add a parsed, test-only
   `JS2WASM_TEST_TAMPER_MULTI_PREPARED_STRING_LEAF` selector over the exact
   UnitId and explicit post-certification phases (support, preparation receipt,
   skip report, post-direct currentness, and post-merge receipt). Each selector
   must match exactly once after the first mutation and prove the invariant/no-
   fallback boundary; an unmatched or multiply matched selector is itself an
   invariant.

9. **Artifact and ownership audit.** Prepared raw audit has 14 rows versus the
   direct control's 16; only target `compileFunctionBody` and
   `compileStatement` disappear. Raw and optimized output preserve exports,
   imports, DTS/import helper, string pool, callback behavior, and Program-ABI
   source/target/trampoline/cache joins without pinning numeric slots. Resolve
   call targets structurally. The target WAT contains one aggregate repeat and
   one concat, no counted loop, dynamic carrier, externref round trip, boxing,
   per-iteration call/allocation, AST dispatcher, or duplicate repeat/concat.
   Host-string WasmGC, native-string WasmGC, and linear must continue lowering
   the same in-memory v5.3 instruction through their authenticated providers;
   C2 makes no linear serialization/cutover claim. Compare the optimized
   Prepared artifact to the contemporaneous builder-off direct artifact:
   Prepared optimized bytes, resolved helper/provider call census, and
   allocation census must each be no greater than direct. Use no unrelated
   #4035 size ceiling or historical binary baseline. Raw binary difference is
   observational only; resolved structural call/allocation targets are the
   acceptance authority.

10. **Runtime and retirement evidence are a later signed checkpoint.** Existing
    runtime scripts do not satisfy this issue's protocol. Add a durable driver,
    preferably `scripts/measure/bench-string-ir-runtime.mts`, that launches
    fresh identical memory-capped processes in interleaved ABBA order, retains
    every sample, collects at least 30 valid samples per arm, brackets with a
    contemporaneous direct/direct control, and publishes the paired median plus
    a 95% bootstrap interval. Every child launch enforces a finite nonnegative
    one-minute load strictly below `logical cores - 2`. Direct/direct deviation
    above 5%, Prepared/direct median above 1.05, or interval upper bound above
    1.10 fails closed.

    Do not mark `IR-OPT-COUNTED-LITERAL-STRING-APPEND` retirement-ready in the
    compile-once PR. Only after complete semantic, output, and runtime evidence
    may its owner move from `containsCountedLiteralStringAppend` to the actual
    executable lowerer (expected `from-ast.ts::lowerPreparedCountedStringAppend`)
    in `plan/log/ir-optimization-retirement-ledger.md` and set
    lowering/complete/retirement-ready. At that point, and only then, update
    `tests/issue-3792-ir-optimization-retirement-gate.test.ts` to the measured
    totals of 50 rows, 37 complete, and 4 ready. Neither evidence file belongs
    to the compile-once C2 commit.

11. **C2 landing discipline.** Run the new route/anti-widening suites, the
    unchanged prior scalar/array/bench-loop/Fibonacci controls, TypeScript 7 and
    5, Prettier, dead-export, IR layering/dialect/fallback, oracle/coercion/
    optimization, LOC, and function-growth ratchets. Before every heavy command
    and commit/push boundary, require a fresh finite nonnegative one-minute load
    strictly below `logical cores - 2`. Run `pnpm run check:loc-budget` again
    immediately before the normally signed C2 commit. Run all normal precommit
    and prepush hooks without `--no-verify` or a skip environment. Push only the
    combined C1+C2 branch after its independent read-only review, then open a
    ready PR and shepherd it through the merge queue.

#### Acceptance and non-vacuous controls

Add `tests/issue-3518-bench-string-prepared-cutover.test.ts` and extend
`tests/issue-1004.test.ts`. At minimum the focused evidence must prove:

- default-on direct-body poison succeeds with zero target legacy rows, one
  self-owned `terminal-ir` disposition, `legacyBodyEmitted: false`,
  `irBodyEmitted: true`, a nonempty prepared component, and one authenticated
  repeat provider;
- the rollback matrix is exact and non-conflated: string-route-off with the
  builder enabled restores the two physical direct rows but still permits the
  late IR overlay (`legacyBodyEmitted: true`, `irBodyEmitted: true`), while
  `JS2WASM_IR_STRING_BUILDER=0` is the true direct artifact with those rows and
  `irBodyEmitted: false`. Both execute the direct body and therefore make the
  same direct-body poison fail. Use builder-off, not route-off, for the
  direct/Prepared artifact and runtime A/B;
- raw and optimized direct/Prepared artifacts instantiate and return **5000**,
  preserve callback invocation and all public/import/DTS/string-pool surfaces,
  and retain exactly one aggregate repeat plus one concat with no counted loop;
- the Prepared target uses no dynamic carrier, externref round trip, boxing,
  per-iteration allocation/call, AST method dispatcher, or second repeat/concat;
- host-string WasmGC, native-string WasmGC, and linear each lower the same
  in-memory v5.3 `string.repeat` instruction through their authenticated
  provider; clone/digest/provider/signature tamper fails before artifact side
  effects, and no executable serialization claim is made unless that separate
  substrate lands;
- cross-backend intrinsic tests exercise negative fractions, negative
  integers, `+Infinity`, `NaN`, `-0`, zero, one, and a positive fraction, plus
  the required `"".repeat(-1)` ordering where validation happens before the
  empty-receiver fast path. Unused throwing results must survive DCE, and an
  observable effect before/after repeat must retain order across optimization;
- zero/one/inclusive/nonzero-start, `+=`, braced body, immutable identifier,
  and nonempty seed cases retain exact semantics and expected aggregate
  shapes. Non-ASCII fragments must pass WasmGC semantic/output-shape coverage;
  linear currently accepts only authenticated ASCII string-runtime evidence,
  so non-ASCII must produce a typed linear incapability unless an explicit
  encoding-widening transaction lands; and
- counter-dependent/prepend/self-fragment, multi-statement, dynamic or unsafe
  bound, non-unit/decreasing update, alias/reassignment/capture/getter/call,
  extra candidate/caller, callback source/ABI drift, provider/allocator/plan
  tamper, class/module-init, an unexpected candidate-owned cross-file call
  component, fast, WASI, IR-disabled, and unsupported backend mutations decline
  before skip or fail with typed pre-emission evidence.

The optimization ledger row `IR-OPT-COUNTED-LITERAL-STRING-APPEND` becomes
retirement-ready only after semantic, output-shape, and paired runtime evidence
are recorded. Output evidence must compare structural helper/provider calls,
not unstable numeric function indices. Runtime evidence uses fresh, identical
memory-capped processes in an interleaved **ABBA** schedule with at least 30
valid samples per arm and a contemporaneous direct/direct bracket. Publish all
samples, the paired median Prepared/direct ratio, and a 95% bootstrap interval.
Fail closed if the direct/direct median drifts beyond 5%, if the Prepared/direct
median exceeds 1.05, or if its interval's upper bound exceeds 1.10; no speedup
claim follows from merely clearing those regression limits. Every launch uses
the strict finite, nonnegative one-minute load gate
`load < logicalCores - 2`; on an eight-logical-core host the limit is `< 6`.
An environmental gate abort is diagnostic evidence, never a retryable PASS.

Run the focused #1004 and #3518 suites, prior string-builder/owned-append/
concat-batching suites, array/Fibonacci/bench-loop route suites, standalone
floor, IR layering/oracle/optimization ratchets, typecheck/lint/format, and the
WasmGC/linear cross-backend matrix. Full merge-group Test262 must be
net-non-negative in JS-host and standalone with complete outcome/fatal-error
accounting. The implementation checkpoint must publish exact test counts,
route/audit denominators, artifact hashes and shapes, runtime samples, provider
receipts, and signed issue/evidence locks before this section may claim
`bench_string` compile-once. The direct #1004 handler remains the required
`JS2WASM_IR_STRING_BUILDER=0` control throughout hybrid operation. It can be
deleted only after R9 removes that switch and #3792 plus the refreshed #3090
R10 audit prove the handler unreachable across the full supported denominator.

#### C2a implementation checkpoint: exact `bench_string` compile-once route (2026-08-27)

The first executable C2 checkpoint now consumes the merged C1 proof for the
exact two-source `string.ts` / `helpers.ts` graph. It injects only C1's
identity-bearing counted-loop plan into multi-source overlay planning, prepares
`bench_string` through `prepareIrBodies`, authenticates its callback support and
counted-string receipt, and routes its exact singleton body skip through
`MultiPreparedProgramOwner`. The owner now carries a frozen cross-family claim
ledger in scalar → array → string → function-value/Fibonacci order, so an
overlap declines before the later family's first allocation.

The route is default-on behind
`JS2WASM_MULTI_PREPARED_STRING_CUTOVER`; `=0` restores exactly the target's
`compileFunctionBody` and `compileStatement` rows while retaining the late IR
overlay. The stored counted-string receipt must occur exactly once in the
merged report before terminal consumption. Target body identity is sealed at
the preparation, post-direct, post-overlay-consumption, post-trampoline, and
pre-publication boundaries so legitimate whole-module rewrites are captured
only at their named boundary and any subsequent drift fails closed.

Focused evidence in
`tests/issue-3518-bench-string-prepared-cutover.test.ts` proves the default-on
route survives a direct-body poison with zero target legacy rows, proves the
rollback lane restores both physical rows with
`legacyBodyEmitted: true` / `irBodyEmitted: true`, and separately proves the
poison still fires on that direct lane. The unchanged whole-program owner
census passes alongside it. Prepared and route-off artifacts retain the same
Wasm import/export surface, DTS, compiler import manifest, and string-pool
membership, instantiate through the shared runtime harness, and both return
`5000` from `bench_string`. C1 remains a separately merged 71-test proof
checkpoint; this change does not duplicate its planner predicates.

This checkpoint does not claim the later runtime/optimization-retirement
transaction. The expanded mutation matrix, builder-off artifact comparison,
durable 30-sample ABBA runtime driver, optimization-ledger promotion, and final
R9 switch deletion remain follow-up evidence and must not be inferred from the
compile-once route landing.

#### C2b checkpoint: true-direct control and phase-addressed fail-closed evidence (2026-08-27)

The first follow-up closes a control-path defect exposed by the C2a landing.
`JS2WASM_IR_STRING_BUILDER=0` correctly rejected the counted builder in the
structural selector, but early multi-source orchestration still injected C1's
counted-string proof into the legacy-name projection. The late overlay then saw
`bench_string` in the compatibility selection without a matching structural
owner and failed `selection-preparation-mismatch` instead of producing the
required direct artifact. Early orchestration now withholds every string shape
and proof when the builder switch is disabled. The resulting artifact has the
two physical target legacy rows, a typed `string-builder-candidate` outcome,
`legacyBodyEmitted: true`, `irBodyEmitted: false`, and returns `5000`.

The string route also gains the parsed test-only
`JS2WASM_TEST_TAMPER_MULTI_PREPARED_STRING_LEAF` selector. Its JSON object must
contain only the exact target `unitId` and one explicit phase: `support`,
`preparation-receipt`, `skip-report`, `post-direct-currentness`, or
`post-merge-receipt`. Each phase corrupts a distinct authenticated record after
the route's first mutation. Every corruption fails invariantly with zero target
legacy rows; malformed or foreign selectors are themselves invariants, and the
route requires an armed selector to match exactly once. This turns the C2a
currentness checks into executable no-fallback evidence rather than relying on
their success path alone.

Focused raw and optimized A/B coverage now uses builder-off—not route-off—as
the direct control. Both artifacts preserve the target UnitId, all non-target
legacy audit rows, imports/exports, DTS, and string-pool membership, and both
instantiate and return `5000`. The route-off lane remains separately covered as
the rollback control with `legacyBodyEmitted: true` and `irBodyEmitted: true`.

This checkpoint deliberately does **not** promote
`IR-OPT-COUNTED-LITERAL-STRING-APPEND`. The first corrected optimized A/B on the
current arm64 host measured 130,595 bytes Prepared versus 130,308 bytes direct:
Prepared is 287 bytes larger, so the no-growth output gate is not yet met. The
next implementation transaction must:

1. attribute and remove that target/provider overhead while preserving the
   generic `string.repeat` validation matrix and the counted-plan receipt;
2. lock structural target helper/provider calls and allocations at direct or
   better, without numeric function-index assertions;
3. add and run the durable 30-valid-sample ABBA driver with the 5% direct/direct,
   1.05 median, and 1.10 bootstrap-upper-bound gates; and
4. only after all three evidence classes pass, promote the optimization ledger
   row and synchronize the measured #3792 totals.

The broader syntax/provider mutation matrix and final R9 switch deletion remain
separate follow-ups. No performance, retirement-ready, linear cutover, or
repository-wide IR-only claim follows from this checkpoint.

#### C2c checkpoint: authenticated counted-native repeat provider (2026-08-27)

The accepted-output regression is removed without weakening generic
`String.prototype.repeat`. IR format v5.4 adds the optional
`countedStringAppendTripCount` proof to `string.repeat`. Production from-AST
lowering emits it only for the exact checker-retained counted-loop trip count in
the signed-i32 range. The verifier requires a matching source-qualified
`countedStringAppendSite`, an integer in `[2, 2147483647]`, and an exact f64
constant definition for the instruction's `count` SSA value. The fragment is
canonicalized from the checker-proven literal/const-alias chain to an exact
`string.const`; its UTF-16 length times the trip count must stay at or below the
native kernel's `0x40000000` result bound. Final provenance association joins
the same trip count and fragment back to the retained syntax plan. Missing,
borrowed, out-of-range, non-constant, non-literal, oversized-result, and
provider-without-proof variants fail closed.

Native WasmGC preparation maps only that authenticated form to
`__ir_string_repeat_counted_native`, whose physical provider is the existing
`__str_repeat (string, i32) -> string` kernel. Lowering performs the proven-safe
`i32.trunc_f64_s` conversion at the call site. It does not materialize the
generic `__ir_string_repeat_native (string, f64) -> string` validation adapter.
Site-less repeats, out-of-i32-range counted repeats, host strings, and the linear
backend retain the generic f64 provider and its complete ToIntegerOrInfinity /
RangeError behavior. Adapter-manifest string-pool metadata remains byte-for-byte
compatible with direct output even though the counted artifact has no dead
RangeError path.

On the current arm64 host, the accepted raw and requested-`optimize: 4`
artifacts both measure **130,062 bytes Prepared versus 130,308 bytes direct**:
Prepared is now **246 bytes smaller** and 533 bytes smaller than C2b's 130,595
byte artifact. Both accepted binaries pass `WebAssembly.validate`, preserve DTS,
imports/exports, string-pool membership, target UnitId, non-target route rows,
and return `5000`. Named WAT evidence contains `__str_repeat`, contains no
`__ir_string_repeat_native`, uses non-saturating `i32.trunc_f64_s`, and reduces
the target's static call count from four to two with no increase in target
`array.new` or `struct.new` operations. The focused verifier/provider/contract,
cutover, and phase-tamper suites pass 36/36, and the TypeScript 7 typecheck
passes.

The no-growth and structural output gates are therefore met. Promotion of
`IR-OPT-COUNTED-LITERAL-STRING-APPEND` remains withheld until the durable
30-valid-sample ABBA runtime driver satisfies the existing 5% direct/direct,
1.05 median, and 1.10 bootstrap-upper-bound gates. The broader syntax/provider
mutation matrix and final R9 switch deletion remain later transactions.

#### C2d checkpoint: durable counted-append runtime gate (2026-08-27)

This checkpoint began only after C2c was live on `main`. Add the discoverable
`benchmark:bench-string-ir-runtime` command around
`scripts/measure/bench-string-ir-runtime.mts` and lock its pure protocol helpers
in `tests/issue-3518-bench-string-runtime-driver.test.ts`. Compile the C2c
builder-off direct and Prepared artifacts once, authenticate their exact route
ownership and matching Wasm surface, then execute every timed launch in a fresh
Node process with a 512 MiB old-space cap, explicit GC, warmup, artifact digest
verification, and the exact `bench_string() === 5000` oracle.

Each of 30 rounds brackets one adjacent direct/Prepared candidate pair with
fresh direct controls. Candidate order alternates AB then BA, producing exact
D/P/P/D blocks across each two-round pair. A fresh finite, nonnegative
one-minute load observation must be strictly below `logicalCores - 2` inside
every child before setup. The first load or worker failure aborts without retry
and retains all completed launches as diagnostic evidence. The completed run
must publish all 120 launch records, 30 paired Prepared/direct ratios, 30
direct/direct bracket ratios, artifact hashes and sizes, process memory, the
paired medians, and the deterministic 10,000-resample 95% bootstrap interval in
`benchmarks/results/ir/3518-bench-string-runtime.json`.

The first v1 execution is retained separately as
`benchmarks/results/ir/3518-bench-string-runtime-aborted-v1.json`. It completed
14 rounds / 56 launches before the next child observed load 6.325 against the
strict `< 6` threshold and aborted exactly as designed. That run also exposed
a harness defect before any retirement claim: each fresh child re-imported
`tsx`, the compiler, and the full runtime, reporting roughly 376–559 MiB RSS
and driving the host over its own gate. Protocol v2 replaces that setup with
`scripts/measure/bench-string-ir-runtime-worker.mjs`, a plain-Node worker that
loads only the signed Wasm artifact and Node built-ins. It rejects every
non-function import and installs throwing stubs for function imports, so the
timed `bench_string` path cannot silently depend on host setup. The v1 abort is
diagnostic evidence and is not retried or reclassified; v2 is a materially new
protocol whose complete run must still satisfy every unchanged gate above.

Only a report whose direct/direct median deviation is at most 5%, whose
Prepared/direct median is at most 1.05, and whose bootstrap upper bound is at
most 1.10 may promote `IR-OPT-COUNTED-LITERAL-STRING-APPEND`. On that same
signed checkpoint, move its owner to
`src/ir/from-ast.ts::lowerPreparedCountedStringAppend`, mark lowering/complete
and all three evidence classes verified, set `retirementReady: true`, and
synchronize the live #3792 totals to 50 rows, 37 complete, and 4 ready. Clearing
the bounds proves runtime parity/no regression, not a speedup. It does not
delete the direct handler, retire the builder switch, close #3518, or make a
repository-wide IR-only claim; those remain gated by R9 and the refreshed R10
reachability audit.

Protocol v2 completed all 30 rounds / 120 launches against merged revision
`8c0033daa50f8d08a49976500e4f62e1440882ce`. Every launch observed load in
`[3.2383, 3.2988]` against the strict `< 6` threshold, returned the exact
5,000,000 accumulated checksum, and reported RSS in `[58,556,416, 59,031,552]`
bytes. The direct artifact is 130,308 bytes with SHA-256
`3cbc410df50905b51a6a269fb152a037fea767e6ce06a41e07e047720e4f60aa`;
Prepared is 130,062 bytes with SHA-256
`dd45e84b55933ffa5587d27e1640a2d389db03c48b65b648977f2bfaa5fde3a5`.

The direct/direct median is 1.002100 (0.210% deviation). The paired
Prepared/direct median is 0.986557 and its deterministic 10,000-resample 95%
bootstrap interval is `[0.971562, 0.988501]`. All three fail-closed limits pass,
so the ledger row now names the executable lowerer, marks semantic/output/
performance evidence verified, and becomes the fourth retirement-ready row.
This is parity/no-regression evidence only. The direct handler and builder
switch remain live controls until R9 and the refreshed R10 reachability audit.
The driver/ledger suites pass 22/22, both TypeScript 7 and TypeScript 5 pass,
and repository lint and formatting checks are green.

#### C2e checkpoint: contract the temporary C1 dead-export baseline (2026-08-27)

PR #4982 merged the dormant C1 planner together with 29 entries in
`scripts/dead-export-baseline.json`, despite this plan's explicit requirement
that C1 remain unpublished until a real production consumer made the complete
planner graph reachable. The subsequent C2a–C2d checkpoints now provide that
consumer through `multi-prepared-callable-orchestration.ts` and
`multi-prepared-program.ts`; retaining the exemptions would hide genuine
retirement progress and weaken the #3090 denominator.

On live `main` `db872cf39ffcda8775fa11b0385c896337ab611e`,
`pnpm run check:dead-exports` reports exactly **29 baseline entries gone**, all
from `src/codegen/multi-prepared-string-leaf.ts`, with 23 unrelated known rows
remaining and zero new rows. Remove those exact 29 string-leaf entries now.
This cleanup changes no source, test, route, artifact, optimization evidence,
or runtime behavior; it merely makes the baseline match the production
reachability already proved by C2.

Acceptance is a clean dead-export check with 23 known entries, zero new rows,
and no stale-baseline progress notice, plus formatting, issue integrity, LOC
and function ratchets, and the normal unskipped precommit and prepush hooks.
Do not remove or reclassify any of the remaining 23 rows in this checkpoint.

## 2026-09-02 — R9 coverage-closure gap, measured

The ladder gap noted above ("R9 needs an explicit coverage-closure dependency")
now has a number attached. It was measured, not inherited from an artifact.

`pnpm run check:ir-only` reports **READY** on `main`. That verdict is real but
it is scoped to five entry files hardcoded at `scripts/check-ir-only.ts:14-20`,
and the script's own comment already says so: *"Wider compiler reachability
remains a separate R9/R10 requirement."* The playground directory it draws from
holds **thirteen** `.ts` entries. The other eight have never been in the gate.

Running the gate's own lane observers over those eight (they accept an entries
override, so no compiler change was needed):

| | gate corpus (5 files) | uncovered (8 files) |
| --- | --- | --- |
| terminal units, single-host | 41 | 32 |
| `emitted` | 38 | 16 |
| `unsupported` | **0** | **8** (7 `@select`, 1 `@build`) |
| legacy body emitted | **0** | **10** |
| terminal units, standalone | 41 | 32 |
| `emitted` | 38 | 10 |
| `unsupported` | **0** | **14** (all `@select`) |
| legacy body emitted | **0** | **14** |

Every one of the eight files has at least one unsupported unit on both lanes;
`benchmarks.ts` and `benchmarks/helpers.ts` have three each on standalone. So
this is not one exotic file dragging a corner — the rejection is spread across
the whole uncovered population.

Three things follow that change what R9 has to do:

1. **The denominator is not 5, and widening it flips the verdict.** Adding the
   eight to the gate takes it from READY to NOT READY with 10 (single-host) /
   14 (standalone) direct-body emissions to retire first. R9's fail-closed flip
   cannot be scheduled off the current READY.
2. **Standalone is the harder lane by a factor, and the gap is growing in the
   direction R10 cares about.** 14 unsupported vs 8, and 10 emitted vs 16. The
   DOM-touching entries (`dom.ts`, `style.ts`, `helpers.ts`) reject wholesale on
   standalone while emitting on single-host.
3. **Two single-host units emit BOTH a direct body and an IR body** — the
   literal compile-once violation, distinct from a clean rejection. They are the
   only units in the population carrying an `r2Withdrawal` record, and it reads
   `stage: "not-attempted", reason: "late-feature-preparation"`. Every other
   legacy-emitting unit has **no withdrawal record at all**, because it never
   reached R2 admission — it was rejected at `select`. R2 withdrawal telemetry
   (#3521, landed in #5486) therefore does not explain this population, and a
   census that reads only withdrawal reasons will report an empty histogram and
   look clean. That is a trap worth naming for whoever runs the full census.

### Reproducing

The gate exports `observeSingleHostLane(entries?)` / `observeStandaloneLane(entries?)`,
both of which take an entry-list override. A scratch script that calls them with
the eight uncovered paths and histograms `kind`, `kind@stage`, `legacyBodyEmitted`
and `irBodyEmitted` reproduces the table above. Put it in `.tmp/`.

**One correction worth carrying, because it cost a wrong reading here:** the
outcome field is `kind`, not `status`. A probe that filters on
`o.status === "unsupported"` returns **zero** for every lane and every file,
which reads as "nothing is rejected, everything silently falls back" — the
opposite of the truth. And `legacyBodyEmitted` / `irBodyEmitted` are **not
mutually exclusive**: a unit can carry both, which is precisely the compile-once
violation in item 3. Tallying them as if they partitioned the units
double-counts and hides that case.

### What this does not settle

The playground is still not the whole compiler. Thirteen entry files is the
bounded population this gate was built around; the true R9 denominator is the
standalone corpus plus whatever #4522's `retire-at-R9` table enumerates. This
measurement closes the gap between "5 files" and "the playground", which is the
first step, not the last. The remaining question for the full census is what the
denominator is beyond `website/playground/examples/`.

### The denominator beyond the playground — dogfood corpus, measured

The section above closed "five files → the playground" and left open what the
denominator is beyond `website/playground/examples/`. Measuring the next
corpus out — `tests/dogfood/corpus`, 20 real JS programs, directly R10-relevant
because dogfooding is what "the compiler compiles itself" means:

| | playground gate (5 `.ts`) | dogfood (20 `.js`) single-host | dogfood standalone |
| --- | --- | --- | --- |
| terminal units | 41 | 35 | 35 |
| IR bodies emitted | **38** | **1** | **0** |
| unsupported | 0 | 33 (`@select`) | 31 (30 `@select`, 1 `@build`) |
| legacy bodies | 0 | 33 | 31 |
| entries compiling clean | 5/5 | 18/20 | 18/20 |

The IR path covers ~100% of the gate's corpus and **1 of 35 units** on the
dogfood corpus (0 on standalone). The two entries that fail outright
(`destructuring.js`, `objects.js`) do so with a fatal diagnostic on both lanes.

**A hypothesis worth stating because it was tested and refuted.** The obvious
explanation is that the dogfood files are untyped `.js` while the gate corpus is
annotated `.ts`, and the known IR fallback vocabulary has three type-resolution
buckets. If that were the cause, type reasons would dominate. They do not —
exactly **one** of 33 rejections is `return-type-not-resolvable`. The histogram:

| reason | single-host | standalone |
| --- | --- | --- |
| `body-shape-rejected` | 19 | 16 |
| `class-member-unsupported` | 4 | 4 |
| `class-projection-unsupported` | 2 | 2 |
| `class-method` | 1 | 1 |
| `static-class-initialization` | 1 | 1 |
| `destructuring-param-complex` | 1 | 1 |
| `async-function` | 1 | 1 |
| `async-generator` | 1 | 1 |
| `operand-coercion-unsupported` | 1 | 1 |
| `param-shape-rejected` | 1 | 1 |
| `return-type-not-resolvable` | 1 | 1 |
| `imported-call-planning-unsupported` | — | 1 |

So the wider denominator is gated on **body shape (≈58%) and class coverage
(8 units across four class reasons)** — that is R3 (#3522) territory plus the
`body-shape-rejected` bucket the IR fallback budget already flags as
*unintended* — and **not** on type propagation. A plan that widens the corpus by
improving TypeMap propagation first would be optimising the 1, not the 19.

**Consequence for the ladder.** R9's fail-closed flip is not a small step past
the current READY. On the corpus that matters most for R10, IR adoption is
effectively at zero, and the blocking reasons are the same unintended buckets
#2855 is already ratcheting. R9 should take an explicit dependency on
`body-shape-rejected` and the class family reaching zero on a corpus wider than
the playground, not merely on the current gate staying green.

**Still not settled:** dogfood is 20 files. Neither it nor the playground is the
full standalone denominator, and #4522's `retire-at-R9` table has not been
cross-checked against either. Both numbers above are floors on the work, not the
total.

#### Correction to the section above: the blocker is module-init (R4), not class coverage (R3)

The table above attributed the wider-corpus gap to "body shape (~58%) and class
coverage — R3 (#3522)". **The class half of that is wrong, and the body-shape
half was true but uninformative.** Splitting `body-shape-rejected` by unit kind:

| | count |
| --- | --- |
| `body-shape-rejected` on `<module-init>` | **17** |
| `body-shape-rejected` on ordinary functions | 2 (`exportedFn`, `Ctor`) |

So the largest bucket is not scattered function-body shapes at all. It is one
unit kind, once per file. Grouping every dogfood rejection by unit kind makes
the split plain:

| lane | module-init units | of those, unsupported | non-module-init unsupported |
| --- | --- | --- | --- |
| single-host | 20 | **19** (17 body-shape, 1 static-class-init, 1 operand-coercion) | 14 |
| standalone | 20 | **16** (14 body-shape, 1 static-class-init, 1 operand-coercion) | 14 |

**Module-init adoption on this corpus is zero of twenty executable units, on
both lanes.** That is R4 (#3523, module-init compile-once), not R3. The class
family accounts for 7 of 33 single-host rejections, real but a third the size.

**And this explains why the gate is green rather than merely narrow.** Its five
entries hold five module-init units: 2 emitted, **3 non-executable**, 0
unsupported. A non-executable module-init has no body by construction, so the
gate exercises module-init on exactly two files. The corpus is not just small —
it is unrepresentative in precisely the dimension that dominates everywhere
else.

**Revised consequence for the ladder.** R9's coverage-closure dependency is
first and foremost **R4**. Widening the corpus without module-init compile-once
converts ~58% of the single-host gap and ~45% of the standalone gap into
permanent red. The class family is the second dependency, not the first.

**Method note, since this is the second time in one session the same mistake
shape appeared.** The previous section read a reason histogram and named an
owner from the reason label alone. `body-shape-rejected` is raised from many
sites spanning entirely different constructs, so the label identifies a *demote
path*, not a *feature area*. Grouping by `unitKind` — one extra field already
present in the telemetry — moved the conclusion from the wrong lane to the right
one. Any future census over these outcomes should group by `unitKind` before
assigning an owner.

**Precision correction to the sentence above, added after tracing it.** An
earlier draft pointed at "~20 sites in `src/ir/from-ast.ts`". Those sites are
`demoteToLegacy` calls, and `demoteToLegacy` throws at stage **`build`**
(`src/ir/outcomes.ts:213`). Every module-init rejection measured here is stage
**`select`**, so it comes from `src/ir/select.ts` instead — sending a reader to
`from-ast.ts` for these would cost them the search. The per-arm breakdown is
obtainable with `JS2WASM_IR_SHAPE_DIAG=1` and no source edit (the #2856 Step-1
reject-arm recorder), and is recorded on `#3523`.

### CORRECTION — "R4 first" was generalised from one corpus; it does not hold on the other

The sections above concluded that R9's coverage-closure dependency is R4. That
conclusion was drawn entirely from `tests/dogfood/corpus`. Measuring the
**playground's own uncovered eight** with the same instruments refutes the
generalisation:

| | dogfood (20 `.js`) | playground-uncovered (8 `.ts`) |
| --- | --- | --- |
| module-init units | 20 | 8 |
| module-init **non-executable** | 1 (sh) / 4 (sa) | **8 / 8 — all of them** |
| module-init unsupported | 19 (sh) / 16 (sa) | **0 / 0** |

**On the playground's uncovered files, module-init is not a blocker at all** —
every one of the eight has no executable module-init body. Their blockers are
elsewhere entirely:

| corpus / lane | dominant blocker | count | plausible owner |
| --- | --- | --- | --- |
| dogfood, both lanes | module-init `vardecl-module-storage-unrepresentable` | 11 sh / 9 sa | R4 (#3523) |
| playground-uncovered, single-host | function `expr-ident-not-in-scope` | 7 of 8 | not R4 |
| playground-uncovered, standalone | **`host-surface-unavailable`** | **12 of 14** | R6 (#3526), standalone surface |

So `body-shape-rejected` is not even the leading reason on the playground's
standalone lane — `host-surface-unavailable` is, by 12 to 1.

**What is actually established, stated at the strength the evidence supports:**

- R4 is a real and severe blocker **on module-bearing sources**: zero of twenty
  executable module-init units on dogfood, on both lanes. That stands.
- R4 is **not** established as R9's universal first dependency. The two corpora
  disagree because they differ structurally in exactly the dimension the
  conclusion keyed on: playground examples are browser scripts whose module-init
  is non-executable, dogfood files are modules with real top-level code.
- R9's denominator needs the **union**, so R4 (module-bearing sources) and the
  standalone host surface (R6) are both dependencies. Their relative weight is
  **unknown** until a corpus representative of the real target population is
  defined — which is the open question the census was for, and it is still open.

**Method, since this is the failure I named two sections earlier and then
committed myself.** That note said a reason label identifies a demote path, not
a feature area, and to group by `unitKind` before assigning an owner. I did
group by `unitKind` — and then generalised from a single corpus without checking
the second, which was one probe away and already on the list of things I had
flagged as unchecked. Grouping correctly does not rescue a sample of one. The
standing instruction should be: **name the corpus in the claim, and do not
promote a per-corpus finding to a ladder dependency until a second corpus
agrees.**

### The standalone half is a target/corpus mismatch, not compiler work — third correction

The correction above concluded that R4 and "the standalone host surface (R6)"
**both** gate R9, on the strength of `host-surface-unavailable` being 12 of the
playground-uncovered standalone lane's 14 rejections. Measuring what those 12
actually name weakens the second half considerably.

All 12 are **DOM**, and `document` is the *only* host global named anywhere in
those eight files — 18 occurrences, and zero `window`, `navigator`, `fetch`,
`localStorage` or `console`. Concretely they are `document.body`,
`document.createElement`, `.innerHTML`, `.style.cssText` and `.appendChild`.
Even `benchmarks/fib.ts` — an otherwise pure-math file — has its `main`
rejected, because `main` renders its result into the page:

```ts
export function main(): void {
  const host = document.body;          // ← the rejection
  host.innerHTML = "";
  …
}
```

`main` is 7 of the 12; the rest are `bench_dom`, `bench_style` and `el`.

**Why this is not R6 work in the ordinary sense.** These are browser demo
programs whose entire purpose is to render to the page, compiled for the
**standalone** target, which by definition has no JS host and therefore no DOM.
A standalone build of a DOM-rendering demo is close to a contradiction in terms;
`select.ts:203-204` already says this reason is owned by "the target's
capability policy, not by IR shape coverage". The compiler is not failing to
lower something it should lower — the corpus is asking a host-free target for a
host surface. Note the machinery for the tractable part already exists: #4576's
`standaloneDomOperation` certifies `document.body` and a registered
`document.createElement(tag)`; these 12 are the uses outside that certified
slice.

**Consequence, and it is a correction to the section above.** The playground's
uncovered eight are a **poor standalone denominator**, not evidence of an R6
gap of comparable weight to R4. Two things follow for whoever defines the real
R9 denominator:

1. Standalone conformance should be measured on programs that could plausibly
   *be* standalone. Counting DOM demos against the standalone lane inflates the
   apparent gap with work nobody intends to do.
2. R4 therefore looks stronger, not weaker, as the leading dependency — but
   note this is now the **third** framing of that question in one session, and
   the honest summary is that the ordering is only as good as the corpus. The
   dogfood corpus (module-bearing, host-free) is the better standalone
   population of the two measured here, and its blocker is R4.

**What is still unmeasured:** neither corpus was chosen to represent the R9
target population, and #4522's `retire-at-R9` table has still not been
cross-checked against either. Until that is done, every weight in this section
is a floor on one sample, not an apportionment.
