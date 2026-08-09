---
id: 3536
title: "Standalone: object-literal argument to a declared function reads null (struct/externref call-boundary mismatch) — RegExp property-escapes 311-row cluster"
status: done
created: 2026-07-23
updated: 2026-07-23
completed: 2026-07-23
priority: high
feasibility: medium
reasoning_effort: max
task_type: bugfix
area: codegen
goal: standalone
sprint: 75
horizon: m
umbrella: 2860
assignee: ttraenkler/fable-2860
related: [2860, 3535, 2863, 2868, 2878, 3534]
oracle-ratchet-allow:
  - src/codegen/literals.ts
# LOC growth is the fix itself, in the owning modules (not barrel spill):
# the expectedType routing arm lives beside the sibling literal-routing arms
# in compileObjectLiteral (+48 incl. its rationale comment), the ABI parity
# guard beside the pre-existing class-member guard in the IR patch loop
# (+42), and the 4-line forward in expressions.ts's dispatch.
loc-budget-allow:
  - src/codegen/literals.ts
  - src/ir/integration.ts
  - src/codegen/expressions.ts
files:
  - src/codegen/expressions.ts
  - src/codegen/literals.ts
  - src/ir/integration.ts
  - src/ir/outcomes.ts
  - tests/issue-3536.test.ts
---

# Standalone: object-literal argument to a declared function reads null

## Discovery

Found by the #3535 de-masked signature census (2026-07-23): the single largest
addressable cluster in the previously-masked standalone population is
`TypeError: Cannot access property on null or undefined at L:C` (149/516 of
the addressable stratified sample). Its cleanest sub-family is
**`built-ins/RegExp/property-escapes/generated/` — 311 rows, one signature,
no live owner** (#2876/#3507/#2935 all done). Every test there calls
`buildString({ loneCodePoints: [...], ranges: [[...], ...] })` from
`regExpUtils.js` and dies at `const loneCodePoints = args.loneCodePoints;`
with `args === null`.

## Root cause (verified from emitted WAT + 8-case bisect)

Standalone call sites for **top-level DECLARED functions** are broken at the
struct/externref boundary, in both directions:

1. **Silent-null arm (the property-escapes signature).** The object literal in
   ARGUMENT position falls back to `compileObjectLiteralAsExternref`
   (`src/codegen/literals.ts` — dynamic plain object via `__new_plain_object`
   - `__set_prop`, externref carrier), while the callee's untyped param was
     structurally narrowed to a concrete struct type (`(ref null 54)`). The
     call-arg coercion then runs `any.convert_extern` → `emitGuardedRefCast`
     (`src/codegen/type-coercion.ts:43`), whose **else-arm pushes
     `ref.null <struct>`** — the param arrives null and the first property read
     throws. The SAME literal assigned to a `var` first (then passed as an
     identifier) lowers via typed `struct.new` and PASSES.
2. **Invalid-wasm arm (mirror).** `function f(a){return a.x} f({x:1})` infers
   the param as EXTERNREF while the argument is built as a typed struct; the
   call site is missing `extern.convert_any` → V8 rejects the module:
   `call[0] expected type externref, found if of type (ref null 54)`. Part of
   the #2878-class invalid-wasm residual is this same defect.

Controls: host lane passes both shapes; the function-EXPRESSION form passes
(closure params keep the boxed-any rep — the never-narrow principle of the
in-flight #3534 unified closure-value representation).

Bisect matrix (standalone, both init models — pre-existing, NOT an #3535
artifact):

| shape                                                       | result               |
| ----------------------------------------------------------- | -------------------- |
| `function f(a){return a.x}; f({x:1})`                       | INVALID WASM (arm 2) |
| `function f(a){var v=a.x; return v}; f({x:1,y:2})`          | null param (arm 1)   |
| exact regExpUtils shape (const/var inside, ± nested arrays) | null param           |
| same literal via `var obj = {...}; f(obj)`                  | PASS                 |
| `const f = function(a){...}` (expression)                   | PASS                 |

## Fix directions (pending lead arbitration vs #3534 — 2026-07-23)

- **O1 (pure bugfix):** call-arg coercion — (i) struct→externref param:
  insert the missing `extern.convert_any`; (ii) dynamic→struct: never
  silent-null.
- **O2 (consistency):** when the callee param has a registered struct type,
  lower the literal argument with that contextual type through the struct
  path (as var-init position already does).
- **O3 (rep policy — #3534's surface, not to be taken unilaterally):**
  never-narrow declared-function untyped params, boxed-any like closures.

Collision note: touches `src/codegen/expressions.ts` /
`src/codegen/type-coercion.ts` / `src/codegen/literals.ts`, which border the
#3534 closure-value-representation work (`variables.ts` A1/A2 +
`closures.ts` A3). Lead arbitration requested before implementation; do not
start this issue without confirming #3534 coordination.

## Measurement discipline (per lead steer)

The cross-family reach (149/516 sampled ⇒ ~1,190 naive extrapolation) must be
**measured, not extrapolated**: after the fix, run a stratified sample of the
full null-deref-signature population across families and count REAL
fail→PASS flips before sizing any claim. The guaranteed floor is the 311-row
property-escapes family (single signature, single call shape) — and only if
the post-fix run shows actual passes (the tests also need
`String.fromCodePoint.apply`, template-literal `RegExp` construction, and
`\p{...}` unicode-property matching to work — CE→valid ≠ CE→pass).

## Repro

`.tmp/probe-3536-bisect.mts` (worktree agent-a0b623d5c2d84ceb6) — 8-case
ladder; `.tmp/probe-3536-wat.mts` dumps the WAT of the failing call site.

## Implementation (landed 2026-07-23, lead arbitration: O1+O2, O3 rejected)

Deeper root-cause than the plan above anticipated — the WAT/instrumentation
trace found THREE cooperating parts, and the fix landed at two of them:

1. **The narrow/lower disagreement (arm 1).** `inferParamTypeFromCallSites`
   (declarations/param-return-inference.ts) narrows an implicit-`any` param to
   the shape struct derived from `getTypeAtLocation(literal-arg)` — but the
   literal ARGUMENT's own lowering consults `getContextualType` (= `any`) and
   diverts to the dynamic `$Object` path (#1901 arm in
   `compileObjectLiteral`). The call-boundary coercion `externref →
any.convert_extern → ref.test <shape>` can then NEVER match → else-arm
   `ref.null <shape>` → callee param is silently null.
   **Fix (O2):** `compileExpression` forwards the Wasm-level `expectedType`
   into `compileObjectLiteral`; when the literal's OWN struct resolution lands
   exactly on the expected param typeIdx (typeIdx equality — precise by
   construction), construct that closed struct, matching the var-init position
   which already passed. `ctx.standalone`-gated; host/wasi byte-identical.
2. **The IR ABI replacement (arm 2).** The IR overlay lowered such a function
   with an externref param and `replaceDefinedFuncAt` swapped the signature
   AFTER `__module_init` (legacy) had emitted its call coercions against the
   collect-time struct type — the module failed V8 validation ("call[0]
   expected type externref, found …"). The patch-time typeIdx parity guard
   deliberately exempted top-level FunctionDeclarations on the (false)
   assumption that no legacy caller depends on the prior typeIdx.
   **Fix:** the guard now covers top-level functions; on divergence the IR
   withdraws the claim via a NEW soft `abi-signature-parity` unsupported code
   (warning channel, not a compile error) and the legacy body/ABI stays.
   Class-member/module-init keep their pre-existing hard-invariant semantics.
   **CI-found refinement (first PR run):** the guard is scoped to slots with a
   REAL legacy body (`existing.body.length > 0`). The original exemption's
   claim was half-true: a lifted branch-hoisted nested declaration
   (`if (x) { function inner(){…} }`) has an EMPTY pre-allocated slot with a
   placeholder typeIdx (probe: `test__nested_inner_0: IR=10 legacy=0
legacyBodyLen=0`), where the IR body is the ONLY body — withdrawing there
   left an empty function and an invalid module (the var-hoisting-scope /
   scope-and-error-handling equivalence regressions) and needlessly
   de-claimed 3 playground units (the #3519 readiness-floor trip). Empty
   slots keep the pre-#3536 patch behavior; the narrowed guard resolves both
   CI failures while all 8 repro shapes stay fixed.
3. **O1(ii) deliberately NOT taken here:** with 1+2 the two measured defects
   are fixed at their causes; the generic `emitGuardedRefCast` silent-null
   else-arm was not even the emitting site in the traced cases (the pattern
   came from `coerceType`'s own arm), converting it to a trap is %-neutral
   per the lead's own analysis, and the file borders the #3534 surface. Left
   for a dedicated slice if a measured case ever needs it.

`oracle-ratchet-allow: src/codegen/literals.ts` — the new arm needs the raw
type IDENTITY for `resolveStructName`'s anonTypeMap/structMap lookup, a
wasm-lowering ValType question deliberately above what `ctx.oracle`
expresses (its header assigns struct registration to the caller).

## Measured results (verify-first discipline)

- 8-case bisect ladder: **8/8 PASS** (pre-fix: 3 silent-null, 3 invalid-wasm,
  2 control-pass).
- Cross-family reach measured, NOT extrapolated (the 149/516 sampled
  signature suggested ~1,190): re-running all 198 sampled
  `Cannot access property on null or undefined` rows post-fix →
  **2 flip to pass; 41 property-escapes rows advance to the NEXT
  pre-existing wall; 138 are unrelated defects** (TypedArray/prototype
  callback internals etc. — #2872/#3177 territory). The naive extrapolation
  was ~600× too optimistic on direct flips — exactly why we measure.
- **The 311-row property-escapes family is now gated by ONE downstream
  defect**, not this boundary: `String.fromCodePoint.apply(null, vec)`
  null-derefs in `__str_concat` even at plain top level (pre-existing,
  reproduces with no function params at all), plus an `illegal cast` in the
  grown-`codePoints`-array variant of the same `buildString` harness
  function. Both live in the apply/fnctor machinery — follow-on issue filed
  (see below); fixing that ONE harness function's path flips the family.
- Regression battery: typecheck ✓ · 101-row standalone pass-sample: 0
  pass→fail (89/12 split identical to pre-fix) ✓ · issue-1901/1472/3468
  (75 tests) ✓ · 21 targeted equivalence files (224 tests) ✓ ·
  `check:ir-fallbacks` gate OK (no bucket growth from the IR guard) ✓ ·
  new `tests/issue-3536.test.ts` (5 tests) ✓.
