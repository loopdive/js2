---
id: 1687
title: "spec gap: eager generator model can't thread .next(arg) / .throw() / .return() into yield (44/63 yield fails)"
status: blocked
created: 2026-05-27
updated: 2026-05-27
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: generators, yield
goal: spec-completeness
sprint: Backlog
blocked_on: 1665
escalation: ESCALATED-NEEDS-SPEC — requires #1665 state-machine coroutine lowering (sendev-1687, 2026-05-27)
related: [1665, 1373, 1042, 1639]
---
# #1680 — Eager generator model breaks suspend/resume semantics

## Problem

`language/expressions/yield`: **18 / 63 pass, 44 fail, 1 CE** (measured
2026-05-27 via the real test262 runner, `runTest262File`, current main HEAD).

The failures are NOT heterogeneous — they share **one root cause**: generators
are compiled with an **eager-yield model** (see `src/runtime.ts:62` "eager-yield
buffer (filled by the generator body)" and the explicit comments in
`src/codegen/expressions/misc.ts:212-214` and `:253-255`:
*"In the eager generator model, yield always 'receives' undefined from .next()."*).

The generator body runs **to completion** when the generator object is created,
buffering every yielded value into an array. `next()` then drains that buffer.
This means three spec-required behaviours are impossible in the current design:

1. **`yield` cannot receive the value passed to `.next(v)`** — the yield
   expression always evaluates to `undefined` (hard-coded `ref.null.extern` at
   misc.ts:214/255). Spec §27.5.1.2 / §15.5: `it.next(v)` makes the *paused*
   `yield` expression evaluate to `v`.
2. **`.throw(e)` cannot be injected at the suspended `yield` point** — the body
   already ran, so there is no live suspension to throw into.
3. **`.return(v)` cannot interrupt mid-iteration** — same reason; the body
   cannot be abandoned partway because it never paused.

## Evidence (real runner, current main)

Representative failures (assert index = how far the test got before the first
mismatch):

- **`.next(arg)` threading** (yield-as-expression returns wrong value):
  - `rhs-yield.js` — `yield yield 1`; `it.next(3)` should yield `3`, got the
    original. (assert #3)
  - `iter-value-specified.js`, `then-return.js`, `in-rltn-expr.js`,
    `rhs-regexp.js`, `rhs-template-middle.js`,
    `formal-parameters-after-reassignment-strict.js`.
- **`yield*` delegation observing inner `.throw()` / `.return()`**
  (all return `null` or a stale value — the delegated iterator's
  throw/return protocol never runs because the outer body already
  drained eagerly):
  - `star-rhs-iter-thrw-*` (10 files): `*-res-done-err`, `*-res-value-err`,
    `*-thrw-call-err`, `*-thrw-call-non-obj`, `*-thrw-get-err`,
    `*-thrw-invoke`, `*-violation-*` (5).
  - `star-rhs-iter-rtrn-*` (9 files): `*-no-rtrn`, `*-res-done-err`,
    `*-res-value-err`, `*-rtrn-call-err`, `*-rtrn-call-non-obj`,
    `*-rtrn-get-err`, `*-rtrn-invoke`, etc.
  - `star-rhs-iter-nrml-*` (10 files): next-protocol step ordering.
  - `star-return-is-null.js`, `star-throw-is-null.js`, `star-iterable.js`,
    `star-in-rltn-expr.js`.

## Deferred / out of scope for this issue

- `from-with.js` — `WithStatement` (compile_error) — deferred per CLAUDE.md
  (eval/with wont-fix).

## Root cause (confirmed)

`compileYieldExpression` (`src/codegen/expressions/misc.ts:162`) pushes each
yielded value into `__gen_buffer` and returns a hard-coded
`ref.null.extern` for the yield expression's own value. The runtime
(`src/runtime.ts` `__create_generator` / `__gen_*`) wraps the pre-filled
buffer in an iterator. There is **no suspension point** — the body is not a
resumable coroutine.

## Fix approach — NOT localized; requires architecture

This cannot be fixed by patching `compileYieldExpression`. It requires
replacing the eager model with **true suspend/resume**, i.e. a coroutine
lowering. Two routes, both already scoped under sibling issues:

1. **State-machine (regenerator-style) transform** — lower the generator body
   to a `switch` over a `state: i32` in a WasmGC `$GeneratorState` struct;
   each `yield` saves live locals + returns; `next(v)` re-enters at the saved
   state with `v` bound to the yield result. This is exactly the design in
   **[[1665]] §"Standalone alternative" item 1**, which proposes it for
   host-independence — but it ALSO fixes the spec-correctness gap here (in
   both JS-host and standalone modes). **Recommend implementing #1665's
   state-machine lowering and treating #1680 as the spec-conformance
   acceptance gate for it.**
2. **Wasm stack-switching (`cont`/`resume`)** — cleaner but proposal not yet
   broadly shipping; defer.

The IR async/CPS work ([[1373]]/#1373b/[[1042]]) lowers `await` via CPS; the
same continuation machinery is what generators need. Coordinating
generator-CPS with async-CPS avoids two parallel coroutine engines.

## Acceptance criteria

1. `language/expressions/yield/rhs-yield.js` passes (`.next(arg)` threads into
   `yield`).
2. `language/expressions/yield/iter-value-specified.js` passes.
3. The `star-rhs-iter-thrw-*` and `star-rhs-iter-rtrn-*` clusters pass
   (yield* observes inner throw/return protocol).
4. `language/expressions/yield` pass-rate rises from 18/63 (28.6%) to ≥ 55/63
   (excluding the `with`-statement file).
5. No regression in currently-passing generator tests
   (`built-ins/Generator*`, `built-ins/GeneratorFunction`,
   `built-ins/GeneratorPrototype`).

## Senior-dev analysis (sendev-1687, 2026-05-27)

I confirmed the root cause and surveyed the full blast radius before writing
any code. **This is not a localized fix and not a single self-merge PR — it is
the #1665 state-machine coroutine lowering, which is currently
ESCALATED-NEEDS-SPEC and blocked (task #93).** Recommending it be driven as
#1665 with #1687 as the conformance acceptance gate, exactly as the issue's own
"Fix approach" section already proposed.

### Why no shortcut exists

The failing tests (`rhs-yield.js`: `function* g(){ yield yield 1 }`,
`it.next(3)` must make the *paused inner* `yield` evaluate to `3`) require the
generator body to **physically suspend at the yield point and resume with a
host-supplied value**. The eager model runs the body to completion at creation
time (`__create_generator`, runtime.ts:6227) and buffers every yield
(misc.ts:162 `compileYieldExpression` hard-codes `ref.null.extern` as the
yield expression's own value, runtime.ts:71 stores a pre-filled `buf`). There
is no live suspension to thread a value into, throw into, or abandon.

I verified the two routes that could avoid a Wasm-side rewrite are both
unavailable in this codebase today:

1. **Host-driven coroutine of the Wasm body** — would need Asyncify or
   Wasm stack-switching (`cont`/`resume`). Neither is present:
   `grep` for `asyncify`/`stack-switch`/`resume` in `src/` finds only comments
   noting their absence (`expressions.ts:920`: "would need JSPI /
   stack-switching"). `src/optimize.ts` does not run the Binaryen Asyncify pass.
2. **Wasm-side state-machine (regenerator-style) transform** — the genuine fix,
   = #1665. Requires rewriting the generator body into a `switch(state: i32)`
   resumable function, saving/restoring live locals across each yield, at FOUR
   independent emission sites that all currently emit the eager buffer model:
   - `src/codegen/declarations.ts:2366` (function declarations)
   - `src/codegen/class-bodies.ts:1523` (class generator methods)
   - `src/codegen/literals.ts:1700` (object-literal generator methods)
   - the IR path (`src/ir/from-ast.ts:342/535`, `src/ir/builder.ts:787`,
     `src/ir/nodes.ts` gen.push/gen.create/gen.yield_star nodes)
   plus runtime.ts `next/return/throw` (lines 191-223) re-driving the body.

### Regression risk if attempted partially

`built-ins/Generator*`, `built-ins/GeneratorFunction`,
`built-ins/GeneratorPrototype` and the 18 currently-passing
`language/expressions/yield` tests all rely on the eager buffer's exact
value/done shape and the GeneratorValidate brand checks (runtime.ts:191-223).
A half-migrated state machine (some sites coroutine, some still eager) would
desync `_GeneratorState` and risk broad regressions in stack-balance-sensitive
codegen across all four sites. This is precisely why #1665 was specced as a
single coordinated lowering, not an incremental patch.

### Recommendation

- Keep #1687 OPEN as the **spec-conformance acceptance gate** for #1665, not as
  independent work. Acceptance criteria here become #1665's exit test.
- Unblock #1665 (task #93) first: it needs the shared `$Iterator` design
  decision (gated on #1666/#1664, both now `done` per TaskList) plus an
  architect spec for the state-machine local-save/restore + the
  generator-CPS / async-CPS coordination called out in this issue (avoid two
  parallel coroutine engines — reuse the #1373/#1042 continuation machinery).
- Do NOT land a partial eager→state-machine migration; the regression surface
  outweighs any sub-cluster win.

Status left at `ready` (not started) — no code changed; this is an
escalation, not an implementation. Worktree `issue-1687-generator-model`
contains only this analysis note.

## Notes

- Smoke-tested via `runTest262File` directly (the real source-transform
  pipeline), NOT a naive harness — the "sameValue is not a function" results
  a naive `assert.sameValue` harness produces are probe artifacts; the real
  runner rewrites `assert.sameValue` → `assert_sameValue` and the failures
  above are genuine value mismatches.

## 2026-07-27 update — #1665 shipped partially; this issue's gap is still open

`blocked_on: 1665` is now stale: #1665 (Wasm-native generator lowering)
shipped 2026-06-03, but only **Phase 1/2** of the lowering
(`src/codegen/generators-native.ts` — simple sequential yields, then yields
inside loops/conditionals). Per that file's own header comment, exactly
this issue's scope — sent-values (`.next(v)` threading), `yield*`
delegation, `.return()`/`.throw()` injection — is explicitly still **not
modeled** ("Phase 3" per the `generator-model` goal doc) and falls through
to the eager-buffer host path this issue describes. So #1665 being `done`
did NOT close this gap; the remaining blocker is Phase 3 of the native
lowering specifically, not #1665 as a whole.

Independently re-derived and confirmed the same root cause from a fresh
differential-testing angle (#3690 — a corpus of programs run under both
Node and compiled js2wasm), with three new minimal repros pinned as
regression tests, cross-linked here rather than duplicated:

- **#3710** — `x = yield y` sent-value threading (this issue's primary case)
- **#3711** — `yield*` delegation, but note: **traps** ("illegal cast")
  rather than degrading to a wrong value, a harder failure mode worth
  checking when Phase 3 lands
- **#3712** — the sharpest evidence yet for *why* eager evaluation is
  dangerous, not just spec-incomplete: two generator instances from a
  shared closure factory (`while(true) yield total` capturing outer
  `total`) silently corrupt each other's state, because generator
  *creation* eagerly drains the infinite loop up to the runtime's
  `__EAGER_GEN_LIMIT` (1,000,000) cap — the wrong output literally contains
  the cap value. Recommended as a canonical acceptance-test addition for
  whoever picks up Phase 3.
