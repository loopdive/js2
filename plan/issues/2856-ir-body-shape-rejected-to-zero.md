---
id: 2856
title: "IR: drive body-shape-rejected fallback bucket to zero (dominant unintended bucket)"
status: in-progress
assignee: ttraenkler/dev-2856f
spec: ready
sprint: current
created: 2026-06-30
updated: 2026-07-02
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
parent: 2855
related: [1376, 1131, 2138, 2135, 2134]
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
4. `"body-shape-rejected"` is added to `STRICT_IR_REASONS` once the bucket is
   zero, so a regression hard-errors.
5. No regression in the existing IR test suite (`tests/ir-*.test.ts`) or
   test262 conformance.

## Files

- `src/ir/from-ast.ts` — add statement/expression handlers for the rejected kinds.
- `src/ir/select.ts` — relax the body-shape check as each kind is supported.
- `src/ir/lower.ts` / `src/ir/nodes.ts` — IR node types + Wasm lowering as needed.
- `scripts/check-ir-fallbacks.ts` — (diagnostic) per-node-kind reporting.
- `scripts/ir-fallback-baseline.json` — ratchet down as slices land.
- `src/codegen/index.ts:1013` — `STRICT_IR_REASONS` once at zero.
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
