---
id: 3518
title: "IR-only default and direct front-end retirement"
status: in-progress
created: 2026-07-21
updated: 2026-08-11
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
related: [1373b, 2855, 2950, 3090, 3142, 3143, 3341, 3517, 3529, 3520, 3521, 3522, 3523, 3525, 3526, 3527, 3528, 3678, 3681, 4382]
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
| Bounded host terminal readiness                  |  **37/37 IR; 0 legacy bodies** | Every measured playground terminal is prepared and compile-once        | Global runtime/linear/direct paths are unreachable or IR-only is ready       |

R0 is complete. After the #3522 cross-owner/Builtins transactions and the
#3523 Algorithms and Calendar function-plus-module-init transactions, the
bounded single-host playground gate is green at 5/5 entries, 37 terminal
units, 37 emitted IR bodies, 0 typed Unsupported outcomes, 0 Invariants, and 0
legacy bodies. All Algorithms and Calendar terminals now seal in exact
prepared components and compile once through IR. This is a bounded census,
not repository-wide strict IR-only readiness.

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
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R0a — #3529 (done)**       | Restore typed-producer equivalence parity without weakening unknown-throw-to-Invariant classification | #3143; exposed by #3519               | 154 new compile failures return to the committed baseline through preclaim/typed Unsupported or true invariant fixes; no baseline expansion                     |
| **R0b — #3519 (done)**       | Typed `Prepared` / `Unsupported` / `Invariant` outcomes plus an honest `check:ir-only` readiness gate | #3143, #3529; informed by #2855/#3341 | No TypeMap or compile failures are skipped; `result.errors` and every unit outcome are accounted for; hybrid vs IR-only policy is tested                        |
| **R1 — #3520 (in progress)** | Source-qualified `IrUnitId` and a whole-program `ProgramAbiMap`                                       | R0                                    | Same-named units across files/classes cannot collide; signatures, globals, imports, types, exports, and synthetic units are planned once                        |
| **R2 — #3521 (in progress)** | `PreparedIrProgram` and prepare-before-emit compile-once pipeline                                     | #3520                                 | Prepared free functions never call legacy body compilation; the versioned validated program round-trips losslessly; unsupported units are decided before emission |
| **R3 — #3522 (in progress)** | Classes and class members are Prepared/compile-once                                                   | #3521                                 | Constructors, instance/static methods, fields, inheritance, wrappers, and type indices no longer depend on legacy body compilation                              |
| **R4 — #3523 (in progress)** | Module init is Prepared/compile-once                                                                  | #3521, #3522                          | One program-owned module-init unit replaces the compile-first/patch-later `__module_init` overlay, including top-level binding/TDZ/export effects               |
| **R5 — #3525 (blocked)**     | Whole-program single- and multi-source Prepared ownership                                             | #3520–#3523                           | Cross-file calls/imports, fast mode, collisions, module init, and class members use one `PreparedIrProgram`; no per-source overlay loop remains                 |
| **R6 — #3526 (blocked)**     | Typed semantic intrinsic/runtime-feature/host-capability contract                                     | #3521                                 | The ~47K runtime/builtin emission lines are reached from a frozen semantic manifest, never AST dispatch; families land in measured sub-slices                   |
| **R7 — #3527 (blocked)**     | AST-free async suspension plans and canonical Promise ABI                                             | #3522, #3525, #3526                   | Every supported async container uses one verified `IrAsyncPlan` and the existing frame engine; no AST callback/direct async route remains                       |
| **R8 — #3528 (blocked)**     | Linear consumes the shared Prepared program                                                           | #3525–#3527                           | WasmGC and linear receive the exact same program/ABI/runtime/async plans; `src/codegen-linear/` has no source-AST lowering path                                 |
| **R9**                       | Fail-closed IR-only default; remove escape hatches                                                    | R3–R8; #2949, #2952, #1373b, #3583    | Default policy is IR-only; hybrid demotion, `experimentalIR: false`, `JS2WASM_IR_FIRST`, `disableIrFirst`, skip allowlists, and compile-twice switches are gone |
| **R10**                      | Reachability-proven direct-front-end deletion                                                         | R9                                    | Re-run #3090 audit; delete the ~59,676 frontend-only fn-lines and dispatch roots; zero direct AST→Wasm reachability remains                                     |

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
      handling, tests, scripts, and documentation.
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
