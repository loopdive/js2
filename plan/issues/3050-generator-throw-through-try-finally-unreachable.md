---
id: 3050
title: "GeneratorPrototype.throw() resumption through try/finally / try/catch hits `unreachable` (6 fails)"
status: done
completed: 2026-07-09
assignee: ttraenkler/fable-3050
pr: 2807
sprint: current
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
model: fable
architect_spec: done
created: 2026-07-05
task_type: bugfix
area: codegen
language_feature: generators, try-finally, abrupt-completion
goal: spec-completeness
test262_category: built-ins/GeneratorPrototype/throw
related: []
---

# #3050 — generator `.throw()` resumption through try/finally / try/catch → `unreachable`

## Source

Fresh default-lane test262 harvest of current main
(`.test262-cache/test262-current.jsonl`, 2026-07-02). **6** fails under
`built-ins/GeneratorPrototype/throw/*` with `error_category: unreachable`
(`returned # — assert ## at L#: assert.sameValue(unreachable, #, …)` — i.e. the
generator resumed to a Wasm `unreachable` instead of the correct catch/finally
target).

## Root-cause hypothesis

Calling `gen.throw(e)` must resume the suspended generator by **injecting the
exception at the current yield point** and running the try/catch/finally
resumption from there. The 6 failing files all exercise resumption where the
`yield` sits inside (or adjacent to) a `try`/`catch`/`finally` block:

- `try-catch-before-try.js`, `try-catch-following-catch.js`, `try-catch-within-catch.js`
- `try-finally-before-try.js`, `try-finally-following-finally.js`, `try-finally-within-finally.js`

The generator state-machine's throw-resumption path likely doesn't map the
resume PC / exception into the correct try-region handler table entry when the
suspension point is before/within/after a catch or finally clause — so control
falls through to an `unreachable` guard instead of the handler.

## Suggested approach

Trace the generator lowering's `.throw()` entry: how the injected exception is
routed to the resume point's enclosing try-region. Compare against the working
`.next()` resumption path. The 6 files are a tight, self-contained matrix
(before/within/following × catch/finally) — good for TDD.

## Acceptance criteria

- All 6 `GeneratorPrototype/throw/try-{catch,finally}-*` files pass.
- `.next()` resumption and non-generator try/finally are unaffected.
- No test262 regression.

## Investigation (2026-07-05, dev-3042) — reassessed: SENIOR / architectural, not a bounded [S] dev fix

**All 6 files route to the LEGACY eager-buffer generator lowering, which cannot
inject a `.throw()` at a suspended yield.** Confirmed root cause, deeper than the
"resume-PC handler-table" hypothesis:

1. The NATIVE lazy state-machine lowering (`src/codegen/generators-native.ts`)
   explicitly **rejects** these shapes in `lowerStatements`:
   - `if (stmt.catchClause || !stmt.finallyBlock) return fail();` — any `try`
     with a **catch clause** across a yield is unsupported (the 3 `try-catch-*`
     files).
   - `if (!statementsAreYieldFree(stmt.finallyBlock.statements)) return fail();`
     — a **yield inside the finally** is unsupported (all 3 `try-finally-*`
     files put `yield 3` in the finally).
   The author's own note at generators-native.ts:2037 flags this: *"try/catch
   across yield stays the next slice."*

2. Rejected generators fall back to the **legacy eager model**
   (`src/codegen/function-body.ts:1052+`, mirrored in `closures.ts` /
   `class-bodies.ts`): the whole body is **evaluated eagerly**, buffering every
   yield into `__gen_create_buffer`, then wrapped by `__create_generator` which
   replays the buffer. Because the body already ran to completion, the statement
   after a suspended `yield` (`unreachable += 1`) executes **during eager eval,
   before `.throw()` is ever called** — so `iter.throw()` cannot skip it.
   Verified: a minimal `try { yield 2 } finally { yield 3; unreachable += 1 }`
   returns `unreachable === 1` (spec requires `0`).

**Why this is not a bounded dev fix.** Correct `.throw()`-at-yield semantics
require the LAZY native state machine to (a) permit yields inside `finally`,
(b) support `try/catch` across yields, and (c) route an injected throw at a
suspended yield to the enclosing try-region — running/exiting the correct
`finally`, entering the matching `catch`, and propagating otherwise
(§27.5.3.4 GeneratorResumeAbrupt + AbruptCompletion through the try model). That
is the deferred generator-state-machine slice, not a localized bug. The eager
fallback is architecturally incapable of it (no suspension point survives).

**Recommendation:** re-scope to **senior-developer** (or `/architect-spec`
first). Bumped `feasibility: hard`, `horizon: m`. Suggested plan: extend
`generators-native.ts` try handling to model try-regions with per-yield
membership + a resume-mode router (reuse the existing `abruptResume` /
`MODE_THROW` machinery, generalised from finally-only to catch + yield-in-finally),
then remove the two `fail()` guards. TDD against the tight 6-file matrix
(before/within/following × catch/finally).

## Implementation Plan (arch, 2026-07-05)

**Confirmed: this is the deferred generator-state-machine slice, not a bounded
bug.** The eager fallback is architecturally incapable of `.throw()`-at-yield
(no suspension point survives), so the fix is to extend the **lazy native**
lowering in `src/codegen/generators-native.ts` to admit these two shapes, then
let the two `fail()` guards fall away. Scope split cleanly into two independent
sub-slices; land them separately (each is a distinct guard + distinct machinery).

### Where the shapes are rejected today

`lowerStatements` (generators-native.ts:511) handles `try` at case 3
(generators-native.ts:554-567):

```
if (ts.isTryStatement(stmt)) {
  if (stmt.catchClause || !stmt.finallyBlock) return fail();        // guard A
  if (!statementsAreYieldFree(stmt.finallyBlock.statements)) return fail();  // guard B
  ...
}
```

- **Guard A** (`stmt.catchClause`) rejects the 3 `try-catch-*` files.
- **Guard B** (`!statementsAreYieldFree(finally)`) rejects the 3 `try-finally-*`
  files (each puts `yield 3` in the finally).

The abrupt-resume machinery lives at generators-native.ts:2016-2074: on resume
with `mode != MODE_NEXT`, it runs `state.abruptResume.finalizers` (the enclosing
finally bodies, generators-native.ts:159 `abruptResume?: { finalizers }`), then
for `MODE_THROW` (=2) **re-throws** the stored error field
(generators-native.ts:2038-2042) and for `MODE_RETURN` (=1) completes with the
`.return(v)` value. There is **no catch routing** and **no way for a finalizer to
itself suspend on a yield**.

### Sub-slice 1 — `try/catch` across a yield (guard A, the 3 `try-catch-*` files)

Goal: a `.throw(e)` injected at a yield **inside a `try` that has a `catch`** must
route control into the `catch` block (binding the error), not re-throw.

**Design:** generalise `abruptResume` from a finalizer-only list to a **try-region
membership model**. For each state (yield point), record the stack of enclosing
try-regions with, per region: `{ catchClause?: {param, body}, finallyBlock?:
Statement[] }` (today only `finalizers: Statement[][]` is tracked — extend the
`NativeGeneratorState.abruptResume` shape at generators-native.ts:159).

At the resume router (generators-native.ts:2062-2073, the `mode != MODE_NEXT`
guard), replace the flat "run finalizers then re-throw" with a per-region walk
from innermost to outermost:

1. If the injected mode is `MODE_THROW` and the innermost enclosing region has a
   `catchClause`: bind the stored `ERROR_FIELD` value to the catch param
   (`local.set`/`struct.set` into the catch param's spill slot the same way
   `resumeBindings` copies the sent value, generators-native.ts:2078-2088), clear
   the throw mode to `MODE_NEXT`, and **branch into the catch block's entry
   state** rather than executing `throwBody`. The catch body is lowered as ordinary
   states (it can itself contain yields → recurse through `lowerStatements` with
   the catch region popped).
2. If the region has only a `finallyBlock` (no catch): run it then continue
   propagating (existing behaviour) — but see sub-slice 2 for yield-in-finally.
3. If no enclosing region catches: run all pending finalizers then re-throw
   (existing `throwBody`, generators-native.ts:2038-2042).

**Lowering change:** in `lowerStatements` case 3, when `stmt.catchClause` is
present, DON'T `fail()` — instead lower the `try` block with the region pushed
(carrying the catch), lower the catch block as successor states reachable only via
the abrupt router, and (if present) the finally as the join. Mirror the existing
`activeFinalizers` threading (generators-native.ts:558) but with a richer region
descriptor. Reuse the `MODE_THROW` field + `ERROR_FIELD` already emitted at the
`.throw()` entry (generators-native.ts:2865, 3022) — no new state field beyond the
catch-param spill slot.

### Sub-slice 2 — yield inside `finally` (guard B, the 3 `try-finally-*` files)

Goal: `try { yield 2 } finally { yield 3; unreachable += 1 }` — `.throw()` at
`yield 2` must run the finally, which **suspends at `yield 3`**, and only after
the consumer resumes past it does `unreachable += 1` run (then the pending throw
re-propagates). Spec: §27.5.3.4 GeneratorResumeAbrupt threads the abrupt
completion THROUGH the finally, which can suspend.

**Design:** the finally body must be lowered as **real states** (not replayed as a
straight-line statement list the way generators-native.ts:562-565 does today for
the normal path, nor compiled inline in `abruptBody` the way
generators-native.ts:2027-2029 does for abrupt). Concretely:

1. Drop guard B; lower `stmt.finallyBlock.statements` via `lowerStatements` so its
   `yield 3` becomes a genuine suspension state.
2. The finally must run on **all three** completion paths (normal fall-through,
   `.return()` abrupt, `.throw()` abrupt) with a **pending-completion** carried in
   state so that after the finally's states finish, the original completion
   resumes: normal → continue; return → complete with the saved value; throw →
   re-throw the saved error. This is the classic "finally with a saved completion
   record" — model it with a small `pendingCompletion` state field (kind:
   none/return/throw + value/error) set on entry to the finally region and
   consumed at its exit state.
3. The current straight-line replay of the finally on the normal path
   (generators-native.ts:562-565) is subsumed by lowering it as states entered on
   the normal path too — remove the duplicate replay so the finally is emitted
   ONCE as a state subgraph, entered from all paths (avoid double-execution — the
   #1 hazard here).

### Interaction / ordering

- Land **sub-slice 1** first (catch routing) — it needs no new suspension inside
  finalizers and is a cleaner extension of the existing router.
- **Sub-slice 2** (yield-in-finally) is the harder one (pending-completion +
  finally-as-states + no-double-run). A combined `try/catch/finally` with a yield
  in the finally is the union case — verify the matrix's `following-*` files hit
  it.
- Keep the `MODE_*` constants (generators-native.ts:54-61) and `ensureExnTag`
  (generators-native.ts:2041) — reuse, don't reinvent.

### Edge cases

- **`.next()` resumption and the return path must be byte-identical** for
  generators that DON'T use catch/yield-in-finally — gate the new machinery so a
  finally-only, catch-free, yield-free-finally generator still takes the exact
  current path (the guards falling away must not change already-passing shapes).
- **Nested try** (`try-catch-within-catch.js`, `try-finally-within-finally.js`):
  the region stack must handle a yield inside a catch/finally that is ITSELF inside
  another try — the innermost-to-outermost walk covers it, but test it explicitly.
- **`return()` inside a finally that yields**: a `.return()` during a suspended
  yield-in-finally must not skip the rest of the finally — the pending-completion
  model handles this; verify against `try-finally-following-finally.js`.
- **Double-execution of the finally** — the single-subgraph rule (sub-slice 2
  step 3) is the guard; a probe that counts finally-runs must show exactly 1.

### Verification plan

1. `.tmp/` minimal per the dev's confirmed repro: `try { yield 2 } finally {
   yield 3; unreachable += 1 }`; `iter.throw()` after `iter.next()` → assert
   `unreachable === 0` (main returns 1).
2. The tight 6-file matrix: `built-ins/GeneratorPrototype/throw/try-{catch,finally}-{
   before-try,within-{catch,finally},following-{catch,finally}}.js`.
3. Regression: `built-ins/GeneratorPrototype/{next,return}/*` and the existing
   native-generator vitest suites (search `tests/*generator*`), plus non-generator
   try/finally (`language/statements/try/*`) — the eager→native promotion of these
   shapes must not perturb them.
4. Full `merge_group` (generator lowering is broad; standalone floor green).

## Implementation (2026-07-09, fable-3050) — WHY it took five mechanisms, not two

**All 6 target files pass** (`runTest262File`, default lane), plus 15 more
flips across `GeneratorPrototype/{throw,return}/try-*-nested-*` and
`language/expressions/generators/dstr/*` — 21 total, 0 real regressions in a
scoped 680-file sweep. The architect's two sub-slices were necessary but NOT
sufficient; the chain of root causes:

1. **Try-region state machine** (`generators-native.ts`) — as specced:
   `TryRegionPlan` + innermost-first `UnwindEntry` chains per yield
   (`replay` legacy finalizers | `catch` | `finally`), catch/finally blocks
   lowered as real states, a trailing i32 `pending` completion field (payloads
   reuse `abrupt`/`error`), a `finally-exit` router terminator, and wasm
   `try/catch $exc` wraps (+ `catch_all` → `__get_caught_exception` in host
   mode, acquired up-front) routing runtime throws positionally. Legacy
   finally-only/yield-free shapes keep the byte-identical `abruptResume` path.
   Bounded bails: return-through-finally, `yield*` inside a region, a yielding
   finally nested in another yielding finally, non-identifier catch params.

2. **The lane blind spot**: `isNativeGeneratorCandidate` hard-required
   standalone/wasi, but the 6 fails are DEFAULT-lane. The native machine now
   also admits **JS-host** free `function*` declarations whose body carries a
   try-region shape (catch across yield / yielding finally) — exactly the
   shapes the eager buffer provably cannot express. All other host generators
   keep the eager path.

3. **The harness blind spot**: `wrapTest` nests every test body in
   `export function test()`, so ALL target generators are NESTED and CAPTURE
   outer vars (`unreachable`) — the #2203-deferred slice. Captures now ride as
   **leading synthetic params** (nested-declarations.ts): mutable captures are
   already `ref $cell` params in the has-captures lift, the state struct
   stores them as ordinary `param_*` fields, the existing
   `nestedFuncCaptures` call-site prepend supplies them unchanged, and the
   resume fn registers cells in `boxedCaptures` (the lifted-closure
   mechanism) so writes propagate to the enclosing frame. Scoped to try-region
   bodies; bails on TDZ-flagged captures and async generators.

4. **Two latent bugs the matrix exposed**:
   - `done` result field boxed as **number** through the dyn any-receiver
     member read (`result.done === true` failed as `1 !== true`): the field is
     now boolean-BRANDED and the member-get dispatcher boxes branded i32 via
     `__box_boolean`.
   - **Trailing statements re-ran on post-completion `.next()`**: the final
     fallthrough state doubled as the completed-generator dispatch target. A
     dedicated empty done state is minted when the final state carries
     statements (byte-identical otherwise).

5. **Host-escape safety (the hard-won lesson)**: a WasmGC state struct is not
   host-iterable. The #1665 native for-of drive was standalone-gated → now
   TYPE-driven (host-lane for-of summed 0 without it). An eager outer's
   `yield* inner()` over a native inner silently yielded NOTHING — and the
   same class covers for-await-of, `Promise.all(g())`, `new Map(g())`…
   Host-lane native routing therefore requires a conservative **use-site
   safety walk**: every call-site result must flow into an allowlisted
   consumer (`.next/.throw/.return` member calls incl. via closure-captured
   bindings, for-of sans await, spread, `Array.from`, destructuring); anything
   else keeps the eager path. Ditto a body referencing an unresolvable
   identifier (host semantics ride #928's deferred-pending-throw).

**Follow-up candidates** (not blocking): widen host-lane routing beyond
try-region bodies once the safety walk matures; `return`-through-finally;
`yield*` inside regions; capture support for the standalone lane beyond
try-region shapes (would grow the host-free floor); teach `coercionPlan` the
boolean brand generally (the dispatcher fix is scoped).

Tests: `tests/issue-3050.test.ts` (10 cases, host + standalone). Validation:
scoped 680-file sweep (0 real regressions; 5 flagged files fail identically on
main under the in-process runner; realm-pollution error storms reproduce on
main), 16 generator vitest files (140 tests) green, equivalence
generator/iterator/for-of subset green (one pre-existing main failure).

## arch-3049 re-verification (2026-07-06) — spec CONFIRMED trustworthy

Re-checked every cited anchor against current `main` @ 52937f5. **All accurate
(within ~2 lines); root cause holds; the senior can implement directly.**

- The two `fail()` guards: `generators-native.ts:556` (guard A `stmt.catchClause
  || !stmt.finallyBlock`) and `:557` (guard B `!statementsAreYieldFree`) —
  present verbatim. `lowerStatements` at `:511`; `statementsAreYieldFree` at
  `:499`; the try case-3 handling + normal-path finally replay at `:553–566`.
- Author's "try/catch-across-yield stays the next slice" note at `:2037` —
  present. Abrupt-resume machinery: `abruptResume?: { finalizers }` at `:159`,
  finalizer loop at `:2023–2027`, `MODE_THROW` re-throw via `ERROR_FIELD` +
  `ensureExnTag` at `:2040–2041`, resume router `MODE_NEXT`/`MODE_THROW` at
  `:2064/2071`, `resumeBindings` at `:2078`. `.throw()` entry sets
  `MODE_THROW`/`ERROR_FIELD` at `:2864–2865` and `:3019–3022`.
- Eager fallback confirmed: `function-body.ts:1053` (`__gen_create_buffer` →
  `__create_generator`). Both target shapes still route here today.

No downgrade. `architect_spec: done` is reliable.
