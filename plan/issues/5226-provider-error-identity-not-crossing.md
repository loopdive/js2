---
id: 5226
title: "Errors thrown inside a linked provider lose identity at the seam — e.pass through as generic objects, instanceof RangeError is false in the consumer"
status: done
completed: 2026-08-31
assignee: ttraenkler/dev-5226
sprint: current
priority: medium
horizon: s
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-08-30
# (#5226, 2026-08-31) Growth allowances for the shared-exception-tag change set.
# `registry/imports.ts` carries the fix itself (the imported-vs-defined tag
# branch in `ensureExnTag` plus `exportedExnTagIndex`) and the comment that says
# why a module-local tag is uncatchable across the seam; the other three are a
# one-line option declaration / pass-through / two installer calls each.
# THIS PR'S OWN growth: registry/imports.ts (the fix), compiler.ts + index.ts
# (one line each), package-linker.ts (+11: the two `installSharedExceptionTag`
# calls and their comments).
#
# RESTATED grants, NOT this PR's work — src/runtime.ts (+191) and
# src/codegen/index.ts (+12) belong to the predecessor stack this branch is
# based on (#3523 and #5241 respectively) and are granted in THOSE issue files.
# Which base the gate resolves decides whether those files count as
# "changed by this change-set", so the grants strand as the stack lands
# (verified 2026-08-31: green against LOC_GATE_BASE=origin/main at b91fed8a1f,
# red against the default base once main advanced to d2c7305c0f). Restated here
# per CLAUDE.md so the gate can see them from a file this PR touches; they carry
# no claim of authorship and should disappear when main's baseline refreshes.
loc-budget-allow:
  - src/codegen/registry/imports.ts
  - src/compiler.ts
  - src/index.ts
  - src/package-linker.ts
  - src/runtime.ts
  - src/codegen/index.ts
  # (2026-09-01) Merge-group park fix, this PR's own growth: two small helpers
  # (`liveSyncGlobalIdx` / `emitGlobalSyncWritebackFor`) plus the comment that
  # says why an index copied into a `let` goes stale. See the section below.
  - src/codegen/statements/for-of-destructuring.ts
  # RESTATED, not this PR's work — the predecessor stack's growth, granted in
  # its own issue file, stranded because the gate resolves the change-set from
  # the files THIS PR touches (same mechanism as the src/runtime.ts note above).
  - src/codegen/context/types.ts
func-budget-allow:
  - src/package-linker.ts::compileLinkedProject
  - src/codegen/index.ts::generateMultiModule
  # restated, same reason as above — #5241's growth, not this PR's
  - src/runtime.ts::resolveImport
  # (2026-09-01) Merge-group park fix: +1/+2/+2 lines, one live-index re-read
  # per boxed-capture `global.set` in each of these.
  - src/codegen/statements/for-of-destructuring.ts::compileForOfAssignDestructuring
  - src/codegen/statements/for-of-destructuring.ts::compileForOfAssignDestructuringExternref
  - src/codegen/statements/for-of-destructuring.ts::compileForOfIteratorAssignDestructuring
  # restated, predecessor stack's growth (see loc-budget-allow note)
  - src/codegen/context/create-context.ts::createCodegenContext
# (2026-09-01) Merge-group park fix for run 33442432133 — see "Merge-group park:
# stale module-global index in for-of assignment destructuring" below.
trap-growth-allow:
  count: 1
  reason: "#3596 reclassification (fail -> fail, trap flavour only; the test has never passed). The merge_group run reported illegal_cast 35 -> 38 alongside the 18-file `immutable global` cluster. Fixing the stale module-global index in `for-of-destructuring.ts` returns 2 of those 3 to their pre-chain flavour — `async-{func,gen}-decl-dstr-array-elem-init-fn-name-class.js` go back to `Test262Error: name descriptor value should be cls` (measured 2026-09-01: pre-chain main a4d141321d and this branch produce the identical Test262Error). The third is NOT this defect: `Array/prototype/toLocaleString/invoke-element-tolocalestring.js` is a residual of #5243's `buildRecordFromExternref` arm, which is what that commit set out to change — its `for (const { label, args } of testCases)` binding destructure read `Cannot destructure 'null' or 'undefined'` on pre-chain main (a4d141321d) and reads `illegal cast` from d41376f94d onward, with or without the index fix. Baseline status is `fail` in both states, so no row changes pass/fail; chasing it means re-opening the exact coercion arm that parked this stack, and it is tracked separately rather than widened into a park fix."
  tests:
    - test/built-ins/Array/prototype/toLocaleString/invoke-element-tolocalestring.js
---

# #5226 — provider seam: error identity does not cross

## Problem

An error thrown inside the #4628 linked Temporal provider (e.g. the
polyfill's `RangeError: year is required`) reaches the consumer as a value
for which `e instanceof RangeError === false` (and `instanceof Error` is
unreliable). The message survives; the identity does not. test262 Temporal
rows assert error TYPES (`assert.throws(RangeError, …)`), so every
negative-case row fails at the seam even when the polyfill throws correctly —
this gates wiring the test262 runner to the provider as much as #5223 does.

## Direction

Reduce non-Temporal: provider function that `throw new RangeError("x")`,
consumer catches and checks `instanceof`. Decide the crossing rule: re-mint
the error host-side from name+message when a provider throw crosses the seam
(cheap, loses custom subclass state), or mirror it module-aware like #5222's
value path. Host-lane `Error` objects are host-native, so re-minting at the
linker trampoline (`instantiateLinkedProviders` call wrapper) is likely
sufficient and narrow.

## Acceptance criteria

1. Non-Temporal reduction: `instanceof RangeError` true in the consumer for a
   provider throw; new `tests/issue-5226-*.test.ts` failing on base (linked
   lane), single-module control passing.
2. `assert.throws(RangeError, () => Temporal.PlainDate.from({}))`-shaped
   probe passes through the provider.
3. No regressions in issue-5222/4628 + linker family. Gates green.

## Root cause (measured 2026-08-31, not the one the Direction guessed)

Nothing was "stripped to a generic object" and nothing needed re-minting. The
value was **gone**: `typeof e === "undefined"` in the consumer's `catch`.

Wasm matches a `catch` clause by **tag identity**, and `ensureExnTag`
(`src/codegen/registry/imports.ts`) gave *every module* its own module-local
`__exn` tag. A provider's `throw` therefore could never match the consumer's
`catch $exn`; it fell to the consumer's `catch_all`, whose recovery path calls
the `__get_caught_exception` host import. That import only answers a value when
a **JS frame** observed the throw — and a directly imported provider function is
a plain wasm→wasm call with no JS frame in between. So the binding was
`undefined`, message included.

That also explains why only ONE of the two routes was broken:

| route | why | base |
| --- | --- | --- |
| statically imported provider function | direct wasm→wasm call, no JS frame | `e === undefined` |
| provider-**mirror** method (`NS.m()`, the #5222 lane) | goes through a host mirror, so a JS frame exists | already correct |

### Fix

One host-owned `WebAssembly.Tag` per process, imported as `env.__exn` by **both**
halves of a linked graph (`sharedExceptionTag` compile option, set by the package
linker on the provider *and* root compiles and by `compileWithTemporalGlobal`).
The externref payload — a host-native `Error` — is then delivered **by identity**.

Consequences of choosing shared-tag over re-mint:

- **Nothing is lost.** `instanceof`, `name`, `message`, own props, and even a
  non-Error throw (`throw {name: "Weird"}`) all cross unchanged. A re-mint would
  have had to declare custom subclass state as a bound; this has no such bound.
- Non-linked modules are **byte-identical** — the option is only set by the
  linker, and wasi/standalone are excluded (no JS host to own the tag), so those
  keep their module-local tag and their previous bytes.
- `PROVIDER_LINKER_ABI_VERSION` bumped `npm-link-v3` → `v4`: a v3 cached provider
  artifact has a module-local tag and cannot be instantiated by a v4 host.
- `validateLinkedSignatures` (the linker's compile-time dry-run instantiation)
  must supply the tag too, or every linked graph falls back to `bundled` with
  "tag import requires a WebAssembly.Tag".

### Base / after

Reduction (`tests/issue-5226-provider-error-identity.test.ts`), linked lane;
the single-module control answers the after-column on base already:

| probe | base | after |
| --- | --- | --- |
| `throw new RangeError` | `no-RE\|no-E\|undefined` | `RE\|E\|object\|n=RangeError\|m=range-x` |
| `throw new TypeError` | `no-TE\|m=undefined` | `TE\|m=type-x` |
| `throw new Error` | `no-E\|m=undefined` | `E\|m=plain-x` |
| `throw {name, message}` | `undefined\|n=undefined` | `object\|n=Weird\|m=w` |
| provider-mirror method | correct | unchanged |

Temporal (`.tmp/probe-temporal-5226.mjs`, fresh `JS2WASM_TEMPORAL_CACHE` per
lane, `cacheHit: false` both):

| probe | base | after |
| --- | --- | --- |
| `new Temporal.PlainDate(2020, 13, 40)` | `no-E\|n=undefined` | `RE\|n=RangeError` |
| `Temporal.PlainDate.from({})` | `TE\|n=TypeError` | unchanged |
| `Temporal.PlainDate.from("nope")` | `RE\|n=RangeError` | unchanged |

**Honest correction to the issue's premise:** the reported shape
`assert.throws(RangeError, () => Temporal.PlainDate.from({}))` **already worked**
on this chain tip (a static reached through the seam is called via a host
mirror). What was genuinely broken, and is fixed here, is the direct wasm→wasm
route — which a `new` on a provider class takes, and which any provider function
imported by name takes.

### Reported-NOT-fixed, with its bound

An **uncaught** throw that escapes an exported function to the **host** still
surfaces as a bare `WebAssembly.Exception` with no `name`/`message`. Measured
identical in the single-module control, before and after — an export-boundary
gap, not a provider-seam one. The last test in the reduction asserts both lanes
agree so a future fix has a measured starting point.

### Validation

`tests/issue-5226-provider-error-identity.test.ts` (4). Regressions green, one
vitest process per file: issue-5221/5222/5223/5225/5237/5239/5241/5242/5243/5244,
issue-4628 ×2 (including the heavy Temporal lane, 11 tests, with the three new
error-identity rows), provider-manifest, linker, issue-3521 ×4, issue-3765 ×2,
issue-3782, issue-2928-e6, issue-2928-refusal. Equivalence gate: 24 failing /
1718 passing — exactly the baseline, no new regressions. Gates green on both
bases (`merge-base(origin)` and `LOC_GATE_BASE=origin/main`).

Known container-environmental, fails on base too:
`issue-3521-prepared-free-function-routing` (vitest fork OOM at ~55 s).

## Notes

- Found by dev-5221 validating PR #5334. Blocks (with #5223) the test262
  runner wiring for #4628 acceptance criterion 2.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-30.

## Merge-group park: stale module-global index in for-of assignment destructuring

The chain's merge_group (run 33442432133, "check for test262 regressions") flipped
18 rows `pass → compile_error`, one cluster:
`test/language/statements/for-await-of/async-{func,gen}-decl-dstr-{array-elem,array-rest,obj-prop}-*`,
all reading `immutable global #107 cannot be assigned`. It also grew the
uncatchable-trap ratchet `illegal_cast` 35 → 38.

### Root cause

`src/codegen/statements/for-of-destructuring.ts`. The assignment-destructuring
paths resolved the target's module global **once** and then emitted `global.set`
with that snapshot:

```
const globalIdx = ctx.moduleGlobals.get(targetEl.text);   // ~L1791, snapshot
…compile the element read / default init / TDZ guard…     // may INTERN strings
fctx.body.push({ op: "global.set", index: vecSyncGlobalIdx });   // ~L1874/L1954
```

Every string constant interned in that window adds an **imported** global, and
imported globals precede module-defined ones in the index space, so
`fixupModuleGlobalIndices` shifts `ctx.moduleGlobals` and every already-emitted
`global.get`/`global.set` — but it cannot reach an index a caller copied into a
`let`. #4447 fixed exactly this for two object-pattern sites by carrying the
NAME; the array / tuple / vec / rest / externref / iterator twins kept the
snapshot. On the repro the target was `let x`, whose TDZ guard interns
`"x is not defined"` inside that window; 18 imports of drift later, index 107
named `string_constants.IsHTMLDDA` (verified by disassembling the emitted
module) instead of `x`'s slot at 125. Imports are immutable ⇒ instantiate
rejects the module.

**Exposed by, not caused by, #5243.** `git archive`-per-commit bisection on
`async-func-decl-dstr-array-elem-nested-array.js`: pass at the #5242 tip
`c4c3dbdc98`, fail at the #5243 tip `5805690814`; inside that link the only
source commit is `d41376f94d` (`buildRecordFromExternref`), which interns one
string constant per record field name and so moved enough imports into the
snapshot→writeback window to make the latent staleness reachable. The
staleness itself predates it.

### Fix

Carry the target NAME instead of the index and resolve at emit time —
`liveSyncGlobalIdx` + `emitGlobalSyncWritebackFor`, applied to the nine
writeback sites and the five raw boxed-capture `global.set` pushes. No behaviour
change where nothing interned: `ctx.moduleGlobals.get(name)` returns the
snapshot's own (possibly shifted) index.

### Measurements (2026-09-01)

Base runs executed here, not inherited:

| tree | `async-func-decl-dstr-array-elem-nested-array.js` |
| --- | --- |
| pre-chain main `a4d141321d` | **pass** |
| chain tip `c838cea6b8` | fail, `immutable global #107 cannot be assigned` |
| current `origin/main` `e904b5f4b2` | fail, identical (PR #5365 already landed the exposing commit — **this defect is on main now**) |
| this branch + fix | **pass** |

Same three-way result for `async-gen-decl-dstr-array-rest-elision.js`. Cluster
sample all pass with the fix: `async-func-decl-dstr-array-elem-nested-obj`,
`async-func-decl-dstr-array-rest-nested-array`,
`async-{func,gen}-decl-dstr-obj-prop-elem-init-evaluation`.

`illegal_cast` +3 → +1. Two of the three
(`async-{func,gen}-decl-dstr-array-elem-init-fn-name-class.js`) return to their
pre-chain `Test262Error: name descriptor value should be cls`. The third is
covered by the `trap-growth-allow` above — see its `reason` for why it is
#5243's residual and not this defect.

### Reported, not fixed

`test/built-ins/Array/prototype/toLocaleString/invoke-element-tolocalestring.js`
still traps `illegal cast` (baseline `fail`, so no row changes verdict).
Bound: one test, one category, `fail → fail`. It is a residual of #5243's
`buildRecordFromExternref` arm — pre-chain it read
`Cannot destructure 'null' or 'undefined'`, which is precisely what that commit
set out to fix — and chasing it means re-opening the coercion arm that parked
this stack.
