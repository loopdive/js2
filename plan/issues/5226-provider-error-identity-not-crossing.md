---
id: 5226
title: "Errors thrown inside a linked provider lose identity at the seam — e.pass through as generic objects, instanceof RangeError is false in the consumer"
status: in-progress
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
# `src/package-linker.ts` is a RESTATED grant: against the merge-base it is
# covered by #5241's issue file, but CI diffs the merge preview against main's
# refreshed baseline, where that grant is stranded (verified 2026-08-31 with
# LOC_GATE_BASE=origin/main). This PR's own +12 there is the two
# `installSharedExceptionTag` calls plus their comments.
loc-budget-allow:
  - src/codegen/registry/imports.ts
  - src/compiler.ts
  - src/index.ts
  - src/package-linker.ts
func-budget-allow:
  - src/package-linker.ts::compileLinkedProject
  - src/codegen/index.ts::generateMultiModule
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

## Notes

- Found by dev-5221 validating PR #5334. Blocks (with #5223) the test262
  runner wiring for #4628 acceptance criterion 2.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-30.
