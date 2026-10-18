---
id: 6979
title: "S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators"
status: in-progress
assignee: ttraenkler/codex
created: 2026-10-14
updated: 2026-10-19
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: refactor
area: compiler, runtime, cli, ci, docs
language_feature: compiler-internals
goal: architecture
sprint: current
parent: 5385
depends_on: [6708]
related: [4396, 4397, 4399, 4401, 6191, 6749, 6750, 6978]
---

# #6979 — S7: delete the host-semantic implementation

Slice S7 of the #5385 "Implementation Plan v2". After S6 (#6708 default flip,
#6978 named accelerators) the JavaScript environment compiles with the native
semantic regime by default and `host-assisted` exists only as a one-release
rollback spelling. S7 removes the rollback and everything that only it
reached. Stakeholder constraints (2026-09-07) stay in force: `wasm:js-string`
strings, host RegExp/Date/Intl and the Web-API/platform layer remain available
as opt-ins — they are *accelerators* and *capabilities*, not the semantic core,
and nothing in this slice touches them.

## State on 2026-10-14 (the before-picture every slice measures against)

| Fact | Measured | Where |
| --- | --- | --- |
| JS-host test262 CI lane | retired 2026-10-12 (`ae7991db21`); host baseline frozen at `39,379 / 48,232`, SHA `f56c6933`, `scripts/preserve-frozen-host-baseline.mjs` | `.github/workflows/test262-sharded.yml` |
| standalone test262 | `42,067 / 48,232` (87.2 %) | README `AUTO:conformance-standalone` |
| `src/runtime.ts` | 20,221 lines; `resolveImport` ≤ 7,909 lines / 15 `case` arms (`caught_exception`, `string_method`, `extern_class`, `builtin`, `callback_maker`, `getter_callback_maker`, `typeof_check`, `box`, `unbox`, `any_to_index`, `truthy_check`, `extern_get`, `extern_call_raw_callable`, `extern_set`, `extern_set_strict`) | `plan/audit/host-import-policy-baseline.json` `runtimeSource` |
| host-import-policy ratchet | native-first: ≤ 446 imports, 0 legacy, 0 unknown over ≥ 33 probes; compatibility (host-assisted) control: 1–23 legacy imports | same file |
| `semanticProviders` predicates | 213 hits in 91 `src/` files; `"host-assisted"` literal in 3 files | `grep -rF semanticProviders src` |
| `ctx.standalone` arms | 1,659 hits in 495 files (`src/codegen` 1,625, `src/ir` 27, `src/runtime` 2, other 5) | `grep -rF ctx.standalone src` |
| `legacy-semantic` import families | `LEGACY_SEMANTIC_BUILTIN_PREFIXES` (≈40 prefixes: `JSON_`, `Promise_`, `RegExp_`, `Map_`, `Set_`, `number_`, `string_`, `__array_`, `__call_`, `__construct`, `__defineProperty_`, …) + `ECMASCRIPT_EXTERN_CLASSES` + `date_new`/`date_method` + `await` + `string_literal`/`string_method` intents | `src/host-import-policy.ts` L61–L130, L170–L340 |
| codegen registration sites by prefix (string-literal hits in `src/codegen`) | `number_` 179, `__defineProperty_` 116, `__call_` 96, `__array_` 90, `Promise_` 50, `__construct` 22, `string_` 21, `RegExp_` 10, `JSON_` 5, `Map_`/`Set_` 1 each | `grep -rF '"<prefix>' src/codegen` |

Re-measure each row at the start of the slice that changes it; a number
quoted from this table without a fresh run is attribution, not measurement.

## Entry conditions (all must hold before S7-a opens)

(#6978, the accelerator slice, is a hard dependency too; it is listed under
`related` only because its issue file lands in its own implementation PR and
the committed-issue integrity gate rejects a `depends_on` that is not yet on
main. Move it to `depends_on` once that PR has merged.)

1. #6708 merged: `{}` ≡ `native-first` byte-for-byte; `host-assisted` is the
   explicit rollback; `check:host-import-policy` default probe reports zero
   legacy/unknown imports.
2. #6978 merged: `regexp` and `date` accelerators end-to-end; `js-string` and
   `intl` either implemented or filed with measured follow-ups. S7 must not
   delete a path an accelerator still routes through — the accelerator
   classification (`host-accelerator`, family-named) is the keep-list.
3. One standalone nightly after both merges with the per-edition ratchet green
   (ES5 `completed`: zero non-passing rows) and the standalone floor unchanged.
4. npm-compat dashboard refreshed at least once after loopdive/js2#6664 (the
   refresh workflow failed on every run 2026-10-06 → 10-14) with the `js-host`
   lane (now the regime) showing no `measured → error` versus the 10-06
   snapshot's `jsHost` column for clsx, cookie, moment, hono, redux, acorn,
   react, marked, lit, uuid.
5. Decision recorded by the stakeholder: what the README's first conformance
   line reports once the JS-environment default is the regime but CI measures
   only standalone (options: show standalone only; re-enable a `schedule`-only
   `gc` lane; keep the frozen host figure with a "retired" label). S7-e
   implements whichever is chosen; the other slices do not depend on it.

## Slices (each its own PR, in this order; a–b may run in parallel with c once a has landed)

### S7-a — remove the `host-assisted` policy (horizon m)

- `src/target-profile.ts`: `SemanticProviderSelection` = `"native-first"`
  only (`"auto"` and `"host-assisted"` become compile errors naming #6979 and
  the last release that accepted them); `SemanticProviderPolicy` =
  `"native-first" | "backend-defined"`; `nativeRegime` = `backend === "wasmgc"`
  (standalone, gc and wasi) — the `JS2WASM_NATIVE_REGIME_JS` kill switch and
  its `readEnv` import go. `capabilityPolicy` keeps `ambient-js` for the JS
  environment: it governs *platform* capabilities, not semantics.
- `src/cli.ts`: delete `--semantic-providers`; `scripts/check-claude-md-paths.mjs`
  and `CLAUDE.md` "CLI Flags" updated in the same PR.
- The 213 `semanticProviders` predicate sites: every `=== "native-first"` in
  `src/codegen/**`, `src/ir/**`, `src/compiler.ts`, `src/package-linker.ts`,
  `src/boundary-policy.ts`, `src/adapter-manifest.ts`, `src/temporal-provider.ts`,
  `src/runtime.ts` (L4835 `ambientCompatibility`) is constant-true for wasmgc
  and is simplified away; the `!== "native-first"` else-arms are deleted.
  `ctx.standalone || ctx.wasi || … === "native-first"` compounds (e.g.
  `src/ir/integration.ts` L7204/L8625, `src/codegen/host-carrier-to-primitive.ts`
  L87) collapse to `ctx.standalone` (≡ `nativeRegime`). Linear keeps its
  `backend-defined` arm untouched.
- Lanes: `TEST262_SEMANTIC_PROVIDERS` plumbing deleted from
  `scripts/run-test262-vitest.sh`, `tests/test262-shared.ts`,
  `scripts/test262-worker.mjs`; npm-compat `js-host-native` alias and
  `js-host-assisted` control lane deleted from
  `scripts/generate-npm-compat-report.mjs` (dashboard JSON keeps `jsHost` and
  `standalone*`; `website/` readers of `jsHostNative` updated).
- `scripts/check-host-import-policy.ts`: the `compatibility` probe and its
  baseline section are deleted — there is no profile left that may emit a
  `legacy-semantic` import, so the ratchet becomes a hard zero for every probe.
- Tests re-pinned: `tests/issue-4396-target-profile.test.ts` (rollback cases
  become "rejected with the S7 message"), `issue-4397`, `issue-6686`,
  `tests/npm-compat-partials.test.ts`, `tests/test262-per-lane-gating.test.ts`.
- Gate: `node scripts/equivalence-gate.mjs` must be byte-neutral for `gc`
  (the default was already the regime after S6 — this slice removes dead
  arms, so any binary change is a finding).

### S7-b — `legacy-semantic` becomes a compile error and its emitters go (horizon l)

- `src/host-import-policy.ts`: the publication gate rejects `legacy-semantic`
  and `unknown` for every profile (today only native-first); then delete the
  class itself — `LEGACY_SEMANTIC_BUILTIN_PREFIXES`, `ECMASCRIPT_EXTERN_CLASSES`
  and the `legacy-semantic` arms for `string_literal`/`string_method`,
  `extern_class` (ECMAScript classes), `await`, `date_new`/`date_method`,
  `dynamic-language-operations`. What survives must classify as
  `platform-capability`, `value-adapter`, `instance-lifecycle` or
  `host-accelerator` (family-named, #6978) — an import that fits none is a
  compile error, not `unknown`.
- Keep-list, `intl` family (#6986): the `Intl_<Class>_*` extern-class imports
  (`namespacePath: ["Intl"]`, registered by
  `src/codegen/helpers/host-intl-classes.ts`), `global_Intl` and the
  `__intl_*` builtins (`src/codegen/helpers/host-intl-locale.ts`), with their
  runtime marshal `src/runtime/intl-host-accelerator.ts`. None of them is
  `legacy-semantic`: selected they classify `host-accelerator`/`intl`;
  unselected, the extern classes and `global_Intl` classify
  `platform-capability` (host-assisted lane) and the `__intl_*` builtins are
  never emitted. Once `host-assisted` is gone (S7-a),
  `hostIntlAvailable` (`src/target-profile.ts`) reduces to "the `intl`
  accelerator is selected".
- Codegen emitters of those imports are deleted, prefix family by prefix
  family, in this order (largest dead surface first, each a commit that
  leaves the tree green): `number_` (179 sites), `__defineProperty_` (116),
  `__call_` (96), `__array_`/`__js_array_` (90), `Promise_` (50) + the `await`
  driver, `__construct` (22), `string_` (21), `RegExp_` (10 — only the arms
  not behind the `regexp` accelerator), `JSON_` (5), `Map_`/`Set_`/`WeakMap_`/
  `WeakSet_`, `parse*`/`*URI*`/`escape`. Each family's registration lives in
  `src/codegen/declarations/import-collector.ts` and
  `src/codegen/registry/imports.ts`; its use sites are the `!ctx.standalone`
  arms found by `grep -rF '"<prefix>' src/codegen`. Where a `!ctx.standalone`
  arm is the *only* implementation of a construct in a JS environment (no
  regime arm exists), that is a regime GAP: stop, file it against #5385 with
  the test that exposes it, and leave the arm until the gap is closed — never
  delete semantics the regime does not yet provide.
- `src/runtime.ts` `resolveImport`: delete the matching provider bodies
  (`builtin` arm sub-cases for the deleted prefixes, the ECMAScript part of
  `extern_class`, `string_method`'s host string provider); ratchet
  `maximumResolveImportLines` / `maximumResolveImportCases` /
  `maximumRuntimeTsLines` down in `plan/audit/host-import-policy-baseline.json`
  — this is the one baseline file S7 may lower, because the ratchet direction
  is "fewer lines", and the gate refuses growth.
- `src/runtime/legacy-regexp.ts` stays, reachable only via the `regexp`
  accelerator; `__date_parse_host` stays behind `date`.
- `tests/issue-4397-native-semantic-js-host.test.ts` gains a per-family
  non-vacuity test: compiling a program that exercises the family under the
  default profile emits zero imports from that family and still runs
  (equivalence against Node).

### S7-c — collapse the `ctx.standalone` arms (horizon xl, sliced by directory)

`ctx.standalone` already means `nativeRegime`; after S7-a the regime is the
only semantic implementation, so every `if (ctx.standalone) { native } else
{ host }` is either dead-else (semantic site) or mis-keyed (environment site).
The 1,659 hits are classified site by site:

- **semantic** → delete the else-arm, un-nest the regime arm;
- **environment** (console, process, crypto, declared globals, WASI fd, start
  section ordering) → re-key to `hostFreeEnvironment(ctx)` (7 hits today);
- **value boundary** (externref marshaling, callback adapters, export
  wrapping) → re-key to `jsValueBoundary(ctx)` (14 hits today);
- **accelerator** → re-key to `ctx.targetProfile.accelerators.has(<family>)`.

A new ratchet `scripts/check-standalone-arms.mjs` counts `ctx.standalone`
hits per directory against a committed baseline and fails on growth
(`--update-on-decrease` banks reductions, same contract as the IR-fallback
ratchet). Sub-slices by directory, each ≤ 150 sites so a reviewer can read the
classification: `src/codegen/expressions/` (calls, identifiers, assignment,
new-*), `src/codegen/statements/`, `src/codegen/object-model/` + `object-*`,
`src/codegen/array*` + `array/`, `src/codegen/string-ops.ts` + `native-strings.ts`
+ `char-code-at-helpers.ts`, `src/codegen/closures*`, `src/codegen/async-scheduler.ts`
+ `ir-async-runtime-adapters.ts`, `src/codegen/index.ts` + `registry/` +
`declarations/`, `src/codegen/type-coercion.ts` + `binary-ops*` + `dyn-ops.ts`,
`src/ir/`. The field `ctx.standalone` itself is removed in the last sub-slice
(then `nativeRegime` is simply `true` for wasmgc and the profile field goes).

### S7-d — shrink `src/runtime.ts` to adapters + capabilities (horizon l)

After S7-b the runtime keeps: value adapters (`box`/`unbox`, callbacks,
`extern_*`, exception transfer), instance lifecycle, platform capabilities
(console, process, crypto, clock, node/deno), accelerator providers
(`legacy-regexp`, `Date.parse`, js-string imports, Intl), the linked-provider
runtime. Everything else is deleted and `maximumRuntimeTsLines` /
`maximumOwnedAdapterLines` / `maximumExplicitCapabilityLines` ratchet to the
measured result. Target: `resolveImport` ≤ 2,000 lines. The split into
`src/runtime/*.ts` modules (`native-regime-view.ts`, `process-capability.ts`
already exist) continues so no single file re-grows.

### S7-e — retire the two-mode story in docs and dashboards (horizon s)

`CLAUDE.md` "Architecture Principles" (one native semantic core; the JS
environment adds the value adapter, explicit capabilities, named
accelerators), `docs/architecture/codegen-axes.md`,
`docs/architecture/marshaling-contract.md`, `docs/cli.md`, README conformance
lines per entry condition 5, `STATUS.md`, `website/` landing copy that says
"JS-host path"; `scripts/preserve-frozen-host-baseline.mjs` stays as the
historical snapshot publisher with a "retired 2026-10-12" label in the
dashboard. `plan/issues/5385-…` gets its program-acceptance checklist closed.

## Acceptance (program-level, closes #5385)

- [ ] `semanticProviders`, `host-assisted`, `JS2WASM_NATIVE_REGIME_JS`,
      `TEST262_SEMANTIC_PROVIDERS` and `--semantic-providers` no longer exist
      in `src/`, `scripts/`, `tests/`, `.github/` (grep returns zero).
- [ ] `check:host-import-policy`: zero `legacy-semantic`/`unknown` imports on
      every probe; the class `legacy-semantic` is gone from `src/host-import-policy.ts`.
- [ ] `ctx.standalone` hit count 0 and the field deleted; `hostFreeEnvironment`
      / `jsValueBoundary` / `accelerators.has` are the only environment keys.
- [ ] `src/runtime.ts` ≤ 8,000 lines, `resolveImport` ≤ 2,000; baseline
      ratchets lowered accordingly.
- [ ] Standalone test262 ≥ the floor at S7 entry; ES5 `completed` zero
      regressions on every slice; equivalence gate green on every slice.
- [ ] npm-compat `js-host` lane: no `measured → error` versus the entry-condition
      refresh for the ten packages named above.
- [ ] Accelerator opt-ins still work end-to-end (the #6978 focused tests pass
      unchanged).

## Implementation Plan — dispatch notes (Fable, 2026-10-14)

- Plan/implement split: each slice gets an Opus `senior-developer` agent with
  `isolation: "worktree"`, branched from `upstream/main` via `git checkout -B`
  (the cwd hook refuses `git merge upstream/main` in agent worktrees), pushed
  to `fork`, PR on `loopdive/js2wasm`. S7-c sub-slices may run two at a time
  on disjoint directories; everything else is sequential on the merge order
  above.
- Every slice re-measures its row of the state table at start and records
  before/after in this file under a dated checkpoint.
- A `!ctx.standalone` arm with no regime counterpart is a GAP, not dead code:
  file it against #5385, keep the arm, move on. The deletion order is chosen
  so gaps surface early (largest families first).
- The ratchet gates (`check-loc-budget`, `check-func-budget`,
  `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`,
  `check-import-cycles`, flat-dir budget, compiler-boundaries inventory) run
  before every commit; deletions should make them easier, so any growth
  allowance in this program is a smell to explain in the PR.

## Recovery and landing handoff (2026-10-19, Codex)

S7-a was recovered onto current `main` rather than rewritten. The recovery
keeps `main` as the first parent and merges the ten original S7-a commits
through `917fbbca96549e71d6e70f4c877e0bc4a80ef777`. Twelve drift conflicts were
resolved by retaining current-main async/error fixes while deleting the
rollback policy and its semantic host branches. PR `#6701` remains the landing
vehicle; its published branch can be fast-forwarded to this recovery without
rewriting history. S7-b PR `#6705` remains deferred until S7-a lands.

All entry conditions are now satisfied. npm-compat refresh run `39170921043`
measured the exact source `4df0306bd1fa4776335f2115b6d3f7d847fafe87` for
clsx, cookie, moment, hono, redux, acorn, react, marked, lit and uuid; every
`jsHost` row stayed `measured`. The React artifact completed successfully, and
the resulting dashboard promotion PR `#6761` merged into current `main` at
`ae913d622f3c`. The recovery branch then merged that current mainline before
adopting S7-a.

### Boundary contract after S7-a

There is one in-module semantic implementation: native WasmGC values and
objects. JS-host machinery is retained only at an explicit JS↔Wasm boundary.
Callers opt into it with `wrapExports(instance, { signatures,
boundaryPolicies })` (or `wrapCompiledExports`), using the compiler-produced
`exportSignatures` and `exportBoundaryPolicies`. The adapter converts only the
declared wire shapes: booleans, strings, symbols, promises, dynamic values,
typed arrays, closures and object results. Object policies choose a detached
copy, an identity-cached live view backed by the native object, or an opaque
WasmGC handle. No second semantic object implementation is selected.

The retained normalization is boundary ABI normalization, not host execution
of language semantics. It canonicalizes values such as Boolean `0`/`1`,
string/symbol/dynamic carriers, native exception payloads and wrapper identity
as values cross the edge. Keeping it is necessary for host interop and does
not reintroduce the removed `host-assisted` policy. In particular, the live
object mode is the non-copying design: JavaScript receives a cached façade and
the same native object identity is recovered when the value crosses back into
Wasm. `tests/issue-3520-closure-host-bridge-abi.test.ts` now exercises that
metadata-driven contract directly.

Obsolete rollback-only Promise suites and their changed-test selector entry
were deleted. Active quality scripts no longer request `host-assisted`, while
explicit rejection tests still prove that removed spellings fail with the S7
diagnostic. The final host-import-policy measurement is 33 probes / 452
imports, with zero `legacy-semantic` and zero `unknown` imports. The migration
ratchets are `src/runtime.ts` 20,240 lines, `resolveImport` 7,868 lines / 15
cases, owned adapters 989 lines and explicit capabilities 1,194 lines.

Landing evidence:

- Typecheck and lint pass.
- The host-import-policy, IR-fallback, LOC, function-budget, coercion-site,
  oracle, import-cycle and flat-directory ratchets pass.
- The focused #3520 boundary suite passes 20/20; the changed-issue selector
  suite passes 54/54.
- The equivalence gate reports 20 failing, 2,008 passing and 22 known failures,
  with no new regressions and two baseline failures now passing.
- The dead-export audit's core node/type and preservation gates pass. Its
  strict modeled closure remains open only on the two pre-existing nonliteral
  dynamic-import witnesses in `src/optimize.ts` and
  `src/runtime/platform-capability-adapter.ts`.
- `check:compiler-boundaries` retains the repository-wide
  `inventory-valid-architecture-incomplete` result (`errors: []`, graph not
  complete); S7-a introduces no new architecture error.

One migration gap remains explicit: #6996's native-gc console string boundary
ordering rows are expected failures after removal of the host rollback. Fix
the native boundary instead of reinstating a semantic host path. S7-c must
also continue classifying `ctx.standalone` sites individually; do not replace
them wholesale with `nativeRegime = backend === "wasmgc"`.

### S7-a checkpoint (2026-10-15, opus-6979-s7a)

Branch `issue-6979-s7a-remove-host-assisted`, stacked on the S6 flip
(`issue-6708-a-default-native-first` @ `731cfae193`) plus a merge of
`upstream/main` (#6982, #6984, #6986). The one conflict was in
`src/runtime.ts` import binding: an Intl-accelerated import takes the #6986
marshal, every other `extern_class` the #6708 platform marshal. S7 stays
`in-progress` until every slice lands.

Re-measured state-table rows. "Before" is the merged base `728bdced5b`,
measured by this slice:

| Fact | Before | After S7-a |
| --- | --- | --- |
| `grep -rF semanticProviders src` | 231 hits / 93 files | 39 / 19 (types, the linear `backend-defined` arm, the S7 rejection, the explicit-native-first #4401 publication gate, adapter-manifest validation) |
| `grep -rF '"host-assisted"' src` | 17 hits / 5 files | 5 / 2 (the rejection branch and its doc comments) |
| host-import-policy ratchet | 33 probes, ≤ 446 imports, 0 legacy/unknown; compatibility control 1-23 legacy | 33 probes, 446 imports, hard zero legacy/unknown in code; compatibility probe deleted; `maximumRuntimeTsLines` 20227 → 20224, `maximumResolveImportLines` 7909 → 7862 |

What changed:
- **Spellings:** `semanticProviders: "host-assisted"`, `"auto"`, and
  `nativeStrings: false` on the JS target are compile errors naming #6979
  and js2wasm 0.71.0 (`REMOVED_SEMANTIC_PROVIDER_RELEASE`).
- **Removed:** `--semantic-providers`, `JS2WASM_NATIVE_REGIME_JS`, the
  `TEST262_SEMANTIC_PROVIDERS` axis, and the npm-compat `js-host-native` and
  `js-host-assisted` lanes.
- **Codegen/IR:** every `=== "native-first"` is folded away and every
  `!== "native-first"` arm is deleted. This also removed the predicates that
  collapsed to constants, for example `isStandalonePromiseActive`,
  `usesNativeJsErrors`, `usesNativeSymbolProvider`, `usesHostBigIntCarrier`,
  `tryEmitFixedHostMethodCall`, and the host Reflect/JSON/BigInt/array-carrier
  providers. Net about -5,700 src LOC.
- **Byte-neutral:** 1,694 programs (equivalence-suite sources, playground
  examples, a test262 sample) produce identical binaries before and after on
  gc, strict gc, wasi and standalone (6,776 hashes, 0 differences).
- **Equivalence gate:** `47 failing, 1714 passing, 22 known-failures`, with
  the same 27 NEW rows as the merged base (`47 failing, 1723 passing`; all 27
  belong to the open #6980/#6981 PRs). The -9 passing is the nine deleted
  `issue-1197` host-assisted structure rows.

**Deliberately NOT done: `nativeRegime = backend === "wasmgc"`.** The spec
asked for it, but it is not a dead-arm removal. It flips `ctx.standalone` on
for WASI and strict gc. Measured on the same corpus, it changes 1,044 of
1,694 WASI binaries and 1,663 strict-gc binaries, turns 14 WASI compiles into
errors (and 36 strict-gc errors into successes), and moved 10 gc/standalone
hashes. `nativeRegime` keeps its S6 domain (standalone + JS environment with
ambient imports). The flip belongs to S7-c, where the `ctx.standalone` arms
are classified site by site. Until then, compounds like
`ctx.standalone || ctx.wasi || native-first` were folded to `true` (their
value under native-first), not to `ctx.standalone`.

GAPs found (kept, not deleted):
- Construct: a generator over `Map.entries()` feeding `new Map(...)` throws
  during module init on the regime.
  Exposing test: `tests/issue-1058-exported-generic-generator-callback.test.ts`
  "maps entries into a host Map during module initialization" (`it.fails`).
- Construct: `new Set([...a, ...a.map(f), ...b]).size` reads 0 on the regime.
  Exposing test: `tests/issue-1058-host-map-object-entries.test.ts`
  "constructs a top-level Set from an unaliased spread-array temporary"
  (`it.fails`).
- Both passed only through the host-strings profile (`nativeStrings: false`
  on gc). No codegen `!== "native-first"` arm was the only implementation of
  a construct: the flip had already made the regime the default, so every
  deleted arm was unreachable by default.

Left for later slices:
- `tests/issue-6685`, `issue-6913`, and the 6687/6689 probe fixtures still
  set `JS2WASM_NATIVE_REGIME_JS` as lane labels (no-ops).
- The retired `test262-native-first` workflow job (`if: false`) still spells
  `--semantic-providers native-first` / `TEST262_SEMANTIC_PROVIDERS`. These
  are untouched CI files.
- The `issue-5807` replay scripts pin the env var for historical commits, by
  design.
- The #4401 publication gate still keys on an explicit `"native-first"`
  spelling. Making it universal is S7-b.
- `tests/issue-3518-*` exact-source provenance suite: already 3,751 red on
  the base, and +71 with this slice. The failures are span/hash pins of the
  codegen files edited here (bigint-carrier-port, resume-main-composition,
  delivery-main-refresh-port, c1-current-source, descriptor-adapter-relocation,
  …). They need new provenance receipts, not code changes.
- Six `issue-2949` "gc runtime ($AnyValue)" execution describes are deleted.
  They only validated with host strings outside the production finalize
  pipeline; the round-trip is covered structurally.
