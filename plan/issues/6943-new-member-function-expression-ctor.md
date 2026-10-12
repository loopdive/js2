---
id: 6943
title: "`new T.Node(k)` — a constructor held in a member property (`T.Node = function(){…}`) compiles to `undefined`; the refusal diagnostic is swallowed (Octane splay, gc + standalone)"
status: done
completed: 2026-10-10
sprint: current
created: 2026-10-10
updated: 2026-10-10
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: new-expression, constructor-functions
goal: correctness
related: [874, 6944, 6945, 6946, 6947, 2660, 3981, 4616, 5383, 1919, 3725]
assignee: "ttraenkler/claude-session-c-octane-new-member-function-expression-ctor-20261010"
loc-budget-allow:
  # 2026-10-10 (#6943) new-super.ts +99: the member-held user-function
  #   predicates (`resolvesToMemberHeldUserFunction`,
  #   `isMemberHeldUserFunctionNewCallee`), the host-lane arm helper and the
  #   documented sticky-degrade terminal refusal. They extend the existing
  #   construct-admission predicates that live in this file next to their two
  #   consumers; the call-site growth is one line each.
  - src/codegen/expressions/new-super.ts
func-budget-allow:
  # 2026-10-10 (#6943) compileNewExpression +2: the one-line host-lane call of
  #   `tryEmitMemberHeldUserFunctionHostNew` (all logic lives in the helper)
  #   plus its separating blank line; the terminal refusal moved into
  #   `reportNewExpressionRefusal` at zero net lines.
  - src/codegen/expressions/new-super.ts::compileNewExpression
---

# #6943 — `new <obj>.<prop>(…)` with a user function expression in the property evaluates to `undefined`

Found by the Octane triage (#874, Session C, 2026-10-10). This is the FIRST
blocker of `splay.js` on both lanes; #6946 and #6947 are the next two behind it.

## Problem

Octane `splay.js` defines its node constructor as a static property of the tree
constructor and constructs through the member:

```js
SplayTree.Node = function(key, value) { this.key = key; this.value = value; };
SplayTree.Node.prototype.left = null;
…
this.root_ = new SplayTree.Node(key, value);
```

Minimized (`.tmp/sp6.js`; a plain `var o = {}; o.Node = function…` receiver
behaves the same — `.tmp/sp5.js`; so does `var N = T.Node; new N(0.5)` on gc —
`.tmp/sp4.js`):

```js
function T() { }
T.Node = function (k) { this.key = k; };
export function main() { var n = new T.Node(0.5); return n.key + "," + (n.key == 0.5); }
```

| lane       | result                                                              |
| ---------- | ------------------------------------------------------------------- |
| node       | `0.5,true`                                                          |
| gc         | `undefined,false`                                                   |
| standalone | `TypeError: Cannot access property on null or undefined at 3:58`    |

Whole-benchmark symptom (`node --import tsx .tmp/octane-probe.mjs splay`, base.js
+ splay.js, driver runs Setup/run/TearDown): gc `Key not found: 0.9351…`
(`InsertNewNode` → `splayTree.insert` stores `undefined` nodes; `remove` then
cannot find the key); standalone traps.

The emitted code for `new T.Node(0.5)` is literally `call $__get_undefined;
local.set $n` (gc) / `global.get $undefined` (standalone): neither the
constructor nor the argument is evaluated, and `compile()` reports `success:
true` with `errors: []`.

## Root cause (confirmed)

1. `compileNewExpression` (`src/codegen/expressions/new-super.ts:6490`) has no
   arm for a member-access callee whose property holds an ordinary USER
   function. Instrumenting every `return` in the function shows the site exits
   at the terminal refusal, `new-super.ts:8543-8544`:
   `reportError(ctx, expr, "Unsupported new expression for class: __function"); return null;`
   (`className` is `__function` — the TS symbol name of the anonymous function
   expression, `new-super.ts:7191`).
   - The host-lane dynamic arm (`dynMemberCallee`, `new-super.ts:7929-7940`) and
     the standalone twin (`dynamicCtorValue` in `tryCompileNativeConstructFromValue`,
     `new-super.ts:3870-3876`) both admit a member callee only through
     `resolvesToDynamicAnyCtorValue` (`new-super.ts:812-845`), whose member arm
     requires the member's type fact to be `any`/`unknown`/`Function`. Under
     `allowJs` the checker types `T.Node` as the function expression's own
     type (call signature present, and — because the body assigns `this.key`
     — a JS-style construct signature too), so the predicate declines.
   - Pattern 2 (`callSigs.length > 0 && constructSigs.length === 0`,
     `new-super.ts:~7055`) does not fire either, for the same construct-signature
     reason, so nothing throws and nothing constructs.
2. The refusal is then silently DROPPED: `compileExpressionBody`
   (`src/codegen/expressions.ts:1016-1021`) treats the `null` result as a
   speculative-probe miss and calls `rollbackSpeculative`
   (`src/codegen/context/speculative.ts:131`), which truncates every non-`sticky`
   diagnostic pushed during the probe and substitutes a default value
   (`undefined`). Verified by instrumenting that truncation site: the one
   dropped entry is exactly this `Unsupported new expression` error. This is the
   #3725 failure mode ("clean compile that traps at runtime") for a refusal that
   was never marked `sticky`.

## Implementation Plan

Lanes: gc (host) and standalone (native construct driver). Linear: not affected
(it has no fnctor lowering; leave untouched).

1. **Admit the member callee** — in `resolvesToDynamicAnyCtorValue`'s member arm
   (`new-super.ts:812-845`) or a sibling predicate `resolvesToMemberHeldUserFunction`
   used at the same two consumers (`dynMemberCallee` `:7929`, `dynamicCtorValue`
   `:3870`): when `ctx.oracle.valueDeclarationOf(calleeExpr)` is a
   `PropertyAssignment`/expando `BinaryExpression` whose initializer (through
   parens) is a `FunctionExpression`/`FunctionDeclaration` reference, apply the
   same discriminator `resolvesToConstructableFunctionValue` (`new-super.ts:565`)
   already uses for identifiers: ordinary (non-generator, non-async,
   non-arrow, non-method) → admit; otherwise leave the non-constructor throw
   path alone. Evaluation order stays §13.3.5.1 EvaluateNew: callee value
   (member read, receiver first) → ArgumentListEvaluation → IsConstructor →
   [[Construct]]. The admitted site then goes through the EXISTING drivers:
   - gc: `emitDynamicNewFallback` → `__construct_closure` base (runtime
     `src/runtime.ts:16268`, which performs the IsConstructor probe and
     `Reflect.construct`), so `this.key = k` lands on the constructed object
     and `n instanceof T.Node` holds.
   - standalone: `tryCompileNativeConstructFromValue` → `__native_construct_<N>`
     (ordinary [[Construct]] of a closure, #3981/#6738).
2. **Also admit the aliased identifier form** `var N = T.Node; new N(k)` on gc
   (`.tmp/sp4.js` currently `undefined,false` on gc; standalone already works):
   `resolvesToConstructableFunctionValue` sees a `VariableDeclaration` whose
   call signature's declaration is the member-held `FunctionExpression` — it
   already returns true; the host lane needs the `calleeIdent` branch at
   `new-super.ts:7520-7540` to route to `emitDynamicNewFallback` when
   `!noJsHost(ctx)` as well (today that `tryCompileNativeConstructFromValue`
   call is standalone-only).
3. **Never again silently `undefined`**: make the terminal refusal at
   `new-super.ts:8543` a `sticky` diagnostic (`reportError(…, "error", { sticky: true })`)
   so `rollbackSpeculative` keeps it and `compile()` fails loudly instead of
   emitting `__get_undefined`; alternatively emit a catchable `TypeError`
   (`emitStaticNotAConstructorThrow`) — but a REFUSAL that is a compiler gap, not
   a program error, should be a compile error. Check the test262 standalone floor
   does not move: the arm is reached today only by programs that already
   misbehave.
4. **Tests** (`tests/issue-6943-new-member-held-ctor.test.ts`, real source
   through the public `compile()` on both lanes, compared with node via
   `tests/equivalence/helpers.ts` `assertEquivalent`/`compileToWasm`):
   - `.tmp/sp6.js` shape (function receiver), `.tmp/sp5.js` (object receiver),
     `.tmp/sp8.js` (`new T["Node"](…)` element form + `new` inside a helper),
     `.tmp/sp4.js` (aliased identifier), each asserting own fields and
     `instanceof`.
   - negative controls: `new T.Node()` where `T.Node = () => {}` and
     `T.Node = function*(){}` must throw `TypeError` (§13.3.5.1 step 5), and
     `new Math.abs()` keeps its static throw.
   - a `compile()` of the pre-fix repro must NOT report `success: true` with an
     empty `errors` array if any arm declines (sticky refusal).
5. **Acceptance**: the original Octane `splay.js` through
   `.tmp/octane-probe.mjs splay` no longer fails with `Key not found` on gc; the
   remaining failures are #6947 (gc) and #6946 (standalone), both reproduced with
   `.tmp/octane-probe-patched.mjs` (which rewrites `SplayTree.Node` to a
   function declaration to isolate this issue).

## Ownership note

`new-super.ts` / `expressions.ts` / `speculative.ts` are in Session A's
WasmGC/shared-IR area. Implementation is done by Session C at the project
lead's direction. Functions touched: `resolvesToDynamicAnyCtorValue`,
`compileNewExpression` (dynamic-callee block near `dynMemberCallee`, the
`calleeIdent` native-construct admission, and the terminal `reportError`),
`tryCompileNativeConstructFromValue` — nothing else.

## Implementation notes (2026-10-10, Session C)

What landed, all in `src/codegen/expressions/new-super.ts`:

- **`resolvesToMemberHeldUserFunction`** (new predicate, plan step 1): a member
  callee whose EVERY declaration (`ctx.oracle.declarationsOf` on the property
  name / string key) is an ordinary `FunctionExpression` — expando
  `T.Node = function…` or object-literal `{ Node: function… }`. Generator /
  async / arrow / method values are not claimed, so their §13.3.5.1 step 5
  TypeError path is unchanged (negative controls in the test).
  `resolvesToDynamicAnyCtorValue`'s member arm ORs it in, which admits the site
  into the existing standalone driver (`tryCompileNativeConstructFromValue` →
  `__native_construct_<N>`) at both of its consumers.
- **Host lane** (plan steps 1+2): the member/alias site carries the function's
  own symbol name `__function`, so the `!className` dynamic block (where
  `dynMemberCallee` lives) is never entered. A new arm right after the native
  construct fallback routes `isMemberHeldUserFunctionNewCallee` (the member
  itself, or an identifier whose initializer is one — `var N = T.Node`) to
  `emitDynamicNewFallback`; `usesHostConstructClosureBase` admits the same
  callee so the fallback's `__construct_closure` no-match base is armed.
  Evaluation order is the fallback's (callee, then arguments, then
  IsConstructor + [[Construct]] in the bridge).
- **Terminal refusal** (plan step 3) — DEVIATION: it is now `sticky` (survives
  `rollbackSpeculative`) but with severity **`degrade`**, not `error`.
  Measured before choosing: a compile-only sweep of the honest-harness test262
  assembly (`.tmp/sweep6943.mts`, gc, 2,000 of the 11,296 rows whose body has a
  non-builtin `new`) found 20 files that reach this refusal, and **6 of them
  pass today** in the CI baseline (`DataView/proto-from-ctor-realm-sab.js`,
  `Function/proto-from-ctor-realm.js`, `Function/prototype/bind/proto-from-ctor-realm.js`,
  `Proxy/get-fn-realm.js`, `Proxy/get-fn-realm-recursive.js`,
  `Proxy/ownKeys/return-not-list-object-throws-realm.js`) — a fatal refusal
  would turn each into a compile_error. It also fires inside probes whose
  sibling lowering later succeeds (`var F; F = function(){}; var o = new F();`
  at top level reports the refusal yet runs correctly), so a fatal sticky error
  would be a false compile failure there. `degrade` surfaces as a `warning` in
  `CompileResult.errors`: the refusal is no longer silent and the build still
  succeeds. The runner counts warnings as a pass only for NEGATIVE tests; a
  sweep of all 372 negative test262 files whose body contains `new` found none
  that reach this refusal, so the channel cannot flip a negative row.

Tests: `tests/issue-6943-new-member-held-ctor.test.ts` — 22 cases (sp6/sp5/sp4/sp8
shapes, object-literal property + instanceof, prototype identity; arrow /
generator / method / `Math.abs` negative controls; refusal diagnostic present
for a still-refused site). Base: 12 fail / 10 pass; head: 22 / 22.

### Remaining (not this issue)

Octane `splay.js` on gc now gets past `Key not found` and fails with
`traverse_ is not a function`; standalone fails with `called value is not a
function`. Root cause, minimized (`.tmp/neg12.js`):

```js
function o() {}
o.F = function (k) { this.key = k; };
o.F.prototype.get = function () { return this.key; };   // TOP-LEVEL
export function main() { return typeof o.F.prototype.get; } // node "function", gc/standalone "undefined"
```

The top-level statement is never compiled: `collectDeclarations`'
module-init keep gate in `src/codegen/declarations.ts` (the #4618 host arm and
the #2660 S2 standalone arm) keeps `F.prototype.m = …` only when `F` is a bare
top-level function identifier; `o.F.prototype.m = …` (receiver of `.prototype`
is itself a member chain) is dropped. The same write inside a function body
works on both lanes (`.tmp/neg13.js`). Pre-existing on base (also through
`mk(o.F, 7)`, which never touches this issue's arm). Needs its own issue; a fix
would extend those two keep arms to a callable member chain rooted at a
top-level function (`isTopLevelFunctionPropertyReceiver` on the `.prototype`
receiver).

Also observed, not asserted: on gc, `new T.Node(7).constructor === T.Node` is
`false` (node/standalone `true`; `.tmp/neg9.js`) — the host bridge constructs
the closure's host wrapper, whose `prototype.constructor` is the wrapper, not
the wasm closure value `T.Node` reads back. `Object.getPrototypeOf(n) ===
T.Node.prototype` and inherited method dispatch do hold.
