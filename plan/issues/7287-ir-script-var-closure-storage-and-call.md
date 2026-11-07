---
id: 7287
title: "IR: a script `var` holding a function expression is storable and callable from IR units"
status: done
completed: 2026-11-07
sprint: current
created: 2026-11-06
updated: 2026-11-07
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
  # 2026-11-06 (#7287 slice B): from-ast.ts +6 / select.ts +6 — the one arm
  # each side adds to its existing call dispatch (the Stage-4 dynamic-callee
  # arm also takes a dynamic module binding; the call graph treats that call as
  # a lowering, not an edge), with the message choice from the declaration.
  # 2026-11-07 (review): from-ast +9 / select +5 net — the arm moved after the
  # propertyHelper alias arms and limited to statement position on both sides.
  - src/ir/from-ast.ts
  - src/ir/select.ts
func-budget-allow:
  # 2026-11-06 (#7287 slice B): one arm each in the existing call dispatchers;
  # splitting `lowerCall` / `buildLocalCallGraph` is its own refactor.
  - src/ir/from-ast.ts::lowerCall
  - src/ir/select.ts::buildLocalCallGraph
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

## Results (2026-11-07, base `origin/main` dc52abf7)

**What changed.**

- Slice A (`1713793e`): `bindingDeclarationCandidates` binds a script's single
  top-level `var` whose name only a lib declares (`print`) to that `var`.
- Slice B (`10b21deb`, review fix `3fa3939f` + statement-position fix): a
  **statement-position** call whose callee is a script `var` in its dynamic
  module home is the Stage-4 dynamic call (`__apply_closure` on the slot at
  call time). It sits after the propertyHelper alias arms on both sides, in
  the selector's order.
- Value-position calls (`return p(3)`) stay legacy: a lib-named `var`'s call
  result is typed by the lib signature (`var isNaN = function () { return "U"; }`
  then `return isNaN(1)` read as `true`), caught by the #7253 equivalence
  cases. Pinned by a test.
- Not-callable message (lead's decision): a function/arrow initializer gives
  "Cannot access property on null or undefined", otherwise "called value is
  not a function". Where legacy traps (`p = 5`), the IR throws that TypeError.
- ES modules: unchanged (their `var`s have no script-var home; the resolver
  rule is script-only).

**Measurements.**

| Check | Result |
|---|---|
| Typed corpus (playground, gc/standalone/wasi) | byte-identical to main |
| Ledger, standalone, wrapped, stride 40 (1296 files) | = main: zero-legacy 32, legacy units 4750, invariants 0 (slice A, A+B, after review) |
| test262 A/B, 833 paths (300 random + JSON + async + Object/Reflect), standalone | 658/117/32 — row-identical to main |
| same, gc | 533/252/22 — row-identical to main |
| 33 adversarial probes (standalone) | = legacy except the `p = 5` cases: legacy traps, IR throws TypeError |
| `tests/issue-7287-script-var-closure-call.test.ts` | 51/51 (gc/standalone/wasi) |
| Equivalence gate | see PR |

The test262 A/B ran before the statement-position restriction, which only
removes claims.

**Yield.** 0 on its own, as planned: the async harness units also need #7277
and #7286, and zero-legacy files stay 0 because `<module-init>` is legacy
(#7284).

**Probe routing.** IR: the prelude's `print`, a call before the definition,
reassignment, wrong arity, `this`, recursion, `arguments`, captured script
vars, arrows, a not-callable value. Legacy: `delete`, `.call` / `.apply`,
`new`, a capturing inner closure, an inner shadow, a redeclared `var`, a
`print` parameter.

**Legacy defect the IR corrects: a non-callable, non-null value.** Repro
(standalone; gc and WASI the same):

```js
var print = function () {};
print = 5;
function h() { print(); }
h();
```

Legacy compiles `print()` as a typed closure call and traps with
`RuntimeError: dereferencing a null pointer` (uncatchable by JS `try`). The
IR's dynamic call checks callability and throws a catchable TypeError
("Cannot access property on null or undefined"), as node throws a TypeError.
The head throws where the base traps; there is no case where the head traps
and the base throws. Pinned by "message: function-initialized, reassigned to
a number".

The compiler-boundaries inventory gate (`node scripts/check-compiler-boundaries.mjs
--mode inventory --base origin/main`) passes: this change adds no module.

## Adversarial review (fresh context, 2026-11-07)

Verdict: 1 must-fix, 3 should-fix, 2 nits.

- **Must-fix, fixed:** the new arm ran before the #7106 S1g propertyHelper
  alias arms, so `__hasOwnProperty(o, k)` took the generic apply instead of
  the own-property provider. Moved after them; the repro now emits the
  provider call, as on main.
- **Should-fix, rebutted:** "two predicates" — from-ast's
  `resolveModuleBinding(…).type.kind === "dynamic"` is the selector's
  `valueKind.kind === "dynamic"` mapped by `resolveModuleBindingGlobal`, the
  only kind that maps to `irDynamic()`; the two cannot disagree.
- **Should-fix, fixed:** the selector arm is now an `else if` like its siblings.
- **Should-fix, rebutted after measurement:** making `isAmbientBinding`
  answer `false` for a shadowing script `var`. Tried; it does not change
  routing here, and the checker-derived typing it would expose is the same
  hazard the statement-position limit addresses. Left as is.
- **Nits, fixed:** the message comment no longer claims legacy throws for
  every non-callable value; the message plumbing is one conditional.
