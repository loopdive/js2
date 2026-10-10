---
id: 6930
title: "Linked test262 oracle + native-first: the harness provider is compiled without `semanticProviders`, so every regime row fails to instantiate"
status: done
completed: 2026-10-10
assignee: ttraenkler/opus-6930
created: 2026-10-09
updated: 2026-10-10
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
loc-budget-allow:
  # 2026-10-10: +3 lines (import + one predicate line + one comment line) so a
  # native-first harness provider may import js2wasm:runtime-eval like a
  # standalone one; the linker otherwise refuses to link it separately.
  - src/package-linker.ts
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

## Resolution (2026-10-10, opus-6930)

Three changes, each needed for a native-first linked row to reach a verdict:

1. **Provider options carry the policy.** `harnessProviderCompileOptions(target,
   semanticProviders)` moved to `scripts/test262-harness-cache.mjs` and is
   shared by the worker and the pre-warm step. It adds `semanticProviders` only
   when it is not `auto`, so the host options are the same object as before.
   The worker memo key (`harnessProviderMemoKey`) includes the policy and a
   regime tag; `JS2WASM_NATIVE_REGIME_JS=0` (an env read the option fingerprint
   cannot see) gets its own cache subdirectory (`test262HarnessProviderLaneCacheDir`).
2. **The linker accepts the regime's eval import.** A native-first harness
   provider imports `js2wasm:runtime-eval` exactly as a standalone one does
   (`ctx.standalone` is `targetProfile.nativeRegime`), but
   `standaloneProviderRuntimeImports` (`src/package-linker.ts`) allowed it only
   for `target === "standalone"`, so the provider was refused ("not linked
   separately … requires unsupported import js2wasm:runtime-eval") and every row
   fell back. The predicate now also accepts the native regime.
3. **Pre-warm.** `prewarm-test262-harness-providers.mjs` takes
   `--semantic-providers native-first` (default: `TEST262_SEMANTIC_PROVIDERS`),
   writes `harness-prewarm[-target]-native-first.json`, and now uses the
   worker's option builder. The old copy lacked `hostBridge: "always"`, so it
   warmed keys the worker never asked for (this affected the CI standalone
   pre-warm step too).

A regime harness provider is ~1.35-1.7 MB against ~83-182 KB for the host one.
A cold build took 46-86 s on a loaded box, so **this lane needs the pre-warm**:
cold builds cannot fit the per-row budget. Even a cache hit took 5-25 s to load
under load average 40-170 on 8 cores.

CI is unchanged. This issue does not ask for a linked variant of the
`test262-native-first` job. If one is added, it must run the pre-warm with
`--semantic-providers native-first` first.

## Test Results

`built-ins/Array/prototype/includes/` (30 rows), `JS2WASM_EVAL_ENGINE=interpreter
TEST262_ORACLE_MODE=linked TEST262_WORKERS=2`. The box ran at load average 40-185
on 8 cores the whole time, so `compile_timeout` counts reflect load, not the change.

| lane | before | after |
| --- | --- | --- |
| linked + native-first | 0 pass; 18 `compile_error` with `__js2wasm_link_error_ctor_Error`, 12 timeouts | cold cache: 30 timeouts. Pre-warmed: 6 pass, 5 fail (real verdicts), 19 timeouts, 0 link errors |
| linked, host (no policy) | 27 pass, 2 fail, 1 timeout | 14 pass, 1 fail, 15 timeouts |

- Host lane: every row that got a verdict after the change has the same verdict
  as before. The only non-timeout failure is `resizable-buffer.js` in both runs.
  The host provider namespaces and byte sizes match the "before" run
  (`54ed56528d836561` 82,783 B, `e3456ce7fb667114` 182,020 B, …). A direct build
  of the `assert+sta+compareArray` prefix also matches: key `2007dca7513d6299`,
  sha256 `4fd53b5e5908e855`, 55,219 B, byte-for-byte equal before and after.
- `tests/issue-6930-linked-harness-provider-options.test.ts` (6 tests) and
  `tests/issue-6723-p1-harness-cache-lane.test.ts` (6) pass.
