---
id: 6436
title: "A plain `f(x)` call inside a host-dispatched closure inherits the AMBIENT `this` instead of `undefined`"
status: done
sprint: current
created: 2026-09-12
updated: 2026-09-13
completed: 2026-09-13
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# (#6436, 2026-09-13) The fix adds one registry (`ctx.funcReadsOwnThis`, its
# doc comment is the bulk of the types.ts growth), its collect-time population
# at the two `needsImplicitArgumentsObject` sites plus the nested-lift one, and
# a trampoline lookup at four plain-call emission sites. The trampoline itself
# and its shared install/restore frame live in `src/codegen/named-this-call.ts`,
# which is under budget; what remains in the god-files is the registry
# declaration and one `?? trampoline` per call site, which cannot move.
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/declarations.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/call-tail-dispatch.ts
func-budget-allow:
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
  - src/codegen/context/create-context.ts::createCodegenContext
---

## Problem

A plain (non-method, non-`.call`) invocation of a named function reads whatever
`__current_this` happens to hold, instead of the `undefined` a plain call is
specified to install (§10.2.1.2 — `thisArgument` is `undefined` for an ordinary
`[[Call]]`, and a module body is strict, so there is no global-object
substitution).

```js
function withArguments(a, b) { return (this ? this.t : 'NO-THIS') + '|' + arguments.length; }
const tests = [];
function register(name, body) { tests.push({ name, body }); }
register('x', () => withArguments(1));
export function run() { return tests[0].body({}); }   // native  NO-THIS|1
                                                      // wasm    undefined|1
```

`tests[0].body(...)` is a METHOD call, so `emitClosureMethodCallExportN`
(`src/codegen/closure-exports.ts`) installs the receiver in the `__current_this`
module global for the duration of the arrow's body. The arrow correctly
inherits that `this` lexically — but the *plain* call it makes to
`withArguments` should not. `withArguments` has no `this` binding in scope, so
`ThisKeyword` resolution falls back to `__current_this` and picks up the
dispatcher's receiver. The wrong answer is silent: `this` is a truthy object,
so `this ? … : 'NO-THIS'` takes the wrong branch and reads `undefined` off it.

Measured 2026-09-12 on `upstream/main` `e8a778638f`, probe via `compileProject`
on a two-file untyped `.js` project. It reads identically before and after
[#6416](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6416-arguments-length-under-applied-call)
— that fix repaired the `arguments.length` half of the same expression
(`|2` → `|1`) and left the receiver half untouched, which is how this was
isolated.

## Where to look

- `ensureCurrentThisGlobal` / the `__current_this` fallback in `ThisKeyword`
  resolution (`src/codegen/statements/nested-declarations.ts`).
- `emitClosureMethodCallExportN` (`src/codegen/closure-exports.ts` ~L1265)
  already save/restores `__current_this` around its `call_ref`; the gap is that
  nothing clears it for a plain call made *inside* that window.
- The #3796 named-`this` trampoline is the model for the correct shape: a call
  that knows its receiver installs one. A plain call knows its receiver is
  `undefined` and should install that, rather than leaving the global alone.

The cost question is whether every plain call to an `arguments`/`this`-reading
named function has to null the global (two globals' worth of stores on a hot
path), or whether the callee can be told at compile time that it has no `this`
binding — most plain call targets are statically known.

## Acceptance criteria

1. The repro above answers `NO-THIS|1`.
2. `.call`/`.apply`/`.bind` receivers are unchanged (#5341's suite stays green).
3. A method call's own `this` is unchanged, including nested method calls.
4. Regression test with untyped `.js` two-file fixtures, failing on the parent
   and passing with the fix, plus an anti-vacuity control.
5. A/B over the 17 dogfood suites — no regression.

## Implementation Plan

**Confirmed 2026-09-13 on `upstream/main` 54c36a9fe3** (probe in `.tmp/probe-6436/`, 8 fixtures): repro → `undefined|1` (native `NO-THIS|1`). Also wrong: `withArguments.call(undefined, 1)` inside the window (the #4203 legacy drop-through), and a dispatched named *function expression* plain-calling it. Correct already: plain call through a closure param (`invoke(body)` — `emitClosureCallArgcExtras` path does not install a receiver), `this`-free callee, top-level plain call, obj-literal-method and class-method callers.

**Responsible arm.** `src/codegen/function-body.ts:360/375` sets `readsCurrentThis = functionLikeReferencesOwnThis(decl)` for every named declaration (#2152, so HOF `thisArg` dispatch works). `compileThisKeyword` (`src/codegen/expressions/this-keyword.ts`, `readsCurrentThis` rung) then reads `__current_this` and only null-guards it. A plain `call $f` (`call-identifier.ts:4254`, `call-tail-dispatch.ts:1687`, `calls-optional-direct.ts:129`, and the `.call`/`.apply` legacy arms at `calls.ts:8738/8820` when `resolveNamedThisCallTarget` returns undefined) installs nothing, so inside `emitClosureMethodCallExportN`'s window the callee sees the dispatcher's receiver. The gate cannot be static on the CALLER (the arrow in the repro never reads `this`); it must be on the CALLEE, which is statically known at all five sites.

**Fix — install `undefined` at plain-call sites whose callee reads its own `this`, via a per-target trampoline (the #3796 shape).**
1. Registry: add `ctx.funcReadsOwnThis: Set<string>` to `src/codegen/context/types.ts` (next to `funcUsesArguments`, L2717) and initialise it wherever `funcUsesArguments` is. Populate at the same three sites that call `needsImplicitArgumentsObject`: `declarations.ts:1879` and `:3026` (`if (functionLikeReferencesOwnThis(stmt)) ctx.funcReadsOwnThis.add(name)`), and `statements.ts:313` (mirror the add/delete restore for nested lifts). Must be filled at collect time, not body-compile time — call sites compile before hoisted bodies.
2. Trampoline: in `src/codegen/named-this-call.ts`, hoist the `installAndCall` closure of `ensureNamedThisCallTrampoline` (L302–380, including the #4620 park-result-in-local try_table shape) into a module-level helper, then add `ensureNamedPlainCallTrampoline(ctx, name, targetFuncIdx, targetFunc, params, results)`: signature `(...targetParams) -> results`, body = `installAndCall([{op:"ref.null.extern"}])` with NO `ref.is_null` split, own cache keyed by `targetFunc` (separate `WeakMap`), name `__named_plain_call_<name>_<ordinal>`. Keep the existing `.call` trampoline bytes untouched (its null arm stays the unbound exact call — #4203/#4025 tests pin it).
3. Call sites: at the five `fctx.body.push({ op: "call", funcIdx: finalFuncIdx })` sites above, when `ctx.funcReadsOwnThis.has(funcName)` and `definedFuncAt(ctx, finalFuncIdx)?.name === funcName` and the func type has ≤1 result, call the trampoline instead. Order constraint: resolve `finalFuncIdx` AFTER arguments compile (index shifts — the sites already do this), mint the trampoline AFTER `maybeSetArgcForKnownCall` (argc/extras globals are read by the callee prologue; the trampoline pushes nothing). In `call-tail-dispatch.ts` a `return_call` through the trampoline is fine (it restores before returning). For the `calls.ts:8738` `.call` arm apply the same replacement only when `namedThisCall` is undefined AND `expr.arguments[0]` is statically nullish (`factIsStaticallyNullish`) — closes the `.call(undefined)` sibling for free; skip if it disturbs #4203 bytes.
4. Do NOT touch `this-keyword.ts` or `readsCurrentThis` — the null-guarded read is what makes the installed `undefined` resolve through `emitUnboundThis` (strict → undefined, sloppy → globalThis), so no strictness gate is needed at the call site.

**Probe first**: rerun `.tmp/probe-6436/probe.mts` (as a `tests/probe-*.test.ts` under vitest) before and after; all 8 lines must read as native.

**Regression test** `tests/issue-6436-plain-call-ambient-this.test.ts`, modelled on `tests/issue-6416-stale-extras-argv.test.ts` (untyped `mod.js` + `entry.ts`, `compileProject` gc/node): (was ✗) the repro; `.call(undefined, 1)` in the window; dispatched function-expression body plain-calling; plain call AFTER a throwing plain call caught inside the arrow, then arrow reads `this` (proves exception-safe restore); nested `withArguments()` inside a method call inside the window. Controls (green on parent, must stay green): `tests[0].body({t:'T'})` where the body is `function(){ return this.t }` (dispatcher receiver unchanged); `.call({t:'T'},1)` in the window → `T|1` (#5341); class-method/obj-method callers; a `this`-free callee emits NO `__named_plain_call_` helper (grep WAT — anti-cost). Anti-vacuity: `register('x', () => { const s = this; return withArguments(1) + '/' + String(s === undefined); })` must read `NO-THIS|1/true` only because the *plain* call is cleared while the arrow's own lexical `this`... is `undefined` at module level — replace with the #6416 shape: rest-param arrow proves the replay really over-applies with a receiver (`tests[0].body({})` vs `tests[0].body()` → `1/0`).

**Dogfood** (anchors: webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740 · lodash 59/62 · redux 67/82 · axios 208/231 · stylelint 108 · tailwindcss 13 · jsdom 6 · styled-components 9 · uuid 75 · marked 16/30 · moment 10 · prettier 107/151 · jest 335/356 · hono ~261/324): the harness shape (`body(assert)` over-applied member call) is every suite's first test, so any package helper with a `this ||`/`this ?` guard called plainly from a test body flips. Expect neutral-to-positive; watch axios/redux/lodash/prettier. A/B all 17; any drop is a real finding (a callee that accidentally relied on the leaked receiver).

**Standalone lane**: no host involvement — `__current_this` is a pure Wasm global and `installAndCall` already carries the wasi/standalone `try_table` + parked-result shape (#4620). Run the new test's repro under the standalone target too; expect identical answers and no floor movement.

## Dispatch

**opus** (medium): the diagnosis is confirmed and the shape is a known trampoline, but it spans a registry, a helper refactor that must keep #3796/#4203 bytes identical, and five call sites with index-shift ordering — enough coordination to need more than a mechanical pass.

## Resolution

Fixed 2026-09-13 (branch `issue-6436`, base `upstream/main` 69ccb3494f).

**Mechanism.** A plain `f(x)` emitted a bare `call $f` and installed no
receiver, so a callee whose `this` resolves through the `__current_this` module
global read whatever a dispatcher had parked there. Plain calls now route
through a per-target trampoline that installs `undefined` for the duration of
the call and restores the previous receiver on both the normal and the
unwinding exit.

Three pieces:

1. **`ctx.funcReadsOwnThis`** (`src/codegen/context/types.ts`) — the set of
   named declarations whose `this` reads the global, minus those taking an
   explicit `this` parameter (`readsAmbientThisGlobal` in
   `src/codegen/helpers/body-references-own-this.ts`). Populated at COLLECT
   time next to `funcUsesArguments` (`declarations.ts` ×2,
   `statements/nested-declarations.ts`), because call sites compile before
   hoisted bodies do; shadow save/restore mirrored in `statements.ts`,
   `nested-function-name-scope.ts` and `runtime-module-callable-metadata.ts`.

2. **`ensureNamedPlainCallTrampoline`** (`src/codegen/named-this-call.ts`) —
   `(...targetParams) -> results`, body = install `ref.null.extern`, exact
   call, restore. It reuses the #3796 `.call` trampoline's save/install/restore
   frame, extracted to the module-level `installAndCallFrame` (including
   #4620's parked-result `try_table` shape), with its own cache so the `.call`
   trampoline's bytes and ordinals do not move. No `ref.is_null` split: a plain
   call's receiver is statically absent, not a runtime value to test. It
   installs a plain null, NOT the #4203 explicit-null marker — `f()` is an
   ABSENT receiver, which the callee's null-guarded read already answers as
   `undefined` (strict) / globalThis (sloppy).

3. **Four call sites** — `call-identifier.ts`, `call-tail-dispatch.ts`,
   `calls-optional-direct.ts`, and the `.call`/`.apply` legacy arms in
   `calls.ts`. The trampoline is resolved from the FINAL (post-argument)
   handle and minted after `maybeSetArgcForKnownCall`, so the argc/extras
   protocol is untouched. The `calls.ts` arms use
   `resolveUndefinedReceiverTrampoline`, which applies only when the #3796
   trampoline declined AND the receiver is statically `undefined`/`void` —
   a provably-`null` receiver keeps the #4203 marker path and its bytes.

Async and generator targets are deliberately excluded: their bodies do not run
inside the call, so clearing the receiver around the synchronous half would
install nothing useful.

**Evidence.** Probe of 15 fixtures, every expectation taken from a native Node
run of the same source rather than assumed (two of the plan's control
expectations were wrong that way — `tests[0].body({t:'T'})` makes `tests[0]`,
not `{t:'T'}`, the receiver). On the parent: 7 wrong, 8 right. With the fix:
15/15. Regression test `tests/issue-6436-plain-call-ambient-this.test.ts`
carries all of them plus a WAT anti-cost control (a `this`-free callee mints no
`__named_plain_call_` helper).

**Pre-existing failures on this base, NOT caused by this change** — verified by
reverting `src/` and re-running: `tests/issue-1702-strict-this.test.ts` (2),
`tests/issue-4025-apply-call-this-binding.test.ts` (3), and
`tests/equivalence/arguments-nested-and-loops.test.ts` "for-loop with function
declaration in body" (a loop-capture bug: 30 vs 33).
