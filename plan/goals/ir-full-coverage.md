# Goal: ir-full-coverage

**Every supported source unit is prepared as typed IR before emission. WasmGC
and linear differ only below that IR boundary. Unsupported source fails with a
typed diagnostic, and the direct AST→Wasm front-end is deleted.**

- **Status:** Active — current migration priority (2026-07-21)
- **Track:** Compiler architecture / IR retirement
- **Tracking epic:** [#3518](../issues/3518-ir-only-default-and-direct-frontend-retirement.md)
- **Completed R0:** [#3529](../issues/3529-ir-r0-typed-producer-equivalence-parity.md)
  producer parity and
  [#3519](../issues/3519-ir-only-typed-outcomes-and-honest-gate.md) typed
  truth/gate, completed 2026-07-21
- **Next executable slice:**
  [#3520 / R1](../issues/3520-ir-r1-source-qualified-identity-program-abi.md)
  — ready
- **Allocated ownership spine:** [#3520](../issues/3520-ir-r1-source-qualified-identity-program-abi.md)
  → [#3521](../issues/3521-ir-r2-prepared-program-free-function-compile-once.md)
  → [#3522](../issues/3522-ir-r3-classes-closures-compile-once.md) →
  [#3523](../issues/3523-ir-r4-module-init-compile-once.md) →
  [#3525](../issues/3525-ir-r5-whole-program-multi-source-ownership.md) +
  [#3526](../issues/3526-ir-r6-semantic-runtime-contract.md) →
  [#3527](../issues/3527-ir-r7-ast-free-async-plan.md) →
  [#3528](../issues/3528-ir-r8-shared-linear-prepared-program.md)
- **Target:** `pnpm run check:ir-only` passes across the authoritative corpus
  and both backends; the hybrid/direct path and its escape hatches no longer
  exist; the #3090 reachability audit reports no direct-front-end survivors.
- **Dependencies:** `compiler-architecture`; `backend-agnostic-ir` supplies the
  shared backend seam, while #3518 completes whole-program consumption.

## Why

The backend axis is legitimate: WasmGC and linear use different
representations/lowering. The front-end axis is temporary duplication. Keeping
both typed IR and direct AST→Wasm lowering makes type propagation, binding,
control flow, source semantics, and bug fixes diverge across two or three
implementations.

The desired boundary is:

```text
source → PreparedIrProgram → WasmGC lowering
                           → linear lowering
```

Runtime/builtin behavior may remain shared code below semantic IR intents. No
runtime family may require an AST dispatcher as its entry point.

## Current state (2026-07-21)

The compiler is **default-on hybrid, not IR-only**:

- #2856 reduced the measured playground function `body-shape-rejected` bucket
  to zero, but that is a narrow corpus ratchet, not strictness or reachability.
- The adoption matrix has 18/56 IR-owned rows. Mixed/direct rows remain, and
  an IR-owned node inside one rejected function still uses its legacy handler.
- The latest compile-once ceiling is 441/1,568 functions (28.1%). The remaining
  71.9% needs runtime/object/string/array/method IR, not signature widening.
- Class members and the #3142 module-init unit compile twice. Module claimability
  and successful slot patching do not prove that legacy emission was skipped.
- Multi-source/M0 and linear are incomplete whole-program IR consumers.
- Roughly 59,676 frontend-only fn-lines remain reachable. Roughly 47K
  runtime/builtin entry fn-lines must be rewired behind IR intents, not deleted.
- R0 now provides typed emitted/Unsupported/Invariant outcomes and complete
  gate accounting without substring policy. Full equivalence is 1,608 passing
  / 35 failing against 36 committed known failures: one baseline-known case
  now passes, there are zero new regressions, and the baseline is unchanged.
- The bounded hybrid lane is green at 5/5 entries, 37 terminal units, 31
  emitted IR bodies, 6 Unsupported, 0 Invariants, and 37 legacy bodies. Strict
  IR-only is intentionally red on async (2), call-graph closure (1), body shape
  (1), static class members (2), and the 37 legacy-emitted bodies.

## Delivery strategy

The old bucket-only sequence (#2855) is complete as a measured function-corpus
milestone. The retirement now follows #3518's dependency spine:

1. **R0a / #3529 — done 2026-07-21:** retained strict
   unknown-throw-to-Invariant behavior, preclaimed known capability shapes,
   used narrow typed Unsupported exits for residual evidence, and fixed the 13
   true producer/pass invariants; full equivalence has zero new failures.
2. **R0b / #3519 — done 2026-07-21:** typed
   emitted/Unsupported/Invariant outcomes and
   an honest gate that includes TypeMap failures, thrown compiles,
   `CompileResult.errors`, named corpus denominators, classes, and module init.
   Later retirement slices expand that same schema to inline equivalence and
   the other production lanes before the fail-closed default flip.
3. **R1 / #3520 — ready next:** source-qualified `IrUnitId` and
   `ProgramAbiMap`.
4. **R2 / #3521 — blocked on R1:** a `PreparedIrProgram` built before body
   emission; free functions compile once without an allowlist.
5. **R3 / #3522 then R4 / #3523 — blocked on R2:** classes/closures compile
   once before their ordered static intents feed compile-once module init.
6. **R5 / #3525 — blocked on R1–R4:** multi-source/M0, collisions, imports,
   fast mode, and one program-owned module-init plan.
7. **R6 / #3526 — blocked on R2:** typed intrinsic/runtime-feature/host-
   capability contract, immutable fixed-point manifest, then measured runtime
   families.
8. **R7 / #3527 — blocked on R3/R5/R6:** AST-free suspension/liveness/handler
   plans and one canonical Promise ABI through the existing frame engine.
9. **R8 / #3528 — blocked on R5–R7:** linear consumes the exact same Prepared
   program, ABI, runtime manifest, and async plans.
10. **R9 — policy flip:** fail-closed IR-only becomes the sole production mode;
   remove hybrid demotion and every legacy escape hatch.
11. **R10 — subtraction:** re-run #3090 and delete the proven-unreachable
    direct front-end.

Corpus fallback counts remain useful downward ratchets during this program,
but no zero count advances a later stage without its structural acceptance
evidence.

## Issues

<!-- AUTOGENERATED:GOAL-ISSUES-START -->

| # | Title | Sprint | Status | Priority |
|---|-------|--------|--------|----------|
| **1370** | IR: claim class methods and constructors (largest legacy bypass) | 51 | done | high |
| **1371** | IR: expand external-call whitelist to stop rejecting host imports and Math.* | 51 | done | high |
| **1372** | IR: support destructuring params (removes param-shape-rejected bypass) | 51 | done | high |
| **1373** | IR: claim async functions (async/await through IR path) | 72 | done | medium |
| **1373b** | IR async Phase C: CPS lowering for await + async-return + async-throw | Backlog | in-progress | top |
| **1374** | IR: string for-of and for-in through IR (removes legacy fallback for string iteration) | 51 | done | medium |
| **1375** | IR: full optional-chain support (?. and ?.[]) without resolver fallback | 51 | done | medium |
| **1376** | IR: fallback telemetry gate — CI fails when unintended legacy bypasses exceed threshold | 51 | done | high |
| **1382** | structural: Wasm closures not JS-callable from host imports — bridge gap | 52 | done | high |
| **1392** | IR: null-safe access primitives — ref.is_null IrUnop + value-producing if/else IR node | 51 | done | high |
| **2855** | IR fallback-corpus ratchet: drive unintended function buckets to zero | 73 | done | high |
| **2856** | IR: drive body-shape-rejected fallback bucket to zero (dominant unintended bucket) | 73 | done | high |
| **2857** | IR: claim static methods under `extends` (class-method 6 → 5) | 69 | done | high |
| **2858** | IR: drive call-graph-closure fallback bucket to zero (derivative of body-shape + class-method) | 71 | done | high |
| **2859** | IR: drive param-type-not-resolvable fallback bucket to zero (TypeMap propagation) | 69 | done | high |
| **2949** | IR dynamic value representation: JsTag-carrying `dynamic` kind in IrType (make untyped JS claimable) | current | ready | high |
| **2950** | IR-first default flip (historical milestone; retirement moved to #3518) | 71 | done | high |
| **2951** | IR-first skip set: include generators and class members (retire the two #2138 standing exclusions) | current | ready | medium |
| **2952** | IR multi-exit control flow: labeled break/continue, switch (br_table), do-while, for-in adoption | current | ready | medium |
| **2955** | De-polymorph the IR front-end on string mode: abstract IR string ops resolved at lower time | current | ready | medium |
| **3000** | IR: class-member residual — private fields, accessors, inheritance/super (class-method → 0) | 71 | done | medium |
| **3052** | IR `class.call`: void instance method in statement position | 71 | done | medium |
| **3065** | IR: claim non-terminating `if (cond) <stmt>;` guard at non-void body position (select↔builder parity, follow-on #1979) | 71 | done | medium |
| **3090** | Retire direct front-end after IR-only reachability gates close (~59,676 fn-lines) | Backlog | blocked | high |
| **3113** | Fix IR->codegen reverse layering: move shared vocabulary (js-tag) below IR; contain the bridge to ir/integration.ts | current | ready | medium |
| **3141** | Self-hosted stdlib pilot: compile math-helpers as TS builtin source through our own IR pipeline (porffor model) | Backlog | done | high |
| **3142** | IR module-init overlay adoption (claimability milestone; compile-once remains) | 72 | done | high |
| **3143** | Flip IR-first (JS2WASM_IR_FIRST) to default — clears gate G1 of the legacy-frontend retirement | 71 | done | high |
| **3144** | IR: instanceof + static method calls + accessor get/set on local classes (claims classes.ts main) | 71 | done | high |
| **3153** | IR post-claim divergence meter — empirical census of the #3143 IR-first flip's throw-site set | 71 | done | high |
| **3156** | IR selector precision: make string .substring / .charCodeAt lowerable (wasm:js-string family) — #3143 flip track | 71 | done | high |
| **3159** | Self-hosted stdlib, array family slice 1: timsort kernels as TS source through our own IR pipeline | current | ready | high |
| **3160** | Self-hosted stdlib: object-runtime slice 1 — getOwnPropertyDescriptors + fromEntries via our own IR pipeline | 71 | done | high |
| **3161** | Self-hosted stdlib driver: generalized typed-signature emit path (Precursor B/C — unblocks array-methods + object-runtime families) | 71 | done | high |
| **3167** | IR: lower string relational operators (< > <= >=) — #3143 flip-track post-claim divergence class 2 | 71 | done | high |
| **3168** | IR: lower unary +/- ToNumber on non-number operands — #3143 flip-track post-claim divergence class 3 | 71 | done | high |
| **3203** | IR-first allowlist widen: f64 → f64+boolean (Phase-3a enabler) | 71 | done | high |
| **3204** | Self-host Math.log + Math.log2 cores (bloat −LOC, scale-up slice) | 71 | done | high |
| **3213** | IR: inline-small tail-duplication trips post-inline verify (use of SSA value before def) for a call-result live across a duplicated if | 71 | done | medium |
| **3214** | IR: first-class function values (pass a top-level function / arrow as a () => T argument) | Backlog | backlog | medium |
| **3226** | self-host stdlib: convert exp/pow/log10 to TS source (dialect-intrinsics groundwork NOT needed after all) | Backlog | done | medium |
| **3233** | self-host stdlib: convert Math.atan2 to TS source (last non-dialect-gap Math core) | Backlog | done | medium |
| **3256** | Self-host stdlib: convert native-strings.ts hand-emitted Instr[] to TS (Tier-1 resolver-widening) | 72 | done | high |
| **3257** | Self-host stdlib: convert array-methods.ts hand-emitted Instr[] to TS (Tier-2) | 72 | done | high |
| **3258** | Self-host stdlib: convert object-runtime.ts hand-emitted Instr[] to TS (Tier-3) | 73 | done | medium |
| **3259** | Bloat quick-wins: knip dead-export sweep + jscpd duplication scan of src/codegen | 72 | done | high |
| **3260** | Whitepaper: auto-update Test262 numbers + date AND surface the JS-host vs standalone lane distinction with both figures | 72 | done | medium |
| **3262** | CLI: make -o friendlier — accept a file path and/or mkdir the output dir instead of ENOENT | Backlog | backlog | medium |
| **3305** | Self-host stdlib: convert parse-number-native.ts + number-format-native.ts hand-emitted Instr[] to TS (family #2) | current | ready | high |
| **3517** | IR: claim the exact generic Map module initializer | 73 | done | high |
| **3518** | IR-only default and direct front-end retirement | current | in-progress | critical |
| **3519** | IR-only R0: typed preparation outcomes and an honest readiness gate | 74 | done | critical |
| **3520** | IR-only R1: source-qualified unit identity and whole-program ABI map | current | in-progress | critical |
| **3521** | IR-only R2: prepare-before-emit free-function ownership | Backlog | blocked | critical |
| **3522** | IR-only R3: compile-once classes, members, and closures | Backlog | blocked | critical |
| **3523** | IR-only R4: typed ordered module-init compile-once ownership | Backlog | blocked | critical |
| **3525** | IR-only R5: whole-program single- and multi-source Prepared ownership | Backlog | blocked | critical |
| **3526** | IR-only R6: typed semantic runtime contract and frozen feature manifest | Backlog | blocked | critical |
| **3527** | IR-only R7: AST-free async suspension plans and canonical Promise ABI | Backlog | blocked | critical |
| **3528** | IR-only R8: linear consumes the shared Prepared IR program | Backlog | blocked | critical |
| **3529** | IR R0 prerequisite: typed producer equivalence parity | 74 | done | critical |
| **3551** | IR ABI-parity withdrawal must cascade to committed IR callers — #3503 partial-commit broke tests/issue-3471.test.ts on main (invalid Wasm: expected f64, found externref) | 76 | done | high |
| **3553** | IR typed-outcome boundary misclassifies the designed extern-arg coercion rejection as an invariant — 80/178 hard CEs in the standalone RegExp guard suite (`arg 0 of new RegExp expects externref but got string`) | 76 | done | high |
| **3565** | IR over-promotion: restore 4 documented demote-to-legacy contracts (#3341/#3519) — element-store, element-access slice-12, verify #1798 return gate, compound-assign non-f64 RHS | 76 | done | medium |
| **3583** | IR adoption matrix: re-own the 28 orphaned mixed/direct-only rows (tracking issues closed or wont-fix) | current | ready | medium |

<!-- AUTOGENERATED:GOAL-ISSUES-END -->

## Success criteria

- `pnpm run check:ir-only` passes with complete denominators and zero
  Unsupported, Invariant, unaccounted, legacy-emitted, or fatal-result rows.
- Every supported function, class member, synthetic callback, module-init unit,
  and multi-source unit belongs to one `PreparedIrProgram` before either
  backend emits bodies.
- WasmGC and linear consume the same program ABI and semantic IR intents.
- Unsupported features fail source-located and typed; there is no silent
  selector fallback or post-claim demotion.
- `experimentalIR`, `JS2WASM_IR_FIRST`, `disableIrFirst`, compile-twice
  allowlists, and direct-path test modes are removed.
- The refreshed #3090 audit reports zero reachable direct AST→Wasm front-end
  handlers. Runtime/substrate survivors are reached only below the IR boundary.
- Equivalence, cross-backend, full Test262 in both lanes, standalone-floor,
  linear, validity, typecheck, lint/format, LOC, and dead-export gates are green.
