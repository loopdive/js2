# IR Adoption Status — AST node kinds

Source of truth for which AST node kinds are owned by the typed IR
(`src/ir/from-ast.ts`) vs. handled exclusively by the direct AST→Wasm
codegen (`src/codegen/`). Companion document to
[`docs/architecture/codegen-axes.md`](../../docs/architecture/codegen-axes.md).

> **Generated file — do not edit by hand.** Regenerate with
> `pnpm run gen:ir-adoption` after editing the curated data in
> `scripts/gen-ir-adoption.mjs`. The quality CI job runs `--check` and fails
> when this file is stale. Per-kind rows are curated; the selector-bucket
> table is cross-checked against the `IrFallbackReason` union in
> `src/ir/select.ts`, so a new rejection reason there forces an update here.

## Status legend

- **ir-owned** — IR's `from-ast.ts` handles the kind and the selector
  (`select.ts`) claims functions containing it. Direct codegen still has a
  body but the IR-compiled body is the one that ships when
  `experimentalIR: true` (the default).
- **mixed** — `from-ast.ts` handles a _subset_ of the kind. Whole-function
  rejection by the selector or per-node throws inside `from-ast.ts` causes
  the function to fall back to direct codegen via the demote-to-warning
  path (`src/codegen/index.ts:889–896`). Ratchet target: drive the
  rejection bucket to zero, then promote to `ir-owned`.
- **direct-only** — IR has no handler; direct codegen is the only path. A
  function touching one of these kinds is rejected by the selector and
  compiles entirely via legacy.
- **deferred** — IR will not adopt this kind; it stays direct-only by
  design (e.g. `eval`, `with`, `Proxy`).

## Statements

| Kind                  | Status      | Notes                                                                      | Tracking |
| --------------------- | ----------- | -------------------------------------------------------------------------- | -------- |
| `VariableStatement`   | mixed       | Single-binding `let/const/var` works. Destructuring init throws.           | #1372    |
| `ExpressionStatement` | mixed       | Calls / assignments / pre-post `++ --` work. Other shapes throw.           | #1131    |
| `IfStatement`         | ir-owned    | Both arms must be present in tail position; body-position `if` works.      | —        |
| `ReturnStatement`     | ir-owned    | Must have an expression in Phase 1; `return;` (void) added in slice 14.    | #1228    |
| `ForStatement`        | mixed       | Requires a condition; rejects bare `for(;;)`.                              | #1131    |
| `ForOfStatement`      | mixed       | Destructuring init throws (slice 6 sentinel).                              | #1131    |
| `WhileStatement`      | ir-owned    | —                                                                          | —        |
| `TryStatement`        | mixed       | Basic try/catch lowered; finally + rethrow paths partial.                  | #1131    |
| `ThrowStatement`      | ir-owned    | —                                                                          | —        |
| `Block`               | ir-owned    | Plain statement lists; scope handling via LowerCtx.                        | —        |
| `SwitchStatement`     | direct-only | No IR handler. Lowered in `src/codegen/statements/control-flow.ts`.        | (future) |
| `BreakStatement`      | direct-only | Labeled / unlabeled break — needs CFG IR enhancements.                     | (future) |
| `ContinueStatement`   | direct-only | Same.                                                                      | (future) |
| `DoStatement`         | direct-only | Lower priority; rewrites cleanly to `while`.                               | (future) |
| `LabeledStatement`    | direct-only | Needs labeled break/continue CFG support.                                  | (future) |
| `ForInStatement`      | direct-only | Object iteration host-import based today.                                  | (future) |
| `ClassDeclaration`    | mixed       | Methods adopted incrementally via #1370 (Phase B). Constructor in Phase C. | #1370    |
| `ImportDeclaration`   | deferred    | Module-level concern, not function-body.                                   | —        |
| `ExportDeclaration`   | deferred    | Module-level concern.                                                      | —        |
| `ExportAssignment`    | deferred    | Module-level concern.                                                      | —        |

## Expressions

| Kind                             | Status      | Notes                                                                                                                                                      | Tracking |
| -------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `Identifier`                     | ir-owned    | Local + param resolution via LowerCtx.                                                                                                                     | —        |
| `NumericLiteral`                 | ir-owned    | f64 / i32 per type hint.                                                                                                                                   | —        |
| `StringLiteral`                  | ir-owned    | `nativeStrings` and host-string both supported.                                                                                                            | —        |
| `NoSubstitutionTemplateLiteral`  | ir-owned    | Treated as `StringLiteral`.                                                                                                                                | —        |
| `TemplateExpression`             | mixed       | Only constant-prefix patterns; complex interpolation throws.                                                                                               | #1374    |
| `TrueKeyword` / `FalseKeyword`   | ir-owned    | —                                                                                                                                                          | —        |
| `NullKeyword`                    | mixed       | `=== / !==` comparisons + bare `null` in a reference-shaped (externref) context. Non-reference (f64/i32) null context throws.                              | #1131    |
| `ThisKeyword`                    | mixed       | Method bodies via #1370. Top-level `this` rejected.                                                                                                        | #1370    |
| `RegularExpressionLiteral`       | ir-owned    | Dispatches to dual RegExp backend.                                                                                                                         | —        |
| `BinaryExpression`               | mixed       | Arithmetic / comparison / `&& \|\|` / bitwise lowered. `??` lowered over same-typed reference operands (else throws). `%`, `**`, `in`, `instanceof` throw. | #1131    |
| `PrefixUnaryExpression`          | mixed       | `-`, `+`, `!`, `++`, `--` lowered. `~` and `typeof` partial.                                                                                               | #1131    |
| `PostfixUnaryExpression`         | ir-owned    | `++`, `--`.                                                                                                                                                | —        |
| `ConditionalExpression`          | ir-owned    | Ternary.                                                                                                                                                   | —        |
| `ParenthesizedExpression`        | ir-owned    | Pass-through.                                                                                                                                              | —        |
| `CallExpression`                 | mixed       | Direct calls to claimed funcs work. Externals require whitelist. Optional `?.()` throws.                                                                   | #1371    |
| `NewExpression`                  | mixed       | Class constructors via #1370 Phase C; arbitrary `new` host-bound.                                                                                          | #1370    |
| `PropertyAccessExpression`       | mixed       | Object / closure / string / vec / extern receivers. Optional `?.` partial.                                                                                 | #1374    |
| `ElementAccessExpression`        | mixed       | Constant string key + numeric array index. Other arg shapes throw.                                                                                         | #1131    |
| `ObjectLiteralExpression`        | mixed       | Non-empty `{ key: val, ... }` lowered; empty literal, computed keys throw.                                                                                 | #1131    |
| `ArrayLiteralExpression`         | mixed       | Slice 12 + #1804 — fixed-length same-typed literals constructed via `vec.new_fixed`. Spread/sparse/mixed-type partial.                                     | #1804    |
| `SpreadElement`                  | mixed       | Static-arity spread in calls only.                                                                                                                         | #1131    |
| `FunctionExpression`             | mixed       | Nested closures via slice 3; named function-expressions partial.                                                                                           | #1131    |
| `ArrowFunction`                  | mixed       | Same as `FunctionExpression`.                                                                                                                              | #1131    |
| `TypeOfExpression`               | ir-owned    | Lowered to host import for externref values.                                                                                                               | —        |
| `VoidExpression`                 | ir-owned    | `void 0` recognised.                                                                                                                                       | —        |
| `DeleteExpression`               | ir-owned    | —                                                                                                                                                          | —        |
| `YieldExpression`                | mixed       | Generator support via integration.ts; non-trivial state-machines partial.                                                                                  | #1131    |
| `AwaitExpression`                | deferred    | Async bodies rejected at the function level today.                                                                                                         | #1373    |
| `AsExpression` / `TypeAssertion` | direct-only | Type-erased; selector sees the operand.                                                                                                                    | —        |
| `NonNullExpression` (`x!`)       | direct-only | Type-erased; rare in compiler-emitted code.                                                                                                                | —        |
| `JsxElement` & JSX family        | deferred    | Out of scope.                                                                                                                                              | —        |

## Declarations

| Kind                                            | Status      | Notes                                                           | Tracking |
| ----------------------------------------------- | ----------- | --------------------------------------------------------------- | -------- |
| `FunctionDeclaration`                           | ir-owned    | The IR claim unit. Each rejection bucket reduces the claim set. | #1376    |
| `MethodDeclaration`                             | mixed       | Adopted incrementally via #1370 Phase B class-shape registry.   | #1370    |
| `ConstructorDeclaration`                        | direct-only | Phase C work; defensively rejected by from-ast.ts today.        | #1370    |
| `GetAccessorDeclaration`                        | direct-only | `class-method` fallback bucket; phase B excludes accessors.     | #1370    |
| `SetAccessorDeclaration`                        | direct-only | Same.                                                           | #1370    |
| `EnumDeclaration`                               | direct-only | Compile-time only; emitted as constants by direct codegen.      | (future) |
| `InterfaceDeclaration` / `TypeAliasDeclaration` | deferred    | Type-erased; no Wasm output.                                    | —        |

## Selector buckets (one row = one reason from `src/ir/select.ts`)

These are the reasons a `FunctionDeclaration` ends up in `mixed` rather
than `ir-owned`. Driving each unintended bucket to zero promotes the
relevant kind row above.

| Bucket reason                 | Category   | What promotes a row                                          |
| ----------------------------- | ---------- | ------------------------------------------------------------ |
| `body-shape-rejected`         | unintended | from-ast.ts handles every statement in the body              |
| `external-call`               | unintended | Math.\* / parseInt / Console wired through IR (#1371)        |
| `call-graph-closure`          | unintended | Callees of claimed funcs all claimable themselves            |
| `param-shape-rejected`        | unintended | Destructuring params supported (#1372)                       |
| `param-type-not-resolvable`   | unintended | TypeMap propagation reaches the param                        |
| `return-type-not-resolvable`  | unintended | TypeMap propagation reaches the return                       |
| `type-resolution-failure`     | unintended | Same                                                         |
| `class-method`                | unintended | #1370 Phase B / C — class shape registry covers the member   |
| `destructuring-param-complex` | unintended | Complex destructuring params lowered (subset of param-shape) |
| `async-function`              | deferred   | Async bodies — CPS lowering tracked separately (#1373/#1796) |
| `async-generator`             | deferred   | Out of scope long-term                                       |
| `deferred-feature`            | deferred   | `eval` / `Proxy` / `with` — wont-fix                         |
| `type-parameters`             | deferred   | Generics specialisation (future)                             |
| `non-export-modifier`         | deferred   | `async` / declare-only — narrow                              |
| `unnamed`                     | deferred   | Anonymous default exports                                    |

## How to update this table

This file is generated. To move a row:

1. Edit the row's Status (and Notes/Tracking) in the `SECTIONS` data in
   `scripts/gen-ir-adoption.mjs`, then run `pnpm run gen:ir-adoption`.
2. If it crossed `mixed → ir-owned`, remove its rejection bucket from
   `scripts/ir-fallback-baseline.json` (the IR fallback gate enforces it
   cannot regress).
3. Drop the tracking issue reference if the issue closed.
4. If you discovered a new rejection bucket, add it to the `IrFallbackReason`
   union in `src/ir/select.ts` **and** to `BUCKETS` here — the generator
   cross-checks the two and fails otherwise.

The aim of #1530 is that every "unintended" bucket reaches zero. The
"deferred" buckets are stable — they're a documented decision, not a TODO.
