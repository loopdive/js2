---
id: 4605
title: "IR module-level declared-type table: give the verifier a signature/global source of truth for call/global.* rules"
status: done
completed: 2026-08-21
sprint: current
created: 2026-08-21
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: hardening
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3518
related: [4603, 4523, 3030, 3520]
loc-budget-allow:
  - src/ir/verify.ts
  - src/ir/nodes.ts
  - src/ir/integration.ts
func-budget-allow:
  - src/ir/integration.ts::compileIrPathFunctions
origin: "#4603 finding 1 (PR #4704): call/global.* type rules could only be intra-function coherence checks because no declared-signature record exists in the verifier's scope"
# id 4605 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-21 (gh CLI offline in this container; pr_scan=degraded). MCP
# open-PR scan at reservation: open PRs 4703/4707 introduce no issue file
# with an id near 4605; the assignment book's prior reservation was #4603.
# Note: "#4605" also appears in old prose as a PULL REQUEST number (ids and
# PR numbers share one sequence); no issue FILE with id 4605 exists on main.
---

# #4605 — module-level declared-type table for the IR verifier

## Problem (from #4603's measured finding)

PR #4704 set out to give `call`, `global.get`, and `global.set` the type
rules #4523's triage sketched ("vs the target's resolved signature", "must
match the global's declared IrType") and found the records **do not exist**
anywhere the verifier can reach: `IrFuncRef`/`IrGlobalRef` carry only a debug
name plus a structural binding, both resolve lazily at lowering, and
`IrModule` holds *only* `functions` — no globals table, no signature table.
`verifyIrFunction` takes a single `IrFunction`, which carries neither.

The landed fallback is intra-function coherence (two references to one
binding must agree with each other), which catches the defect class but not
its most common shape: ONE mistaken call site, coherent with itself.

## Why this belongs on the #3518 spine

`ProgramAbiMap` (#3520 R1) is building exactly this vocabulary on the
codegen side — source-qualified identity with planned signatures, globals,
imports, and types. The verifier needing a declared-type table and the
prepared pipeline needing a whole-program ABI are the same fact stated
twice. The design question this issue owns: does the verifier consume a
projection of `ProgramAbiMap` (one source of truth, but couples verify to
preparation), or does `IrModule` grow its own declared tables that
preparation then cross-checks (verifier stays standalone, one more thing to
keep in sync)? #3030 (serializable interchange) wants the second shape —
a self-describing module — and its C2 thread (schema namespace) is the
natural place the table's serialized form lands.

## Acceptance criteria

- [x] A decision, recorded here, on the table's home (ProgramAbiMap
      projection vs IrModule-owned declarations), with the #3030
      serialization consequence stated.
- [x] `IrModule` (or the chosen carrier) exposes declared signatures for
      functions and declared IrTypes for globals reachable by
      `verifyIrFunction` (likely via an optional context parameter so
      existing single-function callers stay valid).
- [x] The #4603 coherence rules for `call`/`global.*` upgrade to
      declared-type rules when the table is present, keeping the
      conservative skip when it is absent; positive + negative fixtures per
      the #4070 method, and the mutation proof that removing a rule fails
      loudly.
- [x] No behavior change for valid IR; `check:ir-fallbacks` post-claim
      buckets and `check:ir-only` (both lanes) unchanged; the full corpus
      shows zero new demotions attributable to the upgraded rules.

## Implementation Plan (Fable, 2026-08-21)

**Decision (AC 1): option B — `IrModule`-owned declared tables, not a `ProgramAbiMap` projection.** Rationale: (1) the verifier stays standalone — coupling verify to the prepared pipeline would invert the dependency the `check:ir-layering` ratchet exists to shrink; (2) `ProgramAbiMap` (#3520 R1) is actively edited by another lane — consuming it now creates conflicts with every in-flight prepared-pipeline transaction; (3) #3030 wants a self-describing serializable module, which means declarations belong ON the module. Serialization consequence (record in the issue): the tables become part of the module's serialized form under #3030's C2 schema-namespace thread; preparation later cross-checks `ProgramAbiMap` against them (one more sync point, accepted deliberately).

Verified anchors (current main, commit c3988b6d5):

- `IrModule` at `src/ir/nodes.ts:2408` — `{ readonly functions: readonly IrFunction[] }` only.
- `verifyIrFunction(func, domain = defaultTagDomain())` at `src/ir/verify.ts:341`.
- `bindingKey` (stable structural key for `IrGlobalRef`/`IrFuncRef` bindings) at `src/ir/verify.ts:~1557`.
- The #4603 coherence rules live in `checkSymbolicRefCoherence` at `src/ir/verify.ts:~2106`, with state in `RoadmapRuleCtx` (`callSignatures`, `globalKinds` maps, `:~1788-1818`). Its doc comment (`:2096`) states the exact gap this issue closes.
- `verifySymbolicReferences` (`:222`) owns malformed-ref errors; keep that separation.

Mechanism:

1. **Types** (nodes.ts, next to `IrModule`): `IrDeclaredSignature = { readonly params: readonly IrType[]; readonly result: IrType | null }` (null = void). Extend `IrModule` with OPTIONAL fields `declaredSignatures?: ReadonlyMap<string, IrDeclaredSignature>` and `declaredGlobals?: ReadonlyMap<string, IrType>`, keyed by the same structural binding key `bindingKey` computes. Optional fields keep every existing `IrModule` construction site valid — zero-churn.
2. **Key sharing**: `bindingKey` is currently verify-internal. Export it from verify.ts (or move it to nodes.ts if that reads cleaner) so producer and consumer use ONE key function. Do not duplicate the logic.
3. **Verifier context**: add an optional third parameter to `verifyIrFunction(func, domain, declarations?: IrModuleDeclarations)` where `IrModuleDeclarations` is a pick of the two tables. Existing callers unchanged. Thread it into `RoadmapRuleCtx`.
4. **Rule upgrade** in `checkSymbolicRefCoherence`: when the table has an entry for the binding key, check the reference against the DECLARATION (call: arity vs `params.length`, resultType kind vs declared result kind; global.get resultType / global.set value kind vs declared global's ValType kind) — this catches the "ONE mistaken call site, coherent with itself" shape the coherence rule cannot. When the table lacks the key, keep the existing first-seen coherence behavior unchanged (conservative skip). Same carrier-kind-level comparison and unknown-skips as every #4603 rule (a verify error DEMOTES to legacy, so rules fire only on provable contradictions).
5. **Producer wiring — minimal-diff, stop-rule guarded**: `src/ir/integration.ts` assembles `IrModule`. Populate the tables ONLY where the assembly site already has the signature/global type in hand (the per-function results it accumulates). **Stop-rule: if wiring requires >30 changed lines in integration.ts or restructuring code that #3520/#3521 (prepared-pipeline lanes) are editing, do NOT force it** — land the tables + verifier upgrade + fixtures with a test-side producer, keep the issue `in-progress`, and record production wiring as the follow-up gated on #3520. Honest partial over forced complete.
6. **Tests** (`tests/issue-4605-declared-type-table.test.ts`), per the #4070 method: positive fixtures (valid IR verifies clean with tables present), negative fixtures (one mistaken-but-self-coherent call site caught ONLY with the table present — this is the load-bearing case; wrong arity, wrong result kind, wrong global carrier for both get and set), absent-table conservatism (same IR, no tables, no errors), and the mutation proof: deliberately disable the declaration check in a scratch build and show the negative fixture goes silent (record the counterfactual in the issue file, restore).

Bar (AC 4): no behavior change for valid IR; ts7 `pnpm run typecheck`; IR test files green (`ir-*.test.ts`, `issue-4523-*`, `issue-4603-*`); `pnpm run check:ir-fallbacks` and `pnpm run check:ir-only` unchanged; `pnpm run check:linear-ir` still OK compiled=8. If integration.ts wiring lands, run the full corpus check and record zero new demotions. Respect LOC/func budgets — if the diff exceeds a budget gate, grant it in THIS issue's frontmatter (`loc-budget-allow:` list), NEVER edit `scripts/*-baseline.json`.

## Outcome (2026-08-21)

All six steps landed, **including production wiring** (step 5 — the stop-rule did not trigger).

### What shipped

| Step | Where | Note |
| --- | --- | --- |
| 1 Types | `src/ir/nodes.ts` — `IrDeclaredSignature`, `IrModuleDeclarations`, `IrModule extends IrModuleDeclarations` | Optional fields; every existing `IrModule` literal still compiles untouched. |
| 2 Key sharing | `src/ir/declared-types.ts` — `irBindingKey` | The one implementation now lives here; `verify.ts` keeps a `const bindingKey = irBindingKey` alias so its existing call sites are unchanged. |
| 3 Verifier context | `verifyIrFunction(func, domain?, declarations?)`, threaded to `RoadmapRuleCtx.declarations` | Third parameter, so every existing call site is unchanged. |
| 4 Rule upgrade | `checkSymbolicRefCoherence` in `src/ir/verify.ts`; rules in `declared-types.ts` (`declaredCallProblems`, `declaredGlobalProblem`) | Declaration present ⇒ declaration rule and return; absent ⇒ #4603 coherence, unchanged. |
| 5 Producer wiring | `src/ir/integration.ts`, **13 changed lines** (11 +, 2 −) | Two module-level verify sites: post-inline (`irModuleDeclarations(modOut)`) and post-mono/TU (`irModuleDeclarations(modAfterTU)`). |
| 6 Tests | `tests/issue-4605-declared-type-table.test.ts` — 19 tests | Positive, negative, absent-table conservatism, producer derivation, end-to-end. |

**Deviation from the plan, deliberate:** the plan put the types and the key in `nodes.ts`/`verify.ts`. Both are god-files under the `check:loc-budget` ratchet, so the substance went into a new subsystem module `src/ir/declared-types.ts` instead — which is what that gate asks for. Two smaller consequences fall out of it: the type declarations still had to sit in `nodes.ts` (placed below every instruction-kind declaration, so `scripts/ir-kind-neutrality-baseline.json` line numbers do not shift), and `declared-types.ts` imports only *types* from `nodes.ts`, so the edge has no back edge.

### Step-5 stop-rule decision: PROCEED

The rule was ">30 changed lines in integration.ts, or restructuring code the #3520/#3521 lanes are editing". Measured: **13 changed lines**, all additive, none inside a structure those lanes touch (two `const` bindings and two extra call arguments at existing `verifyIrFunction` sites). Well under the threshold, so the wiring landed rather than being deferred.

### The measurement that changed the design

Wiring the producer in ON THE FIRST CUT demoted **3 previously-IR-compiled functions** — `website/playground/examples/js/async.ts`, bucket `async-function` 0 → 3 (reproduced twice, A/B against the base copy of `integration.ts`). Instrumented, the verify error was:

```
call fetchUser resultType externref contradicts the module-declared result f64
```

This is a **false positive, not a caught bug**. An `async function fetchUser(id: number): Promise<number>` lowers to an `IrFunction` whose `resultTypes` is the UNWRAPPED `f64` (#1373b unwraps `Promise<T>` for the awaiting caller), while a call site that does *not* await legitimately receives the Promise object as `externref`. Both carriers are correct for the same callee, so no single declared result carrier exists. Generators divide the same way (the lowerer picks `externref` for the Generator object regardless of the annotation `resultTypes` records).

The fix is `declarableResultType` in `declared-types.ts`: `funcKind === "async" | "generator"` declares `result: null`, which skips the result comparison. **Arity is still declared and still checked for both.** After the guard the bucket returns to 0 — identical to the base run.

This is the concrete argument for wiring the producer rather than shipping the mechanism with a test-side producer only: the async/Promise split is invisible in hand-built fixtures and would otherwise have shipped as a latent conformance loss the first time someone wired it.

### Mutation proof (AC 3)

Counterfactual run, `declared-types.ts` scratch-mutated so `declaredCallProblems` returns `[]` and `declaredGlobalProblem` returns `null` (the declaration checks disabled, everything else intact), then restored:

| | Result |
| --- | --- |
| Rules enabled | 19 passed / 19 |
| Rules disabled | **5 failed** / 14 passed |

The five that went silent are exactly the declaration-only negatives — lone-call wrong arity, lone-call wrong result carrier, lone `global.get` wrong carrier, lone `global.set` wrong carrier, and the end-to-end sibling-unit arity contradiction. Every positive, every conservative-skip, and every #4603 coherence test stayed green under the mutation, which is the other half of the proof: the mutation removes only the new rule.

### Gate results (all on the final tree)

| Gate | Result |
| --- | --- |
| `pnpm run typecheck` (ts7) | clean |
| `pnpm run format:check` | clean |
| `pnpm run check:ir-fallbacks` | OK — no unintended/post-claim/module-level increases; deferred buckets identical to base (`string-builder-candidate` 2, `async-function` 0) |
| `pnpm run check:ir-only` | READY — 38 units, 38 IR bodies, 0 unsupported, 0 invariants, 0 legacy bodies |
| `pnpm run check:linear-ir` | OK — compiled=8 (baseline 8) |
| `pnpm run check:ir-dialect` | OK |
| `pnpm run check:ir-kind-neutrality` | OK (baseline: one `declaredAt` line number shifted by the integration.ts insertions; committed) |
| `pnpm run check:jstag-seam` | OK — no growth |
| `pnpm run check:ir-layering` | OK — 83 import lines (baseline 83) |
| `tests/issue-4605-declared-type-table.test.ts` | 19/19 |
| `tests/issue-4603-*`, `issue-4523-*`, `tests/ir/**`, `issue-3520-*`, `ir-scaffold` | 269/270 |

The single failure is `tests/ir-scaffold.test.ts` "selection picks the expected functions" (`withVar`), and it is **pre-existing on `origin/main`** — verified by an A/B run with the base copies of `verify.ts`/`nodes.ts`/`integration.ts` restored and `declared-types.ts` removed, where it fails identically. Not attributable to this change and not fixed here.

### Budget allowances granted in this issue's frontmatter

`src/ir/verify.ts` (+31), `src/ir/nodes.ts` (+25), `src/ir/integration.ts` (+9), and `compileIrPathFunctions` (+8) exceed their ratchets. The bulk of the new code (~150 lines) is in the new `declared-types.ts`, which is not god-file growth; what remains in the three is the threading and the type declarations, which cannot live anywhere else. `scripts/loc-budget-baseline.json` and `scripts/func-budget-baseline.json` were NOT touched.

### Follow-ups this deliberately does not do

- **`declaredGlobals` has no production producer.** The mechanism, the rules, and the fixtures are all in place, but nothing in `integration.ts` records a declared IrType per global — no such record exists to read yet. So in production the `global.*` rules still fall back to #4603 coherence; only `call` is upgraded end to end. Populating it belongs with whichever slice first materialises global declarations (#3520 R1's globals table is the natural source).
- **Serialization (#3030 C2).** The tables are on the module but not yet in the serialized schema; that is the C2 thread's to add, per the AC-1 decision recorded above.
- **Preparation cross-check.** The accepted cost of option B is that `ProgramAbiMap` and these tables must agree. Nothing checks that today.
