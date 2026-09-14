---
id: 5372
title: "`const u = cond ? await f() : v` inside an async function leaves `u` holding the Promise — the await in a conditional-expression operand is not suspended on (marked Hooks cluster B, the 10 async tests)"
status: done
assignee: ttraenkler/sendev-5372
completed: 2026-09-12
sprint: current
created: 2026-09-06
updated: 2026-09-12
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
related: [5367, 6409, 6410, 5358, 5345, 3722, 4302, 2906]
# 2026-09-06 (#5372): the frame-aware reaction import `Promise_then2_frame` is
# registered next to the six host async imports (import-collector finalize) and
# emitted at the resume machine's one reaction site (async-frame) — a trap
# while a driven frame resumes now rejects the frame's result promise instead
# of killing the host process (marked Hooks.test.js went 9/30 → 0/30 without
# it). +15/+16 LOC; the additions sit in the functions that own those exact
# sites. Its runtime side lives in src/runtime/promise-then-reactions.ts
# (2026-09-12: runtime.ts is at the #4401 ceiling, net 0 lines there).
loc-budget-allow:
  - src/codegen/declarations/import-collector.ts
  - src/codegen/async-frame.ts
# 2026-09-12 (#5372): `planTryCatchCfg` grows by exactly the 4 lines prettier
# needs to wrap its widened signature (`hoist` flag) — no logic added.
func-budget-allow:
  - src/codegen/async-cps.ts::planTryCatchCfg
  - src/codegen/declarations/import-collector.ts::finalizeUnifiedCollector
  - src/codegen/async-frame.ts::ensureAsyncResumeFunction
  - src/codegen/async-frame.ts::buildStateBody
---

## Problem

Split out of #5358 after its agent measured that marked's 10 async
`Hooks.test.js` failures are NOT the runtime-key read the issue was filed for.

Inside an async function, an `await` that sits in a branch of a conditional
expression used as a variable initializer is not suspended on for most
callee shapes — the binding receives the **Promise** itself:

```js
function later(v) { return new Promise((r) => setTimeout(() => r(v), 1)); }
async function laterAsync(v) { await later(0); return v; }

async function f(cond) {
  const u = cond ? await later("A") : "B";     // u is a Promise, not "A"
  ...
}
```

Measured on `a22e2d2623` + #5672 (standalone `.mjs` through
`compileProject`, `target: "gc"`, untyped `.js` fixture), every variant an
async function with `cond === true`:

| initializer                                              | `u` reads   |
| -------------------------------------------------------- | ----------- |
| `cond ? await later("A") : "B"` (plain fn → `new Promise`) | **Promise** |
| `cond ? "B" : await later("A")` (await in the else branch)| **Promise** |
| `cond ? await laterAsync("A") : "B"` (async fn callee)   | **Promise** |
| `cond ? await fn("A") : "B"` (any-typed callee param)    | **Promise** |
| `cond ? await hooks.pre("x") : "B"` (object-literal `async pre()`) | `"Px"` ✓ |
| `await later("A")` (no conditional)                      | `"A"` ✓     |
| `let u = "B"; if (cond) u = await later("A");`           | `"A"` ✓     |

Only the object-literal async-method operand suspends. A direct call to a
function declaration, an async function declaration, or an `any` callee does
not — the await is dropped and the Promise flows on as the value.

## Why marked cares (this is Hooks cluster B)

marked's `parseMarkdown` async arm is exactly this shape:

```js
return (async () => {
  let u = i.hooks ? await i.hooks.preprocess(n) : n,
      c = await (i.hooks ? await i.hooks.provideLexer(e) : e ? x.lex : x.lexInline)(u, i),
      ...
  return i.hooks ? await i.hooks.postprocess(h) : h;
})().catch(o);
```

With `u` a Promise, the lexer receives `"[object Promise]"`-shaped input and
the pipeline degrades until `parse` resolves `undefined`; the test then reads
`html.trim()` and dies with `Cannot read properties of null (reading 'trim')`
— the error #5345/#5358 attributed to the hook read. A marked-free bisect of
that shape (`asyncParse` in the #5358 notes) answers
`html="<p>[object Promise]</p>"`; the hook wrapper `use()` installs works on
its own (`wrapperOnly` → `"Wmd"`), and the sync arm works (`syncParse` →
`"<p>St</p>"`).

The 10 tests: `should preprocess async`, `should preprocess options async`,
`should postprocess async`, `should process all hooks in reverse`, `should
provide lexer async`, `should provide lexer async hook`, `should provide async
lexer from async hook`, `should provide parser async`, `should provide parser
async hook`, `should provide async parser from async hook` — `Hooks.test.js`
stays 9/30 with #5358 merged.

## Where to look

`src/codegen/async-cps.ts` has a conditional-initializer arm (~L1747:
`if (ts.isConditionalExpression(initializer))`) that recognizes exactly this
shape, gated on `awaitSet.has(initializer.whenTrue|whenFalse)`. The table
above says the arm (or the fallback it returns `null` into) treats the operand
differently by callee shape, so the first question is how `awaitSet` is built
— whether an `await` whose operand is not a checker-visible `Promise<T>` (an
`any` call, a `new Promise` return) is left out and the await then compiled as
a no-op. Also check the `let u = …, c = …` multi-declarator form marked uses
(`seen === decls.length`).

## Acceptance criteria

1. Every row of the table reads the awaited value; the two `✓` rows and the
   `if`-form stay as they are.
2. A regression test under `tests/` with the table as untyped `.js` fixtures
   (each an async function; `.then` the exported promise on the host), failing
   on the parent for the four Promise rows.
3. marked `Hooks.test.js` ≥ 19/30 (the 10 tests above), measured through
   `tests/dogfood/marked-upstream-suite.mjs`; A/B over the 17 suites at one
   HEAD, per test file.
4. Standalone lane: byte-identical unless the change is deliberately shared.

## Also seen, not this issue

Reducing marked's shape with the async IIFE placed inside an async FUNCTION
(`async function g() { const p = (async () => {...})().catch(o); await p; }`)
produced a module that codegens but fails `WebAssembly.instantiate`
(`__async_resume_fasyncIifeOnly: not enough arguments on the stack for
local.set`) — on the parent too, so it is pre-existing and separate. marked's
real module validates because its IIFE sits inside a plain arrow. Worth its
own issue once reduced further.

## Implementation Plan

(The plan as executed. The lead's 2026-09-06 draft — "fix at the collector,
every syntactic await is a suspension point" — was followed up to its step 2
and then contradicted by measurement: `awaitSet` was already purely
syntactic, and the decision that dropped the awaits lived one level up, in
the activation gate. One PR with #5367, branch
`issue-5367-5372-await-in-initializer`; interrupted after the fix and resumed
2026-09-12 on upstream/main `225f400089`.)

1. **Capture the base** (`.tmp/*.orig.ts` at `cbd2f11dff`; re-captured from
   `upstream/main` at the merged head into `.tmp/ab2/base-src/`).
2. **Probe** (`compileAndRunUpstreamModule`, untyped `.js`, failing control):
   the seven table rows, marked's nested form
   `await (cond ? await a(e) : b)(u, i)`, the multi-declarator form,
   `cond && (await p)`, `return cond ? await a : b`, the assignment form, a
   `parseMarkdown` mimic, plus #5367's rows — every binding consumed through
   string concatenation so a leaked Promise reads `[object Promise]`.
3. **How is `awaitSet` built?** `collectAwaitPoints` is syntactic (every
   `AwaitExpression` outside a nested function). Instrument the engine claim
   instead: `planLinearAwaits` / `analyzeTryCatchAsync` /
   `asyncFnNeedsHostDrive` per row → the failing rows are the ones both
   planners return `null` for, so the whole function falls to the legacy
   synchronous pass-through (await = identity).
4. **Fix at the planner**: new `src/codegen/async-await-hoist.ts` lowers the
   awaiting variable / expression / return statements into the region items
   `planTryCatchCfg` already drives (conditional arms, unbound suspend
   segments, hoisted awaiting callees into `__async_hoist_<pos>` temps,
   `return await` chunks); `lowerRegionBody` routes through it;
   `analyzeTryCatchAsync` claims an all-chunk body that carries a hoisted item.
5. **Lane gating**: `--target standalone` failed validation for the newly
   admitted shapes (a re-declared own-local's spill mistyped), so hoisting is
   admitted only through `isHostAsyncLane(ctx)`; non-host lanes keep the
   pre-#5372 arm verbatim and their binaries byte-identical.
6. **Const initialisation**: a `const` declarator's non-suspending arm is
   delivered as a synthetic `name = init` whose LHS is the declaration's own
   name node — recognised as initialisation in
   `isConstIdentifierAssignmentTarget`.
7. **Regression tests**: `tests/issue-5372-await-in-conditional-operand.test.ts`
   (rows + controls + the async-IIFE-`.catch`-inside-an-async-function shape,
   which does not even validate on the parent); re-contract
   `tests/issue-3722-await-ternary-label-false-positive.test.ts` (it asserted
   the legacy synchronous return of `return cond ? await x() : y`).
8. **marked through the real suite**: `Hooks.test.js` went 9/30 → 0/30 once
   the driven async arm reached the pre-existing #5345 `illegal cast` trap
   inside a host-driven resume (an uncatchable wasm trap escaping a host
   reaction kills the worker). Add a frame-aware reaction import
   (`Promise_then2_frame`) whose wrapper rejects the frame's result promise
   on a trap; its runtime side lives in `src/runtime/promise-then-reactions.ts`
   because `src/runtime.ts` sits exactly at the #4401 line ceiling (19725).
   Then characterise what still fails (below) instead of chasing it.
9. **Gates, typecheck, scoped test262 both lanes parent vs fix, 17-suite A/B
   at one head** (file copies, suites one at a time). The A/B found one
   regression — hono `src/helper/dev/index.test.ts` 1/8 → 0/8 because its
   module stopped VALIDATING: `getColorEnabledAsync` (`const isNoColor = cond
   ? await (async () => { … })() : !getColorEnabled()`) became driven and the
   resume emitter cannot re-compile a block-bodied IIFE inside an awaited
   expression (pre-existing on the linear and `if`-arm paths too, measured on
   the base → #6410). Gate that shape out of the hoisting lane
   (`awaitedExprHasBlockIife`), re-verify the file (1/8 again, the base's own
   errors), add the `r13` control row, re-run marked/hono and the scoped host
   lane.

## Resolution

**Root cause — the plan's step-2 hypothesis was measured false, the
conclusion holds one level up.** `awaitSet` is built by `collectAwaitPoints`
(`async-cps.ts`), which is purely syntactic: every `AwaitExpression` outside a
nested function is in the set. What decides whether the function suspends is
the JS-host activation gate `asyncFnNeedsHostDrive` (`async-frame.ts`): it
accepts only shapes `planLinearAwaits` (await DIRECTLY the initializer /
assignment RHS / return operand / expression statement) or
`analyzeTryCatchAsync` (the CFG machine: try/catch groups, `if` arms,
for-of, and — only for MULTI-declarator statements — the
`lowerAwaitingVariableStatement` conditional arm) can plan. Every other
position — a single-declarator `const u = cond ? await f() : v`, the
else-branch twin, `cond && await p`, `return cond ? await a : b`, and marked's
nested `await (cond ? await a : b)(u, i)` — returned `null` from both
planners, and the whole function fell to the legacy synchronous pass-through
where `await` is an identity (`expressions.ts` `isAwaitExpression` arm) and
the Promise object flows on as the value. Instrumented verdicts on the base
for the probe rows: `r1..r5, r10, r11: linear=false tryCatch=false
hostDrive=false`; `r8/r9` (nested): same; `r6` (`await later("A")`):
`linear=true hostDrive=true`; `r7` (if-form): `tryCatch=true hostDrive=true`.
The "callee shape" pattern in the table was a red herring: the object-literal
async-method row "worked" only because that callee is itself compiled
synchronously (#2957 phase-3 residue) and returns the raw value, and rows
that `return u` directly were masked by the caller's own `await` flattening
the leaked Promise (the probe consumes every binding through string
concatenation so a leak reads `[object Promise]`).

**Fix (JS-host lane).** New module `src/codegen/async-await-hoist.ts` —
expression-level await hoisting for the CFG planner. `lowerRegionBody` routes
every awaiting variable / expression / return statement through
`lowerAwaitingStatementByHoisting`, which lowers into the region items the
existing `planTryCatchCfg` builder already drives:

- a conditional operand with an await in either (or both) arm(s) becomes a
  real `conditional` item — the non-awaiting arm assigns directly (never
  suspends, no extra microtask turn), the awaiting arm is a suspend segment
  delivering into the SAME binding (one resume local for both arms; the
  binding is typed by the checker's type of the declarator, i.e. the join of
  both arms);
- `cond && (await p)` / `cond || (await p)` as a statement becomes a
  conditional whose one arm is an unbound suspend segment;
- an awaited CALL whose callee itself awaits (`await (c ? await a : b)(u)`)
  hoists the callee into a synthetic temp `__async_hoist_<pos>` that the
  callee's own lowering delivers/assigns, then suspends on the synthetic
  `temp(args)` call. The temp is a resume binding of the inner suspend, so
  the frame emitter allocates its local; it is consumed by the outer await's
  operand in the same activation and is never live across a suspension, so it
  needs no frame spill;
- `return cond ? await a : b` becomes a conditional whose arms are a
  `return await` chunk (`settleSent`) and a synthetic `return b` tail;
- single declarators, await-free declarators among awaiting ones, and the
  assignment form `u = cond ? await a : b` are admitted; the linear-canonical
  `const x = await p` stays on the chunk path byte-identically, and the two
  shapes the old multi-declarator arm accepted produce identical items.

Evaluation order is preserved exactly (the condition is evaluated once, by
the `condGoto`; nothing is replayed after resumption). A write whose LHS is
the declaration's own name node is now recognised as that binding's
initialisation in `isConstIdentifierAssignmentTarget` (`helpers.ts`), so a
`const` declarator's non-suspending arm does not throw "Assignment to
constant variable."; the discriminator is exact because no source-level
assignment can carry a declaration name as its target. `analyzeTryCatchAsync`
also claims an all-chunk body that carries a hoisted item (`RegionBody.hoisted`).

**Lane gating.** The wasi/standalone CFG machine mistypes a re-declared
own-local's spill for the newly admitted shapes (measured on
`--target standalone`: `__async_resume_fr10` failed validation, `struct.set`
field `(ref null $Promise)` vs a `.then()`-closure-typed local), so hoisting
is admitted only on the JS-host lane through one predicate,
`isHostAsyncLane(ctx)` (`async-cps.ts`), used by the activation gate, the
spill layout and the resume CFG alike; the non-host lanes keep the verbatim
pre-#5372 arm (`lowerAwaitingVariableStatementNarrow`). The standalone binary
of the probe fixture is byte-identical (sha256 `abbb5f89ec56603c` base and
fix). The native-first semantic-provider policy rejects the fixture's host
imports (`__js_array_new`, `__call_function`, `setTimeout`, …) before codegen,
independent of this change.

**Measured (probe, JS-host lane, `compileAndRunUpstreamModule`, deliberate
failing control fails in both lanes):**

| row | base | fix |
| --- | --- | --- |
| `cond ? await later("A") : "B"` [true] | `[[object Promise]]` | `[A]` |
| `cond ? "B" : await later("A")` [false] | `[[object Promise]]` | `[A]` |
| `cond ? await laterAsync("A") : "B"` | `[[object Promise]]` | `[A]` |
| `cond ? await fn("A") : "B"` (any callee) | `[[object Promise]]` | `[A]` |
| `cond ? await hooks.pre("x") : "B"` | `[Px]` | `[Px]` |
| `await later("A")` | `[A]` | `[A]` |
| `let u = "B"; if (cond) u = await later("A")` | `[A]` | `[A]` |
| `await (cond ? await provideLexer(e) : syncLex)("u","i")` | `[undefined]` | `[AL(u,i)]` |
| `let u = …, c = await (…)(u,"i"), p = cond ? await … : c` | `[[object Promise]]` | `[PAL(A,i)]` |
| `cond && (await p)` as a statement (flag set by `p.then`) | `no` | `yes` |
| `return cond ? await later("R") : h` | `R` / `h` | `R` / `h` |
| marked `parseMarkdown` mimic with hooks | `post(undefined)` | `post(parse(tok(lex(pre(md)))))` |

Probe totals: base wasm 15/31, fix wasm 30/31 (the 31st is the control).

**Regression test** `tests/issue-5372-await-in-conditional-operand.test.ts`
(untyped `.js` two-file project, compiled and instantiated exactly like the
dogfood worker): 23 rows — 10 fail on the parent, 13 controls pass — plus 5
rows for the async-IIFE-`.catch` shape (the parent does not validate that
module); 28/28 with the fix. `tests/issue-3722-await-ternary-label-false-positive.test.ts`
asserted the legacy synchronous contract (`pick(1) === 7` on an async fn
whose body is `return cond ? await x() : 3`); it now awaits the returned
Promise.

**Scoped test262** (`language/expressions/await`,
`language/statements/async-function`, `built-ins/Promise/all`): see the PR
body / `## A/B` below.

**Trap guard (`Promise_then2_frame`).** The resume machine's one reaction
site (`ensureAsyncResumeFunction`) now registers reactions through
`Promise_then2_frame(p, onFulfilled, onRejected, resultPromise)`, added next
to the six host async imports in `finalizeUnifiedCollector`. Its runtime
wrapper (`src/runtime/promise-then-reactions.ts`, which also owns the plain
`Promise_then` / `Promise_then2` arms — the three fold into one two-line
dispatch in `resolveImport`, net 0 lines in `runtime.ts`) catches a wasm trap
raised while the state resumes and rejects the frame's own result promise,
which is what the caller of the former synchronous pass-through would have
observed. Prepared IR frames keep plain `Promise_then2` (the import is
optional in `HostAsyncImports`). Effect on marked `Hooks.test.js`: 0/30 → 16/30.

**marked `Hooks.test.js` — exact state (AC 3 not reached).** 16/30 with the
fix (parent: 9/30). Of the 10 async tests this issue was filed for, 7 pass
(`should preprocess async`, `should provide lexer async`, `should provide
lexer async hook`, `should provide async lexer from async hook`, `should
provide parser async`, `should provide parser async hook`, `should provide
async parser from async hook`). The remaining three:

- `should preprocess options async` fails exactly like its synchronous twin
  `should preprocess options` (`actual=<p>line1…`) — not an async defect,
  pre-existing, out of scope.
- `should postprocess async` and `should process all hooks in reverse`:
  `marked.parse` resolves `null` (`html.trim()` on null). Characterised with
  the real module: the trigger is the **postprocess hook being a plain
  object-literal `async` method that awaits an already-settled promise**
  (`await timeout()` with `timeout = () => Promise.resolve()`); the wrapped
  hook returns the right value when awaited directly by the test
  (`marked.defaults.hooks.postprocess('H')` → `HQ`), a hook that captures a
  test-local variable passes, a sync hook or a hook awaiting a timer passes,
  and every same-module mimic of the shape (object-literal method through
  marked's `Promise.resolve(o.call(r, a)).then(…)` wrapper, `return cond ?
  await hook(h) : h`) passes — so it is not reduced to a fixture and is not
  filed; it is the next marked item after #5345.

So the reachable maximum for this issue is 18/30, not the 19/30 the AC
assumed (the AC counted `preprocess options async` as async). The two
`illegal cast` tests (`should process tokens [async] before walkTokens`)
remain #5345's; the `not iterable` / `true is not a function` /
`this.block` groups were never in this issue's scope.

**Hoisting lane exclusion (#6410).** An awaited operand that contains an
immediately-invoked function expression / arrow with a BLOCK body
(`await (async () => { return x; })()`) is left off the hoisting lane
(`awaitedExprHasBlockIife` in `async-await-hoist.ts`): the host frame
machine's resume function is invalid for that shape on every path (linear,
`if`-arm, the old multi-declarator arm — measured on the base), and driving
more functions must not widen the reach of that hole. Such functions keep
their pre-hoisting behaviour (the legacy pass-through); the `r13` control row
pins that the module stays valid. The gate goes when #6410 lands.

**Also fixed on the way**: the "Also seen" shape above (an async IIFE with
`.catch` inside an async function that awaits it) — the parent emitted a
module that fails `WebAssembly.validate`; with the hoisting the module
validates and all five rows of that describe block pass.

## A/B

Measured at ONE head — the merged branch tip (upstream/main `225f400089` +
this change), base = the upstream/main copies of the five touched files
(`.tmp/ab2/base-src`, the two new modules removed) swapped in by file copy,
fix = the branch's files; suites one at a time, `JS2WASM_EVAL_ENGINE=interpreter`
for the scoped test262 runs.

**Regression tests** (`node node_modules/vitest/vitest.mjs run …`): base 20
failing rows (`issue-5367` 5/8, `issue-5372` 15/28, `issue-3722` 0/4), fix
0 failing (39/39 → 40/40 with the `r13` control).

**Scoped test262** (`language/expressions/await` ·
`language/statements/async-function` · `built-ins/Promise/all`, 387 tests):

| lane | base | fix |
| --- | --- | --- |
| JS-host GC | 190 pass · 193 fail · 4 CE | **191** pass · 192 fail · 4 CE (`language/statements` 66 → 67, the other two categories identical) |
| standalone (interpreter) | 161 pass · 111 fail · 115 CE | 161 pass · 111 fail · 115 CE (identical per category; probe binary sha256 `0ed867fc616cfa8d` on both sides) |

**17 dogfood suites, per test file** (`tests/dogfood/<pkg>-upstream-suite.mjs`,
`admitted` headline and exit 0 present on every run, both legs):

| suite | base | fix | per-file delta |
| --- | --- | --- | --- |
| marked | 9/30 | **16/30** | `test/unit/Hooks.test.js` 9 → 16 |
| hono | 255/324 | 255/324 | none (`src/utils/concurrent.test.ts` 0/6 both — #6409; `src/helper/dev/index.test.ts` 1/8 both after the #6410 gate; without the gate it read 0/8 — module invalid) |
| webpack | 16/16 | 16/16 | none |
| three | 17/18 | 17/18 | none |
| clsx | 32/32 | 32/32 | none |
| cookie | 63740/63740 | 63740/63740 | none |
| lodash | 59/62 | 59/62 | none |
| redux | 67/82 | 67/82 | none |
| axios | 202/231 | 202/231 | none |
| stylelint | 108/108 | 108/108 | none |
| tailwindcss | 13/13 | 13/13 | none |
| jsdom | 6/6 | 6/6 | none |
| styled-components | 9/9 | 9/9 | none |
| uuid | 75/75 | 75/75 | none |
| moment | 10/10 | 10/10 | none |
| prettier | 105/151 | 105/151 | none (the same 6 known compile problems — worker timeout / `--allow-fs` — on both legs) |
| jest | 335/356 | 335/356 | none |

Total: 65058 → 65065 (+7), no file lower than its base.
