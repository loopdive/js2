---
id: 6979
title: "S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators"
status: in-progress
assignee: ttraenkler/codex
created: 2026-10-14
updated: 2026-10-20
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

### S7-i remaining provider retirement handoff (2026-10-19, Codex)

Parent: `b2c3aaaf89eed66524198207e544fc6bbb6b69ad`. Fresh source census:
runtime 10,582 lines, resolveImport 1,682, 804 raw mode references across
357 source files. The private top-level function graph has 169 declarations,
30 exports and no unreachable function; this alone cannot see dead nested
provider closures or branches made unreachable by manifest policy.

Investigate remaining retired builtin handlers and Promise-only nested
closures, prove policy rejection and exact bound-reference closure before
deletion, and retain live generator-gap, accelerator and boundary operations.
The broad lifecycle prefix currently also admits unknown registration names;
inventory exact live registrations before replacing it with explicit names.
No frozen AST semantic-body edits or ceiling waivers are authorized.

Removed the remaining fixed extern-method/host-call dispatchers, retired
array materialization and dynamic-call/class-parent handlers, five orphaned
Promise closures and write-only Promise registry state. After those removals,
the bound private function graph identified two more unreferenced helpers
(closure classification and the empty-tuple host discriminator); both are
deleted. One duplicate fnctor registration branch was unreachable behind the
same earlier branch; the actual earlier registration remains.

Lifecycle classification now lists the **eleven** implemented registration
names instead of allowing every `__register_*` builtin. Unknown names and the
orphaned Promise registration reject before any dependencies or ambient shims
are touched. This deliberately changes the hand-built builtin manifest API.
An explicitly declared embedder function with the same spelling remains a
platform capability, not an implicit builtin provider.

The two private host-call modules are deleted, not moved elsewhere. The strict
iterator module retains only its live eager-generator yield-star gap adapter;
four retained helper bodies are text-identical to the parent. Its one old
direct host-materializer unit test is replaced with the public manifest
rejection contract. The native strict-spread protocol matrix is unchanged.
Init-window behavior remains covered by the existing marshal and vec-dispatch
tests in the broader comparison, rather than by keeping a dead provider alive.

Measured local validation against production parent
`b2c3aaaf89eed66524198207e544fc6bbb6b69ad`, Node 24.4.1, Vitest 3.2.4 forks
with `--experimental-wasm-exnref`:

- Twelve boundary/support files: **137/137**. Seven-file focused comparison:
  **81 passing/4 failing → 85/85**. Three lifecycle rejection groups and one
  source-retirement assertion improve; this is not four new runtime semantic
  wins. One passing obsolete unit key is replaced with a passing rejection
  key and is not credited as an improvement.
- Fresh fourteen-file broad population: **230 cases, 155 passing/50 failing/25
  skipped** on both sides. All test keys/outcomes match. Two Request failure
  stacks move from runtime line 8162 to 8053; both point to the exact unchanged
  `return new Ctor(...args)` source line and same column. Replacing only those
  coordinates and the control directory leaves exact failure-text equality.
  The prior 194-case subset retains **128 passing/41 failing/25 skipped**.
- Six standalone/WASI modules are **byte-identical 6/6**, have zero imports,
  return 42/7, and export no JS-boundary probe. All **33** detailed import
  inventories remain identical, with zero unknown or regime-gap entries in
  that probe population; this does not mean the three named gap families
  elsewhere have been eliminated.
- The deletion proof resolves **five nested declarations/nine bound
  references**, none outside the removed region. An injected local shorthand
  reference outside it correctly rejects deletion. The two later private
  helpers each had only their declaration reference. The final top-level graph
  has **167 functions/30 exports**, zero direct eval and zero unreachable
  functions; that scoped result is not a whole-program closure certificate.
- Typecheck, lint/format, source/function, coercion, oracle, layering,
  IR-fallback and compiler-inventory checks pass without a baseline change.
  Compiler architecture remains incomplete. Dead-export preservation still
  has **6/6 full and 6/6 cut** witnesses, while strict closure remains open at
  the two recorded nonliteral dynamic imports.

Current runtime source is **10,160 lines** (**422 net removed** in this
checkpoint), `resolveImport` **1,369 lines/seven cases**. Owned adapter and
explicit capability counts remain **895/1,194**. The runtime target gap is
**2,160 lines**. Source retirement totals **745 net lines** across runtime,
the two deleted modules and the trimmed iterator adapter; this is deletion,
not relocation. No ratchet is raised or banked.

Evidence: `plan/audit/6979-provider-retirement-20261019.json`. The temporary
control contained only the added test plus ignored harness inputs over
unchanged tracked parent production sources. Reports were preserved before
cleanup. Prior audits remain historical snapshots.

Next owner: continue S7 retirement without extending frozen direct-AST
semantic bodies. Dead emitter spellings there remain explicit debt. Keep the
live Temporal/SharedArrayBuffer/eager-generator gaps until native replacements
are verified; do not reclassify them as capabilities. The unmerged predecessor,
opaque bound-function boundary slots, **457/452** hard gate, remaining runtime
size target, strict closure, compatibility/conformance/accelerator acceptance
and binary-cost review still prevent migration completion or independent PR
merge.

### S7-j declared capability / accelerator isolation handoff (2026-10-19, Codex)

Parent: `b3a0500cd4bad754a6c40a8b84ac49f77f137740`. Inspect whether
explicitly qualified APIs still inherit builtin-specific argument coercion,
RegExp lastIndex shims or implicit Intl constructor lookup merely by name.
These must stay ordinary declared capabilities, while selected intrinsic
accelerators retain their own adapters. Reproduce with actual compiled
carriers/host providers before changing the shared runtime boundary; keep
frozen direct-AST semantic bodies and import ceilings untouched.

Verified the leak and repaired it at the shared runtime boundary. Policy,
runtime constructor/property adaptation and the Intl wrapper now use one exact
intrinsic identity contract. Only unqualified Date/RegExp and the seven
registered constructors under exactly `["Intl"]` use those accelerator
adapters. A class named Intl, nested Intl paths, and arbitrary qualified API
classes remain declared capabilities.

The parent four-shape compiled probe reads an object bag correctly for
`api.External` (42/7), but `api.Date` and `api.RegExp` receive a coerced string
and `api.Test262Error` receives an unreadable raw carrier; all three return
NaN. The candidate returns **42/7 for all four** through normal live facades.
The functional controls also prove original JS-owned argument, constructed
instance and thrown-token identity with accelerator selection both off and on.
No object is copied.

Qualified RegExp.lastIndex no longer installs the intrinsic coercion shim; it
uses the same property contract as an ordinary capability. A missing
`Intl.custom.NumberFormat`, `Intl.custom.Date` or `Intl.Date` cannot silently
select a global builtin. Exact selected Intl.NumberFormat still binds, and
the existing selected Date/RegExp/Intl tests pass unchanged. The shared Intl
constructor-name list is the same seven names the binder already supported.

Measured local Node 24.4.1 / Vitest 3.2.4 fork validation with
`--experimental-wasm-exnref` against the parent above:

- Thirteen boundary/support files: **151/151**. Focused five-file comparison:
  **57 passing/11 failing → 68/68**. All eleven transitions are fail to pass,
  with no missing/added test keys. Fourteen new controls include six object-bag
  cases (three affected names, accelerators off/on), missing-provider and
  exact-identity/classification controls, plus the ordinary API controls.
- The compiled object-argument probe remains **one direct body/zero IR bodies
  on both sides**. No frozen AST semantic-body emitter changed: this is a
  shared boundary repair, not an IR adoption or whole-program IR-only claim.
- Fresh fourteen-file broad comparison retains **230 cases: 155 passing/50
  failing/25 skipped**. Exact keys and outcomes match. Two Request failure
  stacks move runtime 8053 → 8056, same column and unchanged source line;
  replacing only those coordinates and the control directory leaves exact
  error-text equality. No broader conformance gain is claimed.
- Six standalone/WASI controls are **byte-identical 6/6**, have zero imports
  and return 42/7. All **33** detailed import inventories match. The hard gate
  remains **457 > 452**, unapproved; no import or source ceiling was raised.
- Typecheck, lint/format, source/function, coercion, oracle, layering,
  IR-fallback and compiler-inventory checks pass. The new identity contract is
  classified as unmigrated compiler debt, not an architecture activation.
  Dead-export preservation remains **6/6 full and 6/6 cut**; strict closure
  stays open at the two previously recorded nonliteral imports.

Evidence: `plan/audit/6979-capability-accelerator-isolation-20261019.json`.
Parent tracked production sources were unchanged; only the new test and ignored
harness inputs were copied into the control. Reports were preserved before
verified-clean control removal. Earlier audit hashes are historical snapshots.

Runtime is **10,163 lines**, `resolveImport` **1,371/seven cases**; the three-line
increase wires the shared identity decision. Owned adapter/capability counts
remain **895/1,194**, and the runtime target gap is **2,163**. No ratchet is
banked. The unmerged predecessor/recovered dependency, opaque bound functions,
live regime gaps, runtime retirement target, strict closure, full
compatibility/conformance/accelerator and binary-cost acceptance still prevent
completion and independent merge. Continue from those program requirements;
do not equate this verified interop repair with the full migration.

### S7-k native boundary key filtering / import gate handoff (2026-10-19, Codex)

Parent: `2381a04d088a6cf247ee7be641d13c3bccd44a5c`. The authoritative
33-probe inventory totals 457 imports against the unchanged 452 ceiling.
Investigate exact registration/use/retention edges before changing imports.
Keep all admitted JS-object MOP, identity and callable behavior; no baseline
increase or detector/probe reduction is authorized. Any reduction must come
from production code and be validated against the same 33 probes plus runtime
boundary controls.

Closed the import-budget blocker in production code. Newly generated modules
use the existing admitted-object `__boundary_object_own_keys` primitive and
bounded native helpers that filter its native key vector by exact string/
symbol carrier types. Key order and original symbol identity are preserved;
non-admitted answers remain null and invalid internal key carriers trap.
The helpers use the existing native ObjVec allocator/push operation and are
registered only for a JS value boundary. Frozen direct-AST body emitters and
the selector are unchanged.

The boundary primitive captures intrinsic Reflect.ownKeys once; replacing the
ambient public method cannot redefine the operation. Legacy name/symbol
adapter bindings remain usable by old manifests, but new compiler output
does not import them. This is removal of compiler dependence, not a claim
that all boundary adapter source or compatibility ABI was deleted.

The **unchanged official** `scripts/check-host-import-policy.ts` fails on the
exact published parent at **457 > 452** and passes on the candidate at
**433 ≤ 452**. All **33** probe keys are retained, with zero unknown/gap entries
in that population. No detector, probe, policy classification or baseline is
relaxed. Exact import delta: remove **44** name/symbol-provider occurrences,
add **20** occurrences of the existing own-key primitive, **24 fewer net**.
Twenty-two probes shrink; eleven are unchanged. Every common import retains
its exact kind, intent type, family, classification and owner metadata.

Measured local Node 24.4.1 / Vitest 3.2.4 forks with
`--experimental-wasm-exnref`:

- Fourteen boundary/support files: **158/158**. Focused parent comparison:
  **76 passing/2 failing → 78/78**. The import-shape guard and ambient Reflect
  replacement guard improve; five new runtime behavior controls already pass
  on the parent. This is not seven new semantic runtime fixes.
- Controls cover non-enumerable strings and ordering, exact symbols, empty/
  48-key mixed lists, one ownKeys trap with no descriptor/get/prototype traps,
  original exception tokens, invalid/duplicate/revoked proxies and admission
  denial. The enumerable Object.keys path still invokes descriptor traps.
- Fresh broad comparison retains **230 cases: 155 passing/50 failing/25
  skipped**. One initial candidate failure was solely the old passing test
  requiring the two removed imports, after all its runtime assertions passed.
  Only those expectations were replaced with absence checks; ownKeys presence
  and all value/identity assertions remain. This is a contract re-pin, not a
  new semantic improvement.
- Four already-failing generator tests display `…(19)` instead of `…(20)`
  in their import-array previews. Their statuses and all other error text
  match after directory replacement; no generic error normalization hides
  these differences. All other broad errors match exactly.
- The fresh **145-case** preparation/ABI comparison remains **129 passing/16
  failing**, with exact keys, outcomes and error texts. Six standalone/WASI
  scalar/flat/dynamic controls are **byte-identical 6/6**, zero-import and
  retain answers 42/7.
- Cost is explicit: the names-only and symbols-only JS probes each grow
  **319 bytes**; the combined probe grows **443 bytes**. Both sides keep the
  existing direct entry-body routes; shared native runtime helpers changed,
  not AST emitters. This proves no new whole-program IR-only coverage and no
  performance improvement.
- Typecheck, lint/format, source/function, coercion, oracle, layering,
  IR-fallback and compiler-inventory checks pass. The new helper remains
  unmigrated backend debt in the inventory. Dead-export preservation remains
  **6/6 full and 6/6 cut**; strict closure is still uncertified.

Evidence and exact source hashes:
`plan/audit/6979-native-boundary-own-keys-20261019.json`. Parent tracked
production sources were unchanged; only the new test and ignored harness
inputs were copied. Reports were preserved before verified-clean removal.
The gate script and baseline hashes are pinned and unchanged.

Current runtime source remains **10,163**, resolveImport **1,371/seven cases**;
owned adapter source is **896** (one intrinsic-snapshot line), explicit
capability source **1,194**, all within existing caps. The runtime 8,000-line
target still has a **2,163-line gap**. No ceiling is raised or banked.

Next owner: treat **457/452 as a historical blocker now resolved**, not a
current failure. Keep the unchanged 452 ceiling. The predecessor/recovered
dependency, opaque bound functions, raw-mode/source retirement, live named
regime gaps, strict closure, full conformance/npm-compat/accelerator and
binary-cost acceptance remain open. Import-gate closure alone is not migration
completion or permission to merge this stack independently.

### S7-l shared native object source handoff (2026-10-19, Codex)

Published parent: `1d71a03e35a0544e5259b0e35eea1acf06c9a262`.
Three remaining mode guards in the shared native object runtime excluded WASI
from closed-user-struct source registration and Proxy source finalization.
Live-input probes reproduce both silent skips on the exact parent (−1 instead
of 42 for inputs 7 and 13), while standalone and JS-hosted native controls
already pass. Remove those three guards; do not add an AST body path, selector
override, JS semantic provider or import.

Reserve the existing screened closed-struct classifier before dependent bodies
are built in every WasmGC environment. Keep its finalized admitted shape set,
per-carrier access, enumeration and getter/setter behavior unchanged. The
reader audit finds three consumers: Object.assign, JSON.stringify and
Object.defineProperties. All now share the same classifier in WASI too; no
second implementation or broad fallback is introduced. Install the existing
Proxy ownKeys/descriptor/Get/Set source loop without the mode guard. JS-owned
boundary values and identity-backed adapters are unchanged: Object.assign's
specified copying is not boundary object-graph normalization.

Measured local Node 24.4.1 / Vitest 3.2.4 fork pool with
`--experimental-wasm-exnref`, against the unchanged parent production tree:

- New matrix **33/33**, eleven cases each for standalone, WASI and gc, with
  two live inputs per case. **Nine WASI fail-to-pass rows**: closed source,
  Proxy source, descriptor filtering, symbols, abrupt Get, ownKeys throw,
  revoked Proxy, closed-struct JSON and descriptor-map application. These are
  shared-runtime repairs, not nine independent implementations or IR wins.
- JSON/consumer cohort **34/43 → 43/43**. Wider **170-case/nine-file** cohort
  **158 passing/12 failing → 167 passing/3 failing**, zero skipped. The three
  unchanged linked object-rest failures retain exact test keys and full error
  text after replacing only the parent directory. No expectation re-pins.
- The initial test harness incorrectly required zero WASI imports even when
  explicit throw syntax requests the standard exception printer. The final
  matrix uses real node:wasi binding for wasi_snapshot_preview1, not semantic
  stubs. Standalone has no imports; WASI has no JavaScript semantic imports.
- **All 33 JS policy-probe binaries and complete import inventories match
  exactly**. The unchanged official gate passes **433/452**, with zero
  unknown/gap entries in that population. Selected accelerator and named-gap
  controls are retained. No ceiling, detector, probe or baseline change.
- Five of six scalar/flat/dynamic standalone/WASI controls are byte-identical;
  WASI dynamic grows **141,053 → 142,496 (+1,443 bytes)**. All six remain
  import-free and answer 42/7. The two minimal WASI assign probes improve
  their answers and grow **1,434/1,475 bytes**; paired standalone/gc assign
  binaries match. No overall size or performance improvement is claimed.
- Measured assign entry and module-init bodies remain **direct 1 / IR 0**
  on both sides. The production edit is shared runtime registration and
  finalization, not a frozen AST semantic-body change.
- Typecheck uses the repo's TypeScript7/tsconfig.ts7.json command and passes;
  lint/format, source/function budgets, coercion, oracle, layering, IR-fallback
  and inventory checks pass. An exploratory plain tsc invocation used the
  wrong config and failed on Node types; it is not the acceptance command.
  Strict dead-export closure remains uncertified at the two nonliteral dynamic
  imports; preservation retains six full/six cut witnesses.

Exact source hashes, paired binary witnesses and test transitions:
`plan/audit/6979-shared-native-object-sources-20261019.json`.
Raw mode references fall **804 → 799**, matching files **357 → 356** across
**1,952** scanned source files, under the unchanged/unbanked **818** ceiling.
Three executable guards and two obsolete comment references are removed.
Runtime remains **10,163 lines**, resolveImport **1,371/seven cases**, owned
adapters **896**, capabilities **1,194**; the runtime target gap is **2,163**.

Separate live discovery, **not fixed by the mode-guard change**: a captured
`const assign = Object.assign` called with more than one source currently
loses later arguments, in both standalone and JS-hosted native builds. The
initial probe `assign(target, null, { value: n }, undefined, { other: n+1 })`
returns the original target without those writes. Track the builtin callable
variadic ABI separately; the source-loop controls here call the binary helper
repeatedly to exercise overwrites and nullish skips, not variadic forwarding.
The current generated builtin closure in `src/codegen/builtin-value-read.ts`
pushes only its second argument into the source vector. A real fix needs a
variadic native callable/Program-ABI contract and IR-owned call preparation,
not a JS semantic fallback or another frozen AST body special case.

Next owner: retain the 433/452 gate result and explicit WASI binary costs;
finish the variadic callable gap, remaining raw-mode/source retirement,
opaque bound-function slots and strict closure, then full program-level
conformance/npm-compat/accelerator and cost acceptance. The prerequisite
stack remains unmerged; keep the PR draft and both migration issues in
progress. This checkpoint is not permission to merge independently or mark
the migration complete.

### S7-m native Object.assign argv and boundary-source handoff (2026-10-19, Codex)

Published parent: `6b8825052304cb9233de6f277ba620ad2d1ab8e3`.
Captured Object.assign lost later sources on all three WasmGC targets. It
also skipped genuine JS-owned sources. The parent returns −1 rather than 42
for inputs 7/13 through aliases, call and apply; the JS boundary target stays
identical but receives neither the property nor its nested object value.

Use the existing native argv-vector convention, independent of reflective
arity (Object.assign.length remains 2). A shared builtin population now drives
registration, alias preparation and exact identity/signature checks in dynamic
apply; user rest functions keep their receiver-aware route. The value body
packs every source, including nullish entries, and calls the existing native
Object.assign helper. No new host semantic provider or import implementation.

The return-identity investigation found **storage**, not a copied object:
unannotated call/apply results were narrowed to f64 on standalone/gc. The
shared carrier classifier now retains externref for proven stable Object.assign
captures and their alias chains. WAT confirms f64 → externref on those two
targets; WASI already kept externref. An attempted argument decoder did not
fix that defect and was removed; no new object-normalization/copy layer ships.

Admitted JS-owned sources use the existing boundary ownKeys primitive, native
proxies their native MOP. One native loop asks each live descriptor, Gets only
enumerable values and performs strict Set. Key order, exact symbols, target /
nested-value identity, partial writes and original throw tokens are preserved.
The existing strict Proxy false-set guard is also shared with WASI, with
accepted, rejected, throwing and trap-absent forwarding controls.

Object's patch facts and ordinary native property reads now work on WASI too.
Patched Object.assign members cannot be hardwired to the builtin; rebound
aliases, captured-before-patch values and shadowed namespaces are covered.
Keep the broader patched-Math limitation below distinct from this contract.

Fresh local Node 24.4.1 / Vitest 3.2.4 fork pool with
`--experimental-wasm-exnref`, exact parent production tree unchanged:

- New matrix **69/69**. Focused matrix plus existing Math override controls:
  **80/80**. Wider **268 cases / 13 files** improves **227 passing / 41
  failing → 265 passing / 3 failing**, zero skipped. All **38** changed rows
  are fail-to-pass in the new file; no pre-existing expectation re-pins.
  The three linked object-rest failures retain identical full errors after
  replacing only the parent directory. These are not 38 independent defects.
- No frozen AST expression/statement body, property dispatcher, driver, IR
  selector or IR source changes. Measured run/call/apply/foreign/module-init
  routes match the parent, still direct 1 / IR 0. This is shared native runtime,
  source facts and carrier contracts, not new IR-only coverage.
- **All 33 detailed policy inventories match exactly**. The unchanged hard
  gate passes **433/452** with zero unknown/gap entries in that population;
  selected accelerator and named-gap controls remain. **28** JS binaries
  match; five shrink **3,660–3,770 bytes**. No probe/detector/baseline changes.
- The separate semantic fixture improves all three call forms on all three
  targets, but its gc imports grow **19 → 22**: existing value adapters
  `__boundary_object_apply`, `__unwrap_for_wasm` and
  `__boundary_object_callable_kind`. These are extra occurrences, not new
  implementations or permission to raise the unchanged policy ceiling.
- Four of six minimal native binaries match. Standalone dynamic grows **547
  bytes**, WASI dynamic **3,418**; all six are import-free and answer 42/7.
  The three semantic fixture modules shrink **7,186 / 1,101 / 6,027 bytes**
  (standalone/WASI/gc). No overall size or performance improvement is claimed.
- TypeScript7 repo typecheck, lint/format, LOC/function, coercion, oracle,
  layering, IR-fallback and inventory gates pass without new growth grants.
  Both new modules remain unmigrated inventory debt. Dead-export preservation
  retains six full/six cut witnesses; strict modeled closure is uncertified.
- **Newly checked inherited blocker:** the import-cycle ratchet fails on the
  exact parent and candidate with the same reported directional violations:
  codegen→ir **298 → 301**, ir→codegen **74 → 75**. This is not green or a
  whole-graph equivalence certificate; no baseline/allowance is changed.

Exact hashes, all changed/retained rows, carrier-slot witnesses, complete
binary comparisons and negative controls:
`plan/audit/6979-native-object-assign-argv-20261019.json`.
Raw mode references **799 → 795**, matching files **356 → 354**, scanned
files **1,952 → 1,954**, ceiling **818** unchanged/unbanked. Runtime remains
**10,163**, resolveImport **1,371/seven cases**, owned adapters **896**,
capabilities **1,194**. The runtime target gap is still **2,163 lines**.

The flat-directory gate initially found codegen root growth. Place the new
argv body with object-model helpers and the variadic population with closure
contracts; also move the unchanged boundary key filters into object-model.
The gate now passes at **833** files (published parent **834**, change-set
base **833**), with no allowance/baseline change. All **42** measured binary
witnesses and all **268** outcomes/full failure texts are exactly unchanged
after relocation. Only the key filter's type-only import and its runtime
registration import path change; its semantic body is preserved.

Keep this discovery open rather than overclaim a generic variadic-call fix:
`Math.max = function(...values:number[]) { return n + values.length; };
const fn = Math.max; fn(1,2,3)` still does not reliably invoke the patched
callable. Rejecting every patched variadic alias exposes the old lib-signature
argument-cast problem (a scalar is cast to the rest-vector slot); retaining
the old Math alias shortcut ignores the patch instead. Object.assign's
identity guard is deliberately separate from this unresolved generic
callable/IR ABI work. Do not fix it by extending frozen AST body emitters.
The unconditional all-namespace source-fact projection was withdrawn after an
exact-parent control showed WASI changing from an incorrect scalar result to
an exception for that Math case. Only Object's proven shared callable contract
is widened here; other namespaces keep their existing projection. Both sides
still fail that residual against the isolated Node reference, so this is not
generic patched-builtin completion.

Primitive Object.assign targets also remain open: the captured value returns
the primitive instead of a proper wrapper. In an isolated Node reference,
`const assign=Object.assign; const r=assign(n,{extra:n+1});` yields an object
whose valueOf is n and whose extra is n+1. The exact parent and final candidate
both return −1 against expected 42 for inputs 7/13 on standalone/WASI/gc.
Together with patched-Math, all **six target/fixture residual combinations**
remain failing and exactly match between parent/candidate; they are not hidden
inside the passing 69-case matrix. Fix through shared native wrapper and
callable/IR contracts, not a JS semantic fallback or frozen AST body patch.

The final boundary audit also tested returning Object.assign to JavaScript:
`export function getAssign():any{return Object.assign;}`. Calling the returned
function-shaped facade with a target and two sources fails identically on the
exact parent and candidate: `__call_fn_0/__call_fn_1` are not exported. This
is an additional existing callable-escape / bridge-registration gap, not
covered by the passing in-Wasm calls over JS-owned objects. Check native
builtin registration and authenticated closure-dispatch publication before
claiming full host interoperability; do not replace it with a JS semantic
provider. The audit records this seventh residual control separately.

Next owner: close those residual mechanisms and the callable escape gap, inherited cycle violations,
opaque bound-function slots, raw-mode/runtime retirement and strict closure;
then the full equivalence/conformance/npm-compat/accelerator and cost acceptance
on the resolved prerequisite stack. Keep the 452 import ceiling and binary
tradeoffs visible. Both migration issues remain in progress and the PR draft;
this checkpoint does not authorize independent merge or migration completion.

### S7-n native callable argv and returned-function handoff (2026-10-19, Codex)

Published parent: `9600194e3760ed89c7c94f9c26c330cb45e7d6d4`.
The previous callable-escape error misidentified the mechanism: the minimal
Object.assign getter **does publish authenticated dispatchers 1–4**, but
wrapExports' separate return wrapper only selected 0 or 1. Ordinary returned
two-parameter functions failed too. Reuse the identity-cached dynamic bridge
instead of that duplicate wrapper; retain genuine JS-owned input/receiver
objects in the existing per-instance admission set, without traversing them.
Translate native primitive results and native Error payloads at this bridge;
do not blanket-marshal aggregate results (other native callers need raw values).

Native variadic builtins use the existing physical one-vector convention.
Extend the authenticated `__closure_has_rest` discriminator: **0 positional,
1 source rest, 2 native packed argv**. The native identity arm precedes source
shape checks and reuses the existing metadata-id / linked-signature guards.
It does not mutate shared signature ClosureInfo, which could misclassify an
ordinary array-parameter function. The boundary constructs only the argument
list through existing ObjVec/vector adapters; the builtin still executes in
Wasm and sees every supplied argument, including more than four. Target,
source, nested token, symbol and throw-token objects remain identity-backed.

Keep `__closure_arity` and reflective native `.length` unchanged. A negative
arity discriminator was rejected during investigation: native ToPrimitive
and other readers also use `arity >= 0` as a callability guard. The existing
rest-discriminator readers instead test `=== 1`; extending it with an exact
native identity does not change those source-rest decisions. No new host
import implementation, semantic provider, AST body, driver or selector change.

The ordinary typed-array control exposed a separate shared-reader omission:
native `__extern_length` did not admit JS-owned array-likes. Its existing
Get/ToLength arm now also recognizes already-admitted objects, without adding
a host-free import or probing their prototype. This fixes positional array
length conversion, **not** the typed-array identity/mutation residual below.
Argument-list construction also avoids consulting the host Array iterator.

Local Node 24.4.1 / Vitest 3.2.4 fork harness, `--experimental-wasm-exnref`,
exact unchanged parent production tree and identical new test:

- New matrix **17/17**. Combined **376 cases / 22 files: 349 passing / 27
  failing → 366 passing / 10 failing**, zero skipped. All 17 changed rows
  belong to the new file; they are not 17 independent defects. No old test
  expectations changed. Nine retained failures have identical full errors
  after directory substitution; the tenth differs only in runtime stack-line
  locations, with the same error message and other frames.
- The first linked-harness attempt lacked compareArray.js in both trees.
  Re-run with the repository-pinned Test262 harness
  `b363f29d3c43c626dc852744ad64a0b48a003693`: both linked end-to-end controls
  now stop at unavailable QuickJS execution. Those two remain failures, not
  evidence of linked compatibility; the combined population uses this rerun.
- **33/33 complete policy inventories match; unchanged guard passes 433/452**,
  zero unknown/gap entries in that population. Eleven policy binaries match;
  eighteen grow **5 bytes**, four grow **149 bytes**. No probe, detector,
  baseline, ceiling or allowance change; no size/performance win claimed.
- Four of six native binaries match. Standalone/WASI dynamic controls each
  grow **83 bytes**; all six retain zero imports, answers 42/7 and no exported
  JS-boundary probe. This is not a byte-neutral native change.
- TypeScript7 repo typecheck, lint/format, LOC/function/flat budgets, coercion,
  oracle, IR layering/fallback, issue/retirement and inventory checks pass.
  Flat codegen remains **833** files. Dead-export preservation has six
  full/six cut witnesses; **strict modeled closure remains uncertified** at
  the two recorded nonliteral dynamic imports. The import-cycle gate still
  fails on both trees with the same reported codegen→ir **298→301** and
  ir→codegen **74→75** violations; no waiver or whole-graph equality claim.

Runtime **10,163 → 10,161 lines**, still **2,161** above target. resolveImport
is unchanged at **1,371/seven cases**, owned adapters **896**, capabilities
**1,194**. This checkpoint does not delete the remaining raw-mode field or
activate new IR coverage. The new leaf constant is a runtime contract; shared
context-dependent codegen bodies remain migration debt.
Exact source/gate hashes, transitions, retained failure hashes, binary costs
and negative-control source:
`plan/audit/6979-callable-boundary-argv-20261019.json`.

**Next owner — do not equate native builtin argv with complete callable interop.**
Fresh parent/candidate controls retain these failures:

1. An ordinary returned rest closure given 32 arguments observes **4**.
2. An ordinary returned five-parameter closure has no callable free dispatcher.
   The candidate now refuses while wrapping, instead of deferring the old
   misleading 0/1-dispatch error until invocation. Fix these through a shared
   native complete-argv calling contract, not more frozen AST body emitters.
3. A returned Object.assign facade still reports wrong JS-side name/length:
   candidate `wasmClosureDynamicBridge`/0, parent empty name/0, expected assign/2.
   Reflective metadata **inside Wasm** remains correct; full reflective JS
   function-object fidelity is not certified by that passing control.
4. A typed `number[]` formal still materializes a native vec: pushing 42 does
   not update the original JS array, and the raw returned vec is not that
   array. Both sides fail the same identity/mutation/aggregate-return control.
   Preserve the user's live boundary-object requirement when repairing it;
   do not hide it behind a copied graph or claim array-length success fixes it.

The prior primitive-target and patched-Math fixtures also retain all six
target/fixture failures exactly. Continue these mechanisms, opaque bound
functions, raw-mode/runtime retirement, strict closure/cycles, prerequisite
resolution and full equivalence/conformance/npm-compat/accelerator/cost
acceptance. Both migration issues stay in progress and PR6762 stays draft,
stacked on unmerged PR6701 and recovered S7-b; no independent merge or complete
migration claim is authorized by this handoff.

### S7-o bounded native callable argv publication and handoff (2026-10-19, Codex)

Continue from signed `0c7c877d2ad659a2d1a3b47f9f18c8ea37280c0c`.
The ordinary returned rest/five-parameter controls still fail. Investigate
publishing the existing shared native apply contract through the authenticated
closure boundary, instead of widening another JS-side arity ladder. Preserve
receiver, actual argc, complete extras/rest vectors and exact callable ownership;
prove the wider boundary cannot be redirected through a same-named user export
or a tampered/donor manifest. Keep native no-import and binary-cost controls,
legacy module compatibility and the unchanged import ceiling explicit. No
frozen AST semantic body or selector changes; full migration remains open.

The first complete-argv demand reached **461/452** imports. Keep the complete
native contract, not the overflow: native enumerable string-key selection now
shares the existing OwnPropertyKeys/descriptor primitives. The policy probe's
old requirement for `__boundary_object_keys` was obsolete; replace it with the
two primitive requirements and a hard absence check across every probe. Do not
change the 452 baseline or the probe population. Preserve and report both gate
versions and this intermediate failure. Primitive call arguments also need the
existing native dynamic boundary bridge even in typed-only programs; move that
pure helper unchanged out of declarations into the shared boundary module,
without editing a frozen AST semantic body or adding a second argument decoder.

**Checkpoint for PR6762; not migration acceptance or independent merge.**
Publish a thin three-externref adapter to the existing native `__apply_closure`,
not another JS arity ladder. Manifest bit18 authenticates its exact compiler
alias in a 19-slot funcref table; old modules retain their 18-slot format.
Runtime authority is established only by a branded instance (or the existing
instance association), never public spellings, copied export records, a donor
table entry or descriptor shape alone. Existing cached facades retain their
genuine owner. Untrusted views can still use the legacy narrow ABI, but a wide
closure cannot silently miss that dispatcher. The extracted descriptor ledger
retains the constructor bridge's identity/finalization lifecycle and also
protects this publication. Same-spelled user exports survive stripping.

Ordinary five/nine-formal calls, `any[]` rest calls through 32 arguments,
actual argc/defaults/far arguments on the measured small-formal path, decimal
and NaN inputs, live receivers and exact throw tokens now use native dispatch.
The argument-list vector is new, but its object entries remain live admitted
identities; no graph traversal/copy or JS semantic provider is added.
The native own-key filter now performs enumerable-string selection from live
OwnPropertyKeys and descriptors, without Get of source values, symbol
descriptor queries or prototype probes. Legacy runtime key adapters remain
for previously compiled modules; only current compiler demand is retired.

No frozen AST semantic body, driver or selector edits. The declarations edit
is a pure move of the existing primitive boundary helper into its shared
module. The new provenance leaf is explicitly **unmigrated / mixed-needs-split**
in the compiler inventory. The declarative IR capability row is an ABI
description, not new IR body coverage.

Validation against exact published parent `0c7c877d2ad659a2d1a3b47f9f18c8ea37280c0c`,
Node 24.4.1 / Vitest 3.2.4 fork harness with `--experimental-wasm-exnref`:

- New controls **31/31**. Combined scoped population **495 cases / 26 files**,
  **467 passing / 28 failing → 483 passing / 12 failing**, zero skipped.
  All 16 changed rows are in the new files, including structural and inventory
  assertions, not 16 independent semantic fixes. Final rows and retained errors are in
  `plan/audit/6979-complete-callable-argv-20261019.json`. The new tests are
  identical on the control tree. Existing manifest/schema/inventory expectations
  change normatively for bit18/19 slots, the reserved bit19, the extra exported
  ABI row and native enumerable-key primitives; functional expectations do not.
  The one-shot callback failure moves past invocation/receiver assertions to
  missing construct rejection: do not call its full error unchanged or its
  behavior certified. Two linked controls still lack QuickJS execution despite
  the pinned Test262 harness being present. No full Test262 sweep.
- Same **33** policy probes; **433 → 437 imports / unchanged 452 ceiling**,
  zero unknown/gap entries. There are 26 added primitive-adapter occurrences
  and 22 removed enumerable-key-selector occurrences. The detector itself is
  intentionally updated as described above, not represented as unchanged.
  Nine policy binaries match; 24 grow, including Date **+67,764 bytes** and
  Set iteration **+65,211 bytes**. The isolated typed-callable fixture grows
  **22,678 → 107,033 bytes**, imports **3 → 16**. Native apply demand roots
  substantial existing native runtime; footprint is an open tradeoff, not a win.
- **Six/six** standalone/WASI binaries are byte-identical to this parent,
  retain zero imports and answers 42/7, and export no JS boundary probe.
  Old 18-slot modules instantiated against the new runtime retain their measured
  outcomes, including their old width/primitive limitations; no retroactive
  widening claim.
- TypeScript7 typecheck, lint/format, source/function budgets, coercion/oracle,
  IR layering/fallback, flat directory and compiler inventory checks pass.
  No new allowance/baseline/ceiling change. Flat codegen stays **833** files.
  Function growth initially crossed 300 lines and was split, not waived.
  Commit uses the sanctioned fast pre-commit (format/lint and budgets stay on);
  the slow checks were run manually. The changed-root schema file still has
  the two measured parent failures, recorded rather than re-pinned to green.
  Preservation-only dead exports retain six full/six cut witnesses, but strict
  modeled closure still fails on the two nonliteral imports in optimize.ts and
  platform-capability-adapter.ts. Parent and candidate cycle gates both fail
  with reported codegen→ir **298→301**, ir→codegen **74→75**; no waiver.

Runtime **10,161 → 10,235 lines** (+74), still **2,235 above target**;
resolveImport remains **1,371/seven cases**, owned adapters **896**,
capabilities **1,194**. Raw-mode/source retirement remains open.

**Next owner — bounded publication is not complete callable semantics.**

1. Fix native typed rest-tail concatenation: an isolated `(...a:number[]) =>
   a.length` still observes **5** after 32 arguments on both trees. `any[]`
   passing does not prove typed vectors.
2. Fix wide fixed-formal extras/`arguments` preservation. A nine-formal
   function with 32 inputs reached a wrong NaN before the publication guard;
   this checkpoint now explicitly throws `TypeError` for fixed arity above
   four with extra arguments. Remove that guard only with native-core tests
   proving actual argc and far extras. Exactly-nine-input calls are covered.
3. Repair null receiver normalization. The isolated strict receiver probe
   still returns **-1**, expected 42, on both trees; a separate null argument
   probe retains 42. A combined null test was removed from the green new matrix
   and its exact source remains in the audit's negative controls. A concrete
   nullable-reference investigation aborted beforeAll and is not a pass.
4. Finish callback construct rejection and certify init-window complete argv,
   opaque bound callable slots, JS facade name/length, and live typed JS array
   identity/mutation/aggregate-return handling. Do not substitute graph copies.
5. Continue the prior primitive Object.assign / patched Math residuals, raw-mode
   and runtime/source retirement, strict closure/cycles, then full equivalence,
   conformance, npm compatibility, accelerators and cost acceptance. The earlier
   six primitive/Math failures are not freshly remeasured by this checkpoint.

Keep both migration issues in progress and PR6762 draft, stacked on PR6701
and recovered S7-b. Signed publication with Markdown handoffs is the requested
landing here; no independent merge or complete-migration claim.

### S7-p shared native argument-tail repair (2026-10-19, Codex)

Continue from signed `6d189dfe2541da8676ffaa269b9382e91fde1bee`.
Repair the existing native apply-tail contract for typed rest vectors and
above-cap fixed signatures, not another boundary dispatcher. Enumerate its
producer/consumer lifecycle before changing tail admission; preserve consume-
before-user-code behavior, native element conversions, actual argc, under-
application and nested/reentrant calls. Remove the temporary JS refusal only
after direct native and boundary execution prove full far-extras preservation.
Keep array-like getter order, native import/cost controls and old ABI behavior
visible; no frozen AST body/selector expansion or migration-completion claim.

**Repair:** the native tail now covers every potentially truncating dispatcher
width, including the above-eight-formal entry. Missing intermediate arities
no longer shadow the ordinary top with an undefined fallback. Save actual argc
before widening, use it to bound generic argument reads, and seed it after all
argument getters/tail slicing immediately before entry. Reentrant getters cannot
replace the count, and padding never performs out-of-range Get.

The shared native method-state builder gives extras their actual supplied
length before clamping argc to formals; an above-cap dispatcher may have more
storage slots than the callee received. Rest formals reuse that complete
canonical extras list, through the existing native per-vector element
materializer when a typed representation is required. Reserve materializers
before capturing import-sensitive indices. No second element decoder or JS
graph-copy path. The tail is stored only after successful slicing and consumed
and cleared before user code. Missing required carrier machinery is an explicit
compiler error, not silent loss. No new CodegenContext field or program-order
metadata; the existing per-compilation arity-registration lifecycle is retained.

Remove S7-o's temporary JS refusal for wide fixed over-application after native
execution proves argc/far extras for nine/fourteen-formal functions, with
under- and over-application. Its existing test now expects sum9 for 32 ones,
not TypeError; both A/B trees use the same final test. That is the only changed
old expectation. Shared native calling contracts/runtime bodies changed, not
frozen AST semantic bodies, drivers or AST selectors; no new IR coverage claim.

Measured against exact signed `6d189dfe2541da8676ffaa269b9382e91fde1bee`,
Node 24.4.1 / Vitest 3.2.4 fork harness, `--experimental-wasm-exnref`:

- New matrix **107/107**, with standalone and WASI executed against **empty
  import objects**, and JS-boundary calls. Counts0/1/4/5/6/8/9/14/32,
  numeric/prefixed rest, above-cap padding/extras, isolated dispatcher gaps,
  reentrant Proxy argument getters and exact thrown tokens are exercised.
  Combined **638 cases / 30 files: 569 passing / 69 failing → 623 passing /
  15 failing**, zero skipped, no status regressions. The 54 transitions are
  assertions, not independent defect counts. All 15 retained full errors match
  after tree/runtime-stack-line normalization. Three are additional tuple-rest
  compile-success failures on both trees; tuple rest is not certified. Two
  linked controls still stop at unavailable QuickJS execution.
- **33/33 full import inventories identical**, unchanged detector passes
  **437/452**, zero unknown/gap entries. Nine policy binaries match; twelve
  shrink 95 bytes each and twelve grow, by 377–4202 bytes. Four of six native
  binaries match; standalone/WASI dynamic controls grow **1499/1486 bytes**.
  All six remain import-free, return 42/7 and export no JS boundary probe.
  No overall footprint or performance win claimed.
- TypeScript7 typecheck, lint/format, LOC/function budgets, coercion/oracle,
  IR layering/fallback, flat/inventory checks pass. No new allowance, baseline,
  ceiling, detector or probe-population change. Shared-helper extraction and
  correction of a stale dispatcher comment keep the god-function budgets in
  bounds; flat codegen stays 833. Preservation-only dead exports retain six
  full/six cut witnesses, while strict closure still fails at the two recorded
  nonliteral dynamic imports. Both cycle gates retain the reported
  codegen→ir 298→301 and ir→codegen 74→75 failures, without waiver.

Runtime **10,235 → 10,230 lines** (−5), still 2230 above target;
resolveImport **1371/seven cases**, owned adapters 896, capabilities 1194.
Source/gate hashes, row transitions, retained errors, binary costs and exact
typed-boundary probe source/results:
`plan/audit/6979-native-argument-tails-20261019.json`.

**Next owner:** do not generalize numeric-rest success to full typed interop.
Fresh 32-input JS-boundary probes show boolean rest **5001→32001** and string
rest **5000→32003** (now expected). BigInt rest plus native Number conversion
still overflows the stack on both trees. A typed `{n:number}[]` rest formal
still cannot retain/use JS-owned object elements: the parent fails a property
access, the candidate an illegal cast. This is not a passing identity/mutation
test. Repair the live foreign-object representation/operations, not a copied
object graph or a widened frozen AST emitter. Attribute the BigInt mechanism
separately before choosing a fix.

Null receiver normalization, callback construct rejection, tuple-rest compile
failures, init-window/opaque bound callables, JS facade metadata, typed-array
identity/mutations/aggregate returns, prior primitive Object.assign/Math gaps,
raw-mode/runtime/source retirement, strict closure/cycles, prerequisite stack
and full equivalence/conformance/npm compatibility/accelerator/cost acceptance
remain open. The wider native tail is fixed; the migration is not complete.
Keep both migration issues in progress and PR6762 draft.

### S7-q IR object identity and live typed-object ABI handoff (2026-10-19, Codex)

Continue from signed `519578344261746f63ad25d8d6914dcee980b033`.
Trace typed object parameters/results and rest elements through actual IR
ownership, ABI adaptation and native field operations. The boundary must retain
the original JS object, live getters/prototypes, writes and round-trip identity;
casting to a closed native struct or materializing a copied graph is not the
requested model. Do not change selectors or frozen AST semantic bodies to
claim support. Record exact failing source and actual body routes before
choosing a shared representation/IR repair. The old deep-marshaling document
also contradicts this direction and must be reconciled, not used to authorize
copies. Full migration acceptance remains open.

**Measured diagnosis, not a typed-object ingress fix.** Simple typed
`read(input: {n:number})`, write, and typed echo receive IR bodies but their
public parameters remain native `(ref null $struct)` slots. JS-owned objects
are rejected before the body with `type incompatibility when transforming
from/to JS`. Native facade inputs unwrap correctly and preserve identity.
Dynamic `any` still updates the original JS object. Typed rest elements fail
in the native vector materializer with `illegal cast`.

The exact body ledger disproves an initial assumption: `irCompiledFuncs`
does not mean IR-only ownership. Read/write/echo have one direct and one IR
body emission; their prepared route is withdrawn as `param-signature-unstable`.
The stable-signature vocabulary explicitly excludes logical object types.
Do not weaken that guard or change selectors to pretend that an externref
entry and native object-field operations have been declared/proven.

**Implemented prerequisite:** IR previously rejected `===`, `!==`, `==`, `!=`
between two logical objects at operand lowering. A small IR producer now erases
only the physical shape and uses canonical native boxing/equality. It neither
reads/copies fields nor implements a second identity/coercion engine. Both
object operands use identity for abstract equality as well as strict equality;
boxing still classifies the actual carrier rather than stamping an Object tag
from its annotation. Native nullable-ABI controls pass. Source selection,
prepared admission, frozen AST bodies, native callable ABI and runtime.ts are
unchanged. This fixes a real IR body gap, **not** the foreign entry ABI.

Against exact published `519578344261746f63ad25d8d6914dcee980b033`,
Node 24.4.1 / Vitest 3.2.4 forks with `--experimental-wasm-exnref`:

- New IR identity matrix **32/32**, with standalone/WASI instantiated against
  empty import objects and native facade/null controls in JS. Scoped combined
  **670 cases / 31 files: 643 passing / 27 failing → 655 passing / 15 failing**,
  zero skipped or status regressions. All 12 transitions prove new actual IR
  comparison-body emission; native value behavior already passed on the
  parent's direct bodies. They are not 12 fixed JS-owned interop behaviors.
  All 15 retained normalized full errors match. No old expectation changes.
- A **separate 16-case typed-object diagnostic stays 5 passing / 11 failing**
  on both trees: four native/dynamic functional controls and one truthful
  overlay-route characterization pass; **every JS-owned typed-object case
  still fails**. The initial wrong exclusive-IR assertion was corrected after
  reading the ledger, not counted as conformance progress. Its exact source,
  expected/actual results, physical WAT, policies and counters are in the audit.
  `same` now emits an IR body too, but is still compile-twice, not prepared.
- All **33** complete policy import inventories **and binaries** match;
  unchanged guard passes **437/452**, zero unknown/gap entries. All six native
  control binaries match, retain zero imports, outputs 42/7 and no JS boundary
  probe export. The separate diagnostic fixture shrinks 266 bytes; no overall
  size/performance win is inferred from it.
- TypeScript7 typecheck, lint/format, LOC/function budgets, coercion/oracle,
  IR layering/fallback, flat/inventory checks pass. New producer is explicitly
  unmigrated/mixed-needs-split; flat codegen stays 833. No new detector, probe,
  baseline, ceiling or allowance. Preservation-only witnesses stay six full/six
  cut; strict modeled closure remains open at the two recorded nonliteral
  imports. Both cycle gates retain codegen→ir 298→301 and ir→codegen 74→75.

Runtime remains **10230 lines**, 2230 above target; resolveImport 1371/seven
cases, owned adapters 896, capabilities 1194. Evidence:
`plan/audit/6979-live-object-abi-and-ir-identity-20261019.json`.
The architecture contract at `docs/architecture/marshaling-contract.md` now
supersedes its old incoming deep-copy proposal and separates required ownership
semantics from what is actually implemented.

**Next implementation — foreign-capable native interop reference ABI:**

1. Declare the public interop carrier and callable artifact through prepared
   IR/Program-ABI planning, with exact source-unit, callable and type identities.
   The public entry cannot simply call the old GC-struct-only body with a JS
   object. Keep internal native fast paths only with native-origin proof.
2. Lower the same logical IR object operations over native-or-foreign references
   using the existing native Get/Set/equality engines. Any physical interop
   specialization must come from that same IR, not a JS implementation of the
   program or a hand-written field copier. This contract can also serve opaque
   wasm-to-wasm values; it is not a new JS semantic mode.
3. Propagate carriers through reachable calls, aliases, returns, object slots,
   vectors and rest elements. A foreign-capable entry must not pass an opaque
   JS object to a native-only typed callee. Validate final signatures and
   bindings before atomically publishing any entry/adapter metadata.
4. Do not ship a nominal native wrapper filled with defaults as a shortcut:
   current raw struct.get/struct.set would read/write those defaults, and brand
   tests/erasure could describe the wrapper rather than the original object.
   All reachable consumers and identity paths must honor any view representation.
5. Admission in wrapExports must preserve the original foreign object and use
   authenticated instance/ABI authority. No eager ownKeys/prototype/property
   reads, recursive materialization, or copied-record/name authority. Re-run
   the 11 negative cases for live reads/writes, aliases, inherited receivers,
   Proxy trap order, exact thrown tokens, round trips and rest contents.
6. Recheck the actual source body ledger; do not count an IR overlay or an ABI
   artifact as exclusive source ownership. Keep unknown/unsupported evidence
   explicit and preserve no-host native controls and binary costs.

This handoff does not close foreign-object/typed-array identity, BigInt/Number,
strict receivers, tuple-rest, opaque/init callables, source/raw-mode/runtime
retirement, strict closure/cycles, prerequisite resolution or full program
acceptance. Both migration issues stay in progress and PR6762 stays draft.

### S7-r explicit reference-object lowering (2026-10-19, Codex)

Continue from `ad1907e64cc732376ab116fcda0981b49f02a8e8`. Implement the
missing backend seam for lowering the same logical object IR over an explicit
reference ABI, rather than asserting that every source object is a GC struct.
Keep native-only lowering unchanged. Reference field operations must resolve
declared callable identities, never raw field reads on a foreign reference;
reference erasure, construction, locals, calls and results must agree on the
carrier. Exercise emitted Wasm with live JS-owned reference controls and empty-
import native controls. This is a backend prerequisite, not authorization to
relax source admission or publish a new public entry before whole-component
ABI planning and authenticated boundary metadata are implemented.

**Implemented backend prerequisite, not a public ingress fix.** The additive
layout contract selects an externref carrier for logical objects independently
of environment; an unsupported reference shape fails, never silently falls
back to a native cast. It resolves field providers by structural callable
identity. Native allocations still allocate their actual native struct once
and erase that reference, not a default-field wrapper or copied input graph.
Signatures, return values, SSA spill locals and IR-to-IR calls share the carrier.
The native-only path was moved intact out of the oversized lowering function;
no source/function allowance was added.

The critical effect obligation is explicit: `projectObjectReferenceFunction`
must run **before optimization**. It turns logical Get/Set into real declared
IR calls, preserving site/SSA/result identity and existing call effects. A
foreign getter may mutate state, reenter or throw; a late emitter override
cannot recover a Get already discarded/reordered as a native field load.
The backend refuses remaining raw reference-object field operations. This
projection is not a prepared-ownership token and must not be applied to an
already optimized/serialized source body as a supposed repair.

Against exact published `ad1907e64cc732376ab116fcda0981b49f02a8e8`,
Node 24.4.1 / Vitest 3.2.4 forks with `--experimental-wasm-exnref`:

- New backend matrix **26/26**. Source AST→IR read/store/echo/construction
  bodies execute as Wasm; reference Get/Set providers use native source IR
  for native allocations and test-scaffold primitives only for positively
  admitted JS-owned receivers. Normal/displaced coordinates, live aliases,
  calls/returns/erasure, native allocation spills, Proxy trap order, inherited
  receiver identity, reentrancy, exact thrown tokens, read-only writes and
  fail-closed contract mismatches are covered. DCE, GVN and scheduling retain
  unused Gets and noncommutative getter order. These providers are manually
  bound backend fixtures, **not authenticated production resource planning**.
- Existing **670 cases / 31 files stay 655 passing / 15 failing**, zero skips
  or status transitions; all 15 normalized full errors match. Four additional
  backend files stay **47 passing / 2 failing of 49**, with both normalized
  full errors identical (old Promise-emitter and phase-1-selector expectations).
  No old expectation edits or claims that the new tests repaired public ABI.
- All **33** full policy inventories and binaries match; unchanged guard
  **437/452**, zero unknown/gap entries. All **six** native control binaries
  match, retain zero imports, outputs 42/7 and no JS-boundary probe export.
- The public typed-object diagnostic remains **5 passing / 11 failing of 16**.
  Existing `compile()` entries do not select this contract. The same native
  handles/dynamic reference controls pass; typed foreign objects/rest still fail.
- TypeScript7, lint/format, LOC/function, coercion/oracle, IR layering/fallback,
  flat/inventory and issue gates pass; flat codegen stays 833. New files are
  explicitly unmigrated/mixed-needs-split. Preservation-only stays six full/six
  cut, but strict modeled closure still fails at the same two nonliteral
  imports; both cycle gates retain codegen→ir 298→301 and ir→codegen 74→75.
  No ceiling/probe/detector/baseline/allowance or frozen AST/selector changes.

Runtime remains 10230 lines (2230 above target), resolveImport 1371/seven,
owned adapters 896, capabilities 1194. Full evidence and limitations:
`plan/audit/6979-reference-object-lowering-20261019.json`.

**Next owner:** attach this pre-optimization projection to whole-component
prepared IR/Program-ABI planning, allocate exact native Get/Set resource
providers and reference-capable source/callable variants, then atomically
publish their authenticated entry metadata. Validate every reachable callee
and provider signature; names/annotations are not physical authority. Explicit
mutable physical slots, vectors/rest, object-containing fields, class storage,
captures, dynamic re-entry and foreign-capable return containers still require
representation/ownership planning. Do not expose a partially reference-capable
entry or relax `param-signature-unstable`. Preserve the 11 public negative
controls until source-to-Wasm acceptance actually improves. All S7-q remaining
work and full migration acceptance remain open; both issues stay in progress
and PR6762 stays draft.

### S7-s source write-mode and logical record contracts (2026-10-19, Codex)

Continue from signed `de036a4a4f71a208f816b5e7cf6610b66a2df63b`.
Connect the reference-object prerequisite to genuine source/preparation facts
and complete reachable callable contracts, not a backend fixture or relaxed
admission guard. Investigation found another required source fact currently
erased by fixed-field IR: strict versus sloppy assignment. A foreign setter
must throw on a refused strict write but retain the original RHS without
throwing in sloppy code. Preserve lexical write mode in source IR, reject
unknown mode during reference projection and bind the correct declared setter
before optimization. Then plan exact source/callee/provider identities and
physical carrier obligations across the whole reference component. Public
source interop, authenticated provider/entry publication and full migration
acceptance remain open until their real execution evidence improves.

**Checkpoint handoff: source facts implemented; component planning still open.**
All four source producers of fixed-field ObjectSet now retain the lexical
failed-write policy (`throw` or `ignore`). The neutral core field is optional
for native-only producers; absence is unknown, never implicitly strict at a
reference boundary. Reference projection requires an explicit policy and
resolves either the strict setter or a separately declared sloppy setter by
structural callable identity **before optimization**. Missing policy/provider
fails closed; a refused sloppy write does not become a strict TypeError.
Plain, compound, increment, chained and supported inline-with stores are
covered; inline-with coverage is metadata/projection only, not foreign with-
binding execution. No new host import or graph copier was introduced.

Strictness and raw-token directive analysis now have one frontend owner;
old codegen paths are compatibility re-exports. The raw-token predicate moved
unchanged. Enclosing arrows/accessors/constructors are now included in lexical
strictness inheritance. Four actual standalone/WASI probes (arrow/accessor,
two targets) change from -1 to 42 with empty imports on both trees. Their
source-body ledger remains direct, with no IR-owned functions on either tree:
this is a shared source-analysis correction, **not expanded IR body coverage**.
No frozen direct-AST body, selector or admission guard was extended.

Whole-program source capture now derives exact logical record signatures
from checker facts, including aliases, interfaces/inheritance, nested records
and instantiated generic aliases. Canonical field order, callable/export joins,
write policy and signatures survive preparation plus codec replay. Recursive,
expanding generic, optional, open-indexed, empty and unsupported union/nominal
contracts fail explicitly; generic expansion is depth-bounded. These are
logical contracts, **not proof of native origin, physical layout, own fields
or foreign entry authority**. The internal prepared driver rejects all three
read/echo/write probes at acceptance because physical record carriers are not
materialized. Public compile() admission and entry publication are unchanged.

Against signed `de036a4a4f71a208f816b5e7cf6610b66a2df63b`, Node 24.4.1 /
Vitest 3.2.4 forks with `--experimental-wasm-exnref`, two workers:

- Focused **73/73** candidate versus **36 passing / 37 failing of 73** on the
  exact parent with identical tests: 43 source/write cases, 26 prior reference
  cases and four actual native strictness cases. Of the 37 transitions, 33
  primarily establish source metadata/preparation/provider obligations; do
  not present them as 33 public interop fixes. Providers remain manually
  bound fixtures, not authenticated canonical production resources.
- Existing **670 cases / 31 files remain 655 passing / 15 failing**. Additional
  source/preparation/codec cases remain **66 passing / 2 failing of 68**;
  strictness compatibility cases remain **35 passing / 6 failing of 41**.
  Zero skips/status transitions, and all 23 normalized full errors match.
  Missing QuickJS artifacts account for some retained failures; no expectations
  were edited. No full Test262 or full-program acceptance claim.
- All **33** complete policy inventories and binaries match; guard stays
  **437/452**, zero unknown/gap entries. All **six** native control binaries
  match with zero imports, answers 42/7 and no JS-boundary probe export.
  Public typed-object diagnostic stays **5 passing / 11 failing of 16**, with
  the identical 131388-byte binary; all eleven typed foreign cases stay open.
- TypeScript7, lint/format, LOC/function, coercion/oracle, layering/fallback,
  flat/inventory and issue gates pass. No new allowance/baseline/ceiling or
  detector/probe change. The neutral data-only core leaf is clean; four new
  TypeScript frontend leaves remain explicitly unmigrated/mixed-needs-split.
- Preservation-only remains six full/six cut witnesses; strict modeled
  closure still fails at the same two nonliteral imports. The cycle gate
  **fails**, not waived: inherited codegen→ir 298→301 and ir→codegen 74→75,
  plus new frontend→ir 17→18, frontend→ts-api 2→5 and ir→frontend 7→9.
  Extraction makes ownership explicit but has not closed these dependencies.

Runtime remains 10230 lines, resolveImport 1371/seven cases, owned adapters
896, capabilities 1194. Exact paired rows, error/inventory hashes, negative
controls and gate results: `plan/audit/6979-source-reference-contracts-20261019.json`.

**Next owner, in implementation order:**

1. Plan the complete reachable source/callee/provider reference component on
   raw source IR, before hygiene/optimization. `prepareWholeIrProgram` output
   is already optimized; projecting that sealed packet cannot recover an
   unused Get. Start at raw source preparation/capture, not codec replay.
2. Allocate exact canonical native Get/Set resource providers (including
   strict/sloppy refusal, thrown-value/realm handling and reentry), then
   validate every reachable callable signature and publish authenticated
   entry metadata atomically. Preserve the eleven public negative controls
   until genuine source-to-Wasm execution improves. Do not relax
   `param-signature-unstable` or silently choose a native-only carrier.
3. Plan mutable slots, nested/container/vector/rest/class/capture carriers;
   audit equality against actual carrier proofs. A logical object annotation
   alone does not prove non-null native object identity or authorize using
   strict reference equality for loose `==` across a foreign boundary.
4. Cut the measured frontend/IR cycles, resolve strict closure and the earlier
   runtime/source/raw-mode retirement debt, then complete program acceptance.

The whole-component planner, canonical provider ownership and public typed
entry are **not implemented by this checkpoint**. Resolve the prerequisite
stack, including PR6701 and recovered S7-b `9423a71e82`, before any merge.
Both migration issues stay in progress; PR6762 stays draft for this handoff.
No GitHub issues or issue comments were created.

### S7-t pre-optimization reference component planning (2026-10-19, Codex)

Continue from signed `b0d73c4b9f3dfa4ee03c98cab2cae50db7c92bc9`.
Next implementation: connect the raw typed-program source/callee contracts
to whole-component reference planning before any optimizer runs. Enumerate
all reachable callable and property-provider identities, reject incomplete
or incompatible contracts, and retain getter/setter call effects. Logical
record annotations are not physical authority; no partially planned public
entry, copied graph, new host import, frozen AST extension or admission waiver.
Canonical native resources and authenticated publication remain required.

**Implementation now in the real preparation transaction.** Internal whole-
program callers may request `objectReferenceProjection: "live"`. Raw typed
input carries a logical `objectReferences` plan, derived from the complete
current IR/type/allocation/global population rather than a selected entry's
annotation. Source/callee aliases retain their existing structural identity.
The one Program ABI declares exact Get/strict-Set/sloppy-Set contracts for
each planned shape/field. Unknown requests, incomplete shape populations,
unknown direct callees and shape/result-mismatched calls fail before hygiene;
the tests assert zero optimizer function visits for invalid direct calls.

Get/Set projection now has a backend-free preparation owner. The old backend
API is a compatibility adapter, not a second implementation. Projection covers
nested instruction buffers and semantic async-state bodies, retains source
SSA/result/site identity and selects strict/sloppy setters explicitly. The
prepared plan is regenerated after transforms, frozen with the program,
validated against the exact ABI, and preserved/rechecked on codec replay.
This is logical declaration/early effect planning, **not a physical resource
receipt**. Source-body call effects, not backend emitter overrides, keep an
otherwise-unused foreign getter alive through normal program optimization.

The boundary gate initially rejected a program→mixed-backend dependency. It
was fixed by separating pure semantic preparation from the backend adapter,
not by granting an exception or weakening layer rules. Four new program
modules have clean dependency closures (core/program/runtime data only),
with no TypeScript, codegen context, backend handles or resource emitter.
Inventory and IR layering pass; no new allowance, ceiling, baseline, detector,
frozen AST, selector or public admission change.

The new 17-case matrix exercises genuine source preparation, imported callee
aliases, nested record contracts, codec authentication, an unused getter and
noncommutative getter order, exact thrown tokens, live reference identity,
strict refusal and genuine sloppy-script assignment. Execution of projected
record bodies still uses a **test-only physical binding** to admitted foreign
primitives; it is not production provider authentication. Separate scalar
controls emit and execute in both WasmGC/standalone and linear/WASI, with zero
imports and identical bytes for projection off/on.

Four identical existing-API source probes against signed
`b0d73c4b9f3dfa4ee03c98cab2cae50db7c92bc9` show the actual frontier: parent
discarded the unused Get and declared zero reference providers; candidate
retains one real call and declares three exact provider contracts. Strict and
sloppy writes similarly become their different declared calls; nested echo
plans both record shapes and six field-provider contracts. **All four still
fail physical acceptance**, now explicitly including missing provider slots.
There is no claim of new public typed-object acceptance.

**Next owner:** materialize canonical native property resources and their
actual carrier/layout/allocation obligations in the reservation ledger, then
publish authenticated boundary entries atomically. Typed fixed-field native
structs cannot simply be assumed to be canonical ordinary objects with
descriptor/prototype semantics. Choose actual native allocation ownership,
preserve native/foreign receiver identity and throw/realm/reentry behavior,
and never substitute a copied graph or default-field wrapper. The current
plan declares all three operation contracts per field; it does not establish
their physical costs or certify unused provider elision.

A foreign getter can also return a value outside its annotated field type.
The primitive fixtures do not certify that value contract: a JS→Wasm `f64`
import can coerce a non-number. Production providers must establish actual
value carriers without laundering such coercions into source semantics;
missing fields, undefined/null, non-numbers and dynamic getter results need
explicit checked/dynamic representation tests before public admission.

Direct-call signature closure is checked, but captured/indirect callable
representation, mutable/container/vector/rest/class storage, native origin
proofs and actual-carrier equality still need physical planning. No public
entry may rely on this logical plan alone. Prior cycle/strict-closure,
source/raw-mode/runtime retirement, prerequisite-stack and full acceptance
obligations remain open. Both migration issues remain in progress.

**Measured checkpoint, not migration completion.** Node 24.4.1 / Vitest 3.2.4
forks, two workers, `--experimental-wasm-exnref`, exact parent
`b0d73c4b9f3dfa4ee03c98cab2cae50db7c92bc9`:

- New preparation matrix **17/17**; prior reference/write/native strictness
  matrix **73/73**. These are distinct from public interop acceptance.
- Fresh paired existing cohort **779 cases / 38 files**, both **756 passing /
  23 failing**, zero skips/status transitions; all 23 normalized full errors
  match. No existing expectation edits or full Test262 claim.
- All **33** complete policy inventories and binaries match; guard **437/452**,
  zero unknown/gap imports. All **six** native binaries match with zero imports,
  results 42/7 and no JS-boundary probe export. Separate public typed-object
  diagnostic stays **5 passing / 11 failing of 16**, identical 131388-byte binary.
- Size/function, coercion/oracle, typecheck/lint/format, layering/fallback,
  flat/inventory and issue checks pass without new allowances or policy-edge
  relaxations. Runtime remains 10230 lines; resolveImport 1371/seven cases,
  owned adapters 896, capabilities 1194. No overall size/performance gain claimed.
- Preservation-only stays six full/six cut, but strict modeled closure remains
  open at the same two nonliteral imports. Both cycle gates retain the five
  pairs recorded in S7-s, including its frontend dependencies; no waiver and
  no graph-closure or retirement certification.

Exact source/gate hashes, all retained failures, existing-API probe rows,
complete-inventory hashes and binary costs:
`plan/audit/6979-reference-program-planning-20261019.json`. PR6762 remains draft;
resolve the same prerequisite stack before any merge. No GitHub issues or
issue comments were created.

### S7-u canonical native property/construction resources (2026-10-19, Codex)

Continue from signed `e16a3ab88cf34cf0e308f23c695bd1b1dcd957dd`.
Replace the remaining test-only field binding prerequisite with real owned
native resources, starting at canonical ordinary-object operations and native
construction ownership. Reuse the one semantic implementation; preserve
descriptor/prototype behavior, receiver identity, explicit strict/sloppy
refusal, exact setter/getter throws and realm/reentry. Unknown foreign/native
carrier cases stay explicit gaps, not successful empty/default field paths.
No new host import, copied graph, frozen AST body/selector expansion or public
entry publication before full resource/callee/storage ownership is proven.

#### S7-u checkpoint handoff — source construction facts only

Published in [refactor(codegen): separate native semantics from JS host mode](https://github.com/loopdive/js2/pull/6762).
This checkpoint stops at source facts; it does **not** implement the proposed
native construction resource or complete the migration. Keep this issue and
the parent migration issue in progress, and the PR draft pending the existing
prerequisite stack and acceptance gates.

Completed:

- Preserve object-literal insertion order independently of the existing sorted
  field layout and operand coordinates. Source evaluation/storage behavior is
  unchanged. Tag noncomputed colon `__proto__` initializers separately from
  computed/shorthand data properties, and tag method home-object requirements.
  These tags record unresolved requirements, not new semantic support.
- Record index-free producer facts on allocation identities. Clone detached
  facts through inlining and specialization, including their source-origin
  paths; do not clone SSA-dependent ownership/escape/encoding evidence.
- Retain facts through preparation/snapshot/codec replay. Check their schema,
  live object owner and exact field-key permutation. This is structural
  validation, not authentication of source order, runtime origin, a physical
  carrier or a provider. Missing facts must remain an explicit construction
  gap; callers without an allocation registry cannot manufacture authority.
- Extract only the neutral object.new instruction/arity construction from the
  builder; preserve the preflight-before-identity-allocation error behavior.
  Inventory the new files; activate the exact pure allocation-clone helper,
  without changing allowed dependency edges, existing roots or count floors.

Next implementation owner:

1. Join genuine prepared `object.new` instructions, live object allocations,
   source facts, SSA operand types and runtime projection before issuing a
   construction requirement. Source order can differ for the same storage
   shape, so it must participate in constructor identity. Reject missing,
   stale, special-prototype and method requirements until their owners exist.
2. Compose existing canonical storage `createWithPrototype`, descriptor
   `defineData` (all value/writable/enumerable/configurable bits specified,
   mask 191), and actual native value/boolean/string owners. Install properties
   in source order; preserve nested object references without copying. Do not
   add a second descriptor/Set implementation or use JS stand-ins as receipts.
3. An explicit-prototype inner kernel is only a prerequisite. The full native
   Object/Function realm is still declaration-only: its completion check
   explicitly rejects unfinished algorithms/runtime population. Default storage
   with null prototype and flags zero is an unresolved implicit-prototype state,
   not Object.prototype or an explicit-null certificate. Never silently replace
   a source literal's default prototype with null or a fake empty object.
4. Positively exercise genuine record-source ownership and zero-import native
   construction with displaced reservation indices. The existing descriptor
   fixture's getter-only source cannot certify record-allocation demand.
   Authenticate same-program storage/descriptors/value packs and canonical
   fill/completion receipts before testing a combined provider.
5. Complete actual field-value carriers (missing/undefined/null/non-number and
   dynamic getter results), canonical Get/strict-Set/sloppy-Set, callable and
   storage closure. Test-only f64 imports coerce foreign results and are not
   production value proof. Only then wire physical acceptance and atomically
   publish boundary entry metadata; no selector or frozen AST expansion.

The prior S7-t audit remains historical evidence for signed `e16a3ab8`, not a
claim that construction is done. The final checkpoint verification below
records the current reruns separately. No GitHub issues/comments were created.

#### S7-u final checkpoint verification

- Node24.4.1 / Vitest3.2.4, two fork workers with Wasm exception references:
  **135/135 focused tests**, including **10 new source-construction tests**,
  the prior 90 reference cases and 35 allocation/clone/replay cases.
- Reran the exact **38-file / 779-case** existing population: **756 passing,
  23 failing**, zero skips/status transitions. All 23 normalized full errors
  match the retained post-commit `e16a3ab8` report; no fresh parent checkout
  was run for this handoff. No old expectations changed; no full Test262 claim.
- All **33** policy binaries/complete inventories and **six** native controls
  exactly match the retained `e16a3ab8` artifacts. Native controls execute on
  standalone and WASI, have zero imports and return 42/7. The separate public
  typed-object diagnostic remains **5/16 passing, 11 failing**, with the same
  131388-byte binary. No new public interoperability coverage is claimed.
- TypeScript7, lint, size/function, coercion/oracle, layering, fallback,
  flat-directory and issue checks pass. Inventory is valid; architecture is
  incomplete. No new allowance, baseline, allowed-edge or floor changes.
- **Cycle gate remains red**, with two new source-boundary edges versus S7-t:
  frontend→ir 18→19 and ir→frontend 9→10. Against the gate baseline the five
  pairs are codegen→ir 298→301, ir→codegen 74→75, frontend→ir 17→19,
  frontend→ts-api 2→5, ir→frontend 7→10. No cycle waiver is added. Cut these
  dependencies before claiming architecture completion or merge readiness.
- Preservation-only remains **six full / six cut**. Strict modeled closure is
  still open at the same two nonliteral imports (`optimize.ts` and the platform
  capability adapter); retirement/deletion is not certified. Runtime remains
  10230 lines. No overall size/performance or migration-completion claim.

Machine-readable source/report hashes and counts:
`plan/audit/6979-source-construction-handoff-20261019.json`.

### S7-v native record initialization resource (2026-10-19, Codex)

Continue from signed `4493f10dcf922dbe2cf620c0e80f576ba818796f`.
Implement a genuinely owned explicit-prototype initialization prerequisite from
actual prepared record allocations and source construction facts. Compose the
existing canonical storage/descriptor/value owners, rather than a new property
semantic engine. Verify native execution and ownership negatives. Keep default
realm completion, source special-prototype/method requirements, actual foreign
field carriers and public physical admission explicitly open; an inner kernel
is not completion of the full migration.

Source-census caution found during S7-v: the probe
`export function make(){return {method():number{return 1;}};}` prepares a
void/empty `make` plus a lifted constant method, not an observed object
allocation. Do not count this as a passing method-construction negative or as
an absence proof. Investigate inferred return-type handling before general
source acceptance. The constructor test instead uses an explicit numeric
return and an actually invoked method; it observes both semantic/projected
object.new occurrences before requiring the method-construction gap.

#### S7-v implementation and verification

Completed the **explicit-prototype initialization prerequisite**, not default
source construction or public entry publication:

- Derive demands from genuine prepared object.new occurrences in both semantic
  and selected runtime views. Check instruction/buffer coordinates, exact live
  allocation/type, unique canonical allocation, source key permutation and SSA
  operand/field types. Authenticate issued requirements through the existing
  complete property census; copied requirements and detached inputs fail.
- Own constructor slots in the existing physical reservation ledger. Require
  the exact descriptor/access owner and its canonical storage, SameValue,
  native strings, value and error dependencies. Preflight the complete key set,
  recheck the plan/dependency identities, and require canonical dependency fills
  before constructing. Caller-filled placeholders are not completion receipts.
- Compose canonical createWithPrototype, defineData (mask 191), number boxing
  and Boolean boxing using the actual owned primitive type. Preserve native
  strings and nested live references; install fields in source order while
  keeping existing operand coordinates. No second property engine, host import,
  recursive copy, selector expansion or public acceptance change.
- Fix structural fact validation to reject duplicate logical fields: matching
  keys against duplicated fields was not a complete permutation check.
- **13/13 new tests**, plus the prior **135/135** reference/source/allocation
  cases. Three zero-import WasmGC instances exercise actual owned resources,
  displaced indices and decoded/reissued source requirements: both source-order
  variants, 12-field table growth, all own descriptors/sequences, inherited
  read-only properties, explicit null/native prototypes, live identity,
  true/false, -0/NaN/Infinity, and foreign prototype/string wrapper rejection.
  Observer wrappers do not authenticate production entry publication.
- Separate existing resource population: fresh exact-parent `4493f10d`
  checkout and candidate both **147 passing / 14 failing of 161** across three
  files, with identical normalized full errors. The failures are preservation
  receipt/dependency mismatches; no old expectations were changed or skipped.
- Existing **779-case / 38-file** rerun remains **756 passing / 23 failing**,
  identical normalized full rows against the retained post-commit `4493f10d`
  report. All **33** policy binaries/inventories and **six** native controls
  match; public typed-object diagnostic stays **5/16 passing, 11 failing**,
  identical 131388-byte binary. No full Test262 or production interop credit.
- Typecheck/lint/format, incremental size/function, coercion/oracle, layering,
  fallback, flat-directory and inventory checks pass without new allowances or
  allowed-edge/floor changes. One exact new backend resource root is activated.
  **Cycle gate remains red:** backend→ir is now 115→117, adding a sixth failing
  directory pair; the other five S7-u pairs are unchanged. No waiver. Strict
  modeled closure retains the two nonliteral imports; preservation-only six
  full/six cut does not certify retirement.

Exact source/report hashes and executable binary costs:
`plan/audit/6979-native-construction-resource-20261019.json`.

Still required: complete the actual default Object/Function realm (all eligible
record demands retain that gap), source prototype setters/method requirements,
actual foreign/dynamic field carriers, canonical property-provider wiring and
callable/storage closure, then atomic authenticated physical/public entry
publication. The new kernel is WasmGC-specific; equivalent Linear/WASI native
construction remains open, not claimed by unchanged scalar/native controls.
Investigate the inferred-return erasure above and cut architecture cycles.
The migration and both issues remain in progress; the PR remains draft and
must not be merged independently of its existing prerequisite stack.

### S7-w inferred source return contracts (2026-10-19, Codex)

Continue from signed `a5004601dd6efb537e8ba53c1cd08c58a235a306`.
Fix whole-program source preparation treating an unrepresentable inferred
return as void. Preserve representable return values and their construction
demand; distinguish an actual void contract from an unknown/unsupported result.
Do not obtain an empty census by erasing returned records or runtime effects.
Keep explicit unsupported results honest while completing the semantic owners;
no frozen AST/selector expansion, new host import, graph copy or premature
boundary publication.

#### S7-w verified implementation and handoff

The scalar lattice's null conversion means **unknown/unrepresentable**, not
void. Whole-source preparation now distinguishes it from checker-certified
void and a proven undefined-only return. Source data-record inference preserves
the complete nested shape and Boolean brands; inferred empty records have an
actual object.new/constructor demand, not an empty function. Explicit empty
object annotations remain ambiguous and do not acquire carrier authority.
Callable inference stays intact and its syntax/type selection moves into the
existing frontend owner. The source driver shrinks; no new module, allowance,
selector/frozen AST expansion, host import or physical entry publication.

Known literal undefined keeps its existing zero-result ABI, verified by actual
execution on both no-host backends. That bounded proof checks the canonical
undefined symbol (or actual void expression), not an arbitrary annotation or
cast. First-class undefined values/consumption remain a separate native value
carrier obligation; this is not a general Undefined value implementation.

Exact-parent `a5004601dd` versus candidate, Node24.4.1 / Vitest3.2.4:

- **15/15 new cases**, **184/184 focused overall** (includes the prior reference,
  source, allocation, construction and getter-result cases). Actual zero-import
  scalar/direct-call execution returns 42/7 on standalone and WASI; known
  undefined returns undefined. Empty/deep record allocations survive preparation
  and codec replay, and join the real constructor census. A decoded/offset
  zero-field constructor executes through canonical native resources, preserves
  explicit prototypes and inherits properties without inventing own fields.
- Fresh paired source probe, **nine rows per tree**: parent deep/empty factories
  emit accepted 52/51-byte functions that return undefined instead of objects.
  Candidate retains four/one object allocations and their constructor demands,
  and physical acceptance correctly refuses the missing default-realm/carrier
  ownership. This removes false acceptance; it is not new public object support.
  Scalar binaries remain identical 85-byte modules on both targets; proven
  undefined retains the identical 51-byte zero-result binary. Inferred Boolean
  record contracts now agree with the actual Boolean brand (two logical shapes
  collapse to one), not a claim of physical size/performance improvement.
- Method/cast-to-undefined unknown returns become located unsupported results,
  not void. The parent's method/cast rows also throw a native realm literal-plan
  ownership error during physical acceptance; that is captured as an error, not
  green evidence or a claimed general fix to realm literal ownership. The any
  parameter probe remains unsupported on both sides and earns no improvement
  credit. Negative tests allow future correctly retained values, not permanent
  refusal pins.
- Existing **779 cases / 38 files** remain **756 passing / 23 failing** against
  the retained published-parent report, with identical normalized full rows.
  Fresh exact-parent and candidate resource populations remain **147 passing /
  14 failing of 161** across three files, with identical full errors. Zero
  skips/transitions; no old expectations changed and no full Test262 claim.
- All **33** complete policy inventories/binaries and **six** native control
  binaries remain identical. Public typed-object diagnostic stays **5/16
  passing, 11 failing**, same 131388-byte binary. Typecheck/lint/format,
  size/function, coercion/oracle, layering/fallback, flat/inventory and issue
  checks pass with no new allowances, roots, floors or allowed-edge changes.
- The same **six** cycle pairs remain red, with unchanged output versus S7-v;
  no waiver. Strict modeled closure retains the two nonliteral imports;
  preservation-only six full/six cut does not certify retirement. Runtime stays
  10230 lines. Migration/default-realm/public-entry completion is not claimed.

Evidence and source/report hashes:
`plan/audit/6979-inferred-return-contracts-20261019.json`.
The earlier S7-v inferred-return caution is now addressed for these measured
source cases. Default Object/Function realm completion, source method/prototype
semantics, actual foreign field carriers, provider/callable/storage closure,
Linear/WASI record construction, architecture closure and the prerequisite stack
remain open. Both issues stay in progress and PR6762 stays draft.

### S7-x realm-aware record allocation (2026-10-19, Codex)

Continue from signed `3cd3cbc36932521873b684f86fb7cafb8dceb77a`.
The actual ordinary realm subtype has a seventh state field, but the existing
record initializer allocates the six-field storage root. Join record allocation
to the issued realm layout owner, retaining the existing descriptor/storage
engine and explicit prototype operand. Require exact shared storage layouts and
canonical realm-state initialization; never infer completed intrinsics from a
non-null realm anchor. Keep the existing non-realm recipe byte-identical.
Default-realm publication, mixed prototype admission, full Object/Function
population and Linear/WASI construction remain required, not waived.

Readers/mutators checked before this change: construction declarations,
reservation/currentness/fill/completion all live in the construction resource
owner; its only external callers are the construction fixture and tests. Realm
layout identity/currentness/completion remain with their existing owner. The
runtime definition only composes storage initialization and canonical field
definition; no selector or frozen AST path is changed.

#### S7-x verified implementation and handoff

The actual construction resource can now borrow an issued realm layout owner
from the **same canonical own-storage layout/plan**, allocate its ordinary
subtype, and retain a fresh ObjectState with the explicit prototype and current
realm allocation. The six-field prefix is canonical explicit-null own storage;
prototype traversal belongs to mixed-object operations, not a duplicate storage
chain. Existing canonical DefineData still installs fields in source order.
Absent state preserves the old recipe and binaries. A descriptive stateful
recipe cannot authorize a stateful allocator without the genuine owner.

The new state allocation requires canonical realm-layout completion before
filling its functions, and traps at runtime if the realm identity anchor is
missing. It deliberately does not require/select Function.prototype for an
explicit prototype. A non-null anchor still does **not** certify standard realm
population, prototype admission, a default prototype or a public provider.
Test-only raw state observers are not the semantic SetPrototypeOf algorithm.

Measured at parent `3cd3cbc36932521873b684f86fb7cafb8dceb77a`, Node24.4.1 /
Vitest3.2.4, two forks with Wasm exception references:

- **9/9 new, 69/69 focused** cases pass. Real source construction demands,
  including offset/codec replay, execute with zero imports, independent object
  and state identity, shared immutable realm identity, live explicit prototypes,
  canonical Boolean/string/reference fields and twelve-field storage growth.
  Empty records retain an actual allocation and state without a Boolean helper.
  Copied/foreign/same-ledger-different-storage owners, hidden/accessor/inherited
  roles and a stateful recipe without its issuer are rejected before reservation.
- Four executed binary witnesses: ordinary base **15840 bytes**, displaced and
  decoded **16309 bytes**, decoded empty record **15420 bytes**. These are full
  test instances with observers, **not marginal production overhead**. Default
  prototype gaps remain three/one for normal/empty sources.
- The old three construction binary witnesses are byte-identical (15227/15696/
  15696 bytes). All **33** full policy inventories/binaries and **six** native
  controls are unchanged. No new host import, module/root/allowance, selector,
  frozen AST expansion, copying or public boundary admission.
- Existing **779 cases / 38 files** stay **756 passing / 23 failing**. Existing
  resource **161 cases / three files** stay **147 passing / 14 failing**.
  Full result rows/errors match the retained published-parent reports exactly;
  these are retained-report comparisons, not fresh parent checkouts this turn.
  No skips, old expectation changes, full Test262 or conformance gain claimed.
- Typecheck/lint/format, size/function, coercion/oracle, layering/fallback,
  flat-directory and issue checks pass. Inventory is valid, architecture
  incomplete; the same six cycle pairs remain red. Preservation-only checks
  pass, but strict closure still has the same two nonliteral imports and does
  not certify retirement. No waiver.

**Measurement correction to S7-w:** its ad-hoc source probe passed only backend
and target to `acceptPreparedIrProgram`, omitting required resolved options,
including `utf8Storage`. Its method/cast literal-plan exception is therefore not
evidence of a normal consumer ownership bug. A fresh paired input control on the
same genuine captured-call program executes with complete options (94, zero
imports), and reproduces the literal-plan exception only with incomplete API
input. Keep the literal owner authentication strict. Earlier binary/return
measurements remain historical evidence with that instrumentation limitation;
do not infer broad physical support from their incomplete option bags.

Exact source/report hashes, complete new case names, four binary witnesses and
the paired options-control results:
`plan/audit/6979-realm-record-construction-20261019.json`.

Next: implement actual Object/Function algorithms and singleton population;
join the stateful allocator to authenticated mixed prototype/value admission
and canonical property providers, then atomically publish source/public entries.
Default realm, special source prototype/method semantics, foreign/dynamic fields,
first-class undefined, callable/storage closure, Linear/WASI construction and
architecture/retirement gates remain open. Both issues stay in progress and
PR6762 stays draft, behind its existing prerequisite stack.

### S7-y native numeric SameValue (2026-10-19, Codex)

Continue from signed `7d7f8c88c8c77ec2d07216ac1b35dbeccd09a5c6`.
Before publishing Object.is/realm descriptor algorithms, verify the existing
native SameValue numeric arm against distinct NaN payloads. The current bit-only
comparison appears to confuse NaN representation identity with language value
equality. Correct the genuine native semantic owner, including non-configurable
descriptor redefinition, while preserving signed zero and frozen legacy bytes.
No host import, selector expansion or default/public realm completion claim.

Readers checked: the pure body has the native SameValue resource producer, the
frozen direct-AST producer, historical donor/write fixtures and the BigInt port
test. Only the issued native producer will select corrected numeric semantics;
the historical recipe must remain byte-identical until separately retired.

#### S7-y verified implementation and handoff

The issued native SameValue producer now handles two actual Number NaNs as
equal before delegating to the shared complete primitive/reference recipe.
The guard checks both native Number brands before unboxing, so it does not
coerce undefined/null/Boolean/BigInt values into NaN. Finite values and signed
zero retain their existing comparison. Descriptor redefinition uses this same
owned kernel, not a second property engine or a JS callback.

The historical pure recipe is under source-custody receipts, so it remains
untouched. The correction lives in one clean native-runtime definition module
imported by the existing native producer. No new physical resource/root,
allowance, policy-edge relaxation, selector or frozen AST expansion is needed.
Keeping historical compilation byte-identical is not a claim that its existing
NaN-payload defect has been repaired; it remains frozen pending retirement.

Evidence at signed parent `7d7f8c88c8c77ec2d07216ac1b35dbeccd09a5c6`, Node24.4.1 /
Vitest3.2.4, two forks with Wasm exception references:

- A real native carrier round trip retains each of three distinct NaN payloads
  (including opposite signs). In the paired nine-pair probe the parent gives
  wrong SameValue/redefinition results for **six of nine** pairs, throwing the
  actual shared TypeError tag. The candidate equates **all nine** pairs and
  permits all nine non-configurable redefinitions, matching the Node oracle.
  The nine signed-zero/finite/infinite controls remain correct on both trees.
- **40/40 new cases** pass at ordinary/displaced indices, covering the NaN
  matrix, actual descriptor writes, signed zeros, finite/infinite/subnormal
  controls, NaN/non-NaN pairs and brand separation. Alongside the previous
  construction/realm/inferred-return and wide-BigInt cases, **120/120 focused
  execution cases** pass. All instances reject unexpected provider imports.
- The resource cohort remains **147 passing / 14 failing of 161**, with
  identical full rows against the retained published-parent report. The
  historical custody cohort is **9 passing / 26 failing of 35** on both a fresh
  exact-parent checkout and the candidate, with identical normalized full
  errors. Existing receipts/expectations are not changed, skipped or waived.
- Existing **779 cases / 38 files** remain **756 passing / 23 failing**, with
  identical full rows against the retained published-parent report. No full
  Test262, public Object.is, general host interop or conformance gain claimed.
- All **33** complete policy inventories/binaries and **six** native compiled
  controls stay identical. The four actual stateful construction instances
  remain zero-import and preserve their observed behavior; each grows by
  **37 bytes** to 15877/16346/16346/15457 bytes. These are measured resource test
  modules with observers, not an overall performance/production-size claim.
- Typecheck/lint/format, size/function, coercion/oracle, layering/fallback,
  flat-directory and issue checks pass; inventory valid, architecture
  incomplete. The same six cycle pairs remain red. Preservation-only checks
  pass, but the same two strict-closure nonliteral imports prevent retirement
  certification. No new waiver or completion authority.

Exact source/report hashes, paired payload rows, unchanged-failure hashes and
four binary witnesses:
`plan/audit/6979-native-same-value-nan-20261019.json`.

Next: use the corrected kernel in the actual Object.is/catalog algorithm
owner, with genuine argument transport and Boolean result carriers. Full
Object/Function algorithms/population, authenticated mixed prototype/value
admission, canonical providers, source/public publication, Linear/WASI record
construction and architecture/retirement closure remain required. Both issues
stay in progress; PR6762 stays draft behind its existing prerequisite stack.

### S7-z owned Object.is catalog algorithm (2026-10-19, Codex)

Continue from signed `fa5f5ef74f496df0ac9efc0824b00fc7d6d064e5`.
Connect the corrected SameValue kernel to the actual Object.is algorithm slot:
genuine full-catalog requests, actual shared Call argument transport, canonical
undefined for omitted arguments and an issued Boolean result boxer. Give this
algorithm its own canonical completion owner so it can execute without dummy
bodies for the remaining catalog; let full realm declarations borrow that exact
slot. Keep whole-realm/source/public admission closed until their remaining
owners are complete. This does not certify raw host primitive entry or foreign
reference identity that has not passed the native value boundary contract.

Readers/mutators enumerated: realm dependency capture, key preflight, entry
reservation, currentness, expected-input comparison and declaration inventory
all live in native-object-realm. Native primitive source association belongs to
the native-values producer; it already imports the value-plan authenticator.
Argument layout/currentness and canonical completion belong to the existing
invocation substrate. No selector/frozen AST or catalog availability relaxation.
The mixed-object dependency descriptor reader also recognizes the optional
algorithm owner and delegates its authentication to the realm owner; its
source/provider admission and completion barriers are not changed.

#### S7-z verified implementation and handoff

The Object.is algorithm now has a canonical resource owner for its actual
catalog slot (`%Object.is%:algorithm`). It reads the first two arguments from
the genuine shared Call vector, selects canonical undefined by actual argument
count (not spare null cells), calls the existing corrected SameValue owner,
and boxes the Boolean result through the issued native primitive owner.
The original receiver and excess arguments are ignored, including across real
argument-vector growth. No extra property engine, host callback or graph copy.

The primitive producer checks the exact prepared program/projection association;
equal source data, layouts or signatures do not confer authority. Both source
coordinate fields and dependency roles must be visible own data fields, with
no getter invocation. The shared argument/string owners, native values,
SameValue dependencies and Boolean boxer must all be genuine and canonically
complete before this algorithm is filled. Caller-filled bodies do not certify
completion, and changed dependencies/body headers are rejected.

Full realm declarations may borrow that **exact same reservation**, authenticated
against the same catalog issuer, rather than allocate a second slot. The
mixed-object dependency reader preserves this association too. No other
algorithm body is fabricated, and whole-realm completion still refuses the
missing algorithms/population. Catalog availability, source selectors and
source/public entry admission are unchanged. The completion scope is explicitly
native-value-ABI only: raw host primitive/reference entry still needs its actual
boundary carrier/identity owner. This is not general host Object.is support.

Measured at parent `fa5f5ef74f496df0ac9efc0824b00fc7d6d064e5`, Node24.4.1 /
Vitest3.2.4, two forks with Wasm exception references:

- **56/56 new cases**, **183/183 focused cases** pass. Three actual zero-import
  instances cover ordinary/displaced indices, decoded source and allocating/
  interned Boolean carriers. They distinguish omitted/null values, signed zero,
  NaN, finite/infinite/subnormal numbers, Boolean/Number brands, full-width
  BigInts, native Symbol/reference identity and equal Strings with distinct
  carrier identity. The final new-case rerun also proves actual mixed
  UTF-8/UTF-16 String equality; raw observer brand tests distinguish the two.
- Same-ledger alternate argument transport, a different genuine decoded program
  with the same transport/literals, copied opaque owners/equal dependency data,
  dependency mutation, malformed source/role descriptors, duplicate slots and
  caller-filled bodies are rejected without new reservations. The real catalog
  borrows this slot exactly once and still cannot certify the incomplete realm.
- Existing **779 cases / 38 files** remain **756 passing / 23 failing**; resource
  **161 cases / three files** remain **147 passing / 14 failing**. Full rows
  match the retained published-parent reports; no fresh parent checkout this
  turn, skips, receipt rewrites or expectation changes. No full Test262 credit.
- All **33** full policy inventories/binaries and **six** native compiled
  controls remain identical. The three new algorithm witnesses are full
  resource test modules with observers, not production marginal-cost or
  public source-entry measurements.
- Typecheck/lint/format, size/function, coercion/oracle, layering/fallback,
  flat-directory and issue checks pass. One clean backend resource module is
  added behind existing roots; no allowance, root or allowed-edge relaxation.
  Inventory remains valid, architecture incomplete. The same six cycle pairs
  remain red. Preservation-only checks pass, but strict closure still has the
  same two nonliteral imports and retirement is not certified; no waiver.

Source/report hashes, exact case names and three binary witnesses:
`plan/audit/6979-native-object-is-algorithm-20261019.json`.

Next: complete the remaining catalog algorithm owners, genuine lifted calls and
singleton/property population before publication. Native foreign-value identity
and dynamic fields, general first-class undefined, canonical mixed property
providers, source special prototype/method semantics, callable/storage closure,
Linear/WASI construction and architecture/full retirement acceptance remain
required. Both issues remain in progress; PR6762 remains draft behind its
existing prerequisite stack.

### S7-aa base catalog callable algorithms (2026-10-19, Codex)

Continue from signed `ab3e6a543e4b22b84dc8aedd991f95353bee9b2f`.
Implement the actual `%Function.prototype%` and `%ThrowTypeError%` algorithm
slots against the full catalog issuer, canonical native undefined/TypeError
owners and exact public exception owner. Reuse the existing pure algorithm
definitions, without creating a parallel realm or implementing dummy bodies
for other slots. Full declarations should borrow these exact reservations;
whole-realm completion and source/public admission remain closed.

Readers/mutators: native-object-realm owns dependency capture/currentness,
resource-key preflight, algorithm reservation, inventory and declaration
completion. Native-mixed-object-access also reads realm dependency descriptors
and must recognize/authenticate the new optional owner. The existing builtin
algorithm definition reads only undefined, error literals, the TypeError
constructor and exception tag; narrow its operand type, not its emitted body.

#### S7-aa implementation and handoff

The full catalog's `%Function.prototype%` and `%ThrowTypeError%` algorithm
reservations now have a canonical owner in native-object-realm. The former
returns the genuine native undefined singleton; the latter creates the issued
native TypeError and throws through the exact public exception tag. Neither
inspects the receiver or argument contents. Both use the actual shared Call
vector signature. Canonical completion authenticates the exact source-bound
value owner, argument/string owners, TypeError producer and public exception
issuer; caller-filled slots and altered dependencies or bodies do not certify
completion. No unrelated operand placeholders or second algorithm engine.

Full declarations borrow those exact slots once, alongside the existing
Object.is owner. The mixed-object dependency reader recognizes the optional
base owner and still delegates authentication to the realm producer. Other
catalog algorithms are not fabricated, and whole-realm completion still fails.
Singleton/property population, lifted entry functions and source/public
publication are not implemented by these two algorithm bodies.

The existing pure restricted-property algorithm is factored into a shared
definition with only its real operands. A fresh comparison against the exact
signed parent source proves **four identical emitted definitions**, covering
both algorithms at ordinary and displaced indices. No legacy behavior change.

The final five-file run passes **159/159** focused cases, including **16/16**
new execution/ownership cases. Current execution also verifies **36/36**
existing native callable cases. The
three object-resource suites retain **147 passing / 14 failing of 161**, with
identical full rows against the retained published-parent S7-z report; this is
not a new parent checkout. All **33** policy inventories/binaries and **six**
native compiled standalone/WASI controls remain identical. The three actual
zero-import algorithm test modules measure **17979 / 18448 / 18448 bytes** and
return canonical undefined plus the actual shared-tag TypeError with native
name/message. These include prior Object.is and test observers, not marginal
production costs or source/public-entry measurements.

Typecheck, lint, formatting, size/function, coercion/oracle, layering/fallback,
flat-directory and inventory checks pass without an allowance, root, module
or allowed-edge change. The same six cycle pairs remain red. Preservation-only
checks pass; strict closure retains the same two nonliteral imports, so
retirement remains uncertified. No existing test expectation, receipt or skip
was changed. The 779-case compatibility cohort and full Test262 were not rerun
for this checkpoint; no fresh compatibility/conformance claim is made for them.

Exact source/report hashes, case names, four paired definitions and three
binary witnesses: `plan/audit/6979-native-realm-base-algorithms-20261019.json`.

Next: the remaining actual catalog algorithm owners, genuine lifted entry
functions and singleton/property population. Foreign/dynamic value identity,
general first-class undefined, canonical mixed property/callable/storage
providers, source special prototype/method semantics, atomic source/public
publication, Linear/WASI construction and architecture/full retirement
acceptance remain open. Both issues remain in progress and PR6762 stays draft.

### S7-ab frontend dependency cuts (2026-10-19, Codex)

Continue from signed `46d313b1b790a6cd9ebecf60216110c78ca085f0`.
The fresh cycle check still reports six growing direction counts. Frontend
helpers import the legacy TypeScript runtime-selection shim even though they
use only its canonical static namespace. A source-fact producer also imports
the IR runtime module solely for a data namespace, while its structural facts
are shared by frontend, allocation cloning and detached validation.

Use the existing frontend TypeScript leaf for those static imports and the
existing shared error class instead of the IR outcomes facade. Give the
index-free source allocation facts one shared data-only owner, preserving the
old IR re-exports and exact namespace/schema/validator. Do not relocate or
weaken opaque requirement issuers, mutate preservation receipts, expand source
admission, or raise cycle allowances to make the graph green.

Readers/mutators enumerated: emitSourceObjectNew writes the facts through the
builder; allocation cloning, inlining and specialization preserve the source
namespace; prepared allocation validation and native construction requirements
read/validate it; the codec carries its data. The TypeScript shim re-exports
the exact frontend/typescript binding; the five frontend value importers use
no runtime-selected API. Its sixth frontend importer is type-only. The Boolean
return audit uses the same shared IrUnsupportedError class that outcomes
already re-exports. Behavior and full source/property authority stay intact.

#### S7-ab verified implementation and handoff

All six frontend imports (five value, one type-only) now use the existing
frontend TypeScript leaf. This is the exact namespace that the legacy shim
already re-exports, not a runtime-selected replacement. The Boolean return
audit imports the original shared diagnostic class directly; constructor
identity and failure classification are preserved.

The source allocation namespace, object construction metadata interface and
structural validator have one shared leaf owner. The old IR paths re-export
that same constant/function/type. The complete validator declaration matches
signed parent `46d313b1b790a6cd9ebecf60216110c78ca085f0` exactly. Source
property order, cloning, specialization, codec replay and strict write modes
are unchanged. No opaque issuer or currentness check was moved or weakened;
these facts still do not authorize native construction or public entry.

Fresh exact-parent graph comparison: frontend-to-IR value imports **19 → 17**;
frontend-to-legacy-shim imports **5 → 0**, removing that two-way directory pair.
The reverse shim-to-frontend leaf re-export still exists as a one-way edge.
Growing direction metrics fall from **six to four**, not to zero. The largest
file-level SCC remains **712**, with **four** nontrivial SCCs. Total files
**1977 → 1978**, value edges **10828 → 10829** (the compatibility contract
re-export adds one). This does not claim a reduction in the file-level cycle.

- **49/49 focused cases** pass, including **15/15 new** guards and live
  namespace/class identity checks, source facts, inferred return contracts,
  incremental strictness and zero-import standalone/WASI strictness execution.
- A broader **189-case / six-file** run reports **40 pass / 149 fail** on both
  candidate and a fresh clean worktree at the exact signed parent. Every full
  row/error matches after replacing only worktree path prefixes, including
  file-URL prefixes. Native construction passes **22/22**, data replay **8/8**
  and cycle detector controls **7/7**. The two historical custody suites retain
  **3 pass / 149 fail of 152**. Their guards stop at the Deno raw-profile and
  program-ABI-contract source receipts; they do not certify deeper retirement
  obligations. No receipt, expectation or skip was changed.
- All **33** policy inventories/binaries and **six** native compiled controls
  match the retained published-parent reports. No new host import, graph copy,
  semantic provider, selector or frozen AST body expansion.
- Typecheck/lint/format, size/function (**+12 source LOC**, no allowance),
  coercion/oracle, layering/fallback and flat-directory checks pass. Inventory
  valid with zero errors, architecture incomplete. All global policy fields
  and prior file classifications are unchanged; only the genuine shared leaf
  receives a new classification. No root/floor/allowed-edge relaxation.
- Preservation-only checks pass **6/6 full + 6/6 cut**. Strict closure retains
  the two nonliteral imports; retirement remains uncertified. The 779-case
  compatibility cohort and full Test262 were not rerun here.

Evidence: `plan/audit/6979-frontend-dependency-cuts-20261019.json`.
The temporary clean parent checkout was used only for the exact control and
archived through the managed workflow after confirming no local changes.
Reports remain in this worktree's ignored `.tmp/`; the checkout is recoverable.

Next: the four remaining growing direction counts need genuine producer/
backend separation, not filename shuffling, weaker authentication or waivers.
The historical custody failures also remain required retirement work. Full
catalog algorithms/population, authenticated source/public publication,
foreign/dynamic carriers, canonical mixed providers, general first-class
undefined and Linear/WASI construction remain open. Both issues remain in
progress and PR6762 stays draft behind its prerequisite stack.

### S7-ac native mixed-object extensibility (2026-10-19, Codex)

Continue from signed `27a4332cf8dbfece4e02c7b6f43c6d71b4096881`. Add the
missing mixed-object IsExtensible/PreventExtensions internal operations to the
existing canonical structural owner, not another storage or host engine.
They use the existing classifier and actual own bag, preserving unready (2)
and unsupported (3) separately from false/true (0/1). Source closures remain
unready until genuine source authority exists; no public Object/Reflect or
whole-realm admission follows from a structural operation.

Shared-state review: ordinary storage creation initializes object flags;
insert and both data/accessor descriptor algorithms consult nonExtensible;
mixed SetPrototypeOf consults the same flag. The existing object read path
also consults nullPrototype in that field. Wrapper/realm record initialization
preserves the ordinary prefix. PreventExtensions must OR only nonExtensible,
not replace flags, walk parents, invoke getters, copy bags or seal properties.
The mixed owner is read by its inventory/completion APIs and component tests;
there is no public source consumer yet. Add two canonical roles, keep Get and
full completion pending, and cover new roles in identity/plan/body audits.

Verification planned: real zero-import Wasm execution at normal and displaced
coordinates, all admitted object/wrapper families, native bag authentication,
source/foreign/uninitialized gaps, insertion/prototype enforcement, existing
property updates, flag preservation and idempotence; scoped owner negative
controls and existing mixed/resource suites. No receipt or gate relaxation.

The implementation adds `isExtensible` and `preventExtensions` to the genuine
mixed structural reservation/fill/completion audit. Both use the exact existing
classifier before inspecting storage. Native callable bags must be non-null
ordinary storage; missing bags remain unready, foreign bags unsupported. Source
closures retain their existing unready result. PreventExtensions changes only
the ordinary nonExtensible bit, so the already-owned insertion, descriptor and
prototype algorithms observe the same state. No new host import, public entry,
copying, realm population claim, callback binder or separate property engine.

Further state inventory found the existing callable-only extensibility
builder. Its exact read/OR kernel now has one shared ordinary-storage helper
in the existing descriptor/flags common module; both callable-only and mixed
builders delegate to it. Emission instructions are cloned independently (not
language objects or bags) to avoid multiply remapped instruction identities.
Exact callable definitions at normal/displaced indices guard its frozen
instruction shape. Existing builtin delete/write, ordinary lookup and legacy
codegen integrity/prototype helpers also read this flags word; they are not
rewired or retired here. No compile-time nonExtensibleVars state is changed.

Next integration obligation: these are internal Boolean/status results, not
public Object/Reflect behavior on primitive inputs. The actual catalog
algorithms must compose genuine argument/value/error/Boolean owners and this
mixed owner. Resolve declaration/fill ordering with the genuine realm owner;
do not accept arbitrary function handles, caller-filled bodies or completion
counters as authority. Mixed Get/Call, full population, source/public entry,
foreign identity, Linear/WASI construction and retirement requirements remain
open. Existing JS-owned boundary values/callables stay live identity-backed
references; this change does not replace or copy their boundary machinery.

#### S7-ac verification and handoff

The final native-focused run passes **201/201** cases across six files,
including **42/42 new** mixed cases and three real zero-import modules at
normal/displaced/decoded coordinates (UTF16/UTF8). All eight admitted families,
unchanged property descriptors, insertion/prototype enforcement, independent
flags, idempotence and unsupported/unready refusal execute. New plan/body/data
negative controls retain scoped owner authentication. An initial 201-assertion
run exited nonzero with a worker reporting timeout; the new audit tests now
yield between cases. The final run exits zero without ignoring errors.

The callable suite passes **38/38**, including **two new** normal/displaced
definition controls. Its existing emitted extensibility locals/instructions
are exactly the original sequence, and repeated bag operands have independent
instruction objects. The three object-resource suites retain **147 pass /
14 fail of 161**. Across these four files, **185 pass / 14 fail of 199**;
removing only the two named new cases for the historical comparison leaves
all **197** original full result/error rows identical to the retained S7-aa
report. No expectation, receipt or skip was changed.

All **33** complete policy inventories/binaries and **six** native compiled
controls match the retained S7-ab reports exactly. No new host import or
selector path. Typecheck/lint/format, size/function (**+68 source LOC** across
four source files, no allowance), coercion/oracle, layering/fallback and flat
directory checks pass. Whole-PR size/function gates pass: **374 source files,
net -17586 LOC** against mainline merge-base; the two existing function grants
are unchanged. Inventory stays valid, architecture incomplete, with the same
1978 modules and existing classifications. Comparison excludes source hashes
and the prior pre-commit report's tracking metadata for the now-committed
allocation-facts leaf, not policy/classification differences.

The complete cycle report is byte-identical to S7-ab: largest SCC **712**, four
nontrivial SCCs, **10829** value edges and the same four growing direction
counts against main. No waiver/root/floor/allowed-edge change. Preservation-only
checks pass **6/6 full + 6/6 cut**, but the two unconstrained dynamic imports
still keep strict retirement closure open. Their arbitrary-specifier behavior
and non-exempting receipts are intentionally preserved. Full Test262 and the
historical custody suites were not rerun here; the earlier guard failures and
deeper retirement obligations remain unverified, not repaired by this change.

The **779-case** compatibility cohort was rerun on the final source and retains
**756 pass / 23 fail**, with identical complete rows/errors against the retained
S7-z report. This is a retained-report comparison, not a fresh exact-parent
control. All **44 new cases** (42 mixed, two definition controls) pass. Evidence:
`plan/audit/6979-native-mixed-extensibility-20261019.json`.

Continue from the signed checkpoint containing these source hashes. Implement
the actual catalog/publication dependencies described above; do not promote
structural completion to public semantic support or merge past the remaining
gates. Both Markdown issues stay in progress and PR6762 stays draft.

### S7-ad authenticated owned catalog Call entries (2026-10-19, Codex)

Continue from signed `e946c85a339b0ad2c7a05c342865e66906180ea0`.
The Object methods cannot yet claim public primitive/source behavior: ToObject,
source carrier admission and complete population remain pending. The next real
dependency is canonical lifted Call entries for the three actual algorithm
owners already implemented, not bodies for the remaining unavailable catalog.

Share the existing exact native identity predicate (concrete carrier,
metadata ID, realm identity, singleton identity and lifted signature) and
guarded Call transport without changing bootstrap callable instructions.
Associate only genuine realm declarations and borrowed algorithm owners;
fill their actual reserved lifted slots, with no raw-handle binder, duplicate
algorithm, new host import or source/public admission. Completion stays scoped
to these owned entries; full realm/Get/Call/population still cannot complete.

Before making the algorithm completion checks load-bearing, independently
compare the canonical Object.is/base algorithm definitions as well as the
allocator's fill snapshots. A substituted body accepted through an intercepted
fill must not become valid merely because its completion counter increased.
Readers: realm declarations and the new scoped lifted producer; mutators:
canonical algorithm fills and allocator fill/snapshot state. No body is moved
out of its existing semantic owner; no whole-module seal or public publication
is inferred from the selected entries. Failed partial filling must not yield a
completion capability or a successful retry.

Verify emitted component calls with real canonical algorithms, zero imports,
normal/displaced/decoded coordinates, exact public exception tag/payload,
identity/refusal controls and argument transport. Separate these component
witnesses from whole-realm execution: the unimplemented catalog bodies remain
unfilled. Retain full regression failures and strict retirement gaps.

#### S7-ad implemented boundaries and measured controls (2026-10-20)

The new scoped producer borrows only the actual realm lifted slots whose
Object.is/base algorithm owners already exist. It accepts a genuine realm
declaration owner, never a raw function handle or caller-supplied body/entry
subset. Dependencies are checked before filling; a partial fill failure cannot
yield completion or be retried into authority. Canonical algorithm and lifted
definitions are re-derived independently of allocator fill receipts. The
physical comparison keeps exact scalar bits and rejects a completed global as
function authority, even when malformed expected fields would compare as
undefined. This comparison is not itself a semantic issuer.

Bootstrap native matching, mixed matching and the new entries share the same
exact metadata/realm/singleton/signature predicate. Guarded Call transport also
has one pure owner. Two normal/displaced definition controls retain the entire
original bootstrap matcher and lifted instruction sequences (six definitions),
not just outputs or declaration counts. No source argc/this/extras global,
host adapter, public selector or whole-realm completion path is changed.

Three emitted component modules execute the genuine Function.prototype,
ThrowTypeError and Object.is algorithms via guarded/stored Call, with zero
imports and normal/displaced/decoded resources. They cover canonical undefined,
shared-tag TypeError payloads, distinct NaN/signed zero, missing arguments and
vector growth, plus clone/metadata/foreign-realm/wrong-signature/cross-entry/
stale-identity refusal. Their named test initializers are not the production
catalog population; the remaining catalog bodies stay unfilled. Module sizes
include full literal/descriptor/primitive prerequisites and test observers,
not marginal production costs or a before/after size claim.

A fresh clean control at signed parent
`e946c85a339b0ad2c7a05c342865e66906180ea0` reproduces the physical-record suite's
**148 pass / 1 fail of 149**. Every original candidate row/error is identical
after replacing only worktree path prefixes; no filename, line or error is
removed. The failure stops at the existing fifteen-declaration receipt. No
receipt/expectation/skip is changed or described as repaired. The temporary
parent checkout was verified clean and recoverably archived through the
managed workflow; reports remain in this worktree's ignored `.tmp/`.

All 33 complete policy inventories/binaries and six native compiled controls
match S7-ac exactly. The first expanded 425-case run also hit the existing
mixed-owner test's 35-second limit under concurrent verification work; retain
that failure and rerun without competing verification jobs, without changing
the timeout or ignoring errors. Full Test262 and the historical custody suites
are not certified by these controls.

Final focused result: **425 pass / 1 fail of 426**, no skipped cases or runner
errors. The native subset passes **268/268**, including **27/27 new** lifted
controls and **40/40** bootstrap callable cases. All **38 new cases** pass
(27 lifted, nine physical comparison, two complete-definition controls).
The physical suite is **157 pass / 1 fail of 158**; its 149 original rows/errors
match the fresh signed-parent control completely, after path-only normalization.
The former mixed-owner timeout passes under the original 35-second limit in
the final run, without other verification jobs or ignored errors. The full run
still exits nonzero for the reproduced physical receipt failure; it is not a
green full-suite or retirement result.

The final-source broader runs retain **147 pass / 14 fail of 161** object
resources and **756 pass / 23 fail of 779** compatibility cases. Every complete
row/error is identical to retained S7-ac reports, without error normalization
or truncation. These two comparisons use retained reports, not fresh parent
resource/compatibility runs; only the physical 149-case control was freshly
executed on the exact signed parent here.

Typecheck/lint/format and checkpoint/whole-PR size/function, coercion/oracle,
layering/fallback and flat-directory gates pass. This checkpoint adds **229
source LOC** across five source files, with no new allowance. Whole PR:
**375 source files, net -17357 LOC**, two existing function grants unchanged.
Inventory remains valid with 1978 modules and unchanged policy/classifications.
One new within-native-runtime edge shares the predicate; value edges become
**10830**. Largest SCC **712**, four nontrivial SCCs and all two-way direction
metrics remain unchanged, including the four growing direction counts against
main. No waiver/root/floor/allowed-edge change. Preservation-only **6/6 full +
6/6 cut** does not certify the still-open strict retirement graph.

Evidence: `plan/audit/6979-owned-catalog-lifted-calls-20261020.json`.
Next: remaining real catalog algorithms and constructor paths, complete
singleton/property population and mixed Get/Call, then atomic authenticated
source/public publication. ToObject/default prototype selection, foreign/
dynamic identity, first-class undefined, Linear/WASI construction and the
architecture/custody/retirement/conformance gates remain open. Do not promote
this private-entry completion scope to public semantic admission. Both Markdown
issues remain in progress and PR6762 remains draft behind its prerequisite
stack and merge conflicts.

### S7-ae native Object extensibility catalog algorithms (2026-10-20, Codex)

Continue from signed `cde92c0be290e16821d70a0e26eeccec32bae6fb`.
Implement the actual reserved Object.isExtensible/preventExtensions algorithms
downstream of genuine realm declarations and mixed structural completion. This
ordering must not introduce a realm-to-mixed dependency cycle or accept raw
function handles, callbacks or caller-selected entry subsets.

Implement native primitive semantics too: IsExtensible returns false without
boxing objects; PreventExtensions returns the identical primitive reference.
Use the canonical undefined identity, native null and authenticated Number,
Boolean, String, Symbol and BigInt carrier owners, not "unsupported means
primitive". Unknown foreign values and unready source/bag/realm authority must
refuse loudly, not become false/success. A real internal false for prevention
throws through the genuine public TypeError/tag owner. Public/source admission,
whole-realm population and host boundary adapters stay pending.

Readers of reserved algorithm slots: realm inventory and eventual lifted/public
composition. Current writers: only canonical per-algorithm producers; these two
slots have no producer yet. Mixed structural functions remain in their existing
owner; no body or state is moved. Canonical primitive storage is read only.
Audit executed dependencies independently of fill counters before issuing
scoped completion; compare both new algorithm definitions after fills. Verify
actual emitted calls, live identity/flags/descriptors, every native primitive
family, missing arguments and foreign/unready refusal without host imports.

Use the physical allocator's strict bit-preserving canonical comparison for
global initializers too, rather than introducing a new backend-to-IR comparison
edge. This is comparison only, not a semantic authority issuer. Existing
initializer writers remain unchanged; readers are the new downstream algorithm
owner and its negative tests. Classify the two new implementation modules in
their existing backend/native-runtime layers without changing entries, roots,
floors, allowed edges or waivers.

Reuse the existing native primitive-classification owner (including i31,
String, Symbol and wide BigInt), rather than duplicating its dispatch inside
each Object algorithm. Preserve the stricter canonical-undefined entry guard.
Its current completion readers are its own tests and this new downstream
consumer; writers remain the genuine Number/Boolean/BigInt predicate owners
and the classifier fill. Re-derive those three executed predicate bodies in
classifier completion before making its answer load-bearing for object vs
primitive behavior. This is not IsCallable, ToObject or foreign-object entry.

#### S7-ae implemented boundary and component evidence

The downstream producer borrows exactly the two existing algorithm/lifted entry
pairs from genuine realm declarations, consuming the genuine mixed structural
and primitive classifier owners. It does not reserve replacements or accept
caller-chosen handles, bodies or subsets. The realm does not import this new
producer or the mixed owner back. Partial-fill failure is terminal for this
owner; fill counters alone never certify its algorithms or guarded entries.

Native primitives follow the standard [Object.isExtensible](https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.isextensible)
and [Object.preventExtensions](https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.preventextensions)
rules without ToObject/coercion. Genuine mixed objects use their actual own
bags and existing nonExtensible flag. Unknown/unready object authority traps
instead of becoming false or success; internal prevention false throws through
the actual native TypeError/public tag. Canonical undefined identity remains
strict. These are private native-value-ABI entries, not admission for all
objects, arrays, proxies, arbitrary host objects or public source calls.

Independent canonical definition/initializer comparisons cover the executed
Number/Boolean/BigInt predicates, Boolean result producer/singletons, undefined,
TypeError constructor and message/name literals. The global comparison retains
signed-zero/NaN payload bits and cannot mistake a completed function for a
global even when malformed expected fields would both be undefined. Neither
comparison API issues semantic ownership.

Component execution uses the actual production owner's slots, not a parallel
algorithm implementation. Every reachable function must have a real successful
fill. Only a cloned component snapshot is passed to the existing unreachable-
function sweep; dead catalog obligations stay unfilled in the real unsealed
ledger. Named test initializers, source-refusal controls and a derivative false-
prevention branch observer are not production population or completion grants.
Reported sizes include all retained catalog declarations and test observers;
they are not marginal production costs or before/after improvements.

Development execution exposed an omitted i31 Number arm; the final producer
reuses the existing primitive classifier instead of a new dispatch table. A
newly authored refusal assertion also incorrectly expected raw small integers
to be distinguishable from native i31 values. The explicit Node24.4.1 control
observes `typeof === "number"`, `Object.is(boxNumber(7), 7) === true` and the
existing predicate returning 1 for 7. Accepting that native Number representation
is not host-object admission. Boxed host objects and unknown/unready carriers
retain refusal controls; no existing receipt, expectation or skip is relaxed.
The failed development reports are retained, not presented as green runs.

Final focused result: **673 pass / 1 fail of 674**, 11 files, no skips or
reported runner errors. All **63 new cases** pass (40 component runtime cases,
15 owner controls, eight physical global comparisons), as do all **185 existing
primitive-classifier cases**. Every complete row/error in the prior **426-case**
focused cohort matches the retained signed-parent S7-ad report exactly, without
normalization or truncation. This is a retained-report comparison, not a fresh
parent execution this turn. The sole failure remains the existing physical
record receipt; no receipt is repinned and no full green-suite claim is made.

All **33** complete compiler policy inventories/binaries and **six** native
standalone/WASI compiled controls match retained S7-ad reports byte-for-byte.
The final native modules execute with zero imports. Full Test262, the wider
161/779 cohorts and historical custody suites were not rerun this turn; their
previous failures and remaining proof obligations are not certified away.

Typecheck/lint/format, checkpoint/whole-PR size/function, coercion/oracle,
layering/flat-directory, fallback and issue checks pass. The standard fallback
check initially hit a sandbox-denied runner IPC socket; the same check passed
outside the sandbox. Checkpoint: **four source files, net +412 LOC**. Whole PR:
**378 source files, net -16945 LOC** against the mainline merge-base, existing
two function grants unchanged and no new allowance. Preservation-only **6/6
full + 6/6 cut** does not close the two unconstrained dynamic-import paths.

Inventory is valid with **1980 modules**, zero errors and architecture still
incomplete. Policy changes only classify the two new modules in existing
layers; all previous classifications remain unchanged. Value edges increase
**10830→10846**, while largest SCC **712**, four nontrivial SCCs and every
two-way direction metric remain unchanged. The same four growing directions
against main stay red. No new root, floor, allowed edge or waiver.

Harness correction: commands request two CLI workers, but the base config's
RAM-derived pool `maxForks` overrides top-level `maxWorkers` in Vitest3.2.4.
Actual concurrency was not sampled during the run. No timing/concurrency A/B
claim is made; the original 35-second case timeout and normal error reporting
remain unchanged. Do not read earlier "two forks" descriptions as measurements
of live worker counts.

Evidence: `plan/audit/6979-native-object-extensibility-20261020.json`.
Next: compose the remaining catalog from genuine owners, including
Object.setPrototypeOf's ordered nullish/prototype checks and mixed mutation;
build genuine ToObject/default-prototype owners for the methods that require
them, rather than attaching arbitrary prototype handles. Complete mixed
Get/Call, constructors and population before atomic public/source publication.
Foreign/dynamic identity with live boundary references, first-class undefined,
Linear/WASI and architecture/custody/retirement/conformance acceptance remain
required. Both issues stay in progress; the PR stays draft, not merge-ready.

### S7-af ordered Object.setPrototypeOf catalog composition (2026-10-20, Codex)

Continue from signed `8b193c79c5f6bcaae58216a554c6738ee10b52b3`.
Implement the actual algorithm/lifted slots for Object.setPrototypeOf using the
genuine mixed mutation and primitive/error owners. Keep RequireObjectCoercible
before prototype checks and validate the prototype before returning a primitive
receiver unchanged. Missing arguments use canonical undefined. Unknown/unready
private-ABI inputs must refuse, not become false/success or pretend to be public
TypeErrors. Preserve identity, SameValue-first mutation, immutable prototypes,
non-extensibility and cycle/gap handling in the existing mixed owner.

Share the existing fixed catalog producer machinery with extensibility under
a structural-algorithms module name; no exported arbitrary-entry/body binder.
Separate issued scopes and per-kind uniqueness must prevent cross-scope fill or
completion. Readers of the old producer path are its two test imports and the
compiler inventory classification; writers are its canonical fixed producers.
Rename those consumers, retain the old entry bodies unchanged, and leave pinned
historical audit paths as historical evidence. No state/algorithm body moves out
of the mixed owner, and no caller may provide alternative function handles.

Verify the new real owner through guarded/stored calls and zero-import component
snapshots, all native primitive/object families, ordered errors, actual live
prototype mutation, sealed/immutable/cyclic refusals and missing authority.
Audit substituted algorithm/lifted definitions and wrong/copy/foreign scopes.
Public/source admission, full population, remaining catalog/ToObject/default
prototypes, foreign boundary identity, Linear/WASI and retirement remain open.

#### S7-af implementation and landing handoff

The unpublished slice is now a checkpoint for the existing draft
[refactor(codegen): separate native semantics from JS host mode](https://github.com/loopdive/js2/pull/6762).
Its parent is signed `8b193c79c5f6bcaae58216a554c6738ee10b52b3`. The
prerequisite [refactor(runtime): remove the host-assisted semantic policy](https://github.com/loopdive/js2/pull/6701)
was read back OPEN/unmerged at handoff. Do not merge or mark this migration done.

The fixed downstream producer fills the genuine Object.setPrototypeOf algorithm
and guarded Call slots, using existing mixed-object mutation, native primitive
classification and native TypeError owners. RequireObjectCoercible happens before
reading P, and prototype validation precedes the primitive-O early return.
Only canonical undefined is accepted as undefined; layout copies, foreign/unready
objects and unsupported chains trap instead of receiving a fabricated semantic
result. Object identity, actual prototype state and existing mutation rules stay
with the mixed owner. No JS-owned object is recursively copied or newly admitted.

The producer was renamed to
`src/backend/wasmgc/resources/native-object-structural-algorithms.ts`. Shared
dependency/canonical-definition checks remain private, with fixed exported
factories, separate completion scopes and per-kind uniqueness. This is not an
arbitrary-entry binder. Extensibility callers were moved to the new import path;
their existing expectations and the old pure instruction builder are unchanged.
Historical audits retain the old path at their pinned revisions.

Resume from this PR's verified head, not the dirty primary checkout. Before the
next implementation slice, read this issue and the parent
[Merge JS-host and standalone modes: one native semantic core, host semantics only as opt-in accelerators](5385-merge-host-semantics-into-native-core.md).
The next work is genuine ToObject/default-prototype ownership and the remaining
catalog algorithms/constructors, then mixed Get/Call and complete singleton/property
population before atomic authenticated source/public publication. Do not weaken
admission or treat a non-null anchor, bag, count, allocator receipt or this partial
algorithm completion as whole-realm authority.

The broader migration still requires live identity-backed foreign/dynamic
boundary references, first-class undefined, Linear/WASI construction and full
architecture/custody/conformance/retirement acceptance. Resolve the four existing
dependency-direction violations and the two unconstrained dynamic-import proof
gaps without baseline edits or new waivers. Prior broad-cohort/physical-receipt
failures remain open; no full-suite or full-Test262 green claim follows from
these component checks. The draft also has unresolved merge conflicts. Both
Markdown issues remain in progress; no GitHub issue or issue comment is created.

Additional checker follow-up discovered during landing: the auxiliary
`scripts/check-issue-ids.mjs` workspace mode uses URL `.pathname`, so the space
in this checkout's volume path remains `%20` and it fails to scan the directory.
Its committed mode prints a green result with **zero issues**, which is not
verification and is not counted as a passing gate here. The separate
`check-committed-issue-integrity.mjs HEAD` positively scans all **4955** issue
files, and `update-issues.mjs --check` also indexes **4955**. No issue IDs are
introduced in this checkpoint. Repair and positive-control the auxiliary
checker separately; do not waive failures or accept its empty observation.

#### S7-af verification at publication

The final full new-file run is **38/38 passing**, no skips or reported runner
errors, exit zero: **33 runtime cases and five owner controls**. Three
zero-import component snapshots execute the actual algorithm and guarded/stored
entries at normal and displaced/decoded coordinates, including allocating
Booleans. Their real reservation ledger remains unsealed/incomplete; test-only
initialization and snapshot sweeping are not production population or admission.

All **63 existing extensibility assertions** are reported passing with the final
helper/source, and all **four existing component byte hashes and reachability
counts** equal the retained parent audit, with an explicit four-row floor.
However, the enclosing intermediate two-file run is **98 pass / 3 fail of 101
plus one onTaskUpdate runner error**, not a clean pass. Its three newly authored
guard assertions were corrected before the clean 38-case run; no production
source or old expectation changed. The first development run was 80 pass / 21
fail of 101 plus the same reported runner error. Both reports remain recorded.
Do not describe these observations as a single clean 101-case run or infer a
concurrency cause. Obtain a clean complete regression run before merge.

All **33 policy inventories/binaries** and **six standalone/WASI compiled
controls** match retained parent reports byte-for-byte. Typecheck/lint/format,
size/function, coercion/oracle, layering/flat-directory and fallback checks pass.
Checkpoint: **three source files, net +155 LOC**. Whole PR: **379 source files,
net -16790 LOC**, base `ae913d622f3cb5c4136e43a27594b8ec48e4c933`.
No new allowance or baseline change. Inventory valid: **1981 modules**, zero
errors, architecture incomplete. Value edges 10846→10848; largest SCC712,
four nontrivial SCCs and every direction metric unchanged from the parent.
The cycle gate still exits one for the same four directions growing against
main. Preservation-only is 6/6 full + 6/6 cut; strict retirement still refuses
the two unconstrained dynamic imports. These are not waived or certified.

Node24.4.1/Vitest3.2.4 and the Wasm exception-reference flag were used. The last
new-file run requests fork limit one using `VITEST_MAX_FORKS`; actual concurrency
was not sampled. The case/hook limits remain 35/120 seconds. No timing A/B claim,
ignored errors or timeout increase. Full 674-case, broader 161/779, full Test262
and historical custody cohorts were not rerun. Prior physical-receipt and other
failures remain open. Exact source/report hashes, component witnesses and all
development failures are in
`plan/audit/6979-native-object-set-prototype-20261020.json`.

### S7-ag retained Object.prototype.__proto__ setter (2026-10-20, Codex)

Continue from signed `d54d8454130e9721dc37e429ca081c9b4e0771aa`.
The genuine ToObject owner is still absent: the pure builder exists, but the
Object/Function realm catalog does not issue the required primitive prototype
families. Do not bind arbitrary handles/null prototypes to claim completion.
Object.prototype population also requires the retained normative-optional
`%set Object.prototype.__proto__%` algorithm, whose dependencies now exist.
Implement that complete catalog algorithm as a real bootstrap prerequisite,
not as a substitute for the remaining ToObject/default-prototype work.

Use `this` as O and argv[0] as P. RequireObjectCoercible precedes P. Invalid
native primitive P returns canonical undefined; a primitive O also returns
undefined, and successful mutation returns undefined rather than O. Preserve
native TypeError on internal false and loud refusal of unknown/unready private
inputs. Keep actual mixed mutation, immutable/non-extensible/cycle rules, exact
undefined identity and guarded self identity. No source/public admission or
whole-realm completeness follows.

Readers of the shared prototype builder are the fixed structural producer and
its execution tests; its only writers are fresh instruction factories and the
existing reservation fill owner. Reuse private construction without changing
the existing Object.setPrototypeOf instruction stream. Add a fixed issued
setter scope, per-kind uniqueness and canonical algorithm/lifted re-derivation;
never expose a general entry/body binder. Extend only opt-in test observers so
the existing component binaries remain byte-identical. Track current proof
limits and the broader migration in this issue and its parent.

The first complete S7-ag run reports all **76 cases passing** (38 new
setter + 38 unchanged Object.setPrototypeOf) and no skipped/failed cases,
but also one `[vitest-worker]: Timeout calling onTaskUpdate` and exit one.
The JSON reporter nevertheless says `success: true`; this is not a clean run
and the terminal log/exit take precedence. The requested fork limit was one,
so the observation is not evidence for a concurrency cause. Investigate the
actual installed runner's update handoff, retaining this failed report and
unchanged semantic checks/time limits; do not suppress/normalize the error.

Installed Vitest3.2.4 sends a suite-prepare task update before beforeAll and
uses a 60000ms RPC timeout; it waits for pending updates only at final flush.
The component hooks synchronously perform multiple complete ownership audits
under their separate 120000ms hook budget. Investigate event-loop starvation
without assuming a concurrency defect: preserve the synchronous fixture API,
factor its identical steps through a generator, and let an asynchronous test
entry yield between real reservation/fill/completion/emission phases. Keep all
checks, statement order, emitted bodies, case/hook/RPC deadlines and assertions
unchanged. Record measured synchronous phase durations and rerun the exact
same 76-case cohort. A green JSON flag alone remains insufficient.

Apply the same scheduling-only hook change to the older extensibility suite,
the remaining consumer of this synchronous component constructor, and rerun
its complete 63-case file separately. Preserve its assertions/receipts and
four component byte hashes as well; do not report two executions as one combined
139-case run. The synchronous helper API remains available and emits the same
bodies, while all three expensive component hooks use its cooperative entry.

The cooperative 76-case rerun is terminal: **76/76 pass**, zero skips/reported
runner errors and exit zero. The complete 76 case identities, statuses and
assertion error fields equal the pre-yield run; its full failed log/report are
retained separately. Six component scheduling records observed a maximum
synchronous phase of 16267.59925ms. Both old/new component byte hashes stayed
identical across this scheduling change. This is a correctness observation for
the same private native-ABI cohort, not proof of a performance/concurrency cause
or a fresh signed-commit A/B. The production source did not change for this
harness repair, and all original case/hook/RPC limits remain intact.

#### Next producer acceptance contract: native ToObject

Bind actual issued primitive intrinsic/default-prototype declaration and
initialization owners for Boolean, Number, String, Symbol and BigInt in the
same realm. Do not accept caller-selected globals, arbitrary factory handles,
explicit-null test prototypes or a non-null anchor as that authority. Keep an
algorithm-only completion scope distinct from complete prototype population;
public/source publication still requires the latter and all remaining owners.

Compose existing native value/Boolean unboxers, wrapper storage and StringCreate
through owned unary factories; independently audit the definitions that actually
execute, not just allocator receipts. A String storage allocation is not the
String exotic operation. Retain immutable primitive payload references where
appropriate, signed-zero Number behavior and fresh wrapper identity. Do not
invoke public constructors or observable coercion to implement this operation.

The pure ToObject body's final passthrough assumes an ECMAScript-value domain;
it does not authenticate an unknown private-ABI input as an Object. Preserve
canonical undefined identity and positively owned native object admission.
Foreign/dynamic objects require the live per-instance boundary reference owner,
not recursive copying or a silent host-object passthrough shortcut. Supported
objects must retain exact identity; unknown/stale authority must not become a
fake semantic result.

Verify all five primitive families, native i31 and boxed Numbers including
negative zero/NaN, String own length/virtual indices, repeated fresh wrappers,
exact intrinsic prototypes and object-reference preservation, plus substituted
dependencies/definitions and stale/foreign realm controls. Then compose the
dependent catalog entries and atomic publication. Keep explicitly selected IR
source/custody evidence separate from the default compiled preservation probes;
both no-host backends and full migration acceptance remain required.

#### S7-ag verified publication and handoff

The additional full extensibility file is terminal: **63/63 pass**, zero skips
or reported runner errors, exit zero. Its complete case identities, statuses
and assertion error fields match the retained S7-ae report exactly. All four
component coordinate/byte-hash/import/reachability rows match that parent audit;
this is not a fresh parent execution. Together with the clean 76-case run,
the observations cover **76/76 and 63/63 in two separate runs**, not a single
139-case run. All seven existing component binaries are unchanged. No semantic
assertion, receipt, timeout, ignore setting or authority check was weakened.

Source/report hashes, three actual setter component witnesses, ten measured
cooperative component records and the failed pre-yield report are recorded in
`plan/audit/6979-native-object-prototype-setter-20261020.json`. The synchronous
test helper API remains; all three expensive component hooks use its async
phase-yielding entry. Production scheduling and semantic bodies were not
changed for the runner repair. Do not infer a performance/concurrency cause or
whole-suite conformance from these observations.

All 33 policy inventories/binaries and six standalone/WASI compiled controls
equal retained parent reports. They use the default compilation route, not
proof of complete IR/source admission. Selected quality/budget gates pass:
two changed source files, net +62 LOC; whole PR379 source files, net -16728 LOC
against `ae913d622f3cb5c4136e43a27594b8ec48e4c933`. Existing function grants
unchanged; no new allowance. Inventory valid with 1981 modules and zero errors,
architecture incomplete; policy and all direction metrics are unchanged from
the parent. Value edges10848, largest SCC712 and four nontrivial SCCs remain.
The same four directions still fail against main; strict closure still refuses
both unconstrained dynamic imports despite preservation-only 6/6 full + 6/6 cut.
No baseline, root, floor, edge allowance or waiver changed.

Both Markdown issues stay in progress and PR6762 stays draft. The prerequisite
was read back OPEN/unmerged; the latest mergeability state was UNKNOWN, not a
merge approval. No GitHub issue/comment was created. Resume with the genuine
ToObject/default-prototype producer contract above, remaining catalog and
constructor bodies, mixed Get/Call/full population and atomic authenticated
source/public publication. Live foreign boundary identity, first-class
undefined, Linear/WASI construction and full architecture/custody/conformance/
retirement acceptance remain required. Complete prior 674-case, broader161/779,
full Test262 and historical custody cohorts were not rerun; existing receipt
and broader failures are not repinned or certified away.

### S7-ah genuine primitive prototype bootstrap and ToObject prerequisites (2026-10-20, Codex)

Continue from signed `4e57c7ce47d7bb4a866a0acf47489b6584f0f0c7`.
Issue the five fixed primitive prototype identity roles from semantic contract
data, never caller-selected globals. Build Boolean(false), Number(+0) and
String(empty, with its real own length); Symbol/BigInt prototypes are ordinary
objects without the corresponding private primitive-data slot. Use the genuine
mixed realm, stateful wrapper storage and StringCreate owners. All parents are
the actual issued Object.prototype role. Keep constructor/member population
explicitly unfinished; these exact identities must be reused by later population,
not replaced with fallback empty objects.

Publish all five allocations atomically in a private immutable identity capsule,
stamped with the current realm and Object.prototype identities. Getters are fixed
by kind, preserve identity/user mutations and refuse missing/stale authority.
Initialization is idempotent within one generation and refreshes only after a
genuine base-generation change. Independently re-derive every executed body and
empty-string initializer; failed partial fills remain terminal. This scope is
not whole-prototype, public ToObject or realm completion.

Then compose native ToObject wrapping from this real bootstrap and existing
primitive/error/unbox/StringCreate resources, retaining strict canonical
undefined/native-object admission and exact object/payload identity. Do not
turn the pure builder's generic passthrough into private foreign-object authority.
The full producer acceptance contract above remains in force; public/source
publication, member population, live foreign boundary values, Linear/WASI and
all wider migration acceptance remain open.

Readers of the new capsule are its fixed getters and the later population/
ToObject consumers; its only writer is its canonical initializer, publishing
after all fresh allocations. No existing object/state/payload field moves.
Expose retained declaration plans/dependencies in test fixtures without changing
reservation order or emitted instructions. Preserve all existing component
binaries and use cooperative fixture construction for the actual new bodies.

#### S7-ah publication checkpoint and actionable handoff

User requested publication of the work in progress, not completion of the
remaining producer work. Publish this checkpoint on the existing draft PR6762;
do not mark this issue done, ready the PR or merge the incomplete stack. The
prerequisite PR6701 was freshly read OPEN/unmerged during publication.

Implemented but **not runtime-accepted or wired into source/public execution**:

- `src/runtime/contracts/native-primitive-prototype-identities.ts` fixes five
  identity/payload roles; it is not a member/descriptor population catalog.
- `src/runtime/wasmgc/values/primitive-prototype-identity-bodies.ts` builds the
  immutable generation capsule, atomic initializer and five fixed getters.
- `src/backend/wasmgc/resources/native-primitive-prototype-identities.ts`
  reserves a private capsule/global and seven functions against genuine mixed,
  wrapper-storage and StringCreate owners. Completion re-derives bodies and the
  empty-string initializer; its declared scope is identity bootstrap only.
  No production consumer invokes this owner yet. Backend owner authentication,
  partial-fill behavior and executable Wasm still need dedicated tests.
- Three modules are classified in the existing backend-wasmgc,
  runtime-contracts and native-runtime layers. No root, allowance, floor or
  baseline is changed.

Verification for this checkpoint: **11/11 structural builder tests pass**, zero
skips, runner exit zero, in
`tests/issue-6979-primitive-prototype-identity-bodies.test.ts`. These assert the
fixed roles/payloads, immutable fields, allocation-before-publication ordering,
two-identity generation checks, fixed getter fields and copied instruction
operands. They do not instantiate the new bootstrap or certify runtime/native
provider completion. The initial typecheck failed because declaration
observations used the wrong header/signature shape; the source was corrected
and typecheck/lint rerun successfully. The prior S7-ag runtime/compiler results
above are retained historical evidence, **not rerun on this checkpoint**.

Resume in this order:

1. Expose the original wrapper declaration plan/dependency identities and
   StringCreate dependencies from the mixed fixture, without changing resource
   order. Reserve/fill this owner in an opt-in cooperative component fixture.
2. Execute real zero-import Wasm for all five prototypes. Check false/+0/empty
   payloads, String own length and virtual indices, Symbol/BigInt absence of
   primitive-data slots, exact Object.prototype parents, stable identity and
   preserved user mutations on repeat init, fresh identities on a genuine
   realm/Object.prototype generation change, and loud missing/stale rejection.
3. Add genuine backend-owner positive controls and copied/foreign/mixed-family,
   substituted declaration/body/literal, failed partial fill and forged receipt
   negative controls. Recheck all existing component hashes with unchanged
   assertions; retain the real ledger as incomplete/unsealed.
4. Compose actual ToObject using owned unary adapters and native unbox/error
   resources. Admit canonical undefined/native objects strictly; preserve object
   identity and fresh wrappers. Do not bless raw foreign objects or public
   constructors as private native authority.
5. Complete member/constructor population, authenticated atomic source/public
   admission, live foreign boundary references, Linear/WASI and the full
   architecture/custody/conformance/retirement acceptance already tracked here.

The dependency-cycle gate still fails the same four directions against main
(backend→ir 115→117, codegen→ir 298→301, ir→codegen 74→75,
ir→frontend 7→10); no waiver was added. Inventory covers 1984 source modules
with zero reported errors but architectureComplete=false. Neither those counts
nor the structural tests make this migration merge-ready. Full Test262,
historical custody and broader known-failing cohorts were not rerun or repaired.
No GitHub issue or comment is used for this handoff.

### S7-ai execute and authenticate the primitive prototype bootstrap (2026-10-20, Codex)

Continue from signed `28119417bc729d92118cd50e19fde713befc297e`. The previous
goal turn made authoritative progress by committing/publishing S7-ah; its 11
structural checks deliberately leave native execution unproven. Add opt-in
genuine component integration, preserving existing fixture defaults/resource
order and binary witnesses. Enumerated readers of mixedFoundation and
objectExtensibilityFixture are the mixed-object and extensibility/SetPrototype/
retained-setter tests; only add retained declaration/dependency views and an
opt-in sixth fixture parameter. Existing fields are not moved or reinterpreted.

Execute actual owner-issued initializer/getter slots without host semantic
imports. Check five identities and payload roles, actual Object.prototype
parents, String own length, idempotent mutation-preserving initialization,
independently changed realm/Object.prototype generations, missing/stale refusal
and ordinary Symbol/BigInt prototypes without private payloads. Add genuine
backend owner positive/negative controls and compare existing component hashes.
Keep full population, ToObject/source/public admission and the wider migration
acceptance open; no catalog stub, receipt repin or fake completion is permitted.

#### S7-ai development observations (retain failed evidence)

The first executable run terminated exit one: **16/28 passed, 12 failed**, zero
skips. Four generation-refresh assertions used `not.toBe` on different opaque
WasmGC references; installed Vitest3.2.4's matcher performs deep equality advice
when Object.is is false, before considering the negation, and throws while
enumerating WasmGC objects. Replace only those comparisons with explicit
`Object.is(a,b) === false`; the identity requirement is unchanged. Eight owner
cases exceeded the existing 35000ms case limit while doing fixture construction,
dependency filling and the actual assertions in one case. An isolated initializer
receipt case reproduces `Test timed out in 35000ms` (one failed, 34 deliberately
unselected/skipped); its selection is diagnostic, not a passing cohort.

Keep `.tmp/s7ai-runtime.json` (SHA256
`50c13e0b8595b36b5c518bd3692afd71144787bcede5699bc744ac2baff4afb8`)
and `.tmp/s7ai-owner-failure.log` (SHA256
`29543ab5a46d546d4c081f8bb66ddaf610d80a1ea590d202cb0c3bc8fde1ca74`).
That first run predates additional owner controls/index observer and final
fixture phase scheduling; it does not verify the current complete test file.
No semantic expectation, receipt or production source was changed to repair
those failures. Move genuine fresh fixture preparation/dependency filling to
explicit setup hooks, bounded by the existing component-hook limit120000ms;
retain 35000ms cases and every actual canonical comparison. Split the new
async component fill and completion audits with a yield; old default paths
and emitted instructions remain unchanged. No timeout is raised or ignored,
and no concurrency/performance causal claim follows from these observations.

The final run includes the new runtime/owner file, the original 11 structural
builder checks and all three older extensibility/SetPrototype/retained-setter
files. Require terminal success and positive case/component counts before
claiming the bootstrap verified. Compare all ten old component witnesses
against their retained audits, including coordinates, bytes, hashes, imports
and reachability counts. No fresh parent execution is implied by that comparison.

The expanded file subsequently reports **33/36 pass** inside the still-running
combined regression execution: all 18 runtime cases pass, with three new owner
control assertions failing. The changed getter signature is already refused by
the physical ledger as an `altered function descriptor`; assert that actual
diagnostic. The corrupt empty String is refused earlier by the genuine mixed
owner as `noncanonical executable empty literal`; keep that stronger upstream
rejection and assert downstream incompleteness. An empty private-global
initializer never obtains a fill receipt, so replace that invalid control with
a nonempty, deliberately noncanonical initializer, assert its actual receipt,
then require the independent canonical completion rejection. This negative
receipt control does not claim the forged module is executable/valid Wasm.

No production source or old test assertion changed for these corrections. A
separate corrected native/structural run is active alongside the original
combined run's unchanged older suites. Keep both reports; neither may be called
a single clean 186-case run. The two bootstrap binary hashes are identical
across these assertion-only corrections. Wait for terminal processes and inspect
the complete rows/errors before recording final verification or publishing.

#### S7-ai verified native bootstrap and next producer handoff

The corrected native execution is terminal, exit zero: **47/47 pass**, zero
skips and no reported runner errors across two files. It covers 18 runtime
cases, 18 authenticated owner controls and the original 11 structural checks.
Two actual zero-import component witnesses execute all seven bootstrap
functions. Both normal/interned and displaced/decoded/allocating coordinates
verify exact prototype parents, false/+0/empty payloads, String length flags and
virtual-index presence/absence controls, stable identities/user mutations and
independent missing/stale/generation handling. This closes the S7-ah executable
bootstrap/owner evidence gap, not complete member population or public ToObject.

All ten older component rows match retained audits exactly: four extensibility,
three Object.setPrototypeOf and three retained setters, including configuration,
bytes, SHA256, import lists and reachable/dead snapshot counts. Positive row
floors are enforced; no fresh parent execution or marginal production size is
claimed. The separate combined regression process is terminal, exit one:
**183/186 pass, three new control assertions fail**, zero skips/reported runner
errors. All **139/139 older cases pass**; complete identities/statuses/assertion
error fields equal the retained S7-ag reports. The three new control assertions
are corrected and pass in the separate clean47-case run; do not relabel this
a clean186-case execution. Exact source/report hashes and interpretation are recorded in
`plan/audit/6979-native-primitive-prototype-identities-20261020.json`.

Production source is unchanged from S7-ah. Typecheck, lint, formatting and
selected budget/coercion/oracle/layering/fallback checks pass. The standard tsx
fallback checks required an outside-sandbox rerun after local IPC permission
refusal; no check was bypassed. Whole-PR source budget remains382 files,
net -16253 LOC against `ae913d622f3cb5c4136e43a27594b8ec48e4c933`.
The same two prior function grants remain; no new allowance. Inventory is
valid with1984 tracked modules and zero errors. Policy hash and all cycle
direction metrics equal the S7-ah parent, architectureComplete=false; the same
four directions remain red, strict dynamic-import closure still fails and
retirement is not certified. No full Test262, historical custody, broader
known-failing cohorts or 33-policy/six-native compiler controls were rerun.

Next compose the genuine ToObject wrapping kernel from this owner and existing
primitive classifier, Boolean/Number unboxers, wrapper allocation, StringCreate
and native error/tag resources. Own the fixed unary adapters and predicate
bridges; accept neither caller-selected handles nor public constructors.
Independently audit the actual unbox/error bodies, not just their receipts.
Check canonical undefined identity before broad primitive classification and
reject unknown/unready private values before the generic pure body's final
object passthrough. Genuine native objects must return unchanged; each admitted
primitive must get a fresh wrapper with the exact retained intrinsic identity
and unchanged native payload. Missing/stale bootstrap must trap, never choose
an explicit-null or placeholder prototype. Keep this private kernel scope
separate from full prototype/constructor population and source/public admission.

Then complete the remaining catalog and mixed Get/Call population and atomic
authenticated publication, live foreign per-instance boundary references,
first-class undefined, Linear/WASI and full architecture/custody/conformance/
retirement acceptance. The prerequisite was freshly read OPEN/unmerged; PR6762
remains draft, both Markdown issues stay in progress and the full goal stays
active. No GitHub issue/comment was created or existing failure repinned.

### S7-aj compose the genuine native ToObject wrapping kernel (2026-10-20, Codex)

Continue from signed `0c1cc249ddbccac6482f58a05d7d8f68c4cdfe16`. The previous
goal turn made authoritative progress by verifying/publishing the real primitive
prototype bootstrap. Reuse its exact issued role getters, existing pure ToObject
control flow and genuine wrapper/StringCreate/classifier/unbox/error resources.
Own five fixed unary factories and three predicate bridges; no caller-selected
prototype/global/body/handle binder, public constructor or object graph copy.

First admit the private native ABI: only canonical undefined may occupy its
carrier role; nullish inputs throw the actual native tagged TypeError before
prototype lookup. Positively owned native objects return unchanged. Unknown,
stale, unready or foreign private objects must trap rather than reach the pure
body's ECMAScript-domain passthrough. Primitive wrappers are fresh, keep exact
native payloads and use the retained per-realm intrinsic role identities.

Completion independently re-derives every owned body and the executed Boolean/
Number unboxers, canonical undefined and native error/literal definitions.
Require authentic same-family completed prototype and classifier dependencies;
partial fills remain terminal. This is a private wrapping-kernel scope, not full
prototype members, source/public admission or whole-realm completion.

Add opt-in native component wiring without changing old fixture defaults or
resource order. Readers of the shared fixture are the existing extensibility,
SetPrototype, retained-setter and prototype-bootstrap suites. Keep their
assertions, binary witnesses and original deadlines; use bounded setup hooks
and cooperative audit phases. Verify every primitive family, numeric edge
cases, real String descriptors/indices, object/payload identity, nullish errors,
missing/stale prototype guards and substituted/foreign/partial-fill controls.
The full migration, both no-host backends and the existing conflict/architecture/
custody/conformance/retirement obligations remain open.

#### S7-aj implementation and development evidence

`native-to-object.ts` issues a fixed private kernel from genuine same-family
prototype, classifier and native error owners. It owns three predicate bridges,
five unary factories and the actual wrapping entry. The shared pure ToObject
body remains unchanged; `native-to-object-bodies.ts` adds private-domain
admission and canonical intrinsic selection. String factories use the real
StringCreate owner, not raw wrapper storage. Boolean/Number unboxers, canonical
undefined, TypeError name/message leaf and constructor definitions are
independently re-derived at completion. No source/public publication is added.

The first native run is terminal exit one: **62/65 pass**, zero skips, with all
**48/48 runtime cases passing**. Three dependency-forgery tests correctly
trigger a canonical-body refusal but then expect the weaker `missing canonical`
diagnostic. The physical ledger is already terminally failed, so it correctly
refuses subsequent access as `physical index requested in failed`. Assert both
the failed ledger state and that actual refusal; do not reset the ledger or
weaken the production canonical checks. The new prototype-selector corruption
control follows this same terminal-state contract. Retain
`.tmp/s7aj-native.json` SHA256
`9859f9a978b974101d9448426f947ac7a7a19bd7abbc184bdc732d8ba5e502c0`
and `.tmp/s7aj-native.log` SHA256
`301d664ddb7dfe31e4c201d2dc3ffbb7fb564e1758467793b6b43e7534c29a63`.
That run predates the additional slice/rope/lone-surrogate/selector controls;
the expanded pre-correction and corrected runs are separate records.

Shared control-flow/structural preservation is terminal **107/107 pass**
(96 pure ToObject and 11 prototype-builder cases), zero skips, exit zero.
The report includes lone UTF16 surrogates in case names; jq refuses those
escaped strings, so read the untouched report with JSON.parse, retaining all
code units and positive two-file/case-count floors. Do not normalize case/error
strings or treat the JSON reader refusal as a failed semantic test.

Two new modules are classified in existing backend-wasmgc/native-runtime
layers. Inventory valid:1986 source modules, zero errors, architectureComplete
false. Largest SCC712, four nontrivial SCCs and all direction metrics equal the
parent; the same four directions remain red against main. Whole-PR source
budget384 files/net -15816 LOC; the two existing function grants are unchanged.
No new floor, edge allowance, baseline, root or waiver. Preservation-only6/6
full+6/6 cut still passes; strict dynamic-import closure/retirement remain open.
Final complete new/old runtime results must be inspected before claiming
complete passing verification; the user-requested work-so-far PR may retain
explicitly pending verification in its handoff.

#### S7-aj PR checkpoint and actionable handoff

Publish the work so far to the existing [migration PR](https://github.com/loopdive/js2/pull/6762),
not a GitHub issue or issue comment. It remains a **draft checkpoint, not
merge-ready**: GitHub freshly reports DIRTY/conflicts and the prerequisite
[refactor(runtime): remove the host-assisted semantic policy](https://github.com/loopdive/js2/pull/6701)
is OPEN/unmerged. Both repo issues remain in progress.

The expanded pre-correction execution is now terminal: **64/68 pass**, including
**50/50 runtime cases**, zero skips, exit one. The four failures are the same
terminal-ledger expectation defect described above (including the added
prototype-getter corruption control), not permission to weaken canonical checks.
The corrected full68-case execution and older175-case preservation execution
are still active when preparing this handoff. **No clean68-case result or
175-case/all12-binary preservation claim is made.** Their live session IDs are
4700 and83531 respectively; continue observing those jobs, do not restart or
kill them. Scratch reports/logs and exact source/report hashes, measured
components, gate results and limitations are recorded in
[the native ToObject audit](../audit/6979-native-to-object-20261020.json).

Next maintainer actions, in order:

1. Read terminal exits and complete reports for those same jobs. Require68
   corrected native cases and175 older cases with zero skips/errors before
   claiming those floors. Compare old full case identities/status/error fields
   against retained S7-ai/S7-ag reports, and all12 binary witnesses (four
   extensibility, three setPrototypeOf, three retained setter, two prototype
   bootstrap). Update the audit with actual measured outcomes; retain failures.
2. Implement genuine Object.getPrototypeOf and Object.prototype.valueOf catalog
   algorithms and guarded Call entries. The former applies this ToObject owner
   to argv[0], then actual mixed getPrototypeOf, accepts only success status1
   and returns the exact prototype reference; other internal statuses must not
   become public values. The latter applies ToObject to this. Derive fixed
   entries from actual realm catalog metadata, not caller-selected handles.
3. Complete the remaining catalog/mixed Get/Call, prototype members/constructors
   and atomic authenticated source/public publication. A private kernel does
   not authorize source closures or foreign host objects. Foreign JS objects
   and callables must remain live per-instance identity-backed boundary refs,
   without recursive copying or reinstating a host semantic engine.
4. Resolve the stacked PR conflicts and still-open first-class undefined,
   Linear/WASI, architecture, custody, conformance and strict retirement proof
   obligations. Existing cycle/unknown-import failures are not waived. Do not
   mark this issue or the migration complete based on this checkpoint.

### S7-ak actual ToObject catalog consumers (2026-10-20, Codex)

Continue from signed `f431957fe97dc194076e6032f86ee375e21d9795`. Prior turn
made progress by publishing the native wrapping kernel and explicit handoff.
Corrected native and older preservation sessions4700/83531 are freshly confirmed
live; observe those same jobs while implementing, without changing their shared
fixture until they finish.

Compose the real reserved Object.getPrototypeOf, Object.prototype.valueOf and
retained Object.prototype.__proto__ getter slots. The getter uses the same
ToObject/GetPrototypeOf steps as the static method but reads this instead of
argv[0]; valueOf returns ToObject(this). Derive fixed entries/arity/metadata
from the genuine realm catalog, authenticate the exact ToObject owner and its
dependency identity, and re-derive algorithm plus guarded lifted Call bodies.
Only success status1 from mixed GetPrototypeOf is a public prototype result;
all unsupported/unready internal statuses trap. Canonically authenticate the
guard's actual error message too. Partial fills remain terminal; no raw
handle/body callback or caller-selected catalog subset is allowed.

Exercise actual native Wasm at ordinary and displaced/decoded coordinates:
fresh primitive wrappers and exact payloads/prototypes, object and callable
identity, nullish TypeError/argument ordering, stored guarded calls, stale and
foreign/counterfeit refs, generation changes and receipt-valid substitutions.
Old defaults/order/binaries must remain unchanged. Full realm population,
mixed getter invocation, foreign live boundary ownership, source/public
admission, Linear/WASI and full migration acceptance remain required.

#### S7-aj terminal results collected during S7-ak

Both previously live jobs are now terminal exit zero. Corrected ToObject passes
**68/68** (50 runtime +18 owner); four older files pass **175/175** (63
extensibility +38 setPrototypeOf +38 retained setter +36 prototype identities),
zero skips. Full file/case identity/status/error records equal the retained
old139 in S7-ai's combined report plus prototype36 in its clean final report.
The initially attempted combined comparison wrongly selected the earlier
failed prototype controls too; select the exact named populations, not whichever
duplicate a unique filter retains. No test result or error string is normalized.
All12 retained binary witnesses match coordinates/mode, bytes/SHA256, imports
and live/dead counts, with explicit4/3/3/2 floors. A first jq comparison used a
range number as its document; corrected root binding compares the actual audits.
The [ToObject audit](../audit/6979-native-to-object-20261020.json) now retains
terminal exits and exact report/log hashes. These results verify the published
S7-aj source, not the subsequent S7-ak helper/catalog changes; new executions
are separate evidence. Earlier failed runs remain recorded.

#### S7-ak implementation and live verification

`native-object-to-object-algorithms.ts` borrows exactly the three existing
catalog entries and their six algorithm/lifted slots. Its only inputs are the
genuine ToObject pack and that pack's original dependency object. Fixed
declarations/signatures, actual ToObject prerequisites, the long guard-error
initializer and every executed algorithm/guard are independently authenticated.
`native-object-to-object-bodies.ts` implements the native Call transports and
checks mixed prototype status1 exactly. Both new modules are classified in the
existing backend-wasmgc/native-runtime layers, without allowance changes.

The eighth opt-in fixture flag defaults false; original modes/order remain.
Actual new catalog verification is session74069, report/log
`.tmp/s7ak-native.json` and `.tmp/s7ak-native.log`. Separate five-file older
preservation (expected243 cases =175 older +68 kernel) is session20842,
`.tmp/s7ak-preserved.json` and `.tmp/s7ak-preserved.log`. Both are confirmed
live; do not restart or kill on an observation timeout. New source tests cover
primitive payloads/prototypes/freshness, real objects/callables and live parent
state, this/argument ordering, nullish errors, guarded stored identity, hostile/
foreign/stale refs, receipt-valid substitutions and partial fills.

The normal new component has emitted real zero-import Wasm:47499 bytes,
SHA256 `4fd674c1b019f2f3e4c31ca714d923ed8f683b06bee151d91d75256f743fcb4d`,
live114/dead snapshot95, wholeRealmCompleted=false. This is **not** a passing
test cohort. The fourteen measured synchronous component phases total above
the new whole-component120-second setup hook; its stdout appears under the
next group's context. Inspect the original terminal hook/case errors before
attributing failures. If confirmed, partition only this larger new fixture into
explicitly counted bounded setup phases rather than increasing case/RPC/old
fixture deadlines or weakening canonical audits. Preserve the first execution.
Its test SHA256 is
`da5cd86f4f52026ef017d583725ec10bfeb40838b6b1f733adeec731c87bbc30`;
helper SHA256 `047c9820f1ff9c6e637bbd087092b49c162cf06f20a324b3a32b01fb33bee495`.

Typecheck/lint/format, source/function/coercion/oracle, layering/flat and standard
fallback checks are terminal exit zero. Whole PR386 source files/net -15559
LOC, same two existing grants. Inventory valid1988 modules (1986 tracked, two
new untracked), zero errors, architectureComplete=false, policy hash
`e888dd4fc651053bd9e579571b786199dbfc9183be7287b387442f92183123ff`.
Cycle check is exit one with current metrics exactly equal S7-aj; same four
directions remain red. Preservation-only6/6 full+6/6 cut passes, strict closure
still fails two unknown imports and retirement is not certified. No Test262,
historical custody or broader compiler-control rerun is implied. New catalog
changes remain uncommitted pending runtime evidence; published head stays
`f431957fe97dc194076e6032f86ee375e21d9795` and the migration remains unfinished.

#### S7-ak bounded component preparation and program-level recheck

Both original jobs remain active. The measured larger catalog component
exceeds the original single120-second setup hook; preserve that original
report and inspect its exact terminal errors rather than treating emitted
Wasm as executed assertions. The new test now advances the same lazy generator
through fourteen named120-second hooks. Each hook asserts the exact expected
done state, including a mandatory final completion: early/late/empty setup
cannot pass. Every actual fill, canonical audit, reachability check and emission
is retained. Old fixture/case/RPC deadlines are unchanged; the new larger
component's **total** setup is explicitly split, not claimed to retain the
original120-second total budget. Its positive-owner fill also belongs in
bounded setup before the separate canonical completion assertions. No
production body/check changed. An initial duplicate-hook lint refusal was
fixed by constructing only the lazy iterator during collection; no work runs
outside the bounded next() hooks and no lint rule was suppressed.

Corrected full-file verification is session5862, report/log
`.tmp/s7ak-native-corrected.json` / `.tmp/s7ak-native-corrected.log`, distinct
from original74069 and older243-case20842; all continue, none was killed.
These per-execution fork-limit-one jobs overlap, so no performance/concurrency
causal claim is made. Corrected test SHA256
`2d73c21b0c4b58d325e8eecd14497d799a7d6afd9818ef73143580054d52810b`;
helper SHA256 `51f986495bbbbb04b0917dc2f4ba0f8a3db6c7c9cfa69069f5e6adc5ead7a4d7`.
The only helper change since original243-case start is exporting the existing
generator plus its comment; emitted instruction-building code is unchanged.
Inspect actual retained binaries and all original case/error fields before
claiming preservation of this helper revision. Typecheck/lint/format for the
corrected test setup pass; the original failed lint log was retained.

The full migration is not reduced to catalog tests. A fresh program-level
read still finds src/runtime.ts10230 lines versus the8000-line acceptance bar;
the standalone-arm gate reports improved ceilings (codegen653→632,
expressions157→155), not zero remaining arms. The named host-import-policy
command initially exits one because this Node24.4.1 invocation lacks required
Wasm exnref support (`Invalid opcode 0x1f`); retain
`.tmp/s7ak-host-import-policy.log`. Rerun the same script with the Node feature
flag, not changed compiler options/assertions, in
`.tmp/s7ak-host-import-policy-exnref.log`. Neither compilation refusal nor an
unobserved rerun certifies the import gate, full native IR/source admission,
broader conformance or the remaining program-level criteria.

The feature-enabled host-import-policy rerun is now terminal exit zero:
**33/33 named probes compile**,437 total imports, zero regime-gap/unknown
imports; selected accelerator counts are regexp4/date1/intl4. Positive jq
checks require33 actual named rows,33 reported probes and all per-row gap/
unknown counts zero. Three separate named-gap inventories remain nonempty:
eager-generator-buffer5, shared-array-buffer1, temporal-strings2. The script
checks their explicit name ceilings and nonempty inventories but does **not**
assert result.success there, so this result proves neither their successful
compilation nor a verified compilation refusal. Those imports are not part of
the33 positive-probe total. Closing the three native semantic gaps remains in
scope; do not delete their controls or relabel them to certify retirement.
This is the script's default compiler-route preservation check, not
proof of completed IR/source/public ownership or execution of all feature
semantics. Measured resolveImport1371 lines/7 cases is below its2000-line bar;
runtime.ts10230 is still above8000. Log SHA256
`502793057f0b2b345b28bb9be45b6506df077c63005fb8f80e80989d22700861`;
the initial no-feature refusal's SHA256 is
`b38fee9483a3d3c4d793192a12f9eced418ec7a44b687d80c5284ea1307cde8d`.
No import allowance, runtime metric ceiling, baseline or compiler setting was
repinned to obtain this result.

#### S7-ak original terminal failures and independent dependency controls

Original74069 is now terminal exit one: **9 pass,5 fail,40 skipped /54**.
Both120000ms component hooks time out, so none of its40 runtime assertions
execute. The positive catalog and interrupted partial-fill cases hit35000ms
deadlines. Three post-mutation controls correctly encounter allocator refusal
earlier than their expected semantic-owner errors: `altered function descriptor`,
`altered completed function`, `altered completed global`. All six independently
receipt-valid catalog algorithm/lifted substitution controls pass. The JSON
timeout rows contain STACK_TRACE_ERROR; retain the full original log's real
timeout diagnostics, not a normalized replacement. JSON SHA256
`d238f92513cd761924ce2f0e2b9230247b4d3c174b0918348016ea1533060ebb`;
log SHA256 `183f8026acd2eb8639fd5414b1682975894d4cc46a08163525d6e7687a81db5e`.

Assert those exact stronger mutation refusals plus failed ledger state. Add
two **additional** receipt-valid dependency controls: intercept the original
kernel body fill and the original long guard-error initializer fill, assert
their actual completion receipts, then require the downstream catalog owner
to independently refuse their noncanonical definitions. These differ from
post-fill mutations; neither substitutes for the other. Partial-fill setup now
performs the actual interruption under a bounded hook and verifies the first
real algorithm/lifted receipts; the case still requires terminal retry and
completion refusal. No production code, canonical check, old deadline or
runtime expectation was changed. Typecheck/lint/format pass.

New full-file authenticated-control verification uses
`.tmp/s7ak-native-authenticated.json` / `.tmp/s7ak-native-authenticated.log`.
Expected source count56 =40 runtime +16 owner, not a measured passing count.
It is separate from still-live intermediate5862 and older243-case20842; no job
was killed. Current test SHA256
`018212d4906bbca3dbe00e0fdfa61bf8416f60b39582380c94ba3da66d1f8f26`.
The [catalog ToObject audit](../audit/6979-native-to-object-catalog-20261020.json)
retains exact source versions, failures, actual component witnesses and all
program-level limits. Neither new full source admission nor goal completion
is implied by these private kernels or by the33 compiled import probes.

#### S7-ak exact callee versus stored transport control

The live authenticated-control execution now reports all40 runtime rows:
**38 pass,2 fail**,19/20 in each coordinate, not a terminal full56 result.
Both failures are the same misrouted test control. `storedN` deliberately reads
the supplied self's function pointer and calls it through the shared catalog
ABI. The first supposed wrong-self candidate is the genuine Object.isExtensible
singleton, so the observer correctly calls Object.isExtensible and returns a
Boolean rather than throwing. It never calls the intended getPrototypeOf/
valueOf/getter target's guard. Do not break legitimate dynamic dispatch in the
production implementation to satisfy that invalid negative control.

Correct the negative controls to call each **actual exported lifted target**
with the wrong self. Add a positive control that the shared Call signatures
match and the stored observer still invokes the supplied genuine builtin,
returning its real extensibility result. Retain stale direct and stored calls
for all three old singletons after reinitialization. All prior wrong-self/
metadata/realm candidates remain; production guards/bodies are unchanged.
Typecheck/lint/format pass; current test SHA256
`b19c8be3604e9f68e898b0c79c9e6d8f9ae6ea725d96156feee82964516c8dcb`.
This correction still needs a separate full56-case rerun after one existing
job finishes; do not restart/kill the active older/intermediate jobs or count
their older test sources as verification of this revision.

#### S7-ak intermediate terminal evidence and current full run

Intermediate5862 now exits one: **47/54 pass,7 fail,zero skips**. All40 runtime
rows execute (38 pass,2 misrouted-callee controls); owner14 is9 pass/5 fail.
Its failures retain the three weaker post-mutation expectations and two35000ms
compile-time audit/partial-fill case deadlines. There are no remaining setup
hook timeouts in that revision. JSON SHA256
`e501705e97148739199837a2f4047302b5f4e87208de274d2ac633f265449def`;
log SHA256 `5edbb663aae2ae8b6ac14c86737712006df4bfd0ae692940c5b7d36809b4f7e1`.
Both new receipt-valid kernel and guard-error dependency controls also pass in
the separate still-live47932 execution; no complete56-case result is inferred.

The positive owner's compile-time completion audit now executes under bounded
preparation as well as its fill, with a cooperative yield between them. The
case still checks the actual returned owner identity, duplicate refusal and
incomplete full-realm authority. A failed canonical audit fails preparation;
none of its work is bypassed, cached into authority or made optional. The new
setup deadline is120000ms per phase; old35000ms cases/RPC/older hooks remain.
Together with the direct-target callee checks and actual partial-fill setup,
current source hash is
`da84ccc7b0044449b720f2c92b3ae7c00817ee13dde56df4f5de5ec8be015e52`.
Typecheck/lint/format pass. Full current56-case verification is session78956,
`.tmp/s7ak-native-callee.json` / `.tmp/s7ak-native-callee.log`, started only
after intermediate5862 terminated. Older20842 and prior47932 remain active;
observe those same jobs and preserve actual failures. No production body or
canonical guard changed, and no passing full current cohort is yet claimed.

Current78956 now reports **40/40 runtime assertions passing**,20 normal and20
displaced/decoded/allocating, including direct-target negative self guards,
positive supplied-callee stored transport and all stale direct/stored cases.
Both components still match original bytes/hashes exactly. This is partial
live evidence: the16 ownership controls and whole runner exit remain pending,
as does full older243-case/14-binary preservation. Do not promote the draft,
certify full source/public admission or close the migration from these40 rows.

Prior dependency-control run47932 is now terminal exit one: **54/56 pass,2
fail,zero skips**. Both failures are exactly the known stored-callee negative
control mistake. **All16 ownership controls pass**, including both independently
receipt-valid dependency substitutions, all six catalog-body substitutions,
genuine completion, terminal partial fill and stronger physical mutation
refusal. JSON SHA256
`aed3b0f2dc4e320cc7d24d0a798fb81b64a06307ba925c842b81b7a6d5a4107b`;
log SHA256 `dd1cf26f7c171adedd5d3bc92ad85e26a2846c07928e0ca4726b67b4b64ee33d`.
Do not combine its16 with the separate current40 runtime passes and call that
one clean56-case run; current78956 must finish independently. Source gates are
being refreshed for the eventual signed checkpoint; no new publication yet.

#### S7-ak complete older-case and binary preservation

Older20842 is terminal exit zero: **243/243 pass across five files**, zero
skips (63 extensibility,38 setPrototypeOf,38 retained setter,36 prototype
identities,68 ToObject kernel). Full file name/status/message and case
fullName/title/ancestorTitles/status/failureMessages exactly equal the clean
S7-aj175-case report plus its separate68-case report, with positive five-file/
243-row floors. No error/case normalization or expectation update.

All**14** older component witnesses match their retained audits exactly for
coordinates/mode, bytes/SHA256, imports and live/dead counts. Positive family
floors4/3/3/2/2 and empty-import/incomplete-realm controls pass. Only field
names mode/booleans and reachable/reachableFunctions are mapped for comparison;
no executed data are normalized. This also checks the export-only helper
revision against actual emitted binaries, not just a source-equivalence claim.
JSON SHA256 `4c96ca75ca768c5b40ab32161661d3d685fff32d230d1599728df8fca8df971e`;
log SHA256 `8926d7a56b52312b60dc7109177ef1cb4fb497a14673840e665d3c1b8f997c5c`.
Current78956 still needs its terminal full56 result before publication. Do not
use this older-case proof to certify new source/public admission or retirement.

#### S7-ak verified catalog checkpoint and next producer handoff

Current78956 is now **56/56 pass**,40 runtime +16 owner, one file, zero skips,
all case failureMessages empty and runner exit zero. Five-file older preservation
is separately **243/243 pass**, all14 exact component witnesses unchanged as
above. These are **two clean executions**, not one299-case execution. Final
native JSON SHA256
`05b8f6d5ea8676b45cfa0d8ff80be016dc4534a055c3d3a46870323958aec277`;
log SHA256 `04073bbbe1a5a29af682c5d38564afd26d13e4f0260892e3f6b244bdc2b23ea0`.
Both final catalog components match the original emitted bytes/hashes and
all metadata exactly, with a positive two-row floor. Production source did
not change during the instrumentation corrections. Earlier9/54,47/54 and
54/56 failures remain separately recorded with their actual sources/errors.

The actual Object.getPrototypeOf, Object.prototype.valueOf and retained
__proto__ getter algorithm/guarded Call slots are now implemented and verified
in the private native domain. Genuine same-family ToObject and long guard-error
dependencies are independently re-derived; all six receipt-valid slot
substitutions, both receipt-valid dependency substitutions, real partial fills,
post-fill mutations, callee identity and actual payload/prototype behavior are
covered. Real ledgers remain filling/unsealed/incomplete. No public constructor,
host semantic import, graph copying or whole-realm/source-provider completion.

Refreshed typecheck/lint/format, size/function/coercion/oracle, layering/flat and
source preservation checks pass within their stated scopes. Strict closure
still fails the two unknown dynamic imports, architecture remains incomplete
with the same four red cycle directions, and retirement is not certified.
The33-probe default-route import gate passes but leaves three separately
named native-gap inventories and does not prove completed IR/source admission.
Runtime10230 still exceeds8000. No broader Test262/custody/compiler-control
cohort is silently certified by these component tests.

Publish this checkpoint to existing draftPR6762 with this handoff and
[exact catalog audit](../audit/6979-native-to-object-catalog-20261020.json).
Prerequisite [refactor(runtime): remove the host-assisted semantic policy](https://github.com/loopdive/js2/pull/6701)
is freshly OPEN/unmerged; latest PR readback still needs to be checked before
describing conflicts or mergeability. Do not mark ready or merge this unfinished
stack from private catalog completion alone. No GitHub issue/comment.

Next actual work is the genuine mixed Get/Call graph and remaining catalog
member/constructor algorithms, followed by the real initializer/descriptor
population and atomic authenticated source/public publication. Respect the
existing mixed.get reservation's pending invocation owner: no raw getter/call
handle binder, arbitrary source body or wholeRealmReady/count/receipt shortcut.
Source closures need actual prepared body custody; foreign JS objects/callables
must use live per-instance identity-backed boundary refs, without recursively
copying graphs or restoring a JS semantic engine. Keep first-class undefined,
Linear/WASI, the three named gaps, remaining runtime/arm retirement, architecture/
strict closure, custody/conformance/npm-compat/accelerators and PR conflict
resolution in full scope. Both Markdown issues stay in progress and the full
migration goal stays active.

#### S7-al verified source-body custody; mixed Call join remains pending

Fresh tracing confirms that mixed Get already has a shared algorithm builder,
but its reservation remains deliberately unfilled until genuine mixed invocation
joins. The source-callable association authenticates original prepared units,
shapes and slots, not their canonical lowered bodies. The actual source emission
owner runs the IR lowerer, but its completion currently remembers only unit IDs
and accepts allocator fill receipts. A receipt-valid substituted definition
during that fill must not become future mixed Call authority.

Retain private, independently cloned definitions from the actual prepared-body
lowering before handing them to the ledger. Compare those original definitions
at completion, make interrupted source fills terminal, and issue a separate
realm-source body-custody capability only after every genuine source unit passes
that comparison. It must bind the exact source emission, original full realm
association and same ledger; no raw body/handle binder or caller-selected subset.
This is body custody, not canonical source allocation, whole-realm population,
mixed Get/Call completion or foreign boundary admission. Add positive actual-IR
execution and receipt-valid substitution/interruption controls before relying on
the capability. Linear/WASI and the rest of the full migration stay in scope.

The implementation now retains those actual lowered definitions before ledger
fill and compares their locals/body independently of the allocator's accepted
receipt. A real attempted source fill is terminal even when an interceptor
throws before invoking the ledger, or after the ledger accepted the definition.
The separately issued `realm-source-body-custody` capability binds the genuine
emission, full original realm-callable association and ledger, and rechecks
completion/identity on every use. Existing association-only APIs retain their
original limited scope. This does **not** certify all resolver/ABI/dependency
bindings: the mixed graph must authenticate those owners separately too.

Current focused verification is **18/18 pass**, one file, zero skips and
terminal runner exit zero (session20529). Normal and displaced+decoded variants
execute actual zero-import Wasm with independent captured/empty source closures
and repeated calls in two instances. Eight receipt-valid replacement/in-place
body/local substitutions are accepted by the ledger and independently refused
by source completion. Other controls cover incomplete/raw-receipt populations,
copies and foreign ledgers/realms, duplicate lowering, four actual interrupted
fills before/after ledger acceptance and post-issuance mutation. The original
16-case run remains separately **14/16**, two positive cases stopping at Vitest's
opaque-object matcher; use Object.is for those exact identity observations.
Two new after-ledger interruption cases bring the corrected population to18.
No production change or deadline increase was used to correct that instrument.

Exact source/report hashes and limits are in
[the source-body custody audit](../audit/6979-native-source-body-custody-20261020.json).
The five-file source/invocation/getter/realm/mixed preservation run is now
**171/171 pass**, zero skips and terminal exit zero. Session64251 is **closed**;
do not poll or restart it. Positive five-file/171-row floors, all case statuses
and empty failureMessages, plus exact per-file42/61/37/26/5 row counts were
checked. This is a separate execution from18/18, not one189-case run. No
before/after byte-identity comparison is claimed. The audit records both exact
reports/hashes. The earlier catalog56/older243 cases were not rerun this turn.

Final typecheck/lint/format and source ratchets pass. Inventory is valid for1988
modules/zero errors but architectureComplete=false. All current cycle metrics
exactly equal S7-ak; the same four red directions versus main remain unwaived.
Preservation-only6/6 full+6/6 cut witnesses pass, but strict modeled closure still
fails the two previously named unknown nonliteral import targets. Retirement is
not certified. No new floor/root/edge allowance/baseline/grant or host import.

Next consume this genuine body custody alongside the actual ABI/dependency and
allocation owners in the mixed invocation graph; validate exact source function
identity/realm, not shape or signature alone. Then complete remaining catalog,
constructors, descriptors/population and atomic public/source admission. Keep
live per-instance foreign boundary references, first-class undefined, Linear/WASI,
the three named gaps, runtime/arm retirement, architecture/strict closure and
custody/conformance/npm-compat/accelerators plus PR conflicts in the full scope.
Both issues and the full migration remain in progress; do not mark ready/merge
from body custody alone. No GitHub issue/comment is created.

Signed source checkpoint `38532b0c901b63a45e39b5d1c0703ec89a706c68` is pushed to
the existing migration PR. Normal pre-push typecheck/lint/format/oracle/coercion,
18/18 numeric-local tests and committed issue integrity all pass. The earlier
pending-run handoff in that commit was accurate when written; this terminal
readback supersedes it without rewriting history. Prerequisite
[refactor(runtime): remove the host-assisted semantic policy](https://github.com/loopdive/js2/pull/6701)
is freshly OPEN/unmerged, and the migration PR remains draft/unmergeable.

#### S7-am source code identities and actual allocation join (in progress)

The next mixed Call join must identify actual source code without pretending
that a matching funcref signature identifies a function. Wasm `ref.eq` accepts
eqref, not function references. Use one fresh immutable GC code box per original
lifted unit and instance, with its actual `ref.func` supplied only by the genuine
source-body custody producer. Canonical global initializers and matcher bodies
must be audited independently of fill receipts. The eventual native Call loads
the target from that authenticated box, not an unchecked compatibility-header
funcref. This is code-target identity, not arbitrary source allocation authority.

Join the issued code declarations into native source carrier reservation and
actual IR `closure.new` allocation: preserve capture/state coordinates, append
an immutable code-box tail, and select its exact global from the original
lifted unit binding. Keep the existing stateless/state-only paths unchanged.
Do not edit the historically pinned closure-layout source/receipts; extend the
native lowering metadata in its own shared leaf and consume it in the IR WasmGC
emitter. Enumerated readers are native-source-closures, nativeSourceClosureResolver,
the WasmGC closure allocator and existing layout/ABI/custody tests; existing
Linear/bytecode refusal behavior must not be relabelled implemented.

Test actual prepared allocations and code identity across distinct units sharing
an ABI/shape, independent instances, fresh realm generations, captured/empty
closures, receipt-valid substitutions and partial fills. Keep body/ABI/dependency,
allocation and full realm/public completion scopes distinct. Foreign JS values
stay live identity-backed boundary references; no graph copy or new host import.
The full mixed Call/Get/publication, Linear/WASI and all earlier acceptance work
remain in progress rather than being certified by this identity component.

Architecture follow-through: semantic realm/source selection belongs in the IR
producer, while the new backend owner reserves/authenticates a data-only physical
description. The IR join must revalidate the genuine realm, canonical key and
complete original source population; raw physical declarations are not semantic
authority. Reuse the existing backend declaration comparator for actual type/
global descriptors, not a new IR comparator dependency. Move the actual pure
native String resource-key function below IR/backend (retain its compatibility
export and exact function identity), and make the timer bridge read the existing
canonical exception-policy contract directly instead of importing the compiler's
IR compatibility facade. These are real dependency cuts, not edge allowances or
rewritten historical receipts. Recheck the complete cycle/inventory graphs.

The implementation is now verified by **24/24 focused cases**, one file, zero
skips and terminal exit zero (session10771 closed). Actual prepared native IR
allocations carry immutable code-box tails; three real source units include two
sharing both signature and capture shape. Zero-import Wasm executes the actual
boxed targets with captures, independent instances and live realm checks.
Same-signature/same-shape target substitutions and accept-all matcher bodies
can receive valid allocator receipts, but independent canonical audit rejects
them. Partial fills remain terminal. Raw physical source-subset declarations do
not grant source typing or semantic completion. String-key and callback-policy
compatibility exports retain exact function/object identity.

The first attempt was **1/22**,15 failures/6 skipped: a real production phase bug
requested final indices before reservation freeze. The next was **4/22**,12
failures/6 skipped: the code filler redundantly declared source references that
the original binder already owned. Fix the real producer: bind the full reference
union once and never redeclare it during code fill. These were not merely test
instrument failures, and the skipped runtime cases are not measured successes.
An intermediate22/22 run is separate from final24/24; all22 original full case
identities/status/error fields exactly equal their final subset. No deadlines,
ledger safeguards, assertions or historical pins were weakened.

[The exact source-code identity audit](../audit/6979-native-source-code-identities-20261020.json)
retains every report/hash and the final source hashes. Preliminary preservation
was260/260 across seven files, including71 exact historical closure-state cases;
it began before the final ownership/dependency corrections and is **not** a
single final-source-revision cohort. Final nine-file preservation (the same seven
plus native timer and async-provider coverage) now passes**284/284**, zero skips,
all assertion failureMessages empty and terminal exit zero. Positive9-file/284-row
and exact per-file count floors are checked. Full file/case identities, statuses
and error fields equal clean S7-al171/18 and preliminary260 evidence in their
respective positive5/1/7-file subsets, without case/error normalization or adding
overlapping populations. This is separate from24/24, not one308-case run.
Session65692 and every other test handle named in this S7-am section are now
**closed**; do not poll or restart them. Final source hashes remain unchanged.

Typecheck/lint/format and source gates pass within their stated scopes. The final
inventory is valid for1991 modules/zero errors (pre-staging1988 tracked+3 new),
architectureComplete=false. The runtime→IR edge and its two-way directory pair
are actually removed; ir→backend stays at main's25. The same four older red
directions remain unchanged, largest SCC712/four nontrivial SCCs. No new edge
allowance/root/floor/baseline/grant. Strict modeled closure still fails the two
unknown nonliteral imports; preservation-only6/6 full+6/6 cut is not retirement
certification. The historically pinned closure-layout source and state receipt
remain byte-for-byte unchanged; no broader emitted-byte comparison is claimed.

This is **code-target identity**, not certification of the compatibility-header
funcref, full source allocation custody, argument/receiver/result adaptation or
general mixed Call. The test-only f64 observer loads the genuine boxed target;
it is not a public JavaScript Call implementation. Next complete actual source
allocation/ABI/dependency custody and semantic Call adaptation, then join source
code identities with genuine builtin, bound and live foreign boundary owners.
Keep Get/remaining catalog/constructors/population and atomic public admission,
first-class undefined, Linear/WASI, three named gaps, runtime/arm retirement,
architecture/strict closure, custody/conformance/npm-compat/accelerators and PR
conflicts in full scope. Both issues and the full goal remain in progress. No
GitHub issue or issue comment is created; do not mark this unfinished stack ready.

Concrete next custody gap: `bindNativeSourceClosureUnits` records lifted source
units, not all original functions owning `requirements.allocations` occurrences.
`fillPreparedPrimaryUnit` therefore does not retain canonical definitions for
ordinary factory bodies even when those factories emit the new code tail. Bind
the union of genuine lifted and allocation-owner units to their original slots,
and retain/audit their actual lowering without substituting a function count.
Source closure/capture/ref-cell resolution and allocation target handles must
come from the genuine source owner; a caller-supplied resolver or signature alone
does not prove those bindings. Authenticate the actual slot ABI as well. Keep
argument/receiver/result adaptation separate: the test's f64 observer is not
permission to unbox arbitrary JavaScript arguments or call every source ABI.
