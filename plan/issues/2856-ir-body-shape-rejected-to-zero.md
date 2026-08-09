---
id: 2856
title: "IR: drive body-shape-rejected fallback bucket to zero (dominant unintended bucket)"
status: done
completed: 2026-07-21
assignee: ttraenkler/opus-2856
spec: banked
sprint: 73
created: 2026-06-30
updated: 2026-07-21
priority: high
horizon: l
feasibility: hard
model: fable
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
model: fable
fable_role: spec
parent: 2855
related: [1376, 1131, 2138, 2135, 2134]
loc-budget-allow:
  - scripts/check-ir-fallbacks.ts
  - scripts/ir-fallback-baseline.json
  - src/codegen/index.ts
  - src/codegen/stack-balance.ts
  - src/ir/backend/linear-integration.ts
  - src/ir/capability.ts
  - src/ir/from-ast.ts
  - src/ir/host-date.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/module-bindings.ts
  - src/ir/passes/inline-small.ts
  - src/ir/select.ts
  - tests/issue-2856-inline-small-buffer-caller.test.ts
  - tests/issue-2856-calendar-residuals.test.ts
  - tests/issue-2856-async-delay-ir.test.ts
  - tests/issue-2856-module-bindings.test.ts
  - tests/issue-2856-builtins-component.test.ts
---

# #2856 — IR: `body-shape-rejected` → 0

Child of the IR front-end migration epic **#2855**. This is the **single
largest** unintended IR fallback bucket and the highest-value migration slice.

## Problem

`body-shape-rejected` is the `IrFallbackReason` raised when `from-ast.ts` cannot
lower _some statement or expression_ in a `FunctionDeclaration`'s body, so the
whole function demotes to the legacy direct-AST→Wasm path. Per
`plan/log/ir-adoption.md`, the bucket clears for a function only when
"`from-ast.ts` handles every statement in the body."

## Live snapshot (verified `origin/main` @ dc29fd081, 2026-06-30)

`pnpm run check:ir-fallbacks -- --verbose` → **`body-shape-rejected: 31`**
(matches `scripts/ir-fallback-baseline.json`). Per-file worklist:

| File                                                | count |
| --------------------------------------------------- | ----- |
| `website/playground/examples/dom/calendar.ts`       | 6     |
| `website/playground/examples/js/algorithms.ts`      | 5     |
| `website/playground/examples/benchmarks.ts`         | 4     |
| `website/playground/examples/js/classes.ts`         | 3     |
| `website/playground/examples/benchmarks/array.ts`   | 2     |
| `website/playground/examples/benchmarks/dom.ts`     | 2     |
| `website/playground/examples/benchmarks/style.ts`   | 2     |
| `website/playground/examples/js/builtins.ts`        | 2     |
| `website/playground/examples/benchmarks/fib.ts`     | 1     |
| `website/playground/examples/benchmarks/helpers.ts` | 1     |
| `website/playground/examples/benchmarks/loop.ts`    | 1     |
| `website/playground/examples/benchmarks/string.ts`  | 1     |
| `website/playground/examples/js/async.ts`           | 1     |

## Likely covered kinds (confirm during the diagnostic pass)

The bucket is heterogeneous. From the `mixed` / `direct-only` rows in
`plan/log/ir-adoption.md`, the statement/expression kinds that throw inside
`from-ast.ts` and most plausibly drive these 31 rejections:

- **Statements (direct-only — no IR handler):** `SwitchStatement`,
  `BreakStatement` / `ContinueStatement` (labeled + unlabeled), `DoStatement`,
  `LabeledStatement`, `ForInStatement`.
- **Expression shapes that throw (`mixed` rows):** `%`, `**`, `in`,
  `instanceof` in `BinaryExpression`; `~` / `typeof` partials in
  `PrefixUnaryExpression`; complex `TemplateExpression` interpolation; computed
  / empty `ObjectLiteralExpression`; spread / sparse / mixed-type
  `ArrayLiteralExpression`; non-reference (f64/i32) `null` context; optional
  `?.()` call forms.

## Approach (recommended decomposition)

This is too large for one PR. **Step 1 is a diagnostic pass**, then slice by
kind:

1. **Diagnostic pass (do first).** Run the example corpus with per-function
   reason logging (`JS2WASM_LOG_IR_FALLBACKS=1`, or extend
   `scripts/check-ir-fallbacks.ts` to print the _offending node kind_ per
   rejected function, not just the file count). Produce an exact kind→count
   histogram. **Append the histogram to this issue** so follow-up slices are
   precisely scoped. If the histogram shows several independent kinds, split
   this issue into per-kind child issues (one PR each) rather than a single
   mega-PR.
2. **Land the highest-count kind first** (likely `SwitchStatement` or a
   loop-control kind — confirm from the histogram). Add the `from-ast.ts`
   handler + selector acceptance + IR lowering, with legacy-parity equivalence
   coverage.
3. **Re-run the gate after each slice** and bank the decrease:
   `pnpm run check:ir-fallbacks -- --update-on-decrease`, commit the lowered
   `scripts/ir-fallback-baseline.json`.
4. When the bucket reaches **0**, add `"body-shape-rejected"` to
   `STRICT_IR_REASONS` (`src/codegen/index.ts:1013`) and promote the affected
   rows in `plan/log/ir-adoption.md` (`pnpm run gen:ir-adoption`).

## Step-1 diagnostic pass (2026-07-01, dev-b) — hypothesis CORRECTED

Ran a non-invasive diagnostic (reuses the real `planIrCompilation` selector to
identify the 31 `body-shape-rejected` functions, then classifies each body):

**Key correction — the "Likely covered kinds" hypothesis above is WRONG.** All
31 rejected functions have **only Phase-1-ACCEPTED top-level statement kinds**.
**Zero** of them contain a `SwitchStatement`, `BreakStatement`,
`ContinueStatement`, `DoStatement`, `LabeledStatement`, or `ForInStatement` — at
top level OR nested. So this bucket is **not** driven by unhandled statement
_kinds_; it is driven by inner **expression/statement SHAPE** rejections inside
otherwise-accepted statements.

Approximate cause histogram (heuristic — a function can carry >1 tag; derived
directly from the `isPhase1Expr` / `isPhase1StatementList` reject arms):

| cause                                                         | ~fns   | reject arm                                                                                                                                            |
| ------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stmt: local reassignment` `x = e;` (LHS not property-access) | ~10    | `isPhase1StatementList` accepts `=` only when LHS is a PropertyAccess (line ~824)                                                                     |
| `guard: C-style loop + array literal` (#1804)                 | 5      | `isPhase1Expr` array-literal arm withholds when `currentFnHasCStyleLoop` (line ~1761)                                                                 |
| `expr: closure value` (arrow / function expression)           | 3      | no `isPhase1Expr` arm for ArrowFunction/FunctionExpression                                                                                            |
| `op: %` (remainder)                                           | 2      | `isPhase1BinaryOp` rejects `%`                                                                                                                        |
| `stmt: if/else @ non-tail`                                    | 2      | non-tail loop accepts only `if` WITHOUT else (line ~842)                                                                                              |
| `stmt: ++/--`                                                 | 1      | no ExpressionStatement arm for postfix/prefix inc-dec                                                                                                 |
| `stmt: element assignment` `arr[i] = e;`                      | 1      | same `=` arm — ElementAccess LHS not accepted                                                                                                         |
| `op: instanceof`                                              | 1      | `isPhase1BinaryOp` rejects `instanceof`                                                                                                               |
| **unclassified by the heuristic**                             | **17** | needs the selector's own verdict (bare/multiple non-tail returns, var-decl with non-Phase-1 / non-resolvable initializer, unsupported tail shapes, …) |

**The heuristic explains ~14/31; 17 remain unclassified.** An EXACT per-cause
histogram requires **opt-in selector instrumentation** — thread an
"offending-node" recorder through the `return false` sites of
`isPhase1StatementList` / `isPhase1Expr` (behaviour unchanged when the recorder
is off) and surface it via `planIrCompilation`'s fallbacks, then have
`scripts/check-ir-fallbacks.ts` print the node-kind. That instrumentation is the
concrete Step-1 implementation (was mis-scoped as "just print the kind"; the
kinds are all accepted — it must print the _reject-arm/shape_).

**Recommended first kind-slice** (highest lever, once instrumentation confirms):
statement-level **mutable assignment** — `x = e;` and `arr[i] = e;` — which the
heuristic attributes to ~11 functions. NB this is a substantial IR change
(mutable-local versioning / element-store lowering in `from-ast.ts`), not a
quick win; size it as its own PR with legacy/IR equivalence parity.

Diagnostic script kept at `.tmp/diagnose-body-shape.mjs` (heuristic; not
committed — the exact instrumentation supersedes it). Routing: this epic needs
`senior-developer` for the selector instrumentation + the mutable-assignment IR
lowering.

## Step-1 diagnostic DONE (2026-07-02, sr-funcidx) — heuristic OVERTURNED

Implemented the opt-in reject-arm recorder (`shapeNo`/`takeShapeRejectDetail` in
`src/ir/select.ts`, gated on `JS2WASM_IR_SHAPE_DIAG=1`, byte-inert when off) and a
`--shape-diag` mode in `scripts/check-ir-fallbacks.ts`. Every instrumented
`return false` in the Phase-1 shape gate (`isPhase1StatementList`,
`isPhase1VarDecl`, `isPhase1Expr`, `isPhase1Tail`, `isPhase1BodyStatement`) records
its `"<arm>:<NodeKind>"`; the FIRST (deepest) wins.

Run: `JS2WASM_IR_SHAPE_DIAG=1 pnpm run check:ir-fallbacks -- --shape-diag`.

**Exact histogram (31/31 attributed) — the "mutable assignment ~11 + 17
unclassified" heuristic was WRONG:**

| count | reject arm                                   | meaning                                                                                                                                                                  |
| ----- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 13    | `vardecl-init-expr:PropertyAccessExpression` | `const x = <host-global>.<prop>` — receiver identifier not in scope (`document.*`, `window.*`, `Math.*`, DOM globals)                                                    |
| 4     | `vardecl-init-expr:CallExpression`           | `const x = <host-global-or-method>(...)` — call receiver/callee not IR-claimable                                                                                         |
| 4     | `unattributed-arm:helper-internal`           | class-member reject inside an as-yet-uninstrumented helper (`isPhase1ObjectLiteral`/`TryStatement`/`ClosureLiteral`/`ForStatement` internals) — Step-1b to sub-attribute |
| 3     | `body-unhandled-stmt:IfStatement`            | `if` in a constructor/body-statement position (non-tail body list)                                                                                                       |
| 2     | `vardecl-typenode:ArrayType`                 | `const x: number[] = …` — `isPhase1TypeNode` rejects the array annotation                                                                                                |
| 2     | `nontail-callstmt:CallExpression`            | non-tail call statement whose call isn't IR-claimable                                                                                                                    |
| 1     | `tail-unhandled:ExpressionStatement`         | non-void tail expression statement                                                                                                                                       |
| 1     | `nontail-if-cond:BinaryExpression`           | `if` condition expr not Phase-1                                                                                                                                          |
| 1     | `nontail-unhandled-stmt:IfStatement`         | `if`-with-`else` at a non-tail (non-early-return) position                                                                                                               |

**Key finding — the corpus is DOM / benchmark code dominated by host-global
member access (`document`/`window`/`Math`/`performance`), NOT the compiler-
internal statement-kind gaps the issue originally hypothesised, and NOT
mutable-assignment (0 hits).** So driving THIS corpus's `body-shape-rejected` to
zero is mostly about **host-global member access in `const` initializers** (17 of
31 = 55%), not a `from-ast.ts` statement handler. That is a very different (and
larger / possibly out-of-IR-scope) problem than a kind-slice — it likely needs a
resolver notion of host-global receivers, or the corpus/gate scope revisited.
**Recommend PO/architect re-scope #2856 around this finding before any lowering
slice.**

**Verification:** the `check:ir-fallbacks` gate is byte-unchanged with the
recorder off (`body-shape-rejected: 31`, "IR fallback gate: OK"); typecheck
clean; behaviour-neutral (identical IR-test pass/fail counts with vs. without the
instrumentation — the ~28 pre-existing `ir-*-equivalence` failures in this
container are unrelated and present on the pristine base).

### Remaining (Step-1b, small)

Instrument the 4 `unattributed-arm` helper internals (`isPhase1ObjectLiteral`,
`isPhase1TryStatement`, `isPhase1ClosureLiteral`, `isPhase1ForStatement`
internals) for full sub-attribution of the class-member rejects.

### Leaf-level identifier attribution (2026-07-02, dev-2856f) — complements the arm histogram

An independent leaf-level recorder run (same first-wins discipline, but firing
at the deepest failing node with a source snippet — built in parallel, dropped
in favour of the landed `shapeNo` recorder) confirms the arm histogram above
and adds the **which-identifier** split the arm:NodeKind labels can't see:

- `expr:ident-not-in-scope` fires 21× total at the leaf level. Split:
  **`document` ×16, `console` ×2** (host globals — the extern-in-IR plan
  below), and **module-scope bindings ×3**: `fibCache`
  (`js/algorithms.ts::fibMemo`), `gridEl` (`dom/calendar.ts::renderCal`),
  `selStart` (`dom/calendar.ts::updFoot`). The module-scope arm is NOT in the
  extern-in-IR plan's scope — it's a separate dev-lane arm (added below).
- **Step-1b answered**: the class-member rejects the arm recorder couldn't
  sub-attribute are the `js/classes.ts` private-field accesses — `Animal_new`
  writes `this.#name` (`assign-prop-name-not-ident`), `Animal_speak` reads
  `this.#name` (`prop:name-not-ident`). `#private` names are not
  `ts.Identifier`s, so both property arms reject on `isIdentifier(name)`.
- The 2 `nontail-callstmt:CallExpression` rows are the `console.log(…)`
  statements in `js/algorithms.ts::main` / `js/classes.ts::main` — i.e. the
  SAME host-global root as the 17 `vardecl-init-expr` rows, just reached via a
  call-statement arm. Host-global work should count 17+2 = **19 functions**.
- `new:type-args` ×1 is `new Promise<number>(…)` in `js/async.ts::delay`.

### ⚠ Sequencing constraint — demotion is CONTAGIOUS (read before picking up ANY arm)

The selector's fixpoint loop (`src/ir/select.ts` ~line 415 — the
`call-graph-closure` demotion) removes a claimed function whenever ANY local
caller or callee is unclaimed. The host-global rejects sit in the `main` /
`bench_*` **drivers — the call-graph roots** — so they pin every example's
whole call graph out of the IR. Consequence: **landing a leaf arm (if-in-loop,
ArrayType annotation, module-scope binding, …) BEFORE the extern-in-IR slice
does not reduce the unintended total — it MOVES the count from
`body-shape-rejected` into `call-graph-closure`, and the gate FAILS on that
bucket's growth** (demonstrated empirically: shape-fixing a leaf in
`benchmarks/fib.ts` grew `call-graph-closure` by the same amount). So:

- The extern-in-IR slice (below) lands **first**; it shrinks BOTH buckets in
  one PR and the ratchet (`--update-on-decrease`) banks them together.
- Any smaller arm picked up before that must land as part of the same PR as
  its callers' unblocking, or explicitly verify `call-graph-closure` does not
  grow (`pnpm run check:ir-fallbacks` locally before pushing).

## Acceptance criteria

1. `body-shape-rejected` count in `scripts/ir-fallback-baseline.json` is `0`
   (verify `pnpm run check:ir-fallbacks` reports the bucket gone).
2. The kind histogram from the diagnostic pass is recorded in this issue.
3. Equivalence tests for each newly-IR-claimed kind pass (legacy/IR parity).
4. Once the corpus bucket reaches zero, the zero floor is banked in the
   fallback baseline and the promotion verdict is recorded. Do **not** add
   `"body-shape-rejected"` to `STRICT_IR_REASONS` while real-world shapes can
   still legitimately use the legacy front-end (see “At corpus-zero” below).
5. No regression in the existing IR test suite (`tests/ir-*.test.ts`) or
   test262 conformance.

## Files

- `src/ir/from-ast.ts` — add statement/expression handlers for the rejected kinds.
- `src/ir/select.ts` — relax the body-shape check as each kind is supported.
- `src/ir/lower.ts` / `src/ir/nodes.ts` — IR node types + Wasm lowering as needed.
- `scripts/check-ir-fallbacks.ts` — (diagnostic) per-node-kind reporting.
- `scripts/ir-fallback-baseline.json` — ratchet down as slices land.
- `src/codegen/index.ts` — record the no-promotion verdict at corpus zero;
  promotion belongs to the sole-front-end endgame.
- `plan/log/ir-adoption.md` — promote rows (regenerated).

## Implementation Plan — extern-in-IR (host-global member access)

> Spec'd 2026-07-02 (sr-funcidx) against `origin/main` post-#2454 (the Step-1
> recorder is merged). **Re-`grep` the function names before editing** —
> `isPhase1Expr`, `whyNotIrClaimable`, `isKnownExternClass`, `getExternClassInfo`,
> the `from-ast.ts` member-read/call lowering, `IrType`. This plan covers the
> **first slice** (host-global member access, 17/31); the smaller arms are listed
> separately at the end for dev-lane pickup.

### Implementation notes (2026-07-02, dev-2856f) — verified corrections to this plan

Probe-verified against a real compile (`.tmp/probe-2856-doc-imports.mts`): the
legacy surface for `document.*` is NOT `__extern_get` — it is the
**extern-class per-member import surface**: `global_document` (declared-globals
handle, `collectDeclaredGlobals`), `Document_getElementById` /
`Document_get_body` / `Element_set_textContent` / `Node_appendChild`
(`collectUsedExternImports` source pre-scan over `ctx.externClasses`, chain
walk via `ctx.externClassParent`; DOM classes enter the registry from
lib.dom's `declare var X: { new(): X; … }` constructor-vars via
`collectExternFromDeclareVar` + `collectInterfaceMembers`), and
`console_<method>_<number|bool|string|externref>` per-arg-type variants
(`collectConsoleImports`). All are **source-scan pre-passes independent of
which front-end compiles the body**, so IR-claimed functions get their imports
registered anyway; the IR lowering resolves them **by name**
(`resolver.resolveFunc`) — funcIdx-shift-safe by construction.

Design deltas vs the plan above:

1. **No new IR node kinds.** `IrInstrCall` takes a symbolic `{kind:"func",
name}` target and an explicit result IrType, so `document` lowers as
   `call global_document : {kind:"extern", className:"Document"}`, and
   `console.log(s)` as a void `call console_log_string`. Member get/set/call
   reuse the existing `extern.prop` / `extern.propSet` / `extern.call` instrs
   (their lowering already emits `<prefix>_get_<p>` / `<prefix>_<m>` by name;
   effects analysis already marks `extern.*` full heap read+write, covering
   the plan's #2134 barrier concern).
2. **Selection runs EARLY (index.ts ~1178), before the registries populate
   (~1471-1524)** — the selector can NOT read `ctx.externClasses` /
   `ctx.declaredGlobals`. Split: the selector uses a **checker-backed
   callback** threaded via `IrSelectionOptions`
   (`resolveHostGlobal(node: ts.Identifier) → className | undefined`:
   symbol → ambient declare-var in a `.d.ts` → `isExternalDeclaredClass`
   parity gate → type symbol name; shadow-safe because the checker resolves
   the real binding), while **from-ast (which runs late) uses the authoritative
   registry** via new resolver callbacks (`getHostGlobalInfo(name)`,
   `resolveExternMember(className, member, kind)` — the chain walk). The gate
   script keeps its direct `planIrCompilation` call and builds the same
   checker callback from its own program — no script rewrite.
3. **Capability integration (#2135, agreed with dev-2138f):** mode-gated
   `hostExternCapability(jsHost): IrOpCapability` in `src/ir/capability.ts` —
   `"claim-partial"` in JS-host mode, `"defer"` under
   standalone/wasi/strictNoHostImports; selector consumes it, from-ast entry
   asserts via `assertNotDeferred` (uniform message class for the #1923 meter
   and #2138's IR-first channel). Branch is predecessor-stacked on
   `issue-2135-ir-capability-predicate` (#2476); enqueue only after it lands.
4. **Two from-ast gaps to close** (pre-existing in the slice-10 extern arms):
   member resolution does NOT walk `externClassParent` (an `Element` receiver
   would miss `Node.appendChild`), and `extern.prop`/`extern.call` results
   lose the class brand (registered as bare ValType, breaking chained
   `document.body.appendChild`). Fix: chain-walk in the new
   `resolveExternMember` + record `resultClassName` at registration
   (`collectInterfaceMembers` et al.) when the mapped result is externref.
5. **Standalone**: `"defer"` ⇒ the selector never claims ⇒ legacy ⇒ the
   existing #1472/#2907 refusal — unchanged, as the plan requires. The
   `console` arm is also host-only (WASI console lowers natively via
   fd*write, no `console*\*` host imports).

### Slice 1 RESULTS (2026-07-02, dev-2856f — extern-in-IR landed)

- Gate: `body-shape-rejected` **34 → 27** (−7); post-claim demotions **0**
  (the two `<f64>.toString()` demotions the first run surfaced were fixed by
  the `number_toString` arm). `call-graph-closure` 5 → 8: the predicted
  contagion shuffle — `el`/`bcrd`/helpers are now IR-CAPABLE but pinned by
  callers whose own first blockers are **closure-valued args**
  (`addBenchCard(…, bench_fib)`), **imported callees** (cross-module calls),
  `%`-defer (#2945), and misc arms — all separately tracked. Banked via
  `--update` in the slice PR (net unintended 45 → 41).
- Runtime parity: IR-on vs IR-off **identical observable behavior** on
  benchmarks/dom.ts, benchmarks/helpers.ts, js/algorithms.ts, js/classes.ts
  (full console-output equality on the executable ones; identical
  failure-mode on DOM files under Node's shimless host).
- Landmine fixed en route: extern method imports have FIXED Wasm arity
  including optional params (`createElement(tag, options?)` = 3 slots) — the
  IR extern.call arm must pad missing optionals with default sentinels like
  legacy's `pushDefaultValue`, or the module fails validation ("not enough
  arguments on the stack"). Regression-tested in
  `tests/issue-2856-extern-in-ir.test.ts`.
- Use-site branding replaced registration-time branding (the plan's note 4):
  overloads collapse at registration (`createElement`'s first overload
  returns a type param), so `resolveExternMember` brands from the checker at
  the USE SITE (`getTypeAtLocation` + `getNonNullableType`).
- Remaining body-shape (27): 8 `nontail-callstmt` (mains calling
  imported/closure-valued fns), 4 helper-internal (incl. the `#private`
  pair), 3 if-in-loop, 2 ArrayType annotation, 2 `%` (#2945-deferred), 1
  each arrow-value / tail-expr / if-cond / if-else-nontail / assign-nonprop
  / vardecl-call / cloop-guard / instanceof.

### What the bucket actually is (grounded by the Step-1 histogram)

17 of 31 `body-shape-rejected` functions reject on host-global member access in
`const` initializers — all DOM: `const host = document.body` (13
`PropertyAccessExpression`) and `const box = document.createElement("div")` (4
`CallExpression`). The receiver identifier (`document`, `window`, …) is a host
ambient global, so `isPhase1Expr`'s identifier arm rejects it
(`scope.has("document") === false`, `select.ts` ~line 1594), which cascades: the
property-access / call arm rejects because its receiver sub-expression isn't
Phase-1. There is **no bounded partial** that flips these without an actual
extern host-object member-access path in the IR (the `Math.*` unary whitelist
`IR_MATH_UNARY_WHITELIST` and the extern-_class_ `new`/`getExternClassInfo`
slice-10 machinery do NOT cover ambient host-object receivers).

### The representation (front-end axis — IR, backend-agnostic)

The IR type system already has the pieces (no new IrType needed):

- `IrType` `{ kind: "extern"; className: string }` (`nodes.ts:225`) — already
  used for slice-10 extern-class instances (RegExp, Uint8Array). A host-global
  receiver resolves to this with a synthetic className (e.g. `"HostGlobal"` or
  the ambient symbol name `"Document"`).
- `ValType` `ref_extern` / `externref` (`types.ts:165-166`) — the lowered carrier.
- `Instr` already has `extern.convert_any` / `any.convert_extern` (`types.ts:327`).

Add two IR **node kinds** (in `nodes.ts`), both carrying an `extern` result type:

1. `HostMemberGet { recv: IrExpr; name: string }` — `document.body`.
2. `HostMethodCall { recv: IrExpr; name: string; args: IrExpr[] }` —
   `document.createElement("div")`.

`recv` is itself an IR expr that resolves to an extern (the host-global
identifier, lowered to a `__get_globalThis`-style host handle — see
`identifiers.ts:825-831` for the legacy `globalThis` handle the receiver reuses).

**Effect annotation (coordinates with #2134 IR effect model).** Host member
reads and host calls are **effectful/opaque**: they may observe or mutate host
state and must NOT be reordered, CSE'd, or dropped-if-unused by any IR pass. Mark
both new nodes with an `effect: "host"` (or the #2134 effect lattice's top
element) so the IR scheduler treats them as ordering barriers. This is the one
genuinely new IR-semantics addition; get it reviewed against #2134's model before
lowering work. Until #2134 lands, the conservative stance is "never reorder a
host node relative to any other host node or side-effecting node" — encode that
as a pinned/sequenced flag on the node.

### Lowering (backend axis — differs ONLY at lower.ts / codegen-linear)

Per the north star (everything routes through IR; backends differ only at
lowering), the two new nodes lower differently per backend but are represented
once:

- **WasmGC (`src/ir/lower.ts`, JS-host lane):**
  - `HostMemberGet` → the existing host dynamic-get path: `recv` (externref) →
    `__extern_get(recv, nameGlobal)` → externref. Reuse the exact import +
    string-constant-global machinery the legacy `expressions/property-access.ts`
    emits for `document.body` today (do NOT invent a new import — resolve the
    same `__extern_get` via `ensureLateImport`, and mind the funcIdx-shift
    discipline: `__extern_get` is a late import, so its idx must flow through
    `funcMap`, never a cached number — this is the #2941 lineage, keep it
    name-based).
  - `HostMethodCall` → `__proto_method_call(recv, nameGlobal, argsVec)` (or the
    exact host-method-call import the legacy call path uses — confirm in
    `expressions/calls.ts`). Args lower as IR exprs coerced to externref.
  - Result stays `extern`; a `const x = document.body` binding gives `x` IrType
    `extern`, which the IR already carries through locals/returns.

- **Linear / standalone (`src/codegen-linear` + the standalone gate):** there is
  **NO host** — `document.*` cannot be satisfied. **Dual-mode rule:** this is not
  a "new host import without a standalone story" violation because the standalone
  story is the _existing_ #1472 refusal — `HostMemberGet`/`HostMethodCall` on a
  host-global receiver must route to the same compile-time refusal the legacy
  standalone path already emits (`STANDALONE_REFUSED_IMPORT` → `__extern_*`
  refusal in `late-imports.ts`). So: the IR **selector** may only claim these
  nodes when NOT `noJsHostTarget(ctx)`; under standalone/wasi the function stays
  `body-shape-rejected` → host path → the existing clean #1472 refusal. Net: the
  bucket reaches zero **in the JS-host lane** (which is what the playground/
  website example corpus targets — it runs in the browser); standalone keeps its
  honest refusal. Document this scope explicitly in the ratchet note: the
  `body-shape-rejected` STRICT promotion applies to the JS-host lane; a
  standalone `document.*` legitimately routes to `deferred`, not `unintended`.

### Selector change (`select.ts`)

`isPhase1Expr` gains a host-global-receiver arm, gated on JS-host mode:

- Recognise a host-global receiver: an identifier whose checker symbol resolves
  to an **ambient `declare` global** (lib.dom.d.ts / lib.es\*.d.ts) rather than a
  local binding. Prefer the checker (`ctx.checker.getSymbolAtLocation` →
  `symbol.declarations` has an ambient/`.d.ts` source) over a hardcoded name
  list — a hardcoded `{document,window,console,performance}` set is the
  fallback if the checker resolution proves flaky, but the checker path
  generalises to any host global and avoids a maintenance list.
- `PropertyAccessExpression` with a host-global receiver + Identifier name →
  accept (lower to `HostMemberGet`).
- `CallExpression` whose callee is `<host-global>.<method>` → accept (lower to
  `HostMethodCall`); args must be Phase-1.
- **`whyNotIrClaimable` must stay in lockstep with `from-ast.ts`** — this is the
  #2135 (single capability predicate) concern, and it is **load-bearing here
  because of #2138** (see next).

### Coordination with #2138 (compile-once inversion) — SEQUENCING DEPENDENCY

Under `#2138` Slice 2 (`JS2WASM_IR_FIRST`), a fully-claimed function's legacy
body is **skipped** (placeholder `unreachable`) and only the IR overlay fills it.
So a function this slice claims for host-global access **must be genuinely
IR-lowerable end-to-end** — if `select.ts` claims it but `from-ast.ts` throws
(select↔builder drift), under IR-first that is a **live `unreachable` trap**, not
a silent demote. Two hard requirements:

1. **select↔from-ast parity is mandatory, not nice-to-have.** Every shape
   `isPhase1Expr` accepts here, `from-ast.ts` MUST lower without throwing. Add
   the parity to the #2135 predicate if #2135 lands first; otherwise mirror the
   accept/throw sites exactly and add a parity test (compile each of the 17
   corpus functions through `from-ast` and assert no throw).
2. **Explicit sequencing:** land this slice's `from-ast` lowering + parity
   **before** #2138 Slice 2 adds host-global-reading functions to its
   `skippable` set — OR, if #2138 Slice 2 lands first, its skippable-closure
   computation must exclude any function whose claim depends on a host node
   until this slice proves the lowering. Note in #2138 Slice 2's trap list:
   "host-global member reads (#2856) are only skippable once their IR lowering
   is proven — until then treat a host-node-claiming function as non-skippable."
   Cross-reference both directions (added to this issue; #2138 owner to mirror).

Because #2138 is itself `blocked_by: [2167]` (Fable gate), this slice is not
blocked ON #2138 — it can land first and _reduce_ #2138's risk (one fewer
select↔builder drift class). Recommended order: **this slice → #2135 →
#2138 Slice 2**.

### Decomposition into dev slices

1. **`HostMemberGet` (property read)** — the 13-function majority.
   selector arm + `nodes.ts` node + `lower.ts` WasmGC `__extern_get` lowering +
   from-ast parity + JS-host-only gate. Ratchet `body-shape-rejected` down ~13.
2. **`HostMethodCall`** — the 4 `document.createElement(...)` cases. Adds the
   host-method-call lowering + args. Ratchet down ~4.
3. **STRICT promotion** — once the JS-host-lane bucket is zero for these,
   scope-add `body-shape-rejected` to `STRICT_IR_REASONS` **for the JS-host lane**
   (verify the standalone-refusal path still routes `document.*` to a graceful
   CE, not a STRICT hard-error). Promote `plan/log/ir-adoption.md` rows.

Each slice: verify adopted functions **actually take the IR path** — re-run
`JS2WASM_IR_SHAPE_DIAG=1 pnpm run check:ir-fallbacks -- --shape-diag` and confirm
the target functions leave the `body-shape-rejected` set (not merely that tests
stay green — the hazard is a silent legacy fallback keeping tests green while the
IR path is NOT exercised). Full `merge_group` validation, not a scoped sample
(broad-impact rule).

### Constraints honored (coordinator's checklist)

- **(a) North star:** the two host nodes are IR-represented once; WasmGC lowers
  to `__extern_get`/host-call, linear/standalone routes to the existing #1472
  refusal — backends differ only at lowering, nothing bypasses IR.
- **(b) #2138:** select↔from-ast parity is made mandatory (a wrong claim traps
  under IR-first); explicit two-way sequencing note added; recommended order
  puts this slice before #2138 Slice 2.
- **(c) Dual-mode:** no NEW host import — reuses the existing `__extern_get` /
  host-method-call imports; the standalone story is the existing #1472 refusal,
  so the JS-host claim never leaks an unsatisfiable import into a standalone
  build.

### Smaller dev-sized arms (leave for dev-lane pickup — NOT this slice)

From the same histogram, independent of extern-in-IR, mechanical additions:

- `vardecl-typenode:ArrayType` (2) — `const x: number[] = …`: widen
  `isPhase1TypeNode` to accept array type annotations (the value already lowers).
- `body-unhandled-stmt:IfStatement` (3) + `nontail-unhandled-stmt:IfStatement`
  (1) + `nontail-if-cond` (1) + `tail-unhandled` (1) — `if`/`else` at
  constructor-body / non-tail positions; a from-ast `if`-statement handler in
  body-statement position. NB `binarySearch` has a `return` INSIDE a while
  loop — the lowering must handle early-exit-from-loop, not just
  statement-shaped conditionals.
- **Module-scope bindings (3)** — `fibCache` / `gridEl` / `selStart` (see the
  leaf-level attribution above): the selector's scope set only holds
  params/locals, so module-level `let`/`const` references reject. Needs a
  module-scope binding set threaded into the shape walk + IR module-global
  read/write lowering that shares the SAME storage slots the legacy backend
  allocates (the two front-ends coexist per function — a module global written
  by an IR function and read by a legacy one must be one location; add a mixed
  IR/legacy read-write equivalence test).
- Private-field member access (2) — `this.#name` read/write in
  `js/classes.ts` (`Animal_new`/`Animal_speak`); `ts.PrivateIdentifier` is not
  an `Identifier`, both property arms reject on the name check.
- `unattributed-arm:helper-internal` (4) — instrument
  `isPhase1ObjectLiteral`/`TryStatement`/`ClosureLiteral`/`ForStatement`
  internals (Step-1b) to sub-attribute, then handle. (The class-member pair is
  already identified as the private-field arm above.)
  These ~9 are dev-lane; the coordinator authorized folding at most ONE trivial arm
  as a recorder-discipline validation slice — deferred here to keep this a
  docs-only spec PR.

**Dispatch note (2026-07-02, dev-2856f):** these arms were drafted as three
child issues, but the ids allocated for them (2939/2940/2941) were lost to a
cross-session allocation race (those ids now name unrelated issues on `main`),
and the allocator ref is under heavy multi-agent contention — so the arms stay
in-file for now. When splitting them out, get fresh ids via
`claim-issue.mjs --allocate` and carry over the ⚠ contagion sequencing
constraint above (an arm landed before extern-in-IR must prove
`call-graph-closure` does not grow).

## Step-2 root-cause analysis (2026-07-03, sr-bodyshape2) — the "dev-sized arms" framing is EMPIRICALLY DISPROVEN; no single mergeable PR can reduce this bucket

Re-grounded from a clean `upstream/main` (@ 93ab47912). Confirmed the extern-in-IR
Slice-1 (#2454's recorder + `2fcfbe06a`) **did** land and the baseline is now
`body-shape-rejected: 25 / call-graph-closure: 10 / class-method: 5` (the 31→25
reduction is banked — the "reduction never happened" premise some dispatch notes
carried is stale). Fresh `JS2WASM_IR_SHAPE_DIAG=1 pnpm run check:ir-fallbacks -- --shape-diag`
histogram of the current 25:

| count  | reject arm                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | functions                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 8      | `nontail-callstmt:CallExpression`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | the 8 benchmark-harness `main`s (benchmarks.ts, benchmarks/{array,dom,fib,loop,string,style}.ts, js/builtins.ts) |
| 4      | `unattributed-arm:helper-internal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | calendar `updFoot`, async `delay`, classes `Animal_new`/`Animal_speak`                                           |
| 3      | `body-unhandled-stmt:IfStatement`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | algorithms `binarySearch`/`quicksort`/`joinNums`                                                                 |
| 2      | `vardecl-typenode:ArrayType`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | benchmarks.ts + benchmarks/array.ts `bench_array`                                                                |
| 1 each | `expr-unhandled:ArrowFunction` (helpers `addBenchCard`), `tail-unhandled:ExpressionStatement` (calendar `fdow`), `nontail-if-cond:BinaryExpression` (calendar `renderCal`), `nontail-unhandled-stmt:IfStatement` (calendar `onDay`), `nontail-assign-nonprop-lhs:BinaryExpression` (calendar `main`), `vardecl-init-expr:CallExpression` (algorithms `fibMemo`), `expr-arraylit-cloop-guard-1804:ArrayLiteralExpression` (algorithms `main`), `expr-binary-op-instanceof:BinaryExpression` (classes `main`) | —                                                                                                                |

### The two structural blockers that make every "dev-sized arm" a dead end

**(1) Demotion is contagious (verified in source, `select.ts:492-518`).** Step-2's
`call-graph-closure` fixpoint removes ANY shape-claimable function whose local
caller OR callee is unclaimed. `buildLocalCallGraph` (`select.ts:2193-2198`) only
creates edges for real `CallExpression`s with a local-decl callee — a function
passed _by reference_ (e.g. `addBenchCard(…, bench_fib)`) or called _inside a
nested arrow_ (`select.ts:2164` does not descend into nested function-likes) is
**not** an edge. Consequence: fixing a leaf statement/expression arm inside a
function whose call-component root (`main`) stays unclaimed does not reduce the
gated total — it **moves** the count from `body-shape-rejected` into
`call-graph-closure`, and the gate fails on that bucket's growth. So the unit of
reduction is a **whole call-component**, never a single arm.

**(2) The gate compiles each corpus file as a per-file program**
(`scripts/check-ir-fallbacks.ts:217` — `ts.createProgram([filePath], …)`). Imports
from sibling modules (`el`, `addBenchCard` from `benchmarks/helpers.ts`) are
therefore genuinely **external**, landing in the `external-call` bucket.

### Empirical proof that the highest-value arm is net-zero

Temporarily accepting _any_ out-of-scope identifier in `isPhase1Expr` (the
"top-level function passed as a `() => number` value" arm the 8 benchmark `main`s
need) moved the gate to:

```
body-shape-rejected   25 → 17   (-8)      ← the 8 benchmark mains leave body-shape
external-call          0 →  7   (+7)      ← …but land here (imported el/addBenchCard)
call-graph-closure    10 → 11   (+1)
```

Net unintended change: **0**. The gate FAILS on `external-call` + `call-graph-closure`
growth. So the benchmark `main`s' `body-shape` rejection is **blocked BY #2858's
domain (cross-module imported calls), not the reverse** — the dispatch claim that
#2858 is "blocked on #2856" is backwards for this cluster: they are mutually
entangled, and the benchmark mains need cross-module import lowering **and**
first-class function-reference (closure-wrap ABI) lowering **together** before
they can leave any unintended bucket.

### Per-cluster capability requirements (each is a WHOLE-COMPONENT slice)

- **Benchmark harness (8 `main`s + `helpers.ts`):** cross-module imported-call
  lowering (#2858 / `external-call`) **+** top-level-function-reference as a
  first-class `() => T` value (closure/`$__fn_wrap` ABI parity with legacy —
  see `builtin-fn-meta.ts`, `closures.ts`) **+** the `addEventListener(…, () => …)`
  arrow-closure value in `addBenchCard`. Contagion-safe leaves, but multi-capability.
- **`bench_array` ×2 (contagion-safe leaves):** `ArrayType` annotation
  (`isPhase1TypeNode`, trivial) **+** empty-array-literal + **growable-array
  `.push`** (IR from-ast/lower have NO `.push` method arm — verified) **+** the
  #1804 C-style-loop vec-SSA-threading correctness fix (the guard at
  `select.ts:1967` protects a real lowering bug, not a shape check). Widening
  `isPhase1TypeNode` alone is a no-op: `bench_array` immediately falls through to
  `expr-arraylit-cloop-guard-1804` (verified).
- **algorithms.ts (5 fns, one call-component rooted at `main`):**
  `if`-in-non-tail-body-statement selector arm (`isPhase1BodyStatement` has no
  `IfStatement` arm — `select.ts:1407`) **+** element-store `arr[i] = e`
  (quicksort) **+** module-scope `Map` global with `.get`/`.set` sharing the
  legacy backend's storage slot (fibMemo) **+** array-literal-under-C-style-loop
  SSA (main's `const sorted = […]`). All pure computation (no host/closure), the
  most self-contained cluster, but ≥3 real capabilities that MUST land together.
- **classes.ts (3 fns):** `#private` field read/write (`ts.PrivateIdentifier`
  is not an `Identifier`) **+** `instanceof` (`isPhase1BinaryOp` rejects it) **+**
  `super`/inheritance interplay.
- **calendar.ts (5 fns):** module-scope **mutable** bindings (`selStart`, `gridEl`,
  …) **+** DOM member chains **+** if-in-body **+** `new Date()`.
- **async.ts `delay`:** `new Promise((resolve) => …)` executor closure (borders
  the `deferred`/async lane).

### Why NO incremental capability PR is mergeable against this corpus

Because the gate ratchets on this fixed corpus, any capability a
contagion-locked corpus function needs (e.g. the `if`-in-body arm, which is
genuinely useful and reusable) **cannot** be added incrementally: relaxing the
selector for it flips `binarySearch`/`quicksort`/`joinNums` to shape-claimable,
which the `call-graph-closure` fixpoint then demotes (their `main` is
unclaimable) — the gate fails on `call-graph-closure` growth. Verified by
inspection of the fixpoint. There is no corpus file whose whole call-component is
one capability away from fully claiming.

### Recommendation (routing)

`body-shape-rejected → 0` is **not a dev-lane ticket and not decomposable into the
"smaller dev-sized arms" listed in the earlier spec** — every one of those arms is
either contagion-locked to an unclaimable `main` or has a deeper co-blocker in the
same function. It is a **multi-capability program** that must be scheduled as
whole-call-component slices, several of which (cross-module calls, first-class
function values, growable arrays, module-scope mutable Map) are substantial IR
features in their own right and overlap #2858 (cross-module/`external-call`),
#2135 (capability predicate), #2138 (compile-once). Recommend PO/architect:

1. Re-scope #2856 as a **tracking epic** under #2855, not an executable ticket.
2. Cut capability sub-issues sized as whole-component slices, ordered by
   self-containment: **algorithms.ts** (pure-compute; `if`-in-body + element-store
   - Map-global + arraylit-SSA) is the cleanest first real reduction (−5, all
     contagion-internal to one file). The benchmark-harness cluster (−8) should be
     sequenced **after** #2858's cross-module-call lowering, since it is a hard
     dependency, not a dependent.
3. Do NOT dispatch the `ArrayType` / `if-in-body` / module-scope-binding arms as
   standalone dev tasks — each is provably net-zero-or-worse against the gate in
   isolation.

No source change accompanies this analysis (the gate stays at 25/10/5); this PR is
the corrected root-cause record so the team stops bouncing off the disproven
"arms" decomposition. Marking `status: blocked` (on the capability program /
#2858), `spec: needs-rescope`.

## Implementation Plan — algorithms.ts whole-component slice (−5, first real reduction)

**Author:** dev-team-c (2026-07-03), grounded against `origin/main` @ `17b09dd35`
(includes the Step-2 correction). Verified with
`JS2WASM_IR_SHAPE_DIAG=1 pnpm run check:ir-fallbacks -- --shape-diag`. This is
the first executable slice of the re-scoped capability program — the cleanest
because `website/playground/examples/js/algorithms.ts` has **zero imports**
(`grep '^import' → none`; only `export function main`), so its whole call-graph
is self-contained and its contagion is entirely **internal to one file** (unlike
the benchmark-harness cluster, which needs #2858's cross-module-call lowering
first).

### The call-component (must claim atomically — one PR)

`main` (the component root) calls `fibIter`, `fibMemo`, `joinNums`,
`binarySearch`, `quicksort`. `fibIter` already claims. The **five** functions
that currently reject (verified `--shape-diag`), and the capability each needs:

| function       | reject arm (current main)                               | capability required                                 |
| -------------- | ------------------------------------------------------- | --------------------------------------------------- |
| `fibMemo`      | `vardecl-init-expr:CallExpression`                      | **C3** module-scope `Map` global + `.get`/`.set`    |
| `binarySearch` | `body-unhandled-stmt:IfStatement`                       | **C1** if-in-body (+ early-`return`-in-loop)        |
| `quicksort`    | `body-unhandled-stmt:IfStatement`                       | **C1** if-in-body **+ C2** element-store `arr[i]=e` |
| `joinNums`     | `body-unhandled-stmt:IfStatement`                       | **C1** if-in-body                                   |
| `main`         | `expr-arraylit-cloop-guard-1804:ArrayLiteralExpression` | **C4** array-literal-under-C-loop SSA               |

⚠ **Contagion (read `## ⚠ Sequencing constraint` above): all four capabilities
must land in ONE PR.** The `call-graph-closure` fixpoint (`select.ts:492-518`)
demotes any claimable function whose local caller/callee is unclaimed. `main`
calls all five; fixing only some flips them to shape-claimable but `main` (still
rejecting on C4) then demotes the whole component — the gate **fails on
`call-graph-closure` growth**. The unit of reduction is the whole component. The
merge gate to satisfy: `body-shape-rejected 25→20 (−5)` with `call-graph-closure`
and `external-call` **unchanged** (net unintended −5); ratchet via
`check:ir-fallbacks -- --update-on-decrease`.

### C1 — `if`-in-non-tail-body-statement (+ early `return` inside a loop)

`isPhase1BodyStatement` (`select.ts:1315`) has arms for Block, VariableStatement,
ExpressionStatement, ForOf, While, For, Throw, Try — but **no `IfStatement`
arm**, so it falls to `shapeNo("body-unhandled-stmt", stmt)` (`select.ts:1408`).
A well-formed **tail** if already exists in `isPhase1Tail` (`select.ts:1430`:
requires `else`, recurses both branches as tails). The body form differs: an
`if` in statement position whose then/else are **statement lists** (not
tail-expressions), and — critically for `binarySearch`/`fibMemo` — whose branch
may contain an **early `return`** (`if (arr[mid] === t) return mid;` inside a
`while`; `if (hit !== undefined) return hit;`). `isPhase1BodyStatement` has no
`ReturnStatement` arm either.

- **Selector:** add `if (ts.isIfStatement(stmt)) return isPhase1IfBodyStatement(stmt, scope, localClasses)` before the final `shapeNo`. New helper: cond via `isPhase1Expr`; then/else recurse via `isPhase1BodyStatement` (else optional, unlike the tail form). Add a `ReturnStatement` arm to `isPhase1BodyStatement` (guarded: allowed only when a lowerable early-exit target exists — i.e. the enclosing lower context can emit a `br` to the function epilogue).
- **Lowerer (`from-ast.ts`):** the nested-buffer `if` lowering already exists for the tail path (`IrInstrIf` with nested then/else buffers, `forEachNestedBuffer`). The new work is **early-return from inside a nested buffer/loop**: lower `return e` in body position to eval `e` + `br` to the function's result/epilogue block. Verify the multi-exit path composes with the existing loop back-edge lowering (this is the `binarySearch` `return mid` inside `while` case). NB this borders #2952 (multi-exit control flow) — coordinate: if #2952's `IrInstrBrLabel` lands first, reuse it; else a scoped epilogue-br is sufficient here (single-level, no labeled target needed).

### C2 — element-store `arr[i] = e`

Element **read** `arr[i]` is accepted (`select.ts:1950`, `isPhase1Expr`) and
lowered (`from-ast.ts:2276` `lowerElementAccess`). The **store** is not: in
`isPhase1BodyStatement`'s ExpressionStatement→BinaryExpression→`EqualsToken` arm
(`select.ts:1343-1352`) the LHS is checked for `Identifier` and
`PropertyAccessExpression` only — an `ElementAccessExpression` LHS
(`arr[i] = arr[j]`, quicksort:66-67,70-72) falls through and rejects. And there
is **no `lowerElementStore`** in `from-ast.ts` (`grep lowerElementStore → none`).

- **Selector:** add an `ElementAccessExpression` case to the `EqualsToken` LHS
  check — accept when `expr.expression` and `expr.argumentExpression` are both
  `isPhase1Expr` (mirror the read guard at `select.ts:1950`).
- **Lowerer:** add `lowerElementStore(expr, valueId, cx)` — the write dual of
  `lowerElementAccess`; emit `vec.set` (WasmGC array `array.set`; linear
  backend the store dual) with the i32-coerced index, reusing the in-bounds
  reasoning path (`isProvenInBoundsIr`, `from-ast.ts:2179`). No new host import.

### C3 — module-scope `Map` global + `.get`/`.set`

`fibMemo` rejects at `vardecl-init-expr:CallExpression` on
`const hit = fibCache.get(n)` because (a) `fibCache` is a **module-scope**
binding (`const fibCache = new Map<number,number>()`, algorithms.ts:25) not in
the function's scope set — the selector's scope set holds params/locals only —
and (b) `Map.get`/`Map.set` are method calls the IR does not yet lower. This is
the substantial capability of the slice.

- **Module-scope binding set:** thread a module-level binding set (the `const`/
  `let` names declared at module scope) into the shape walk so member/reference
  access to `fibCache` is in-scope. Must NOT admit arbitrary module globals as a
  side effect — scope it to bindings with a proven IR-lowerable representation.
- **Storage-slot parity (the hazard):** IR module-global read/write MUST share
  the **same storage slot the legacy backend allocates** for `fibCache` — the two
  front-ends coexist per function (a global written by an IR function and read by
  a legacy one must be one location). Add a **mixed IR/legacy read-write
  equivalence test** (`tests/ir-*.test.ts`): a module global written by an
  IR-claimed function and read by a legacy-compiled one round-trips.
- **`Map` lowering:** lower `new Map()`, `.get(k)` (returns value-or-`undefined`),
  `.set(k,v)`. If a native `Map` substrate is absent in the IR, this pairs with
  the object/Map runtime — confirm the legacy backend's `Map` representation and
  emit the identical calls/slots (byte-parity per mode). **This is the item most
  likely to need its own predecessor sub-issue** if the `Map` runtime is not yet
  IR-reachable — measure first; if `Map` lowering is out of reach, the component
  cannot claim and this whole slice defers behind a `Map`-in-IR capability.

### C4 — array-literal under C-style loop (SSA threading)

`main` rejects at `expr-arraylit-cloop-guard-1804` (`select.ts:1967`): the #1804
guard **withholds** the claim whenever the function contains a C-style
`while`/`for` loop, because a constructed vec read inside such a loop fails SSA
hygiene (the vec value isn't threaded into the loop's cond/body blocks — distinct
from the working `for-of` vec path). `main` has both `const sorted = [1,3,…]`
(algorithms.ts:99) and C-style `for` loops.

- The guard protects a **real lowering bug**, not a shape gap — the fix is to
  **thread the constructed-vec SSA value into the loop cond/body blocks** so the
  vec identity is stable across the back-edge (the same class as the #2784 S3
  vec-identity fix). Once threaded, lift the guard for the threaded case.
- If the SSA-threading fix is larger than this slice can absorb, an acceptable
  fallback that still claims `main`: hoist/represent the literal so it is not
  read _through_ the C-loop region — but the guard exists precisely because that
  is unsound in general, so **prefer the SSA-threading fix**; do not just delete
  the guard.

### Ordering, sizing, verification

- **Order within the PR:** C2 (smallest, self-contained) → C1 (if-in-body +
  early-return, reused by 3 fns) → C4 (SSA threading) → C3 (Map + module-global,
  the gate). Land as ONE PR; the ratchet only moves when all five claim.
- **Sizing / routing:** whole-component, **feasibility hard, ~L, senior-dev** —
  C1's multi-exit and C3's Map-runtime + storage-slot parity are each real IR
  capabilities. NOT a single-window dev slice; schedule at a **fresh budget
  window** (big-rock). If C3's `Map`-in-IR proves out of reach on a measure-first
  probe, split C3 into a predecessor `Map`-in-IR sub-issue; note that C3 is on
  the critical path for the whole component (`main` calls `fibMemo`, so `fibMemo`
  must claim for `main`'s component to claim), so the whole slice waits on it —
  measure before committing.
- **No-regression bar:** `body-shape-rejected 25→20`, `call-graph-closure` and
  `external-call` unchanged (net unintended −5); `pnpm run check:ir-fallbacks`
  green locally before push; `tests/ir-*.test.ts` green; per-mode lowered bytes
  for every already-claimed function unchanged (byte-parity); test262 conformance
  net-neutral-or-positive.
- **Promotion:** this slice does NOT reach `body-shape-rejected: 0` on its own
  (20 remain: benchmark-harness −8 behind #2858, calendar/classes clusters). It
  is the first `−5`. `STRICT_IR_REASONS` promotion (acceptance #3 of the epic)
  waits until the whole bucket is 0.

### Files

- `src/ir/select.ts` — `isPhase1BodyStatement` (:1315, add IfStatement + Return
  arms), `EqualsToken` LHS ElementAccess case (:1343), module-scope binding set,
  `expr-arraylit-cloop-guard-1804` guard (:1967).
- `src/ir/from-ast.ts` — new `lowerElementStore`; early-`return`-in-body lowering;
  Map `.get`/`.set`/`new Map` lowering; module-global read/write.
- `src/ir/lower.ts` / `src/codegen-linear/` — backend duals for element-store,
  module-global, Map (WasmGC vs linear differ only here).
- `tests/ir-algorithms-cluster.test.ts` (new) — per-capability claim tests +
  the mixed IR/legacy module-global round-trip equivalence test.
- `scripts/ir-fallback-baseline.json` — ratchet `body-shape-rejected` 25→20.

## Slice RESULTS — algorithms.ts whole-component (2026-07-04, fable-2856exec)

**Gate: `body-shape-rejected` → 18, `call-graph-closure` → 9, `class-method`
unchanged, post-claim demotions ZERO.** Relative to the pre-slice base
(23/10/5) that is −5/−1; relative to post-#2952-slice-2 main (22/11/5, which
this branch merged mid-flight) it is −4/−2. Net unintended 38 → 32 either
way, banked in `scripts/ir-fallback-baseline.json`. (The plan's "25→20"
numbers were grounded pre-#3000; the private-field pair had already cleared.)
Whole-file verification: `js/algorithms.ts` IR-vs-legacy **console output
identical (20/20 lines)**, zero demotions; standalone + wasi compiles stay
clean (host-gated arms defer → legacy, as designed).

### What landed, per capability (and WHY it's shaped that way)

- **C1 — `if.stmt` + `early.return` IR instrs** (`nodes.ts`): statement-level
  `if` (else optional, no carrier values — the #1392 value-`if` requires
  both) and early-return (lowers to the Wasm `return` op, which natively
  unwinds the `block{loop{…}}` nesting). Soundness scope is selector-enforced
  and mirrored in from-ast (`cx.noEarlyReturn` / module-level
  `earlyReturnLoopDepth`/`BarrierDepth` counters): early return is accepted
  ONLY inside C-style `while`/`for`/`do` bodies with NO enclosing for-of
  (iterator `return()` cleanup would be skipped), try/catch/finally (inlined
  finally skipped), constructor (implicit `return this` synthesis), or
  generator (buffer epilogue). A regression test pins the try/finally case to
  legacy. Both kinds are excluded from `inline-small` (buffer-bearing /
  caller-exit).
- **C2 — element store** via an on-demand `__vec_elem_set_<vecTypeIdx>`
  helper (`src/codegen/vec-elem-set.ts`, materialized through the
  `resolveFunc` intercept like `ensureFmod`, #2945). NOT a new IR instr and
  NOT a bare `array.set`: the helper carries the FULL legacy semantics
  (null-guard → throw, grow-on-OOB with capacity doubling + copy, length
  update) because the growing write (`a[i] = v` past the end) is common in
  newly-claimable code — a bare store would trap. Pure WasmGC, no host
  import (dual-mode clean). TypedArray-view receivers demote
  (per-view ToUint8/clamp conversions stay legacy); selector restricts the
  receiver to a plain in-scope identifier.
- **C3 — module-scope Map** WITHOUT a Map-in-IR predecessor: module-level
  statements always compile via legacy, so `const m = new Map()` already has
  a legacy `__mod_<m>` externref global + `Map_new/Map_get/Map_set` extern
  imports (JS-host lane). The IR side only needed: (a) a TDZ-checked
  `global.get $__mod_<m>` branded `extern:Map` in the identifier arm
  (storage-slot parity BY CONSTRUCTION — same global, name-resolved), after
  which `.get`/`.set` ride the existing extern method-call machinery; (b)
  `f64→externref` arg boxing via `__box_number` and `externref→f64` return
  unboxing via `__unbox_number` in the coercion arms (exactly legacy's
  emission for the same sites, so the imports are registered by legacy's own
  compile of the function — dual-compile model); (c) strict undefined-compare
  (`hit !== undefined`) → `__extern_is_undefined` on externref-shaped
  operands, constant-fold on never-undefined representations. LOOSE `==
undefined` stays legacy (null == undefined needs a null check). Host lane
  only — standalone's native Map runtime is NOT wired; fibMemo correctly
  demotes there (the selector's Map-const set is empty outside the host
  lane, so no claim-then-fail).
- **C4 — #1804 guard retired**: the unsound shape it protected was fixed by
  the slice-12 buffer machinery (synthetic −1 block-id use recording
  materializes the constructed vec into a local before the loop op).
  Verified with a 7-shape battery (read-in-body/cond, construct-in-body,
  after-loop, nested, do-while, store-in-loop), each proven CLAIMED via
  byte-diff (not vacuously green). Plus: call-arg `ref → ref_null` widening
  (`irTypeArgAssignable` — a vec literal is `(ref $vec)`, params are
  `(ref null $vec)`), and statement-position VOID direct calls
  (`quicksort(arr, lo, p-1);` — `lowerCall(…, statementPosition)`).

### Two latent lower.ts/passes bugs found & fixed en route

1. **`inline-small` corrupted value-`if` arm buffers** — `renameAllInInstr`
   doesn't deep-rename arm-buffer DEFS, so inlining a single-block callee
   containing an `if` (any bounds-checked `a[i]` read emits one) produced
   duplicate SSA defs → silent post-inline demote. Latent on main (the
   ref/ref_null arg mismatch demoted such callers at build first); exposed by
   C4's widening. Fix: `if` joins the buffer-bearing exclusion list in
   `canInline`.
2. **Nested-buffer emission silently DROPPED zero-use side-effecting
   instrs** — all seven buffer-emission loops in `lower.ts` (loop bodies,
   for-of bodies, try bodies, if arms) lacked `emitBlockBody`'s
   "zero uses + side-effecting → eager emit + drop" arm, so a statement call
   with an unused non-void result inside a loop body (e.g.
   `shared.set(k, v)` — Map_set returns the map) emitted NOTHING. Caught by
   the mixed-front-end storage-parity test (IR writer's write never
   happened). Fix applied uniformly to all seven sites.

### Verification record

- `tests/ir-algorithms-cluster.test.ts` (new, 18 tests): per-capability
  legacy/IR parity, each claim-proven via byte-diff (anti-vacuity); growing
  store; mixed IR-writer/legacy-reader Map storage parity; try/finally
  early-return negative; whole-component e2e console equality; standalone/
  wasi cleanliness.
- IR suite (`tests/ir-*`, issue-\*-ir tests): per-file failure counts
  IDENTICAL to pristine main (the ~81 container-env failures are
  pre-existing; verified side-by-side) except `ir-scaffold`'s expected-claims
  list, updated for `withWhile` (legitimate capability growth).
- Byte-inertness for non-claimed programs: by construction — no legacy
  codegen path was modified (the only `src/codegen/` change is the NEW
  helper file, reachable only from the IR resolver).

### Epic status after this slice

`status: blocked` stands for the EPIC (bucket 18, not 0): the remaining
clusters are the benchmark-harness 8 (hard-blocked BY #2858 cross-module
calls + first-class function values), bench_array ×2 (ArrayType annotation +
`.push` growable-array IR), calendar 5 (mutable module-scope bindings + DOM
chains), classes.ts main (`instanceof`), async delay (Promise executor).
This slice (−5 algorithms.ts component + −1 call-graph bonus) is merged
work; the next executable slice per the Step-2 ordering is the
benchmark-harness cluster AFTER #2858.

### Post-merge reconciliation with #2952 slice 2 (same-day upstream landing)

#2952 slice 2 landed mid-flight with a CONVERGENT `if.stmt` design (identical
node shape) plus `br.label` break/continue and a ctrlStack depth resolver.
Reconciliation on this branch: upstream's `if.stmt` + `emitBufferAsStatements`

- ctrlStack machinery adopted wholesale (their arm pushes the plain CtrlFrames
  br.label depth-derivation needs; their `lowerIfBodyStatement` also upgrades
  the cond to truthiness via `coerceLoopCondToBool`); my duplicate `if.stmt`
  implementation deleted at every layer; `early.return` (mine alone) kept and
  now rides their emission helper. The #2856 zero-use side-effect fix collapsed
  from seven emission-loop sites into upstream's single `emitBufferAsStatements`
  (+ the remaining per-arm loops). Early-return barriers and #2952's `inLoop`
  threading coexist: break/continue may cross a try (br.label inlines crossed
  finallys) while early-return stays barred there. Verified post-merge:
  gate 18/9/5, cluster suite 18/18, #2952 suite 27/27, and a combined probe
  (`continue` + early `return` + `break` in one loop) claims with legacy parity.

### Post-slice regression caught by the equivalence sweep (fixed in-branch)

`void x === undefined` — the undefined-compare constant-fold was initially
REP-based (f64 can't hold undefined), but the IR erases `void x` (static type
`undefined`) into f64 NaN, folding the comparison to false where JS says
true. Fix: the fold now ALSO requires the checker's static type to exclude
undefined/void/any/unknown; undefined-able static types demote to legacy
(which tracks undefined-ness). Full `tests/equivalence/` sweep on the final
tree matches the pristine-main baseline (all remaining failures pre-existing
container-env issues, verified side-by-side).

## Slice RESULTS — bench_array ×2 (2026-07-10, fable-2856): `number[]` annotation + `arr.push` + sibling-loop counters

**Gate: `body-shape-rejected` 17 → 15 (−2); all other buckets unchanged;
post-claim demotions ZERO.** Banked via `--update-on-decrease`. Grounded
against `origin/main` @ d7a1feaa1c (post-#2858: `call-graph-closure` is 0 and
the caller-direction demotion arm is gone, so leaf claims like `bench_array`
are contagion-safe — the unclaimed `main`s no longer pin their callees).

### What landed (three small capabilities, one PR)

- **`number[]` type annotation** — `isPhase1TypeNode` accepts an
  ArrayTypeNode with a NumberKeyword element; `lowerVarDecl` resolves it via
  `resolveVecForElement(f64)` to the vec struct-ref IrType. That ref is the
  hint an EMPTY literal initializer (`const arr: number[] = []`) needs to
  type its `vec.new_fixed` (the machinery existed; only the hint threading
  from an array annotation was missing). f64 element only — `string[]` /
  `boolean[]` carriers are backend-dependent, deferred.
- **`arr.push(v)`** (`lowerMethodCall` vec arm) — rides the C2
  `__vec_elem_set_<vecTypeIdx>` helper: a store at index == length IS push
  (null-guard, grow-on-capacity with doubling + copy, store, length update —
  full legacy parity, pure WasmGC, dual-mode clean). Old length is read
  BEFORE the store; expression position returns old + 1 (JS's new-length
  result). Residuals that demote: multi-arg push, spread, non-f64/externref
  element vecs, and NULLABLE receivers (`ref_null`, e.g. unnarrowed params —
  `emitVecLen` struct-reads without a null guard, so those keep legacy's
  runtime TypeError).
- **Sibling `for (let i...)` loops** — the selector's flat scope set leaks
  each for-init counter into the outer scope (so post-loop reads stay
  claimable), which made a SECOND sibling `for (let i...)` a false
  "duplicate" reject. from-ast scopes each for-init in its own `innerCx`
  copy (`lowerForStatement`), so the shadow is build-safe. Fix: leaked names
  are tracked (`forInitLeakedNames`, reset per function walk) and only
  GENUINE outer bindings still reject — mirroring `lowerVarDecl`'s
  redeclaration throw exactly (select↔build parity, #2138).

### Verification record

- `tests/issue-2856-vec-push.test.ts` (new, 9 tests): legacy/IR parity for
  each capability, every positive claim proven via byte-diff
  (anti-vacuity); grow path; expression-position push return value;
  multi-arg-push clean demote; genuine-shadow negative; standalone + wasi
  compile cleanliness (no host import — the helper is pure WasmGC).
- bench_array e2e: IR-vs-legacy both return 49995000 (10k push + sum),
  claimed (byte-diff), zero demotions.
- `tests/ir-scaffold.test.ts` failure count IDENTICAL to pristine main at
  d7a1feaa1c (2 pre-existing container-env failures, verified side-by-side);
  `tests/ir-algorithms-cluster.test.ts` 18/18.

### Remaining (13 after this slice, by cluster)

benchmark-harness 8 `main`s + `addBenchCard` (first-class function values +
arrow closure args + cross-module imported calls — the multi-capability
program from Step-2), calendar 4 (module-scope MUTABLE bindings + DOM
chains + if-shapes), classes.ts `main` (`instanceof`), async `delay`
(Promise executor). Epic stays `blocked` on those capability programs.

## from-ast overlay-bug fix — structurizer `materialized` leak (2026-07-13, opus-2856)

Fixed the **from-ast overlay soundness bug** flagged from PRs #2966/#3203 (the
`classify` "undefined SSA value" overlay) and #2972/#3204 (`Math.log(2.414)`
returned `log(2)`; worked around with ternary-init `over`/`ea`/`fa` locals).

### Root cause — a lower.ts structurizer bug, NOT a from-ast/select gap

The from-ast IR is **correct**. `lowerStatementList`'s non-terminating mid-body
`if (cond) { <side effect> } <rest>` rewrite (from-ast.ts ~811) builds a
`br_if → thenBlock; thenBlock br→ contBlock; contBlock=<rest>` CFG. `contBlock`
(the continuation holding `<rest>`) is reached from BOTH the then-block's `br`
and the `br_if`'s false edge, so it is a **merge block**.

The lowerer's structurizer (`emitBlockBody`, lower.ts ~2985) has no shared-merge
emission — its `br`/`br_if` handlers **tail-duplicate** every successor inline.
So `contBlock` is emitted once into the then-arm sink and again into the
else-arm sink. An **intra-block multi-use** value defined in `contBlock` (e.g.
`let t = f*f` used twice by `let t2 = t*t`) is materialized **lazily** via
`local.tee` on first use, gated on the function-**global** `materialized` set.
The then-arm copy tee'd `t` and added it to `materialized`; the else-arm copy
then saw `t ∈ materialized` and emitted a bare `local.get` for a local the
else runtime path **never set** → silent `0` (or an "undefined SSA value" throw
when the leaked value is a cross-block def, the #3203 manifestation).

Verified in the WAT: pre-fix the else arm read `local.get $t` without the
preceding `f*f; local.tee $t` def; post-fix it recomputes it.

Why prior probes mislocated it as "mis-scopes a let into the then-branch": the
observable symptom (the trailing `let` "disappears" on the not-taken path) looks
like scope folding, but the IR scope is right — it is the emitter that drops the
def in the duplicated copy.

### Fix (`src/ir/lower.ts`, br_if handler)

The two arms are **separate runtime paths**. `materialized` means "this value's
local is assigned on the CURRENT path". Snapshot it at the branch and restore to
that snapshot before emitting each arm (and after the `if`), so each path
re-materializes its own intra-block locals. Values materialized BEFORE the
branch stay live in both arms (they are in the snapshot); cross-block values are
re-emitted eagerly in each copy's instr loop as before. ~15 lines, localized to
the one duplication site (the sole tail-dup origin is a `br_if` fork).

### Scope note — this does NOT reduce the corpus `body-shape-rejected` count

Grounding `JS2WASM_IR_SHAPE_DIAG=1 check:ir-fallbacks --shape-diag` @ main
`7d4a48cfc0`: the 14 remaining `body-shape-rejected` are 8 benchmark-harness
`main`s (`nontail-callstmt` — blocked BY #2858 cross-module calls + first-class
function values), 2 helper-internal (`updFoot`/`delay`), and the calendar
DOM/if arms — **none are the overlay-bug shape** (which was a CLAIMED-but-
miscompiled correctness bug, not a selector rejection). So this fix banks **no
bucket delta**; its value is **correctness + IR-first skip safety** (the −60k
epic can only make IR-first the sole path once shapes like this lower correctly)
and **removing the #3204 math workaround**.

### Also landed — restored the natural `Math.log`/`Math.log2` guard form

`src/stdlib/math.ts`: the `if (f > sqrt2) { f *= 0.5; e += 1; }` adjust is back
in its natural mid-body-if form (the ternary `over`/`ea`/`fa` workaround is
gone). **Bit-identical** to the ternary form — 8010 self-hosted-vs-self-hosted
comparisons (dense magnitude sweep + specials), 0 mismatches; both claim/skip;
the self-host driver is context-free so it lowers identically in host/standalone/
wasi. `math-inline` (49) + `issue-2972` + `issue-3141` green.

### Validation

- `tests/issue-2856-if-guard-tail-dup.test.ts` (new, 4 tests): IR-vs-legacy
  parity for the multi-use trailing-local shape, the exact Math.log
  range-reduction shape, nested guards, and a single-use control — every
  positive case asserts the function is IR-owned (`irFirstSkipped` contains it)
  so a demote-to-legacy can't vacuously green it.
- 111 IR-equivalence/gate tests green (`ir-if-else`, `ir-let-const`,
  `ir-algorithms-cluster`, `issue-2856-vec-push`, `issue-3203`); `ir-scaffold`'s
  2 failures are pre-existing container-env (verified side-by-side on base).
- `tsc` clean; `check:ir-fallbacks` OK (`body-shape-rejected` 14→14, no change).
- Broad-impact (structurizer + Math path) → validated on `merge_group`.

### Follow-up (separate, deeper — NOT this PR)

The #3203 `const b = call(); if (b …) …; use b twice` shape still fails a
DIFFERENT pass — `inline-small`'s post-inline verify ("use of SSA value N before
def") — a pre-existing bug (reproduces on base, unaffected by this fix) in the
inliner's block-duplication path, not the emission structurizer. Same structural
class (block duplication + a value live across copies) but in a different pass;
tracked as a follow-up so this PR stays a focused, low-blast-radius correctness
fix.

## Implementation Plan (Fable, 2026-07-18) — the last 14, by capability

> Grounded on this branch (= `upstream/main` merged 2026-07-18) with a fresh
> `JS2WASM_IR_SHAPE_DIAG=1 pnpm run check:ir-fallbacks -- --shape-diag`.
> Supersedes the stale cluster lists above where they disagree (e.g.
> classes.ts `instanceof` has CLEARED — it is no longer in the set).

### The 14, verified today

| #   | Arm                                           | Functions                                                                                     |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 8   | `nontail-callstmt:CallExpression`             | the `main`s of benchmarks.ts, benchmarks/{array,dom,fib,loop,string,style}.ts, js/builtins.ts |
| 1   | `expr-unhandled:ArrowFunction`                | benchmarks/helpers.ts `addBenchCard`                                                          |
| 1   | `nontail-if-cond:BinaryExpression`            | calendar `renderCal` (cond reads module-scope `selStart`/`selEnd`)                            |
| 1   | `nontail-unhandled-stmt:IfStatement`          | calendar `onDay` (if/else-if chain writing module globals)                                    |
| 1   | `nontail-assign-nonprop-lhs:BinaryExpression` | calendar `main` (`gridEl = …` module-global write)                                            |
| 2   | `unattributed-arm:helper-internal`            | calendar `updFoot`, async `delay`                                                             |

Plus the **moduleLevel** bucket (2: calendar 9 stmts, algorithms 1 stmt) —
same roots (module-scope bindings + DOM chains at module level), tracked in
the #2855 plan but retired by capability C below.

Three capabilities + one instrumentation task clear all of it. Per the
Step-2 lesson, a slice is landable only when **net unintended decreases** —
watch `external-call` when claiming the mains.

### Step 0 (S, do first) — Step-1b sub-attribution

`updFoot` and `delay` are still `unattributed-arm:helper-internal`.
Instrument the `return false` sites inside `isPhase1ObjectLiteral` /
`isPhase1TryStatement` / `isPhase1ClosureLiteral` (`select.ts:2490`) /
`isPhase1ForStatement` internals with the existing `shapeNo` recorder
(byte-inert off, first-wins). Expected outcome: `updFoot` attributes to the
module-global root (capability C), `delay` to the closure/type-args root
(capability B). Confirms slice boundaries before C/B start; ~1 day.

#### Step 0 result (2026-07-20) — complete

Instrumented the remaining bare rejection sites in the Phase-1 object-literal,
try, closure, and C-style-for helpers with stable first-wins `shapeNo(...)`
labels. The identifier and `new`-expression leaves were also attributed so the
two corpus unknowns resolve at their deepest failing subcheck. This is
diagnostic-only: no selector acceptance, IR lowering, claim behavior, or
fallback count changed.

Fresh exact histogram:

| Count | Reject detail                                 | Functions                                                                |
| ----: | --------------------------------------------- | ------------------------------------------------------------------------ |
|    10 | `expr-ident-not-in-scope:Identifier`          | eight benchmark/builtins mains, calendar `renderCal`, calendar `updFoot` |
|     1 | `expr-unhandled:ArrowFunction`                | benchmark helper `addBenchCard`                                          |
|     1 | `nontail-unhandled-stmt:IfStatement`          | calendar `onDay`                                                         |
|     1 | `nontail-assign-nonprop-lhs:BinaryExpression` | calendar `main`                                                          |
|     1 | `expr-new-type-args:NewExpression`            | async `delay`                                                            |

Result: **14 total rejections, 14 attributed, zero
`unattributed-arm:helper-internal`**. In particular, `updFoot` is confirmed as
capability C's module-binding root and `delay` as capability B's generic
Promise/closure root. First-wins leaf attribution also refines the previous
eight enclosing `nontail-callstmt` labels to their missing-identifier cause.

Validation: focused attribution tests 2/2; diagnostics-off gate unchanged at
function-level `body-shape-rejected: 14`, module-level
`body-shape-rejected: 2`, and zero post-claim demotions; Prettier and typecheck
clean. The epic remains in progress; capabilities C/A/B are unchanged.

### Capability C (M–L) — module-scope mutable bindings (calendar 4 + moduleLevel 2)

Root: calendar.ts declares module-scope **`let`** bindings — numeric
(`selStart`/`selEnd`/`curYear`/`curMonth`) and nullable-extern
(`gridEl: HTMLElement | null`, …). The selector's scope set holds
params/locals only, so every read rejects; every write hits
`nontail-assign-nonprop-lhs`. The C3 slice (above) already landed the READ
path for a module-scope **const Map** (TDZ-checked `global.get $__mod_<name>`
branded extern) — this capability generalizes it:

1. **Reads of `let` module globals** — extend the C3 identifier arm from the
   Map-const set to a general module-binding set, restricted to bindings with
   IR-lowerable representations: f64/i32 primitives and extern-class refs
   (incl. `T | null` → `ref_null extern` with the legacy null-check parity).
   **Measure first** how legacy stores each shape (`__mod_<name>` global
   ValType — f64 direct vs boxed): the IR read must use the same slot AND the
   same representation, storage parity BY CONSTRUCTION (name-resolved global,
   like C3).
2. **Writes** — new from-ast arm for `Identifier = expr` where the LHS is a
   module binding: `global.set` with the write-side coercion mirroring
   legacy's assignment emission for the same slot. TDZ discipline: writes
   before the module-init executes the declaration cannot occur for
   function-body code (module init runs first), but keep C3's TDZ check on
   reads.
3. **Selector** — accept the binding set in `isPhase1Expr`'s identifier arm
   and in the `EqualsToken` LHS check (`select.ts` ~1343 lineage); mirror
   accept/lower exactly (select↔from-ast parity is mandatory under IR-first,
   see the #2138 constraint above).
4. **Mixed-front-end parity test is mandatory** (both directions: IR writer /
   legacy reader and legacy writer / IR reader), extending the C3 pattern in
   `tests/ir-algorithms-cluster.test.ts`.

Pre-implementation forecast (superseded by the measured result below):
`renderCal`, `onDay`, `main`, and (per Step 0) likely `updFoot` claim → **−4
function-level**, and the moduleLevel calendar entry shrinks toward claimable.
algorithms.ts's 1 moduleLevel stmt
(`const fibCache = new Map<…>()`) needs the module-level `new Map` claim —
verify whether #3142's module-init IR covers extern-class `new` at module
scope; if not, leave moduleLevel at 1 and record it (moduleLevel is gated
must-not-increase, not must-be-zero).

DOM-file verification standard: identical-failure-mode under Node's shimless
host (established in the extern-in-IR slice); full equivalence gate
(`node scripts/equivalence-gate.mjs`), not scoped tests — the #2858 caller-arm
episode showed scoped runs miss real regressions.

#### Capability C result (2026-07-21) — declaration identity + shared legacy slots

Implemented scope is the independently landable storage slice, measured against
`origin/main` at `94f91fd`:

- One checker-backed resolver now identifies a module binding by its actual
  top-level `VariableDeclaration`, shared by selector and builder. Flat names
  are never sufficient, so locals/params/imports and the #3343 leaked
  `for (let i)` selector name cannot alias `__mod_i`.
- Ordinary f64 numbers, boolean i32 values, and branded
  nullable-extern values whose legacy slot is actually externref-backed use
  symbolic `global.get`; supported plain writes use `global.set`; TDZ reads
  preserve the existing legacy flag check. IR and legacy functions share the
  same global in both directions, covered by single-instance mixed-front-end
  tests. Fast-mode ordinary numbers and every native-string host-extern slot
  remain pre-claim rejects until their representations are unified. Numeric
  i32 aliases are not claimed: the checker erases those aliases at this lookup
  site, so no distinct numeric-i32 module representation is currently proven.
- Const writes, module compound assignments, and module updates stay
  pre-claim rejects in ordinary functions. The synthetic module-init unit keeps
  its already-supported `++`/`+=` behavior through scoped `moduleGlobal`
  bindings.
- Strict nullable-extern `=== null` / `!== null` lowers to `ref.is_null`;
  loose equality and extern truthiness remain legacy-owned because they need
  host `undefined` and JavaScript ToBoolean semantics, respectively.
- A void function may now end in a statement guard (`if (c) effect;`) followed
  by its implicit empty return. This is the final hidden shape needed after
  `updFoot`'s module reads became visible.

Measured gate result: function-level `body-shape-rejected` **14 → 13**
(`updFoot` genuinely IR-emitted), all other function buckets unchanged, and
zero post-claim build/verify/lower errors. The earlier `−4 likely` forecast was
not sound: `renderCal` and `main` next reject on arrow callbacks (Capability B),
while opening `onDay`'s converging if/else alone would only move it into
`call-graph-closure` because it calls still-legacy `renderCal`.

Module-level remains **2** rather than the forecast 2 → 1. Calendar module init
uses the legacy native `Date` constructor (`new Date().getFullYear()`), for
which from-ast has no native Date constructor; it is now explicitly rejected
before claim rather than allowed to create a post-claim demotion. Algorithms
still rejects its generic `new Map<number, number>()`, as expected.

Validation: 49 focused Capability C tests (including mixed storage in both
directions, boolean i32, nullable extern, ambient declarations, #3343 identity,
fast/native-string/standalone/WASI representation gates, builtin-vs-user `Map`,
declaration-scoped scalar/Map aliases, catch shadowing, exact extern-brand flow,
extern-member boundary provenance, builtin-constructor shadowing, and negative
pre-claim consumer guards); 52 adjacent #3142 module-init, C3 Map,
extern-in-IR, #3343, selector-attribution, and non-terminating-guard tests green;
full equivalence gate at 1,607 passing / 36 known failures with no new
regressions; typecheck clean; fallback baseline ratcheted to 13.

### Builtins component result (2026-07-21) — Math, `~`, `toFixed`, and `replace`

The next independently measurable component clears
`website/playground/examples/js/builtins.ts::main` without widening general
dynamic coercion:

- One exact-arity Math table is shared by the selector, call-graph scan, and
  builder. `abs`/`sqrt`/`floor`/`ceil`/`trunc` remain direct Wasm unary ops;
  `sin`/`cos`/`exp`/`log`/`log2`, `pow`, and `atan2` lower to the existing
  symbolic self-hosted `Math_<method>` functions. Checker identity preserves
  ambient `Math`; module/local/parameter shadows and wrong arities reject
  before claim. Every argument must be checker-proven numeric.
- Unary `~` is now a partial claim lowering through the established
  `js.bitxor(value, -1)` ToInt32 composite. Only checker-proven numbers enter
  it, keeping string, boolean, bigint, symbol, and dynamic coercions on the
  legacy path.
- Number `.toFixed(digits)` lowers through `number_toFixed` only in the
  host-string lane and only for one integer literal in `[0, 100]`. Dynamic,
  out-of-range, native-string, fast, standalone, and WASI forms remain
  pre-claim rejections.
- String `.replace(search, replacement)` reuses the existing string-method
  backend plan for exactly two literal-string arguments. RegExp, callback,
  custom/coercive, wrong-arity, and unsupported linear forms remain
  legacy-owned; class/extern methods with the same name keep their ordinary
  dispatch.

Measured gate result: function-level `body-shape-rejected` **13 → 12**;
`builtins.ts::main` appears in `irCompiledFuncs`; module-level remains **2**;
all post-claim build/verify/lower/backend buckets remain zero. Validation:
12 focused component tests covering the real playground source, direct and
self-hosted Math parity, ToInt32 edge cases, literal formatting/replacement,
shadow/arity/type/backend negatives, receiver-name collisions, linear
pre-claim routing, and representation-mode gates; typecheck and the fallback
gate clean; full equivalence gate at 1,607 passing / 36 known failures with no
new regressions.

### Prerequisite M0 (zero delta) — bounded multi-module IR overlay

Imported-callee coverage cannot be measured honestly until the multi-source
entry points actually run the IR overlay. M0 adds that compile-twice seam to
`compileMulti`, `compileFiles`, and `compileProject` only after every legacy
body and method trampoline exists. It deliberately leaves module init, class
members, imports, ambiguous flat names, and unsafe cross-file callable ABI
components legacy-owned. Graph-wide collision pruning and checker-resolved
global-script edges prevent an IR body from patching or calling the wrong flat
function slot.

M0 is an enabling slice, not a bucket-serving claim widening. Its focused
multi-source probes genuinely IR-emit safe leaves with runtime parity while
the fallback gate remains exactly **12 → 12**, module-level **2 → 2**, and
post-claim buckets stay empty. This prerequisite must land before imported-call
selection is widened.

### Prerequisite B0 (zero delta) — one callable boundary ABI

The legacy front end carries callable parameters as `externref` wrappers rooted
in `__fn_wrap_*`; the pre-B0 IR closure types used a private
`__ir_closure_base_*` hierarchy. Direct all-IR tests hid that mismatch, but an
M0 mixed-front-end call could expose an invalid signature or cast. #3214 B0 now
keeps typed closures internal, packs them into the legacy carrier at callable
parameter boundaries, and unpacks through one permanently open canonical
wrapper root. Exact signature checking happens on the extracted funcref before
`call_ref`; it never depends on a module-local signature-wrapper RTT. Mixed
legacy→IR runtime coverage in both adversarial wrapper orders plus the
compositional IR→legacy pack path preserve **12 → 12** with zero post-claim
demotions. Function-valued results and storage/escape remain deliberately
deferred; B0 does not claim them.

### Capability A (M) — imported-callee calls (first half of the 8 mains)

Root: the gate compiles each corpus file as its own program
(`scripts/check-ir-fallbacks.ts:217`), but module resolution still pulls the
sibling source (e.g. `helpers.ts`) in, and legacy compiles imported functions
into the same module via the import-resolver. The IR selector only claims
callees that are _local_ FunctionDeclarations, so `el(…)`/`addBenchCard(…)`
reject at `nontail-callstmt`.

Design (mirror the extern-in-IR split — selection runs early, from-ast late):

- **Selector**: thread `resolveImportedFunction(node: ts.Identifier) →
{ name: string } | undefined` via `IrSelectionOptions` — checker-backed
  (symbol → import specifier → resolved FunctionDeclaration in a compiled-in
  sibling module). Accept a call whose callee resolves this way and whose args
  are Phase-1.
- **from-ast/lower**: lower as an ordinary direct call via
  `resolver.resolveFunc(name)` — the legacy pre-pass allocates the funcIdx
  for imported decls under the same name discipline, so this is
  funcIdx-shift-safe by construction (no cached indices — the #2941 lineage).
- **ABI**: the callee stays LEGACY-compiled (it lives in another module's
  compilation unit) — that is the signature-safe direction post-#2949 3b
  (`any` → `irDynamic()`, one ABI both front-ends) **in host mode**; keep the
  arm host-gated like the #2858 caller-arm relaxation, standalone/wasi defers.
- **Edge cases**: optional/default params on the imported callee (fixed Wasm
  arity — pad with default sentinels exactly like the extern.call arm's
  landmine fix above, incl. the f64 sNaN sentinel); void-result calls in
  statement position (`lowerCall(…, statementPosition)`); re-exports and
  `import { x as y }` aliasing (resolve through the checker symbol, not the
  local name); namespace imports (`ns.el(…)`) — defer, not needed by the
  corpus.

**Do not land A alone if the gate shows the mains merely shuffling into
`external-call`** — measure with `--shape-diag` + `--verbose`; if the mains
still reject on the function-reference args, A+B must land together.

### Capability B1/B2 (L) — first-class function references + arrow values

Two arms, both required by the mains' `addBenchCard("fib", bench_fib)`-style
calls and by `addBenchCard` itself (`expr-unhandled:ArrowFunction`, the
`addEventListener("click", () => …)` callback):

1. **B1: top-level function reference as a value** — an Identifier referencing a
   FunctionDeclaration in argument position with a function-typed param.
   Lower to the closure ABI legacy uses for the same site (`$__fn_wrap` /
   `builtin-fn-meta.ts`, `closures.ts`) — the emitter primitives already
   exist post-#2953 (`emitFuncRef`, `emitClosureNew`); the gap is purely the
   select/from-ast arms. **Byte-parity with legacy's wrap is the acceptance
   bar** (a legacy callee will `call_ref` through the same wrapper type —
   mind the #2873 wrapper-RTT creation-order hazard: cast to ROOT + funcref
   sig-dispatch, don't depend on RTT order).
2. **B2: arrow-function expressions as values in argument position** —
   `isPhase1ClosureLiteral` (`select.ts:2490`) exists but is only consulted
   from var-decl initializer position (`:2357`). Widen to call-argument
   position; from-ast reuses the same closure-literal lowering. Captures:
   whatever the existing closure-literal path already supports (ref-cell
   captures); shapes beyond it keep rejecting — this is a widening, not a new
   lowering.

`delay` (`new Promise<number>((resolve) => { setTimeout(() => resolve(value),
ms) })`) needs arm 2 + the `new <ExternClass>` type-args arm + nested-arrow
capture of `resolve`/`value`. Sequence it LAST within B; if the
executor-capture shape proves out of the closure path's reach, **recommend
re-bucketing `delay`'s reject to `deferred` with a recorded rationale**
(flag to PO) rather than forcing an unsound claim — the corpus must not
dictate an unshippable capability.

#### B2 result (2026-07-21) — one ambient void event callback

The measured slice is intentionally narrower than the general arrow-value
forecast above. It checker-certifies exactly one direct, discarded ambient
`addEventListener(type, () => { ... })` site per top-level owner, with a
zero-parameter synchronous block-bodied void arrow, strict lexical/nesting
guards, and symbol-proven readonly captures. Lowering reuses B0's canonical
callable pack and crosses the host boundary through the existing
`__make_callback` import using sentinel `-1`; the runtime produces a cached,
nonconstructible JS arrow that returns `undefined` and ignores event arguments.
Single and multi overlays both validate the final import name/signature and the
deterministic lifted-name slot before claim, while captured subtype names are
module-unique.

The gate ratchets function-level `body-shape-rejected` **5 -> 4** with zero
post-claim demotions. The exact remaining histogram is calendar `renderCal`,
`onDay`, and `main`, plus async `delay`; module-level remains **2** and deferred
async functions remain **4**. The 29-test B2 suite covers optimized and
unoptimized runtime dispatch, callback identity/undefined/nonconstructibility,
unchanged legacy positive-id dispatch, distinct per-site values and capture
shapes, IR shape, strict negatives including symbol-vs-spelling capture
ambiguity including destructured bindings, nested/non-certified sibling
declarations, cross-source name safety, maker/lifted collision demotion, and
standalone containment. A replay regression additionally keeps any local call
component containing a planned B2 owner out of the IR-first skip set until
final-context maker/lifted-name proofs complete, preventing skipped-body
placeholders after a safe demotion. Promise/async executor shapes are
unchanged.

### Ordering and landability

1. Step 0 (landed) → 2. Capability C (landed, measured −1) → 3. builtins
   component (measured −1) → 4. M0 multi-module overlay (zero delta) → 5. B0
   canonical callable ABI (zero delta) → 6. Capability A + B1 atomically → 7.
   B2 arrow values → 8. remaining calendar shapes → 9. `delay` support or an
   explicitly approved deferred rebucket.

The expected measurement sequence from the current 12 floor is
**12 → 12 → 12 → 5 → 4 → 1 → 0**. Treat those intermediate numbers as routing
forecasts, not acceptance substitutes: each slice banks only its observed gate
result, and any mismatch is diagnosed before widening the next claim surface.

Each slice: prove claims via byte-diff/`irFirstSkipped` (anti-vacuity, the
established pattern), zero post-claim demotions, bank via
`--update-on-decrease`, full equivalence gate, `merge_group` validation
(broad-impact rule). Contagion is largely retired post-#2858 (caller-arm
host-gated off), but re-verify per slice that `call-graph-closure` and
`external-call` stay 0.

### Calendar residual implementation notes (2026-07-21)

The three non-callback calendar gaps are implemented as a deliberately narrow
preparation slice for the measured **4 → 1** step after A+B1/B2 lands:

- `renderCal`'s `priceOf(...).toString()` is admitted only when the checker
  proves the receiver numeric and the call is the exact zero-argument,
  non-optional scalar formatter already supported by `number_toString`. This is
  provenance-based rather than syntax-based because the receiver is a module
  call result, while radix overloads and optional calls remain pre-claim
  rejections.
- `onDay`'s top-level non-tail `if/else` reuses the existing structured
  `if.stmt` lowering. Both branches must fit the existing branch-body subset,
  function returns remain excluded, and each branch is selected with an
  isolated scope so branch-local declarations cannot leak across the join.
  This avoids adding a second CFG encoding for a shape the IR already
  represents.
- Calendar `main`'s assignments from the local `el(...)` helper are accepted
  only through exact same-file extern-factory provenance. The callee must be a
  direct top-level function with an explicit non-null extern-class return,
  one final return source, and no mutation of a returned local. Its source must
  recursively trace to an already-proven host extern value. Branching returns,
  forwarded parameters, mutable locals, nullable annotations, optional calls,
  and cross-file helpers remain rejected. The proof deliberately lives in
  module binding analysis, where the global write's expected storage type and
  source provenance are both available.

Focused tests cover runtime behavior and `irCompiledFuncs` genuine-emission
anti-vacuity for all three positive shapes plus pre-claim negatives. On the
B0-only base used for this preparation commit, the fallback baseline is
intentionally unchanged:
the newly selected `onDay` routes to `call-graph-closure` until `renderCal`'s
callback arguments are unlocked by B2, while `renderCal` and `main` still stop
at their arrow expressions. Therefore the residual slice is to be measured
and banked only after the callback prerequisite lands; do not record the
intermediate routing shuffle as a new floor.

Validation on the B0 base:

- `pnpm run typecheck` passes.
- The focused residual suite passes 6/6, and the combined module-binding,
  host-extern, guard-tail, and structured-control-flow suites pass 85/85.
- A direct compile of the live
  `website/playground/examples/dom/calendar.ts` validates as Wasm with no
  post-claim demotions.
- `--shape-diag` reports 11 body-shape rejections: calendar `renderCal` and
  `main` now stop only at `ArrowFunction`; `onDay` has left the bucket.
- The default gate fails in the expected pre-stack shape
  (`body-shape-rejected` 12 → 11, `call-graph-closure` 0 → 1) because `onDay`
  calls the still-arrow-blocked `renderCal`. The baseline JSON remains
  untouched; B2 removes that temporary closure before this slice is banked.

### Calendar 4→1 implementation result (2026-07-21)

The prepared Calendar shapes are now banked on the exact B2 stack. Four narrow
pieces complete the live source without widening the Promise/async surface:

- B2 callback planning now accepts multiple independently checker-certified
  sibling `addEventListener` sites. Every lifted callback receives a stable
  source-order ordinal, every `<owner>__closure_N` name is final-context
  validated, and any uncertified/nested sibling declaration rejects the owner
  before claim.
- Homogeneous string-literal array expressions lower to the existing
  externref-vector family only in JS-host, non-native-string mode. Each element
  uses the established string-to-externref coercion; mixed, sparse, spread,
  annotated-carrier, callback-use, native-string, standalone, WASI, and linear
  shapes remain pre-claim rejections.
- Exact ambient `new Date()` snapshots with only zero-argument `getDate`,
  `getMonth`, and `getFullYear` reads lower through synthetic JS-host imports.
  Selection is checker-certified and symbol-exact; aliases, escapes, writes,
  optional calls, constructor arguments, unsupported methods, shadowed Date,
  nested ownership, and host-free targets reject before claim. Final-context
  preparation runs after callback preparation, registers only the retained
  component's exact imports as one batch, and demotes the entire connected
  component on any name/signature collision without leaving partial imports.
  This host-only path follows JavaScript's local-time getter semantics; legacy
  native Date behavior is unchanged.
- `inlineSmall` now treats any caller containing nested instruction buffers as
  a conservative inlining barrier. This prevents result-id rewrites from
  leaving stale uses inside loop/if/while bodies; ordinary buffer-free inlining
  remains enabled.

The 23-test Calendar residual suite proves runtime behavior, strict negative
containment, final-context Date/callback collision ordering, deterministic
parallel compilation, and the live source itself. The direct anti-vacuity
compile genuinely IR-emits `renderCal` plus closures 0–2, `onDay`, and `main`
plus closures 0–3; its Wasm validates, its Date import set is exactly
`Date_new`, `Date_getDate`, `Date_getMonth`, and `Date_getFullYear`, and
`irPostClaimErrors` is empty. The nested-buffer inliner regression also
executes and validates with zero post-claim demotions.

The production gate ratchets function-level `body-shape-rejected` **4 → 1**.
Calendar contributes no residual; `--shape-diag` identifies the sole remaining
rejection as async `delay` (`expr-new-type-args:NewExpression`). Deferred
`async-function` remains **4**, module-level `body-shape-rejected` remains
**2**, all post-claim buckets remain zero, and no rejection is reclassified
into another unintended bucket.

### At corpus-zero — the promotion question (answered)

Do **NOT** add `body-shape-rejected` to `STRICT_IR_REASONS` at corpus-zero.
The reason legitimately fires on real-world shapes outside the 13-file corpus
for as long as from-ast is not the sole front-end; promotion is the
IR-completeness endgame, not this issue's AC. At corpus-zero: bank the floor
in the baseline, update `plan/log/ir-adoption.md`, and record the verdict at
the `STRICT_IR_REASONS` comment (see the #2855 Fable plan's verdict table —
this corrects acceptance criterion 4 above).

### Async delay 1→0 implementation result (2026-07-21)

The final residual is banked through an exact checker-certified lowering of the
playground `delay(ms, value)` shape: `new Promise<number>` with one synchronous
executor, one `setTimeout` callback, and one `resolve(value)` call. The proof is
symbol-identity based and deliberately single-source/JS-host only; shadowed or
shape-divergent Promise/timer forms, fast/native-string lanes, standalone/WASI,
and the M0 multi-module overlay remain on their pre-existing paths.

Lowering uses the canonical callable ABI for both closures. The Promise
executor captures `ms` plus transitive `value`; the timer callback captures the
raw host `resolve` function plus `value`. Final-context preparation proves the
exact `Promise_new`, `__timer_set_timeout`, `__box_number`, and
`__call_1_f64` signatures, collision-checks both deterministic lifted names,
and registers missing helpers as one late-import batch only after every
read-only refusal check succeeds. Callback, Date, and Promise preparation run
in that order before IR compilation, with one shared compile-twice component
closure for every final-demotable owner.

The 29-test async-delay suite covers optimized/unoptimized real Promise and
timer execution, concurrent capture isolation, deterministic output, exact
post-pruning binary import signatures, strict syntax/symbol negatives, helper
and lifted-name collisions, component replay, host-free/fast/native-string/M0
containment, and a combined callback + Date + Promise runtime module. Calendar
remains green at 28/28, callback coverage at 29/29, and the nested-buffer
regression at 1/1. Full equivalence remains 1,607 passing with the same 36
known failures and zero new failures.

The production gate now records function-level `body-shape-rejected` **1 →
0** and `--shape-diag` reports zero attributed rejections. Deferred
`async-function` remains **4**, module-level `body-shape-rejected` is **1**
after Calendar's exact top-level Date snapshots joined the same host ABI as its
function bodies, and all post-claim buckets remain empty. The baseline is banked
at zero, but
`body-shape-rejected` intentionally remains outside `STRICT_IR_REASONS`: the
13-file corpus is complete while unsupported real-world shapes still
legitimately require the direct front-end.

## Implementation Summary

### What was done

- Drove the playground corpus's function-level `body-shape-rejected` bucket
  from 31 to 0 through bounded IR capabilities for control flow, module
  bindings, imported calls, first-class callables, host callbacks, Calendar
  string tables and Date snapshots, and the exact Promise timer-delay shape.
- Preserved whole-component closure and final-context collision proofs so a
  late ABI refusal cannot strand an IR-first skipped body.
- Made Calendar's nine-statement module initializer IR-owned for its exact
  immediate `new Date().get*()` expressions. Module and function snapshots now
  share the host Date ABI, removing the UTC/local split found during final
  review and reducing the module-level corpus residual from 2 to 1.
- Taught the stack-balance verifier that a concrete closure struct is already
  assignable to its declared closure-root local through Wasm GC subtyping. This
  removes three redundant Calendar casts and keeps the `local-set-coerce`
  quality bucket at zero without banking a false repair baseline.
- Banked the function-level zero floor while deliberately keeping the generic
  `body-shape-rejected` reason non-strict: corpus-zero is not proof that every
  real-world body is IR-lowerable.

### What worked

- Checker- and symbol-certified narrow capabilities kept unsupported variants
  on the pre-claim path instead of creating new post-claim demotions.
- Shared callable packing and one finalization boundary let callbacks, Date,
  and Promise lowering compose deterministically in the same module.
- Strict stack-balance telemetry localized the final CI failure to subtype-safe
  closure stores, so the producer/verifier contract could be fixed narrowly
  without changing call-argument coercion or weakening the ratchet.
- The fallback ratchet stayed monotonic: no unintended reason grew, no
  post-claim class appeared, and Calendar module-init adoption banked an
  additional module-level decrease.

### What did not work

- Promoting `body-shape-rejected` wholesale to `STRICT_IR_REASONS` at corpus
  zero was rejected because unsupported source shapes still legitimately need
  the direct front-end. Strict promotion belongs to the IR-only endgame.
- The first Calendar Date implementation mixed legacy UTC module state with
  host-local function snapshots. Final review caught the boundary case; the
  fix moved exact top-level snapshots onto the same host ABI.
- Fractional/NaN string-array indexing remains legacy-parity conformance debt.
  It is not a regression introduced by this migration slice and is not hidden
  by the zero-fallback claim.

### Files changed

- IR selection, AST lowering, integration, module binding, closure, Date, and
  Promise-delay planning under `src/ir/`.
- Final overlay preparation, driver wiring, and declared-subtype recognition in
  the stack-balance verifier under `src/codegen/`.
- Focused Calendar, async-delay, callable ABI, module-binding, and inliner
  regression suites under `tests/`.
- The fallback baseline, generated IR-adoption record, and this markdown issue.

## Test Results

- Calendar residual suite: 28/28.
- Async-delay suite: 29/29; callback ABI suite: 29/29; inline-buffer regression:
  1/1.
- Integrated focused matrix: 142/142.
- Equivalence gate: 1,607 passing, the same 36 known failures, zero new
  regressions.
- Fallback gate: function body-shape 0, deferred async 4, module-level
  body-shape 1, and no post-claim demotions.
- Stack-balance gate: `local-set-coerce` 0; `call-arg-coerce` improves 7 → 6;
  no fixup bucket increases.
- Typecheck and `git diff --check`: pass.
