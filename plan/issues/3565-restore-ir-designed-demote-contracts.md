---
id: 3565
title: "IR over-promotion: restore 4 documented demote-to-legacy contracts (#3341/#3519) — element-store, element-access slice-12, verify #1798 return gate, compound-assign non-f64 RHS"
status: done
sprint: 76
created: 2026-07-24
completed: 2026-07-24
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: ir-fallback, typed-arrays, element-access, verify, compound-assign
es_edition: es2015
goal: ir-full-coverage
related: [680, 2079, 3341, 3519, 3008, 3552]
assignee: ttraenkler/agent-a63dab458f1a10042
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/integration.ts
origin: "2026-07-24 STRICT-IR over-promotion sweep (continues #680): measured probe over 5322 corpus files + a bounded standalone-test audit found 4 designed-demote sites hard-erroring where legacy compiles fine (the 4th, compound-assign, flips tests/issue-2079 green)."
---

# #3565 — restore IR designed demote-to-legacy contracts broken by #3341/#3519

## Problem

`#3341`/`#3519` made the IR overlay treat any post-claim failure whose
`outcome.kind === "invariant"` as a **hard compile error**
(`formatIrPathFallbackDiagnostic`, src/codegen/index.ts) — the correct fix for
catching real invalid-Wasm emission. But it over-reached: **three sites are
DESIGNED demote-to-legacy points** whose own code comments document a "clean
throw → legacy" / "demotes the function to legacy" contract. A plain
`throw new Error` (or an untyped verify error) at those sites was classified as
the generic `unexpected-internal-throw` / `verifier-failure` invariant → hard,
**failing the compile of valid programs that have a working legacy body**.

`#680` fixed the two most-visible casualties (standalone generator host-import
ref + `.next()` method-call throw) but left these three, which regressed
silently for ~7 days — invisible outside the required checks (#3008 gap).

The four sites:

1. **`lowerElementStore` TypedArray-view store** (src/ir/from-ast.ts) — the
   per-view value conversions (ToUint8/clamp/packing) are legacy-only; doc says
   "Demotes (clean throw → legacy) for: TypedArray-view receivers".
2. **`lowerElementAccess` slice-12 residual** (src/ir/from-ast.ts) — an element
   READ on a receiver/index shape not yet in IR scope (e.g. `extern<C>[i]`).
3. **verify.ts #1798 return-value gate** (src/ir/verify.ts) — a return /
   early.return whose value type or arity would emit invalid Wasm; the gate's
   own comment: "Flagging it here demotes the function to legacy … instead of
   emitting an invalid module."
4. **`lowerCompoundAssign` non-f64 RHS** (src/ir/from-ast.ts) — `s += v` on an
   f64 slot whose RHS lowers to a non-f64 (e.g. an externref value yielded by a
   generator for-of); the numeric coercion is legacy-only. **Found by a bounded
   standalone-test audit** (the #2 lane): `tests/issue-2079` was silently red on
   main — this site flips it (and its 12 siblings) green. Legacy compiles+runs
   the case correctly (`s += it.next().value` → 3).

## Measured evidence (current main, two-compile-per-file probe: IR-overlay vs `experimentalIR:false`)

Casualty = IR overlay hard-fails on an `[IR-FALLBACK]` invariant while pure
legacy compiles the same file fine.

- **standalone corpus** (1347 files @ stride 40): **0** casualties — `#680`
  already captured the standalone value; nothing else standalone regressed.
- **host/default corpus** (5322 files @ stride 10): **3** casualty files —
  `examples/native-messaging/nm_js2wasm_node_fs.ts` (TypedArray element-store),
  `website/playground/examples/benchmarks/helpers.ts` (extern element-access),
  and `test262/.../S13_A6_T1.js` (duplicate-fn-decl → verify #1798 return-type
  mismatch).

**Honest conformance framing:** this is a **~0 test262 flip** PR. Its value is
**forward-looking contract restoration** + **#3008 invisible-regression
closure**: as IR coverage grows, more functions will hit these three demote
paths and hard-fail where they must gracefully fall back to legacy. Restoring
the documented behaviour now — before it bites wider — is the point, not a pass
bump.

## Fix (SURGICAL — do NOT blanket-reclassify `invariant`→`unsupported`)

The whole point of `#3341`/`#3519` making `invariant` hard is to catch invalid-Wasm
emission (real bugs). So the fix types **only** the three documented-demote
throws distinctly, leaving every generic invariant a hard error:

- `src/ir/outcomes.ts` — four new `IrUnsupportedCode`s:
  `element-store-unsupported`, `element-access-unsupported`,
  `return-type-legacy-coupling`, `compound-assign-unsupported`; widen the
  `unsupported` failure `stage` to admit `"verify"` (a verify-stage designed
  demote is legitimately unsupported).
- `src/ir/from-ast.ts` — the TypedArray-view store throw, the slice-12
  element-access terminal throw, and the compound-assign non-f64-RHS throw
  become `IrUnsupportedError` (→ warning → legacy).
  In `lowerElementAccess`, the sibling _internal_ throws (`produced no value`,
  `unexpected IrType`) stay plain `Error` → hard (genuine invariants).
  **Knowingly left hard (pending measurement):** `lowerElementStore` has
  further siblings under the SAME "Demotes (clean throw → legacy)" doc contract
  (packed/exotic-element vec, non-vec receiver, optional-store `a?.[i]=v`,
  non-coercible value). They are NOT converted here: the measured probe (5322
  files) showed only the TypedArray-view throw firing, and under-converting is
  the correct risk posture — a loud hard-fail is safe, whereas converting a
  throw that might be catching a genuine desync would silently mask a bug (the
  exact thing #3341 exists to prevent). If a future measurement shows one of
  these firing on valid code, convert it then with the same distinct-code
  pattern. This is a deliberate scope call, not an oversight.
- `src/ir/verify.ts` — tag the #1798 return/early.return arity+type errors with
  `demote: true` (a discriminator on `IrVerifyError`). Every other verify error
  (SSA scope, dominance, branch/instr type rules, block-id shape) is untagged
  and stays a hard invariant.
- `src/ir/integration.ts` — `verifyIntegrationFailure` routes `demote`-tagged
  verify errors to an `unsupported` outcome; untagged ones stay
  `verifier-failure` invariants. The post-hygiene / post-inline re-verifies
  (which catch a pass corrupting already-valid IR) are untouched — still hard.

## Guard (folded into the required suite, #3552)

`tests/issue-3565.test.ts` — five subtests: each of the 3 sites demotes
(compiles), the #1798 gate error carries `demote:true`, and — critically — a
GENERIC invariant (a real block-id/type desync; an injected build throw) STILL
hard-fails (masking guard, so #3341's invalid-Wasm-catch is preserved).

## Test Results

- `tests/issue-3565.test.ts`: 5/5 pass.
- Full required guard suite (`run-guard-suite.mjs`): green (incl. #680, #3519 siblings).
- `tests/issue-3519-ir-outcomes.test.ts` (over-promotion outcomes): 29/29 —
  the injected verify failure (non-contiguous block id) stays `invariant`.
- `tests/issue-1924.test.ts` (verify type rules): 11/11.
- `check:ir-fallbacks`: OK (no post-claim/unintended increase).
- Post-fix probe: host casualties 2 → **0**; standalone remains 0.
