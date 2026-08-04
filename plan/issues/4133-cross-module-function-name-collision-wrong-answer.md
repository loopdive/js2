---
horizon: xl
id: 4133
title: "Same-named top-level functions in different modules share one slot and silently compute the wrong answer"
status: in-progress
created: 2026-08-02
updated: 2026-08-04
assignee: unassigned  # authoring lane stood down after PR #4074 landed the first slice
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: multi-module-compilation
goal: npm-library-support
sprint: current
required_by: [1282, 1400, 2693]
es_edition: n/a
related: [1282, 2138, 4001, 4037]
---

# #4133 — cross-module function-name collisions produce a silently wrong program

## Problem

`ctx.funcMap` is keyed by the **bare function name**, with no module
qualification. Two modules that each declare a top-level function of the same
name therefore share one Wasm slot: the second registration overwrites the
first, and **every call in both modules reaches the surviving body**.

The compile reports **`success: true` and zero errors**. The program is just
wrong.

### Reproduction (compiles clean, wrong answer)

```ts
// a.ts — 40 locals
export function shared(x: number): number { /* returns 40*x + 780 */ }
export function callA(x: number): number { return shared(x); }

// b.ts — 1 local
export function shared(x: number): number { return x * 2; }
export function callB(x: number): number { return shared(x); }

// main.ts
export function run(x: number): number { return callA(x) + callB(x); }
```

| | |
| --- | --- |
| node | `run(3)` → **906** (900 + 6) |
| js2wasm | `run(3)` → **12** (6 + 6) |
| compile result | `success: true`, 0 errors, 343 bytes |

`callA` calls `b.ts`'s `shared`. `a.ts`'s body is discarded.

**Pre-existing, not a regression**: verified against base `bd1086b3` — byte
identical output (343 bytes) and the same wrong answer.

## The failure also corrupts emission at scale

On a large graph the same collision installs a body compiled for one local frame
into a slot declaring another, which fails at binary emit:

```text
Binary emit error: RangeError: Codegen error: local index out of range — 65
(valid: [0, 8)) at function 've'. This is the late-import index-shift class (#2043)…
```

The `#2043` attribution in that message is **misleading here** — the index is not
stale from an import shift, it is from a *different function's* frame. Anyone
debugging that message will start in the wrong place.

## Scale on the real target

The resolved ESLint `linter.js` graph — 146 sources, 488 distinct top-level
function names — has **55 colliding names**:

| name | copies | files |
| --- | --- | --- |
| `parse` | 6 | posix.js, windows.js, acorn.mjs, espree.js |
| `resolve` | 4 | posix.js, windows.js, resolve.js, relative-module-resolver.js |
| `normalize` | 3 | posix.js, windows.js, index.js |
| `basename`, `dirname`, `extname`, `format`, `isAbsolute`, `assertPath`, … | 2 each | posix.js + windows.js |

`@eslint/config-array`'s bundled `std__path/posix.js` and `windows.js` are near-
identical APIs by design, so they collide on ~20 names by themselves. This makes
**#4133 a hard blocker for "ESLint runs identical to node"** independently of
whether it emits: a graph that resolves `posix.basename` to `windows.basename`
cannot produce matching output.

## Already half-known

`collectMultiIrFunctionNameCollisions` (`src/codegen/index.ts`) computes exactly
this set, with the comment *"Flat function names shared by two or more source
files are not safe IR keys."* It is used **only** to stop the IR overlay from
claiming those functions. The IR path defends itself; the legacy path — which
actually emits them — does not.

## Why this is not a small fix

`ctx.funcMap` is read and written pervasively: **282 `funcMap.set` sites and
1,780 `funcMap.get` sites**. Most gets are compiler-internal helper lookups
(`__box_number`, `__extern_get`, …) that must keep working unchanged, so a
blanket re-key is not viable.

### Sketch of a tractable approach

1. Compute the collision set (already exists).
2. **Only for colliding names**, register a source-qualified key
   (`${name}$${sourceOrdinal}`) and keep the Wasm `func.name` distinct too.
3. Give body compilation a per-source resolution map
   (`name → qualified key`) consulted **before** the flat `funcMap` lookup, and
   route *user-function* call resolution through one helper. Internal helper
   lookups keep using the flat map, so the 117 `object-runtime.ts` sites and
   friends are untouched.
4. Imports/exports already bind through module records, so cross-module
   references should resolve to the qualified target via the existing import
   alias machinery (`registerImportBindingAliases`).

The risk concentrates in step 3: identifying every site that resolves a *user*
name. `call-identifier.ts` (23) and `calls.ts` (64) are the main ones, but this
needs an audit, not a guess.

## Acceptance criteria

- The repro above returns **906**, matching node.
- A graph with N same-named top-level functions emits N distinct bodies, each
  reachable from its own module.
- The `posix.js` / `windows.js` pair in the ESLint graph resolves per-module.
- Internal helper lookups are unaffected (no change to `funcMap` semantics for
  compiler-owned names).
- **Interim, if the full fix is deferred:** the compiler must **refuse loudly**
  on a cross-module collision rather than emit a silently wrong program. A hard
  diagnostic is strictly better than the current outcome — but note it would
  make the ESLint graph fail to emit, so land it together with, or after, the
  real fix rather than as a standalone regression.
- Fix the misleading `#2043 late-import index-shift` attribution on the
  local-index-out-of-range message, which this defect also triggers.

## Partial fix landed (2026-08-02) — direct calls now resolve per module

The full 282-set/1,780-get re-key was **not** needed for the direct-call case.
Two facts made a much smaller fix correct:

1. **The slots already exist.** Registration mints a distinct slot per
   declaration — the emitted module genuinely carries two `$shared` functions.
   Only the *name → index* map collided.
2. **Bodies compile one source at a time**, so a per-source binding is enough;
   it does not have to be globally unique.

So:

- `generateMultiModule` snapshots each source's own binding for colliding names
  immediately after that source's `collectDeclarations` call (the one moment it
  is observable), and re-applies it before that source's bodies compile.
  Iterating in the same order leaves the map in the same last-wins end state, so
  everything after the loop sees what it saw before.
- `compileDeclarations` built `funcByName` by a last-wins scan of
  `ctx.mod.functions`, which installed every body into the surviving slot. It now
  defers to `ctx.funcMap` for any name whose target slot carries that same name —
  a strict no-op for non-colliding names and for names bound to imports.

**No `funcMap.get` site changed**, including the ~117 internal-helper lookups in
`object-runtime.ts`.

### Measured

| | before | after |
| --- | --- | --- |
| repro `run(3)` | 12 | **906** (node: 906) |
| emitted binary | 343 B (one body emitted twice) | 1,018 B (both bodies) |
| equivalence suite | — | 32 failed / 1611 passed, **empty diff vs base** |

The ESLint graph's `local index out of range — 65 (valid: [0, 8))` binary-emit
failure is **gone**.

## Still open — why this issue stays in-progress

Fixing direct calls exposed the **same collision one layer up**, in the ABI
sidecar:

```text
Codegen error: allocator locator for
  …eslint-visitor-keys@3.4.3…:top-level-function:0:function-value-trampoline:0
is already owned by
  …eslint-visitor-keys@5.0.1…:top-level-function:0:function-value-trampoline:0
```

Two *different versions* of `eslint-visitor-keys` coexist in the graph, and
their function-value trampolines now both claim one allocator locator — because
both functions are now genuinely reachable, where previously one was silently
discarded. The trampoline/ABI layer still assumes one owner per name-derived
locator.

Remaining work:

- Per-module identity for **function-value trampolines** and any other
  name-derived ABI locator (this error).
- Indirect references — `ref.func`, closures, exports — are **not** covered by
  the per-source rebinding and have not been audited.
- The interim "refuse loudly" criterion above is now less urgent for direct
  calls but still applies to whatever remains uncovered.

## Test coverage — and its honest limit

`tests/issue-4045-cross-module-function-name-collision.test.ts`, 4 rungs, all
passing. Against the unfixed base **only one fails**: the 40-local rung. The
other three pass there because a small `shared` is **inlined** at its call site,
so each caller gets the right code regardless of which slot the name denotes.
The collision is only observable once a body is too large to inline. That is
recorded in the test file so the small rungs are not mistaken for evidence.

## Next layer, located precisely (2026-08-02)

The ABI trampoline error above is the **same bare-name keying**, in
`ensureFuncClosureSingleton` (`src/codegen/closures/method-trampolines.ts`):

```ts
const trampolineName = `__fn_tramp_${funcName}_cached`;
let trampolineFuncIdx = ctx.funcMap.get(trampolineName);
let cacheGlobalIdx = ctx.funcClosureGlobals.get(funcName);
```

Both the synthetic trampoline name and the closure-cache global are keyed by the
bare `funcName`, so two units that share a name share **one trampoline object**.
Its caller (`src/codegen/index.ts`, the `plan.topLevelFunctionValues` loop) then
hands that one `WasmFunction` to `planProgramAbiFunctionValue` under two
different unit-anchored binding ids, and
`ProgramAbiSession.locatorOwners` rejects the second — correctly, since a slot
cannot have two owners.

Note the caller's `ctx.funcMap.get(valuePlan.target.name)` now resolves to the
right per-source function (that is the landed fix), which is exactly why the
duplicate is now visible instead of silently collapsing.

### Suggested next step

Give the trampoline and its cache global a per-owner discriminator when the name
collides — e.g. derive them from the owning **unit id** rather than the bare
name, mirroring what the binding ids already do. Scope check before starting:
`ensureFuncClosureSingleton` is shared closure infrastructure used well beyond
the multi-source path, so this needs the full equivalence suite plus the
closure/trampoline-focused tests, not just the #4133 rungs.

### Beyond that, still unaudited for this defect class

- `ref.func` references and closure captures of a colliding name.
- Re-exports and `export { x as y }` chains across colliding modules.
- Whether two versions of the *same package* (the eslint-visitor-keys 3.4.3 /
  5.0.1 case) need anything beyond per-unit naming — they are distinct units by
  construction, so probably not, but it has not been verified.

---

# POST-MERGE STATE — PR #4074 landed a slice, 2026-08-04

`status` stays `in-progress`. Both halves of the *naming* defect shipped; the
residual is the reachability problem tracked jointly with #4134.

## What landed

- **Top-level collision** — `funcMap` is rebound per source, so two modules
  declaring the same top-level function name no longer share one slot.
- **Nested collision** — a nested declaration's bare name is scoped to its
  **enclosing function**, not to the parent block. The scope choice is
  load-bearing: an earlier revision walked only to the parent block and
  regressed Annex B §B.3.3 block-hoisted declarations (#165) plus lodash #1303.

Both were **silent wrong answers**, not crashes — they compile and validate
cleanly and only the computed value detects them. A factory whose nested `equal`
lost to another module's `equal` returned `0` where node gives `306`.

Regression guards: `tests/issue-4133-cross-module-function-name-collision.test.ts`
and `tests/issue-4133-nested-name-scope.test.ts`, both verified non-vacuous
against the unfixed base.

## What remains

The out-of-scope nested binding case, where the correct callee is not reachable
from the calling frame. Neither available end is safe today:

| out-of-scope nested binding | consequence |
| --- | --- |
| suppress it | call falls to `ref.null.extern` → `null_deref` +1200 (measured) |
| let it through | wrong-frame capture index → module fails to validate |

The shipped code lets it through. A real fix makes the callee *reachable* via
the #2029 family-A promotion to `capturedGlobals`, which changes mutation
semantics and needs a spec first. This is the same remainder as #4134's — the
two should be specced together, not separately.

---

## Implementation Plan (2026-08-04, architect)

The shared mechanism — planned promotion of cross-frame-unreachable captures to
module globals, gated on a single-activation predicate, plus a diagnosed compile
error for the unpromotable-unreachable case — is written ONCE, in
`plan/issues/4134-eslint-local-index-out-of-range-emit.md` § "Implementation
Plan". Read that first. This section adds only what is specific to the NAMING
case, and one verdict that changes how the shared mechanism applies here.

### Verdict: promotion is NOT the fix for `assertASTDidntChange`

The kill-check in #4134's plan (§0) confirmed uri-js's UMD factory is
single-activation, so promotion CAN fire for its captures — but it MUST NOT be
the route for this survivor. `assertASTDidntChange` calls fast-deep-equal's
capture-free `equal`; the bare-name fallthrough resolves it to uri-js's
factory-nested `equal` instead. Promoting uri-js's `SCHEMES`/`UNRESERVED`
would make the module *emit* while still calling the *wrong* `equal` — it
converts today's loud validation failure into a silent wrong answer, the
outcome this issue exists to prevent. The acceptance criterion is the correct
VALUE, not a valid binary.

Consequence for the shared plan: uri-js's nested `equal`/`parse`/`serialize`
DO satisfy E1/E2 and will be promoted (they are legitimately exported), so the
`assertASTDidntChange` frame breach disappears as a side effect. That is
acceptable ONLY together with the resolution slice below — land them in the
same change-set so the misresolution cannot hide behind a now-valid emit.

### The naming-specific slice: resolve, then refuse

In `compileIdentifierCall` (`src/codegen/expressions/call-identifier.ts`), the
out-of-scope handling at :1057-1088 currently lets an out-of-scope nested
binding fall through to `funcMap` when the closure/local paths miss. Two
changes, in order:

1. **Try the module's own bindings before the flat fallthrough.** When
   `isOutOfScopeNestedBinding` (:1003-1034) is true and `closureInfo` /
   `resolveClosureInfoFromLocal` missed, consult the CURRENT source's import /
   CJS-require binding for the bare name (the `registerImportBindingAliases`
   machinery and `ctx.moduleGlobals`) before `funcMap.get(funcName)`. For
   `assertASTDidntChange`, the CJS rewrite binds `equal` to fast-deep-equal's
   module export — that binding must win over a foreign module's nested
   declaration. Audit exactly what the CJS rewrite produces for
   `var equal = require('fast-deep-equal')` in eslint's rule-tester before
   coding; the dev should trace it with a two-module fixture, not assume.
2. **Refuse loudly only where provably invalid.** If the fallthrough still
   reaches a `funcMap` entry that is an out-of-scope NESTED binding AND its
   cap-prepend would emit an unreachable capture (the shared plan's
   `captureSourceKind === "unreachable"` with no promotion registered), emit
   the shared plan's diagnostic, naming both the out-of-scope owner and the
   likely-intended binding. Do NOT suppress to `ref.null.extern` (measured
   +1200 `null_deref`) and do NOT gate on out-of-scope-ness alone — in-frame
   and promoted cases keep today's behavior (the #1177 restraint).

### Scope walk constraint (restated so it is not re-broken)

Any visibility walk added by slice 1 must keep the owner scope at the enclosing
FUNCTION, never the parent block — block-scoping regressed Annex B §B.3.3
hoisting (#165) and lodash #1303 (see :1006-1011).

### Tests

- Extend `tests/issue-4133-cross-module-function-name-collision.test.ts` with
  the misresolution rung: module A = UMD-style factory with nested exported
  `equal` (with captures); module B requires a DIFFERENT capture-free `equal`
  and calls it. Assert B gets ITS `equal`'s value (base today: invalid module
  or wrong value). Non-vacuity: verify against unfixed base.
- ESLint Tier 1a: `JS2WASM_CHECK_FRAMES=1` goes 2 → 0 only with #4134's
  promotion AND this slice together; record which change closes which breach.

### Still open after this slice (unchanged from above)

- `ensureFuncClosureSingleton` trampoline / allocator-locator per-owner
  discriminator (`src/codegen/closures/method-trampolines.ts`).
- `ref.func` / re-export chains / two-package-version audit.
