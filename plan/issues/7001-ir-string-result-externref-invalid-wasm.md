---
id: 7001
title: "ir: a `string`-declared result fed by a dynamic/externref value is patched into the slot unchecked (from-ast `coerceReturnValue` and verify `returnTypeAssignable` both encode host-only string≡externref), so on every native-string lane the IR body returns externref into `(ref null $String)` and the module FAILS Wasm validation — a valid program that compiles with `experimentalIR: false`; the ABI-parity withdrawal cascade also misses callers whose call was inlined away"
status: done
completed: 2026-10-15
sprint: current
created: 2026-10-15
updated: 2026-10-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
language_feature: return-types, strings, abi-parity
goal: ir-full-coverage
related: [3551, 1798, 2949, 7000]
# 2026-10-15: audit finding; from-ast.ts/verify.ts/integration.ts gain one arm each.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/runtime/verify.ts
  # 2026-10-15 (impl): +1 import line — step 4 routes the final telemetry
  # through `withEngineRejectedIrOutcomes` (logic lives in compiler/validation.ts).
  - src/compiler.ts
# 2026-10-15 (impl): +2 lines — the verifier's lane fact (`verifyOptions`) is
# computed once beside `fromAstResolver` and passed to the existing verify calls.
func-budget-allow:
  - src/ir/integration.ts::compileIrPathFunctions
---

# IR string result accepts externref → invalid Wasm on native-string lanes

Found by the 2026-10-15 audit (IR claim lane). Standalone / wasi / `--utf8-storage` / `nativeStrings: true`; gc is valid only because string ≡ externref there.

## Repro

```ts
function addOne(x) { return x + 1; }
export function a1(n: number): number { return addOne(n); }
export function a2(s: string): string { return addOne(s); }
```
`compile(src, { target: "standalone" })` → `success: false`, `emitted WebAssembly failed validation … "a2" … return[0] (expected (ref null 6), got externref)`. `experimentalIR: false` → success. `a1` IS caught (`return[0] type dynamic not assignable to declared result f64` → designed demote); only the string arm is missing. Same for `"v" + (n > 0 ? "p" : 0)`, `let d = n>0?"p":0; d = "q"; return d`, `return tof(n<2)` where `tof(x){ return typeof x }`, `function plusplus(x){return x+x}` into a string result.

Ledger side effect: these rows are recorded `emitted / irBodyEmitted=true` with no `[IR-FALLBACK]` row — the compile dies at the Wasm validator with a non-IR message, so `check:ir-fallbacks` and the outcome telemetry report success for a unit that broke the module.

## Root cause

- `src/ir/from-ast.ts` ~10790-10810 (`coerceReturnValue`): after the `dynamic`/`f64` arms, `if (!declared || declared.kind !== "val" || declared.val.kind !== "externref") return value;` — a declared `{kind:"string"}` result receiving a `dynamic`/`externref` value is returned as-is.
- `src/ir/runtime/verify.ts:581-624` (`returnTypeAssignable`): the final "both reference-shaped (or externref): assignable" arm returns `true` for actual=dynamic/externref, declared=string. Under `nativeStrings`, string lowers to `(ref null $AnyString)` and dynamic to externref (`lower-generic.ts:3991 lowerIrTypeToValType`).
- The integration parity check (`src/ir/integration.ts` ~5520) cannot catch it: the IR func's typeIdx is computed from the override (string), so IR and legacy typeIdx agree while the BODY disagrees.
- Second half: `src/ir/integration.ts` ~5620-5655 — the #3551 parity-withdrawal cascade withdraws `pendingPatches` whose IR fn still contains a `call`/`closure.new` to a withdrawn unit (`findReferencedWithdrawnIrUnit`, :5910). It runs AFTER module-scope inlining / monomorphise / constant folding, so a caller whose call was inlined and folded has no reference left and commits a body built on the callee's IR ABI (confirmed by WAT: `c3` emits `global.get; extern.convert_any; return` with `tof2` folded in; `JS2WASM_IR_INLINE=0` does not change it).

## Implementation Plan

1. `coerceReturnValue`: add a declared-`string` arm. When the actual is `dynamic`/externref and the lane's string representation is NOT externref (ask the resolver: the same predicate `lowerIrTypeToValType` uses — expose it as `stringIsExternref(ctx)` if not already), either emit the dynamic→string conversion the IR already has for `+` string concatenation (`dyn.to_string` / the `js.string.*` intrinsic family) or throw `IrUnsupportedError("return-type-legacy-coupling", "build", …)` to demote exactly like the f64 arm does. Demote is the minimal correct fix; conversion is better if the intrinsic exists.
2. `returnTypeAssignable`: make it lane-aware — `dynamic`/externref actual into `string` declared is assignable ONLY when the resolver says string ≡ externref. The function is pure today; thread the one boolean in from the verify entry point (it already receives lane facts for `support-ref`).
3. Cascade: compute the referenced-withdrawn-callee set from the PRE-inline built functions (record `inlinedFrom` unit ids on each function when phase 2b/2d inline or fold a callee, and include them in `findReferencedWithdrawnIrUnit`). Add a test that fails today: `tof2` shape from the audit (`.tmp/audit/t18.ts` is gone with the container; recreate from this description).
4. Telemetry honesty: when the Wasm validator rejects the module, the outcome row for the IR unit(s) in the failing function should be `invariant`, not `emitted`. Hook the validation failure in `src/compiler.ts` (where `emitted WebAssembly failed validation` is produced) to the outcome recorder when `trackIrOutcomes` is on — small, and it is what makes #7002's ledger truthful.
5. Tests: the repro file compiled under `target: "standalone"`, `"wasi"`, `{ utf8Storage: true }`, and gc, asserting success and correct output (`a2("x")` → `"x1"`), plus the inlined-caller cascade case.

## Acceptance

- All five repro programs compile and run correctly on standalone with IR on.
- `check:ir-only` stays READY; `check:ir-fallbacks` unintended buckets unchanged or lower.
- gc byte-identical for the repro (string ≡ externref there, so no body change).

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-7001-ir-string-result-externref-invalid-wasm.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.

## Implementation notes (2026-10-15)

- **Step 1 (from-ast)** — `coerceReturnValue` gained a declared-`string` arm: a
  `dynamic` / externref value into a `string` result throws
  `IrUnsupportedError("return-type-legacy-coupling", "build")` unless
  `cx.resolver.stringIsExternref()` is `true`. Demote, not conversion: the IR has
  no checked dynamic→native-string conversion (the `+` concat path demotes on
  dynamic operands too). Resolver-absent defaults to demote.
- **Step 2 (verify)** — `returnTypeAssignable` takes the lane fact through a new
  optional `IrVerificationOptions.stringIsExternref`; `false` rejects
  dynamic/externref → `string` (still the `demote: true` #1798 gate). Absent ⇒
  the historical lenient answer, so callers outside integration are unchanged.
  `integration.ts` computes it once from `fromAstResolver` and passes it to the
  build, post-hygiene, post-inline and post-mono verify calls.
  `verifyDominanceNaive` became optional (`options?.verifyDominanceNaive ?? env`),
  behaviour-identical for the existing callers.
  Measured: with step 1 disabled, step 2 alone also turns all four
  invalid-Wasm repros into designed demotes.
- **Step 3 (cascade) — not implemented as `inlinedFrom` tracking; covered by
  steps 1+2.** Inlining removes the call, so the caller no longer depends on the
  withdrawn callee's ABI; the only way the inlined body went wrong was the
  externref→string return flow, which the build arm now demotes and the
  lane-aware post-inline / post-mono verify now rejects. Test: `tof2` with
  `c3(): string { return tof2(1) }` (demotes) and `c4(): boolean { return
  tof2(1) === "number" }` (stays IR, inlined + folded) both run correctly on
  every lane. If a future withdrawal reason is SEMANTIC rather than ABI, the
  `inlinedFrom` bookkeeping would become necessary — not the case for #3551.
- **Step 4 (telemetry)** — `withEngineRejectedIrOutcomes`
  (`src/compiler/validation.ts`) re-keys the `emitted` row of the IR unit the
  engine names (`Compiling function #N:"name"`) to
  `invariant / backend-legality / backend-legality-failure` when validation
  fails. Verified on the pre-fix IR: `a2` reads
  `invariant/backend-legality/backend-legality-failure` instead of `emitted`.
- **Lanes verified** (compile + validate + run, `tests/equivalence/issue-7001-ir-string-result-native-strings.test.ts`):
  standalone, wasi, `{ target: "standalone", utf8Storage: true }`, gc. 15/20
  rows fail on the base, 20/20 pass after. gc binaries for the repro programs are
  byte-identical before/after (sha1 compared); on gc `stringIsExternref()` is
  `true`, so neither arm changes anything there.
- **Gates**: loc/func budget (also with `LOC_GATE_BASE=origin/main`), coercion
  sites, oracle ratchet, dead exports, ir-layering, ir-dialect: OK.
  `check:ir-only` READY; `check:ir-fallbacks` OK (no unintended growth).
  `tests/equivalence/*{string,class,inherit,return}*` (22 files): 187/188, the
  one failure is the baselined `array-inline-return … find does not hijack return`.
- **Left out — repro 2 is a DIFFERENT root cause.**
  `export function b(n: number): string { return "v" + (n > 0 ? "p" : 0); }`
  fails on ALL lanes including gc, before and after this change, with
  `IR-first (#2138): b failed after its legacy body was skipped: … '+' operands
  not provably both-number or both-string (string/unprovable)` /
  `invariant [unpatched-slot]`. The IR-first routing skips `b`'s legacy body,
  then from-ast's #2781 `+` proof demotes at build — a selector-vs-builder claim
  disagreement, not a string-result flow. It only reproduces when `b` has no
  in-module caller (adding `export function main() { return b(1) === "vp" ? 1 : 0 }`
  makes it compile). `JS2WASM_IR_FIRST=0` compiles it. Needs its own issue
  (IR-claim lane).

