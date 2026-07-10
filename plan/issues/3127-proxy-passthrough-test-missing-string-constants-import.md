---
id: 3127
title: "proxy-passthrough.test.ts broken on main (missing string_constants import) — masked a REAL bug: trap-absent Proxy get on a WasmGC-struct target reads undefined"
status: done
sprint: current
created: 2026-07-10
completed: 2026-07-10
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: tests, runtime
language_feature: Proxy
goal: standalone-mode
related: [1667, 2180, 2618, 498]
assignee: ttraenkler/fable-shepherd
origin: "2026-07-10 fable-shepherd — found while drift-refreshing PR #2815 (#3031): tests/proxy-passthrough.test.ts fails 3/3 on pure origin/main (b6691942bd832), same on unrelated branches."
---

# #3127 — proxy-passthrough test rot masked a trap-absent Proxy [[Get]] bug

## Problem (layer 1 — the latent test)

All 3 tests in `tests/proxy-passthrough.test.ts` failed on `main` with:

```
WebAssembly.instantiate(): Import #0 "string_constants": module is not an object or function
```

The test's local `run()` helper instantiated with a hand-rolled `{ env: {} }`
import object, which never supplies the `string_constants` namespace that
every string-pooling module has required since #1667. The file sits at
`tests/` root, which no CI job executes (`quality` runs lint/typecheck/gates
+ named files; the equivalence shards run `tests/equivalence/`; `linear-tests`
runs `linear-*`/`c-abi`/`simd`), so it rotted silently. Same root cause and
fix as `tests/functional-array-methods.test.ts` (see its header): use the
shared `buildImports()` builder + `setExports` wiring.

## Problem (layer 2 — what the throw was masking)

With the harness fixed, 2 of 3 tests STILL failed — a real runtime bug:

**A trap-absent `get` on a Proxy whose target is a raw WasmGC struct returns
`undefined` for every field** (`new Proxy(structTarget, {}).x` → unboxed 0).

Mechanism: `_hostProxyConstruct` (#2180) keeps the raw struct as
[[ProxyTarget]] (identity-preserving). §7.3.10 "missing trap ⇒ target's
ordinary internal method" then runs the HOST engine's ordinary [[Get]]
against a struct that is **opaque to V8** — no visible fields — so the read
misses. Trap-PRESENT reads were fine (the bridge fires user traps); only the
forwarding default was broken. This is also the root cause of the baseline
test262 failures `built-ins/Proxy/get/trap-is-undefined.js` and
`trap-is-undefined-no-property.js` (verified locally: both shapes flip to
pass with the fix; the trap-present shape still returns the trap result).

Additionally, the old test 2 asserted the obsolete tier-0 semantics ("get
trap is IGNORED, reads pass through") — since #2180 real traps fire, so the
spec-correct expectation is the trap's return value. The test was updated,
not the runtime.

## Fix

1. **Harness** (`tests/proxy-passthrough.test.ts`): `buildImports(result.imports,
   undefined, result.stringPool)` + `imports.setExports?.(...)` — the canonical
   pattern.
2. **Runtime** (`src/runtime.ts`): `_hostProxyConstruct` /
   `_hostProxyConstructRevocable` now pass `structTarget` (the user target,
   only when it is a WasmGC struct kept as [[ProxyTarget]] — i.e. no callable
   substitution) into both bridge builders. Both the eager and lazy builders
   install a default `get` bridge trap for the trap-absent case that reads
   through `_resolveHostField(structTarget, key, exports)` — the same
   canonical precedence `_wrapForHost` uses (accessor getter → sidecar →
   `__sget_*` field getter → well-known-symbol sidecar → vivified prototype).
   NOTE: `_safeGet` was deliberately NOT used — its string-key struct arm does
   not consult `__sget_<key>` (that lookup lives in `__extern_get` /
   `_resolveHostField`), which is why a first cut with `_safeGet` still read
   `undefined`.

## Why this shape (implementation notes)

- **Fix point = the bridge default, not `__extern_get`**: `_safeGet` line
  ~4787 already routes user-proxy reads into the host MOP (`obj[key]`), so
  installing the forwarding trap makes EVERY boundary read path correct at
  once; patching `__extern_get` alone would leave other MOP entry points
  broken and duplicate struct-read logic.
- **Not `_wrapForHost` as [[ProxyTarget]]**: swapping the proxy target for a
  readable wrapper would fix forwarding for ALL MOPs but breaks trap-arg
  identity (`assert.sameValue(trapTarget, target)` in get/set/has traps) and
  cannot be built at START-timing (exports unwired). Rejected.
- **`get` only, this slice**: `has`/`set`/`ownKeys`/`getOwnPropertyDescriptor`
  forwarding on struct targets has the same opaque-target gap (see baseline
  `trap-is-undefined-target-is-proxy.js` etc.) but each has its own result
  semantics and invariant interactions — follow-up material, tracked below.
- **Invariants safe**: an explicit bridge `get` result is validated by V8
  against the [[ProxyTarget]]'s own descriptors; the opaque struct exposes
  none, so no §10.5.8 invariant conflicts can fire.
- **Plain-JS handler + struct target** (host-created handler object) keeps the
  old behavior — compiled programs produce WasmGC-struct handlers, so the
  live shapes are covered; noted as a residual in the code comment.

## Residual / follow-up

- Trap-absent `has` / `set` / `deleteProperty` / `ownKeys` /
  `getOwnPropertyDescriptor` forwarding on struct targets (baseline fails
  `trap-is-undefined-target-is-proxy.js`, `trap-is-missing-target-is-proxy.js`,
  `not-same-value-configurable-false-writable-false-throws.js`, …).
- `tests/issue-2615.test.ts` (2 cases: set/delete "WebAssembly objects are
  opaque") and `tests/struct-proxy-wrappers.test.ts` (1 case: `__sget_*`
  "expected true to be 1") also fail on pure main — pre-existing, unrelated
  to this change (verified by control runs on origin/main), same
  latent-tests/-root-not-in-CI class.

## Test Results

- `tests/proxy-passthrough.test.ts`: 0/3 → **3/3** (probe/regression coverage
  for the done-flip).
- Proxy/Reflect sweep (`issue-2180`, `issue-2615`, `issue-2616`, `issue-2617`,
  `issue-2618`, `issue-2933`, `struct-proxy-wrappers`, `issue-3031-proxy-apply`,
  `proxy-passthrough`): 57 passed / 3 failed — the 3 failures are byte-identical
  on pure `origin/main` (pre-existing, listed above). Net delta of this PR:
  +3, no collateral.
- test262 shapes probed locally: `trap-is-undefined.js` and
  `trap-is-undefined-no-property.js` core shapes flip fail → pass (lazy
  top-level bridge); trap-present lazy shape unchanged (returns trap result).
