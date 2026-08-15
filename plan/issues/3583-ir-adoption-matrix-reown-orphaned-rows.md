---
id: 3583
title: "IR adoption matrix: re-own the 28 orphaned mixed/direct-only rows (tracking issues closed or wont-fix)"
status: in-progress
sprint: current
created: 2026-07-24
updated: 2026-08-15
priority: medium
horizon: m
feasibility: medium
task_type: chore
area: ir
language_feature: compiler-internals
goal: ir-full-coverage
related: [1131, 2952, 2949, 3518, 3522, 1373b]
# (#3102) Both adoptions are one selector arm + one mirroring lowering arm, and
# both arms MUST live in the god-file that owns the dispatch they extend:
# `isPhase1Expr` / `isPhase1ForStatementInScope` in select.ts and `lowerExpr` /
# `lowerForStatement` in from-ast.ts. There is no subsystem module to move them
# to without splitting a single dispatch across two files, which is exactly the
# claim<->lowering parity hazard this issue exists to prevent. Growth is +22
# lines each, the majority of it the measured-evidence comments that record WHY
# the previous notes were wrong.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/select.ts
# (#3400) +13 lines in the 1029-line `isPhase1Expr` dispatch: a 6-line guard
# (four `ts.is*` predicates, prettier-expanded) plus the 5-line comment that
# records the measured evidence. Splitting a 1029-line kind-dispatch switch is
# #3399's job, not this issue's — and doing it here would put the selector arm
# in a different file from the `lowerExpr` arm it must stay in lockstep with.
func-budget-allow:
  - src/ir/select.ts::isPhase1Expr
origin: "2026-07-24 Fable IR-migration review (plan/agent-context/fable-ir-review-2026-07-24.md §3) — 28 of 34 non-ir-owned, non-deferred adoption-matrix rows have no live owning issue"
---

# #3583 — Re-own the orphaned IR adoption-matrix rows

## Problem

`plan/log/ir-adoption.md` is the source of truth for which AST node kinds the
IR owns, and every `mixed`/`direct-only` row is supposed to be a migration
TODO with a tracking issue. As of main @ `7652f0337` (2026-07-24), **28 of
the 34 non-ir-owned, non-deferred rows have no live owner**:

1. **13 rows track #1131 — which is `wont-fix`** (closed 2026-06-12 as the
   superseded middle-end SSA plan): `ExpressionStatement`, `ForStatement`,
   `ForOfStatement`, `TryStatement`, `NullKeyword`, `BinaryExpression`
   (`%`, `**`, `in`, `instanceof` all still throw), `PrefixUnaryExpression`,
   `ElementAccessExpression`, `ObjectLiteralExpression`, `SpreadElement`,
   `FunctionExpression`, `ArrowFunction`, `YieldExpression`.
2. **12 rows track issues that are `done`** while the row is still only
   `mixed`: `VariableStatement` (#1372), `ClassDeclaration` / `ThisKeyword` /
   `NewExpression` / `MethodDeclaration` (#1370), `TemplateExpression` /
   `PropertyAccessExpression` (#1374), `ArrayLiteralExpression` (#1804),
   `CallExpression` (#1371), `ConstructorDeclaration` /
   `GetAccessorDeclaration` / `SetAccessorDeclaration` (#3000).
3. **3 rows have no tracking reference at all**: `AsExpression` /
   `TypeAssertion`, `NonNullExpression` (both listed direct-only despite
   being type-erased pass-throughs — likely near-trivial adoptions),
   `EnumDeclaration` ("(future)").

Rows that DO have live owners and are NOT in scope here: `SwitchStatement` /
`LabeledStatement` / `ForInStatement` / `BreakStatement` /
`ContinueStatement` / `DoStatement` (#2952, ready), `AwaitExpression`
(#1373b, in-progress), `FunctionDeclaration` (#1376, the claim unit itself).

Why it matters: R9 of epic #3518 (the fail-closed IR-only flip) implicitly
requires every one of these rows to reach `ir-owned` or an _acceptable_
typed-Unsupported. Ownerless rows mean unscheduled critical-path work that
the corpus-zero ratchet cannot see (the playground corpus barely exercises
these shapes).

## Acceptance criteria

- [ ] Every `mixed`/`direct-only` row in `plan/log/ir-adoption.md` has a
      Tracking reference to an issue whose status is `ready`/`in-progress`/
      `blocked` (not `done`, not `wont-fix`), or is explicitly re-tagged
      `deferred` with a rationale.
- [ ] Class-family rows (`ClassDeclaration`, `MethodDeclaration`,
      `ConstructorDeclaration`, accessors, `ThisKeyword`, `NewExpression`)
      are re-homed under #3522 (R3) or a dedicated residual issue naming the
      remaining lowering gaps (computed/generator/abstract names, static
      super, subclass-of-builtin).
- [ ] The expression-lowering residue (group 1 above) is triaged into
      per-family owning issues (allocated via `claim-issue.mjs --allocate`)
      or folded into #2949/#2952 scope where the blocker genuinely overlaps.
- [ ] `AsExpression`/`TypeAssertion` and `NonNullExpression` get either a
      cheap adoption PR (pass-through in `from-ast.ts` — verify the selector
      currently rejects them at all) or a corrected matrix row if they are
      already transparently handled.
- [ ] `EnumDeclaration` gets an explicit decision: adopt (const-folding in
      IR) or `deferred` with rationale.
- [ ] `scripts/gen-ir-adoption.mjs` curated data updated; `pnpm run
    gen:ir-adoption` regenerated; `--check` green.

## Notes

- This is triage/ownership work first; actual lowering work should land as
  the newly-allocated child issues, sized separately.
- Cross-reference: the 2026-07-24 review also recommends #3518's R9 row gain
  an explicit "coverage closure" dependency so this class of gap cannot go
  unscheduled again.

## Implementation Plan (fable, 2026-08-15 — IR-path-only migration session)

Measure first, then triage, then cheap adoptions:

1. **Live-measure every non-ir-owned, non-deferred row.** For each, a minimal
   probe program through production `compile()` with `trackIrOutcomes`: does
   the shape claim? Which rejection reason if not? Bank the probe set in
   `.tmp/` and the results table in this issue.
2. **Correct the curated data** in `scripts/gen-ir-adoption.mjs`: fix stale
   Notes (measured, not assumed), promote rows measured fully claimed,
   regenerate (`pnpm run gen:ir-adoption`), keep `--check` green.
3. **Re-own tracking refs without new id allocation** (assignment-book writes
   are out of scope for this session): point rows at the live owning issue
   whose scope genuinely covers the residual — #2952 (control flow), #2949
   (dynamic-value/operand shapes), #3522 (class family), #1373b (await), #3518
   (epic) — or re-tag `deferred` with a rationale. Rows needing a NEW issue get
   listed in a TODO section here for the next allocation window.
4. **Implement the genuinely-cheap residuals found by step 1**, each with
   selector arm + from-ast lowering + claim-backed test + negative boundary and
   a same-PR matrix row update. Skip anything non-trivial; file it in step 3.

> **Note on the plan's own premise.** The dispatch brief for this session
> asserted that `AsExpression`/`NonNullExpression`/`TypeAssertion` already had
> transparent pass-through arms at `from-ast.ts:7390` and `select.ts:5744,6125`,
> so the row was merely stale. **Measurement disproved that** — see the first
> subsection of the Implementation Notes below. It is recorded here rather than
> quietly corrected because the plan's step 1 (measure before triaging) is
> exactly what caught it.

## Implementation Notes (2026-08-15, fable — IR-path-only migration session)

### The issue's own premise was wrong, and measurement is why we know

The brief asserted that `AsExpression` / `NonNullExpression` / `TypeAssertion`
"have transparent pass-through arms in BOTH `from-ast.ts` (:7390) and
`select.ts` (:5744, :6125)", so the matrix row was merely stale. **That is not
what the code does.** Every one of those three cited sites is a *helper-local*
unwrapper serving one specific analysis:

| Site               | Function                      | What it actually does                                      |
| ------------------ | ----------------------------- | ---------------------------------------------------------- |
| `select.ts:5744`   | `expressionIsProvenNumber`    | unwraps while proving an expression is numeric             |
| `select.ts:6125`   | `unwrapProjectionExpression`  | unwraps while resolving a class/computed-member projection |
| `from-ast.ts:7390` | `immutableLiteralStringValue` | unwraps while constant-folding a string literal            |

None is the general shape gate (`isPhase1Expr`) or the general lowering
dispatcher (`lowerExpr`). Measured: **all five `as` variants, `<T>x` and `x!`
rejected at `expr-unhandled`** — i.e. the matrix's `direct-only` label was
*correct* and the brief's "already transparent" assumption was the stale thing.
Had this been triaged by reading rather than measuring, the row would have been
"corrected" to `ir-owned` while the selector still rejected every instance — a
matrix that lies in the *opposite* direction, strictly worse than the drift it
replaced.

The same measurement flipped several rows the other way: `%` and `instanceof`
are lowered though the note said they throw; `~` is lowered though the note said
"partial"; named function expressions claim (including self-recursive ones);
`try`/`finally` claims while `try` + `return` does not — the exact inverse of the
note. Drift ran in **both** directions.

### The single cross-cutting finding: union-typed operands, not the features

Six rows (`NullKeyword`, `BinaryExpression ??`, `NonNullExpression`,
`PropertyAccessExpression ?.`, `CallExpression ?.()`, and the `!== null` local
form) all rejected — and they all reject for the **same** reason, which is none
of those features. The control probe settles it:

```ts
export function probe(x: string): number {
  const y: string | null = x; // no ??, no !, no ?., no null comparison
  return 1;
}
```

still rejects at `vardecl-typenode:UnionType`; a `string | null` **param**
rejects at `param-type-not-resolvable`. **A union-typed value is unrepresentable
in either position**, so every "optional/nullish feature is partial" note in the
matrix was attributing one root cause to six different features. All six rows are
now re-owned to **#2949** (dynamic/union value representation), the actual
unblocker. This is the highest-leverage item the measurement found.

### Triage decisions — WHY each row went where

| Destination                                          | Rows                                                                                                                                  | Why                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#2949** (ready) — dynamic/union value repr.        | `NullKeyword`, `BinaryExpression`, `ElementAccessExpression`, `CallExpression`, `PropertyAccessExpression`, `EnumDeclaration`          | All gated by a value-representation limit: union-typed operands (above), a `Record<string,…>` receiver at `type-resolution-unsupported`, or an unrepresentable module binding. Measured proof for the enum row: `enum E { A = 1 }; E.A` rejects at `expr-ident-not-in-scope`, and a plain `const E = { A: 1 }` module object rejects at `expr-module-storage-unrepresentable` — the *same* gate. An enum is just one more unrepresentable module binding. |
| **#2952** (ready) — multi-exit control flow          | `ForStatement`, `TryStatement`                                                                                                        | Both residuals are provably *tail-position control flow*: `for (;;) { … return }` and `try { … return }` reject at `tail-unhandled`, while every non-returning form of both claims. #2952's subject matter exactly.                                                                                                                                                                                                    |
| **#3522** (in-progress) — R3 classes/closures        | `ClassDeclaration`, `ThisKeyword`, `MethodDeclaration`, `GetAccessor`, `SetAccessor`, `FunctionExpression`, `ArrowFunction`            | The class family per the acceptance criteria, plus the two closure rows (R3 explicitly covers closures). Their previous owners #1370 / #3000 are both `done`.                                                                                                                                                                                                                                                          |
| **#1373b** (in-progress)                             | `AwaitExpression`                                                                                                                     | Previous owner #1373 is `done`; #1373b is the live CPS-lowering workstream.                                                                                                                                                                                                                                                                                                                                            |
| **#3518** (in-progress) — the IR-only epic           | `ExpressionStatement`, `ForOfStatement`, `TemplateExpression`, `PrefixUnaryExpression`, `ObjectLiteralExpression`, `ArrayLiteralExpression`, `SpreadElement`, `YieldExpression` | Real residuals belonging to no *existing* narrower issue. Parked on the epic **as an interim owner** rather than invented into a fake one — each is itemised in the TODO list below. Assignment-book writes were out of scope, so no ids were allocated.                                                                                                                                                                 |
| **`ir-owned`**                                       | `AsExpression`/`TypeAssertion`, `NonNullExpression`                                                                                   | Adopted this session (below).                                                                                                                                                                                                                                                                                                                                                                                          |

No row was re-tagged `deferred`. Every candidate turned out to be
adoptable-but-blocked rather than out-of-scope-by-design — `EnumDeclaration`
most notably, where the acceptance criteria demanded an explicit adopt-or-defer
call and the measurement supports **adopt, blocked on #2949**.

### Adoptions landed

**1. Type-erased assertion wrappers → `ir-owned`.** One arm in `isPhase1Expr`
(`select.ts`) and the mirroring arm in `lowerExpr` (`from-ast.ts`), covering
`as` / `<T>x` / `satisfies` / `!`. These emit nothing at runtime, so the
claimable shape *is* the operand's shape and the lowering *is* the operand's
lowering under the same hint — the hint comes from the consuming context
(declared type / param ABI / return ABI), which is what decides the value
representation, so the asserted type cannot change the emitted bytes. Selector
claim ⇔ lowering parity by construction: both arms delegate to the identical
recursion, so there is no claim-then-demote window. The negative tests confirm
the delegation is real rather than a swallow — `(x ** 2) as number` still
rejects, because the *operand* still rejects.

**2. Bare `for (;;)` → claimed.** The `for-missing-cond` reject was a slice-12
lowering gap, not a semantic one: an omitted condition is exactly `for (; true; )`
per the spec, and the constant-true form was **already** claimed and lowered.
`lowerForStatement` now emits the `true` constant straight into the cond buffer.
It deliberately does **not** synthesize a `ts.factory.createTrue()` node — a
parentless synthetic node has no checker identity, and the downstream cond
helpers (`coerceLoopCondToBool`, the string-encoding loop scope) are
AST-position-sensitive. The test asserts the resulting binary is
**byte-identical** to the `for (; true; )` program, the strongest available
statement that this adoption introduces no new lowering path at all.

### Side finding — a pre-existing LEGACY bug, surfaced not caused

While equivalence-checking the assertion adoption, legacy direct codegen turned
out to mis-compile two of the four forms (`.tmp/probe-assert-runtime.ts`):

| source (`x = 41`)                  | legacy | IR  | correct |
| ---------------------------------- | ------ | --- | ------- |
| `return <number>x;`                | **0**  | 41  | 41      |
| `return (<number>x) + 1;`          | **1**  | 42  | 42      |
| `return (x satisfies number) + 1;` | **1**  | 42  | 42      |
| `return (x as number) + 1;`        | 42     | 42  | 42      |
| `return x! + 1;`                   | 42     | 42  | 42      |

Legacy evaluates the assertion's *operand* as `0`: it has no handler for
`TypeAssertionExpression` / `SatisfiesExpression` and silently yields the zero
value instead of erroring. `as` and `!` are unaffected, which is exactly why only
those two forms diverge. The IR path is spec-correct, so this adoption *fixes*
the two forms for claimed functions and leaves the bug only on the legacy path.

`tests/issue-3583.test.ts` therefore deliberately does **not** assert IR/legacy
parity for those two cases — asserting it would pin the wrong answer. It asserts
the spec answer from IR and **pins legacy's wrong answer**, so whoever fixes
legacy gets a loud failure rather than a silent pass. Filed in the TODO list.

### TODO — next allocation window (needs new issue ids)

Assignment-book writes were out of scope this session, so nothing was allocated
via `claim-issue.mjs --allocate`. Each of these is a genuine residual with a
measured reject arm and no existing issue whose scope covers it:

1. **Value-discarding expression statements** — `x + 1;`, `x;`, `1;`,
   `cond ? a : b;` reject at `nontail-compound-or-binary-stmt` /
   `nontail-exprstmt-other`. Calls and compound assigns already claim, so this is
   the "lower for effect, drop the result" arm (`lowerDiscardedExpression`
   already exists). Small. (Interim owner: #3518.)
2. **Empty object literal `{}`** — rejects at `objectlit-empty`. Not as cheap as
   it looks: the IR object model needs a decision on the field set of an empty
   shape, which is why it was *not* taken this session despite being on the
   expected-candidates list. (Interim: #3518.)
3. **`**` exponentiation** — rejects at `expr-binary-op-**` while `Math.pow`
   already claims, so this is a missing lowering arm over an existing primitive.
   Small. (Interim: #3518.)
4. **Comma operator** — `expr-binary-op-,`. Small. (Interim: #3518.)
5. **Destructuring `for-of` heads** — `for (const [p, q] of …)` rejects at
   `nontail-forof`. (Interim: #3518.)
6. **Computed object keys** — `objectlit-computed-key`. (Interim: #3518.)
7. **Spread** in both array-literal and call positions. (Interim: #3518.)
8. **Numeric template substitution** — `template-substitution-unsupported`;
   string substitution already claims. (Interim: #3518.)
9. **`typeof` on object / closure locals** — currently a *hard compile error*
   (`typeof of non-static IrType … is deferred`), not a clean demote. Arguably a
   bug in the #3565/#4035 typed-demote class, not just a gap. (Interim: #3518.)
10. **LEGACY BUG: `<T>x` and `satisfies` evaluate to 0** in direct codegen (table
    above). Independent of the IR path; needs its own issue against `src/codegen/`.
11. **Top-level `this`** — rejects at an uninstrumented helper arm
    (`unattributed-arm:helper-internal`); the shape-diag recorder should be
    extended to attribute it before the row can be triaged properly.

### Residual (not done in this issue)

`PrefixUnaryExpression` is left `mixed` even though every operator probed
(`-`, `+`, `!`, `~`, `~~`, `++`, `--`) claims. Promoting it to `ir-owned` needs a
complete operator × operand-type sweep, not the seven shapes measured here; the
row now says so explicitly rather than quietly claiming coverage it lacks.

## Test Results (2026-08-15)

### Measured adoption matrix — 89 probe shapes, production `compile()`

Harness: `.tmp/ir-adoption-probes.ts`, run with `JS2WASM_IR_SHAPE_DIAG=1` so each
`body-shape-rejected` carries its proximate selector arm. A shape is CLAIMED iff
its `irOutcomes` entry is `emitted` with `irBodyEmitted === true` — a mere claim
is not enough, the slot must actually carry an IR body.

**Before this issue's adoptions: 43/89 claimed. After: 52/89.** Rows in bold
changed as a direct result of this work.

| Row                      | Probe shape                  | Verdict     | Reason code                       | Stage  |
| ------------------------ | ---------------------------- | ----------- | --------------------------------- | ------ |
| (control)                | plain add                    | CLAIMED     | —                                 | patch  |
| VariableStatement        | let init                     | CLAIMED     | —                                 | patch  |
| VariableStatement        | array destructuring decl     | CLAIMED     | —                                 | patch  |
| ExpressionStatement      | call stmt                    | CLAIMED     | —                                 | patch  |
| ExpressionStatement      | compound assign stmt         | CLAIMED     | —                                 | patch  |
| ExpressionStatement      | bare binary expr stmt        | rejected    | body-shape-rejected               | select |
| ExpressionStatement      | bare identifier stmt         | rejected    | body-shape-rejected               | select |
| ExpressionStatement      | bare literal stmt            | rejected    | body-shape-rejected               | select |
| ExpressionStatement      | ternary stmt                 | rejected    | body-shape-rejected               | select |
| ForStatement             | normal for                   | CLAIMED     | —                                 | patch  |
| ForStatement             | for(; cond; ) no init/incr   | CLAIMED     | —                                 | patch  |
| ForStatement             | bare for(;;) + return        | rejected    | body-shape-rejected               | select |
| ForStatement             | bare for(;;) + break         | **CLAIMED** | —                                 | patch  |
| ForStatement             | for(init; ; incr) no cond    | **CLAIMED** | —                                 | patch  |
| ForOfStatement           | over array                   | CLAIMED     | —                                 | patch  |
| ForOfStatement           | destructuring init           | rejected    | body-shape-rejected               | select |
| TryStatement             | try/catch assigning local    | CLAIMED     | —                                 | patch  |
| TryStatement             | try/finally                  | CLAIMED     | —                                 | patch  |
| TryStatement             | try/catch/finally            | CLAIMED     | —                                 | patch  |
| TryStatement             | return inside try            | rejected    | body-shape-rejected               | select |
| TryStatement             | catch without binding        | rejected    | body-shape-rejected               | select |
| TryStatement             | rethrow in catch             | rejected    | body-shape-rejected               | select |
| NullKeyword              | === null on param            | rejected    | param-type-not-resolvable         | select |
| NullKeyword              | !== null on local            | rejected    | body-shape-rejected               | select |
| NullKeyword              | bare null in f64 ctx         | rejected    | nullish-value-unsupported         | build  |
| NullKeyword              | null in return position      | rejected    | return-type-not-resolvable        | select |
| BinaryExpression         | % modulo                     | CLAIMED     | —                                 | patch  |
| BinaryExpression         | \*\* exponent                | rejected    | body-shape-rejected               | select |
| BinaryExpression         | \*\* literal operands        | rejected    | body-shape-rejected               | select |
| BinaryExpression         | in operator (typed obj)      | rejected    | body-shape-rejected               | select |
| BinaryExpression         | instanceof local class       | CLAIMED     | —                                 | patch  |
| BinaryExpression         | ?? string\|null local        | rejected    | body-shape-rejected               | select |
| BinaryExpression         | comma operator               | rejected    | body-shape-rejected               | select |
| PrefixUnaryExpression    | - negate                     | CLAIMED     | —                                 | patch  |
| PrefixUnaryExpression    | ~ bitwise not                | CLAIMED     | —                                 | patch  |
| PrefixUnaryExpression    | ~~x truncation               | CLAIMED     | —                                 | patch  |
| PrefixUnaryExpression    | ! on boolean                 | CLAIMED     | —                                 | patch  |
| TypeOfExpression         | typeof number param          | CLAIMED     | —                                 | patch  |
| TypeOfExpression         | typeof string param          | CLAIMED     | —                                 | patch  |
| TypeOfExpression         | typeof boolean param         | CLAIMED     | —                                 | patch  |
| TypeOfExpression         | typeof as string value       | CLAIMED     | —                                 | patch  |
| TypeOfExpression         | typeof object local          | COMPILE-ERR | —                                 | —      |
| TypeOfExpression         | typeof closure local         | COMPILE-ERR | —                                 | —      |
| TypeOfExpression         | typeof undefined             | rejected    | body-shape-rejected               | select |
| ElementAccessExpression  | numeric index on array       | CLAIMED     | —                                 | patch  |
| ElementAccessExpression  | variable index on array      | CLAIMED     | —                                 | patch  |
| ElementAccessExpression  | string-literal key on obj    | CLAIMED     | —                                 | patch  |
| ElementAccessExpression  | index on string              | rejected    | element-access-unsupported        | build  |
| ObjectLiteralExpression  | non-empty                    | CLAIMED     | —                                 | patch  |
| ObjectLiteralExpression  | shorthand                    | CLAIMED     | —                                 | patch  |
| ObjectLiteralExpression  | empty {} (inferred)          | rejected    | body-shape-rejected               | select |
| ObjectLiteralExpression  | empty {} (annotated)         | rejected    | body-shape-rejected               | select |
| ObjectLiteralExpression  | computed key                 | rejected    | body-shape-rejected               | select |
| ArrayLiteralExpression   | fixed same-typed             | CLAIMED     | —                                 | patch  |
| ArrayLiteralExpression   | empty []                     | CLAIMED     | —                                 | patch  |
| SpreadElement            | spread in call               | rejected    | body-shape-rejected               | select |
| SpreadElement            | spread in array literal      | rejected    | body-shape-rejected               | select |
| FunctionExpression       | anonymous fn expr            | CLAIMED     | —                                 | patch  |
| FunctionExpression       | named fn expr                | CLAIMED     | —                                 | patch  |
| FunctionExpression       | named fn expr self-recursive | CLAIMED     | —                                 | patch  |
| ArrowFunction            | arrow                        | CLAIMED     | —                                 | patch  |
| AsExpression             | as in return                 | **CLAIMED** | —                                 | patch  |
| AsExpression             | as in const init             | **CLAIMED** | —                                 | patch  |
| AsExpression             | as on string receiver        | **CLAIMED** | —                                 | patch  |
| AsExpression             | as in call arg               | **CLAIMED** | —                                 | patch  |
| AsExpression             | as unknown as                | **CLAIMED** | —                                 | patch  |
| TypeAssertion            | `<number>x`                  | **CLAIMED** | —                                 | patch  |
| NonNullExpression        | x! on non-null param         | **CLAIMED** | —                                 | patch  |
| NonNullExpression        | x! on string\|null local     | rejected    | body-shape-rejected               | select |
| CallExpression           | local direct call            | CLAIMED     | —                                 | patch  |
| CallExpression           | Math.floor                   | CLAIMED     | —                                 | patch  |
| CallExpression           | Math.pow                     | CLAIMED     | —                                 | patch  |
| CallExpression           | optional ?.()                | rejected    | param-type-not-resolvable         | select |
| PropertyAccessExpression | obj prop                     | CLAIMED     | —                                 | patch  |
| PropertyAccessExpression | optional ?. on local         | rejected    | body-shape-rejected               | select |
| TemplateExpression       | string interpolation         | CLAIMED     | —                                 | patch  |
| TemplateExpression       | numeric interpolation        | rejected    | template-substitution-unsupported | select |
| ThisKeyword              | this in method               | CLAIMED     | —                                 | patch  |
| ThisKeyword              | top-level this               | rejected    | body-shape-rejected               | select |
| YieldExpression          | generator declaration        | rejected    | body-shape-rejected               | select |
| YieldExpression          | generator consumed by for-of | rejected    | call-graph-closure                | select |
| NewExpression            | local class                  | CLAIMED     | —                                 | patch  |
| ClassDeclaration         | class + ctor + method        | CLAIMED     | —                                 | patch  |
| MethodDeclaration        | instance method              | CLAIMED     | —                                 | patch  |
| GetAccessorDeclaration   | getter                       | CLAIMED     | —                                 | patch  |
| SetAccessorDeclaration   | setter                       | CLAIMED     | —                                 | patch  |
| EnumDeclaration          | enum member read             | rejected    | body-shape-rejected               | select |
| EnumDeclaration          | const enum member read       | rejected    | body-shape-rejected               | select |
| EnumDeclaration          | enum as param type           | rejected    | body-shape-rejected               | select |

**Proximate selector arms** for every `body-shape-rejected` above — the column
that made the triage possible, since the bare reason string is uniform:

```
ExpressionStatement  bare binary expr stmt   nontail-compound-or-binary-stmt:BinaryExpression
ExpressionStatement  bare identifier stmt    nontail-exprstmt-other:Identifier
ExpressionStatement  bare literal stmt       nontail-exprstmt-other:FirstLiteralToken
ExpressionStatement  ternary stmt            nontail-exprstmt-other:ConditionalExpression
ForStatement         for(;;) + return        tail-unhandled:ForStatement
ForOfStatement       destructuring init      nontail-forof:ForOfStatement
TryStatement         return inside try       tail-unhandled:TryStatement
TryStatement         catch without binding   tail-unhandled:TryStatement
TryStatement         rethrow in catch        tail-unhandled:TryStatement
NullKeyword          !== null on local       vardecl-typenode:UnionType
BinaryExpression     ** (both forms)         expr-binary-op-**:BinaryExpression
BinaryExpression     in operator             expr-binary-op-in:BinaryExpression
BinaryExpression     ?? on union local       vardecl-typenode:UnionType
BinaryExpression     comma operator          expr-binary-op-,:BinaryExpression
TypeOfExpression     typeof undefined        expr-ident-not-in-scope:Identifier
ObjectLiteral        empty {} (inferred)     objectlit-empty:ObjectLiteralExpression
ObjectLiteral        computed key            objectlit-computed-key:ComputedPropertyName
SpreadElement        in array literal        expr-arraylit-spread:SpreadElement
NonNullExpression    x! on union local       vardecl-typenode:UnionType
PropertyAccess       ?. on union local       vardecl-typenode:UnionType
ThisKeyword          top-level this          unattributed-arm:helper-internal
YieldExpression      generator declaration   tail-unhandled:ExpressionStatement
EnumDeclaration      all three forms         expr-ident-not-in-scope:Identifier
```

Isolation controls (`.tmp/probe-isolate.ts`) — needed because four rows' first
probe was rejected by an unrelated *annotation* gate rather than the feature
under test:

```
union local, NO feature at all    -> vardecl-typenode:UnionType             (proves the union is the blocker)
union PARAM, NO feature at all    -> param-type-not-resolvable              (same, param position)
module `const E = { A: 1 }` read  -> expr-module-storage-unrepresentable    (proves enum is not enum-specific)
instanceof local class            -> CLAIMED                                (proves the old note was stale)
bare call-with-value stmt         -> CLAIMED                                (isolates the value-discarding arm)
```

### Gate results

| Gate                                       | Result                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `pnpm run gen:ir-adoption -- --check`      | **green** — "ir-adoption.md is up to date"                                   |
| `npm run typecheck`                        | **green** (exit 0)                                                           |
| `npm test -- tests/issue-3583.test.ts`     | **green** — 16/16                                                            |
| `pnpm run check:ir-fallbacks`              | **green** — no unintended / post-claim / module-level increases vs. baseline |
| `pnpm run check:ir-only`                   | **green** — verdict READY, 37/37 emitted, 0 unsupported, 0 invariants        |
| scoped equivalence (8 loop/try/cast files) | **green** — 91/91                                                            |
| IR suites (8 files)                        | 132/134 — see the honest note below                                          |

**Honest note on the two IR-suite failures.** `tests/ir-scaffold.test.ts`
("selector picks up only phase-1-shaped functions", 11 vs 10) and
`tests/ir-vec-new-fixed.test.ts` (6d, hintless empty literal) both fail. They are
**pre-existing on this branch's base**, not caused by this work — verified with
the file-copy A/B pattern: restoring the unmodified `select.ts` + `from-ast.ts`
from `HEAD` reproduces **both failures with byte-identical assertion output**,
then restoring the changes reproduces the same two. This is the documented #3008
class (untouched root tests never run at PR time, so nothing reports the rot).
They are *not* fixed here — deliberate scope discipline — but they are flagged
rather than silently absorbed.

`npm test -- tests/equivalence` (the full directory) **OOMs** in this container,
as CLAUDE.md documents. The scoped 8-file subset above was run instead, chosen
for relevance to the two adoptions (loops, try/catch, casts, gradual typing).
Full test262 was deliberately not run, per the task constraints.

### Acceptance criteria status

- [x] Every `mixed`/`direct-only` row has a Tracking reference to a live issue —
      audited: the only refs remaining on such rows are #2949 (ready), #2952
      (ready), #3518 (in-progress), #3522 (in-progress), #3783 (ready). No
      `#1131` / `#1370` / `#1371` / `#1374` / `#1804` / `#3000` / `(future)`
      refs survive anywhere in the matrix.
- [x] Class-family rows re-homed under #3522.
- [x] Expression-lowering residue triaged — folded into #2949/#2952 where the
      blocker genuinely overlaps (measured, not assumed), remainder itemised in
      the TODO list. New-id allocation deferred (out of session scope).
- [x] `AsExpression`/`TypeAssertion` and `NonNullExpression` — cheap adoption
      PR landed; the selector *did* reject them, contrary to the brief.
- [x] `EnumDeclaration` explicit decision: **adopt, blocked on #2949** (module
      binding representation), with measured justification. Not deferred.
- [x] `scripts/gen-ir-adoption.mjs` updated, regenerated, `--check` green.

Status stays `in-progress`: the acceptance criteria are met, but the TODO list
above is real follow-up work this issue surfaced and the id allocation it needs
was out of scope for this session.
