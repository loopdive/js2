---
id: 4520
title: "Differential gate for three-way ABI carrier agreement: r2StableSignatureType / hasFullyAnnotatedScalarAbi / legacy resolveWasmType agree only by argument, not by test"
status: done
sprint: current
created: 2026-08-16
updated: 2026-08-21
completed: 2026-08-21
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: hardening
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
parent: 3518
related: [4514, 4508, 4186, 3518]
origin: "tech-lead IR design review 2026-08-16"
files:
  - src/codegen/ir-legacy-caller-abi.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/ir/program-abi.ts
---

# #4520 — differential test for the three ABI carrier oracles

## Problem

Three independent predicates must answer "what wasm carrier does this
annotated position get" identically:

1. `r2StableSignatureType` (prepared-component admission,
   `src/codegen/ir-prepared-free-functions.ts`),
2. `hasFullyAnnotatedScalarAbi` (select-stage caller-closure certification,
   `src/codegen/ir-legacy-caller-abi.ts`),
3. legacy `resolveWasmType` / `getOrRegisterVecType` (the slot ABI a legacy
   caller's pre-emitted `call` actually targets).

Their agreement is currently argued in comments ("both read the same
`ts.TypeNode` through the same mode-consistent mapping") — not asserted by
any test. The `mname` episode (#3518 notes, 2026-08-15) proved these
arguments go wrong in BOTH directions: `string` positions were excluded from
certification on the claim that "their carrier depends on `nativeStrings`",
which was FALSE (both sides pick from the same
`ctx.nativeStrings && ctx.anyStrTypeIdx >= 0` pair, including the corner). A
wrong argument in the other direction (certifying a position the carriers
disagree on) would be a silent ABI mismatch — the exact hazard class of
#4186 and the late-import index-shift family.

## Acceptance criteria

- [x] A test enumerates the annotated-type surface (scalars, `void`,
      one-level arrays, `string`, and the excluded families: optional/rest/
      default params, generators, object positions) × modes
      (host/standalone/wasi × nativeStrings on/off) and asserts, for every
      cell: certification granted ⇒ IR carrier === legacy carrier
      (structurally, e.g. both `(ref_null $vec_f64)`).
- [x] Cells where certification is DENIED assert why: either the carriers
      genuinely diverge (documented) or the denial is conservative-but-sound
      (candidate for a follow-up widening, listed in the test as such —
      `mname`-style false exclusions become visible instead of latent).
- [x] The test fails if a new `IrType` family or a carrier-affecting ctx flag
      is added without a row (exhaustiveness over the certified surface).
- [x] No behavior change in this PR — a discovered disagreement is its own
      bug to file, not to quietly fix here.

## Resolution (2026-08-21)

`tests/issue-4520-abi-carrier-differential.test.ts` (44 cases, all green). The
witness is semantic rather than textual: each of 20 cells (8 certified, 12
denied) compiles a module whose ONLY caller of `f` is unclaimable (contains
`**`), in both host-free lanes (standalone + wasi — the only lanes where the
certification is consulted; `demoteOnLegacyCallerPolicy` is structurally false
in host mode), once with the IR overlay and once pure-legacy
(`experimentalIR: false`). Assertions per cell: predicate verdict matches the
row table; claim outcome matches; both binaries pass `WebAssembly.validate`
(a divergent carrier at the overlay-into-legacy-call seam cannot validate);
and the executed `probe()` values are identical across lanes. Exhaustiveness
is runtime-checked: the `IrType` union is re-extracted from `src/ir/nodes.ts`
(11 families pinned) and the predicate's `SyntaxKind` surface from
`ir-legacy-caller-abi.ts`, so a new family or a widened certified surface
fails the gate until a row exists.

Notes against the ACs:

- The nativeStrings dimension is exercised where the predicate is live:
  standalone/wasi run the native-string carrier; the `anyStrTypeIdx < 0`
  externref corner exists only in host mode, where the caller-direction
  closure never consults the certification (structural, per #4521's policy
  module) — recorded here rather than tested vacuously.
- No carrier disagreement was discovered (AC 4: nothing to file). One
  measured surprise is documented in the rows: an implicit-any param function
  IS claimed under an unclaimed caller — via the pre-existing
  implicit/projected-param arm of `legacyCallerAbiIsProjected`, not via
  `hasFullyAnnotatedScalarAbi` — i.e. the two oracles partition the surface
  rather than overlap. Conservative-but-sound denials (candidates for
  follow-up widening with their own proof) are marked in the rows:
  `string[]` params, inferred scalar returns, object shape-struct positions.
