---
id: 2859
title: "IR: drive param-type-not-resolvable fallback bucket to zero (TypeMap propagation)"
status: done
sprint: current
created: 2026-06-30
updated: 2026-07-02
completed: 2026-07-02
assignee: ttraenkler/dev-2912f
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: feature
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
parent: 2855
related: [1376]
---

# #2859 — IR: `param-type-not-resolvable` → 0

Child of the IR front-end migration epic **#2855**. Smallest unintended bucket —
a good tail-filler slice.

## Problem

`param-type-not-resolvable` is raised when the IR selector cannot resolve a
parameter's Wasm type from the source annotation + TypeMap propagation
(`src/ir/select.ts:81`), so the function demotes to legacy. Per
`plan/log/ir-adoption.md`, the row promotes when "TypeMap propagation reaches the
param."

## Live snapshot (verified `origin/main` @ dc29fd081, 2026-06-30)

`pnpm run check:ir-fallbacks -- --verbose` → **`param-type-not-resolvable: 1`**,
in `website/playground/examples/benchmarks/helpers.ts` (the same file also shows
`body-shape-rejected: 1` and `call-graph-closure: 1` — but those are distinct
functions/causes; this issue scopes only the single param-type rejection).

## Approach

1. Identify the one function in `benchmarks/helpers.ts` whose parameter type the
   selector cannot resolve (extend the diagnostic from #2856 to print the
   function name + unresolved param, or add a temporary trace in
   `whyNotIrClaimable`).
2. Determine whether the fix is (a) better TypeMap propagation reaching that
   param, or (b) a missing annotation-resolution case in the selector's type
   resolver. Implement the minimal fix.
3. Re-run the gate; `pnpm run check:ir-fallbacks -- --update-on-decrease`.
4. At `param-type-not-resolvable: 0`, add `"param-type-not-resolvable"` to
   `STRICT_IR_REASONS` (`src/codegen/index.ts:1013`). Consider bundling the
   strict-promotion of the related `return-type-not-resolvable` and
   `type-resolution-failure` reasons (already at zero) in the same PR, since they
   share the TypeMap-propagation root cause.

## Acceptance criteria

1. `param-type-not-resolvable` count in `scripts/ir-fallback-baseline.json` is `0`.
2. The previously-rejected `helpers.ts` function is IR-claimed (verify via the
   gate / `irReport`).
3. `"param-type-not-resolvable"` added to `STRICT_IR_REASONS` once the bucket is
   zero.
4. No regression in `tests/ir-*.test.ts` or test262 conformance.

## Files

- `src/ir/select.ts` — param type resolution in `whyNotIrClaimable`.
- (possibly) the TypeMap propagation source feeding the selector.
- `scripts/ir-fallback-baseline.json` — ratchet down.
- `src/codegen/index.ts:1013` — `STRICT_IR_REASONS` once at zero.

## Resolution (2026-07-02, dev-2912f)

**Root cause** (per-function probe on `helpers.ts`): the rejection was
`addBenchCard`'s `fn: () => number` param — `resolveParamType` had no
`FunctionTypeNode` arm, so ANY callback-taking function demoted. Not a TypeMap
propagation gap (option a); a missing annotation-resolution case (option b).

**Fix — function-typed params lower to `IrType.closure`:**

- `src/ir/select.ts`: new exported `irClosureSignatureFromFunctionTypeNode` —
  builds an `IrClosureSignature` from a function-type annotation when params +
  return are all primitive (the slice-3 closure-literal surface; identical
  primitive mapping to `typeNodeToIr` so `irTypeEquals` holds between a param's
  declared type and a closure-literal argument's signature). `resolveParamType`
  accepts FunctionTypeNode via the helper (new `"closure"` ResolvedKind);
  inexpressible signatures (non-primitive types, void return, rest/optional/
  default params, generics) keep the honest rejection.
- `src/ir/select.ts` `collectLocalClosureBindings`: calls through a
  closure-typed param are intra-function closure dispatch, not `external-call`
  (previously `fn()` marked the caller external and killed the claim).
- `src/codegen/index.ts` `resolvePositionType`: FunctionTypeNode arm using the
  SAME helper, so the override map / `calleeTypes` signatures agree with the
  lowerer. Existing `lowerClosureCall` / `emitClosureCall` machinery handles
  the call — params enter scope as `{kind: "local", type: closure}` and
  dispatch exactly like slice-3 closure locals. No lower.ts changes needed.

**Corpus effect** (`check:ir-fallbacks`): `param-type-not-resolvable` **1 → 0**;
`addBenchCard` progresses past the param gate and now attributes honestly to
`body-shape-rejected` (+1, 31 → 32 — its `addEventListener` arrow body is
#2856's scope; a claim additionally needs `bcrd` via #2858). Total unintended
unchanged at 45; baseline refreshed via `--update` (the bucket-attribution
move is intentional). No post-claim demotions.

### STRICT promotion deferred (acceptance criterion 3) — deliberate

`STRICT_IR_REASONS` hard-errors a listed reason in **every compilation**
(`src/codegen/index.ts:1455-1464`), not just the corpus gate. Verified
empirically that common shapes still legitimately produce
`param-type-not-resolvable`:

- unannotated polymorphic param (plain JS): `function poly(x): number {...}`
  called with number + string → lattice not concrete → this reason;
- union-annotated param: `function pick(x: string | number)` → this reason.

Promoting it would turn those legacy fallbacks into hard compile errors
(mass test262/user breakage — violates criterion 4). Zero-in-corpus ≠
structurally-zero: the reason remains the honest selector verdict for
not-yet-expressible param types. STRICT promotion needs `resolveParamType`
totality (union/generic/etc. handling) first — same reasoning applies to
bundling `return-type-not-resolvable`/`type-resolution-failure` (the latter is
the #1921 resolve-fallback channel, explicitly warning-severity by design).

## Test Results

- `tests/issue-2859.test.ts` — 8/8 green: selector claims + end-to-end
  execution (zero-arg, one-arg, string/boolean signatures, param forwarding
  closure→closure), helpers.ts shape no longer param-type-rejected,
  inexpressible/void signatures stay rejected, signature-helper unit cases.
- `check:ir-fallbacks`: param-type 0, gate OK against refreshed baseline; no
  post-claim demotions.
- `tests/ir/**`: 121 passed; the 8 failures in `passes.test.ts` (#1167a) /
  `inline-small.test.ts` (#1167b) are PRE-EXISTING on origin/main (verified
  identical on a pristine main worktree — `__unbox_number` import harness +
  post-inline duplicate-SSA verify; not in the CI quality suite).
- Adjacent suites green: `issue-2923` (dynamic dispatch), `issue-1382`
  (closure bridge), `ir-vec-two-backend`. `tsc --noEmit` clean.
