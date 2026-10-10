---
id: 6930
title: "Linked test262 oracle + native-first: the harness provider is compiled without `semanticProviders`, so every regime row fails to instantiate"
status: ready
created: 2026-10-09
updated: 2026-10-09
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: testing
goal: architecture
sprint: current
parent: 5385
related: [6881, 6723, 3451]
---

# #6930 — linked-harness provider ignores the semantic-provider policy

Found while reproducing #6881 (2026-10-07). With
`TEST262_ORACLE_MODE=linked TEST262_SEMANTIC_PROVIDERS=native-first`, every
row fails at instantiation:

```
WebAssembly.instantiate(): Import #0 module="js2wasm:npm:test262-harness:…"
function="__js2wasm_link_error_ctor_Error": imported mutable global must be a
WebAssembly.Global object
```

Measured locally on all 32 `built-ins/Array/prototype/includes/` rows, with a
fresh `JS2WASM_TEST262_HARNESS_CACHE`, so a stale cache is ruled out.

## Cause

`harnessProviderCompileOptions(target)` in `scripts/test262-worker.mjs` (≈
L1435) builds the provider options without `semanticProviders`, while the body
(`doCompile`) passes it. Under native-first the body is in the native regime
(`ctx.standalone === true`), so it imports the #6723 D4 Error-family carrier
cells (`importStandaloneLinkErrorCtorCells`). The provider is not in the regime,
so it never exports them (`exportStandaloneLinkErrorCtorCells` needs
`ctx.standalone`). The memo key in `getWorkerHarnessProvider` also omits the
policy.

## Fix sketch

Thread `semanticProviders` into `harnessProviderCompileOptions` and the memo
key (`harnessProviderCacheKey` already fingerprints it), and into the prewarm
step if one exists for this lane. Add a test that builds the provider plus one
body under native-first and instantiates the pair.

## Impact

CI does not run this combination today: the nightly `test262-native-first`
lane leaves `TEST262_ORACLE_MODE` unset (honest lane). It blocks any linked
measurement of the regime, and it misled #6881's brief into calling an
honest-lane leak "linked-only".
