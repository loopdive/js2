---
horizon: m
id: 3656
title: "IR: dynamic destructured parameter blocks ESLint getInactivityReasonMessage"
status: ready
created: 2026-07-26
updated: 2026-08-26
priority: critical
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: ir, codegen
language_feature: object-destructuring
goal: npm-library-support
sprint: current
required_by: [1400, 2691]
es_edition: ES2015
related: [1169c, 1400, 2691, 3518, 3654]
---

# #3656 — IR lowering for an untyped JS destructured parameter

## Problem

The real ESLint package graph fails on this function from
`eslint/lib/shared/flags.js`:

```js
function getInactivityReasonMessage({ replacedBy }) {
  if (typeof replacedBy === "undefined") {
    return "This feature has been abandoned.";
  }
  if (typeof replacedBy === "string") {
    return `This flag has been renamed '${replacedBy}' to reflect its stabilization. Please use '${replacedBy}' instead.`;
  }
  return "This feature is now enabled by default.";
}
```

The fatal diagnostic is:

```text
Codegen error: IR path failed for getInactivityReasonMessage:
ir/from-ast: object destructuring source must be IrType.object or IrType.class
(got dynamic) in getInactivityReasonMessage [IR-FALLBACK]
```

## Independent reproduction

This is not merely a package-resolution cascade. On 2026-07-26 the existing CLI
failed when compiling `node_modules/eslint/lib/shared/flags.js` directly with
`--no-optimize`; it emitted the exact diagnostic above before producing Wasm.

The input is plain JavaScript under `allowJs`: JSDoc describes the parameter,
but IR sees the destructuring source as `dynamic`.

## Fix direction

Determine whether the canonical IR representation should:

1. carry the JSDoc object shape into the parameter type;
2. lower dynamic object destructuring as named dynamic property reads; or
3. return a typed `Unsupported` outcome and use an explicitly permitted legacy
   path until dynamic destructuring is represented.

Do not silently default `replacedBy` or erase the function. The returned message
must be verified by value for the missing/string/null cases.

## Acceptance criteria

- The direct real `flags.js` input compiles and emits valid Wasm.
- A reduced untyped-JS fixture covers `{ replacedBy }` with:
  omitted property, string property, and `null`.
- Runtime results match Node for all three arms.
- IR-only policy reports no invariant/fatal fallback for the function.
- `tests/issue-3656.test.ts` permanently covers the reduced untyped-JavaScript
  destructured parameter and validates its emitted Wasm.
- The full ESLint package-entry probe no longer contains the
  `getInactivityReasonMessage` diagnostic; later blockers are reported
  separately.

## Root cause and implementation (2026-07-26)

Selection and overlay planning used different type sources for the same
JavaScript parameter:

- selection called `effectiveIrParamTypeNode`, so it saw the JSDoc
  `InactiveFlagData` reference;
- overlay planning read only `p.type`, which is absent on a JavaScript
  parameter, and therefore replaced the selected parameter with propagated
  `dynamic`.

The overlay planner now uses the shared effective JSDoc-aware parameter helper.
For ESLint's exact optional `string | null` field, the current object IR cannot
project the union, so preparation records a typed resolve-time unsupported
result and retains the legacy body. It no longer hands a dynamic value to the
object-pattern builder or promotes the mismatch to a fatal invariant.

## Verification (2026-07-26)

- Added `tests/issue-3656.test.ts` with omitted, string, and null runtime
  branches plus a direct compile/validation of ESLint's real `flags.js`.
- The real file compiles successfully and validates. Its only IR note is the
  expected resolve-time object-shape limitation; there is no build-time
  destructuring invariant.
- The Tier 1 package-entry probe no longer contains
  `getInactivityReasonMessage` or `object destructuring source` diagnostics;
  planning blocker `3654` is the remaining pinned compile frontier.

## Implementation Plan

### Verdict (re-verified 2026-08-26 against `main` @ `0e65e238`)

**The blocker in "Problem" is FIXED. Every acceptance criterion is met. This
issue should close as `done`; the work below belongs to #2949 and to two new
follow-ups, not to a reopened #3656.**

Evidence:

- `npx vitest run tests/issue-3656.test.ts` — 2/2 pass, including the direct
  `compileProject` of the installed `eslint/lib/shared/flags.js` (it ran; not
  skipped). Wasm validates.
- Scratch matrix `.tmp/probe-3656*.mjs` (9 shapes × host/fast) — the string
  `object destructuring source must be IrType.object or IrType.class (got
  dynamic)` **no longer occurs at all**, at any severity. It is unreachable at a
  parameter: `src/ir/select.ts:1911` rejects a `dynamic` binding-pattern param
  **pre-claim**, so `lowerObjectPattern` never sees a dynamic source.
- The message still exists (`src/ir/from-ast.ts:3633`) and is still reachable —
  but only for **local** destructuring off a non-object source
  (`const { length } = str` → `(got string)`, `= arr` → `(got vec<f64>?)`), as a
  non-fatal `build`-stage demote. Different population, tracked below as R5.

Everything after this point is **residual IR coverage**, not a regression, and
none of it is fatal: each item is a silent, correct demote to legacy.

### What actually remains — measured, not inferred

`irCompiledFuncs` / `irPostClaimErrors` for `function reason({ replacedBy })`
and its neighbours (`.tmp/probe-3656{,b,e,f,g,h,i}.mjs`):

| # | Shape | IR claims? | Diagnostic |
|---|---|---|---|
| A | untyped JS `({ replacedBy })` | no | (pre-claim, silent) |
| B | **ESLint's exact** JSDoc `@property {string \| null} [replacedBy]` | no | `resolve`: `object TypeNode TypeReference could not be lowered to IrType.object` |
| C | JSDoc, **no** union, destructured | no | `build`: `function typeIdx parity mismatch: IR=14, legacy=11` |
| D | TS `{ replacedBy }: { replacedBy: string }` | **yes** | — |
| E | TS `{ replacedBy }: { replacedBy?: string }` | no | `resolve`: `… TypeLiteral could not be lowered` |
| J | TS `{ replacedBy }: Flag` (interface) | **yes** | — |
| M | JSDoc typedef, **not** destructured (`f.replacedBy`) | **yes** | — |
| N | TS union field, **not** destructured | no | `resolve`: same as E |
| F/G/H | default / rest / nested in pattern | no | `destructuring-param-complex` (pre-claim) |

Read the matrix as three orthogonal gaps, none of which is "destructuring":

**R1 — object IR cannot represent a union field.**
`tsTypeToFieldIr` (`src/codegen/index.ts:1392-1401`) returns `null` for anything
that is not NumberLike / BooleanLike / StringLike / Object. `string | null` and
`string | undefined` (i.e. every optional field) fall out, so
`objectIrTypeFromTsType` (`:1352`) bails and `resolvePositionType` throws at
`:1231`. This is what stops **B**, and it is **not destructuring-specific** — it
stops **N** identically.

**R2 — `p.type`-vs-JSDoc split-brain, third site.**
`bindingPatternParamNeedsWiden` (`src/codegen/declarations.ts:330-333`, used at
`:957`) reads **`p.type` only**:

```ts
if (p.type || p.dotDotDotToken) return false;
return ts.isArrayBindingPattern(p.name) || ts.isObjectBindingPattern(p.name);
```

So legacy widens a JSDoc-typed destructured param to `externref`, while the IR
resolves it through `effectiveIrParamTypeNode` (`src/ir/select.ts:2137-2139`,
consumed at `select.ts:1948`, `from-ast.ts:1135`, `codegen/index.ts:2565`) to a
struct ref. The claim is then withdrawn at `src/ir/integration.ts:3336-3348` —
the *soft* `abi-signature-parity` arm, explicitly documented there as "the IR
legitimately cannot express e.g. a shape-struct param". This is exactly the bug
class the 2026-07-26 fix repaired on the overlay planner; `declarations.ts:330`
is the site it did not reach.

**R3 — no dynamic arm in the destructuring lowerer.**
`src/ir/select.ts:1907-1911` rejects a `dynamic` binding-pattern param outright,
and `lowerObjectPattern` (`src/ir/from-ast.ts:3625-3637`) has no branch for a
`dynamic` source. This is what stops **A** — the majority shape in real JS.

**R4 — the actual gate on ESLint's function: `typeof` on a dynamic value is not
claimable.** Measured directly: `function reason(f: any) { if (typeof f ===
"string") … }` does **not** claim; only a pure move (`return f`) does.
`dynamicUsesAreMoveOnly` (`src/ir/select.ts:2630`, called at `:2047`) still
admits only moves, so `emitDynMemberGet` (`src/ir/builder.ts:660`) remains
"wired but unreached" exactly as its own comment says. **Even with R1–R3 landed,
`getInactivityReasonMessage` would still not IR-claim**, because its entire body
is `typeof` dispatch. R4 is #2949 S5.P and is out of scope here.

**R5 — `lowerObjectPattern` has no `string`/`vec` arm** for `const { length } =
s`. Bounded, unrelated, note-only.

### The concrete change

Three independent slices. **S1 and S2 must land together or not at all for the
destructured population** — see the interaction note.

**S1 — represent a union field as the legacy carrier (fixes B, E, N).**

`src/codegen/index.ts`, `tsTypeToFieldIr` (`:1392`). Add, after the
`StringLike` arm and before the `Object` arm:

- if `t.isUnion()` and every constituent is NumberLike / BooleanLike /
  StringLike / Object / Null / Undefined → return
  `irVal({ kind: "externref" })`;
- otherwise keep the `null` rejection.

`irVal({kind:"externref"})` is **not** a style choice — it is the measured
legacy layout. Probe `.tmp/probe-3656f.mjs`:

| field type | legacy `fast=false` | legacy `fast=true` |
|---|---|---|
| `string` | `(mut externref)` | `(mut (ref null $AnyString))` + `$$shapeBrand` |
| `string \| null` | `(mut externref)` | `(mut externref)` |
| `number` | `(mut f64)` | `(mut f64)` |
| `number \| null` | `(mut externref)` | `(mut externref)` |
| `any` | `(mut externref)` | `(mut externref)` |

Legacy stores a union field as bare `externref` **in both modes**, so the IR
field hashes to the same `legacyFieldsHashKey`
(`src/ir/integration.ts:6937-6952`) and `ObjectStructRegistry.resolve`
(`:6852-6923`) converges on legacy's existing `__anon_N` instead of minting a
second struct. **Do not use `irDynamic()` here** — `resolveDynamic()`
(`src/ir/integration.ts:5346`) returns `ref_null $AnyValue` in fast mode, which
would diverge from legacy's `externref` and re-create the R2 parity mismatch in
fast mode only.

Fast mode carries a second hazard the table exposes: legacy adds a
`$$shapeBrand` field for some shapes and not others. Gate S1's acceptance on
mode if the brand rule cannot be reproduced exactly; the `abi-signature-parity`
check at `integration.ts:3336` is the backstop and turns any layout divergence
into a demote, never a miscompile — but a demote is a silent no-op, so verify
`irCompiledFuncs` contains the function rather than trusting `success === true`.

**S2 — one shared predicate for "legacy widens this binding-pattern param"
(fixes C, K, O).**

Export from `src/ir/select.ts`, beside `effectiveIrParamTypeNode`:

```ts
export function legacyWidensBindingPatternParam(p: ts.ParameterDeclaration): boolean;
```

with the body currently at `src/codegen/declarations.ts:330-333`, and have all
three consumers import it:

1. `src/codegen/declarations.ts:957` — replace the local helper (delete
   `bindingPatternParamNeedsWiden`; keep `restBindingOverridesToExternref`);
2. `src/ir/select.ts:1899-1922` — in the binding-pattern arm, when the predicate
   is true, resolve `dynamic` **instead of** consulting
   `effectiveIrParamTypeNode`, so the IR ABI matches legacy's `externref`;
3. `src/codegen/index.ts:2550-2566` `resolveIrOverrideParamType` — same, so the
   overlay cannot re-derive a struct override the selector declined. This is the
   site the 2026-07-26 fix touched; leaving it out reintroduces the original bug
   in mirror image.

**Direction matters: align the IR to legacy, not legacy to the IR.** Teaching
`bindingPatternParamNeedsWiden` about JSDoc (`p.type ?? ts.getJSDocType(p)`) is
a one-word change that also "fixes" C — and it changes the **legacy ABI** for
every JSDoc-typed destructured param in React / ESLint / webpack from a
forgiving `externref` to a `ref.test`-gated struct ref. JSDoc in real packages
is routinely loose or wrong; a caller passing an off-shape object would get
`ref.null` instead of a working destructure. That widening exists precisely to
be forgiving (see the `#862` rationale at `declarations.ts:325-329`). Do not
touch it.

**S1 × S2 interaction — the trap.** With S1 alone, B stops failing at `resolve`
and starts failing at `build` (it becomes case C): a JSDoc-typed destructured
param whose shape now *is* resolvable, hitting the parity mismatch. Net gain
zero. With S2 alone, C stops mismatching but routes to `dynamic`, which S3 must
then lower. **S1's standalone value is the non-destructured population (N, E,
M-with-union) — a large real-world class on its own.** State that explicitly in
the PR; do not claim S1 unblocks ESLint.

**S3 — dynamic arm in `lowerObjectPattern` (fixes A; makes S2's output
lowerable).**

- `src/ir/select.ts:1911` — replace the blanket
  `if (paramResolved === "dynamic") return "param-type-not-resolvable"` with an
  accept for **object** patterns only (array patterns need the iterator
  protocol — keep rejecting), still downstream of `isPhase1BindingPattern`
  (`:5291`) and still gated by `dynamicUsesAreMoveOnly` at `:2047`.
- `src/ir/from-ast.ts:3627-3637` — before the `demoteToLegacy`, add: when
  `sourceType.kind === "dynamic"`, emit one `dyn.member_get` per leaf, keyed by
  the literal property name boxed as a tag-5 string carrier, binding each leaf
  as a `dynamic` local. Copy the pattern verbatim from the named-read arm at
  `from-ast.ts:5277-5279`:
  ```ts
  const key = cx.builder.emitBox(cx.builder.emitStringConst(propName), irDynamic(JS_TAG_IDS.String));
  const leaf = cx.builder.emitDynMemberGet(source, key);
  ```
  `emitDynMemberGet` (`src/ir/builder.ts:660-676`) requires **both** operands to
  be `dynamic` and rejects concrete ones at construction; the param carrier from
  `from-ast.ts:1131-1136` is already the dynamic carrier, so no coercion is
  needed. `IrDynamicLowering.emitMemberGet`
  (`src/ir/backend/handles.ts:431-433`) is mode-split and, in host mode, is a
  thin `__extern_get` wrapper — byte-identical to what legacy already emits for
  this exact shape.
- S3 lands as **mechanism-only / byte-inert** until R4 opens the scan, which is
  the established idiom here (see the "MECHANISM ONLY … wired but unreached"
  comment at `from-ast.ts:5265-5275`). Ship it that way, with a test that pins
  the *move-only* dynamic destructure (`function f({a}) { return a; }`) — the
  one body shape the current scan already admits — so the arm is genuinely
  exercised rather than dead.

### Interaction with the IR fallback baseline

**Nothing here moves `scripts/ir-fallback-baseline.json`, and the gate cannot
protect it.** Verified 2026-08-26:

- `pnpm run check:ir-fallbacks` → `OK`, with `unintended: {}`,
  `postClaim: {build:{},verify:{},lower:{},backend-legality:{}}`,
  `moduleLevel: {}`. Only `deferred.string-builder-candidate: 2` is non-zero.
  `param-shape-rejected` is already **corpus-zero and cannot shrink**.
- The corpus is `CORPUS_ROOTS = [website/playground/examples]`
  (`scripts/check-ir-fallbacks.ts:89`), which holds **13 `.ts` files and 0
  `.js`**. Untyped JS and JSDoc — this issue's entire population — never enter
  it. The gate is structurally blind here; do not cite a green gate as evidence
  for any of S1–S3.
- Neither `param-shape-rejected` nor `destructuring-param-complex` is the
  reason on the failing path anyway: A/C are `param-type-not-resolvable` and a
  post-claim `abi-signature-parity` demote respectively.
- Post-claim accounting: `POST_CLAIM_KINDS` is
  `["build","verify","lower","backend-legality"]`
  (`scripts/check-ir-fallbacks.ts:143`) and any other kind — including
  `"resolve"` — is folded into `lower` at `:350`. So R1's demote would land in
  `postClaim.lower` if the corpus contained such a shape. It does not.

**Do not promote anything into `STRICT_IR_REASONS`.** The set at
`src/codegen/index.ts:2043` is empty by design, and the comment at `:2044-2067`
names "the destructuring param buckets" among the reasons that describe
*legitimate* IR-non-claimability. Corpus-zero is explicitly declared necessary
but not sufficient (#3341). Promotion requires the reason to be genuinely
**unreachable**; after S1–S3 a dynamic destructure is still declined whenever
`dynamicUsesAreMoveOnly` says no, so `param-type-not-resolvable` stays reachable
by construction. The post-claim promotion vector (`:2070-2090`, four-part bar)
is likewise unavailable: S1/S2 *reduce* `abi-signature-parity` demotes but leave
the code live for genuine shape-struct divergence.

The real regression protection is `tests/issue-3656.test.ts` plus the
npm-compat dashboard (`benchmarks/results/npm-compat.json`, refreshed by
`npm-compat-refresh.yml` — do not hand-commit it).

### Edge cases

- **Optional (`?`) vs `| undefined`** — identical to the checker and both hit
  R1. `{ replacedBy?: string }` (E) and `{ replacedBy: string | null }` (N)
  produce the same demote; S1 must accept both.
- **Param-level `?`/rest/default** — `src/ir/select.ts:1900-1902` rejects these
  as `param-shape-rejected` *before* the pattern check. Unchanged; S3 must not
  loosen them (arity is ABI).
- **Element-level default / rest / nested** (F/G/H) — `isPhase1BindingPattern`
  (`src/ir/select.ts:5291-5311`) rejects → `destructuring-param-complex`.
  Deliberately out of scope: a default needs a runtime undefined test per leaf,
  a rest needs own-key enumeration, and a nested pattern needs a recursive
  dynamic read. S3 must keep routing them to legacy — `lowerObjectPattern`'s
  defensive re-checks at `from-ast.ts:3640-3660` stay as the selector-desync
  guard.
- **Computed keys** — `{ [k]: v }` is rejected by `isPhase1BindingPattern`
  (`:5301-5303`, propertyName must be Identifier or StringLiteral) and again
  defensively at `from-ast.ts:3663-3675`. `emitDynMemberGet` would in principle
  accept a computed key (it is key-uniform), but evaluation-order and
  `ToPropertyKey` semantics make this its own slice. Leave rejected.
- **String-literal property names** (`{ "a-b": v }`) — already accepted by both
  gates; S3's key box must use `elem.propertyName.text`, not `elem.name.text`,
  for the renaming form. The existing `propName` computation at
  `from-ast.ts:3661-3668` already does this; reuse it, do not re-derive.
- **Redeclaration** — `cx.scope.has(localName)` at `from-ast.ts:3677` and
  `scope.has(name)` at `select.ts:5307`. Unchanged.
- **Genuinely dynamic object shapes** — a caller passing an object the JSDoc
  does not describe is the *reason* S2 aligns to legacy's `externref`;
  `__dyn_member_get` walks the proto chain and fires getters
  (`src/ir/effects.ts:173-174`), so a missing property yields `undefined`, not a
  trap. That is the correct JS semantics and matches what legacy already emits.
- **Cyclic / method-carrying / callable shapes** — `objectIrTypeFromTsType`
  already rejects these (`src/codegen/index.ts:1353-1358`, `:1367-1372`, and the
  `#4019` path set). S1's union arm must run *before* recursing so a
  `Node | null` self-reference resolves to `externref` rather than re-entering
  the cycle guard.
- **`fast` mode** — see the S1 table. `$$shapeBrand` and the `$AnyString`
  carrier make fast-mode struct parity a separate proof. If it does not fall
  out, gate S1 on `!ctx.fast` and say so; a mode-split acceptance is honest,
  a silent fast-mode demote is not.

### Test plan

**Existing, must stay green**

- `tests/issue-3656.test.ts` — 2 tests, currently passing. Both assert
  `irPostClaimErrors` has no `build`-kind entry. Note this assertion is weaker
  than it looks: case B demotes at `resolve`, which the map at
  `scripts/check-ir-fallbacks.ts:350` folds elsewhere and which this predicate
  does not catch. **Strengthen it to assert on `irCompiledFuncs`** once S1+S2
  land — that is the only assertion that distinguishes "IR claimed it" from
  "legacy silently did it".
- `pnpm run check:ir-fallbacks` — must stay `OK`; expect **no baseline diff**
  (see above). A diff here means the change reached the TS corpus, which is a
  signal to re-read, not to `--update`.
- `tests/equivalence.test.ts` — S2 touches `declarations.ts:957`, the shared
  legacy param-type path. This is the blast-radius test.

**New**

- Extend `tests/issue-3656.test.ts` (same file — the shapes are the issue's own
  population, and a second file would fragment it):
  - `{ replacedBy: string | null }` **without** destructuring (case N) — the
    S1-only win; assert `irCompiledFuncs` contains the function.
  - JSDoc typedef, no union, destructured (case C) — the S2 regression pin;
    assert no `abi-signature-parity` message.
  - untyped `function f({ a }) { return a; }` (move-only) — the S3 arm, the one
    dynamic-destructure body the current move-only scan admits.
  - runtime values for each, matched against Node, for omitted / string / `null`
    — the issue's existing three-arm discipline.
- `tests/` fast-mode twin of the S1 case (`fast: true`) — asserts either a claim
  or an explicit documented demote, never a silent one.
- Struct-convergence unit test next to the existing IR integration tests:
  compile a module where legacy registers `{a: string|null}` and the IR also
  needs it; assert a **single** `__anon_N` in the WAT. This is the S1 layout
  contract and the cheapest possible guard against the fast-mode trap.

Scratch probes used for this plan are in `.tmp/probe-3656{,b,c,d,e,f,g,h,i}.mjs`
(gitignored); re-run them to re-establish the matrix after any slice.

### Risk

The one thing that can turn a demote into a miscompile is S1 picking a field
ValType that differs from legacy's while still hashing equal, or equal while
hashing differently. `legacyFieldsHashKey` keys on `kind` plus `typeIdx`
(`src/ir/integration.ts:6937-6952`), so `externref` vs `ref_null $AnyValue`
hash differently and produce two structs that both look fine in isolation. The
struct-convergence test above is the guard; the `abi-signature-parity` check is
the backstop. Everything else in S1–S3 fails safe to legacy.
