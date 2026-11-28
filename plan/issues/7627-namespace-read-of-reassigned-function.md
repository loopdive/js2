---
id: 7627
title: "A call of a reassigned function reaches the original body: through a namespace (`d.f()`), and before the reassigning code compiles (shape Y)"
status: ready
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
parent: 7620
depends_on: [7530, 7625]
related: [7620, 7530, 7622, 7630]
---

# #7627 — calls of a reassigned function reach the original body

Child A2 of #7620. PRV-7620 approved it as a blocked placeholder. This is the full plan, written against #7530's
approved plan at `73c3b4070a` (branch `claude/7530-reassigned-functions`).

The issue stays `blocked` until #7530 lands. SCHEMA.md allows one blocker label or id, so the frontmatter says
`blocked_by: 7530` and lists both dependencies in `depends_on`.

## Problem

A reassigned top-level function is a live binding: every call must invoke its current value. Two call paths instead
bind the call to the declaration's original body.

- **A2-ns.** A call or read through a module namespace (`d.f()`, `const k = d.f`).
- **A2-Y.** An ordinary identifier call `f()` compiled before the reassigning code has compiled. The lead moved this
  shape here from #7530's out-of-scope list.

### Measured

Measured on 2026-11-28 with node v22.23.5 on `ada18e6bb6` (head of PR #7558). #7530's branch has no code yet: its
head `73c3b4070a` and the two commits below it change only plan files. So nothing was measured on it.

- `compileMulti` or `compile`, standalone and gc. `ir` is `experimentalIR` on, `off` is `experimentalIR: false`.
- Probe: `.tmp/p7620/{y-cases.mjs,rows.mts,single.mts}` in the c8-7620 worktree.
- Standalone and gc agree on every row.
- `nsDep` is `export function f() { return 3; } export function swap() { f = function () { return 4; }; }`.

**A2-ns.**

| row | entry (dep is `nsDep` unless noted) | node | ir | off |
| --- | --- | --- | --- | --- |
| N0 | `import * as d; d.swap(); return d.f();` | 4 | 3 | throws |
| N0, read before and after the swap | `const a = d.f(); d.swap(); return a * 10 + d.f();` | 34 | 33 | throws |
| N(b): entry declares its own `f` (returns 1) | `d.swap(); return f() * 10 + d.f();` | 14 | 43 | throws |
| N(a): a third file `c` declares its own `f`, read through `c.h()` | `d.swap(); return h() * 10 + d.f();` | 14 | 43 | throws |
| through a value | `d.swap(); const k = d.f; return k();` | 4 | throws | throws |
| control: by name | `import { f, swap }; swap(); return f();` | 4 | 4 | 4 |
| control: no reassignment | dep's `swap` writes `let k`, and `f` returns `k` | 4 | 4 | throws |

- In N(a)/N(b), the "4" digit (the other module's own `f` returns 4) is #7530's row A shape: a shared `__mod_f`.
  #7530 fixes it. The "3" digit is this issue.
- All "throws" cells with IR off, and the no-reassignment row's IR-off cell, are #7622: without the identity
  context, the namespace object declines.

**A2-Y.**

| row | program | node | ir | off |
| --- | --- | --- | --- | --- |
| Y (cyclic, no name clash) | entry: `import { g } from "./dep"; export function f() { return 1; } main: { const a = g(); f = function () { return 5; }; return a * 10 + g(); }`; dep: `import { f } from "./entry"; export function g() { return f(); }` | 15 | 11 | 11 |
| Y, `g` not inlinable (loop around the call) | the same, `g` sums `f()` in a one-iteration loop | 15 | 11 | 11 |
| Y through a namespace | dep reads `e.f()` from `import * as e from "./entry"` | 15 | 11 | throws |
| Y3, the other cycle direction (control, #7530's row) | the reassigning module is the imported one | 12 | 12 | 12 |
| Y5, acyclic (control, #7530's row) | lib reassigns `f`; dep calls lib's `f` | 15 | 15 | 15 |
| Y-single, caller before the reassigner (one file) | `function f() {1}; function g() { return f() }; function swap() { f = …5 }; main: g(); swap(); g()` | 15 | 11 | 11 |
| Y-single, reassigner before the caller | the same with `swap` declared before `g` | 15 | 15 | 15 |
| Y-single, reassigning `main` first | `main` (reassigns) declared before `g` and `f` | 15 | 15 | 15 |
| D, from #7530 (routed here by the lead, 2026-11-28) | #7530's row D: `get()` calls `f` and compiles before `swap`'s `f = () => 4` | 314 | 313 (S7, on PR #7569) | 313 (S7, on PR #7569) |

Row D is the same compile-order defect, reported by S7 and not re-measured here. A direct call to a live function
that compiles before the first assignment to it stays a static call, because the call goes through the live global only
once `closureMap` holds the name, and the assignment's compile is what sets that.
- Multi-file D (sources: "Sources" in `plan/issues/7530-same-named-reassigned-functions-share-global.md` on
  `claude/7530-reassigned-functions`) gives 313 against node's 314 on all four lanes after PR #7569 (`35db004b05`).
- Its single-file form gives 303 against node's 304 on main.
- D′, the same graph with `swap` declared before `get`, is fixed by #7530 and pinned in
  `tests/issue-7530-same-named-reassigned-functions.test.ts`. It is D's control here.

Y is **not specific to cycles**. A single file fails the same way whenever the caller's body compiles before the
reassigning body. A cycle is just the only way, across files, to compile an importer before its exporter.

### Causes

**A2-ns** (read from the code; the rows above match it).

1. `tryRuntimeNamespaceMemberCall` (`src/codegen/expressions/calls.ts:2800`) lowers `d.f()` to a direct call of the
   member's declaration (`runtimeNamespaceMemberImplementation`, then `withRuntimeModuleCallableBindings`). It never
   asks whether that declaration is reassigned.
   - The named-import read `exactImportedTopLevelFunction` (`identifiers.ts:878`) does ask
     (`ctx.reassignedFunctionDeclarations`), which is why the by-name control answers 4.
2. `moduleSymbolNamespaceExports` (`src/codegen/module-namespace-value.ts:486-497`) declines the whole namespace object
   when any export is a reassigned function ("Mutable values require live-binding getters"). So `const k = d.f` throws,
   and a dynamic fallback for (1) would find no object either.

**A2-Y** (measured in the WAT; the trigger is partly a hypothesis).

- In Y, dep's `g` compiles to `return_call` of entry's original `f` (`.tmp/p7620/Y.wat`).
- In Y5, the same call reads the live global `__mod_f` and dispatches on it (`.tmp/p7620/Y5.wat`).
- In Y-single, `g` and `f` are folded to `f64.const 1` inside `main` (`.tmp/p7620/ysf.wat`).
- The graph-wide reassignment scan has already run before any body compiles:
  `registerReassignedFunctionGlobals`, `index.ts:9053`, fills `ctx.reassignedFunctionDeclarations` and
  `liveFuncBindingGlobals`. So the scan is not what is late.
- What is late is the call site's routing. The identifier-call path (`call-identifier.ts:1536-1800`) takes the direct
  `ctx.funcMap.get(funcName)` call (`:1777`) unless a live route already applies:
  - `hasLiveFunctionBinding` (`:266`) covers only runtime-eval and Annex B bindings;
  - otherwise the closure state the assignment's compilation creates.
- Hypothesis, not instrumented: the closure state is registered when the `f = function …` assignment compiles, so a
  call compiled earlier misses it.
- The same direct call makes `g` inlinable (`registerInlinableFunction`, `function-body.ts:172`), which is how
  Y-single folds to a constant.

**Does Y share A2's root?** Partly.

- **Shared:** the missing fact. Both call paths decide by compile-time state instead of asking whether the callee's
  declaration is a live binding.
- **Not shared:** the site. A2-ns's namespace path never asks. Y's identifier path asks only through state that
  depends on compile order.
- **The fix:** one liveness predicate consulted at both sites, plus the inliner. Y does not depend on #7625's
  namespace work, and its cycle is incidental.

## Implementation Plan

### #7530's API, used read-only

From `73c3b4070a`'s plan:

- `ModuleBindingDeclaration` includes `ts.FunctionDeclaration`;
- `ModuleBinding.liveFunction?: "assigned" | "eval"`;
- `markLiveFunctionBinding(ctx, binding, kind)` and `liveFunctionBindings(ctx)` in `module-binding-table.ts`;
- the same `liveFunction` union on `ModuleNameState`;
- `withDirectRuntimeModuleBindings` (`declarations.ts:1748`) passes liveness through the namespace projection.

This issue only reads `moduleBindingOf(ctx, declaration)?.liveFunction` and the binding's `value` global. It edits
none of #7530's regions.

### One predicate

Two exports in `src/codegen/module-bindings/module-binding-liveness.ts`, a small new leaf module next to `module-binding-table.ts`:

- `liveFunctionBindingOf(ctx, declaration): ModuleBinding | undefined` returns `moduleBindingOf(ctx, declaration)`
  when that binding has `liveFunction === "assigned"`. Sites 1–4 use it.
- `isLiveFunctionDeclaration(ctx, declaration): boolean` is true for either kind (`"assigned"` or `"eval"`).
  `exactImportedTopLevelFunction` uses it (PRV-7620 round 3: this variant is chosen now).

**Why a leaf module, not `module-binding-table.ts`.** `module-binding-table.ts` is #7530's region: it owns
`ModuleBinding`, `markLiveFunctionBinding` and `liveFunctionBindings`. This issue only reads that file. The predicate
is a query over the table, not part of it. A leaf module beside it imports `moduleBindingOf` and nothing else, so it
adds no import cycle. The table stays the one owner of the data.

- **Why `"assigned"` only.** An `"eval"` binding (a function a dynamic `Function`/`eval` source may rebind) is already
  routed by the runtime-eval arm (`hasLiveFunctionBinding`). lodash-es has about 475 of them (#7530's census).
  Widening those calls would change lodash's bytes and speed with no measured gain. Eval-only calls keep their path.
- **Users.**
  - `exactImportedTopLevelFunction` (`identifiers.ts:878`) replaces its `ctx.reassignedFunctionDeclarations` test with
    `isLiveFunctionDeclaration`. That is a one-line swap, so `identifiers.ts` does not grow. Eval-only declarations
    keep declining there, as today.
  - Sites 1–4 below use `liveFunctionBindingOf`.
- **The existing WeakSet stays a second liveness source, for now.**
  - `ctx.reassignedFunctionDeclarations` (`context/types.ts:3196`) holds both kinds. After this issue its other ten
    readers still ask it (`ir-overlay-preparation.ts`, `multi-prepared-module-init-census.ts`, `module-namespace-value.ts`,
    `function-member-closure-planning.ts`, `ir-imported-call-planning.ts` ×2, `ir-prepared-free-functions.ts`,
    `property-access.ts`, `identifiers.ts:1173`).
  - Folding them onto the binding and deleting the WeakSet is
    [#7630](7630-retire-reassigned-function-declarations-weakset.md), filed unclaimed as the follow-up.
  - Until then the two sources agree by construction: #7530 marks a binding live for exactly the declarations its
    scan adds to the WeakSet.

### Site 1, A2-ns call (`calls.ts:2800`, `tryRuntimeNamespaceMemberCall`)

- After resolving `memberDecl`, return `undefined` when `liveFunctionBindingOf(ctx, memberDecl)` answers. The call
  then compiles as a member call on the namespace object, which site 2 makes exist.
- `calls.ts` is over the threshold, so this is a condition on the existing `memberDecl === undefined` line: net zero.

### Site 2, A2-ns object (`module-namespace-value.ts:486-497`, `moduleSymbolNamespaceExports`)

- Before the function arm declines, a reassigned function export with a live binding pushes
  `{ kind: "live", key, binding }`.
- This is the same shape as the `var`/`let` arm at `:468`, and the same getter: `ensureLiveBindingGetters` reads
  `binding.value` directly through `NamedGlobalRead`/`rebaseNamespaceGlobalReads`, never by name.
- So the getter is independent of the name state that `withDirectRuntimeModuleBindings` sets. After #7530 that state
  passes liveness through anyway, so there is no coordination edit.
- A function export without a live binding keeps today's `function` arm.

### Site 3, A2-Y identifier call (`call-identifier.ts`, regular identifier call, `:1536-1560`)

- Next to `hasLiveFunctionBinding` (`:1554`): when the callee identifier's declaration has a live binding, call
  through the live value. The declaration is `ctx.oracle.valueDeclarationOf`, through `ctx.importBindingTargets` for an
  import alias, the same resolution `bindingIsImmutablePropertyCallableAlias` (`:326-331`) uses.
- The live value is the same dynamic call `tryEmitInlineDynamicCall(ctx, fctx, expr, true)` the runtime-eval arm
  uses, reading the binding's global. This extends that arm's condition; it is not a new arm.
- **The predicate route subsumes the closure-state route for `"assigned"` declarations.**
  - Today a call to a reassigned function reaches the live value only through state that depends on compile order:
    the closure path (`compileClosureCall`, `call-identifier.ts:1766`) once that state exists. That route is why Y5
    works and Y does not.
  - With site 3, every call whose callee declaration has an `"assigned"` binding takes the live route at `:1554`,
    before that closure arm is reached. So for those declarations the closure arm is never needed.
  - The plan therefore bypasses it for them: the closure arm's condition gains `&& !liveFunctionBindingOf(…)`. If
    instrumentation shows the arm serves only these declarations, the arm is deleted instead.
  - Other closures (arrow-valued `const`s, captured callables) keep it.
- **The first commit instruments Y's cause** before changing behaviour. It logs, for each identifier call to a
  declaration in `ctx.reassignedFunctionDeclarations`, which arm emitted it (direct `funcMap`, closure, or runtime
  eval) and what closure state existed at that point. The output is recorded in the PR, and the logging is removed.
  This confirms or replaces the hypothesis in Causes.
- `call-identifier.ts` is over the threshold. The condition joins `hasLiveFunctionBinding`'s existing call, and the
  import-alias resolution is a call to the shared helper, so the edit is net zero.

### Site 4, inliner (`function-body.ts:172`, `registerInlinableFunction`)

A function whose declaration has a live binding is never registered as inlinable. This is a guard next to the existing
rest-param and capture guards. Inlining copies the declaration's **original body** into the caller (that is how
Y-single folds to a constant), and a reassigned function's current value need not be that body. A live function is
never inlinable, whatever the call site does.

**Pipeline.** Legacy codegen. The IR's imported-call planning already declines reassigned targets
(`ir-imported-call-planning.ts:61/99`, `ir-prepared-free-functions.ts:522`), and the IR refuses the rows' units.

### Order and dependencies

- **Waits for #7530 to land.** The predicate reads `ModuleBinding.liveFunction`. Until then, a function has no
  binding in #7470's table.
- **Waits for #7558, transitively.** #7530 is stacked on #7558's table.
- **A2-ns waits for #7625.** Site 2's object path relies on #7625 keying namespace objects by module symbol and on
  its `moduleNamespaceSourceOf`. N0 itself does not need `export * as`, but the shared entry does.
- **The IR-off cells wait for #7622.** Without the identity context, the namespace object declines before site 2.
- **A2-Y could land without #7625.** It needs only #7530. It stays in this issue as its own commit, after #7530.

## Acceptance criteria

- **Pin test (red → green).** A new `tests/issue-7627-reassigned-function-calls.test.ts` holds every row of both
  tables, × standalone/gc × `experimentalIR` on/off, compared with node.
  - **Red on `ada18e6bb6`, green after:** N0, N0 before-and-after, N(a), N(b) and through-a-value (IR on); Y, Y
    non-inlinable, Y-single caller-first, D and D's single-file form (all lanes); Y through a namespace (IR on).
  - **IR-off cells of the namespace rows:** red until #7622; each carries a comment naming #7622.
  - **N(a)/N(b) "4" digit:** green once #7530 lands. This issue only asserts the full value after both.
  - **Controls stay green:** by-name, no-reassignment (IR on), Y3, Y5, Y-single reassigner-first, Y-single
    `main`-first.
- **Code quality.**
  - One liveness module (`module-binding-liveness.ts`) with two queries over #7530's binding:
    `liveFunctionBindingOf` at the four sites, and `isLiveFunctionDeclaration` at `exactImportedTopLevelFunction`.
    No duplicated liveness test, and no new name-keyed set.
  - The closure arm is bypassed or deleted for `"assigned"` declarations, per site 3.
  - The WeakSet's remaining readers are left to #7630, which is linked.
  - Each fix sits next to its sibling: site 1 on `tryRuntimeNamespaceMemberCall`'s decline line; site 2 beside the
    `var`/`let` live arm; site 3 in `hasLiveFunctionBinding`'s condition; site 4 beside the inliner's existing guards.
  - No edits to #7530's regions: `module-binding-table.ts`, `source-binding-projection.ts`, `registerModuleGlobal`'s
    tail, `registerLiveFunctionGlobal`, `registerAnnexBLiveBinding`, `registerReassignedFunctionGlobals`,
    `module-init-prologue.ts`'s seed loop, `annexb-global-live-binding.ts`, `named-this-call.ts:655-656`,
    `declarations.ts:1748`.
  - `identifiers.ts`, `calls.ts` and `call-identifier.ts` do not grow. The new leaf module is small.
  - The budget gates pass with `LOC_GATE_BASE` set to the upstream main tip.
  - An adversarial review verdict goes in the PR body.
- **Expected gc byte diffs.** Base is #7530's merge, against new.

  | corpus | expected |
  | --- | --- |
  | the #7470 389-file sample | only the files that reach #7530's mint loop with an `"assigned"` binding: `language/module-code/instn-local-bndng-export-{fun,gen}.js` (#7530's census), and only where a call to the function precedes the reassignment or goes through a namespace |
  | #7530's `reassign-sample.txt` (553 files; 18 mint a global) | changed: calls to an `"assigned"` function compiled before its reassignment (direct call or inline → live call), and namespace objects of modules that export one (previously declined, now built). The PR lists each file |
  | #7530's `eval-sample.txt` (113 files) | identical: eval-only bindings are untouched |
  | lodash-es (`compileProject(lodash.js)`) | identical, except call sites of an `"assigned"` function. #7530's census counts its live bindings as eval-only, so the expected diff is empty. A non-empty diff is listed and justified |
  | #7470 / #7530 multi-file graphs (`.tmp/mhash.mts` + #7530's E, G-variant, E+3rd, Y3) | identical, except E/G when a call precedes the reassignment |

  Any other changed function is a finding.
- **No test262 regression.** Scoped per-test diff over `language/module-code|language/import|language/export` and
  `language/statements/function`, on standalone, in the CI lane (`pnpm run test:262` with `TEST262_PATH_FILTER_FILE`):
  no pass → fail.
