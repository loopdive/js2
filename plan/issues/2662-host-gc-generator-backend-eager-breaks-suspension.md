---
id: 2662
title: "host (gc) generator backend is EAGER-buffered — breaks lazy/suspension semantics on the default path (architecture)"
status: blocked
updated: 2026-07-21
model: fable
fable_role: implement
assignee: ttraenkler/fable-dev-1
sprint: Backlog
created: 2026-06-25
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime, architecture
language_feature: generators
goal: spec-completeness
related: [1344, 1665, 2157]
test262_bucket: built-ins/GeneratorPrototype
loc-budget-allow:
  - src/codegen/generators-native.ts
  - src/codegen/statements/nested-declarations.ts
---

> **SLICE 1 LANDED (fable-dev-1, 2026-07-18)** — capturing-NESTED generators
> (the wrapped-test262 shape) now run lazily on the default gc/host lane. Issue
> stays `ready`: the TOP-LEVEL generator lever (requires the Option-(ii)
> JS-boundary wrapper) is the remaining epic scope, and #1344 S-B/S-C are still
> gated on measuring the GeneratorPrototype buckets after the wrapper lands. See
> the `## Implementation Plan` section below.

> **RE-SCOPE — measured current-main state (senior-dev verify-first, 2026-07-21;
> status → `blocked` needs-architect).** The SLICE-1 note above is now STALE: the
> "TOP-LEVEL generator lever" it describes as remaining was substantially
> delivered by **#3032 W6** (`feat(#3032): W6 — host-lane generator declarations
route native (lazy §27.5 + next(v) two-way)`, landed 2026-07-19, AFTER this
> issue was last updated 2026-07-17). Verify-first probe on `main` HEAD
> (`3e53969`), gc/host lane, measuring the side-effect var at generator
> **creation** vs after the first `.next()`:
>
> | Shape                                              | at creation              | Behavior on main today                                                 |
> | -------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------- |
> | Top-level free `function* g(){ se=1; yield 1; … }` | `se===0`                 | **LAZY** ✅ (was `3` eager — the issue's headline proof case is FIXED) |
> | Exported `export function* g`                      | `se===2`                 | **EAGER** — crosses the wasm↔JS boundary raw                           |
> | Generator expression (`const g = function*(){}`)   | `se===0`, drains eagerly | slice-1 lazy-thunk (lazy create, eager drain) — #3032-tracked          |
> | `yield*` delegation                                | `se===2`                 | EAGER (host-arm bail; native machine still miscompiles `yield*`)       |
> | Method generator (`class C { *g(){} }`)            | `se===2`                 | EAGER — #3032 W4 territory                                             |
>
> **What this means:**
>
> - This issue's stated **acceptance** ("a capturing nested generator runs
>   LAZILY … re-measure the GeneratorPrototype buckets") is **essentially met** by
>   slice-1 (#3335) + #3032 W6. The **#1344 S-B/S-C dashboard gate this issue
>   existed to lift is LIFTED** — the wrapped-test262 capturing-nested shape is on
>   the native lazy path (evidence: committed, passing
>   `tests/issue-2662-gc-lazy-nested-generators.test.ts`).
> - The TRUE residual is **narrower** than the original framing: only
>   **escaping / exported** generators remain eager. That is the Option-(ii)
>   **JS-boundary wrapper** (escape analysis + an externref JS-callable wrapper
>   object forwarding into the in-module native dispatch) — rated
>   **High / architectural / multi-session epic** in the ARCHITECTURE WRITEUP
>   below. It does not fit a bounded dev slice → `blocked` needs-architect; the
>   lead should decide whether it is spun as its own prioritized issue or stays
>   deferred.
> - The incremental in-module shapes still eager on the host lane
>   (generator EXPRESSIONS full laziness, METHODS, `retVal`/`return(v)`
>   marshalling, buffer retirement) are the remaining **#3032 W-waves** —
>   **#3032 is `in-progress`, owner-pinned `ttraenkler/sendev-3032-w6`**.
>
> **⚠️ DO NOT double-assign.** The residual work overlaps #3032's owner-pinned
> files — `src/codegen/generators-native.ts` and
> `src/codegen/statements/nested-declarations.ts` (both in this issue's
> `loc-budget-allow`), plus `src/codegen/property-access-dispatch.ts`. Coordinate
> with `sendev-3032-w6` before any source work here; do not open a parallel
> implementation against those files.

# #2662 — host (gc) generator backend is eager-buffered (architectural correctness gap)

Split out of **#1344** (2026-06-25, sd-2651) because it is **bigger than #1344**
and gates whether #1344's state-machine slices (S-B/S-C) move the conformance
dashboard at all.

## The gap

There are **two** generator backends:

- **Native lazy state machine** (`src/codegen/generators-native.ts`) — correct
  suspension semantics, but **standalone/wasi-ONLY** (`generators-native.ts:849`
  `if (!noJsHostTarget(ctx)) return false`).
- **Host runtime** (`src/runtime.ts`) — used in **default gc mode** — is an
  **EAGER-YIELD BUFFER**: it runs the **entire** generator body up front into a
  `buf: any[]` (runtime.ts:135), then `.next()` just drains the buffer.

The eager backend **cannot** implement lazy suspension, so it is wrong for every
observable that depends on when the body runs:

- side-effect timing (statement after a `yield` must not run until resumed);
- `.return()` / `.throw()` **interrupting** a generator suspended in a `try`;
- `finally` running on abrupt completion at the right time;
- infinite generators (eager buffer never terminates).

### Proof (verified, current `main`)

```ts
let se = 0;
function* g() {
  se = 1;
  yield 1;
  se = 2;
  yield 2;
  se = 3;
}
g(); // create, NO .next() yet
// gc/host:    se === 3   (whole body ran eagerly — WRONG)
// standalone: se === 0   (correctly lazy)
```

## Why this gates #1344 (and any generator-conformance work)

The test262 conformance runner wraps every test in `export function test() { … }`
(`tests/test262-runner.ts:2370`, `wrapTest`). A test's top-level `function* g()`
therefore becomes a **generator nested inside `test()`**, and (for the
GeneratorPrototype tests, which have no class so their `var`s are NOT hoisted to
module scope) it **captures** the `test()`-local vars. A capturing nested
generator hits `generatorCapturesOuterScope` (`generators-native.ts:901`) →
**bail to the host EAGER path even under `--target standalone`.**

Verified: the wrapped `return/try-finally-within-try.js` keeps `var inTry`,
`var inFinally`, and `function* g()` all INSIDE `test()` (capturing), so it runs
on the eager host path in BOTH lanes. The conformance dashboard's
`runTest262File` defaults to gc/host (`scripts/runner-bundle.mjs:64253` — no
`target` arg). **So test262 generators are measured on the eager host path.**

⇒ Building the native state machine for catch / yielding-finally (#1344 S-B/S-C)
would move the dashboard by **ZERO** until this gap is closed, because the
measured path never reaches the native backend for these tests.

## Options (architecture decision — needs the lead / an architect)

1. **Make the native lazy path handle CAPTURES** (so a nested/capturing generator
   goes native instead of bailing to eager host). This re-routes the wrapped
   test262 generators onto the correct backend and is likely the highest-leverage
   single change — it may flip a large swath of generator tests at once AND
   unblock #1344 S-B/S-C. Scope: the native state struct currently has slots for
   `this` + own params only, not captures (`generators-native.ts:899-902`);
   capture support means materializing captured bindings as ref-cell fields in the
   state struct (the closure-capture pattern already used elsewhere).
2. **Make the host gc backend lazy** (a proper resumable coroutine in
   `src/runtime.ts` instead of the eager buffer). Large rewrite; the eager buffer
   was a deliberate simplification. Likely out of scope / lower leverage than (1).
3. **Measure conformance on the standalone lane for generators** — does not fix
   the gc correctness gap, and captured generators still bail to eager even under
   standalone, so this alone is insufficient.

**DECISION (lead, 2026-06-25): Option (ii)** — native-struct→JS-callable boundary
wrapper + in-module-only native selection + capture-materialization. The PoC
revealed the JS-host boundary blocker that makes a plain "Option 1" insufficient
on its own (a captured generator can still escape to JS). See the full
**ARCHITECTURE WRITEUP** section below for the verdict, the option (i)/(ii)/(iii)
reasoning, and the 3-lever cost model. Build DEFERRED (multi-session epic).

## Acceptance

- A capturing nested generator runs LAZILY (the side-effect-timing proof above
  returns 0 in gc mode, or the wrapped test262 generators are routed to the
  native lazy path), without regressing the existing generator suites.
- Re-measure the GeneratorPrototype `return`/`throw` buckets afterward; #1344
  S-B/S-C then have a measurable target.

## Routing

Architecture decision first (lead/architect): option 1 vs 2 vs 3. Then a
senior-dev build. Blocks #1344 S-B/S-C from moving the dashboard.

---

## Implementation Plan (fable-dev-1, 2026-07-18) — SLICE 1: capturing-nested host-lane laziness

> Handoff-ready. Branch `issue-2662-gc-lazy-generators`, worktree
> `/workspace/.claude/worktrees/agent-aeb10fb7d183a166f`. If interrupted, an
> Opus dev resumes from this section + the `## Suspended Work` note (if present).

### Slice boundary (what this PR lands, and what it deliberately does NOT)

**LANDS — capturing NESTED generators run lazily on the default gc/host lane.**
This is the exact wrapped-test262 conformance shape: `wrapTest` nests every
test's top-level `function* g()` inside `export function test()`, capturing the
test-locals (`var`s). Those now route to the native lazy state machine on the
host lane (previously eager-buffer). Verified: `var iterations`-capturing
nested gen driven by for-of has `iterations === 0` before the first drive and
`=== 3` after (was eager: all 3 ran at creation).

**DOES NOT LAND — top-level generator host-lane laziness.** Deliberately kept
eager. Root cause (the architecture writeup's Option-(ii) PREREQUISITE, verified
here by probe): a top-level generator can ESCAPE to a JS caller (export / return
value), where the native state struct is opaque — `gen.next is not a function`,
and a host `.value` read post-exhaustion surfaces the `UNDEF_F64` sentinel as
**NaN**, not `undefined` (the runtime cannot distinguish a generator-result
struct from any other struct to canonicalize the sentinel). A capturing nested
generator CANNOT escape (it is local to its enclosing fn, never a module value),
so the boundary blocker does not apply — the struct stays in-module, driven by
native dispatch. Top-level laziness waits on the JS-boundary wrapper lever.

Also out of scope for this slice (kept eager on the host lane): `yield*`
delegation (single-level only), `return <expr>` terminal values (§27.5.1.2 — the
native host carrier has no `__gen_set_return` equivalent), non-numeric/string
yields (object/boolean payloads come back NaN via the externref carrier),
bodiless `yield;`, and TDZ-flagged (`let`/`const`) captures (host-lane TDZ
threading is the separate #3032 wave — `var` captures work, which is what the
test262 GeneratorPrototype tests use).

### The 4 regressions found by the initial (over-wide) approach, and the fix

The first attempt widened `isNativeGeneratorCandidate`'s host lane to admit
EVERY plannable free `function*` declaration (top-level included) with safe
uses. That regressed 4 local tests, all rooted in the JS-boundary gap:

1. `issue-2035` raw `next()` post-done value → NaN not undefined.
2. `issue-2035` `gen.return(v)` terminal value → wrong.
3. `issue-2035` `yield*` delegation return-value leak → `illegal cast` trap.
4. `issue-680` "keeps the JS host eager-buffer fallback outside standalone" —
   a contract test asserting top-level gens stay eager.

Fix: NARROW the host-lane widening from "all top-level" to "capturing nested
ONLY" (+ keep the #3050 try-region set unchanged). Top-level gens revert to
eager → all 4 regressions resolved, zero new regressions.

### Files / functions touched

- `src/codegen/generators-native.ts`
  - `isNativeGeneratorCandidate` host-lane block (`!noJsHostTarget`): now admits
    `isTryRegion` (#3050, unrestricted) OR `isCapturingNested` (#2662, restricted
    to safe payloads + no `yield*` + no `return <expr>`); plus an EXPORT bail
    (closes a latent #3050 hole where an exported try-region gen handed JS the
    un-callable struct).
  - New helpers: `hostLaneYieldPayloadsAreSafe` (numeric/string yields only),
    `bodyHasYieldStarDelegation`, `bodyHasReturnWithValue`.
  - `hostLaneGeneratorUsesAreSafe`: added a value-reference (alias-escape) bail —
    a non-call reference of the gen name (`const h = g`, `f(g)`) that resolves to
    this decl fails the walk (calls through an alias are invisible to the walk).
- `src/codegen/statements/nested-declarations.ts`
  - Capturing-nested host-lane gate (line ~832): dropped the
    `bodyHasNewTryRegionAcrossYield` requirement so plain capturing nested gens
    (not just try-region) go native when `tdzFlaggedCaptures.length === 0`;
    removed the now-unused `bodyHasNewTryRegionAcrossYield` import.

### Test plan

- New test file `tests/issue-2662-gc-lazy-nested-generators.test.ts` (TODO):
  the lazy-creation proof, side-effect interleaving, for-of/spread drive, and
  the "top-level stays eager / escaping gen stays a JS Generator object"
  guard-rails, all on the gc/host lane.
- Regression gate: the ~146-file generator blast radius (`grep -Fl 'function*'
tests`). A/B vs main must show ZERO new failing tests. Pre-existing failures
  (issue-680 lowers/persists/registers, issue-1516 prototype-identity,
  generator-yield-contexts fn-expr) are unrelated to this change.

### Remaining-steps checklist

- [x] Narrow candidate gate to capturing-nested + try-region; add payload/
      yield\*/return helpers; alias-escape bail. Typecheck green.
- [x] Restrict widened payload to NUMERIC-only (string needs nativeStrings the
      host gc lane lacks → NaN; object/bool/bodiless also unsafe on the carrier).
- [x] Probe battery: acceptance (lazy nested, interleave, test262-shape,
      infinite) green; the 4 initial regressions (2035×3, 680-keeps-eager)
      resolved.
- [x] A/B FULL 146-file generator blast radius (chunks 1–3) — mine 48 == main
      48 failing tests, ZERO new failures. (The initial contradictory compare
      was a stale main-src checkout artifact; re-verified clean.)
- [x] Added `tests/issue-2662-gc-lazy-nested-generators.test.ts` (7 tests, all
      green: 4 lazy-behavior + 3 eager guard-rails, setExports-wired harness).
- [x] `loc-budget-allow` granted for the two touched god-files (+155 / +4 lines).
- [ ] Open PR to `loopdive/js2wasm`, confirm CI starts clean. Issue stays
      `ready` (epic continues) — NOT `done`.
- [ ] FOLLOW-UP (remaining epic scope, separate issue/PR): the TOP-LEVEL
      generator lever — the Option-(ii) JS-boundary wrapper that gives an
      escaping native generator a JS-callable object and canonicalizes the
      post-done `.value` sentinel to `undefined` at the host boundary. Only then
      can top-level gens go lazy AND the GeneratorPrototype return/throw buckets
      be re-measured to give #1344 S-B/S-C a target.

---

# ARCHITECTURE WRITEUP (2026-06-25, sd-2651) — DECISION + PoC verdict + cost model

> This section is the durable spec a future session builds from. The build is
> **DEFERRED** (multi-session epic); the design is settled here. **DECISION
> (lead): Option (ii)** — native-struct→JS-callable boundary wrapper +
> in-module-only native selection + capture-materialization. Reasoning below.

## PoC verdict (env-gated probe `JS2WASM_POC_GC_NATIVE_GEN`, reverted — no commit)

Flipping `noJsHostTarget` (`generators-native.ts:110`) to also return true for gc
routed gc-mode generators to the native lazy backend. Three findings, in order of
how they reshape the design:

1. **Routing gc→native is trivial to ENABLE and works for the simple case.** A
   non-capturing top-level generator in gc mode became lazy
   (`function* g(){ se=1; yield 1; … }; g()` → `se===0`, was `3` eager) and
   emitted the native resume function (`__gen_resume_`). So the gate is the only
   thing standing between gc and the native path _for the simple shape_.

2. **Capturing generators still bail** (`generatorCapturesOuterScope`,
   `generators-native.ts:~901`) → eager host. The wrapped test262 shape (a
   `function* g()` nested in `export function test()` capturing the test-locals)
   needs capture-materialization (Lever A) OR runner-side hoist (Lever B) to reach
   native at all.

3. **THE BLOCKER — routing gc→native breaks the JS-HOST BOUNDARY.** The native
   path returns an **opaque Wasm state struct**, not a JS-callable generator
   object. Existing gc generator unit tests fail with **`gen.next is not a
function`** (5 failures across `generators`/`generator-methods`/
   `generator-nested`/`for-of-generator`) the moment a native generator is handed
   **back to JS** (`const gen = exports.count(); gen.next()`). The native `.next`/
   `.return`/`.throw` are reached only via **in-module dispatch** (the
   `tryCompileNativeGeneratorMethodCall` path), never as JS methods on the struct.

### The decisive distinction (drives the whole design)

- **In-module generator use** (the wrapped test262 `test()` calls `it.next()`
  _inside_ Wasm; standalone programs) → native lazy backend is CORRECT and is what
  we want everywhere.
- **JS-escaping generator use** (a gc program returns a generator to a JS caller,
  or host-side `for…of` drives it) → needs a **JS-callable object**, which today
  only the eager host runtime provides.

A global gc→native flip is therefore WRONG: it silently breaks every escaping
generator. Native must be selected only when the generator provably stays
in-module, **or** the native struct must be wrapped in a JS-callable object at the
Wasm↔JS boundary.

## Why Option (ii), not (i) or (iii) (lead decision)

- **(i) Keep gc eager; measure generators on the standalone+native lane.** Only
  moves the STANDALONE report, not the headline gc dashboard; leaves real gc-mode
  generators broken; and introduces a measurement-integrity wrinkle (generators
  scored on a different lane than the rest of the dashboard). Rejected.
- **(iii) Make the host gc runtime lazy** (resumable coroutine in `src/runtime.ts`
  instead of the eager `buf`). A large rewrite duplicating the state-machine the
  native backend already has. Rejected (lower leverage; two lazy engines).
- **(ii) native-struct→JS-callable wrapper + in-module-only native selection +
  capture-materialization.** Fixes the gc correctness gap broadly (escaping AND
  in-module), moves the headline dashboard, and reuses the one correct lazy engine
  (native). **CHOSEN.** Multi-session epic; build deferred, design captured here.

## 3-lever cost model (build order for the epic)

| Lever                                  | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Cost                     | Notes / prerequisite                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JS-boundary wrapper** (PREREQUISITE) | Wrap the native state struct in a JS-callable object exposing `.next/.return/.throw/[Symbol.iterator]` that forward into the in-module native dispatch helpers; emit it at the Wasm↔JS boundary when a native generator value escapes to JS (return value, export, host `for…of`). Equivalently/additionally: an **in-module-only native selection** gate so a generator that never escapes JS takes native, while an escaping one either gets the wrapper or stays host. | **High (architectural)** | The genuinely new design piece. Decides escape analysis (which generators escape to JS) + the externref wrapper object shape. Reuses `tryCompileNativeGeneratorMethodCall` dispatch as the wrapper's forwarding target. Without it, gc→native breaks escaping generators (PoC finding 3).                                                                                       |
| **Lever A — capture-materialization**  | Make `generatorCapturesOuterScope` NOT bail; materialize captured bindings as **ref-cell fields** (`struct (field $value (mut T))`) in the native state struct, shared with the enclosing scope's locals (the existing closure-capture pattern). Thread the ref-cells into the generator factory call; read/write through them in the resume function.                                                                                                                    | **High (multi-day)**     | Bounded by the existing closure-capture machinery, but touches the state-struct layout (`registerNativeGenerator` ~:1094-1135), the factory call, and the resume emitter. Required because the wrapped test262 generators all capture. Needs the boundary wrapper first (a captured generator can still escape).                                                                |
| **Lever B — runner-side hoist**        | In `tests/test262-runner.ts` `wrapTest`, hoist a test's top-level `function* g` + the `var`s it references to **module scope** (outside `export function test()`), so it is not captured → with gc→native it goes native.                                                                                                                                                                                                                                                 | **Low**                  | CHEAPER but: (a) still needs the gc→native routing + boundary-wrapper decision; (b) changes WHAT is measured — must preserve test semantics (hoist order, TDZ); (c) only helps the conformance lane, not real gc-mode generator correctness. A measurement convenience, NOT a substitute for Levers A + wrapper. Use only to _accelerate dashboard signal_ once the core lands. |

**Build order:** JS-boundary wrapper (+ in-module-only selection) → Lever A
(captures) → re-measure GeneratorPrototype buckets → unblock #1344 S-B/S-C
(yielding finalizers, try/catch state decomposition). Lever B optionally bolted on
to speed the conformance signal, with semantics-preservation review.

## Loci (current `main`, for the builder)

- `src/codegen/generators-native.ts:110` `noJsHostTarget` — the gc/standalone gate.
- `:~839` `isNativeGeneratorCandidate` (gates on `noJsHostTarget`) +
  `:~901` `generatorCapturesOuterScope` (the capture bail — Lever A).
- `:~1094-1135` `registerNativeGenerator` state-struct field layout (add capture
  ref-cell fields here).
- `:~1448-1481` resume-function mode handling (mode 1 = `.return` abrupt;
  #1344 S-B adds mode 2 = `.throw` + deferred-throw-through-yielding-finally).
- `tryCompileNativeGeneratorMethodCall` (`:~1992`) — the in-module dispatch the
  JS-boundary wrapper must forward into.
- Call-site double-gates that also block gc→native:
  `declarations.ts:~848`, `class-bodies.ts:~1073`, `literals.ts:~2409`,
  `nested-declarations.ts:~377` (each `(ctx.standalone || ctx.wasi) && …`).
- `src/runtime.ts:~135` — the eager host generator `buf` (option (iii)'s target;
  NOT chosen, listed for completeness).
- `tests/test262-runner.ts:~2370` `wrapTest` — wraps every test in
  `export function test()` (the capture source); Lever B edits here.

## Status

Design settled (Option ii). Build DEFERRED — multi-session epic, to be prioritized
against s66 work with this spec in hand. **#1344 stays parked behind this epic**
(`#1344 depends_on [1665, 2662]`).

## Review (Fable, 2026-07-24)

Empirical confirmation of the ESCAPING-generator residual as a **silent wrong
VALUE** (not just wrong side-effect timing), on main `7652f0337`, default gc
lane — and a lane-divergence data point: **standalone gets this right, host
gets it wrong**.

```ts
function mk(): Generator<number, number, number> {
  function* g(): Generator<number, number, number> {
    let s = 0;
    for (let i = 0; i < 3; i++) {
      const t: number = yield i;
      s = s + t;
    }
    return s;
  }
  return g(); // ← escapes the factory
}
export function test(): number {
  const it = mk();
  it.next();
  it.next(10);
  it.next(20);
  return it.next(30).value; // node: 60
}
// node: 60 · standalone: 60 ✓ · gc host: 0 ✗ (silent)
```

The eager buffer runs the whole body up-front, so every `next(v)` SENT value
is lost (reads as 0) — the yielded values still look right (0,1,2), only the
accumulated return value is wrong, which makes this maximally silent. The
same generator NOT escaping (created + driven inline in `test()`) is correct
on both lanes (post-#3032-W6 native routing). See the review doc
`plan/agent-context/fable-substrate-async-review-2026-07-24.md` (probes
a4n/a4k/a4l) and the new narrow shape-gate issue #3586 (`s += yield` knocks
even a NON-escaping generator onto the eager buffer).
