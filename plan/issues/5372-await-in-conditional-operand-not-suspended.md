---
id: 5372
title: "`const u = cond ? await f() : v` inside an async function leaves `u` holding the Promise — the await in a conditional-expression operand is not suspended on (marked Hooks cluster B, the 10 async tests)"
status: done
assignee: ttraenkler/sendev-5372
completed: 2026-09-06
sprint: current
created: 2026-09-06
updated: 2026-09-06
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
related: [5367, 5358, 5345, 3722, 4302, 2906]
# 2026-09-06 (#5372): the frame-aware reaction import `Promise_then2_frame` is
# registered next to the six host async imports (import-collector finalize),
# emitted at the resume machine's one reaction site (async-frame) and answered
# by the runtime import resolver — a trap while a driven frame resumes now
# rejects the frame's result promise instead of killing the host process
# (marked Hooks.test.js went 9/30 → 0/30 without it). +15..+19 LOC each; the
# additions sit in the functions that own those exact sites.
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/async-frame.ts
# 2026-09-12 (#5372): `planTryCatchCfg` grows by exactly the 4 lines prettier
# needs to wrap its widened signature (`hoist` flag) — no logic added.
func-budget-allow:
  - src/codegen/async-cps.ts::planTryCatchCfg
  - src/runtime.ts::resolveImport
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

(Lead-written; the implementing agent was to follow it and contradict it
with evidence if measurement said otherwise. Shared with #5367 — one PR.)

1. **Capture** `.tmp/async-cps.orig.ts` and `.tmp/async-ir-planning.orig.ts` before any edit. One standalone probe (`compileAndRunUpstreamModule` from `tests/dogfood/upstream-suite-runner.mjs`, untyped `.js` two-file project, harness sanity-checked with a deliberately failing control) with #5372's seven rows, marked's nested form `await (cond ? await a(e) : b)(u, i)`, the multi-declarator form (`let u = …, c = …`), and #5367's six ladder rows plus its continuations-run log (`seen` must read `s0|s1|e0|e1`).
2. **How is `awaitSet` built?** Grep `awaitSet` in `async-cps.ts` and follow it to the collector. The #5372 table says the decision depends on the *callee shape* — that smells like membership gated on the operand's checker type being a visible `Promise<T>`. An `AwaitExpression` is a suspension point **by syntax** (`await 1` suspends too); the operand's type may only choose the resume binding's carrier (unknown → `externref`, coerced on resume), never whether to suspend. Instrument the collector to print, per await, the operand kind, the resolved type, and the verdict for every probe row BEFORE changing anything.
3. **Fix at the collector / planner**, not in the conditional-initializer arm (~L1747, `ts.isConditionalExpression(initializer)`): once every syntactic await is a suspension point, re-run the probe; then check the arm handles the else-branch await and the multi-declarator form (`seen === decls.length`), and that the resume binding for a conditional initializer is typed by the join of both branches, not by the non-await branch alone.
4. **#5367 on the same fix**: the inline `Promise.all` rows should now suspend; if the resumed value still materialises as a default tuple / empty vec, the resume coercion is choosing the awaited tuple carrier for a host array — route it through the coercion the via-local form already uses (compare the WAT of the via-local form). `isAmbientPromiseAll` (`async-ir-planning.ts` ~490) must keep its contract or be removed if it was only a workaround for the collector gap.
5. **Both lanes**: run the probe under `semanticProviders: "native-first"` / the standalone target too (find how an existing test drives it) and record the status.
6. **Scoped test262 before pushing**: `test/language/expressions/await`, `test/language/statements/async-function`, `test/built-ins/Promise/all` on parent and fix, both lanes (find the path filter in `tests/test262-runner.ts` / the vitest runner `pnpm run test:262`); numbers must not go down; quote them in the PR body.
7. **Regression tests**: one file per issue under `tests/`, the tables as untyped `.js` two-file fixtures (each an async function, resolved on the host via `.then`), failing on the parent for the failing rows, controls for the passing rows; exact counts both ways.
8. **A/B at ONE HEAD** over all 17 suites (`tests/dogfood/*-upstream-suite.mjs`: webpack three clsx cookie lodash redux axios stylelint tailwindcss jsdom styled-components uuid marked moment prettier jest hono), per test file, base vs fix via the `.orig.ts` copies, suites ONE AT A TIME (three other agents share the box). Anchors on main (measure your own base): marked 9/30 · hono 229–253/324 (moving as #5675/#5676/#5680/#5681 land) · prettier 105/151 · jest 335/356 · redux 67/82 · lodash 58/62 · axios 200/231 · three 17/18 · webpack 16 · clsx 32 · cookie 63740 · tailwindcss 13 · jsdom 6 · styled-components 9 · uuid 75 · moment 10 · stylelint 108. Expected: marked `Hooks.test.js` → ≥ 19/30, hono `concurrent.test.ts` → ≥ 5/6; jest and axios are promise-heavy and may move up; no regressions. Any suite with no `admitted` headline or non-zero exit is re-run alone (a transient `Cannot find package 'tsx'` in a worker spawn silently zeroes modules; per #5369 one unobserved host-promise rejection zeroes a whole file — check `compile.details` before attributing a whole-file flip). #5345 stays `in-progress` (its `illegal cast` bucket remains) — say what marked reads after your change.
9. The async-IIFE-`.catch`-inside-an-async-function invalid-wasm shape noted above is NOT this task: reduce it to a two-file fixture, file it with `node scripts/claim-issue.mjs --allocate --by ttraenkler/sendev-5372` (read the LAST line for the verdict; never pipe a command whose status you need), do not fix it here.

## Dispatch

- Agent: `ttraenkler/sendev-5372` (Claude Fable 5.1, reasoning effort max);
  one PR for #5372 + #5367; branch `issue-5367-5372-await-in-initializer`
  from `upstream/main` `cbd2f11dff` (verified detached, clean, then branched).
- Lanes: JS-host GC (`target: "gc"`, `platform: "web"`, `experimentalIR`,
  as the dogfood worker compiles) is the fix lane; wasi/standalone must stay
  byte-identical.
- Commit trailer: `Model: Claude Fable 5.1 Max`.

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
dogfood worker): 22 rows — 10 fail on the parent, 12 controls pass; 22/22
with the fix. `tests/issue-3722-await-ternary-label-false-positive.test.ts`
asserted the legacy synchronous contract (`pick(1) === 7` on an async fn
whose body is `return cond ? await x() : 3`); it now awaits the returned
Promise.

**Scoped test262** (`language/expressions/await`,
`language/statements/async-function`, `built-ins/Promise/all`): see the PR
body / `## A/B` below.

## A/B

<!-- filled from the fix/base legs -->
