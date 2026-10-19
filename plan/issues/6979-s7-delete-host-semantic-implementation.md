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

### S7-c shared value-coercion handoff (2026-10-19, Codex)

This fourteenth bounded checkpoint migrates `type-coercion.ts`,
`symbol-field-carrier.ts`, `dyn-ops.ts`, `dispatch-extern-arg-bridge.ts`,
`dispatch-vec-result-bridge.ts`, `callable-result-unbox.ts`, and
`internal-call-argument.ts` on `codex/6979-s7c-ir-arms` / draft PR `#6762`.
The 20 raw `ctx.standalone` references in this group (16 decisions and four
historical comments) fall to zero. The banked source inventory falls from
990 to **970**, `src/codegen` from 699 to **686**, and expressions from 283 to
**276**. S7 remains `in-progress`.

**Classification.** Native indexed array readers, symbol carriers, AnyValue
boxing, string-payload recovery, ToPrimitive/ToNumber, native object
reification, and internal callable argument/result conversions are WasmGC
backend decisions. An internal `externref` formal is an open native value
slot; it does not by itself require a JavaScript object or array mirror.

The IR dynamic-method helper is different: when there is a real JS value
boundary, its receiver can be a JS-owned object and must retain that exact
identity for the boundary adapter. This check now asks `jsValueBoundary`.
Host-free builds continue using the native AnyValue classifier. The existing
JavaScript-environment array materialization policy is retained through
`hostFreeEnvironment`, independently of whether the JS bridge is enabled:
these callers may supply a typed native vector rather than an already
indexable ObjVec. This materializer converts between native array layouts; it
does not create a JS semantic mirror.

**Runtime improvement.** WASI previously skipped the native ToPrimitive step
when converting an open object to a number. Subtracting one from
`{ valueOf() { return 42; } }` consequently returned `NaN`. The shared WasmGC
path returns **41**, with zero imports. A single-gate kill switch that restores
the old projection reproduces `NaN` under WASI while standalone still passes,
so the improvement is attributed to this conversion gate.

**Controlled validation.** Before edits, the existing 17-file mixed coercion
cohort at parent `ad0f0396529501f49962506aeca812207bd8e180` was 209 passing,
15 failing, and three skipped. With the same two new numeric probes applied
to both revisions, the exact detached parent is **210 passing / 16 failing /
three skipped**, and the candidate is **211 passing / 15 failing / three
skipped** (229 rows each). The only status change is the WASI valueOf probe.
The 14 available residual failure messages match after normalizing worktree
paths. The Acorn private-name exception row has no serialized error text on
either side; only its failing status is compared, not its exception payload.
This is a mixed standalone/WASI/JavaScript/IR regression comparison, not a
Test262 conformance population or proof of complete IR admission.

The final focused check is **39/39**: 33 S7 array/object tests and six
JavaScript-boundary tests. Its new IR-specific boundary probe explicitly
requires both zero- and one-argument functions in `irCompiledFuncs`, checks
that JavaScript `this` is the original object, and verifies exactly two calls.
TypeScript 7 typecheck, Biome lint, Prettier, LOC/function, coercion-site,
oracle, and standalone-arm gates pass. Host-import policy passes **33 probes /
452 imports / zero regime-gap or unknown imports**, including selected RegExp,
Date, and Intl controls. The IR-fallback gate has no unintended, post-claim,
or module-level increases. Dead-export preservation remains 6/6 full and cut
witnesses; its strict retirement proof is still open at the two previously
recorded nonliteral dynamic imports.

**Residuals and next work.** The compared residuals are one Number([]) stale
expectation, seven symbol-array behavior/import assertions, one IR admission
assertion, two IR dynamic-member cases, three typed-array/undefined/BigInt
boundary cases, and one undefined callable-result assertion. Keep these
visible rather than presenting the cohort as green. Continue with the
remaining receiver/namespace call and constructor semantic groups, preserving
the same explicit backend, value-boundary, environment, and accelerator facts.
The next large expression owners are `call-receiver-method.ts` (46 raw
references) and `calls.ts` (42); review their native-runtime dependencies
before widening WASI admission. The full S7 acceptance checklist above stays
open, including runtime retirement and program-wide conformance evidence.

### S7-c receiver-method dispatch handoff (2026-10-19, Codex)

This fifteenth bounded checkpoint migrates the receiver-method dispatcher and
its native dependency closure: `call-receiver-method.ts`,
`standalone-primitive-tail.ts`, `valueof-fallback.ts`, `ta-hof-map-filter.ts`,
`regexp-exec-carrier.ts`, `wrapper-valueof.ts`, `boxed-proto-valueof.ts`,
`wrapper-proto-dynamic-demand.ts`, and `native-proto.ts`. It continues on
`codex/6979-s7c-ir-arms` / draft PR `#6762`; S7 remains `in-progress`.

**Ratchet.** The reviewed reduction is **970 → 913** raw source references,
**385 → 377** matching files, **686 → 679** in `src/codegen`, and **276 → 226**
in expressions. The dispatcher falls from 46 references to two: both remaining
hits are writes to the existing `standaloneNativeFinallyNodes` metadata field,
not mode decisions. All mode decisions in this nine-file group are migrated,
including five indirect checks through the old `noJsHost` composite helper.

**Classification and dependencies.** Native fnctor dispatch, closed/open
method calls, wrappers and overrides, internal array argument carriers,
TypedArray callback methods, dynamic spread, and prototype companion seeding
are WasmGC backend decisions. The old claim that WASI lacks native indexed
argument readers is obsolete: the object runtime now reads the same ObjVec
and native-vector carriers that the dispatcher writes. Packed map/filter must
move with its helper gate; changing only the caller leaves WASI on a missing
helper. Wrapper calls similarly need their native valueOf bodies, dynamic
member demand, and prototype companion registration together.

RegExp is a provider-capability decision. The call site and exec carrier now
ask `usesNativeRegExpProvider`, so a WasmGC target without an enabled engine
does not accidentally mint engine-only helpers. The dynamic-class method-name
set remains restricted to the non-WasmGC provider, matching its authoritative
reader in `closed-method-dispatch.ts`; it is legacy provider bookkeeping, not
the JavaScript value-boundary adapter. JS-owned receivers still reach the
existing admitted-object boundary arm of the native MOP with their identity
intact. Wasm-owned objects and callback arguments stay native internally.

**Runtime evidence.** The final focused run is **49/49**: 43 S7 array/object
tests across standalone/WASI and six JavaScript-boundary tests. New probes
exercise typed String-wrapper `charAt`, Boolean-wrapper `toString`, packed
TypedArray `map`, scalar `some`/`findIndex`, and a fixed argument followed by a
dynamic spread into an open method. Every native probe instantiates with an
empty import object.

With the same first eight new cases applied before editing production code,
the exact 18-file parent control at
`6947e10aeaa187ff7ed0865e0706cd701035ffee` is **202 passing / 16 failing / five
skipped**; the candidate is **205 passing / 13 failing / five skipped**
(223 rows each). All 13 residual failure messages match exactly. The only
status changes are three WASI fixes: the String-wrapper method changes from an
illegal cast to the correct answer; packed TypedArray mapping changes from an
exception to 42; mixed method spread changes from `NaN` to 42. The two scalar
TypedArray cases were added afterward and are covered by the 49/49 focused
run, not counted in that 223-row comparison.

**Residuals kept explicit.** The 13 compared failures are one dynamic-view
regrow case, five array/object expando-method cases, five harness-flip utility
expectations from `issue-3668.test.ts`, and two direct-call devirtualization
expectations. This cohort is not green and is not a Test262 population. Its
utility assertions are reported as measured rather than silently excluded
from the denominator.

**Validation and next work.** TypeScript 7 typecheck, Biome lint, Prettier,
LOC/function, coercion-site, oracle, and standalone-arm gates pass. The
host-import policy remains **33 probes / 452 imports / zero regime-gap or
unknown imports**, with RegExp, Date, and Intl accelerator controls present.
The IR-fallback gate has no unintended/post-claim/module-level growth.
Dead-export preservation remains 6/6 full and cut witnesses, while strict
retirement is still uncertified at the two recorded nonliteral dynamic imports.
Continue with the 42 raw references in `calls.ts` and the remaining namespace
and constructor groups. Keep the full S7 acceptance checklist open: these
bounded native-runtime improvements do not establish program-wide conformance
or certify deletion of the remaining host provider code.

### S7-c call orchestration handoff (2026-10-19, Codex)

**Checkpoint, not S7 completion.** The sixteenth S7-c checkpoint is published
in [PR 6762](https://github.com/loopdive/js2/pull/6762), on branch
`codex/6979-s7c-ir-arms`. It remains stacked on the open policy-removal
[PR 6701](https://github.com/loopdive/js2/pull/6701) and recovered S7-b commit
`9423a71e82`; do not merge it independently or mark the full acceptance
checklist complete. Continue in the existing worktree
`worktrees/codex-6979-s7c-ir-arms` rather than the dirty shared checkout.

**Inventory and ownership.** Thirteen source modules remove **62** raw
references: **913 → 851**, **377 → 367** matching files, `src/codegen`
**679 → 668**, and expressions **226 → 175**. `calls.ts` falls from 42
references to zero. Eleven indirect `noJsHost` conditions in that dispatcher
and `calls-guards.ts` are also classified. This is existing migration custody
and shared runtime/ABI maintenance, not authorization for unrelated new
direct-AST features under the IR-only development freeze.

Native reflective calls, numeric wrappers, omitted Array.slice arguments,
dynamic invocation, Promise miss arms, runtime-eval callable carriers,
compiled-graph dynamic import, and constructor-context values follow
`wasmGcBackend`. Existing helper-demand, callable-carrier, and host-Promise
producer checks remain load-bearing: changing the backend predicate does not
prove a provider is available. The compiled-graph import route retains its
WASI exclusion: an additional missing-import probe runs the rejection handler
in standalone but leaves it unrun in WASI when that exclusion is removed.
Keep the historical WASI route until Promise settlement is independently
verified; this checkpoint does not claim WASI dynamic import support.
Actual declared JS-owned `.call`/`.apply`
fallback follows `jsValueBoundary`, preserving the original function and
receiver rather than copying them. In contrast, the old foreign-provider
argument-list selection and host undefined-padding preparation remain
restricted to the non-WasmGC provider; they are not value adapters.

**Reader/caller ABI closure.** Migrating the reflective Boolean caller alone
leaves WASI trapping with an illegal cast. The native builtin prototype-member
value reader and wrapper/Function prototype closure bodies must move with it.
With the complete candidate, restoring only the old value-reader gate makes
the standalone reflective Boolean probe pass and the WASI twin trap again.
That single-gate control identifies a carrier mismatch, not an absence of
native Boolean support.

**Measured execution.** The focused run is **56/56**: 49 native S7 tests across
standalone/WASI, plus seven JavaScript-boundary tests. New native probes cover
Number-wrapper formatting, reflective Boolean valueOf, and borrowed Array.slice
with an omitted end. Native probes instantiate with an empty import object.
The boundary probe calls and applies an actual JS function, checks exact `this`
identity and returned values, and verifies exactly two invocations.

The exact 18-file comparison uses the same **259 rows** and seven added tests
on published parent `900aa30de1f90cc146c30c39f34bea66b53717fb` and this
candidate: **241 passing / 14 failing / four skipped → 243 passing / 12 failing /
four skipped**. Only the two WASI Number-formatting and Boolean-reflection rows
change status. All 12 residual failure messages match exactly. The residuals
are one JSON replacer defect, three retired-host-import expectations, three
legacy WAT exception-shape expectations, and five Redux integration cases.
These are default-path scoped Vitest measurements, not explicitly selected IR
Test262 results or proof of program-wide equivalence. Ignored local reports
are `.tmp/s7c-calls-parent.json` and `.tmp/s7c-calls-candidate.json`.

**Validation.** TypeScript typecheck, Biome, Prettier, LOC/function, coercion,
oracle, and standalone-arm gates pass. Host-import policy remains **33 probes /
452 imports / zero regime-gap or unknown imports**, with RegExp/Date/Intl
accelerator controls. IR fallback has no unintended/post-claim/module-level
growth. Dead-export preservation passes 6/6 full and cut witnesses, but strict
retirement remains uncertified because `getBinaryenModule` and
`resolvePlatformCapabilityImport` contain unresolved nonliteral dynamic imports.

**Next work and boundaries.** Review the remaining constructor, namespace, and
builtin value-reader groups as dependency closures. `new-super.ts` still has
14 raw references and indirect aliases; `builtin-value-read.ts` is only
partially migrated. `expressions.ts` retains the existing
`standaloneNativeFinallyNodes` metadata spelling, not a mode decision.
`promise-finally-invoke.ts` retains its helper availability exclusions for a
later review. Keep S7 runtime retirement, compatibility, accelerator, and
conformance acceptance open. Do not infer that 851 lexical hits are 851 semantic
branches, or that these bounded improvements certify deletion of host code.

### S7-c constructor/value-reader handoff (2026-10-19, Codex)

**Seventeenth checkpoint; full S7 remains open.** Continue on
`codex/6979-s7c-ir-arms`, [PR 6762](https://github.com/loopdive/js2/pull/6762),
stacked on the recorded policy-removal predecessor and S7-b recovery. Parent
for this checkpoint is `c2475742eb5d39ab2c59a5291db54afc1f166ea5`.
Seven source modules remove **33** raw references: **851 → 818**, **367 → 362**
matching files, `src/codegen` **668 → 653**, expressions **175 → 157**.
`new-super.ts` has no remaining raw or `noJsHost(ctx)` references.
`builtin-value-read.ts` retains only four lexical references on three lines
to the existing refusal set, not mode decisions. The dispatcher and builtin
reader also replace 22 and two indirect `noJsHost(ctx)` checks respectively.

**Classifications.** Native construction, static spread, proxy/closure
construction, TypedArray carriers, class values, Promise result typing,
constructor-context receivers, and native iterator-close exception transfer
follow the WasmGC backend. Builtin method metadata and symbol-member values,
Array.isArray, and ArrayBuffer.isView use the native runtime. Legacy fnctor
registration, host-class naming stamps, host return-ABI annotations, and
foreign-provider no-match bases remain non-WasmGC provider bookkeeping.
They must not be re-enabled merely because a JavaScript value adapter exists.
Actual JS-owned values continue through the native runtime's admitted-object
and callable boundary arms; no new host import or copying adapter is added.
Runtime-eval construction retains source-demand and helper-availability
checks; a backend predicate alone is not proof of a linked provider.

**Constructor ABI dependency closure.** WASI omitted the hidden
`__constructor_identity` argument from the signature, parameter definitions,
call-site operands, and cached user-parameter slicing. All four now agree
that WasmGC constructors carry it. Preserve the pre-existing convention for
the non-WasmGC provider. Native fnctor instance fields, initializer operands,
prototype-start reservation, prototype reads/writes, and construction-time
snapshots move together. Source fields and presence bits retain their indices:
the compiler-owned fields append after them. The alternate layout initializer
also recognizes the native identity field; its separate allocation-policy
gates remain for the next layout/representation review.

Readers of that hidden value include both instance identity initialization
and the function-expression twin's transitive capture spill. The latter must
not be enabled without the parameter it reads. With the complete candidate,
restoring only its old standalone gate makes the standalone capture probe
pass and its WASI twin return `NaN` instead of 42. Restoring the backend gate
returns both to 42. This is a one-gate attribution control, not an inference
from the overall passing count.

**Runtime and binary evidence.** Twelve new native tests pass **12/12**, versus
**8/12** on the parent. The four WASI changes are iterator alias identity,
fnctor constructor identity (with a different-constructor negative control),
transitive sibling captures, and construction-time prototype snapshots.
Native method metadata and array/buffer classification retain passing
controls. Each native module instantiates with an empty import object.
The final six-file focused run is **84/84**, including the prior array/object
and JS-boundary suites and the updated layout/runtime-eval controls.

Seven compiler probes on the **valid `gc` target** produce byte-identical
binaries at parent and candidate: constructor identity, transitive captures,
prototype snapshots, builtin metadata, symbol iterator alias, Array.isArray,
and JS-owned apply. The initial probe attempt used the unsupported string
`js-host`; those results are superseded, not evidence about a valid JavaScript
environment. The clean temporary parent checkout was removed after the valid
comparison; its source remains recoverable from the parent commit. Local
records are `.tmp/s7c-constructor-gc-{parent,candidate}.jsonl`.

The unchanged-test **20-file / 272-row** comparison is **259 passing / 13
failing → 263 passing / nine failing**, no skips. Only the four new WASI rows
change status. Four available non-provider residual messages match exactly;
five remaining rows cannot execute because the required QuickJS provider
artifact is missing on both sides. Their messages match after normalizing
only the source-content cache hash; this is not proof of QuickJS behavior.
Reports: `.tmp/s7c-constructor-{parent,candidate}.json`.

**Obsolete test contracts corrected separately.** Three old assertions expected
the JS environment to disable native shape controls or omit the native eval
construct driver. Replace them with the current native-core contract, not a
compiler rollback. The two layout fixtures also used unsupported
`target: "js-host"`; they now request `gc`. The layout-emission check actually
instantiates through the generated adapter, proves ON/OFF binaries differ,
and checks six absolute runtime answers with each layout. The eval check
verifies a filled native driver and rejects a retired host construct import;
it does not claim execution of an unavailable QuickJS artifact. These are
test corrections, not three additional compiler fixes.

After those test corrections the final same-size cohort is **266 passing /
six failing / zero skipped**. The six residuals are the vec-constructor
identity assertion and the five missing-provider rows described above.
Record: `.tmp/s7c-constructor-final-cohort.json`. Do not describe this cohort
as green or count unavailable-provider rows as successful runtime execution.

**Gates and remaining work.** TypeScript, Biome, Prettier, LOC/function,
coercion, oracle, and standalone-arm checks pass. Host-import policy remains
33 probes / 452 imports / zero regime-gap or unknown imports, with the
RegExp/Date/Intl controls intact. IR fallback has no unintended/post-claim/
module-level growth. Dead-export preservation passes 6/6 full and cut source
witnesses; strict retirement remains uncertified at the two previously
recorded nonliteral dynamic imports. The four IR fnctor test files are in the
272-row comparison, but the default runtime probes are not explicitly
selected IR Test262 measurements.

Next review native fnctor layout/flow-grown field gates, namespace readers,
and the larger object-runtime dependency groups. The remaining constructor
identity test for a genuine vec's `constructor === Array` still fails on both
parent and candidate; keep it visible. Unknown runtime target spellings are
not accepted adapter targets; do not reuse `js-host` fixtures as valid `gc`
evidence. Preserve all full S7 retirement, compatibility, accelerator and
conformance acceptance requirements: this checkpoint does not satisfy them.

### S7-c native constructor lookup checkpoint and landing handoff (2026-10-19, Codex)

**Publication, not merge readiness.** The user requested the current work in
a PR with a repository-issue handoff. Publish this checkpoint on
`codex/6979-s7c-ir-arms`, PR [#6762](https://github.com/loopdive/js2/pull/6762),
above parent `62d4803e12d1d025594fce64f0496ef36a7f43e6`. Keep the PR draft:
the import-count gate below is red, the prerequisite
[Remove the host-assisted semantic policy](https://github.com/loopdive/js2/pull/6701)
is still open, and the recovered S7-b commit `9423a71e82` remains in the stack.
Do not merge this stack independently or describe S7 as complete. No GitHub
issue was created or edited.

**Implementation and ownership boundary.** Fix the retained genuine-array
`constructor === Array` failure in shared native runtime demand planning,
not by adding a special direct-AST property reader. Previously only two
reflective String helpers demanded the Array carrier. Constructor demand now
prepares Array, wrapper and ordinary-object carriers, prototype tables and
companion seeds for every WasmGC environment. Bare builtin constructor and
namespace values no longer become WASI null placeholders. A namespace
publishes its singleton identity before recursive property seeding.

The source pre-scan admits unknown computed keys and stored `Reflect.get`
values; it no longer requires an `Object` identifier to give an ordinary
object its inherited constructor. Direct `Reflect.get` calls with known
non-constructor literal keys do not force this demand. This is not a proof
that every reflective alias through a dynamic realm/global is covered;
audit those shapes before claiming general reflection completeness.

Array and wrapper lookup uses the live prototype property, not an intrinsic
selected solely from the receiver tag. Own constructor properties still
shadow inheritance, deletion restores it, and the explicit null-prototype
flag prevents an invented Object constructor. The removed
`plainCtorCarrierDemanded` field had one definition and two setup producers;
its only consumer and its `moduleMentionsObjectIdentifier` helper are removed
together. Preserve the existing JS boundary normalization: no adapter body,
copying policy or host semantic implementation was added or removed here.

**Runtime evidence, with denominators.** Node 24 requires
`--experimental-wasm-exnref` for these local runs. Temporary worker-config
and hook flag adjustments are local only and must not be committed.

- New native lookup suite: **24/24**, twelve cases each on standalone and
  WASI. Every module verifies an empty import list, instantiates with `{}`,
  and checks the runtime answer. Cases cover literal/split/map arrays,
  unknown computed keys without an Array identifier, own shadow/delete,
  live Array/Number/Object prototype replacement, wrapper metadata,
  ordinary objects without an Object identifier, explicit null prototypes,
  and stored Reflect.get.
- Focused native/boundary/existing-constructor run: **38/38**. The eight
  boundary tests retain JS-owned constructor and getter-result identities
  and the getter's original receiver, alongside typed-facade re-entry tests.
  No JS-owned object is replaced by a native copy.
- Controlled, unchanged **14-file / 182-row** comparison at parent `62d4803e12`
  versus candidate: **143 passing / 37 failing / two skipped → 160 passing /
  20 failing / two skipped**. Only the original sixteen new native cases
  and the old genuine-array constructor assertion change status. All twenty
  remaining failure messages match exactly.
- Final expanded same-file population: **191 rows / 169 passing / 20 failing /
  two skipped** after adding eight live/null/Reflect controls and one boundary
  control. Those nine additions are passing controls, not nine measured
  parent-to-candidate fixes. All twenty residual failure messages still match
  the parent. Fourteen cannot execute because Test262 source files are missing;
  the other six are one obsolete host Object_get_constructor expectation,
  two existing footprint/bridge assertions, and three existing Node namespace
  import cases. This cohort is not green and is not an IR Test262 sweep.

Local reports: `.tmp/s7c-constructor-lookup-{parent,candidate}.json`,
`.tmp/s7c-constructor-lookup-final-cohort.json`, and
`.tmp/s7c-constructor-lookup-live-controls-after.json`. The committed test
files are the portable runtime witnesses; ignored reports are local evidence.

**Binary cost, not just arm-count reduction.** Twelve compile-and-run probes
compare the exact parent with this candidate at optimize level zero and the
same filename/options. Nine no-lookup arithmetic, Fibonacci and numeric-index
programs are byte-identical across standalone, WASI and valid `gc`, and retain
answers 9, 21 and 19. The constructor probe changes its wrong answer −1 to 42
in all three targets, but grows: standalone **173,984 → 581,487 bytes**,
WASI **113,838 → 462,068**, `gc` **179,292 → 590,134**. This is substantial
transitive builtin materialization, not an overall size improvement. The
`gc` probe uses the real generated imports and instance wiring, not stubs.
Records: `.tmp/s7c-lookup-{parent,final}-bytes.jsonl` (12 rows each).

**Hard merge blocker: import ceiling unchanged.** The actual
`check:host-import-policy` fails **456 > 452**. Diagnostic compilation of all
**33/33** exact policy probes measures parent 452 versus candidate 456, with
zero `regime-gap` and zero `unknown` classifications. Four additional import
occurrences, all existing `value-adapter` names, account for the difference:

| probe | additional adapter |
| --- | --- |
| core | `__boundary_object_callable_kind` |
| core | `__unwrap_for_wasm` |
| proxy | `__unwrap_for_wasm` |
| proxyMop | `__unwrap_for_wasm` |

The unwrap requests originate in generated typed-reference closure entrypoints
for newly exposed native builtin function/prototype carriers. Attempts to
alter closure argument-demand checks did not reduce the count and were
reverted; do not delete working normalization to make the count green.
The host-import baseline remains **452**, and the standalone-arm baseline
remains **818**. The candidate source measures **804** lexical mode references
in **357 / 1,942** scanned source files, but that reduction is deliberately not
banked while the checkpoint is unready. Empty JSON files from failed policy
runs are not successful reports. The complete diagnostic records are
`.tmp/s7c-lookup-{parent,final}-imports.jsonl` (33 rows each).

**Next owner / required decision.** First obtain an explicit decision to
accept and document the four existing-adapter occurrences, or redesign
carrier materialization to stay within 452 without regressing native lookup
or boundary identity. Publishing this checkpoint is not approval to raise
the ceiling. Also review the binary growth above before marking the PR ready.
Then rerun the hard policy gate and its accelerator controls, the focused
runtime suites, the unchanged-test comparison, and footprint probes; only
after acceptance bank the raw-mode reduction. Preserve full S7 retirement,
compatibility, accelerator and conformance requirements. Dead-export
preservation has 6/6 full and cut witnesses, but strict retirement remains
uncertified at the two previously recorded nonliteral dynamic imports.

### S7-c carrier materialization deduplication handoff (2026-10-19, Codex)

**Parent and scope.** Continue above published checkpoint
`55ac4b99ef83d4210d4e89fa83fd241e1711027c`, retaining its unresolved import
ceiling and stack requirements. Each namespace read previously emitted the
complete inline own-property seed again, although every copy guarded the same
singleton global. Emit one shared native lazy getter per namespace instead.
This changes code duplication, not the complete static surface, attributes,
boundary normalization or admission policy. No properties or host adapters
are removed to make a count smaller.

**Index and re-entry ownership.** Reserve and publish the getter's stable
function handle before object-runtime/prototype preparation can recursively
request it. Attach its initialization body to the registered function before
seeding methods, so late-import repair can see nested initialization code.
Keep the caller's possibly detached body registered during getter preparation
and release that registration only if this call acquired it. Retain the
earlier global-identity publication before prototype seeding; otherwise the
runtime could re-enter a null global and split constructor identity.

**Positive control, not an empty size check.** The new eight-test suite covers
standalone and WASI, with zero imports and real empty-import instantiation.
Twelve exported readers of Object must share a non-null/non-undefined
identity and one emitted getter. On both targets, the exact parent grows
**15,844 bytes** when going from one reader to twelve; the candidate grows
**268 bytes**. The parent has zero getter definitions and would fail both
new structural/size assertions. One reader costs **35 additional bytes** in
the candidate due to the shared call/function overhead. This is a measured
amortization tradeoff, not a claim that every program shrinks.

The other six new runtime controls pass on both parent and candidate: a
dynamically found Object constructor retains callable keys/defineProperty
and the keys descriptor's identity/attributes; a changed Array.isArray is not
reseeded by another reader; prototype-seed re-entry retains exact Array
constructor identity and a callable isArray. These are preservation controls,
not new semantic fixes. The control script extracts those literal fixtures
from the committed test source and floors the fixture count; it does not
substitute simplified handwritten equivalents.

**Unchanged-row and binary evidence.** The same 14 files / **191 rows** at
parent and candidate both yield **169 passing / 20 failing / two skipped**.
There are zero status changes; all twenty failure messages match exactly.
The preceding constructor/boundary focused population remains **38/38**;
the new materialization suite is **8/8**. The final commit hook reruns the
changed test file separately. These default-path Vitest runs are not
explicitly selected IR Test262 measurements.

All nine arithmetic/Fibonacci/numeric-index controls stay byte-identical and
retain their answers across standalone, WASI and valid gc. Three constructor
probes retain answer 42 while shrinking from parent to candidate:
standalone **581,487 → 579,657 bytes**, WASI **462,068 → 458,866**, and gc
**590,134 → 588,302**. This does not solve most of the substantial transitive
materialization cost recorded in the previous handoff. The temporary clean
parent checkout was removed; its source remains recoverable from `55ac4b99ef`.

Local records are `.tmp/s7c-carrier-dedup-{parent,candidate}.json`,
`.tmp/s7c-carrier-dedup-new-tests.json`,
`.tmp/s7c-carrier-dedup-control-{parent,candidate}.jsonl` (ten rows each), and
`.tmp/s7c-carrier-dedup-{parent,candidate}-bytes.jsonl` (twelve rows each).

**Unresolved acceptance, unchanged.** The hard import-policy command still
fails **456 > 452**. All **33/33** detailed import inventories match the
preceding checkpoint exactly, with zero unknown/regime-gap imports. Record:
`.tmp/s7c-carrier-dedup-imports.jsonl`. The source remains at 804 lexical mode
references under an unchanged 818 ceiling; neither baseline is changed.
Typecheck, formatting/lint, LOC/function, coercion, oracle and IR-fallback
checks pass. Dead-export preservation remains 6/6 full and cut witnesses,
with strict retirement still uncertified at the two recorded nonliteral
dynamic imports. Keep the PR unready and the full S7 goal open. Next resolve
the explicit existing-adapter ceiling decision or a semantics-preserving
representation redesign; do not call this bounded deduplication the completed
JS-host migration or a resolution of its import/footprint blockers.

### S7-d orphaned host JSON retirement handoff (2026-10-19, Codex)

**Parent and removal.** Continue above published parent
`5c3b2ca62e0a0eac683aaa98fe18f145bc1d3b6b`. Remove the unreachable private host
JSON serializer/reviver island from `src/runtime.ts`: eleven functions and
the `_JsonRep` type alias, **422 lines** in total. The old JSON import provider
was already removed; recursive references among these helpers did not make
them live. Retain `_wasmToPlain`, `_wrapForHost`, the public import/export
adapter roots, and the other shared conversion helpers still used at actual
JS crossings. No native JSON implementation, callback ABI or boundary
normalization is changed. A historical callback-classification comment still
names the former host bridge; do not interpret it as a live provider or remove
its receiver-forwarding behavior without separate evidence.

**Bound-reference proof, scoped rather than whole-runtime certification.**
TypeScript symbol binding finds exactly **12 private declarations / 42 bound
identifier occurrences**, all within the removed block. None of the module's
**30 exports** aliases a target. There is no direct lexical eval call that
could refer to a private declaration by string. A positive control appends an
in-memory reference to `_serializeJSONProperty` outside the block: the audit
finds the 43rd occurrence at line 12068 and rejects retirement. No production
file is modified for that control. Repository text search finds only
historical comments outside the block, not another caller of these private
symbols.

The committed reference lines, exact parent, retained roots, counts and
positive control are in
`plan/audit/6979-host-json-retirement-20261019.json`. Local instrument records
are `.tmp/s7d-json-island-parent-audit.json` and
`.tmp/s7d-json-island-positive-control.json`. This proof authorizes removal of
this closed private group only. It does not discharge the global dead-export
gate's two unresolved nonliteral dynamic imports or certify other helpers.

**Runtime comparison, not conformance credit.** The unchanged **12-file /
98-row** JSON, reviver/replacer, namespace, Date/Intl, vector, equivalence and
JS-boundary population is **72 passing / 24 failing / two skipped** at both
parent and candidate. There are no status changes; all **24 failure messages
match exactly**, without stack/path normalization. The residuals are seven
JSON replacer/toJSON assertions, two vector/conversion assertions, fourteen
Date/Intl/bridge assertions and one missing Test262 rawJSON source file.
Do not fix or repin those unrelated failures as part of a dead-code deletion.

The three new retirement controls improve **two passing / one failing →
three passing**. The failing parent assertion sees the old `_JsonRep`
declaration, so this is a positive source-retirement witness, not a new
semantic fix. Both native runtime controls already pass on the parent and
remain passing: dynamically stringify an object holding a supplied number,
parse the result, and check different inputs 41 → 42 and 6 → 7. Each module
has no imports and instantiates with `{}`. The final expanded population is
**13 files / 101 rows / 75 passing / 24 failing / two skipped**, not a green
full suite. These are default-path Vitest measurements, not an explicitly
selected IR Test262 sweep.

Six separate compile-and-run probes cover dynamic object/array JSON round
trips on standalone, WASI and valid gc. All **6/6 binaries are byte-identical**
to the exact parent, return 42 and 7 for the two inputs, and emit no `JSON_*`
host import. The four native modules have zero imports; the two gc modules
use their real generated imports and instance wiring (18 value-adapter
imports each), not stubs. Records:
`.tmp/s7d-json-island-{parent,candidate}-tests.json`,
`.tmp/s7d-json-island-parent-controls.json`, and
`.tmp/s7d-json-island-{parent,candidate}-bytes.jsonl` (six rows each).

**Ratchets and next work.** Bank the runtime source ceiling
**12,066 → 11,644 lines** in the allowed migration audit baseline. The
resolveImport ceiling stays 1,959; owned/explicit adapter ceilings and the
**452 import ceiling remain unchanged**. The hard policy command still
fails **456 > 452**, with no additional source-budget violation. Keep that
decision visible; a line-count decrease is not approval to raise imports.
The raw mode inventory likewise remains 804 under an unchanged 818 ceiling.
Typecheck, lint/formatting, LOC/function, coercion, oracle and IR-fallback
checks pass; dead-export preservation retains 6/6 full and cut witnesses but
strict closure is still uncertified. The PR remains draft on the recorded
dependency stack. Continue proving remaining host-only private groups before
retirement, preserve live boundary conversion, and keep all full S7
compatibility, accelerator, floor and final-conformance requirements open.

### S7-d private operator retirement handoff (2026-10-19, Codex)

**Parent and scope.** Continue above published parent
`cc099d5cbf3728ae708e135d6bb88888bf09278a`. Remove four unreachable private
functions from `runtime.ts`: the old host `_instanceofResult` dispatcher,
`_compiledFnPrototypeSlot`, its `_fnctorInstanceofResult` wrapper, and the
recursive `_toJsArrayDeep` copy helper. Remove five state declarations used
only by those functions (or already unused), plus the two local import
bindings for the retired fnctor wrapper. The source shrinks **316 lines**,
including obsolete comments and formatter-collapsed blank lines. Native
bound-function state, live sidecars/prototype bridges, `_wrapForHost`,
`_unwrapForHost` and `_nativeDynamicFromHost` are retained. The unused private
sentinel/WeakMap allocations disappear; no live boundary map is removed.

The separately exported `src/runtime/fnctor-instanceof.ts` file and its
existing compiler-boundary/custody records are intentionally retained. This
checkpoint proves local private unreachability, not retirement of an exported
module across every dynamic-import root.

**Reference proof and positive controls.** A conservative TypeScript-bound
function graph starts from exported functions and every other top-level
statement, explicitly handles export aliases and shorthand property values,
and rejects direct lexical eval. The exact parent has **178 functions / 32
conservative roots / 30 module exports**; four functions are unreachable.
Injecting `{ _instanceofResult }` as a new top-level shorthand root makes the
dispatcher and both helpers reachable, leaving only the array-copy helper
unreachable. A separate closed-group audit covers all **11 local declarations
and imported bindings / 31 bound occurrences**, with zero references outside
the deletion group. The same shorthand injection is caught as an outside
reference at parent line 11646 and rejects deletion.

The candidate has **174 functions / 29 conservative roots / 30 exports** and
zero unreachable functions under that model. This is not a whole-program
necessity proof for all remaining runtime code. The committed scoped record
is `plan/audit/6979-host-operator-retirement-20261019.json`; local records are
`.tmp/s7d-runtime-private-function-{parent,candidate}-audit.json`,
`.tmp/s7d-runtime-private-function-positive-control.json`,
`.tmp/s7d-private-operator-parent-audit.json`, and
`.tmp/s7d-private-operator-positive-control.json`.

**Existing runtime behavior, including failures.** The unchanged **nine-file /
70-row** operator, linked-class, fnctor, vector, JSON-retirement and JS-boundary
population remains **63 passing / seven failing / zero skipped**. All seven
failure messages match exactly, with no path/stack normalization. Residuals
are two vector/conversion assertions, one Test262Error/Error membership
assertion, two Function.hasInstance cases (bound target and an existing
invalid-local-index compiler failure), and two linked/single-module class
expectations. The expanded population with three retirement controls is
**ten files / 73 rows / 66 passing / seven failing / zero skipped**, not a
green full suite. Records: `.tmp/s7d-operator-{parent,candidate}-tests.json`.

The three new retirement controls pass: old private declarations are absent
while required boundary roots remain, and native nested-array flattening
returns 42 and 7 for different inputs on standalone and WASI with no imports.
The source assertion fails on the parent; the two native controls already
pass there. Six compile-and-run operator/flat probes compare the exact parent
and candidate on standalone, WASI and valid gc: **6/6 binaries are identical**,
and every module returns 42 and 7 for the two inputs on both sides. Native
modules have no imports; gc uses genuine imports and instance wiring (three
imports for flat, 21 for instanceof), not stubs. Records:
`.tmp/s7d-operator-{parent,candidate}-bytes.jsonl` (six rows each). The clean
temporary parent checkout is removed after verification; its source remains
recoverable from the exact parent commit.
These are default-path measurements, not an explicitly selected IR Test262
sweep. The two newly discovered foreign-instanceof failures below are
separate open findings, not included among the three passing controls.

**Ratchets and next action.** Bank the runtime-source ceiling
**11,644 → 11,328**. The import ceiling remains 452 and its hard gate still
fails at 456; resolveImport remains capped at 1,959. Raw-mode source remains
804 under the unchanged 818 ceiling. Typecheck, lint/formatting, LOC/function,
coercion, oracle and IR-fallback checks pass. Dead-export preservation remains
6/6 full and cut witnesses, but strict retirement is still uncertified at the
two recorded nonliteral dynamic imports. Keep the stack draft and full S7
acceptance open. Prioritize the native boundary-operator gap below; do not
describe this deletion as restoring host instanceof interoperability.

#### Open boundary gap: dynamic instanceof on JS-owned values

- [x] Make a genuine JS-owned instance/constructor pair return true through
  native dynamic `instanceof`.
- [x] Invoke a JS-owned `Symbol.hasInstance` with the original receiver,
  original value, and exactly one argument, even when its installation was
  outside the compiled source.

At parent `cc099d5cbf`, compile the default native-regime export
`export function isInstance(value: any, constructor: any): number { return value instanceof constructor ? 1 : 0; }`.
Instantiate with `buildCompiledImports(result)`, publish the instance, and use
`wrapCompiledExports(result, instance)` (that exact argument order). A JS
`class Foreign {}` and `new Foreign()` return **0 instead of 1**; the negative
`{}`/Foreign control returns 0 correctly. A JS object with a true-returning
`[Symbol.hasInstance]` method likewise returns **0 instead of 1** and the
method is called **zero times**. A separate echo export preserves both the
sentinel object's and Foreign function's exact identities, so this is not
evidence of copying at admission.

Local records: `.tmp/s7d-operator-boundary-repro.ts` and
`.tmp/s7d-operator-boundary-parent.jsonl` (four rows). The corrected initial
five-test exploration is `.tmp/s7d-operator-parent-controls-corrected.json`:
two native flat controls pass; source-retirement and both new boundary
expectations fail on the parent. The earlier report with the reversed export
wrapper arguments is superseded, not interop evidence. These two failures are
recorded here rather than silently converting them into expected-failure or
wrong-answer assertions in the retirement suite. Preserve this open work as
part of the full migration acceptance.

Review the shared native `InstanceofOperator`/OrdinaryHasInstance dispatch,
especially the source-only `moduleInstallsCallableHasInstance` decision and
foreign prototype identity. A JS-owned handler cannot be excluded because
the compiled source did not install it. Implement the repair in IR or the
genuinely shared native runtime, not as a new frozen direct-AST language arm.
Do not restore the unreachable legacy host dispatcher as a semantic fallback.

### S7 native dynamic-instanceof suspended-work handoff (2026-10-19, Codex)

**Publication, not completion.** At the user's request, checkpoint the work in
[Separate native semantics from JS host mode](https://github.com/loopdive/js2/pull/6762)
and hand off here. The runnable compiler remains at `3498bfa40d`; this handoff
does not enable the unsuccessful experimental route. Full S7 acceptance and
this issue remain open. The prerequisite
[Remove the host-assisted semantic policy](https://github.com/loopdive/js2/pull/6701)
was still open and unmerged when checked for this publication. Keep the
existing PR draft: the known import gate is 456 against its unchanged 452
ceiling; publication grants neither a ceiling increase nor merge readiness.

**Recoverable prototype.** The exact five-file experiment is preserved in
`plan/audit/6979-native-dynamic-instanceof-unfinished-20261019.patch`.
It applies to `3498bfa40d` (`git apply --check` verified). It is research/WIP,
not a recommended patch to enable in production. The five production files
have been returned to that checkpoint after archiving their full diff; no
user edits or frozen direct-AST emitters were changed. The local Node 24
Vitest flag is an environment workaround and is not part of the patch.

The prototype adds a checked native runtime target, exact externref dynamic
carrier capability, IR selection/lowering and resolver wiring. Its owners
are `src/codegen/native-dynamic-instanceof.ts`, `src/ir/backend/legality.ts`,
`src/ir/from-ast.ts`, `src/ir/integration.ts` and `src/ir/select.ts`.
It deliberately leaves the frozen direct-AST path alone and keeps the
InstanceofOperator separate from OrdinaryHasInstance. The latter is also the
implementation of Function.prototype[Symbol.hasInstance] and must not
recursively consult a custom handler.

**Fresh experiment result.** Run default WasmGC/gc native-first compile,
real generated imports and exported-value wrappers under Node 24 with
`--experimental-wasm-exnref`. The archived prototype still returns **0 instead
of 1** for both the JS-owned instance/constructor pair and JS-owned custom
handler; the handler is called zero times. The negative case returns 0 and
the identity control passes. These are four measured cases: two passing and
two failing, not a passing interop suite. With `trackIrOutcomes: true`,
`isInstance` appears in `irCompiledFuncs` with no first-skip/post-claim error,
but its ledger explicitly says `stage: patch`, `directBodyEmissions: 1`,
`irBodyEmissions: 1`, `legacyBodyEmitted: true`, and admission withdrawal
`param-signature-unstable`. This is hybrid patching, **not genuine IR-only
admission**. The outcome target label says standalone while the physical body
route audit says gc; do not use that label to identify the measured target.
Typecheck completed successfully on the prototype; the full semantic/error,
import and source-ratchet matrix has not been validated for it.

The following self-contained repro can be saved as `.tmp/s7-instanceof.ts`
and run with `node --experimental-wasm-exnref --import tsx .tmp/s7-instanceof.ts`:

```ts
import { compile } from '../src/index.ts';
import { buildCompiledImports, wrapCompiledExports } from '../src/runtime.ts';
const result = await compile(`
  export function isInstance(value: any, constructor: any): number {
    return value instanceof constructor ? 1 : 0;
  }
  export function echo(value: any): any { return value; }
`, { trackIrOutcomes: true });
if (!result.success) throw Error(JSON.stringify(result.errors));
const imports = buildCompiledImports(result);
const { instance } = await WebAssembly.instantiate(result.binary, imports);
imports.setInstance?.(instance);
const ex = wrapCompiledExports(result, instance) as Record<string, Function>;
class Foreign {}
const sentinel = {};
let calls = 0;
const custom = {
  [Symbol.hasInstance](value: unknown) {
    if (this !== custom || value !== sentinel || arguments.length !== 1)
      throw Error('boundary receiver/argument identity');
    calls++;
    return true;
  },
};
console.log({ positive: ex.isInstance(new Foreign(), Foreign), expected: 1 });
console.log({ negative: ex.isInstance({}, Foreign), expected: 0 });
console.log({ custom: ex.isInstance(sentinel, custom), calls, expected: 1 });
console.log({ identity: ex.echo(sentinel) === sentinel && ex.echo(Foreign) === Foreign });
console.log(result.irOutcomes, result.irBodyRouteAudit);
```

**Resume in this order.**

1. Reproduce the two wrong answers before changing admission. Trace native
   GetMethod/Call for a JS-owned handler: inspect `__extern_get`, boxed
   well-known Symbol.hasInstance key conversion and foreign callable
   classification (`__typeof_function`). Missing symbol-marshalling export
   demand and callable classification are hypotheses, not established causes.
   The source-only `moduleInstallsCallableHasInstance` hint cannot exclude a
   handler installed by JS outside the compiled source. Do not resurrect the
   retired legacy host-semantic dispatcher as a fallback.
2. Implement the repair in IR or genuinely shared native runtime, preserving
   GetMethod/Call versus OrdinaryHasInstance separation. Prove helper demand,
   stable parameter ABI and actual prepared-body ownership. Require zero
   legacy function-body emissions; a selector claim or patched count is not
   sufficient. Do not fix the frozen direct-AST emitter instead.
3. Add parent-controlled tests for original receiver/value identity, one
   argument/one call, live getter mutation, truthiness, throwing getter/handler
   exception identity, noncallable handlers, invalid RHS, primitive LHS and
   default Function.prototype[Symbol.hasInstance] without recursive dispatch.
   Preserve native standalone/WASI zero-import controls and existing static
   class/wrapper lowering. Operator TypeError cases are not fixed by the
   archived checked wrapper alone; the existing operator still has
   conservative false-return paths.
4. Rerun the recorded 70-row operator population and compare every failure
   message, then measure new probes/imports, binary cost and all ratchets.
   Do not inherit old measurements as proof for a new semantic patch. The
   runnable checkpoint remains at 804 raw-mode references under the unchanged
   818 ceiling, runtime-source ceiling 11,328, and the unresolved 456/452
   import gate. Strict dead-export retirement remains uncertified at the
   two previously recorded nonliteral dynamic imports. Leave acceptance open
   until these and the dependency stack are resolved.

**Handoff-only validation.** After restoring the runnable compiler, the same
four boundary cases reproduced the same two passes/two failures. The JSON
and operator retirement files pass **6/6 tests across two files** on the
restored source. Issue integrity, LOC/function, coercion and oracle checks
pass. The dead-export preservation command exits successfully with **6/6 full
and 6/6 cut witnesses**, while still explicitly reporting the two unknown
dynamic imports and **strict retirement NOT CERTIFIED**. Those scoped checks
do not clear the migration's semantic/import blockers or establish IR-only
conformance. This handoff changes documentation/audit material only.

**Publication blocker at handoff.** The normal commit hook chain passed, but
the configured SSH signing key could not be decrypted and no signing agent
was available. The handoff and archived prototype are staged locally, not
yet committed/pushed. The PR's published head remains `3498bfa40d`. Resume
publication after the user unlocks the signer or explicitly authorizes a
one-off unsigned commit; do not silently disable signing or bypass hooks.

#### Resumed investigation after the publication blocker

The signing blocker does not prevent local migration work. Fresh three-way
controls on `3498bfa40d` locate two independent demand/selection defects:
plain source classifies a JS-owned function as non-callable (0) and both
instanceof positives fail; adding an exported symbol-read function makes
callable classification/read identity pass but leaves both positives false;
adding a source handler-install function makes both positives pass. A Proxy
log observes the exact Symbol.hasInstance key, original receiver/value and
one argument in the passing installation control. Symbol bridge exports are
present in all three modules, so missing symbol export demand is not the
cause of these observations. Local record:
`.tmp/s7-boundary-dispatch-diagnosis.ts` (three measured variants).

Resume the archived IR path locally, explicitly demand the existing admitted
callable classifier, and prove a dynamic-externref ABI against the allocated
slot before early body ownership. Keep the archival patch as the failed
experiment, not an updated success claim. No permission to bypass signing,
raise ceilings, or change frozen direct-AST semantics has been granted.

#### Local repair verified; still unpublished (2026-10-19, Codex)

The new default non-fast WasmGC IR path now requests the checked native
InstanceofOperator and the existing admitted-JS callable classifier itself.
No source installation of Symbol.hasInstance is required. Dynamic signature
preparation admits only its exact externref carrier and still compares every
parameter/result against the allocated Program ABI slot. This removes the
`param-signature-unstable` withdrawal for the measured operator exports:
`check` and the number-LHS `numeric` each have **zero direct body emissions,
one IR body emission, no legacy body entry and no withdrawal**. The physical
audit identifies target gc; the stale outcome target label is not used as
target evidence. This proves these function bodies, not a whole IR Test262
sweep or complete program ownership.

The operator keeps its own checked contract separate from the frozen direct
body's legacy entry and from OrdinaryHasInstance. Invalid RHS/present
noncallable handlers throw native TypeError; boxed boundary null and undefined
handlers count as absent. Concrete numeric operands use the native dynamic
boxer instead of the unsupported host-number-box seam. JS objects/functions
stay the original admitted externrefs, without object copying.

Callable classification previously used a dummy ordinary construction with
the user value as newTarget, which read a Proxy's `prototype` while merely
classifying it. The boundary adapter now uses a trapping constructible target:
it checks constructibility without reading the user's prototype or invoking
user code. It also reuses the adapter's existing admission guard. The adapter
file remains 238 lines; no source/import ceiling was raised.

Keep the drivers bounded rather than granting new growth allowances:
`src/codegen/ir-prepared-signature-contract.ts` owns signature vocabulary and
physical projection; `src/ir/instanceof-selection.ts` owns the exact carrier
certificate; `src/ir/instanceof-lowering.ts` owns the extracted unchanged
wrapper-brand lowering. New dynamic-operator orchestration remains in IR;
no frozen direct-AST body emitter was extended.

**Fresh parent-controlled acceptance.**
`tests/issue-6979-native-dynamic-instanceof.test.ts` has **28/28 passing** on
the candidate versus **7/28 passing and 21 failing** on clean parent
`3498bfa40d`. Cases cover original JS instance/constructor identity, default
positive/negative membership, live getters/mutations, exactly one handler
call and argument, no Proxy prototype access during classification, handler
truthiness, thrown-value identity, invalid operands/handlers, nullish absent
methods, numeric LHS dispatch, no recursive default-method dispatch and
standalone/WASI native zero-import controls with two runtime inputs. Runs
use Node 24's `--experimental-wasm-exnref` and real generated imports/export
wrappers; no JS semantic import is substituted as an operator implementation.

The eight-file preparation/ABI population is **145 rows / 129 passing /
16 failing / zero skipped on both fresh parent and final candidate**, with
zero status changes and all failure texts equal after replacing only the
temporary worktree directory name. Existing failures include vector/ABI,
receipt-lookup bounds, singleton/caller behavior and telemetry assertions;
this is not a green preparation suite. Reports are
`.tmp/s7e-prepared-{parent,final}-tests.json`.

The combined final operator/wrapper/ordinary/retirement/interop population is
**13 files / 161 unique cases: 140 passing, ten failing and eleven skipped**,
versus **119 passing, 31 failing and eleven skipped** on the assembled parent
controls. All 21 transitions are the new interop controls changing fail to
pass; all ten residual failure texts match after only the parent directory
replacement. Three retirement rows overlap the earlier 73-row and fresh
63-row baseline reports and are counted once, not twice. The original 70-row
population remains 63/7/0, with exact failure messages unchanged. Wrapper
residuals include two obsolete assertions demanding the retired host import;
the ordinary-method residual requires an unavailable runtime-eval provider.
The scoped reproducible record is
`plan/audit/6979-native-dynamic-instanceof-local-20261019.json`, including
source hashes, case transitions and explicit proof limits. It does not make
the combined population green or certify the full migration.

Typecheck, targeted lint/format, LOC/function budgets, coercion, oracle and
IR-fallback gates pass. The dead-export preservation gate remains 6/6 full
and cut witnesses, not strict certification of the two recorded unknown
dynamic imports. Raw-mode source is still **804 references in 357/1,945
source files**, under the unchanged 818 ceiling. The host-import hard gate
still fails **456 > 452** and reports no other budget violation; runtime
source remains 11,328 and owned adapters remain within 898. All baselines
remain unchanged. The clean temporary parent checkout was removed after
copying its reports into this worktree's `.tmp/`.

**Remaining semantic work, independently reproduced.**

- [x] Support OrdinaryHasInstance on a JS-owned constructor whose own
  Symbol.hasInstance is null/undefined. With `class F {}`, `v = new F()` and
  `Object.defineProperty(F, Symbol.hasInstance, { value: null })`, the current
  S7-e native export returned **0 rather than 1** (the JS oracle returned 1). The
  new GetMethod normalization correctly avoids a wrong handler TypeError,
  but the ordinary native prototype walk still cannot compare foreign
  object identities. Fix the shared identity/prototype substrate, not a
  top-level host instanceof fallback or object copy. The passing negative
  nullish-method controls must remain beside this positive case.
- [ ] Complete the remaining S7 source retirement, import-ceiling decision,
  binary-cost review, dependency stack and full compatibility/accelerator/
  conformance acceptance. These focused successes do not complete migration.

The earlier archived patch remains an exact record of the unsuccessful
prototype. The working tree now contains the subsequent verified repair;
it is **not** the archived patch or the published PR head. Signing is still
blocked, so none of this local repair is committed/pushed. Do not bypass
signing or hooks and do not mark the PR ready on the strength of local tests.

#### Foreign-prototype identity repair underway (2026-10-19, Codex)

The next shared-runtime slice addresses the remaining ordinary membership
gap, not another host semantic provider. Wasm's eqref identity cannot compare
opaque JS-owned object references. Add one admission-gated object-identity
adapter primitive (no property reads, traversal, construction or instanceof
inside the adapter), and keep the prototype walk and decision in Wasm. Use
the existing GetPrototypeOf MOP for each hop, preserving Proxy trap order and
exceptions. Its null terminal must remain an internal null reference, not a
boxed dynamic null. Foreign callable prototype lookup must use Get directly,
not an observable extra GetOwnPropertyDescriptor/HasOwnProperty probe.

Register the primitive before helper bodies capture indices. Preserve the
old native eqref walk and all no-JS-target imports/behavior, and verify native,
JS and mixed chains with positive/negative and trap controls. Measure the
actual import delta without raising the existing ceiling. Keep the prior
local repair's source-hash audit as its own historical measurement; do not
relabel it as validation of these later edits. Bound-function opaque internal
slots are a separate requirement, not assumed solved by an ordinary walk.

### S7-f foreign prototype identity and signed-publication handoff (2026-10-19, Codex)

**This section supersedes the earlier signing-blocked/unpublished status for
the code included in this checkpoint.** The shell did not inherit the macOS
SSH-agent socket. Read-only discovery through launchctl found the existing
agent; its loaded public key fingerprint matches the configured signer. Use
that socket only in the commit process environment, with signing and normal
hooks enabled. No private key/passphrase was read, no persistent signing
configuration changed, and no unsigned-commit permission is assumed. Publish
through the existing draft PR, not directly to main or as migration completion.

**Representation repair.** The native ordinary prototype walker now supports
JS-owned prototype identities. Its only added import is
`__boundary_object_same_identity`, a two-reference, admission-gated identity
primitive. It performs no property lookup, traversal, instanceof or copying.
The Wasm algorithm still owns each GetPrototypeOf hop, null termination and
the decision. Exact identity implies both references share the admitted owner;
an unadmitted or native GC value never acquires authority through this import.
The foreign walk has no arbitrary finite-chain cutoff. The existing native
eqref path remains separate and needs no JS import on standalone/WASI.

An admitted foreign callable's prototype is read directly through Get, not
through a preceding observable descriptor/own-property probe. Nullish handler
absence and prototype validity use the native boxed-null/undefined contract;
a boxed null prototype is invalid even though JavaScript typeof null says
object. The same shared nullish test handles the ordinary native helper's
value/prototype checks. The frozen direct-AST body emitter remains untouched.

**Trap-free admission.** The initial walk tests exposed a second defect:
`_isWasmStruct` called Object.getPrototypeOf during admission and could swallow
a throwing Proxy trap as a classification result. New dynamic boundary exports
publish `__dynamic_boundary_is_gc`, a native eqref-type probe. Admission uses
that probe and caches its certified verdict before marking JS ownership;
neither a Proxy trap nor a speculative property write is needed. Native GC
values stay native, while ordinary, frozen/null-prototype, adversarial and
revoked JS Proxies retain their actual JS identities. Existing compiled
modules without the new probe retain their compatibility path.

The object adapter reuses one admission guard for binary MOP operations and
returns a raw internal null for the GetPrototypeOf terminal; dynamic user
values retain their normal boxing. Numeric/boolean/bigint admission shares
its existing boxer lookup without changing the value families. Runtime source
is **11,324 lines**, under the unchanged 11,328 cap. Measured owned adapters
are **895 lines**, under the unchanged 898 cap. No baseline was raised.

**Measured acceptance and limits.**

- The three-file boundary population passes **55/55**. The new ordinary-
  prototype file passes **19/19**, versus **7 passing/12 failing** on the
  exact staged S7-e source snapshot. That baseline was reconstructed in a
  temporary checkout and all eleven source hashes matched the preceding
  audit before execution. Cases include own null/undefined handlers, direct
  and inherited positives/negatives, live prototype replacement, Proxy trap
  order, no descriptor probe, thrown-value identity, primitive LHS order,
  invalid/null/Symbol prototypes, a 10,005-link finite chain, native-versus-JS
  classification, exact frozen/Proxy identity and instance-scoped admission.
- The expanded **15-file / 189-case** parent-controlled population changes
  **156 passing/22 failing/11 skipped → 168 passing/10 failing/11 skipped**.
  All twelve transitions are fail to pass. All ten remaining failure texts
  match after replacing only the temporary parent directory name. The parent
  report's older eleven-row foreign file is replaced, not added again, by
  its final nineteen-row run. The existing 161-case population has no status
  or failure-message change. The eight-file **145-row** preparation/ABI
  population remains **129 passing/16 failing/zero skipped**, with exact
  status and raw failure-message equality against the prior source snapshot.
- Native scalar/flat/dynamic controls execute **6/6** modules over standalone
  and WASI, each with zero imports and answers 42 and 7 for different inputs.
  Four scalar/flat binaries remain byte-identical. The two dynamic-instanceof
  binaries each grow **468 bytes** for the shared boxed-null checks:
  standalone **145,718 → 146,186**, WASI **140,585 → 141,053**. They are not
  claimed byte-identical, and no JS-boundary type probe is exported there.
- All **33** import inventories were compared. Totals change **456 → 457**,
  with **zero unknown and zero regime-gap imports** on both sides. The only
  added occurrence is the identity value adapter in the `objectPrototype`
  probe; no other import is added or removed. The actual hard gate still
  fails **457 > 452**. Temporary observational instrumentation prints before
  the same throwing guard; the real gate was rerun and still fails. Neither
  the previous 456 decision question nor publication authorizes a 457 ceiling.
- Typecheck, targeted lint/formatting, LOC/function, coercion, oracle and
  IR-fallback checks pass. The strict dead-export proof remains uncertified
  at the two recorded nonliteral dynamic imports; preservation still has
  six full and six cut witnesses. These are default-path scoped tests, not
  an IR Test262 or whole-program acceptance result.

The scoped record is
`plan/audit/6979-foreign-prototype-identity-20261019.json`, with exact source
hashes, transitions, import deltas and native binary witnesses. The preceding
S7-e audit and failed prototype patch remain historical evidence, not claims
about this later source. Raw reports stay under `.tmp/s7f-`; the controlled
temporary checkout was restored, verified clean and removed after preserving
its reports. No unrelated checkout or user changes were removed.

**Next owner.** Resolve the 457/452 import decision or a semantics-preserving
representation redesign; review the remaining constructor/binary cost and
unmerged prerequisite stack before readiness. Audit opaque JS bound-function
internal slots rather than assuming an ordinary prototype walk exposes them;
the inherited bound-function and invalid-local-index cases remain open beside
the other recorded broader failures. Finish full S7 runtime retirement and
compatibility/accelerator/conformance acceptance. Keep the PR draft and this
issue in progress; do not reintroduce a host instanceof semantic fallback,
copy boundary objects, waive a gate, or declare the full migration complete.

### S7-g runtime binder retirement handoff (2026-10-19, Codex)

Current base: signed checkpoint `f99bd729cc82285c514eba87996874e334f07799`.
Read-only inspection found that low-level `buildImports()` enforced the
retired-import policy only with `ambientCompatibility: false`. The default
and explicit-true paths could still bind retired ECMAScript extern classes
through injected dependencies. This is a second semantic provider, not the
documented ambient Iterator/RegExp shim option.

Plan: measure that bypass with negative controls on all three option forms;
make the existing import-policy rejection unconditional; delete only the
class-specific branches that the policy makes unreachable. Keep selected
RegExp/Date/Intl accelerators, SharedArrayBuffer's named gap, test-harness
errors, declared external classes and JS-owned object/callback adapters.
Validate removal with symbol-reference evidence, parent/candidate runtime
tests, unchanged native binaries/import inventories and the existing ratchets.
Do not raise any ceiling or treat this as full S7 completion.

**Implemented.** Every env manifest entry is now classified before any
dependency resolution or ambient-shim installation. `ambientCompatibility`
does not bypass semantic retirement. AggregateError, AsyncDisposableStack,
Boolean, Function, Number and String were missing from the shared retired-
class set and are now classified consistently. This deliberately breaks
hand-built manifests attempting to restore retired host semantics; it does
not copy JS objects or remove declared external API capabilities.

The unreachable Map/Set/WeakMap/WeakSet constructor and method adapters,
wrapper/Promise/buffer/Error constructor special cases and seven private
support declarations are deleted. General ToPrimitive, boundary iterable
materialization, live facades, admission and selected accelerator paths remain.
TypeScript binding analysis on the exact parent finds **7 declarations / 17
references**, all inside the removed region, **30 exports**, no target export
and **zero direct eval**. An in-memory shorthand reference to the Error helper
at line 11,326 makes the same detector refuse the deletion. This is a scoped
private-reference proof after the policy guard, not global runtime closure.

**Measured.**

- Focused seven-file population: **88 passing/7 failing of 95** before;
  guard-only **95/95**; final **97/97**, including two added source-retirement
  and whole-manifest controls. The class rejection loop covers **39 classes ×
  4 actions × 3 option forms = 468 assertions**. The old ambient adapter test
  now expects the deliberate policy rejection rather than an unhandled intent.
- Fresh detached-parent comparison: **10 files / 194 unique cases** retain
  **128 passing/41 failing/25 skipped**, with no status changes. Two failure
  stacks differ only in the shifted runtime line coordinates; after replacing
  just those coordinates and the parent directory on both sides, every error
  matches. This is not a green suite. The separate Linear runtime/class
  population remains **6/6** in two files on both sides.
- Six fresh standalone/WASI controls retain byte-exact modules, zero imports,
  answers **42/7** and no JS-boundary type-probe export. All **33** detailed
  import inventories match, **457 imports/zero unknown/zero regime-gap**.
- Runtime source: **11,324 → 10,580 lines (744 net removed)**;
  `resolveImport`: **1,959 → 1,680**, still seven cases. Owned adapters stay
  **895**, explicit capabilities **1,194**. No ceiling is raised or banked.
- Project TypeScript7 typecheck, whole lint, formatting, LOC/function,
  coercion, oracle and IR-fallback gates pass. The generic `tsc --noEmit`
  command used initially is not this repository's typecheck and reports
  missing Node types; the canonical `pnpm run typecheck` passes. The pnpm
  IR-gate wrapper initially hit sandbox IPC restrictions; the same script
  passes through `node --import tsx`. Dead-export preservation still has
  **6/6 full and cut witnesses**; the two nonliteral imports leave strict
  retirement **not certified**.

Scoped evidence: `plan/audit/6979-runtime-binder-retirement-20261019.json`;
raw comparisons and positive control: `.tmp/s7g-*`. The temporary parent
checkout is only a control, not an implementation branch.

**Remaining.** Runtime is still **2,580 lines** above the program's target.
The real import gate still fails **457 > 452**. Preserve the prerequisite
stack, opaque bound-function investigation, constructor/binary review, raw
mode-field deletion and full compatibility/accelerator/conformance acceptance
as open work. Keep the PR draft; do not merge or mark the migration complete.

**Qualified-capability follow-up.** The final classification
review found a name collision: an explicit external namespace may declare
its own `Number`, `Function`, `Date` or collection class. Retirement must
identify the global intrinsic, not ban a declared API by its leaf name.
Preserve qualified extern capabilities in the shared classifier/registration
helper, exclude unrelated namespaces from accelerator inference, and resolve
an explicit namespace before a same-named builtin constructor fallback.
Validate actual constructor/argument identity and retain the unqualified
retirement controls. This is boundary policy/registration work, not a new
direct-AST semantic emitter.

The eleven-row parent-policy probe at `92efacb428` classified ten qualified
APIs `unknown` and qualified `SharedArrayBuffer` as a regime gap. All eleven
now classify as declared capabilities, including with `date`/`regexp`
selected; separate live constructor checks preserve argument identity. The
shared registration helper now receives the existing namespace metadata;
the runtime resolves that namespace before a builtin fallback. An explicit
namespace is not evidence that an unrelated API is a selected accelerator.
Unqualified builtins retain all **468** rejection assertions.

The final focused population is **100/100**. The two added compiled Number
and Map namespace controls each return **42 and 7** for different inputs.
The four-shape compile/run probe is **2 passing/2 failing**: replacing the
class name in the fixture below with `Function` or `Date` compiles but then
throws `TypeError: Cannot access property on null or undefined`; Number/Map
work. Keep those two lowerer collisions open, not hidden by the binder's
positive tests or repaired in the frozen direct-AST body emitter:

```ts
declare namespace api { class Function { constructor(value: number); value: number; } }
export function run(n: number): number { var value = new api.Function(n); return value.value; }
// Supply deps.api.Function = class { constructor(value) { this.value = value; } }.
// compile({ skipSemanticDiagnostics: true }), buildCompiledImports, instantiate,
// setInstance and wrapCompiledExports; run(42) should return 42, but currently throws.
```

The refreshed **194-case** comparison retains **128 passing/41 failing/25
skipped**, with identical keys and failure texts under the same directory/
runtime-coordinate normalization. All six native binary rows and all 33
import inventories still match. Runtime source is now **10,581** lines and
`resolveImport` **1,681** (one line for namespace-first constructor resolution);
the net reduction against `f99bd729cc` is **743** lines, and the runtime target
gap is **2,581**. The 457/452 gate is unchanged. See
`plan/audit/6979-qualified-class-capabilities-20261019.json` for exact source
hashes and proof limits. The earlier
binder deletion audit remains the historical `92efacb428` snapshot, not a
source-hash claim about this follow-up.

The missing-provider negative control then exposed a remaining binder escape:
`api.Date`/`api.RegExp` with no `api` provider still fell back to the global
builtin. The new three-name test fails on `9cfcfa65f5` before the repair
(zero passing/one failing/15 filtered). Restrict builtin fallback to unqualified
imports and the explicitly supported Intl namespace; an unresolved arbitrary
API namespace now throws the existing missing-dependency error on invocation.
Keep flat dependency overrides and selected Intl constructor binding intact.

Final focused validation passes **101/101** across seven files, including the
new missing-provider test. Six native binary rows and all 33 import inventories
still match. Runtime source is **10,582** lines, `resolveImport` **1,682**;
net reduction against `f99bd729cc` is **742** lines. No ceiling is banked or
raised; the 457/452 import gate and 2,582-line runtime target gap remain.
The preceding qualified-capability audit describes the `9cfcfa65f5` snapshot;
`plan/audit/6979-qualified-class-missing-provider-20261019.json` records this
final guard and current source hashes.
Keep the compiled Function/Date lowerer failures and full S7 acceptance open.

### S7-h qualified constructor IR handoff (2026-10-19, Codex)

Base: `d86d645ba9e4d8aeb945e39f109938a4facf51e4`. Reproduced the four-shape
namespace probe: Number/Map pass with outputs 42/7; Function/Date compile but
fail at execution. IR selection currently rejects every non-Identifier new
callee, and from-ast has the same restriction. Plan: certify actual same-file
ambient namespace/class declaration identity through the checker, reject
shadowed/dynamic callees, and reuse existing extern-new/property IR operations
and registered import signatures. Recheck namespace metadata in lowering;
prove prepared IR body ownership rather than accepting an AST/hybrid repair.
Keep unqualified native builtins and host-free controls unchanged. No new host
semantic import, AST-body emitter fix or ceiling waiver is authorized here.

Implemented checkpoint for [PR 6762](https://github.com/loopdive/js2/pull/6762),
still draft and not independently mergeable. The earlier Function/Date lowerer
gap above is superseded for the exact declared namespace constructor shapes
below, not for general dynamic constructors or the whole migration.

- Certify same-file ambient namespace/class identity through the checker.
  Reject parameter shadows, aliases, computed callees, runtime objects and
  runtime-merged roots. Both selection and lowering consume this certificate;
  lowering rechecks the actual registered namespace metadata.
- Use full qualified class keys in shared import registration and IR receiver
  types. Publish used metadata by import prefix, preserving two namespaces
  with the same leaf name, deduplicating aliases and rejecting conflicting
  provider prefixes. An explicit API Date declaration is not the intrinsic.
  Both single- and multi-module metadata publisher sites use the same helper;
  the integration execution tests below cover single-module compilation only.
- A direct qualified constructor returned as `any` uses the canonical empty
  externref boxing operation: the JS-owned object is unchanged, not copied.
  Prepared support records the exact instruction, operand type object and
  selected externref carrier, rather than inventing a helper or accepting an
  empty callable list as evidence. Normal program ABI sealing still validates
  the carrier binding. Strings and other unsupported dynamic operations gain
  no authority from this change.
- Small metadata/selection/resolver contracts were extracted to stay within
  existing source/function limits. Consolidating an existing duplicate
  integration import statement reduces the layering count to 87 lines in
  15 files; it does not remove a unique dependency edge. Compiler inventory
  now explicitly classifies six new modules and four earlier S7 modules as
  unmigrated debt, with no activation or architecture-complete claim.

Measured local validation, Node 24.4.1, Vitest forks with
`--experimental-wasm-exnref`, native-first JS target unless a test explicitly
selects another target:

- Ten boundary/support files: **125/125** passing. Three focused files:
  **24/24**, versus **17 passing/7 failing** on production parent
  `d86d645ba9e4d8aeb945e39f109938a4facf51e4`.
  The parent control copied the two new tests and two new inert helper modules
  imported only by those tests; its tracked production tree was unchanged.
  This is a production-parent comparison with new test support, not a claim
  that the entire control directory was unchanged.
- Seven fail-to-pass rows comprise six prepared-IR ownership assertions and
  one exact identity-witness unit assertion. They are **not seven runtime bug
  fixes**. Separately, the clean parent four-shape execution probe passes
  Number/Map and fails Function/Date; the candidate passes all four with
  answers 42 and 7. Each candidate body records zero direct emissions, one IR
  emission and no legacy body entry. The return test additionally checks exact
  original instance and thrown-token identity.
- Fresh broad comparison: **194 cases, 128 passing/41 failing/25 skipped** on
  both sides. Prepared/ABI comparison: **145 cases, 129 passing/16 failing** on
  both sides. Exact test keys, outcomes and raw errors match after replacing
  only the parent worktree directory. No runtime-coordinate normalization was
  needed; runtime source is unchanged in this checkpoint.
- Fresh six-module standalone/WASI controls are **byte-identical 6/6** to the
  parent, with zero imports and answers 42/7. All **33** detailed import
  inventories and their classification totals are identical to the parent.
  The hard import gate still fails **457 > 452**, unapproved.
- Typecheck, lint/format, LOC/function, coercion, oracle, IR layering and
  IR-fallback checks pass. Compiler inventory is valid with zero errors, but
  architecture remains incomplete. Dead-export preservation passes **6/6 full
  and 6/6 cut** witnesses; strict closure is still uncertified at the recorded
  nonliteral imports in optimize and the platform capability adapter.

Evidence and implementation hashes:
`plan/audit/6979-qualified-extern-ir-20261019.json`. Earlier audits remain
historical source snapshots. Runtime remains **10,582 lines**,
`resolveImport` **1,682**, and the runtime target gap **2,582**. No source,
function or import ceiling is raised or banked.

Next owner: do not extend the frozen direct-AST semantic body emitter. Keep
the explicit JS ownership boundary and native-first profile orthogonal.
Resolve the unmerged predecessor PR 6701 and recovered S7-b dependency before
any merge; retain the 457/452 gate as a blocker. Continue the remaining S7
source retirement, opaque bound-function internal-slot handling, strict
closure, compatibility/accelerator/conformance acceptance and binary-cost
review. Neither these controls nor publication certify whole-program IR-only
admission, a full Test262 sweep, or migration completion.
