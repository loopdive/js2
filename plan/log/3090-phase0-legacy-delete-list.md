# #3090 Phase 0 — legacy front-end delete-list (reachability audit)

**Date:** 2026-07-10 · **Author:** fable-6th · **Baseline:** `origin/main` @ `8d86b2c4fd`
**Tool:** `node scripts/audit-legacy-reachability.mjs` (re-run any time; writes
per-function detail to `.tmp/legacy-reachability.json`, prints the tables below)

> **Current disposition (2026-07-21):** this is the historical measurement and
> R10 delete ledger for **#3518**, not evidence that handlers are dormant now.
> The latest completed audit records **59,676 frontend-only fn-lines** and
> roughly **47K runtime/builtin entry fn-lines**. None of the frontend handlers
> is deletion-ready: hybrid compile-twice reachability remains for free
> functions, classes, module init, multi-source/M0, and linear. Run the audit
> again only after #3518 R9 establishes fail-closed IR-only ownership. R0
> completed with #3529 typed-producer equivalence parity and #3519's honest
> gate; neither capability reclassification nor equivalence-baseline expansion
> is evidence that a handler became unreachable.

## What was measured

Call-graph reachability over every top-level function in `src/` (function
declarations + `const x = fn/arrow`, plus a `<module>` pseudo-node per file
for top-level tables). Two reachability passes:

- **Survivor pass** — roots = every function in `src/` **outside**
  `src/codegen/` (IR front-end/backend, runtime, cli, linear backend,
  orchestration entry), with the legacy body-dispatch pair
  **`compileStatement`/`compileExpression` removed from the graph**. What
  this pass reaches survives legacy front-end retirement ("shared").
- **Full pass** — same roots + the dispatch pair. Reachable here but not in
  the survivor pass = **dies with the legacy front-end** ("legacy-only").
  Reachable in neither = **unreferenced** (dead today).

Edges are identifier references (call, callback, table entry) resolved via
same-file definitions and import/re-export chains — conservative: any
reference marks a function shared, so "legacy-only" is an under- not
over-estimate, and "unreferenced" excludes anything a live table mentions.
Known blind spot: consumers outside `src/` (tests import some codegen
internals) — Phase 2 must confirm each "unreferenced" entry with `knip`
before deleting.

## Hard numbers (fn-lines, 2026-07-10)

| Bucket                                               | files | legacy-only | shared | unreferenced |
| ---------------------------------------------------- | ----: | ----------: | -----: | -----------: |
| **frontend** (delete candidates)                     |    35 |  **59,976** |  7,413 |          288 |
| **deferred** (`eval`/`with`/async-CPS at audit time) |     3 |       1,473 |  1,408 |           12 |
| **runtime** (stdlib behavior emission — keep)        |    58 |  **46,979** | 29,032 |          280 |
| **stays** (substrate/orchestrator — keep)            |    57 |       4,136 | 45,802 |        1,573 |

The table is the 2026-07-10 baseline. Subsequent cleanup moved the current
FRONTEND legacy-only count to **59,676 fn-lines** (Phase 2f, 2026-07-16). Treat
that as an approximate R10 deletion opportunity, not as currently dead code.

## Ground-truth gates — what "dormant" actually means (premise corrections)

The issue's Phase 1 assumed handlers for `ir-owned` kinds are "unreachable
when `experimentalIR: true`". The pipeline disproves this; deletion is gated
on four structural facts:

- **G1 — legacy compiles EVERYTHING first.** ~~By default the IR is an
  _overlay_~~ **CLEARED 2026-07-13 by #3143** (PR #2891, merge 1fc3b9d3a3):
  IR-first is now the default (`JS2WASM_IR_FIRST=0` is a one-release escape
  hatch). `computeIrFirstSkipSet` is an **ALLOWLIST** (not the earlier
  denylist gates): legacy emission is skipped ONLY for a function whose
  signature is f64-params + (f64|void)-return AND whose body is the
  proven-lowerable numeric/boolean subset (`irFirstBodyIsProvenLowerable`) AND
  whose internal callers are all also skipped (signature-parity fixpoint,
  `collectLocalCallEdges`). Safe-by-construction: everything else compiles
  twice. The historical proposal was to widen this allowlist and delete
  per-kind handlers incrementally. The measured 28.1% ceiling disproved that as
  the retirement path: #3521 (R2) replaces it with prepare-before-emit
  ownership, and R9 clears G1 globally before deletion.
- **G2 — whole-function claim unit keeps every handler live.** The selector
  claims `FunctionDeclaration`s; any rejection (every non-zero bucket in
  `plan/log/ir-adoption.md`, every `mixed`/`direct-only`/`deferred` kind in
  the body, class-method gaps) demotes the _whole function_ to legacy — which
  then needs the legacy handler for every kind it contains, including
  `ir-owned` ones. An `IfStatement` inside a function with a `switch` is
  compiled by the legacy `IfStatement` handler. **A kind being `ir-owned`
  does NOT make its legacy handler dead.**
- **G3 — module init is still compile-twice.** #3142 made a synthetic
  module-init unit claimable and lets IR patch the legacy-created
  `__module_init` slot. The legacy module-init body is nevertheless emitted
  first, and a rejection or integration failure retains it. Claimable (or a
  zero module histogram) therefore does not clear deletion reachability.
  #3523 (R4) must prepare module init before emission; R9 removes fallback.
- **G4 — runtime emission enters through legacy dispatch.** ~47K fn-lines of
  stdlib behavior emission (`array-methods`, `property-access`, `object-ops`,
  `native-regex`, `string-ops`, `json-*`, `dataview`, `map-runtime`…) are
  reachable **only** via `compileExpression`/`compileStatement` today; the IR
  path shares just 29K (coercion, strings, async/generator machinery,
  `object-runtime`). Retiring the front-end requires the IR to grow its own
  call-paths into this emission (per-kind adoption), not deletion.

### Current hybrid status (reconciled 2026-07-21)

The #3143 flip is **not** “flip ⇒ delete now.” It cleared G1 only for a positive
numeric/boolean allowlist. The latest measured maximum population reachable by
signature/body widening is **441/1,568 (28.1%)**; the other 1,127 functions
require runtime-path IR, not another signature widen. Class members, module
init, multi-source/M0, and linear remain compile-twice or direct.

The 18/56 `ir-owned` adoption rows also do not clear G2: one unsupported node
causes the whole function to retain legacy, and an IR overlay may patch a body
that was already emitted. **No frontend handler is deletable from the flip,
function-corpus zero, or module claimability alone.** #3518 replaces incremental
allowlist-to-deletion speculation with a prepare-before-emit whole-program
sequence: #3529/#3519 completed R0 → #3520 identity/ABI → #3521
PreparedIrProgram → #3522 classes/closures → #3523 module init → #3525 whole
program / #3526 runtime → #3527 async → #3528 linear → fail-closed default →
this audit's R10 deletion.

**Consequence:** "deletable today with zero capability change" =
the **unreferenced set (~2.1K fn-lines)** — everything else is conditional.
The ~60K FRONTEND number is the size of the eventual win, banked per-kind as
gates clear (revised phases below).

## Ranked FRONTEND delete-list (dies with the legacy front-end)

Ranked by legacy-only fn-lines; "shared" fn-lines inside these files must
be kept (or relocated) when the file is deleted.

| File                              | file lines | legacy-only fn-lines | shared fn-lines | unreferenced |
| --------------------------------- | ---------: | -------------------: | --------------: | -----------: |
| expressions/calls.ts              |      17573 |                16210 |               0 |            0 |
| expressions/assignment.ts         |       7330 |                 6853 |               0 |            0 |
| statements/loops.ts               |       6221 |                 5645 |             105 |            0 |
| expressions/new-super.ts          |       5603 |                 5153 |               0 |            0 |
| binary-ops.ts                     |       4475 |                 4187 |               0 |            0 |
| expressions/builtins.ts           |       3710 |                 3494 |               0 |            0 |
| literals.ts                       |       4233 |                 3364 |             434 |            0 |
| expressions/unary-updates.ts      |       2088 |                 1700 |               0 |          204 |
| expressions/identifiers.ts        |       1926 |                 1507 |             167 |            0 |
| typeof-delete.ts                  |       1590 |                 1417 |               0 |            0 |
| statements/control-flow.ts        |       1530 |                 1305 |              49 |            0 |
| expressions.ts                    |       1568 |                 1217 |               3 |           59 |
| closures.ts                       |       5023 |                 1147 |            3229 |            0 |
| statements/variables.ts           |       1529 |                 1142 |             198 |            0 |
| expressions/calls-closures.ts     |       1102 |                 1012 |               0 |            0 |
| statements/destructuring.ts       |       1424 |                  639 |             532 |            0 |
| statements/exceptions.ts          |        638 |                  550 |               0 |            0 |
| expressions/misc.ts               |        563 |                  490 |               0 |            0 |
| expressions/extern.ts             |        578 |                  481 |               0 |            0 |
| statements/nested-declarations.ts |       2729 |                  443 |            1909 |           20 |
| expressions/logical-ops.ts        |        451 |                  403 |               0 |            0 |
| expressions/helpers.ts            |        533 |                  272 |              27 |            0 |
| statements.ts                     |        311 |                  230 |               0 |            0 |
| expressions/calls-guards.ts       |        300 |                  223 |               0 |            0 |
| expressions/calls-optional.ts     |        240 |                  209 |               0 |            0 |
| expressions/unary.ts              |        179 |                  146 |               0 |            0 |
| statements/shared.ts              |        174 |                  111 |              13 |            0 |
| expressions/late-imports.ts       |        856 |                  102 |             571 |            0 |
| expressions/promise-subclass.ts   |        200 |                   98 |               0 |            0 |
| expressions/fnctor-prototype.ts   |        222 |                   83 |              43 |            0 |
| expressions/proto-override.ts     |        288 |                   71 |             100 |            0 |
| statements/tdz.ts                 |        125 |                   49 |              14 |            5 |
| new-target.ts                     |         98 |                   23 |              19 |            0 |

Per-function names/spans: `.tmp/legacy-reachability.json` (regenerate with
the script).

### Kind → file mapping (cross-check vs `ir-adoption.md` `ir-owned` rows)

| ir-owned kind(s)                                                                                                    | Legacy handler home                               | Gate     |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------- |
| `IfStatement`, `Block`, `ThrowStatement`, `ReturnStatement`                                                         | statements/control-flow.ts, statements.ts         | G1+G2+G3 |
| `WhileStatement` (+ mixed for/for-of/do)                                                                            | statements/loops.ts                               | G1+G2+G3 |
| `Identifier`                                                                                                        | expressions/identifiers.ts                        | G1+G2    |
| `NumericLiteral`, `StringLiteral`, `NoSubstitutionTemplateLiteral`, `True/FalseKeyword`, `RegularExpressionLiteral` | literals.ts, string-ops.ts (runtime)              | G1+G2    |
| `PostfixUnaryExpression`                                                                                            | expressions/unary-updates.ts                      | G1+G2    |
| `ConditionalExpression`, `ParenthesizedExpression`                                                                  | expressions.ts                                    | G1+G2    |
| `TypeOfExpression`, `DeleteExpression`, `VoidExpression`                                                            | typeof-delete.ts, expressions/unary.ts            | G1+G2    |
| `FunctionDeclaration` (claim unit)                                                                                  | declarations.ts (stays), function-body.ts (stays) | —        |

No `ir-owned` kind's handler is deletable in isolation today (G2); the
per-kind coupling lands in Phase 3 as buckets zero out.

## Deletable NOW — unreferenced functions (Phase 2, knip-confirmed)

~2.1K fn-lines dead today (top items; full list in the script output):

- `src/codegen/index.ts` — the superseded host-import scan family
  (`collectConsoleImports`, `collectMathImports`, `collectPrimitiveMethodImports`,
  `collectStringMethodImports`, `collectString*`/`collectPromise*`/
  `collectJson*`/`collectGenerator*`/`collectIterator*`/`collectUnion*`/… —
  ~1,400 lines): re-implemented as fused scans in `declarations.ts` (see the
  `// -- collectXImports --` section markers there); the originals in
  index.ts are referenced by nothing.
- `regex/vm.ts` — 245 lines unreferenced (regex VM superseded by
  `regex/bytecode.ts` + `native-regex.ts` paths; verify with knip).
- `expressions/unary-updates.ts` — `compilePrefixIncrementProperty` (:1650, 65 ln),
  `compilePrefixIncrementElement` (:1719, 139 ln).
- `expressions.ts` — `emitCoercedLocalSet`/`updateLocalType`/`widenLocalToNullable` (~59 ln).
- Assorted ≤20-line strays (see report).

Caveat: the audit graph does not include `tests/` — confirm zero test-side
imports (or move the helper) before each deletion; wiring `knip` into
`quality` (issue Phase 2) automates exactly this.

## Revised phase plan (superseded by #3518)

The unconditional dead-export cleanup is exhausted. The remaining work follows
#3518's R0–R10 spine; it is not safe to delete handlers kind-by-kind from
adoption labels:

1. R0 is complete: typed Prepared/Unsupported/Invariant outcomes, producer
   parity, and an honest readiness gate (#3529/#3519).
2. Build source-qualified whole-program identity/ABI and prepare all supported
   units before backend/body emission (#3520 R1 → #3521 R2 → #3522 R3 → #3523
   R4, followed by #3525–#3528 R5–R8).
3. Make fail-closed IR-only the sole production policy and remove hybrid/
   compile-twice escape hatches (#3518 R9).
4. Re-run this reachability audit against that committed state. Delete only the
   newly unreachable FRONTEND set, largest independent files first, while
   retaining the runtime/substrate reached through IR semantic intents (#3518
   R10 / #3090).

Every deletion slice requires full CI / `merge_group`; the standalone floor is
only authoritative there.

## Regenerate

```bash
node scripts/audit-legacy-reachability.mjs            # tables + JSON
node scripts/audit-legacy-reachability.mjs --why 'calls.ts#compileCallExpression'  # survivor-path trace
```
