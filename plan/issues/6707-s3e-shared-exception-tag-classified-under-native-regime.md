---
id: 6707
title: "S3-e: the linker's shared exception tag `env.__exn` is an instance-wiring import, not unknown host semantics — unblocks the regime Temporal provider"
status: done
completed: 2026-09-27
assignee: ttraenkler/opus-6707
created: 2026-09-27
updated: 2026-09-27
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: host-interop, compiler, linking
language_feature: host-imports
goal: architecture
sprint: current
parent: 5385
depends_on: [6706]
related: [4401, 5226, 5247, 5353, 6706]
---

# #6707 — S3-e: classify the shared exception tag under the native regime

Follow-up carved by S4 (#6706 "Finding"). With the regime on by default for
`native-first` (S5, #6191), the package linker's provider compile of
`@js-temporal/polyfill` is refused before publication:

```
Native-first semantic-provider policy rejected implicit or unclassified host
imports: env::__exn (unknown, owner #4401)
```

so the regime measurement lane cannot link a Temporal provider and loses
~1,500 host-passing rows (`Temporal is not defined`, `until`/`since`/`round`
on `undefined`).

## What `env.__exn` is

`sharedExceptionTag: true` is set only by `src/package-linker.ts`
(≈ L1889, ≈ L2090) for provider/consumer builds. The JS embedder owns one
`WebAssembly.Tag({ parameters: ["externref"] })` and hands it to every module
as `env.__exn` (`src/linked-provider-runtime.ts` ≈ L83–L90), so an exception
thrown in the provider is catchable in the consumer. `create-context.ts`
≈ L248 keeps it for any target that is not `wasi`/`standalone` — correct for
the regime: the *environment* is JavaScript, the JS host owns the tag, and
a standalone provider (no JS host) keeps its module-local tag, which is why
the standalone Temporal provider carries no imports at all.

This is instance/link-time wiring in the #4399 sense (like `__register_*`,
`caught_exception`), not an ECMAScript semantic fallback. It is `unknown`
only because `buildHostImportInventory` in `src/host-import-policy.ts`
classifies `env` entries by their typed intent and a `tag`-kind import has
no descriptor, so it falls to `policy("unknown", …)`.

## Change

1. `src/host-import-policy.ts`: in `buildHostImportInventory` (≈ L311),
   before the generic `env` fallback, classify `module === "env" && kind ===
   "tag" && name === "__exn"` as
   `policy("instance-lifecycle", "shared-exception-tag", 5226, true,
   "linker-owned shared exception tag; a host-free build keeps a module-local tag")`.
   Native fallback is genuinely `true` (that is the standalone behaviour).
2. Add the same arm to `classifyNonEnvImport` only if the tag ever moves off
   `env` — today it does not; do not widen.
3. Test: extend `tests/issue-4401-host-import-policy.test.ts` with a
   `sharedExceptionTag: true` native-first compile (a one-function module
   that throws) asserting the inventory shows exactly one
   `instance-lifecycle`/`shared-exception-tag` entry, zero legacy/unknown,
   and that the publication gate accepts it; and a kill-switch
   (`JS2WASM_NATIVE_REGIME_JS=0`) case with the same expectation (the tag is
   environment-shaped, so it must classify identically in both).
4. Prove the unblock: `JS2WASM_NATIVE_REGIME_JS=1 node scripts/prewarm-temporal-provider.mjs --target host --semantic-providers native-first`
   now builds and stamps `prewarm-native-first.json`; then the scoped run
   `TEST262_SEMANTIC_PROVIDERS=native-first TEST262_PATH_FILTER="built-ins/Temporal/Now/" TEST262_WORKERS=1 pnpm run test:262`
   announces the link and `Temporal is not defined` rows drop (before: 48 of
   66 in that folder, per #6706).

Do not change `create-context.ts`'s tag decision, `linked-provider-runtime.ts`,
or the linker; do not add `__exn` to any allowlist by spelling.

## Acceptance

- [x] `pnpm run check:host-import-policy` green, ceilings unchanged (the 33
      probes never request the shared tag, so import totals do not move).
- [x] `tests/issue-4396-target-profile.test.ts` byte-identity green.
- [x] Regime Temporal provider builds and stamps; scoped `Temporal/Now`
      run links it; record before/after `Temporal is not defined` counts.
- [ ] Next nightly after merge: native-first lane `Temporal is not defined`
      host-passing rows ≤ the standalone lane's count (record it in #5385).

## Implementation note — where the arm actually lives (2026-09-27)

The plan put the arm in `buildHostImportInventory`'s no-descriptor branch. That
branch is never reached for `env.__exn`: `buildImportManifest`
(`src/compiler/import-manifest.ts`) emits a descriptor for EVERY `env` import,
recording the wasm `tag` as `kind: "global"` with the fallback intent
`{ type: "builtin", name: "__exn" }`, which `classifyBuiltin` answers `unknown`.
More importantly, the native-first **runtime adapter** gate (`src/runtime.ts`,
`ambientCompatibility === false`) classifies the same manifest descriptor via
`classifyHostImport` — measured: with only the physical-import arm, the provider
compiled and linked, then all 66 `Temporal/Now` rows failed with
`Native-first adapter cannot bind env::__exn: unknown import owned by #4401`.

So the arm is in `classifyHostImport`, keyed on `module === "env"`, a non-`func`
manifest kind, and the name — the one predicate both gates see. A `func`-kind
`env.__exn` stays `unknown` (unit-asserted). No allowlist spelling, no change to
`create-context.ts`, `linked-provider-runtime.ts`, the linker or the manifest.

## Test Results (2026-09-27, measured on this branch vs its upstream/main base)

Regime on via `JS2WASM_NATIVE_REGIME_JS=1` (S5 / PR #6191 not yet merged at the
base). Before = the base `src/host-import-policy.ts`, after = this change; each
used its own cold `JS2WASM_TEMPORAL_CACHE` so no fixed-build artifact was served.

| Measurement | Before | After |
| --- | --- | --- |
| `prewarm-temporal-provider.mjs --target host --semantic-providers native-first` | FAILED (`provider compilation failed`, plan=bundled) | OK, 3,763,632 B, stamps `prewarm-native-first.json` |
| scoped `built-ins/Temporal/Now/` (66 rows), provider | UNAVAILABLE — rows run unlinked | linked (`host/native-first … ceac0b969ccde8cf`) |
| `ReferenceError: Temporal is not defined` rows | 48 | **0** |
| pass | 1 | 0 |
| other failures | 17 assertion failures | 66 × `wasm exception during module init` |

- `pnpm run check:host-import-policy`: green before and after; 33 probes /
  426 imports / 0 legacy / 0 unknown; compatibility legacy 23 — unchanged.
- `tests/issue-4396-target-profile.test.ts` 12/12; `tests/issue-4401-host-import-policy.test.ts`
  7/8 — the one red ("preserves target-derived standalone compatibility
  fallbacks…") is pre-existing on main. The three new #6707 cases (regime on,
  kill-switch, func-kind negative) were red on the base with the exact
  `env::__exn (unknown, owner #4401)` diagnostic.

## Finding — the next blocker is `Intl`, not the tag (out of scope here)

The 66 `module init` failures are the provider's OWN top level throwing:
`TypeError: Cannot access property on null or undefined` at polyfill `4:10198`,
which is `ct=Intl.DateTimeFormat`. Minimal repro
(`var ct = Intl.DateTimeFormat;`, `deferTopLevelInit`):

| | native-first | auto |
| --- | --- | --- |
| regime on | throws (reads `Intl` as `undefined`) | OK |
| regime off | CE: `string_constants::Intl (legacy-semantic)` | OK |

Under the regime `Intl` is neither refused nor provided — it silently reads
`undefined`. Until that is closed the native-first lane's Temporal rows move
from `Temporal is not defined` to `module init`, not to passes, so acceptance
item 4 (nightly native-first ≤ standalone) cannot be met by this slice alone.
Needs its own slice (Intl as an environment global under the regime).
