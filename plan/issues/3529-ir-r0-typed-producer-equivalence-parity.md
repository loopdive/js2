---
id: 3529
title: "IR R0 prerequisite: typed producer equivalence parity"
status: done
sprint: 74
created: 2026-07-21
updated: 2026-07-21
completed: 2026-07-21
priority: critical
horizon: l
complexity: L
feasibility: hard
reasoning_effort: max
task_type: bug
area: ir, codegen, compiler
language_feature: compiler-internals
es_edition: n/a
goal: ir-full-coverage
lane: ir-retirement-r0-producer-parity
model: gpt-5.6-sol
parent: 3518
depends_on: [3143]
required_by: [3519]
related: [2855, 2949, 3053, 3090, 3341]
origin: "#3519 full-equivalence audit: strict typed outcome classification exposed 154 previously demoted compile failures"
loc-budget-allow:
  - src/ir/outcomes.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/backend/linear-integration.ts
  - src/ir/module-bindings.ts
  - src/ir/backend/legality.ts
  - src/ir/passes/tagged-unions.ts
  - src/ir/passes/tagged-union-types.ts
  - src/ir/verify.ts
  - src/codegen/index.ts
  - src/codegen/stdlib-selfhost.ts
files:
  - src/ir/outcomes.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/backend/linear-integration.ts
  - src/ir/module-bindings.ts
  - src/ir/backend/legality.ts
  - src/ir/passes/tagged-unions.ts
  - src/ir/passes/tagged-union-types.ts
  - src/ir/verify.ts
  - src/codegen/index.ts
  - src/codegen/stdlib-selfhost.ts
  - tests/equivalence/helpers.ts
  - tests/issue-3529-producer-contract.test.ts
  - tests/issue-3529-selector-preclaim.test.ts
  - tests/issue-3529-dataflow-outcomes.test.ts
  - tests/issue-3529-tagged-union-dynamic.test.ts
  - tests/issue-3529-integration-preflight.test.ts
  - tests/issue-3529-result-errors.test.ts
  - tests/issue-3529-ir-producer-parity.test.ts
---

# #3529 — IR R0 prerequisite: typed producer equivalence parity

## Objective

Restore the full equivalence suite to its committed baseline after #3519 made
unknown post-claim throws honest `Invariant` outcomes. Keep that strict rule:
an untyped/unknown throw remains `invariant/unexpected-internal-throw` in both
hybrid and IR-only policy. Recover parity by making selector-reachable
capability exits explicit, typed, and source-shape aware, while fixing the
genuine producer/pass invariants.

This is a prerequisite to accepting #3519. It does **not** weaken the typed
outcome contract, add 154 failures to the equivalence baseline, or claim that
IR-only is ready. Hybrid compilation must again preserve the legacy result for
known capability gaps; strict IR-only must remain red on the same gaps, now as
stable typed `Unsupported` blockers rather than generic invariants.

## Initial measured evidence

Full `tests/equivalence/` on the #3519 implementation merged with the latest
`origin/main` produced:

| Signal                   |  Result |
| ------------------------ | ------: |
| Passing tests            |   1,453 |
| Failing tests            |     190 |
| Committed known failures |      36 |
| **New failures**         | **154** |

All 154 are compilation regressions exposed by the stricter producer boundary;
none is a new runtime-semantic failure:

- **139** directly reported, known capability gaps;
- **13** genuine compiler/pass invariants that must be fixed;
- **2** additional capability gaps hidden by tests that asserted only
  `CompileResult.success` and did not print `result.errors`.

The two assertion-hidden cases are:

1. `tests/equivalence/externref-array-destructuring.test.ts` — the existing
   array-destructuring source `const [a, b, c] = [1, 2, 3];` reaches an
   externref/heterogeneous widening sink that is not yet an IR capability.
2. `tests/equivalence/global-index-shift-trycatch.test.ts` — the source
   `const msg = "val:" + (1 > 0);` reaches the boolean-to-string concat gap
   inside the try/catch/global-index scenario.

Those tests therefore had to include the fatal `result.errors` text in their
assertion diagnostic. A future failure may not be reported only as “expected
true, got false.”

### Directly surfaced structural census (152)

| Cluster                                           | New failures | Required disposition                                                                 |
| ------------------------------------------------- | -----------: | ------------------------------------------------------------------------------------ |
| String methods                                    |           22 | Syntax/checker-known preclaim or typed residual capability exit                      |
| Logical `&&` / `\|\|` value shapes                |           18 | Preclaim unsupported result/coercion shapes                                          |
| Array methods                                     |           17 | Checker-owned Array method capability preclaim                                       |
| `Error` / `TypeError` / `RangeError` constructors |           10 | Constructor identity/target preclaim                                                 |
| Dynamic box/tagged-union pass bug                 |            9 | **Fix invariant**: builder and verifier allow `dynamic`; the pass wrongly rejects it |
| Class projection/member access                    |            9 | Class/member shape preclaim; repair only proven projection bugs                      |
| Call/constructor/nested resolution and arity      |            9 | Resolve/arity preflight before claim                                                 |
| Template coercion                                 |            6 | Template substitution capability preclaim                                            |
| Mixed string equality                             |            6 | Typed dataflow/type-evidence Unsupported when not preclaimable                       |
| Dynamic/mixed `+`                                 |            6 | Typed dataflow/type-evidence Unsupported                                             |
| Unary coercion                                    |            6 | Typed dataflow/type-evidence Unsupported                                             |
| Null/undefined shapes                             |            6 | Typed dataflow/type-evidence Unsupported                                             |
| Typed-array constructors                          |            5 | Target-capability constructor preclaim                                               |
| Binary coercion                                   |            5 | Typed dataflow/type-evidence Unsupported                                             |
| String `+=` evidence                              |            4 | Evidence-aware preclaim or typed residual Unsupported                                |
| Ref property write                                |            3 | Typed dataflow/type-evidence Unsupported                                             |
| Numeric primitive methods                         |            3 | Checker-known method preclaim                                                        |
| `Function.call` / `Function.apply`                |            2 | Callable identity/arity preclaim                                                     |
| Array widening                                    |            2 | Typed dataflow/type-evidence Unsupported                                             |
| Mutation prepass miss                             |            2 | **Fix invariant**; the selector/prepass promise was wrong                            |
| Raw internal `TypeError`                          |            2 | **Fix invariant**; do not translate JavaScript implementation errors to Unsupported  |

The invariant population is exactly the 9 tagged-union pass failures, 2
mutation-prepass misses, and 2 raw internal `TypeError`s. The 139 other direct
failures are capability decisions. With the two assertion-hidden capability
cases, the total classification is **141 capability gaps + 13 invariants =
154**.

## Final validation (2026-07-21)

Producer parity is restored without weakening the typed boundary or expanding
the committed equivalence baseline:

| Signal                                      | Result |
| ------------------------------------------- | -----: |
| Passing tests                               |  1,608 |
| Failing tests                               |     35 |
| Committed known failures                    |     36 |
| Baseline-known cases that now pass          |      1 |
| New regressions                             |      0 |
| `scripts/equivalence-baseline.json` changes |      0 |

The final #3519 hybrid gate is green across 5/5 entries and 37 terminal units:
31 emitted IR bodies, 6 typed Unsupported outcomes, 0 Invariants, and 37
legacy-emitted bodies. The six Unsupported outcomes are async (2), call-graph
closure (1), body shape (1), and static class members (2). Strict IR-only is
intentionally red on those six typed capability blockers and on the 37 legacy
bodies; no generic invariant is being silently demoted.

## Original error contract and sample sources

Before remediation, direct cases terminated with a fatal outcome shaped as
`invariant/<stage>/unexpected-internal-throw`; the compile diagnostic is
rendered as:

```text
IR path failed for <unit>: <producer detail> [IR-FALLBACK]
```

That signature is evidence that the boundary is honest, not the desired final
classification for known source capabilities. Representative existing sources
that must be pinned at their producer seam include:

| Cluster                  | Existing sample and exact source quote                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| String methods           | `tests/equivalence/string-methods.test.ts`: `return "  hello  ".trim();`                                                            |
| Logical values           | `tests/equivalence/logical-operators.test.ts`: `return 0 \|\| 42;` and `return 1 && 42;`                                            |
| Array methods            | `tests/equivalence/array-prototype-methods.test.ts`: `return arr.indexOf(2);` and `arr.forEach(function(x: number) { sum += x; });` |
| Error constructors       | `tests/equivalence/ir-slice10-error.test.ts`: `const e = new TypeError("bad type");`                                                |
| Class projection         | `tests/equivalence/ir-slice4-classes.test.ts`: `return p.sum();` after `const p = new Point(3, 4);`                                 |
| Call arity               | `tests/equivalence/function-arity-mismatch.test.ts`: `return f(5);` for a two-parameter `f`                                         |
| Template coercion        | `tests/equivalence/template-literal-type-coercion.test.ts`: retain a non-string substitution case from that file                    |
| Mixed equality           | `tests/equivalence/equality-mixed-types.test.ts`: `return (true == obj) ? 1 : 0;`                                                   |
| Unary coercion           | `tests/equivalence/unary-plus-coercion-185.test.ts`: `return +undefined;`                                                           |
| Null narrowing           | `tests/equivalence/null-narrowing.test.ts`: `if (p !== null) { return p.x + p.y; }`                                                 |
| Typed-array constructors | `tests/equivalence/ir-slice10-typed-array.test.ts`: `const a = new Uint8Array(8);`                                                  |
| Function call/apply      | `tests/equivalence/arrow-call-apply.test.ts`: `return add.call(null, 10, 20);`                                                      |
| Ref property write       | `tests/equivalence/compound-assignment-property.test.ts`: `obj.x += 5;`                                                             |
| Hidden widening          | `tests/equivalence/externref-array-destructuring.test.ts`: `const [a, b, c] = [1, 2, 3];`                                           |
| Hidden boolean concat    | `tests/equivalence/global-index-shift-trycatch.test.ts`: `const msg = "val:" + (1 > 0);`                                            |

Focused #3529 tests must assert the terminal `kind`, `stage`, and stable `code`
and must also assert hybrid/IR-only policy behavior. Matching the prose detail
above is forbidden; human-readable messages are diagnostic payload only.

## Classification contract

### 1. Preclaim shapes known from syntax/checker evidence

Extend the selector/preparation preflight for shapes whose unsupported status
is knowable before body construction:

- method identity and receiver family for String, Array, numeric primitives,
  and `Function.call` / `Function.apply`;
- constructor identity, target, and arity for Error-family, TypedArray, and
  Date construction;
- logical value/result families, template substitutions, direct/nested call
  arity, constructor resolution, and class projection/member availability;
- backend capability checks that are stable before lower/emit.

These exits use existing selector reason codes where they are exact. Add a new
closed code only when no existing reason expresses the capability. The
selector must remain checker-aware so a user-defined class method named
`trim`, `map`, `call`, or `apply` is not mistaken for an ambient builtin.

Date support is target-dependent: preclaim only the target/constructor shapes
the backend can actually lower. Do not let an ambient `Date` symbol imply
universal backend capability.

### 2. Explicit Unsupported only for residual capability evidence

Some gaps become knowable only after type/dataflow resolution. At those narrow
producer sites, throw `IrUnsupportedError` with a stable code for the exact
capability:

- mixed string equality and dynamic/mixed addition;
- unary/binary coercion evidence that cannot be lowered;
- null/undefined carrier shapes;
- string `+=`, array widening, and ref-property writes whose resolved storage
  type is unsupported;
- narrowly certified module-init destructuring/no-global cases.

Do not wrap a whole builder, pass, or integration phase in a broad catch that
turns arbitrary failures into Unsupported. Unknown throws must still reach
`classifyIrFailure` as `Invariant`.

### 3. Fix true invariants

- **Dynamic box/tagged union (9):** `src/ir/from-ast.ts` and
  `src/ir/verify.ts` intentionally permit `box { toType: dynamic }` and
  dynamic tag operations. `src/ir/passes/tagged-unions.ts` currently applies
  the V1 union-registry rejection to that legal dynamic form. Make the pass
  agree with the builder/verifier contract; do not demote the validation error.
- **Mutation prepass (2):** fix the missed mutable binding/slot evidence so a
  selector promise cannot reach an impossible SSA/local state.
- **Raw internal TypeError (2):** fix the invalid internal access/call. Preserve
  it as an Invariant until the producer is corrected; do not catch by
  `instanceof TypeError` and relabel it.

Mutation misses, raw implementation `TypeError`s, helper preregistration
failures, malformed/pass-invalid IR, verifier errors, missing helper ownership,
and assertion failures remain Invariants in both policies.

### 4. Resolve and backend-legality preflight

Move predictable capability decisions ahead of lower/emit:

- resolve exact local/nested/imported/class/constructor identities and arity
  before claiming the unit;
- ask `src/ir/backend/legality.ts` (or an equivalent target capability query)
  before selecting target-specific constructs;
- keep a late legality failure an Invariant when the preflight promised the
  backend could accept the IR;
- classify only the narrow module-init destructuring/no-global shapes as typed
  Unsupported; missing bindings, ABI divergence, and impossible module plans
  remain Invariants.

## Throw-site boundary

The main IR preparation seams contain **454 throw statements**, of which
**435** are generic `Error`. This issue does not authorize a mechanical
`Error` → `IrUnsupportedError` rewrite. Each converted site needs all of:

1. a valid-source capability fixture;
2. an exact stable code and stage;
3. evidence that the condition is expected for that source/target shape;
4. a paired malformed/internal fixture proving nearby unknown failures remain
   Invariant;
5. no message matching and no broad catch/reclassification.

Unclassified sites retain strict unknown-throw-to-Invariant behavior.

## Bounded landing slices and ownership locks

At most three implementers run concurrently. One implementer owns each core
file for the life of a slice; later slices rebase after the earlier owner lands.
New focused test files are unique to their slice.

| Slice                           | Scope                                                                                                                     | Exclusive files                                                                                                                                                                              | Exit evidence                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| P0 — outcome codes              | Allocate the minimal closed Unsupported codes and contract tests; no producer behavior                                    | `src/ir/outcomes.ts`, `tests/issue-3529-producer-contract.test.ts`                                                                                                                           | Codes are exhaustive; unknown Error and raw TypeError remain Invariant                                                       |
| P1 — preclaim                   | String/Array/numeric/Function methods; logical/template; Error/TypedArray/Date constructors; call/ctor/arity/class shapes | `src/ir/select.ts`, `tests/issue-3529-selector-preclaim.test.ts`                                                                                                                             | Every syntax/checker-known cluster rejects before build with exact reason; shadowed/user methods remain claimable when valid |
| P2 — residual producer evidence | Mixed equality/addition, coercions, nullish, string `+=`, widening, ref writes; mutation-prepass fix                      | `src/ir/from-ast.ts`, `tests/issue-3529-dataflow-outcomes.test.ts`                                                                                                                           | Narrow typed Unsupported only at evidence sites; mutation misses fixed and nearby malformed states stay Invariant            |
| P3 — dynamic pass invariant     | Make tagged-union pass accept the dynamic form already accepted by builder/verifier                                       | `src/ir/passes/tagged-unions.ts`, `src/ir/passes/tagged-union-types.ts`, `src/ir/verify.ts`, `tests/issue-3529-tagged-union-dynamic.test.ts`                                                 | All 9 dynamic-box regressions compile; malformed union/dynamic IR still fails verifier/pass as Invariant                     |
| P4 — integration preflight      | Resolve/backend capability, narrow module-init Unsupported, helper/ABI invariant preservation                             | `src/ir/integration.ts`, `src/ir/module-bindings.ts`, `src/ir/backend/legality.ts`, `src/codegen/index.ts`, `tests/issue-3529-integration-preflight.test.ts`                                 | Predictable target gaps are decided before emit; late legality/helper/ABI faults remain Invariant                            |
| P5 — diagnostic visibility      | Make assertion failures include fatal `result.errors`; pin the two hidden capability cases                                | `tests/equivalence/helpers.ts`, `tests/equivalence/externref-array-destructuring.test.ts`, `tests/equivalence/global-index-shift-trycatch.test.ts`, `tests/issue-3529-result-errors.test.ts` | Both formerly opaque tests print the typed fatal diagnostic on failure                                                       |

P0 lands first. P1, P3, and P5 may then run in parallel. P2 starts only after
P0 and must not edit `select.ts`; P4 starts after P0 and must not edit
`from-ast.ts`. If a slice discovers that it needs another slice's locked file,
record the handoff and defer that edit to the owner; do not overlap the file.

The final integrator owns only reconciliation, the full-equivalence run, and
the #3519 hybrid/strict gate evidence. Scope growth into new language support is
rejected unless it is smaller and safer than the required typed capability
exit and remains within that slice's locked files.

## Acceptance criteria

- [x] Unknown/untyped throws still classify as
      `invariant/unexpected-internal-throw`; Invariants fail hybrid and IR-only.
- [x] Every syntax/checker-known method, constructor, logical, template,
      call/arity, class-projection, Date, and target-capability gap in the census
      exits at preclaim with a stable typed reason.
- [x] `IrUnsupportedError` is used only at narrow dataflow/type-evidence
      residual capability sites; no broad catch or message-based policy exists.
- [x] The 9 legal dynamic box/tagged-union programs pass after the pass agrees
      with the builder/verifier contract; invalid tagged-union IR remains an
      Invariant.
- [x] Both mutation-prepass misses and both raw internal TypeErrors are fixed,
      not reclassified. Helper preregistration, malformed/pass-invalid IR,
      verifier/backend promise violations, ABI/slot failures, and assertion
      failures remain Invariants.
- [x] Narrow module-init destructuring/no-global and unsupported Date target
      shapes are typed Unsupported; missing bindings/ABI and late legality
      contradictions stay Invariant.
- [x] Focused seam tests cover every census cluster and assert kind/stage/code
      plus hybrid/IR-only policy, including a neighboring invariant fixture.
- [x] Assertion diagnostics include fatal `result.errors`; the externref
      array-destructuring and try/catch boolean-concat cases are no longer
      opaque `success` mismatches.
- [x] Full equivalence returns to the committed **36-known-failure baseline**:
      **zero new failures**, with one baseline-known case now passing and no
      change to `scripts/equivalence-baseline.json`.
- [x] #3519's hybrid gate is green with zero Invariants/unaccounted units; its
      strict gate remains red on explicit typed Unsupported blockers and the
      independently reported legacy-emitted bodies.
- [x] Cross-backend, typecheck, lint, format, issue integrity, and existing IR
      outcome tests remain green.

## Implementation Summary

- **What was done:** classified the 141 capability gaps at checker-aware
  preclaim or narrow typed producer sites, repaired all 13 genuine producer/
  pass invariants, and made the two formerly opaque equivalence assertions
  include fatal compiler diagnostics. A merge-queue differential then exposed
  one missed producer seam: inferred mutually recursive boolean returns lost
  their i32 boolean brand before an `externref` console boundary. The IR now
  retains that brand and emits the canonical `__box_boolean` call when the
  host lane owns it; native/self-host lanes explicitly decline the capability.
- **What worked:** unknown throws stayed fatal Invariants, while stable typed
  Unsupported reasons preserved hybrid behavior for known capability gaps.
  The nine legal dynamic-box/tagged-union cases, two mutation-prepass misses,
  and two raw internal TypeErrors were fixed at their owning seams.
- **What did not work:** the initial strict boundary produced 154 new compile
  failures, and early partial slices still left 111. Rebaselining and broad
  error reclassification were rejected; the remaining sites were handled with
  source-shape evidence or repaired as invariants.
- **Files changed:** the outcome codes, selector and AST producer, tagged-union
  and verifier passes, integration/module/backend preflights, result diagnostic
  helpers, and focused producer/equivalence tests listed in the frontmatter.
- **Tests:** full equivalence is 1,608 passing / 35 failing against 36 committed
  known failures, with one baseline-known case now passing, zero new
  regressions, and an unchanged baseline. The hybrid gate is green with 0
  Invariants; strict remains intentionally red on the six typed Unsupported
  units and all 37 legacy-emitted bodies. The exact
  `tests/differential/corpus/closures/10-mutual.js` probe now compiles through
  IR and prints `true\ntrue`; the #2788, #2795, and #3529 focused suites pin
  valid Wasm, boolean identity, and an emitted `<module-init>` IR outcome.

## Required validation

```bash
pnpm exec vitest run tests/issue-3529-*.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
pnpm exec vitest run tests/issue-3519-ir-outcomes.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
node scripts/equivalence-gate.mjs
pnpm run check:ir-only -- --policy=hybrid
pnpm run check:ir-only -- --policy=ir-only --json  # expected non-zero on typed Unsupported and legacy bodies
pnpm exec vitest run tests/cross-backend-diff.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
pnpm run check:ir-fallbacks -- --verbose
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run check:issues
pnpm run check:issue-ids
```

The implementation report must include the full equivalence denominator and
delta, counts by typed outcome code/stage, all 13 repaired invariant cases, the
two formerly assertion-hidden diagnostics, hybrid-gate output, and the strict
typed blocker list. “The 154 failures were baselined” is an explicit rejection.
