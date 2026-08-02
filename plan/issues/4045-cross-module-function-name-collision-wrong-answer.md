---
horizon: xl
id: 4045
title: "Same-named top-level functions in different modules share one slot and silently compute the wrong answer"
status: in-progress
created: 2026-08-02
updated: 2026-08-02
assignee: ttraenkler/claude
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

# #4045 — cross-module function-name collisions produce a silently wrong program

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
**#4045 a hard blocker for "ESLint runs identical to node"** independently of
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
closure/trampoline-focused tests, not just the #4045 rungs.

### Beyond that, still unaudited for this defect class

- `ref.func` references and closure captures of a colliding name.
- Re-exports and `export { x as y }` chains across colliding modules.
- Whether two versions of the *same package* (the eslint-visitor-keys 3.4.3 /
  5.0.1 case) need anything beyond per-unit naming — they are distinct units by
  construction, so probably not, but it has not been verified.
