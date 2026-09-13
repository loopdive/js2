---
id: 6416
title: "`arguments.length` inside an under-applied `.call`/`.apply` target reports the FORMAL count, not the supplied one"
status: done
sprint: current
created: 2026-09-12
updated: 2026-09-12
completed: 2026-09-12
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# 2026-09-12 — the `arguments` protocol (`__argc` + `__extras_argv`) is written
# at four sites and read at one, and each of the four leaked a stale extras vec
# on its no-extras path. The fix has to land at each writer: the two host-facing
# closure dispatchers (closure-exports.ts), the known-callee helper
# (nested-declarations.ts) and the direct-closure-call helper (calls.ts). There
# is no shared seam to extract them to — each writer is a different arm of a
# different emitter — so the growth is 4-6 instructions plus the mechanism
# comment at each site, in files that are already the owners of those emitters.
loc-budget-allow:
  - src/codegen/closure-exports.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/expressions/calls.ts
# 2026-09-12 — same reason, at function granularity: the reset is a RETURN-PATH
# epilogue, so it has to sit in the dispatcher emitter that owns the return
# path (both of these already tee their result through a save local to restore
# `__current_this`, and the reset must run after that restore). Extracting it
# would mean handing a helper the local layout, the two global indices and the
# ordering contract — more surface than the six instructions it replaces.
func-budget-allow:
  - src/codegen/closure-exports.ts::emitClosureCallExportN
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
---

## Problem

A named function invoked reflectively with fewer arguments than it declares
sees `arguments.length` equal to its FORMAL count, not the count the call site
actually supplied.

```js
function f(a, b) { return arguments.length; }
f.call({}, 1);   // native 1 · wasm 2
```

Found while fixing [#5341](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5341-axios-residual-buckets)
(the under-applied `.call` receiver drop). It is a **separate, pre-existing**
mechanism: it reads identically before and after that fix, and it is
independent of the receiver — the receiver is now correct while
`arguments.length` is still wrong.

Measured 2026-09-12 on `upstream/main` `cf82f78d6d`, probe via
`compileAndRunUpstreamModule`, two-file untyped `.js` fixture:

| call                                 | native  | wasm (before #5341) | wasm (after #5341) |
| ------------------------------------ | ------- | ------------------- | ------------------ |
| `withArguments.call({t:'T'}, 1)`     | `T\|1`  | `NO-THIS\|2`        | `T\|2`             |

with `function withArguments(a, b) { return (this ? this.t : 'NO-THIS') + '|' + arguments.length; }`.

## Where to look

`maybeSetArgcForKnownCall` (`src/codegen/statements/nested-declarations.ts`
~L3760) does push `i32.const min(actualArgCount, paramCount)` into the
`__argc` global at the `.call` site — so the value written appears to be
right (1). The reader side is what to check: whatever computes
`arguments.length` for a plain named FunctionDeclaration is falling back to
the formal count rather than honouring the global. Candidates: the argc
global is reset to `-1` before the callee reads it, or the `arguments`
materialisation for a non-closure target never consults it.

Note that the `.call` path now goes through the `#3796` named-`this`
trampoline for these arities. The trampoline does not touch `__argc` — it
only saves/installs/restores `__current_this` — so it is not the cause, but
confirm that on the emitted WAT rather than assuming it.

## Acceptance criteria

1. `f.call(t, 1)` into `function f(a, b)` answers `arguments.length === 1`,
   and `arguments[1] === undefined`.
2. The same for `.apply(t, [1])` and for an immediately-invoked
   `f.bind(t)(1)`.
3. Over-application is unchanged (the extras-argv ABI already carries it).
4. Regression test with untyped `.js` two-file fixtures, failing on the
   parent and passing with the fix, plus an anti-vacuity control.
5. A/B over the 17 dogfood suites — no regression.

## Implementation Plan

**Diagnosis (measured 2026-09-12 on `upstream/main` `23a0ddaa26`, plus the same probe on `cf82f78d6d`).** The issue's hypothesis — the `arguments` reader falling back to the formal count — is wrong. `__argc` is set and read correctly: `f.call({t:'T'}, 1)` from a plain exported function answers `T|1` on BOTH commits (also `.apply`, `.bind()(1)`, direct `f(1)`, 0 args, 3 args). The `T|2` only appears when the `.call` sits inside a closure that was itself invoked **dynamically with more args than it declares** — exactly the upstream harness's `__upstreamTests[index].body(__qunitAssert)` into a 0-param `it` callback. Reduction via `compileProject` (two-file untyped `.js`): `const tests=[]; function it(n,body){tests.push({n,body})}; it('x', () => withArguments.call({t:'T'},1)); export function run(){ return tests[0].body({}); }` → `T|2`; the same with `body()` → `T|1`; `it('x', () => 0); run(){ tests[0].body({}); return withArguments(1); }` → `NO-THIS|2` (stale AFTER the closure returns). Exact `.call(t,1,2)` inside reads `T|3`; over-applied `.call(t,1,2,3)` reads 3 because it rewrites the extras itself.

**Mechanism.** The exported closure dispatchers `emitClosureCallExportN` (`src/codegen/closure-exports.ts` ~L694, `__call_fn_N`) and `emitClosureMethodCallExportN` (~L1265, `__call_fn_method_N`) build `__extras_argv` for the arm where `arity > entry.closureArity` (~L947–960 and ~L1540–1552) before the `call_ref`, and **never clear it after** (the only extras `global.set`s in that file are pre-call; the `__\0js2_call_fn_method_argc_N` wrapper ~L1757 resets `__argc` only). A callee that does not read `arguments` never consumes the vec (`emitArgumentsVecBody` in `statements/nested-declarations.ts` ~L4212 clears it only when it runs), so the next `arguments` materialisation anywhere — inside the callee, or in the caller after return — computes `totalLen = argc + extrasLen` with a stale `extrasLen ≥ 1`. The Wasm-side inline ladder in `expressions/calls.ts` ~L5130 already does the right thing (`appendExternResultArgcReset` → `buildArgcResetNoLazyExtras`); the two host-facing dispatchers are the gap.

**Change 1 (primary, both dispatchers).** After `buildClosureResultBoxing(...)` in each arm's `callBody` (closure-exports.ts ~L985 and ~L1565), append: `local.set <result>` · `ref.null <extrasVecTypeIdx>` · `global.set <extrasArgvGlobalIdx>` · `i32.const -1` · `global.set <argcGlobalIdx>` · `local.get <result>`. The method dispatcher already has `resultSaveLocal` (`prevThisLocal + 1`); the plain dispatcher needs one externref local added to its layout (do NOT renumber `anyLocal`/`funcLocal` — append after them; the `__struct` slot comment at ~L708 shows why layout is load-bearing). Order constraint: the reset goes after the `call_ref` result is boxed and before the `__current_this` restore in the method variant — it must not touch `prevThisLocal`. Reset unconditionally (not only on the `arity > closureArity` arm): a leak from elsewhere is cleared for free and the cost is two globals.

**Change 2 (secondary, hygiene at known-callee sites).** In `maybeSetArgcForKnownCall` (`statements/nested-declarations.ts` ~L3767), when `ctx.funcUsesArguments.has(funcName) && actualArgCount <= paramCount`, also emit `ref.null; global.set __extras_argv` (via `ensureExtrasArgvGlobal`). Guard on `<=`: every over-applied caller has already emitted `emitSetExtrasArgv` before reaching this helper and must not be wiped. This closes the same hole for any future dispatcher that forgets to reset.

**Probe first.** `.tmp/6416-probe.test.ts` with the five reductions above (over-applied dynamic `body({})`, `body()` control, stale-after-return, exact `.call` inside → expect `T|2`, direct call inside) and run it against the parent to record the fail set; the harness-shaped run (`compileAndRunUpstreamModule` with `UPSTREAM_TEST_SHIM` + `describe/it`) reads `[false×6, true]` on parent.

**Regression test** `tests/issue-6416-stale-extras-argv.test.ts`, shape of `tests/issue-5341-under-applied-call-receiver.test.ts` (untyped `mod.js` + `entry.ts`, `compileProject` gc/node): cases (was ✗) — `.call(t,1)`, `.apply(t,[1])`, `.bind(t)(1)`, direct `f(1)`, exact `.call(t,1,2)`, each inside an over-applied `tests[0].body({})`; stale-after-return `body({}); f(1)`; over-applied closure via param `invoke(b){ return b({}) }`. Controls: `body()` (exact arity) → `T|1`; over-applied `.call(t,1,2,3)` → `T|3` (extras ABI unchanged); `arguments[1] === undefined` on the under-applied case; a callee that ignores `arguments` still gets padded args (anti-vacuity: `tests/issue-1511.test.ts` and `issue-2745.test.ts` must stay green — they cover the extras protocol this change touches).

**Dogfood expectation.** The harness over-applies EVERY `it` callback, so the first `arguments`-reader in each test body is contaminated suite-wide today. Expect movement in lodash (59/62; `arguments.length` overload dispatch throughout), moment (10), and plausibly marked (16/30), prettier (107/151), jest (335/356), hono (259/324), redux (67/82); webpack/three/clsx/cookie/axios/stylelint/tailwindcss/jsdom/styled-components/uuid should hold. Run the full 17-suite A/B (parent vs branch) and record it in the issue; no suite may drop. Standalone lane: the dispatchers and both globals are mode-agnostic (comment at ~L814), so the same fix applies; add one standalone (`target: "gc"` + `nativeStrings`/WASI if the 5341 test has such a lane, else note "host-only verified") case and expect no floor movement.

## Dispatch

opus — the fix is ~30 lines in two generated dispatchers with a load-bearing local layout and an ordering contract against the `__current_this` restore, plus a suite-wide A/B; the diagnosis and reduction are already done here, so no further investigation is needed.

## Resolution

Fixed 2026-09-12. Measured on `upstream/main` `e8a778638f`.

**The issue's own diagnosis was wrong, and so was the plan's — in the same
direction but not far enough.** The reader is fine: a top-level
`f.call({t:'T'}, 1)` into `function f(a, b)` answers `T|1` on the parent commit.
The plan correctly re-diagnosed it as a *stale `__extras_argv`* left behind by
an over-applied closure call, and correctly identified the two host-facing
dispatchers as leaking it. But it located the repair on the **return path only**,
and that is not where the reported symptom comes from: with the dispatcher
epilogue alone, 8 of the 9 originally-failing probe cases still failed. The
contaminated read happens *inside* the over-applied callback, before any
dispatcher has returned.

**Mechanism.** `arguments.length` is `argc + extrasLen`
(`emitArgumentsVecBody`), and the two globals are written at four sites and
consumed at one. A callee that never materialises `arguments` never consumes
them — so an over-applied call parks a non-null extras vec in `__extras_argv`
and walks away. The reduced harness shape:

```js
function withArguments(a, b) { return arguments.length; }
register('x', () => withArguments.call({}, 1));  // arrow declares 0 params
tests[0].body({});                               // invoked with 1 → extras = [{}]
```

`__call_fn_method_1` seeds `__argc = 0`, `__extras_argv = [{}]` for the arrow;
the arrow ignores `arguments`; the inner `.call` then seeds its own
`__argc = 1` and inherits the arrow's extras → `1 + 1 = 2`. Every npm upstream
harness over-applies every test callback, which is why the first `arguments`
reader in each test body was contaminated.

The four writers each had the same hole — a no-extras path that seeds `__argc`
but leaves the extras global alone:

| site | file | shape it fixes |
| --- | --- | --- |
| `maybeSetArgcForKnownCall` | `statements/nested-declarations.ts` | known callee, `.call`/`.apply`/`.bind`, direct call |
| `emitClosureCallArgcExtras` | `expressions/calls.ts` | call to a closure **variable**, object-literal method |
| `buildArgcExtrasSetupFromLocals` | `expressions/argc-extras.ts` | dynamic closure-ref call |
| `emitClosureCallExportN` / `emitClosureMethodCallExportN` | `closure-exports.ts` | leak surviving *past* the dispatcher's return |

The first three null `__extras_argv` immediately before their `call`, guarded so
an over-applied caller's own extras are never wiped (`maybeSetArgcForKnownCall`
guards on `actualArgCount <= paramCount`; the other two on "this call has no
extras"). They use the no-lazy-registration convention of
`buildArgcResetNoLazyExtras`: with no extras global yet, nothing in the module
has ever written a vec. The fourth is a return-path epilogue in both
dispatchers, teeing the result through a save local so the two `global.set`s do
not disturb it; in the method dispatcher it runs **after** the `__current_this`
restore and reuses that restore's existing `__result` slot, so the result is
re-loaded once rather than twice. The plain dispatcher gained one externref
local, appended after `__fallback_args` (index `arity + 5`) — `anyLocal`,
`funcLocal` and `linkedArgsLocal` index the locals list positionally and must
not be renumbered.

**Which change carries which case** (measured, one change at a time):

| change | regression cases it fixes alone |
| --- | --- |
| `maybeSetArgcForKnownCall` | 14 of 15 |
| dispatcher epilogues | 1 (a dynamic closure-ref call *after* an over-applied body) |
| `buildArgcExtrasSetupFromLocals` | 1 (dynamic closure-ref call *inside* one) |
| `emitClosureCallArgcExtras` | 2 (closure **variable** / object-literal method) |

All four are load-bearing; none is redundant.

**Regression test** `tests/issue-6416-stale-extras-argv.test.ts` — 22 cases on
untyped two-file `.js` fixtures via `compileProject` (gc/node). **15 fail on the
parent commit, 7 controls pass there; 22 pass with the fix.** Controls cover
exact-arity replay, the over-applied `.call(t,1,2,3)` extras ABI, the
over-applied closure's own `arguments.length`, and padded formals into a callee
that ignores `arguments`. The anti-vacuity control asserts a rest-parameter
callback really does see the surplus argument (`1/0`) — it reads `0/0` the
moment the fixture stops over-applying and the whole file would otherwise pass
for the wrong reason. Neighbour suites `issue-1511`, `issue-2745`, `issue-5341`
and `issue-1053-arguments-global-staleness` were run on base and branch and
read **identically** (4 pre-existing failures in `issue-1511` /
`issue-1053-arguments-global-staleness` are on `upstream/main` too — unrelated
to this change).

**Host-only verified.** The dispatchers and both globals are mode-agnostic, but
the reduction reaches them through the JS-host closure bridge; `issue-5341` has
no standalone lane either, so no standalone case was added and no floor
movement is expected.

**A/B over all 17 dogfood suites** (same HEAD `e8a778638f`, base vs branch, one
suite at a time). Every suite identical — **and identical at per-file
granularity too** (`diff` over every `[dogfood] <file>: n/m native; n/m Wasm`
line across all 17 logs is empty):

| suite | base | branch | | suite | base | branch |
| --- | --- | --- | --- | --- | --- | --- |
| webpack | 16/16 | 16/16 | | styled-components | 9/9 | 9/9 |
| three | 17/18 | 17/18 | | uuid | 75/75 | 75/75 |
| clsx | 32/32 | 32/32 | | marked | 16/30 | 16/30 |
| cookie | 63740/63740 | 63740/63740 | | moment | 10/10 | 10/10 |
| lodash | 59/62 | 59/62 | | prettier | 107/151 | 107/151 |
| redux | 67/82 | 67/82 | | jest | 335/356 | 335/356 |
| axios | 208/231 | 208/231 | | hono | 261/324 | 261/324 |
| stylelint | 108/108 | 108/108 | | | | |
| tailwindcss | 13/13 | 13/13 | | | | |
| jsdom | 6/6 | 6/6 | | | | |

The plan expected lodash/moment/marked/prettier/jest/hono/redux to move. **None
did.** The contamination is real and now fixed, but no admitted upstream test in
the 17 suites was gated on it — the tests that read `arguments.length` inside an
over-applied callback were already failing for other reasons, or did not read it
at all. Recorded as a measurement, not a disappointment: the acceptance bar was
"no suite may drop", and none did.

**Residual, filed separately.** `arguments.length` was only half of the reported
expression. In the same shape, a *plain* call inside a host-dispatched closure
still inherits the dispatcher's `__current_this` instead of `undefined`:
`register('x', () => withArguments(1)); tests[0].body({})` reads
`undefined|1` where native reads `NO-THIS|1`. The count is now right; the
receiver is not. That is a `__current_this` leak, orthogonal to the `arguments`
protocol, and is
[#6436](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6436-plain-call-inherits-ambient-this).
