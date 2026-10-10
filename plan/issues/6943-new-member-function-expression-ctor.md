---
id: 6943
title: "`new T.Node(k)` — a constructor held in a member property (`T.Node = function(){…}`) compiles to `undefined`; the refusal diagnostic is swallowed (Octane splay, gc + standalone)"
status: ready
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
