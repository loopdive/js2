# IR Adoption Status — AST node kinds

Source of truth for which AST node kinds are owned by the typed IR
(`src/ir/from-ast.ts`) vs. handled exclusively by the direct AST→Wasm
codegen (`src/codegen/`). Companion document to
[`docs/architecture/codegen-axes.md`](../../docs/architecture/codegen-axes.md).

**North star (goal `ir-full-coverage`, elevated 2026-07-02):** ALL AST node
kinds route through the IR front-end; WasmGC vs linear is purely a backend
fork below the IR (`BackendEmitter`); the direct AST→Wasm path is
**deprecation-tracked by this file**, not a peer front-end. Every
`direct-only` / `mixed` row here is a migration TODO (except `deferred`
rows, which die with the direct path). See the "North star" section of the
codegen-axes doc and `plan/goals/ir-full-coverage.md`; ratchet #2855,
bucket work #2856–#2859.

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
  path (`src/codegen/index.ts:~1889` for a selector-claimed function whose
  types can't be resolved, and `~2390` for an IR-build throw; both emit a
  severity-`warning`). Ratchet target: drive the rejection bucket to zero,
  then promote to `ir-owned`.
- **direct-only** — IR has no handler; direct codegen is the only path. A
  function touching one of these kinds is rejected by the selector and
  compiles entirely via legacy.
- **deferred** — IR will not adopt this kind; it stays direct-only by
  design (e.g. `eval`, `with`, `Proxy`).

## Statements

| Kind                  | Status      | Notes                                                                                                                                                                                                                                                                                                                              | Tracking |
| --------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `VariableStatement`   | mixed       | Single-binding `let/const/var` works. Destructuring init throws.                                                                                                                                                                                                                                                                   | #1372    |
| `ExpressionStatement` | mixed       | Calls / assignments / pre-post `++ --` work. Other shapes throw.                                                                                                                                                                                                                                                                   | #1131    |
| `IfStatement`         | ir-owned    | Tail / early-return via block CFG; statement-`if` inside loop/try body buffers via `if.stmt` (#2952 slice 2).                                                                                                                                                                                                                      | —        |
| `ReturnStatement`     | ir-owned    | Must have an expression in Phase 1; `return;` (void) added in slice 14.                                                                                                                                                                                                                                                            | #1228    |
| `ForStatement`        | mixed       | Requires a condition; rejects bare `for(;;)`.                                                                                                                                                                                                                                                                                      | #1131    |
| `ForOfStatement`      | mixed       | Destructuring init throws (slice 6 sentinel).                                                                                                                                                                                                                                                                                      | #1131    |
| `WhileStatement`      | ir-owned    | —                                                                                                                                                                                                                                                                                                                                  | —        |
| `TryStatement`        | mixed       | Basic try/catch lowered; finally + rethrow paths partial.                                                                                                                                                                                                                                                                          | #1131    |
| `ThrowStatement`      | ir-owned    | —                                                                                                                                                                                                                                                                                                                                  | —        |
| `Block`               | ir-owned    | Plain statement lists; scope handling via LowerCtx.                                                                                                                                                                                                                                                                                | —        |
| `SwitchStatement`     | mixed       | Numeric-literal case tests claimed via the `switch` IR instr (block-per-case ladder; eq-chain dispatch, `br_table` for dense-int i32 discs; fallthrough + mid-position `default` + break/continue interplay — #2952 slice 4). Non-literal / string tests stay legacy.                                                              | #2952    |
| `BreakStatement`      | mixed       | Unlabeled `break` binds the nearest loop OR switch (`breakTargetLabel`, #2952 slice 4); labeled break targets labeled loops (slice 3), labeled switches and labeled non-loop blocks (`labeled.block`, slice 4) — all via `br.label` + the lowering-time depth resolver. Breaks in still-direct-only contexts (for-in) stay legacy. | #2952    |
| `ContinueStatement`   | mixed       | Unlabeled `continue` claimed (dedicated continue-target frame per loop shape) and keeps binding the nearest LOOP even through switch frames (§14.8 vs §14.9 split, #2952 slice 4); labeled continue via the label→loopLabel resolution (slice 3).                                                                                  | #2952    |
| `DoStatement`         | mixed       | Post-test loop claimed (reuses `while.loop` + `postCond`); unlabeled break/continue bodies claimed since slice 2; labeled since slice 3.                                                                                                                                                                                           | #2952    |
| `LabeledStatement`    | mixed       | Labeled LOOPS claimed via the loop's own `loopLabel` (+ IteratorClose on crossing branches, #2952 slice 3); labeled switches alias the switch's `breakLabel`; other labeled statements claim via the break-only `labeled.block` frame (slice 4). A label on a still-direct-only statement (for-in) stays legacy.                   | #2952    |
| `ForInStatement`      | direct-only | Object iteration host-import based today.                                                                                                                                                                                                                                                                                          | #2952    |
| `ClassDeclaration`    | mixed       | Methods adopted incrementally via #1370 (Phase B). Constructor in Phase C.                                                                                                                                                                                                                                                         | #1370    |
| `ImportDeclaration`   | deferred    | Module-level concern, not function-body.                                                                                                                                                                                                                                                                                           | —        |
| `ExportDeclaration`   | deferred    | Module-level concern.                                                                                                                                                                                                                                                                                                              | —        |
| `ExportAssignment`    | deferred    | Module-level concern.                                                                                                                                                                                                                                                                                                              | —        |

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

| Kind                                            | Status      | Notes                                                              | Tracking |
| ----------------------------------------------- | ----------- | ------------------------------------------------------------------ | -------- |
| `FunctionDeclaration`                           | ir-owned    | The IR claim unit. Each rejection bucket reduces the claim set.    | #1376    |
| `MethodDeclaration`                             | mixed       | #1370 Phase B; #3000-E adds subclass methods + `super.method()`.   | #1370    |
| `ConstructorDeclaration`                        | mixed       | #3000-C ctor emission (`class.alloc`); #3000-E `super(...)` chain. | #3000    |
| `GetAccessorDeclaration`                        | mixed       | #3000-B accessors; #3000-E subclass accessors (`Dog_get_breed`).   | #3000    |
| `SetAccessorDeclaration`                        | mixed       | #3000-B accessors over the private slot.                           | #3000    |
| `EnumDeclaration`                               | direct-only | Compile-time only; emitted as constants by direct codegen.         | (future) |
| `InterfaceDeclaration` / `TypeAliasDeclaration` | deferred    | Type-erased; no Wasm output.                                       | —        |

## Selector buckets (one row = one reason from `src/ir/select.ts`)

These are the reasons a `FunctionDeclaration` ends up in `mixed` rather
than `ir-owned`. Driving each unintended bucket to zero promotes the
relevant kind row above.

**Module-level unit (#3142, gate G3).** Since Slice 1 the selector also
assesses the top-level statement list as a synthetic `<module-init>` claim
unit (`IrSelection.moduleInit`, `trackFallbacks` only). Its rejections
REUSE the reasons below but are baselined separately — the `moduleLevel`
section of `scripts/ir-fallback-baseline.json` counts one entry per corpus
MODULE whose module-init unit is not claimable (gated must-not-increase by
`check:ir-fallbacks`). Slice 2 wires the actual lowering + the
`__module_init` slot patch; only then do legacy statement handlers become
per-file deletable (gate G3 in `plan/log/3090-phase0-legacy-delete-list.md`).
The current corpus floor is **0** (#3517): Calendar's nine-statement initializer
and Algorithms' top-level generic Map initializer are both IR-owned.

| Bucket reason                            | Category   | What promotes a row                                                                                                                                   |
| ---------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `body-shape-rejected`                    | unintended | Corpus bucket **0** (#2856); not strict while unsupported real-world shapes still legitimately use the direct front-end                               |
| `string-method-unsupported`              | unintended | All checker-identified String method surfaces and arities have typed IR lowering (#3518)                                                              |
| `array-method-unsupported`               | unintended | All checker-identified Array method surfaces and arities have typed IR lowering (#3518)                                                               |
| `primitive-method-unsupported`           | unintended | All checker-identified primitive method surfaces and arities have typed IR lowering (#3518)                                                           |
| `function-invocation-method-unsupported` | unintended | `Function.call` / `Function.apply` receiver and argument semantics are represented in typed IR (#3518)                                                |
| `logical-value-unsupported`              | unintended | Logical value/result families and JavaScript short-circuit coercions are represented in typed IR (#3518)                                              |
| `template-substitution-unsupported`      | unintended | Template substitutions support the remaining typed coercion families (#3518)                                                                          |
| `error-constructor-unsupported`          | unintended | Error-family constructor identity, arity, and runtime intent are represented in typed IR (#3518)                                                      |
| `typed-array-constructor-unsupported`    | unintended | TypedArray constructor identity, arity, and backend capability are represented in typed IR (#3518)                                                    |
| `date-constructor-unsupported`           | unintended | Date constructor identity, arity, and backend capability are represented in typed IR (#3518)                                                          |
| `regexp-constructor-unsupported`         | unintended | RegExp constructor identity, arity, and backend capability are represented in typed IR (#3529)                                                        |
| `call-resolution-unsupported`            | unintended | Every supported call target resolves through the source-qualified whole-program ABI map (#3520)                                                       |
| `call-arity-unsupported`                 | unintended | Typed IR models the supported JavaScript call-arity/default/rest semantics (#3518)                                                                    |
| `constructor-resolution-unsupported`     | unintended | Every supported constructor target resolves through the source-qualified whole-program ABI map (#3520)                                                |
| `constructor-arity-unsupported`          | unintended | Typed IR models the supported JavaScript constructor-arity/default/rest semantics (#3518)                                                             |
| `class-projection-unsupported`           | unintended | Class projection identity and storage are represented in the prepared class-unit model (#3522)                                                        |
| `class-member-unsupported`               | unintended | All supported instance/static class members are represented in the prepared class-unit model (#3522)                                                  |
| `external-call`                          | unintended | Math.\* / parseInt / Console wired through IR (#1371)                                                                                                 |
| `call-graph-closure`                     | unintended | Callees of claimed funcs all claimable themselves                                                                                                     |
| `recursive-type-evidence`                | unintended | Recursive SCC has one checker-backed scalar ABI across parameters, returns, and call edges (#3500)                                                    |
| `param-shape-rejected`                   | unintended | Destructuring params supported (#1372)                                                                                                                |
| `param-type-not-resolvable`              | unintended | TypeMap propagation reaches the param                                                                                                                 |
| `return-type-not-resolvable`             | unintended | TypeMap propagation reaches the return                                                                                                                |
| `type-resolution-failure`                | unintended | Same                                                                                                                                                  |
| `class-method`                           | unintended | #1370/#3000 B-C-E — corpus bucket **0** (#3000-E); NOT yet strict (still covers computed/generator/abstract names, static super, subclass-of-builtin) |
| `destructuring-param-complex`            | unintended | Complex destructuring params lowered (subset of param-shape)                                                                                          |
| `string-builder-candidate`               | deferred   | Kill-switch only (`JS2WASM_IR_STRING_BUILDER=0`): builder loops are IR-claimed by default via the owned-append fast path (#3740/#3744)                |
| `async-function`                         | deferred   | Async bodies — CPS lowering tracked separately (#1373/#1796)                                                                                          |
| `async-generator`                        | deferred   | Out of scope long-term                                                                                                                                |
| `deferred-feature`                       | deferred   | `eval` / `Proxy` / `with` — wont-fix                                                                                                                  |
| `type-parameters`                        | deferred   | Generics specialisation (future)                                                                                                                      |
| `non-export-modifier`                    | deferred   | `async` / declare-only — narrow                                                                                                                       |
| `unnamed`                                | deferred   | Anonymous default exports                                                                                                                             |

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

The aim of #2855 is that every "unintended" bucket reaches zero. The
"deferred" buckets are stable — they're a documented decision, not a TODO.
