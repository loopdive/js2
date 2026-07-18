---
id: 3399
title: "Architecture modularization + bloat-reduction roadmap: 2026-07-18 re-grounding + god-function enforcement axis"
status: ready
sprint: current
created: 2026-07-18
updated: 2026-07-18
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
model: fable
task_type: epic
area: codegen, ir, codegen-linear, compiler
goal: maintainability
related: [3029, 3030, 3182, 3108, 3111, 3102, 3288, 2855, 2950, 1934, 3400]
coordinates: [3029, 3182]
---

# #3399 — Modularization + bloat roadmap: 2026-07-18 re-grounding

**This is a COORDINATING roadmap, not a new competing umbrella.** The two
architecture axes already have complete umbrellas:

- **Modularization / backend-seam axis → #3029** (+ #3030 IR interchange).
  Target picture is normative in
  [`docs/architecture/target-architecture.md`](../../docs/architecture/target-architecture.md).
  S1 + S4 landed (backend contract frozen); S2/S3/S5–S9 sequenced.
- **Bloat / duplication axis → #3182** (slices #3191–#3196).

This issue does **three** things those two do not:

1. **Re-grounds their stale LOC anchors** to a fresh 2026-07-18 census (both
   were last measured 2026-07-09/07-12; the numbers moved a LOT since — see
   §1). Their slice tables cite file sizes that are now 40–90% smaller.
2. **Adds the missing third enforcement leg** — a **per-function** LOC
   ceiling (R-FUNC, #3400). The R-SIZE ratchet in the target doc enforces
   _file_ size (#3102, live); nothing enforces the elegance criterion **"no
   function > 300 LOC"**, and the census finds **166 functions over it**.
   Without R-FUNC the god-_function_ class regrows exactly as the god-_file_
   class did before #3102.
3. **Re-scopes #3111** — its target (`compileCallExpression`, then 12,210
   LOC) was decomposed to 1,684 LOC by **#742 (done)**; the real remaining
   targets are the five oversized functions #742's split _produced_. #3111
   is updated in place (§4).

It provides the unified phase table (§5), the top-5 leverage moves (§6), and
links every child. It does **not** re-declare the layer stack, the five-part
backend contract, or the directory migration map — those are #3029 /
target-architecture.md and remain authoritative.

## §1 — Reality check: what already banked (the big wins since 2026-07-12)

Fresh census on `origin/main` @ 2026-07-18. The issue anchors in
#3029/#3111/#3182 are pre-decomposition; **re-grep every anchor before
editing** — most line numbers have moved.

| File / function                                  | Anchor in issue  | Cited size     | **Now (2026-07-18)** | Driver (landed)    |
| ------------------------------------------------ | ---------------- | -------------- | -------------------- | ------------------ |
| `expressions/calls.ts` (file)                    | #3029 §grounding | 18,474         | **7,898**            | #742 / S8          |
| `compileCallExpression` (function)               | #3111 title      | 12,210         | **1,684**            | #742 (done)        |
| `codegen/index.ts`                               | #3029 §grounding | 15,625         | **7,041**            | god-file wave      |
| `object-runtime.ts` (`ensureObjectRuntime` core) | #3108            | 10,453 / 6,960 | **6,378 / 3,525**    | #3274/#3275/#3277  |
| `array-methods.ts`                               | #3182 D-series   | 9,565          | **8,216**            | #3193 (S3)         |
| `runtime.ts`                                     | #1934            | ~16,257        | **14,668**           | (mostly untouched) |

Net: the **top five god files shed ~35,000 LOC** in ~6 days. The
decomposition machine (byte-identity `prove-emit-identity` + loc-budget
ratchet) works; this roadmap keeps it pointed and closes the enforcement gap
so the wins can't silently reverse.

## §2 — Current census (authoritative, 2026-07-18)

**God files (> 1,500 LOC ceiling):** **69** total — 41 heavy (≥ 2,500),
28 mid (1,500–2,499). Top offenders and ownership:

| LOC    | File                               | Owner / status                                     |
| ------ | ---------------------------------- | -------------------------------------------------- |
| 14,668 | `src/runtime.ts`                   | **#1934** (backlog, `resolveImport` only) — see §7 |
| 8,216  | `src/codegen/array-methods.ts`     | #3182 (D3/D5), #3196 in-flight                     |
| 7,898  | `src/codegen/expressions/calls.ts` | #742 done at fn level; file still god — §4 / #3111 |
| 7,448  | `src/ir/from-ast.ts`               | IR front-end; #2855 migration surface              |
| 7,041  | `src/codegen/index.ts`             | #3029 S3c/S5 (integration split), god-file wave    |
| 6,378  | `src/codegen/object-runtime.ts`    | **#3108** (full byte-identity spec, in-progress)   |
| 5,692  | `src/codegen/dataview-native.ts`   | #3182 S1/S2 (throw/brand dedup)                    |
| 5,566  | `src/codegen-linear/index.ts`      | #2956 (linear-consumes-IR)                         |
| 4,884  | `src/codegen/object-ops.ts`        | **un-owned** (§7 candidate)                        |
| 4,864  | `src/codegen/property-access.ts`   | **un-owned** (§7 candidate)                        |

**God functions (> 300 LOC elegance criterion):** **166** top-level
functions. The largest that are NOT already owned by a byte-identity spec:

| LOC   | Function                       | File                                   | Status                  |
| ----- | ------------------------------ | -------------------------------------- | ----------------------- |
| 3,525 | `ensureObjectRuntime`          | `object-runtime.ts`                    | **#3108** (owned)       |
| 3,102 | `compileReceiverMethodCall`    | `expressions/call-receiver-method.ts`  | **#3111 re-scope (§4)** |
| 3,054 | `compileBuiltinStaticCall`     | `expressions/call-builtin-static.ts`   | **#3111 re-scope (§4)** |
| 2,807 | `lowerIrFunctionBody`          | `ir/lower.ts`                          | #3029 S2 (pushRaw)      |
| 2,719 | `buildObjectDescriptorHelpers` | `object-runtime-descriptors.ts`        | #3274 (done — leave)    |
| 2,106 | `compileIdentifierCall`        | `expressions/call-identifier.ts`       | **#3111 re-scope (§4)** |
| 1,930 | `compileNamespaceStaticCall`   | `expressions/call-namespace-static.ts` | **#3111 re-scope (§4)** |
| 1,793 | `compileTailDispatch`          | `expressions/call-tail-dispatch.ts`    | **#3111 re-scope (§4)** |
| 1,536 | `ensureAnyHelpers`             | `any-helpers.ts`                       | #3282 (in-progress)     |
| 1,446 | `coerceType`                   | `type-coercion.ts`                     | **un-owned** (§7)       |
| 1,359 | `compileBinaryExpression`      | `binary-ops.ts`                        | **un-owned** (§7)       |
| 1,309 | `compileObjectDefineProperty`  | `object-ops.ts`                        | **un-owned** (§7)       |

The takeaway: after #742 shattered `compileCallExpression`, the **five
call-shape functions it created are themselves 1,800–3,100 LOC** — the god
function simply fractured into five slightly-smaller gods. That is the exact
failure mode R-FUNC (#3400) exists to prevent, and the exact target #3111 is
re-scoped onto.

## §3 — Elegance criteria (checkable end-state)

The roadmap is "done" when all hold **and are CI-enforced** (not just true
today):

| Criterion                                                  | Enforcement                        | Status                           |
| ---------------------------------------------------------- | ---------------------------------- | -------------------------------- |
| No file > 1,500 LOC                                        | R-SIZE (`check:loc-budget`, #3102) | **live** (shrink-only ratchet)   |
| **No function > 300 LOC**                                  | **R-FUNC (#3400)**                 | **GAP → this roadmap builds it** |
| Layer imports downward; `src/ir/` ⊄ `src/codegen/`         | R-DEP (#3029 S7)                   | script pending (#3029 S7)        |
| One lowering per construct (no per-call-site re-emit)      | #3182 D3/D5 + review               | in-flight (#3193/#3196)          |
| Backend-specific code only below the contract seam         | R-DEP + #3029 S3                   | in-flight                        |
| AST-path deleted as IR covers each kind (no dead fallback) | #2855 → STRICT_IR_REASONS          | in-flight (buckets: 14+4)        |

## §4 — #3111 re-scope (updated in place this PR)

`compileCallExpression` is done (#742). #3111 is retargeted onto the five
call-shape god functions #742 produced (the §2 table). Full byte-identity
slice plan added to the #3111 issue file
(`plan/issues/3111-decompose-compilecallexpression-call-shapes.md`) in this
PR. One-line summary:
apply the #3108 pattern (shared context bag + order-preserving orchestrator +
`prove-emit-identity` per slice) to `call-receiver-method.ts`,
`call-builtin-static.ts`, `call-identifier.ts`, `call-namespace-static.ts`,
`call-tail-dispatch.ts`, extracting the per-builtin-family arms into sibling
`call-shapes/<family>.ts` modules. Gated by R-FUNC (#3400) so the extracted
pieces can't regrow. **Blocked-on coordination:** `call-tail-dispatch.ts`
(tail calls) is adjacent to the in-flight async/generator rewrite
(#3386–#3391, #2662) — sequence that one slice _after_ those land.

## §5 — Unified phase table

Every row is independently landable, single-PR-sized, and gated. "Gate" =
what proves it safe. This table SEQUENCES existing issues; it does not
re-own them.

| Phase  | What moves / lands                                                  | Issue            | Gate                         | Blocked-on            |
| ------ | ------------------------------------------------------------------- | ---------------- | ---------------------------- | --------------------- |
| **E0** | **R-FUNC per-function ceiling ratchet** (script + baseline + CI)    | **#3400**        | script unit test; byte-inert | — (land FIRST)        |
| E1     | R-DEP layer-import ratchet (`check:layer-imports`)                  | #3029 S7         | script unit test; byte-inert | —                     |
| E2     | pushRaw families behind the trait + R-ESCAPE count ratchet          | #3029 S2 / #2953 | byte-identity + count check  | S1 (done)             |
| E3     | `js-tag.ts` → `src/ir/` + from-ast upward-import re-home            | #3029 S3a/S3b    | byte-identity (path-only)    | —                     |
| E4     | `compileIrPathFunctions` split (neutral core / GC adapter)          | #3029 S3c        | byte-identity corpus         | E3                    |
| E5     | ModuleAssembler adapters (GC + linear)                              | #3029 S5         | additive ⇒ byte-inert        | S4 (done)             |
| E6     | `object-runtime.ts` core decomposition (13 slices)                  | **#3108**        | `prove-emit-identity` /slice | — (in-progress)       |
| E7     | **five call-shape god functions → call-shapes/ modules**            | **#3111**        | `prove-emit-identity` /slice | E0 (R-FUNC banks it)  |
| E8     | array-methods D3 shape-path dedup + D5 standalone HOF de-inline     | #3193 / #3196    | zero test-diff               | —                     |
| E9     | throw/brand template dedup                                          | #3182 S1/S2      | zero test-diff               | —                     |
| E10    | directory re-layout (`git mv` → `src/backend/{gc,linear,bytecode}`) | #3029 S6         | byte-identity (path-only)    | E3/E4; lead-scheduled |
| E11    | `runtime.ts` decomposition (resolveImport + beyond)                 | #1934 (+§7)      | equivalence; ABI-stable      | —                     |
| E12    | IR fallback buckets → 0 → STRICT_IR_REASONS; IR-first flip          | #2855 / #2950    | conformance delta 0          | value-rep #745/#2773  |
| E13    | Porffor backend proof (5-part contract, second real consumer)       | #3288            | its own gates                | in-progress           |

**In-flight collision guards (do not schedule into these until they land):**
async/generator rewrite #3386–#3391 / #2662 (blocks E7's `call-tail-dispatch`
slice); value-representation #745 / #2773 (blocks E12's IrType.dynamic work).

## §6 — Top-5 highest-leverage moves

1. **E0 / #3400 — per-function ceiling ratchet.** Smallest change, largest
   structural payoff: it converts every future oversized function into a hard
   CI failure and banks all decomposition progress permanently. Without it,
   E6/E7 regrow. **Do this first** — it is byte-inert (no compiler change).
2. **E7 / #3111 — the five call-shape gods.** #742 left five 1.8k–3.1k-LOC
   functions; they are the single densest remaining pocket of >300-LOC
   functions and the top merge-conflict surface for dev agents.
3. **E6 / #3108 — object-runtime core.** Fully specced (13 byte-identity
   slices), in-progress; the largest un-owned-until-now function (3,525 LOC)
   dissolves into an ordered `build*(s)` orchestrator.
4. **E1 / #3029 S7 — R-DEP.** Locks the layer boundary before the directory
   moves (E10); flips `src/ir/` to zero-codegen-imports as E3/E4 clear it.
   Prevents the modularization from silently re-coupling.
5. **E11 / #1934 + §7 — runtime.ts.** The single largest file (14,668 LOC)
   and almost entirely un-decomposed; even the `resolveImport` slice (#1934)
   is still backlog. High LOC-per-PR yield.

## §7 — Un-owned god files/functions (backlog candidates, NOT filed here)

These are over the ceiling with no owning issue. Filing them is deferred to
PO grooming (this roadmap flags them; it does not pre-file to avoid backlog
churn): `object-ops.ts` (4,884), `property-access.ts` (4,864), `literals.ts`
(4,482), `coerceType` (1,446), `compileBinaryExpression` (1,359),
`compileObjectDefineProperty` (1,309). **runtime.ts** (14,668) is partially
owned by #1934 (resolveImport only, backlog) — the whole-file split "rides
#1934" per #3029 S6 wave 6 but needs #1934 promoted from backlog and extended
beyond resolveImport. Recommend PO promote #1934 and file the
`object-ops`/`property-access`/`coerceType` trio once R-FUNC (#3400) is live
so each extraction is ratchet-banked.

## Acceptance criteria (umbrella)

- [x] Fresh 2026-07-18 census recorded (§1/§2), stale anchors flagged.
- [ ] R-FUNC (#3400) live in `quality` — the 300-LOC function criterion is
      CI-enforced.
- [ ] #3111 re-scoped onto the five call-shape functions with a byte-identity
      slice plan (§4 — done in this PR).
- [ ] The §5 phase table is kept current as children land (this issue is the
      cross-axis status board; #3029 and #3182 remain authoritative per axis).
- [ ] No new function > 300 LOC and no new file > 1,500 LOC merges after
      E0/E1.

## Non-goals

- Re-declaring the layer stack / backend contract / directory map — owned by
  #3029 + `target-architecture.md`.
- Superseding #3182 (bloat) or #3108/#3111 (specific decompositions) — this
  coordinates and re-grounds them.
- Any code change in this PR — **doc/plan-only**.
  </content>
