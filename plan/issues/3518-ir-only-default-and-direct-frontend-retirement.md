---
id: 3518
title: "IR-only default and direct front-end retirement"
status: in-progress
created: 2026-07-21
updated: 2026-08-20
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
| **R10**                      | Reachability-proven direct-front-end deletion                                                         | R9                                    | Re-run #3090 audit; delete the ~59,676 frontend-only fn-lines and dispatch roots; zero direct AST→Wasm reachability remains                                    |

R0a and R0b completed on 2026-07-21. R1 remains active while R2 production
preparation and the first R3 static-method transaction are now in progress.
The current cutover is deliberately component-local: sealed owners skip direct
body emission, while unsealed owners retain the typed hybrid route. R4 follows
R3 because its ordered plan consumes the class/static-intent census owned by
#3522. #3525, #3527, #3528, and R9 remain integration barriers rather than
parallel deletion opportunities. R9 also requires the explicit dynamic-value,
control-flow, async, adoption-owner, and broader-corpus coverage closure named
above.

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
      is the #4522 inventory's four retire-at-R9 vars (`JS2WASM_IR_FIRST`,
      `JS2WASM_IR_STRING_BUILDER`, `JS2WASM_IR_ASYNC`,
      `JS2WASM_IR_OBJECT_SHAPES`); diagnostics/self-checks classified keep
      there survive — consume that table, do not re-audit at flip time.
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
