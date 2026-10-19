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
func-budget-allow:
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/generators-native.ts::nonWasmGcProviderGeneratorUsesAreSafe
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

### S7-b recovery handoff (2026-10-19, Codex)

The published S7-b history through `aac2b4040d` has been recovered onto the
validated S7-a head `ec4165107c` on branch `codex/6979-s7b-recovery`. The old
S7-b head remains the recovery merge's second parent, so PR `#6705` can be
fast-forwarded without rewriting its public history after S7-a lands. The
recovery had five conflicts:

- the issue and host-import ratchet retain both the current recovery evidence
  and the S7-b deletion checkpoint;
- the obsolete `new` host-construct fallback and
  `own-property-method-shadow.ts` stay deleted;
- `compatibility-semantic-adapter.ts` retains only the named `date`
  accelerator intents;
- current-main boundary fixes remain: admitted object/callback throws are
  normalized onto the module exception tag, and a dynamic `null` crosses as
  the native null rather than a boundary-object box.

Those boundary fixes explain the only increase relative to the original
S7-b checkpoint. The recovered ceilings are `src/runtime.ts` 12,066 lines,
`resolveImport` 1,959 lines / 7 cases, owned adapters 898 lines and explicit
capabilities 1,194 lines. They are boundary ABI and capability code, not a
semantic-host implementation. Relative to current S7-a, the recovery still
deletes 13,942 lines across 70 files and the repository-wide source budget is
net -18,229 `src/` lines.

Recovered evidence:

- `check:host-import-policy`: 33 ordinary probes / 452 imports, zero
  `regime-gap` and zero `unknown`; accelerator probes retain only regexp,
  date and Intl, while the three explicit gap probes remain separately named
  (`eager-generator-buffer`, `shared-array-buffer`, `temporal-strings`).
- Typecheck, lint, formatting, IR-fallback, LOC, function-budget,
  coercion-site, oracle, import-cycle and flat-directory gates pass.
- Equivalence reports 20 failing, 2,008 passing and 22 known failures, with no
  new regressions and two baseline failures now passing.
- The S7 policy/accelerator suites pass. The linked script-goal suite passes
  6/6 after building its pinned QuickJS adapter. Five failures in the host
  async and Calendar exact-artifact suites reproduce identically on the S7-a
  control, so they are not S7-b regressions.
- The dead-export audit retains only its two pre-existing nonliteral dynamic
  import witnesses. The compiler-boundary inventory is valid again after
  removing the deleted `export-throw-boundary.ts` classification; the broader
  repository architecture remains incomplete with `errors: []`.

PR `#6705` remains draft while S7-a PR `#6701` finishes its required checks.
Once S7-a lands, push this recovery head to the existing S7-b branch, refresh
the PR body from this evidence, and mark it ready. S7-c, S7-d and S7-e remain
required before the full host migration is complete.

### Original S7-b checkpoint (2026-10-15, opus-6979-s7b)

Branch `issue-6979-s7b-legacy-semantic-removal`. It is stacked on the S7-a head
`917fbbca96` (draft PR #6701, itself stacked on the S6 flip #6672) and is a
draft PR against `main`. S7 stays `in-progress`.

**How this was measured.** A corpus of 1,930 programs, scanned after every
commit: equivalence-suite sources, playground examples, and a 1-in-97 sample of
`test262/test/{built-ins,language}`. Each program was compiled on four profiles:
`gc` default, strict gc (`strictNoHostImports`), `standalone` and `wasi`. For
each compile we recorded the binary sha256, success, and any `unknown` or
`regime-gap` imports. Where a binary changed, the normalised WAT was diffed
against the previous commit.

**Policy (`src/host-import-policy.ts`).**
- The `legacy-semantic` class and `LEGACY_SEMANTIC_BUILTIN_PREFIXES` are
  deleted.
- A retired host-semantic import now classifies `unknown`, owner #6979, family
  `retired-host-semantics`. This covers host strings, Date, the `await` driver,
  dynamic language operations, ECMAScript extern classes, and every unlisted
  builtin.
- `ECMASCRIPT_EXTERN_CLASSES` stays. It is the only thing that tells a declared
  class (a platform capability) apart from an ECMAScript builtin (retired).
  Codegen uses it through `isRetiredEcmaScriptExternClass`.
- New class `regime-gap`, owner #5385. It covers exactly the three families the
  lead approved. `check:host-import-policy` holds an explicit name ceiling for
  them and runs one non-vacuous probe per family.
- New `declared_function` intent. An ambient `declare function` from user
  source or a non-ECMAScript lib is classified `platform-capability`
  `declared:<name>` instead of `unknown`.
- The #4401 publication gate (`src/compiler.ts`) rejects `unknown` on every
  WasmGC profile, not only an explicit native-first spelling. The diagnostic
  names #6979.

**Strict gc moves onto the regime.** `nativeRegime` is now `standalone || gc`,
approved for strict only; WASI is unchanged. Measured on the corpus:
- strict legacy/unknown debt drops from 140 programs to 7 (the
  eager-generator gap family);
- 44 strict compiles that used to fail now succeed;
- 4 that used to succeed now fail. All 4 fail with the same #680 error gc
  already reports for them ("native generator lowering currently supports only
  sequential numeric yields"): `yield-as-expression` #2, two
  `for-await-of/async-gen-dstr-*` rows, and a
  `dynamic-import/nested-async-gen` row.

`create-context` asserts the invariant S7-b relies on: WasmGC codegen lowers
with the regime or WASI, never neither. Every arm keyed on
`!(ctx.standalone || ctx.wasi)` is therefore dead.

Host-import registration sites per family (`addImport(ctx,"env",…)` /
`ensureLateImport(ctx,…)` calls in `src/codegen` + `src/ir`). The raw
string-literal hit counts in the state table also count the native helpers
that share these names, so they are not a measure of host emitters.

| Family | Registration sites S7-a → S7-b | `grep -rF '"<prefix>' src/codegen` S7-a → S7-b | Deleted in |
| --- | --- | --- | --- |
| `number_` / `bigint_` | 10 → 3 | 179 → 167 (`number_`), 27 → 23 (`bigint_`) | 55bbfc1218 |
| `__call_` | 11 → 1 | 97 → 79 | b593e4ca9c |
| `__array_` / `__js_array_` | 72 → 4 | 86 → 70, 120 → 7 | 928f93f22e |
| `Promise_` / `__await` | 2 → 2 (+ dead pre-registration loop, `await` intent) | 33 → 33 | 35a23e7f4a |
| `__construct` | the four `new` host-construct arms | 25 → 11 | 928f93f22e |
| `string_` | 3 → 3 (`js-string` lane, kept) | 21 → 21 | — |
| `RegExp_` (outside the accelerator) | 2 → 0 | 7 → 1 | 35a23e7f4a |
| `JSON_` | dead scan flags | 3 → 3 | 35a23e7f4a |
| `Map_`/`Set_`/`WeakMap_`/`WeakSet_` + ECMAScript extern classes | extern-class registration for ECMAScript builtins | 1 → 1 each | 35a23e7f4a |
| `parse*` / `*URI*` / `escape` | dead URI fall-through | 86 → 85, 18 → 17, 19 → 19, 16 → 16 | 29c88a770f |
| `__defineProperty_` | 4 → 3 (native object runtime), externref-class-fields.ts | 123 → 121 | 29c88a770f |

Registration sites are counted by `.tmp` script: single-line `addImport(ctx, "env", "<lit>"` /
`ensureLateImport(ctx, "<lit>"` with a literal name. Template-named registrations
(`Promise_${m}`, `${prefix}_new`) and multi-line calls are not in this count;
the per-family commits name the ones that were deleted.

What is left, and why:
- `number_`, `string_`: the `!ctx.nativeStrings` host-string lane. It is kept
  for the pending `js-string` accelerator (#6978 keep-list).
- `__defineProperty_`: these resolve to the native object runtime
  (OBJECT_RUNTIME_HELPER_NAMES).
- `__call_`: the WASI-only branch of the IR Promise-delay lowering.
- `__array_` / `__js_array_`: two sites.
  - The Promise combinator host fallthrough (`emitIterableArg`).
  - The node-builtin named-import call (`tryCompileNodeBuiltinMemberCall`).
    It does not fire in my `platform: "node"` / `emulateNode` probes.
- `Promise_`: the `.then` / `.finally` host miss arms and the non-inline
  executor `new Promise` fallthrough.

All remaining sites are only reachable for shapes the regime does not lower.
They now end in a compile error naming #6979; none appears in the corpus.

**`src/runtime.ts` (`resolveImport`).**

| Metric | S7-a | S7-b | Ceiling |
| --- | --- | --- | --- |
| `runtime.ts` lines | 20,224 | 12,050 | 20224 → 12050 |
| `resolveImport` lines | 7,862 | 1,953 | 7862 → 1953 |
| `resolveImport` case arms | 15 | 7 | 15 → 7 |
| owned-adapter lines | 962 | 860 | 962 → 860 |

The seven arms that remain are `caught_exception`, `extern_class`, `builtin`,
`callback_maker`, `getter_callback_maker`, `box` and `unbox`.

What was deleted:
- `builtin` arm: 187 sub-cases for names that can no longer be published.
- Whole intent arms: `string_method`, `typeof_check`, `any_to_index`,
  `truthy_check`, `extern_get`, `extern_call_raw_callable`, `extern_set` and
  `extern_set_strict`.
- `extern_class`: the ECMAScript constructors, including the BigInt/Symbol
  `Object(v)` boxing.
- 77 module-level helpers that became unreferenced.
- `compatibility-semantic-adapter.ts`, reduced to the `date` accelerator
  intents.

What stays:
- The `regexp` (`__regexp_host_*`, `legacy-regexp.ts`), `date`
  (`__date_parse_host`) and `intl` paths.
- The `__temporal_*` and `__gen_*` regime-gap providers.
- The SharedArrayBuffer constructor.
- Every value-adapter, lifecycle and capability provider.

**Equivalence gate.** Shard verdicts sum to `47 failing, 1714 passing, 22
known-failures`. The 27 NEW rows are identical, row for row, to the same gate
run on the S7-a head (`diff` empty); they belong to the open #6980/#6981 PRs.

**GAP list.** Each row is a construct whose host import is still its only
implementation on the native regime. The lead approved them as `regime-gap`.
They are not fixed here; each should be filed as a #5385 regime slice.

| Family | Construct | Exposing program (corpus count, gc) |
| --- | --- | --- |
| `eager-generator-buffer` (`__gen_*`, `__create_generator`, `__create_async_generator`) | Generator shapes the native generator lowering declines (#680), mostly async generators whose `yield` result is consumed or that are re-entered through `.throw()`/`.return()`. `addGeneratorImports({ allowNoJsHost: true })` registers the host eager-buffer bundle. | `tests/equivalence/issue-1388.test.ts` #2; test262 `AsyncGeneratorPrototype/throw/throw-suspendedYield-promise.js`, `AsyncFromSyncIteratorPrototype/throw/iterator-result-poisoned-value.js`, three `class/elements/*async-gen*` rows, `async-gen-method-static/yield-promise-reject-next-for-await-of-async-iterator.js` (7 programs; same on standalone, strict and WASI) |
| `shared-array-buffer` (`SharedArrayBuffer_new`) | `new SharedArrayBuffer(n)` whose value escapes into an `Int32Array`/`Atomics` call has no native provider | test262 `Atomics/load/expected-return-value.js`, `Atomics/waitAsync/bad-range.js`, `Atomics/waitAsync/value-not-equal-agent.js`, `ArrayBuffer/prototype/transfer/this-is-sharedarraybuffer.js` (4 programs) |
| `temporal-strings` (`__temporal_*_to_string`, `*_from_string_field`, `*_add_field`, `month_code`, `duration_sign`) | Temporal string parsing/formatting and duration-field arithmetic in `temporal-native.ts` call the host | test262 `Temporal/PlainDate/prototype/toString/calendarname-undefined.js`, `PlainDate/from/argument-propertybag-calendar-string.js`, `PlainDate/prototype/{add,subtract}/…`, `PlainTime/prototype/toString/roundingmode-wrong-type.js`, `Duration/from/argument-string-fractional-units-rounding-mode.js`, `Duration/prototype/toJSON/balance-subseconds.js` (7 programs) |

Findings that are not gaps:
- WASI `tests/equivalence/wrapper-constructors.test.ts` #3 needed an
  unsatisfiable `env::__unbox_string`. It is now a compile error; a WASI host
  could never run it.
- An externref-backed class instance gets no field initializers on the regime.
  The host DefineField lane (`externref-class-fields.ts`, deleted) early-returned
  on the regime and on WASI since S6, so behaviour is unchanged.
- Pre-existing, also on the S7-a head: `Promise.all([...])` followed by an
  indexed read of the result traps with "dereferencing a null pointer" on gc
  and standalone. The non-vacuity test avoids this shape.

**Tests.**
- `tests/issue-4397-native-semantic-js-host.test.ts` gains the per-family
  non-vacuity suite. It covers 11 families × {default, native-first,
  standalone}: zero family imports, zero `unknown`, and the result equals
  Node's. 33/33 pass.
- Tests that bound deleted runtime providers through hand-built manifests or
  through the IR "host" target are retired:
  - whole files: `fixed-host-method-calls.test.ts`,
    `issue-3527-prepared-dynamic-async.test.ts`,
    `issue-3527-prepared-program-async-consumer.test.ts`;
  - async halves: `issue-3527-prepared-numeric-throw`, and the execution half of
    `issue-3518-program-codec-replay`'s mixed-application case;
  - the "facade" lane of `issue-3518-host-async-imports`;
  - the `__defineProperty_value` bit-6 provider case of `issue-6474`;
  - the compatibility half of the `issue-4399` refusal test.

  The IR "host" target is never produced by `compile()`: a JS-environment
  build projects to `standalone` in `projectIrBackendTargetProfile`.
- The policy tests (`4401`, `4396`, `6978`, `6986`, `5131`, `4577`) are
  re-pinned to the new classes.

### S7-c IR-arm handoff (2026-10-19, Codex)

Branch `codex/6979-s7c-ir-arms` is stacked on the recovered S7-b head
`9423a71e82` (`fork/codex/6979-s7b-recovery`). This is the first bounded S7-c
directory slice; S7 stays `in-progress`.

**Ratchet.** `scripts/check-standalone-arms.mjs` now lexically counts
`ctx.standalone` per source directory, including comments, against
`plan/audit/standalone-arms-baseline.json`. A new directory with hits is a
`0 → N` failure; every existing directory fails on growth;
`--update-on-decrease` banks only reductions. The scanner also requires at
least 1,746 TypeScript source files, so an empty or misdirected scan cannot
pass. The package entry point is `pnpm run check:standalone-arms`.

This slice measured and banked:

| Measure | S7-b base | S7-c IR slice |
| --- | ---: | ---: |
| Raw `ctx.standalone` hits in `src/` | 1,614 | 1,590 |
| Matching source files | 496 | 494 |
| `src/ir/` hits | 24 | **0** |

**Classification.** Every IR occurrence was classified rather than replaced
mechanically:

- Semantic decisions now select the one native WasmGC implementation:
  undefined probing, `%Function.prototype%.[[Call]]`, batched native string
  concat, holey-array filter, standardized exceptions, native
  `ReferenceError`, `in`, primitive wrappers, dynamic `ToNumber`, and the
  compiler timer shim.
- Embedder decisions use `hostFreeEnvironment`: DOM/clock capabilities,
  ambient extern surfaces and indirect-eval availability. The neutral helper
  lives in `target-profile.ts`; `codegen/context/types.ts` preserves its
  context-shaped compatibility wrapper. Keeping the IR import on the neutral
  policy module avoided a new `ir → codegen` value-cycle edge.
- Callback adaptation uses `jsValueBoundary`; host callbacks remain boundary
  machinery, not a second semantic implementation.
- Host Date and JS-string decisions use `hasHostAccelerator("date" |
  "js-string")`. The pending JS-string profile remains rejected by #6978; no
  implicit host-string lane was reintroduced.

The result keeps native objects and strings canonical inside Wasm. JS-backed
facades are still created only by the explicit live export boundary, and
ambient platform objects remain environment capabilities rather than semantic
providers.

**Validation.** All new-slice gates pass:

- TypeScript 7 typecheck, Biome lint, Prettier check and the new standalone-arm
  ratchet.
- Host-import policy: 33 probes / 452 imports / zero `regime-gap` or `unknown`
  imports on the native-first matrix; runtime metrics remain 12,066 lines,
  `resolveImport` 1,959 lines / 7 cases, owned adapters 898 lines and explicit
  capabilities 1,194 lines.
- Equivalence: 20 failing, 2,008 passing, 22 known failures, two baseline
  failures now passing and **no new regressions**.
- `issue-4396`, `issue-4397` and `issue-6978`: 93/93 pass under the repository's
  exnref-enabled Node wrapper.
- IR fallbacks, LOC, function, coercion and oracle ratchets pass. Import cycles
  pass with no growth (one measured number dropped); flat-directory budget
  passes. Compiler-boundary inventory remains the expected
  `inventory-valid-architecture-incomplete` with `errors: []`.
- The dead-export audit retains only the two pre-existing nonliteral dynamic
  import witnesses. Four `issue-4588` timer-shim failures reproduce on the
  S7-b control with the same assertions, so they are not S7-c regressions.

**Next handoff.** Keep this PR stacked until S7-a and the recovered S7-b land.
The next S7-c branch should start from this head and take one of the planned
≤150-site directory groups, preferably `src/codegen/statements/` (37 hits) or
`src/codegen/declarations/` + `registry/` (56 hits). Run
`check:standalone-arms -- --update-on-decrease` only after the directory is at
its reviewed lower count; never raise another directory's ceiling.

### S7-c statement-arm handoff (2026-10-19, Codex)

This second bounded S7-c slice continues on `codex/6979-s7c-ir-arms` after the
IR checkpoint. S7 remains `in-progress`; this checkpoint removes the statement
directory's complete regime fork without claiming the program-level migration
is complete.

**Ratchet.** The reviewed reductions are banked:

| Measure | IR checkpoint | Statement checkpoint |
| --- | ---: | ---: |
| Raw `ctx.standalone` hits in `src/` | 1,590 | **1,549** |
| Matching source files | 494 | **486** |
| `src/codegen/statements/` hits | 37 | **0** |

The two additional `src/codegen/` and two `src/codegen/declarations/` drops
come from renaming the internal persistent-Script context fact from
`standaloneScriptVarBindings` to `sharedScriptVarBindings`; the public compile
option remains unchanged. The WasmGC backend check remains explicit where the
old regime bit also excluded the linear backend.

**Classification.** The 37 statement occurrences were reviewed individually:

- The optional `document` guard is environmental and now asks
  `hostFreeEnvironment(ctx)`.
- Strict switch equality, native async iteration, sparse-array reads,
  iterator-close EH, for-in key formatting, proxy enumeration, native
  RegExp/subarray/object-identity carrier inference, and direct-eval capture
  are semantic decisions. Their host branches are deleted and the native path
  is unconditional inside the WasmGC statement lowering.
- Standard try/catch/finally now has one tagged standardized-EH encoding. The
  legacy structured-EH `catch_all` / `__get_caught_exception` sidecar path is
  gone from ordinary statement lowering.
- Arguments objects always use the native branded vec when identity is needed;
  the `__register_arguments` host overlay is deleted.
- Spread argument materialization closes the previously documented WASI gap:
  opaque iterables use `__array_from_iter_n`, `__extern_length`, and
  `__extern_get_idx` in every environment. `issue-2202` now exercises typed and
  opaque spreads under JavaScript, standalone, and WASI (33/33 passing).

This also retires the now-unreachable host RegExp-result carrier exception and
the statement-local `__host_eq` / `__async_iterator` semantic imports. JS
machinery remains at the explicit value boundary and for named capabilities or
accelerators; none of these statement decisions creates a second semantic
implementation.

**Validation.** TypeScript 7 typecheck, Biome lint, Prettier, the standalone-arm
ratchet, IR-fallback, import-cycle, flat-directory, LOC, function, coercion and
oracle gates pass. Host-import policy remains 33 probes / 452 imports / zero
regime-gap or unknown imports, with runtime metrics unchanged at 12,066 lines,
1,959 `resolveImport` lines / 7 cases, 898 owned-adapter lines and 1,194
explicit-capability lines. The equivalence gate is unchanged at 20 failing,
2,008 passing and 22 known failures, with two baseline failures now passing and
no new regressions. Compiler-boundary inventory retains
`inventory-valid-architecture-incomplete` with `errors: []`; dead-export
analysis retains only the two known nonliteral dynamic-import witnesses.

The focused statement-family run had 258 passing, 22 failing and 37 skipped
assertions. An exact A/B on pre-edit commit `1c9cc738da` reproduced all 22
failures row-for-row with the same error shapes; they are existing S7-stack
debt, not statement-slice regressions. The strengthened spread suite then
passed 33/33 on the candidate.

**Next handoff.** Continue with `src/codegen/declarations/` plus
`src/codegen/registry/`, now 41 + 13 = 54 raw hits. Preserve the same rule:
environment decisions use the explicit environment/value-boundary facts,
semantic decisions collapse to native WasmGC, accelerators name their family,
and any host-only construct with no native counterpart is a measured regime
gap rather than a renamed mode arm.

### S7-c declaration/registry handoff (2026-10-19, Codex)

This third bounded S7-c slice continues on `codex/6979-s7c-ir-arms`. It
finishes the planned `src/codegen/declarations/` + `registry/` group and closes
the directly exposed native-object consumer mismatch in the same checkpoint.
S7 remains `in-progress`; the PR stays stacked and draft until S7-a/S7-b land.

**Ratchet.** The reviewed reductions are banked:

| Measure | Statement checkpoint | Declaration/registry checkpoint |
| --- | ---: | ---: |
| Raw `ctx.standalone` hits in `src/` | 1,549 | **1,469** |
| Matching source files | 486 | **472** |
| `src/codegen/declarations/` hits | 41 | **0** |
| `src/codegen/registry/` hits | 13 | **0** |

The remaining 26-hit reduction comes from the dependency closure and from
renaming internal capability facts whose names still encoded the retired mode:
`standaloneGlobalThisImport` is now `linkedGlobalThisImport`, and
`standaloneMicrotaskNotifyImport` is now `microtaskNotifyImport`. Public compile
options and link-manifest fields are unchanged.

**Classification.** Declaration and registry sites now describe the actual
axis they select:

- WasmGC semantic/carrier analysis uses `targetProfile.backend === "wasmgc"`:
  empty-object shape evolution, divergent assigned shapes, descriptor-array
  carriers, module-undefined seeds, parameter/return inference and native
  struct registration are backend facts, not environment or JS-host facts.
- Registry construction uses the same backend fact for native error types,
  type registration, peer exception namespaces and native import ownership.
  The linear backend retains its pre-existing import/type behavior.
- Environment-owned decisions are explicit. Standalone console value/sink
  registration uses `targetProfile.environment === "none"`; the historical
  GC/standalone Promise-source condition is expressed as WasmGC plus
  `environment !== "wasi"`; microtask notification is a named linked
  capability rather than a mode field.
- Import normalization is only a classification/routing cleanup: it maps each
  request to backend, environment, boundary or named-capability facts before
  registration. It does not copy values, change object identity, or introduce
  a new semantic provider. Linear and JS-boundary compatibility behavior is
  preserved.

**Native object dependency closure.** Enabling the declaration analyses for
WASI exposed consumers that still treated `ctx.standalone` as synonymous with
"native WasmGC". The initial #2372 probe made the split visible: descriptor
and receiver analyses selected native carriers, while dynamic reads and
reflection skipped the finalized native arms. The closure is deliberately on
the semantic side of the boundary:

- non-empty `any`/`unknown` object literals use the existing native `$Object`
  carrier on every WasmGC environment, so a dynamic descriptor remains an
  object the native `__obj_define_from_desc` machinery can inspect;
- finalized closed-struct `__extern_get`, `__extern_set`, has-own and own-name
  arms now run for every WasmGC environment;
- native `$Object` and closed WasmGC structs remain canonical inside the
  module. Existing JS-host-backed wrappers/facades are retained only at the
  explicit JS value boundary; this slice adds no internal dependency on JS
  objects and performs no object copying at that boundary.

This answers the boundary design question directly: objects should use JS
machinery only when they actually cross into JavaScript. Reusing the existing
host-backed boundary object is preferable there, because it preserves identity
and avoids duplicate mirrors. It must not become the compiler's internal
semantic representation; WASI demonstrates why the native carrier has to stand
on its own without a JS host.

**Validation.** The final candidate passes:

- `tests/issue-2372.test.ts`: 26/26 across standalone and WASI, including
  dynamic data/accessor descriptors, conflict throwing, closed-struct dynamic
  get/set and own-property reflection.
- Focused object/carrier suite: 208 passing and five failing assertions. The
  same five failures reproduce exactly on pre-slice commit `1c98d6a685` (three
  stale known-gap expectations, RegExp gOPN and the existing #4194 constructor
  field divergence), so there is no candidate-only failure.
- Equivalence gate: 20 failing, 2,008 passing, 22 known failures; two baseline
  failures now pass and there are **no new regressions**.
- TypeScript 7 typecheck, Biome lint, Prettier, standalone-arm ratchet,
  IR-fallback, import-cycle, flat-directory, LOC, function, coercion and oracle
  gates pass. Compiler-boundary inventory remains
  `inventory-valid-architecture-incomplete` with `errors: []`; dead-export
  analysis retains only the two known nonliteral dynamic-import witnesses.
- Host-import policy remains 33 probes / 452 imports / zero `regime-gap` or
  `unknown` imports. Runtime metrics remain 12,066 lines, 1,959
  `resolveImport` lines / 7 cases, 898 owned-adapter lines and 1,194 explicit
  capability lines.

**Next handoff.** A compact next checkpoint is the remaining leaf-directory
group `src/codegen/context/` (4), `analysis/` (3), `helpers/` (5), `classes/`
(18) and `closures/` (13): 43 raw hits total. Continue classifying by backend,
environment, value boundary and named accelerator. Do not reintroduce a JS
object as internal semantic storage; keep host-backed objects at the explicit
interop boundary only.

### S7-c leaf-directory and callable-boundary handoff (2026-10-19, Codex)

This fourth bounded S7-c checkpoint finishes the 43-site leaf-directory group
on `codex/6979-s7c-ir-arms` and closes the ambient-function value gap exposed by
that classification. S7 remains `in-progress`; this PR remains stacked and
draft until its S7-a/S7-b prerequisites land.

**Ratchet.** The reviewed reductions are banked:

| Measure | Declaration/registry checkpoint | Leaf/callable checkpoint |
| --- | ---: | ---: |
| Raw `ctx.standalone` hits in `src/` | 1,469 | **1,425** |
| Matching source files | 472 | **446** |
| `src/codegen/context/` | 4 | **0** |
| `src/codegen/analysis/` | 3 | **0** |
| `src/codegen/helpers/` | 5 | **0** |
| `src/codegen/classes/` | 18 | **0** |
| `src/codegen/closures/` | 13 | **0** |

The extra one-hit reduction is the ambient-function declared-global gate in
`extern-declarations.ts`, now keyed directly to `jsValueBoundary`.

**Classification.** Class and closure object-model choices are native WasmGC
backend facts: derived-constructor guards, dynamic heritage reads, constructor
return overrides, native collection subclasses, closure result carriers,
`new.target`, Function construction and apply dispatch no longer pretend that
the JavaScript environment selects a second semantic implementation. Host
callback result boxing and mixed host-callable storage are instead keyed to
`jsValueBoundary`. RegExp, Date and Intl routes name their accelerator families
directly. The linear backend retains its existing provider/carrier behavior.

**Ambient functions as values.** A user `declare function hostTick(...)` still
uses its typed Wasm function import for a direct `hostTick(...)` call. Only a
real first-class read such as `let selected = hostTick` requests the separate
`global_hostTick` identity thunk and fixed-arity
`__boundary_callback_call_1` adapter. The variable keeps the exact JS function
as an externref at the boundary, while later assignments may still install a
native compiled closure. The identifier dispatcher distinguishes those two at
runtime and never revives the retired `__call_function` semantic ABI.

No object or function is copied by this path. If the global thunk runs during
the Wasm start section, it returns the original JS identity immediately and
defers only per-instance boundary admission until `setInstance` publishes the
exports. That makes the existing host-backed object/function machinery usable
at the boundary without making it native storage. A direct-call-only regression
also proves that neither the global identity thunk nor a boundary-callback
adapter is emitted when no value read exists. The implementation lives in the
declarations subsystem rather than growing the ambient collector god-file.

**Validation.** The candidate has the following evidence:

- TypeScript 7 typecheck, Biome lint, Prettier, standalone-arm ratchet,
  IR-fallback, LOC, function, coercion, oracle, import-cycle and flat-directory
  gates pass.
- Host-import policy remains 33 probes / 452 imports / zero `regime-gap` or
  `unknown` imports. Runtime metrics remain 12,066 lines, 1,959
  `resolveImport` lines / 7 cases and 1,194 explicit-capability lines; the
  owned-adapter surface is **897**, below its 898-line ceiling.
- `issue-4397-native-semantic-js-host.test.ts` passes 64/64, including direct
  ambient calls, a boundary-stored host callable, startup-window identity
  admission and replacement with a compiled closure.
- Equivalence remains 20 failing, 2,008 passing and 22 known failures, with two
  baseline failures now passing and no new regressions.
- The focused class/closure/accelerator run has 171 passing and ten failing
  assertions. Eight failures (`issue-2951`, `issue-6417`) reproduce exactly on
  pre-checkpoint commit `97e364b700`; two `issue-3488` rows cannot run because
  this checkout lacks their test262 fixture files. There is no candidate-only
  failure. Class residue passes 51/51; Intl, accelerators, collection subclasses,
  console values and Octane TypeScript pass completely.
- The changed-root hook reached 16/17 assertions in `issue-1183`; its sole Set
  iteration boundary failure reproduces identically on the same detached
  `97e364b700` control.
- Compiler-boundary inventory retains the expected
  `inventory-valid-architecture-incomplete` status with `errors: []`.

**Next handoff.** Continue with a bounded reviewed group, preferably
`src/codegen/array/` (22) plus `src/codegen/object-model/` (29), before taking
the much larger expression directory (362). Preserve the same rule: native
WasmGC owns language semantics and storage; JS machinery owns only explicit
interop values, capabilities and named accelerators.

### S7-c array/object-model handoff (2026-10-19, Codex)

This fifth bounded S7-c checkpoint finishes the planned
`src/codegen/array/` + `src/codegen/object-model/` group on
`codex/6979-s7c-ir-arms`. S7 remains `in-progress`; the PR remains stacked and
draft until its prerequisites land.

**Ratchet.** The reviewed reductions are banked:

| Measure | Leaf/callable checkpoint | Array/object checkpoint |
| --- | ---: | ---: |
| Raw `ctx.standalone` hits in `src/` | 1,425 | **1,374** |
| Matching source files | 446 | **416** |
| `src/codegen/array/` | 22 | **0** |
| `src/codegen/object-model/` | 29 | **0** |

**Classification.** All 51 sites selected native WasmGC language semantics or
native carrier storage rather than an environment capability or JavaScript
value boundary. Array holes and receiver identity, generic Array method bodies,
array-like exotic arms, proxy/object MOP dispatch, primitive-wrapper reads,
own-key ordering, descriptor rejection, generator-function prototypes and
native prototype links now use the same native machinery in every WasmGC
environment. Constant-index `in` uses the existing native
`__extern_has_idx`; dynamic keys continue through the shared native object MOP.

This does not replace the boundary representation or copy objects. Existing
JS-host-backed objects remain the representation when an object actually
crosses the JavaScript boundary, preserving identity and host interop. The
change removes the environment bit from internal semantic/storage decisions;
it does not add a WASI dependency on JS machinery. Import normalization from
the earlier checkpoint remains routing/classification only and is unaffected.

**Focused evidence.** The new
`issue-6979-array-object-mode-collapse.test.ts` passes 3/3: a WASI structural
probe verifies the object carrier bag slot, and standalone plus WASI both
translate native descriptor rejection to `Reflect.defineProperty(...) ===
false`. `issue-4397-native-semantic-js-host.test.ts` remains 64/64, covering
the JavaScript interop boundary after the internal mode collapse.

The focused existing array cohort measured 88 passing and four failing
assertions. The focused object cohort measured 86 passing, 14 failing and six
skipped assertions. An exact detached A/B at pre-checkpoint commit
`f8b4ce5e73` reproduced all 18 failures row-for-row, including the same error
shapes, so the candidate has zero slice-specific regressions across 174 passing
assertions.

**Architecture validation.** TypeScript 7 typecheck, Biome lint, Prettier,
standalone-arm ratchet, host-import policy, IR fallback, import-cycle,
flat-directory, LOC, function, coercion, oracle and verdict-oracle gates pass.
Host-import policy remains 33 probes / 452 imports / zero `regime-gap` or
`unknown` imports, with runtime metrics at 12,066 lines, 1,959
`resolveImport` lines / 7 cases, 897 owned-adapter lines and 1,194 explicit
capability lines. Equivalence remains 20 failing, 2,008 passing and 22 known
failures; two baseline failures pass and there are no new regressions.
Compiler-boundary inventory is
`inventory-valid-architecture-incomplete` with `errors: []`; this checkpoint
also records the prior ambient-function boundary helper in that inventory.
Dead-export preservation remains 6/6 full and 6/6 cut witnesses while the two
known nonliteral dynamic imports keep strict closure open and retirement
uncertified.

**Next handoff.** Continue with the coherent top-level array follow-up:
`array-methods.ts` (18), `array-prototype-borrow.ts` (9),
`array-object-proto.ts` (6), `array-nonindex-key.ts` (4),
`array-flat-native.ts` (3) and `array-slice-native.ts` (3), for 43 raw hits.
Keep JS-backed object machinery at the explicit interop boundary only; collapse
semantic and carrier choices onto the native WasmGC implementation.

### S7-c top-level array semantic handoff (2026-10-19, Codex)

This sixth bounded S7-c checkpoint completes the 43-site top-level array group
on `codex/6979-s7c-ir-arms`. S7 remains `in-progress`; the PR remains stacked
and draft until its prerequisites land.

**Ratchet.** The reviewed reduction is banked:

| Measure | Array/object checkpoint | Top-level array checkpoint |
| --- | ---: | ---: |
| Raw `ctx.standalone` hits in `src/` | 1,374 | **1,331** |
| Matching source files | 416 | **410** |
| Six-file top-level array group | 43 | **0** |

The group is `array-methods.ts`, `array-prototype-borrow.ts`,
`array-object-proto.ts`, `array-nonindex-key.ts`, `array-flat-native.ts` and
`array-slice-native.ts`.

**Classification and normalization.** Thirty-eight semantic/carrier sites now
name the WasmGC backend directly: array HOFs, equality, sparse backing growth,
generic borrowed methods, native flatten/slice, prototype glue and the expando
bag do not depend on whether JavaScript is the surrounding environment. Two
sites that really unwrap or spread a JS facade use `jsValueBoundary`; one
callback-safety site uses `hostFreeEnvironment`; two comment-only hits were
removed.

This makes explicit what the earlier normalization already did:
`ctx.standalone` is initialized from `targetProfile.nativeRegime`, not from the
literal `standalone` target. In other words, it had already selected native
semantics in default JS-host WasmGC builds. Replacing that compatibility alias
with backend/environment/boundary predicates does not drop host interop; it
prevents future code from mistaking native semantics for a host-free
environment. The old tests and comments that still say the JS-host lane is
byte-unchanged are therefore stale migration-era descriptions.

**Boundary objects.** This checkpoint does not copy arrays or objects into a
second representation. Wasm-owned arrays keep their native carrier and expose
the existing live facade only when a value crosses the JavaScript boundary.
Caller-owned JS values keep their identity at that boundary. The dynamic
spread and typed-array facade unwrap paths are the only two sites in this group
that deliberately retain JS machinery.

**Validation.** The candidate has the following evidence:

- `issue-4397-native-semantic-js-host.test.ts` remains 64/64 and
  `issue-6979-array-object-mode-collapse.test.ts` remains 3/3, directly covering
  live JS boundary identity and the native carrier model.
- The wider focused array run has 158 passing and six failing assertions. One
  cannot run because this checkout lacks its test262 fixture. Four standalone
  Array-subclass assertions still expect the old fail-loud result, and one
  JS-host `toLocaleString` assertion still expects the retired semantic import;
  the conditions changed here are branch-equivalent for those configurations
  because the pre-checkpoint `ctx.standalone` already meant `nativeRegime`.
- Equivalence remains 20 failing, 2,008 passing and 22 known failures; two
  baseline failures pass and there are **no new regressions**.
- TypeScript 7 typecheck, Biome lint, Prettier, standalone-arm ratchet,
  host-import policy, IR fallback, import-cycle, flat-directory, LOC, function,
  coercion, oracle and verdict-oracle gates pass.
- Host-import policy remains 33 probes / 452 imports / zero `regime-gap` or
  `unknown` imports, with runtime metrics at 12,066 lines, 1,959
  `resolveImport` lines / 7 cases, 897 owned-adapter lines and 1,194 explicit
  capability lines.
- Compiler-boundary inventory remains
  `inventory-valid-architecture-incomplete` with `errors: []`. Dead-export
  preservation remains 6/6 full and 6/6 cut witnesses; the same two nonliteral
  dynamic imports keep strict closure open and retirement uncertified.

**Next handoff.** Continue with a bounded object/property dispatcher group.
The largest remaining top-level concentrations are `object-ops.ts` (36),
`property-access.ts` (34) and `property-access-dispatch.ts` (31); split that
101-site area into reviewable semantic, environment and boundary checkpoints
rather than changing it as one mechanical batch. Keep native WasmGC objects as
the semantic/storage authority and reuse JS-backed objects only at the explicit
value boundary.

### S7-c object/property dispatcher handoff (2026-10-19, Codex)

This seventh bounded S7-c checkpoint completes the 101-site object/property
dispatcher group on `codex/6979-s7c-ir-arms`. S7 remains `in-progress`; this
lands another reviewed migration checkpoint rather than claiming the program
is complete.

**Ratchet.** The reviewed reduction is banked:

| Measure | Top-level array checkpoint | Object/property checkpoint |
| --- | ---: | ---: |
| Raw `ctx.standalone` hits in `src/` | 1,331 | **1,230** |
| Matching source files | 410 | **407** |
| `object-ops.ts` | 36 | **0** |
| `property-access.ts` | 34 | **0** |
| `property-access-dispatch.ts` | 31 | **0** |

The shared `wasmGcBackend` policy query now names the backend decision directly
without regrowing already-large dispatch functions. It is a backend fact, not
an environment or interop synonym.

**Classification.** Object descriptors, accessors, deletion, Proxy routing,
open-object reads, numeric element reads, primitive wrappers, iterators and
native carrier dispatch now select the WasmGC implementation by backend. The
linear backend retains its provider-specific behavior. Two genuinely different
axes stay explicit: `process.*` availability is decided from the WasmGC backend
plus `hostFreeEnvironment`/`jsValueBoundary`, while an externref string's host
length fallback is admitted only by `jsValueBoundary`. The existing host
buffer byte-attribute bridge remains an explicit boundary exception.

This is also the intended answer for boundary objects. Internal objects use the
native WasmGC MOP and storage. An object that actually crosses the JavaScript
boundary may keep the existing JS-host-backed representation and identity; it
is not copied into a second object model. JS machinery is therefore reused at
the boundary only, not selected as a competing semantic implementation.

The earlier normalization was not harmful: default `gc` and literal
`standalone` already projected `ctx.standalone` from `nativeRegime`, so their
semantic branches were already the same. Replacing the compatibility bit with
the backend query makes that fact explicit and intentionally brings WASI onto
the same WasmGC object/property semantics. The environment and value-boundary
queries preserve the places where WASI and a JavaScript embedder really differ;
the linear backend remains outside this collapse.

**Validation.** The candidate has the following evidence:

- `issue-6979-array-object-mode-collapse.test.ts` now passes 5/5, including a
  new standalone/WASI `any`-typed numeric-property probe through the native
  object MOP. Together with the 64 boundary tests in `issue-4397` and the four
  `process.env` regime tests in `issue-6910`, the focused policy set is 73/73.
- The wider 31-file object/property cohort is 393 passing, 17 failing and ten
  skipped assertions. A detached A/B at pre-checkpoint commit `0734da6c00`
  reproduces all 17 failures exactly across the four failing files (38 passing,
  17 failing in both runs), so there is no slice-specific failure.
- Equivalence remains 20 failing, 2,008 passing and 22 known failures; two
  baseline failures pass and there are **no new regressions**.
- TypeScript 7 typecheck, Biome lint, Prettier, standalone-arm, host-import
  policy, IR-fallback, import-cycle, flat-directory, LOC, function, coercion,
  oracle and verdict-oracle gates pass. No function-budget allowance was added.
- Host-import policy remains 33 probes / 452 imports / zero `regime-gap` or
  `unknown` imports. Runtime metrics remain 12,066 lines, 1,959
  `resolveImport` lines / 7 cases, 897 owned-adapter lines and 1,194 explicit
  capability lines.
- Compiler-boundary inventory remains
  `inventory-valid-architecture-incomplete` with `errors: []`. Dead-export
  preservation remains 6/6 full and 6/6 cut witnesses; the same two nonliteral
  dynamic imports keep strict closure open and retirement uncertified.

**Next handoff.** Continue with another bounded object-model group, preferably
`closed-method-dispatch.ts` (29) plus `object-runtime.ts` (25), before entering
the larger expression-call cluster. Keep semantic/storage choices on
`wasmGcBackend`; use `jsValueBoundary` only for values that actually cross the
JavaScript boundary and `hostFreeEnvironment` only for platform availability.

### S7-c closed-method/object-runtime handoff (2026-10-19, Codex)

This eighth bounded S7-c checkpoint completes the planned closed-method and
object-runtime group on `codex/6979-s7c-ir-arms`. S7 remains `in-progress`;
this is another reviewed checkpoint in the existing draft PR, not a claim that
the full migration is complete.

**Ratchet.** The reviewed reduction is banked:

| Measure | Object/property checkpoint | Closed-method/runtime checkpoint |
| --- | ---: | ---: |
| Raw `ctx.standalone` hits in `src/` | 1,230 | **1,173** |
| Matching source files | 407 | **404** |
| `closed-method-dispatch.ts` | 29 | **0** |
| `object-runtime.ts` | 25 | **0** |
| `hof-native.ts` dependency closure | 3 | **0** |

**Classification.** All 57 sites selected native WasmGC language semantics,
carrier storage or finalize-time widening. Closed method dispatch now uses one
backend fact for native array methods, HOFs, iterators, collections, RegExp,
DataView and nullish-receiver errors. The object runtime uses the same fact for
the native MOP, prototype and descriptor machinery, string exotics, function
metadata, dynamic enumeration, vector indexing and closure application. The
linear backend keeps its provider-owned behavior.

The `hof-native.ts` closure was required rather than cosmetic. Once WASI could
reach the native array-HOF dispatcher, the helper reservation and TypedArray
finalize pass still rejected every non-literal-standalone target. Both now use
`wasmGcBackend`, matching the native object-runtime dependencies they consume.

This does not copy objects and does not remove host interop. Internal WasmGC
objects continue to use their native carrier and MOP. A caller-owned JavaScript
object or function that actually crosses the value boundary can still use the
existing host-backed facade and preserve identity. The earlier normalization
was therefore safe: it already made default `gc` native, while this checkpoint
removes the accidental WASI exclusion without selecting JavaScript machinery
as a second semantic implementation.

**Focused evidence.** `issue-6979-array-object-mode-collapse.test.ts` passes
9/9. Its new probes cover an `any`-typed array HOF and boxed-String indexed read
under both standalone and WASI. An exact detached control at pre-checkpoint
commit `a82bfa424f` passes the seven prior/standalone assertions but fails
exactly those two WASI assertions: the HOF throws and the string exotic returns
the wrong value. The candidate passes both.

The wider dispatcher/runtime cohort passes 122 assertions across 11 files with
one intentional skip. It covers array search/mutation/HOF/producer methods,
Map/Set dispatch, RegExp, prototype-sensitive filter, TypedArray iteration and
residue, function-carrier fast reads, and string-exotic behavior.

**Architecture validation.** TypeScript 7 typecheck, Biome lint, Prettier,
standalone-arm, host-import policy, IR-fallback, import-cycle, flat-directory,
LOC, function, coercion, oracle and verdict-oracle gates pass. Host-import
policy remains 33 probes / 452 imports / zero `regime-gap` or `unknown`
imports, with runtime metrics at 12,066 lines, 1,959 `resolveImport` lines / 7
cases, 897 owned-adapter lines and 1,194 explicit-capability lines.

Equivalence remains 20 failing, 2,008 passing and 22 known failures; two
baseline failures pass and there are **no new regressions**. Compiler-boundary
inventory remains `inventory-valid-architecture-incomplete` with `errors: []`.
Dead-export preservation remains 6/6 full and 6/6 cut witnesses; the same two
nonliteral dynamic imports keep strict closure open and retirement uncertified.

**Next handoff.** Continue with the bounded class/literal group:
`class-bodies.ts` (21) plus `literals.ts` (20), before taking the 61-site
`index.ts` orchestrator or the larger expression-call cluster. Keep native
WasmGC semantic/storage choices on `wasmGcBackend`; retain JavaScript machinery
only for explicit value-boundary identities, platform capabilities and named
accelerators.

### S7-c literal/coercion handoff (2026-10-19, Codex)

This ninth bounded S7-c checkpoint migrates the literal/coercion carrier group
on `codex/6979-s7c-ir-arms`. S7 remains `in-progress`; this is a reviewed
checkpoint in the existing draft PR, not completion of the full migration.

**Ratchet.** The reviewed reduction is banked in
`plan/audit/standalone-arms-baseline.json`:

| Measure | Closed-method/runtime checkpoint | Literal/coercion checkpoint |
| --- | ---: | ---: |
| Raw `ctx.standalone` hits in `src/` | 1,173 | **1,152** |
| Matching source files | 404 | **404** |
| `literals.ts` | 20 | **1** |

The closure also moves the type-level ToPrimitive/open-carrier decision in
`index.ts` and the struct-accessor closure setter dispatch in
`expressions/assignment.ts` onto `wasmGcBackend`. The latter adds two formatted
lines to an already over-budget legacy function, so this issue explicitly
allows that measured `compilePropertyAssignment` growth; no function-budget
baseline is changed.

**Classification.** Object-literal native prototype setup, overridden builtin
prototype descriptors, `@@unscopables`, computed arithmetic carriers,
`Symbol.toPrimitive`, callable-bearing literals, pure string-index objects,
expected structs, accessor closure globals, generator methods, Map spread and
`any[]` object-element widening are WasmGC backend decisions. Linear keeps its
provider-owned paths. The JavaScript value boundary is unchanged: a caller-owned
host object that actually crosses it keeps the existing host-backed object and
identity, without copying it into a second representation. JS machinery stays
available for that explicit boundary, platform capabilities and named
accelerators, not as the internal object semantic core.

The earlier mode normalization remains safe. It classified default `gc` and
literal `standalone` as the same WasmGC semantic regime; replacing the legacy
projection with `wasmGcBackend` makes that existing equivalence explicit and
adds WASI where the implementation is backend-owned. No environment or
boundary distinction is erased.

**Focused and A/B evidence.**
`issue-6979-array-object-mode-collapse.test.ts` passes 11/11. Its new probe
builds an open literal with `Symbol.toPrimitive` plus an ordinary field, aliases
it, and verifies both coercion and field access under standalone and WASI. The
wider ten-file literal/coercion cohort is 172 passing, 15 failing and eight
skipped assertions. An exact detached control at pre-checkpoint commit
`d980a8e805` reproduces all 15 failures unchanged in the three failing files
(35 passing, 15 failing and eight skipped), so the checkpoint adds no
cohort-specific regression.

**Measured prototype dependency.** Dynamic-prototype literal promotion is the
one intentional `ctx.standalone` site left in `literals.ts`. Widening that site
and its `index.ts` slot/global lockstep correctly marks both objects, constructs
both as native `$Object` values, and makes
`Object.getPrototypeOf(object) === proto` true under WASI. The inherited read
still returns zero because the promoted prototype's first named property is not
seeded during WASI module initialization:

```ts
var proto = { inherited: 41 };
var object = { own: 1 };
Object.setPrototypeOf(object, proto);
export function readResult() {
  return (object as any).inherited + object.own;
}
```

The widened candidate returns `1`, not `42`; `(proto as any).inherited` is
null until the same property is assigned after initialization. Generated WAT
shows module initialization calling `__new_plain_object` followed by
`__extern_set` (and a checked `__defineProperty_value` variant) with the
initialized constant box. The later assignment succeeds. This isolates the
next dependency to WASI module-init named-property seeding, not prototype
linking or lookup.

**Architecture validation.** TypeScript 7 typecheck, Biome lint, Prettier,
standalone-arm, host-import policy (33 probes / 452 imports / zero `regime-gap`
or `unknown` imports), IR-fallback, import-cycle, flat-directory, LOC,
coercion, oracle and verdict-oracle gates pass. Compiler-boundary inventory
remains `inventory-valid-architecture-incomplete` with `errors: []`.
Dead-export preservation remains 6/6 full and 6/6 cut witnesses; the same two
nonliteral dynamic imports keep strict closure open and retirement uncertified.

**Next handoff.** Fix or explicitly model WASI module-initialization seeding for
the first named property of a promoted open literal. Then migrate the final
`literals.ts` dynamic-prototype gate together with its `index.ts` slot/global
lockstep and restore the prototype regression above. After that, take
`class-bodies.ts` (21) as the next bounded group rather than folding it into the
61-site `index.ts` orchestrator.

### S7-c promoted-literal seeding follow-up (2026-10-19, Codex)

This follow-up closes the measured WASI dependency above and lands the final
`literals.ts` mode arm. S7 remains `in-progress`; this is another bounded
checkpoint in the existing draft PR, not completion of the full JS-host
migration.

**Root cause and fix.** The promoted prototype was linked correctly. Its first
named field disappeared because `compileObjectLiteralAsExternref` captured the
`__extern_set` function index before compiling the property value. Value
compilation can register a late function and shift every defined function
index, so module initialization called a stale neighbouring function instead
of the setter. The data-property and method-shorthand stores now re-resolve
`__extern_set` after emitting their value or closure, matching the existing
late-index discipline in the adjacent `__proto__` arm. No object is copied and
no new JS-host path is introduced.

With seeding repaired, dynamic-prototype promotion and its var, let/const and
module-global storage decisions now use `wasmGcBackend` in `literals.ts`,
`index.ts` and `declarations.ts`. This keeps Wasm-owned literals on the native
`$Object` prototype carrier for standalone, WASI and default gc. An object that
actually crosses the JavaScript value boundary still reuses the admitted
host-backed object and its identity.

**Ratchet.** The standalone-arm baseline is banked from 1,152 to **1,148** raw
`ctx.standalone` hits in `src/`, and from 404 to **403** matching source files.
`literals.ts` drops from one legacy projection to **zero**.

**Runtime evidence.** `issue-6979-array-object-mode-collapse.test.ts` passes
15/15. Its two new probes cover both named data-property seeding and
method-shorthand seeding before prototype linkage under standalone and WASI;
each preserves prototype identity and returns the inherited value plus an own
field (`42`). The wider eight-file prototype/open-object cohort is 127 passing
and three failing. An exact detached control at parent
`691ae6e9b723a409441dc7e19fe4db77cf14fc79` reproduces all three failures
unchanged. The two non-fixture failures selected from
`issue-4504-inherited-set.test.ts` also reproduce exactly at that parent; the
remaining rows in that local file are limited by this worktree's absent
test262 fixture and are not claimed as passing evidence.

**Architecture validation.** TypeScript 7 typecheck, Biome lint, Prettier,
standalone-arm, host-import policy (33 probes / 452 imports / zero
`regime-gap` or `unknown` imports), IR-fallback, import-cycle, flat-directory,
LOC, function, coercion, oracle and verdict-oracle gates pass. Compiler-boundary
inventory remains `inventory-valid-architecture-incomplete` with `errors: []`.
Dead-export preservation remains 6/6 full and 6/6 cut witnesses; the same two
nonliteral dynamic imports keep strict closure open and retirement
uncertified.

**Next handoff.** Take `class-bodies.ts` (21) as the next bounded semantic group.
Classify each remaining mode arm as native WasmGC storage/dispatch versus an
explicit value-boundary or platform-capability decision, and keep the 61-site
`index.ts` orchestrator for a later coordinated slice.

### S7-c class semantics and prototype handoff (2026-10-19, Codex)

This tenth bounded S7-c checkpoint completes the remaining mode conditions in
`class-bodies.ts` and the class/prototype dependency closure on
`codex/6979-s7c-ir-arms`, published through draft PR `#6762`. S7 remains
`in-progress`; this checkpoint does not claim the full host migration is
complete.

**Ratchet.** The reviewed reduction is banked in
`plan/audit/standalone-arms-baseline.json`:

| Measure | Promoted-literal checkpoint | Class/prototype checkpoint |
| --- | ---: | ---: |
| Raw `ctx.standalone` hits in `src/` | 1,148 | **1,109** |
| Matching source files | 403 | **400** |
| `src/codegen` | 779 | **740** |
| Exact `ctx.standalone` conditions in `class-bodies.ts` | 21 | **0** |

The closure updates `class-proto-object.ts`, `class-static-sidecar.ts`,
`class-proto-lookup.ts`, `standalone-class-dyn-static.ts`,
`class-static-descriptor.ts`, `standalone-class-instance-proto.ts`,
`standalone-class-dyn-member.ts`, `standalone-subclass-method-install.ts` and
`dynamic-proto.ts`. Remaining raw text in that area is either compatibility
state whose field name still contains `standalone` or historical comments; it
is not a surviving semantic-mode condition.

**Classification.** Native builtin-subclass construction, Map/Set iterable
carriers, Error subclass branding, dynamic heritage, runtime-keyed class
members, static sidecars, generator methods, dynamic prototype slots and
native fnctor parent calls are WasmGC backend decisions. The linear backend
keeps its provider-owned behavior. The retired class-object registry,
`__tag_user_class`, `__register_fnctor_instance`, dynamic-parent bridge and
fnctor bridge are now explicitly confined to the non-WasmGC provider rather
than being selected by the surrounding environment.

This preserves the object-boundary design. Wasm-owned class objects and
instances use native WasmGC storage and prototype machinery. A value that
actually crosses into JavaScript can still use the existing identity-cached
host-backed facade; this checkpoint neither copies it nor installs the host
object model as an internal semantic mirror. The earlier normalization was
therefore safe: default `gc` already projected the native semantic regime,
while `jsValueBoundary` remains the independent decision for marshaling and
host identity.

**Dynamic-prototype residual.** Prototype storage and linkage are working in
WASI: `Object.getPrototypeOf(instance) === proto`, and `Object.keys(proto)`
sees the donor field. A minimal generic inherited named read can nevertheless
miss that field unless the same donor key is also demanded directly. The
regression test makes that demand explicit before reading through the
instance, so it verifies this checkpoint's class/prototype path without
claiming the demand-sensitive reader bug is fixed. The follow-up belongs in
the generic named-property reader/metadata cluster; it must not be addressed
by reviving a JS-host semantic object.

**Validation.** `issue-6979-array-object-mode-collapse.test.ts` passes 19/19
across standalone and WASI. The wider 19-file class/prototype cohort is 197
passing, five failing and 19 skipped after updating the obsolete #2917 default
GC control to require the native Array constructor (no `env::__new_Array`). An
exact detached A/B at parent `4642efb50c` reproduces all five remaining
failures with identical values: one #5195 unprovable-heritage failure and four
#5204 host-class-bridge assertions. TypeScript typecheck and the standalone-arm
ratchet pass.

**Next handoff.** Keep the donor-read residual explicit, then take another
bounded reviewed group rather than folding the 61-site `index.ts` orchestrator
into unrelated changes. Continue to classify storage/semantics with
`wasmGcBackend`, actual JS crossings with `jsValueBoundary`, platform access
with `hostFreeEnvironment`, and accelerators by family.

### S7-c native iterator/generator handoff (2026-10-19, Codex)

This eleventh bounded S7-c checkpoint migrates the iterator and synchronous
generator semantic cluster on `codex/6979-s7c-ir-arms`, published through
draft PR `#6762`. S7 remains `in-progress`; this checkpoint does not claim the
full JS-host migration is complete.

**Ratchet.** The reviewed reduction is banked in
`plan/audit/standalone-arms-baseline.json`:

| Measure | Class/prototype checkpoint | Iterator/generator checkpoint |
| --- | ---: | ---: |
| Raw `ctx.standalone` hits in `src/` | 1,109 | **1,065** |
| Matching source files | 400 | **396** |
| `src/codegen` | 740 | **699** |
| `src/codegen/expressions` | 361 | **358** |
| Exact `ctx.standalone` conditions in the four iterator/generator files | 41 | **0** |

The four-file semantic group is `iterator-native.ts`,
`generators-native.ts`, `generators-native-consumer.ts` and
`generators-native-protocol.ts`. Three nested object-literal `super` gates in
`expressions/new-super.ts` form the required dependency closure.

**Classification.** Native iterator records, generator frames, protocol-result
ABI and objects, strict spread/materialization, delegation, completion
exception handling, dynamic generator methods and factory prototype setup are
WasmGC backend decisions. The linear backend retains the legacy provider's
eager and result-accessor paths. `noJsHostTarget`, which returned
`ctx.standalone || ctx.wasi`, was therefore a misleading environment name for
a backend decision and has been removed; its consumers now ask
`wasmGcBackend` directly.

This does not move JavaScript machinery back into the semantic core. Wasm-owned
iterators and generators stay in native storage. Values that actually cross a
JavaScript boundary still use the existing boundary machinery, including its
identity-cached host-backed facades where applicable; no object is copied and
no host semantic mirror is created. The earlier normalization remains safe:
default `gc`, literal standalone and WASI select the same native WasmGC
semantics here, while `jsValueBoundary` independently controls marshaling and
host identity.

**Dependency closure.** Widening only the generator gates exposed a real WASI
gap: an object-literal generator containing `yield super.answer()` returned
`2` instead of `42`. The generator was native, but its nested `super` call and
property readers were still guarded by the old standalone projection. Moving
those three readers to `wasmGcBackend` restores the unseeded case directly;
the test does not manufacture a donor read to make metadata appear. The same
focused fixture also proves that a runtime-keyed class generator method uses
the native protocol under both standalone and WASI.

**Validation.** `issue-6979-array-object-mode-collapse.test.ts` passes 23/23.
The wider 16-file iterator/generator cohort is 191 passing, six failing and 13
skipped. An exact detached A/B at parent `d1cd6e36a4` reproduces all six
failures with the same values in the four failing files: two #4768 conservative
eager-path expectations, one #5199 legacy import expectation, two #5199
prototype assertions and the deliberately pinned-wrong #6651 invalid-Wasm
expectation. The four-file control is 42 passing and six failing, exactly
matching the candidate rows, so this checkpoint adds no cohort-specific
regression. TypeScript 7 typecheck, Biome lint, Prettier and `git diff --check`
pass, and the standalone-arm ratchet is banked.

**Next handoff.** Continue with another bounded semantic group. Preserve the
same split: `wasmGcBackend` for internal storage and language semantics,
`jsValueBoundary` for real JS crossings, `hostFreeEnvironment` for platform
capabilities, and explicit family checks for optional accelerators. Do not
fold the remaining `index.ts` orchestrator conditions into an unrelated slice.

### S7-c builtin-static call handoff (2026-10-19, Codex)

This twelfth bounded S7-c checkpoint migrates the 40 remaining raw mode
decisions in `src/codegen/expressions/call-builtin-static.ts` on
`codex/6979-s7c-ir-arms`, published through draft PR `#6762`. S7 remains
`in-progress`; this checkpoint does not claim the full JS-host migration is
complete.

**Ratchet.** The standalone-arm baseline is banked from 1,065 to **1,025** raw
`ctx.standalone` hits in `src/`, from 396 to **395** matching source files, and
from 358 to **318** hits in `src/codegen/expressions`.
`call-builtin-static.ts` drops from 40 legacy projections to **zero**.

**Classification.** BigInt narrowing, `RegExp.escape`, native Array factories,
proxy-aware Array branding, object integrity, prototype singletons and dynamic
prototype slots, `Object.create` descriptor application,
`Object.getOwnPropertyDescriptor` key canonicalization,
`Object.fromEntries`, and native `Map`/`Object.groupBy` dispatch are WasmGC
backend decisions. In particular, `Map.groupBy` no longer treats
`nativeStrings` as a proxy for the object backend. Optional accelerators remain
explicit family checks rather than recovering a composite host mode.

The script-top-level `globalThis` descriptor fold is the one genuine JavaScript
realm decision in this group and now asks `jsValueBoundary` directly. This
preserves the existing host-backed object only at the crossing, with its
identity intact. Wasm-owned objects remain native WasmGC objects internally;
no object is copied and the JavaScript host is not used as a semantic mirror.
The earlier mode normalization is therefore harmless here: it unified native
backend semantics without changing whether a value crosses the host boundary.

**Runtime evidence.** `issue-6979-array-object-mode-collapse.test.ts` passes
31/31 across standalone and WASI. Four new probes cover `Object.create`
descriptor bags, numeric-key `Object.getOwnPropertyDescriptor`, native
array-of-pairs `Object.fromEntries`, and `Array.from` over a native `Map`
iterator. The wider 24-file builtin-static cohort is 169 passing, 13 failing
and five skipped.

An exact seven-file detached A/B at parent `7e27e85a1060b5ec1759ffe47c8f205266ded97b`
is 73 passing / 14 failing at the parent and 74 passing / 13 failing at the
candidate. The same 13 failures reproduce on both revisions; the candidate
additionally passes the new WASI `Array.from(Map)` probe, which the parent
cannot compile because it still requests the retired `env::__array_from`
provider. A temporary kill switch that restored the old backend-shaped
predicate for the script-global boundary reproduced the existing #3366 sloppy
global-assignment failure unchanged, so the explicit `jsValueBoundary`
classification adds no regression there.

**Residuals kept explicit.** A numeric `any` backed by an i31 value can still
surface as JavaScript `null` when exported from WASI, and the WASI native `Map`
constructor can lose numeric values while preserving string values. The new
tests compare native numeric values before export and use a string Map value so
this checkpoint measures the dispatcher behavior it owns. Both residuals are
follow-up boundary/container defects; neither should be addressed by reviving
JS-host semantics inside the compiler.

**Validation.** TypeScript 7 typecheck, Biome lint, Prettier,
`git diff --check`, and the banked standalone-arm gate pass. The focused and
parent-control runtime evidence above establishes a strict improvement with no
candidate-only failure in the compared cohort.

**Next handoff.** Continue with another bounded call-dispatch group. Keep
semantic and storage decisions on `wasmGcBackend`, true JavaScript crossings on
`jsValueBoundary`, platform access on `hostFreeEnvironment`, and named
accelerators explicit. Preserve the two residuals above as independent work
rather than routing native objects through the JS host.

### S7-c identifier, closure, and tail-call handoff (2026-10-19, Codex)

This thirteenth bounded S7-c checkpoint migrates the remaining 35 raw mode
decisions in `call-tail-dispatch.ts`, `calls-closures.ts`, and
`call-identifier.ts` on `codex/6979-s7c-ir-arms`, published through draft PR
`#6762`. S7 remains `in-progress`; this checkpoint does not claim the full
JS-host migration is complete.

**Ratchet.** The standalone-arm baseline is banked from 1,025 to **990** raw
`ctx.standalone` hits in `src/`, from 395 to **392** matching source files, and
from 318 to **283** hits in `src/codegen/expressions`. All three migrated files
now contain **zero** raw `ctx.standalone` conditions.

**Classification.** Compiled iterator methods, native iterator carriers,
generator self iteration, open-object method dispatch, proxy calls, Boolean
truthiness, runtime function aliases, builtin-static aliases, dynamic spread,
native closure application, approved function-constructor prototype methods,
native RegExp and collection calls, and TypedArray intrinsic-prototype dispatch
are WasmGC backend decisions. Default `gc`, literal standalone, and WASI
therefore share those native semantics; the linear provider retains its own
implementation.

Callable reference adaptation, rest-shaped wrapper discovery, omitted-slot
restoration, shadowed top-level function slots, and linked-realm structural
calls are different: they exist because a value can actually cross into
JavaScript, so they now ask `jsValueBoundary` directly. This keeps the current
identity-cached JS-host-backed object or callable at the boundary only. It does
not copy the object, and it does not make JavaScript machinery an internal
semantic mirror. Dropping host semantics therefore does not drop host interop;
it makes the crossing explicit and leaves Wasm-owned values native until that
crossing occurs.

The legacy `__call_dyn_N` family is the important negative case. Although it
looks like boundary machinery, it owns retired dynamic-call semantics and is
not an admitted S7 adapter. Its fallback remains excluded whenever
`wasmGcBackend` is active, even if the target also has a JavaScript value
boundary. An intermediate boundary-only gate activated that provider for two
WasmGC rows; restoring the backend exclusion removed both candidate-only
failures without removing real callable interop.

**Validation.** `issue-6979-array-object-mode-collapse.test.ts` remains 31/31.
The four-file iterator/tail cohort is 43/44; its only failure is the parent
#5199 assertion that still requires the retired `__create_generator` import.
The closure-call cohort is 100/108, with all eight failures reproduced exactly
at parent `dc3e1a6843`: seven #5334 rest-bridge result gaps and one #4771 bound
`instanceof` gap.

Before the final `__call_dyn_N` exclusion, an exact 148-row detached A/B was
136/12 at the parent and 135/13 at the candidate: the candidate already fixed
the parent-failing NodeArray union-callback row, but had activated two rejected
legacy-driver rows. After the correction, a focused 37-row rerun has the same
seven #4527 residuals as the parent and all four deferred callable-property
rows pass, including that parent-failing row. A later 12-file mixed-call check
is 60 passing, 19 failing, and 13 skipped; every remaining failure has an
identical parent witness, including the separately checked #3791 WASI RegExp
control. TypeScript 7 typecheck, Biome lint, Prettier, `git diff --check`, and
the banked standalone-arm gate pass.

**Next handoff.** Continue with a bounded semantic cluster rather than treating
every host-looking helper as a boundary. Use `wasmGcBackend` for internal
language semantics and storage, `jsValueBoundary` only for genuine JS value
crossings, `hostFreeEnvironment` for platform availability, and explicit
capability gates where a WasmGC target does not enable a native accelerator.
