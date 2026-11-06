---
id: 7287
title: "IR: a script `var` holding a function expression is storable and callable from IR units"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7198, 7195, 7271, 7284, 7286, 7252, 7274]
assignee: "ttraenkler/c-lead"
loc-budget-allow:
  # 2026-11-06 (#7287 slice A): +32 — `scriptVarBehindLibGlobal`, the one
  # rule `bindingDeclarationCandidates` applies before every binding query
  # (the shared seam both the selector and from-ast resolve through). It reads
  # only the candidates that function already gathers, so it lives beside it.
  - src/ir/module-bindings.ts
---

# #7287: a script `var` holding a function expression, callable from IR units

## Problem

The test262 runner prelude binds `var print = function (value) { console.log(value); };`.
`__consolePrintHandle__` calls `print(msg)`, which the selector marks
`external-call`; `$DONE` then stays legacy through the call-graph closure
(#7284, #7286).

## Findings (spike, 2026-11-06, base `origin/main` 8b349439; not committed)

1. **Where `print` comes from.** `tests/test262-original-harness.ts`
   (`RUNTIME_PATH` = `scripts/test262-fyi-runtime.js`) prepends the plain-JS
   prelude, whose first binding is `var print = function (value) { console.log(value); };`.
   `doneprintHandle.js`'s `__consolePrintHandle__(msg) { print(msg); }` is the
   only harness caller.
2. **What legacy emits.** `print` lives in `__mod_print`, a
   `(mut externref)` global: the script-var *dynamic home* (#7105/#7198). The
   initializer stores legacy's function object there. A call reads the
   global, casts it to the closure struct, throws a TypeError when it is not
   callable, publishes `__argc`, and calls through `call_ref`.
3. **Root cause of `external-call`, part 1: the name.** `lib.dom.d.ts`
   declares `declare function print(): void` (window.print). At the call
   site the checker binds `print` to that lib declaration alone
   ("Duplicate identifier 'print'"), so the module-binding resolver
   (identity-based) finds no binding. For the plain name `p` the same shape
   resolves to the dynamic home. Legacy binds by name and is right by JS
   semantics: a script's top-level `var print` *is* the global binding.
4. **Root cause, part 2: the call.** Even with the binding resolved, the
   selector's call graph has no arm for a call whose callee is a dynamic module
   binding, and from-ast's dynamic-callee arm (#7106 Stage 4,
   `lowerDynamicValueCall`) covers dynamic locals and slots only. Reading the
   binding as a value inside a function already works (`typeof p` is IR).

Both parts were spiked in two selector / from-ast lines plus one resolver rule:

- the calls run with correct effects;
- a negative control throws;
- on 13 adversarial probes, verdicts and messages match legacy, with one
  exception (see the plan).

## Implementation Plan

**Design: a dynamic call through the existing dynamic home** — not a
certified direct callee.

- Calling the function *by identity* would need the closure's compiled body
  and ABI. With calls present, #7198's planner refuses the initializer
  (`scriptVarReferencesAreValueUses`), so `<module-init>` is legacy and the
  value in the slot is **legacy's function object**, whose call ABI
  (closure struct, `__argc`) is legacy's.
- The Stage-4 dynamic call (`__apply_closure`) already applies either
  producer's value, legacy's function object or #7198's boxed carrier. It
  reads the slot at call time, so it is exact under reassignment
  (`print = …` later) and before initialization (a TypeError). It needs no
  every-write certification, no new import and no new op.
- Value uses (`print.length`, `print.name`, passing `print`) are unchanged:
  #7198 already admits argument, `typeof` and `=` uses, and the rest stay
  refused.

Slices:

1. **Resolver: a script `var` shadowing a lib-only global**
   (`src/ir/module-bindings.ts`, `bindingDeclarationCandidates`). In a script,
   when the use's checker declarations are all in declaration files and the
   file has exactly one top-level `var` of that name, the binding is that
   `var`. Shared by the selector and from-ast; both already read this
   resolver. Redeclared `var`s (`var print` in the test as well as the
   prelude) stay unresolved, as today.
2. **Call through a dynamic module binding.** The selector call-graph arm
   (`buildLocalCallGraph`, the identifier-callee branch, before `markExternal`):
   when `currentModuleBindingResolver(callee).valueKind` is `dynamic`, the call
   is a lowering, not an edge; visit the arguments. from-ast `lowerCall`: the
   Stage-4 dynamic-callee arm also takes `resolveModuleBinding(callee)` of
   type `dynamic` (same `lowerExpr` + `lowerDynamicValueCall`). One predicate
   both sides call, placed with the module-binding helpers; no duplicate arm.
   The Phase-1 / dynamic-scan expression positions (result used as a value)
   follow the same predicate. In the spike only statement calls were needed;
   value positions get measured, and are refused if not exact.
3. **Tests + A/B** as dispatched.

**Known difference to decide.** A call before the initializer runs
(`function h() { p(); } h(); var p = function () {};`):

- legacy throws TypeError "Cannot access property on null or undefined";
- the IR throws TypeError "called value is not a function", the same as
  legacy's own message for `var p; p()`.

Node says "p is not a function". Matching legacy's message needs the
not-callable message to depend on the slot's declared initializer. Proposal:
accept the IR message, since the constructor is identical and legacy is
inconsistent itself, or refuse the call when the callee's `var` is declared
after the calling function. Lead's call.

**Expected yield.**

- #7287 alone moves **0** async units: `__consolePrintHandle__` then refuses
  only through the call-graph closure from `$DONE`, which needs #7286's
  `string + dynamic`.
- With #7277 + #7286 + #7287, both units are IR in the 130 stride files.
  Zero-legacy files: **0**, because every one of them keeps a legacy
  `<module-init>` (#7284).
- Other callers of lib-colliding script vars: measured by the ledger A/B
  (below).
