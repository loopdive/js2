---
id: 7454
title: "Prepared path: `o.m()` on an object literal holding a function expression is refused"
status: ready
created: 2026-11-22
updated: 2026-11-26
priority: high
horizon: s
goal: ir-full-coverage
sprint: Backlog
related: [7354]
---

# #7454 — Prepared path: `o.m()` on an object literal holding a function expression is refused

## Problem

`function f(){ var o = {m: function(){ return 1 }}; return o.m(); }` refuses with `physical setup cannot be materialized (js.closure.call:0)`. This is the most common method-call shape in the test262 harness and in ES5 tests.

Found on 2026-11-22 during the #7354 slices (Prepared whole-program IR path).

## Acceptance criteria

- The program returns 1 on the Prepared path.
- `this` inside `m` is `o`.
- Mutated twin (returning 2, asserting 1) fails through the real runner.

## Probes (2026-11-26, head 6694a8b839)

Prepared entry, runner options (`runnerOptions()` in `tests/helpers/prepared-node-agreement.ts`). "Refuse" is
`compile(…, "refuse")`; "run" is the default compile, run. Each body sits in `function f(){ … }` and the program
throws unless `f()` returns the expected value. The message in the problem statement above is stale: since #7354 U
the refusal is an abort body (f traps `unreachable` when called).

| Case | Refuse-mode message | Run |
| --- | --- | --- |
| `var o = {m: function(){return 1}}; return o.m();` | `method call .m(...) on externref not in slice 4 (f)` | trap |
| same, `this.x` / `o.m(1, 2)` / returns `'ab'` / returns `{k: 5}` | same | trap |
| `this.n()` inside m; m reads an outer local `k` | same | trap |
| `o.m = function(){…}` after creation, then `o.m()` | same | trap |
| statement `o.m();` | same | trap |
| `({m: function(){…}}).m()` inside f | same | trap |
| `o.hasOwnProperty('n')` on a local literal | `method call .hasOwnProperty(...) on externref …` | trap |
| `var o = {m: function(){ return this === o }}` | `identifier "o" is not in scope in f__closure_0` | trap |
| shorthand `{ m(){…} }` (ES2015, note only) | `closure must have a return type annotation (f)` | trap |
| top-level `var o`, `o.m()` (also `this.x`, args, `this === o`) | OK | works |
| `var h = o.m; return h();` | OK | works |
| `o['m']()` | OK | works |
| nested `o.p.m()` (with `this.x`) | OK | works |
| literal passed as a parameter, `p.m()` (also `this.x`, `this.n()`, args) | OK | works |

The element-call form `o['m'](…)` already runs every shape the property form refuses: `this.x`, a write through
`this` seen on `o`, args, string and object results, `this.n()`, a captured local, a method assigned after creation.
Identity holds through dynamic parameters: `same(o['m'](), o)` returns true; a mutated twin comparing with another
object throws. The property form reuses exactly that path after the fix.

Refusals the fix does not touch (each also refuses under `o['m']()`):

- `o.m() === o`: `Phase 1 requires matching operand types for '==='` (dynamic against a raw externref).
- `var o = {m: function(){ … o … }}`: the closure captures `o` inside its own initializer.
- `var r = 0; … function(){ r = 1 }`: `nondefaultable reference widening needs a separately authenticated physical
  post-state` (a closure that writes an outer local).
- A program that creates no function value: `js.closure.call:0 … creates no function value has no Prepared
  intrinsic` (e.g. `({}).m()` alone). This is still an abort body, as it is today.

## Cause

- A function-local literal on the Prepared path is an ordinary object built by `lowerOrdinaryObjectLiteral`
  (`src/ir/from-ast.ts:6735`). Its value is the raw `externref` that `js.object.create-default` returns (6738–6739).
  A local `var o` keeps that type. The literal is typed `externref` on purpose: the typed O1 read
  `lowerPreparedOrdinaryPropertyRead` (6233) requires that raw carrier (invariant at 6248).
- The read arm (6593) and the write arm (10654) already box a raw externref receiver onto the dynamic carrier through
  `isRawExternrefReceiver` (6904). The method-call arm in `lowerMethodCall` admits only `recvType.kind === "dynamic"`
  (9888). A raw externref falls through to `throwMethodCallNotInSlice` (8840, thrown at 10220).
- The top-level case works because a script `var` lives in its dynamic home, so the receiver is `dynamic`. A
  parameter and `o.p` are `dynamic` too. `o['m']()` works because `lowerPreparedValueCallee`
  (`src/ir/function-object-lowering.ts:342`) sends every element-access call to `lowerFunctionObjectMemberCall`
  (294). `lowerDynamicMemberCall` (308) puts a non-dynamic receiver into the carrier through
  `functionObjectDynamicValue` (161, externref arm 174–186).

## Implementation Plan

**Target.** `lowerMethodCall` in `src/ir/from-ast.ts`, the dynamic arm at 9888–9891. No new module, arm or helper.

**Change.** Hoist the function-object branch out of the `recvType.kind === "dynamic"` block and widen its
condition to the receiver the sibling read and write arms already accept:

```ts
if (functionObjects.createsFunctionObjects(cx.resolver) && (recvType.kind === "dynamic" || isRawExternrefReceiver(recvType, cx)))
  // (#7354 F2) [[Get]], then the call with `this`; (#7454) a function-local object is boxed first, as its read is.
  return functionObjects.lowerDynamicMemberCall(expr, expr.expression, () => recv, functionObjectLoweringHost(cx));
if (recvType.kind === "dynamic") { /* host-lane body, unchanged */ }
```

- **Reuse.** `lowerDynamicMemberCall` and `functionObjectDynamicValue` already box the receiver (as for
  `o['m']()`), do the [[Get]], and call through `js.closure.call:N` with the receiver first. `isRawExternrefReceiver`
  is the predicate the read and write arms use.
- **Duplicate removed.** The local-literal path and the top-level path then differ only in the receiver's IR type.
  They share one call arm, as they already share one read arm and one write arm. There is no second method-call arm.
- **Not unified here (cleanup, own issue).** A raw externref becomes dynamic in two spellings: `emitBox(recv,
  irDynamic())` in the read and write arms (from-ast.ts:6594, 10660), and `__ir_dyn_call_box` through
  `functionObjectDynamicValue`. Folding them touches the ordinary pipeline's `__ir_dyn_call_box` body
  (`src/codegen/dyn-ops.ts`) and the kind proof in `src/ir/program/dynamic-value-chains.ts:64`, so it does not belong
  in an S fix. Allocate its id with `claim-issue.mjs --allocate` and link it from the PR.
- **Rejected alternative.** Typing the local literal `dynamic` (as the top-level home is) would fix every consumer at
  once, but it breaks O1's typed reads, which need the raw carrier (6248). That is a representation change for its
  own issue. The fix here is the one sibling arm the O3 pattern left out.

**`this`.** Unchanged mechanism: `nativeClosureCall` (`function-object-lowering.ts:527`) passes the boxed receiver
first, and the callee reads it through `dyn.current_this`. The `o['m']()` probes show `this.x`, a write through
`this`, and identity through dynamic parameters.

**Gating.** `createsFunctionObjects` is set only by `programDynamicContracts`
(`src/ir/source-dynamic-contracts.ts:363`, `:405`), which only the Prepared producer calls
(`src/ir/program-source.ts:1576`). The ordinary pipeline and the JS-host lane do not change, and their output stays
byte-identical. Between 9888 and 10220 no arm accepts a `val externref` receiver: the number arms need `f64`, the
extern-class arm needs `extern`, the vec arms need `vec`. So the routing takes no shape away from another arm.

**Stays refused, by name** (follow-ups; none is in Session B's areas):

- `o.m() === o`: strict equality of dynamic against a raw externref (`Phase 1 requires matching operand types`). A
  separate consumer, equality's operand boxing.
- A closure that reads the binding its own initializer defines (`identifier "o" is not in scope`), and a closure that
  writes an outer local (`nondefaultable reference widening`). Both belong to the closure-capture mechanism (Fa/Fb).
- A program with no function value: `js.closure.call:N` has no Prepared intrinsic there. It is program-level and
  stays an abort body.
- The ES2015 method shorthand `{ m(){…} }`: `closure must have a return type annotation`. Out of the ES5 goal.

**Tests.** New file `tests/issue-7454-literal-method-call.test.ts`, written like `issue-7354-p1-method-values.test.ts`:

- Node agreement plus a wrong-answer twin (`agreesWithNode(…, true, runnerOptions())`, PRELUDE `CATCHES`). Cases,
  each inside a function:
  - the issue's program;
  - `this.x`;
  - a write through `this` read back as `o.y`;
  - `same(o.m(), o)` through dynamic parameters;
  - `o.m(1, 2)`;
  - string and object results;
  - `this.n()` inside m;
  - a captured outer local;
  - `o.m = function…` after creation;
  - statement-position `o.m();` (effect seen through `this.hit`);
  - `({m: …}).m()`;
  - `o.hasOwnProperty('n')`;
  - `t(function(){ o.missing(); })` and `t(function(){ o.n(); })` with `n: 1`, both a TypeError.
- Real runner: `assembleOriginalHarness(source, parseMeta(source)).primary.source` (`tests/test262-original-harness.ts`
  and `tests/test262-runner.ts`, as `scripts/ir-census/prepared-census.mts` uses them) compiled with
  `runnerOptions()`. The body is `function f(){ var o = {x: 1, m: function(){ return this.x; }}; return o.m(); }
  assert.sameValue(f(), 1);`. It must return. The mutated twin (m returns 2, still asserting 1) must throw a JavaScript
  exception, not trap.
- Refusal pins with `refusal()` / `abortBodies()`: the four "stays refused" rows above, each with its message.
- Mutation check before release: revert the condition, and the agreement cases fail (trap). Keep
  `issue-7354-p1-method-values`, `-o3-member-write`, `-o4-member-read`, `-f2-calls-through-values` and `-u-prelude`
  green.

**Measurement.** Measured 2026-11-26 on head 6694a8b839, as a stand-in rather than a census.
- **Candidate set.** An AST scan of the 9,174 ES5 files (`classifyEdition` list, seed 7106) kept every non-negative,
  non-async file in which one function body holds both an object literal and an `x.m(…)` call: 357 files. A file
  can reach this refusal only by having that shape somewhere in its program.
- **Run.** Each of the 357 files was compiled with the real runner's assembly and options, and its abort-body table
  was read. Result: 103 pass, 54 fail, 200 compile errors. **No file carries a `method call … on externref` abort
  body**, in the test or in its harness.
- **Narrower scans.** Only one ES5 file calls a method on a function-local literal at all
  (`built-ins/Boolean/prototype/toString/S15.6.4.2_A2_T5.js`, inside an `assert.throws` arrow). It does not reach
  the abort: it stops on an earlier gap.
- **Shared sample.** The 411-row sample (`plan/samples/7354-o411.txt`, branch `claude/7354-o411-sample` 155b06691f)
  shares 0 files with the 357. **Estimate: 0 rows move on it.** The PR is measured on that sample with
  `plan/samples/7354-tally411.mjs`, and must show no row moving to an earlier gap.
- **The premise does not hold.** The problem statement's "most common method-call shape in the harness and in ES5
  tests" is wrong for the Prepared path. ES5 bodies put such objects at top level, in the dynamic home, which already
  works. The harness prelude has no such call (see the `issue-7354-u-prelude` abort table).
- **Ranking.** This fix completes a mechanism (the sibling of O3's read and write arms) with no measured ES5 yield.
  Under "foundations first" it ranks below the measured gaps. It is worth taking only as a small fix, or bundled with
  the equality and capture follow-ups that make `this === o` inside a function work.

**Acceptance.**

- The issue's program returns 1 on the Prepared path. `this` inside m is o (`this.x`, a write through `this`, identity
  through dynamic parameters). The mutated twin throws through the real runner's assembly.
- The "stays refused" rows keep their messages. No test262 verdict regresses. Ordinary-pipeline and gc bytes are
  identical.
- Code quality:
  - the change is the condition of the existing arm, with no new arm, helper or parameter;
  - the read, write and call arms accept the same receivers through the same predicate;
  - `src/ir/from-ast.ts` is at its LOC ceiling (17,340 in `scripts/loc-budget-baseline.json`). The wrapped condition
    costs about +2 lines. Carry a dated `loc-budget-allow:` grant of at most +3 in this issue's frontmatter, and have
    the review agree to it. No other growth is allowed;
  - the boxing cleanup issue is filed and linked;
  - an adversarial review agent's verdict is recorded in the PR body.

**Risks.**

- A raw externref on the Prepared lane that is not an ordinary object (a #7128 open carrier, a host handle) now takes
  the dynamic call. That is still the right semantics: [[Get]] handles every kind, and the Prepared lane has no host.
  Covered by the 7354 suites above.
- The probe evidence for the fixed shape is by proxy (`o['m']()` takes the same `lowerDynamicMemberCall`). The new
  tests confirm it on the property form.

**Size.** S. About 4 lines changed in `src/ir/from-ast.ts` (net +2 at most) and a test file of about 120 lines.
