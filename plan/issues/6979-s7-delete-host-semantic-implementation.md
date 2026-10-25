---
id: 6979
title: "S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators"
status: in-progress
assignee: ttraenkler/opus-s7c-collapse-arms
created: 2026-10-14
updated: 2026-10-25
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
loc-budget-allow:
  # 2026-10-16 (#6979 S7-c): +1 import line for runtimeEvalProviderLinkable, the WASI-excluding
  # runtime-eval capability gate; the S7-c expressions fold removes far more than it adds.
  - src/codegen/expressions/eval-inline.ts
  # 2026-10-16 (#6979 S7-c): inModuleStdoutSink(ctx), the environment key of the #3469 console sink
  # (+10 next to hostFreeEnvironment/jsValueBoundary, where every environment key lives). Without it
  # WASI on the regime prints nothing (34 WASI rows red).
  - src/codegen/context/types.ts
# (2026-10-20, S7-a landing) Not growth: deleting the dead
# `__rethrow_host_exception` provider arrow in resolveImport renumbers the
# anonymous functions after it, so main's existing 309-line `<anonymous>#95`
# is reported as a NEW over-budget `#94`. Same function, same size.
func-budget-allow:
  - src/runtime.ts::<anonymous>#94
  # 2026-10-16 (#6979 S7-c): formatting only. Un-nesting the regime arm of a
  # `ctx.standalone || ctx.wasi ? registerNative(...) : undefined` ternary leaves a
  # call prettier wraps over 7 lines (+3 net); the function lost its host branch.
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
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

### S7-b checkpoint (2026-10-15, opus-6979-s7b)

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

### S7-c checkpoint (2026-10-16, opus-6979-s7c)

Branch `issue-6979-s7c-collapse-standalone-arms`, stacked on the S7-b head
`aac2b4040d` (draft #6705 → #6701 → #6672). This is the first S7-c sub-slice
set: the ratchet, the WASI verdict, and three directories. S7 stays
`in-progress`.

**How this was measured.** A corpus of 2,442 programs: equivalence-suite
sources, playground examples, and a 1-in-40 sample of 16 test262 directories.
Each was compiled on `gc`, strict gc (`strictNoHostImports`), `wasi` and
`standalone` (9,768 compiles per scan), in three fixed shards. The compiler
keeps per-process caches, so two scans are only comparable with the same shard
layout; every per-commit comparison below uses the same layout, and any
cross-layout difference was re-checked by compiling in isolation.

**The ratchet.** `scripts/check-standalone-arms.mjs` counts `ctx.standalone`
(not the `ctx.standalone*` sibling fields) per `src/` directory against
`scripts/standalone-arms-baseline.json` and fails on growth. The baseline is
written only by `--update-on-decrease` and `--update`. It runs as
`check:standalone-arms` in the `quality` job and is banked post-merge next to
the flat-dir bank in `test262-sharded.yml`. The plan's 1,659/495 figure
predates S7-a/S7-b; the seed on the S7-b head is 1,538.

| Directory | S7-b head | After S7-c (this PR) |
| --- | --- | --- |
| `src/codegen/expressions` | 345 | 0 |
| `src/codegen/statements` | 36 | 0 |
| `src/codegen/object-model` | 27 | 0 |
| `src/codegen` (top level; includes `object-*.ts`, 106 → 0) | 986 | 875 |
| `src/codegen/declarations` | 39 | 37 |
| `src/codegen/context` | 6 | 5 |
| `src` (top level) | 6 | 4 |
| `analysis` / `array` / `classes` / `closures` / `helpers` / `registry` | 3 / 21 / 16 / 13 / 5 / 9 | unchanged |
| `src/ir` / `src/runtime/contracts` | 24 / 2 | unchanged |
| **total** | **1,538** | **1,014** |

**WASI verdict: flipped.** `nativeRegime` is now `backend === "wasmgc"`, so
`ctx.standalone` is true for every WasmGC build and create-context asserts it.
S7-a measured 14 new WASI errors from this flip. On the S7-b head, with the
larger corpus, it is 16. They are not regime gaps:

- 15 are one mis-keyed environment site. The native RegExp engine was
  selected by `target === "standalone" || environment === "javascript"`, so a
  WASI regime build had no engine and refused every RegExp that gc and
  standalone compile. It is now selected by `nativeRegime`.
- 1 is a regime gap shared with gc and standalone (GAP list below).

Two more environment sites only showed up in behaviour, not compile errors.
Both were re-keyed in byte-identical commits before the flip:

- The runtime-eval provider: new `runtimeEvalProviderLinkable(ctx)`. A WASI
  host has no provider, so WASI keeps the #4195 refusal; without this, 13
  corpus programs gained `js2wasm:runtime-eval` imports.
- The #3469 in-module stdout sink: new `inModuleStdoutSink(ctx)`, true only
  for `environment === "none"`. Without it every WASI `console.log` went into
  the sink instead of `fd_write`, printing nothing (34 WASI test rows red).

Flip measurements (WASI lane):

| Measure | Result |
| --- | --- |
| WASI binaries changed | 1,665 of 2,442 |
| failing → compiling | 40 (the RegExp family, `wrapper-constructors` #3) |
| compiling → failing | 1 (`Promise.withResolvers`, GAP below) |
| non-WASI imports gained | 0 |
| non-WASI imports lost | `env.__make_getter_callback` (40 programs) and `env.__dynamic_import` (8) no longer leak into WASI binaries |
| the 251 test files that compile for WASI (3,037 tests) | 0 regressions after two re-pins (below); 1 newly passing (`issue-3791` WASI exclusion) |
| gc / strict / standalone | 0 binary changes |

The two re-pins:

- `issue-4396`: the wasi profiles now carry `nativeRegime: true`.
- `issue-4035`: the WASI size cap. The REALISTIC program at `-O3` is
  37,729 B on the old WASI lowering, 69,307 B on the regime, and 68,066 B for
  `--target standalone`. WASI now carries the standalone runtime, so the cap
  moves to 72,000.

Not done: the function reachability sweep (`functionSweepEnabled`) still
excludes WASI. With it forced on (`JS2WASM_FUNC_SWEEP=1`), the 251 WASI test
files show 0 regressions and 1 more pass (`issue-2921`), and REALISTIC drops
to 66,041 B. It is a separate optimisation decision.

**Classification.** Every code hit in the three directories was semantic.
With the regime constant, the fold cannot change a binary. The environment
and value-boundary questions that matter for WASI were settled at the flip,
by the three re-keys above. No `!ctx.standalone` arm was the only
implementation of a construct for the JS environment, because the JS
environment has run the regime arms since S6. The flip's WASI deltas are the
only place a host arm could still have been load-bearing.

| Directory | Hits at the flip (code / comment) | Re-keyed before the flip | Deleted with the fold |
| --- | --- | --- | --- |
| `expressions/` | 314 / 23 (all code sites semantic) | 8 runtime-eval gates → `runtimeEvalProviderLinkable` | 13 host-only helpers, 9 newly unreferenced exports, 3 empty modules; net −2,860 lines |
| `statements/` | 36 / 0 (all semantic) | — | host `__box_number` index boxing, `__register_arguments`, the `catch_all` + `__get_caught_exception` branch |
| `object-model/` + `object-*.ts` | 110 / 22 (all semantic) | — | `object-create-class-instance.ts` (its whole emitter was a host arm), the host descriptor routes in `object-ops.ts` |

Comment mentions are reworded, or deleted together with the statements they
described.

**GAP list (#5385).**

| Construct | Exposing program | Notes |
| --- | --- | --- |
| `Promise.withResolvers()` | test262 `built-ins/Promise/withResolvers/promise.js` | The regime refuses it (`__get_builtin`, #1472 Phase B) on gc, standalone and now WASI. The old WASI lowering "compiled" it to a binary with no `Promise.withResolvers` at all. |

The three S7-b `regime-gap` families (eager generator buffer,
SharedArrayBuffer, Temporal strings) apply to WASI unchanged.

**Byte identity per commit** (9,768 hashes each, same shard layout):

| Commit | Scope | Result |
| --- | --- | --- |
| `36c5505049` | ratchet | no codegen change |
| `52e2a128c5` | runtime-eval capability re-key | identical by construction: `standalone && !wasi` ≡ `standalone` while `standalone` xor `wasi` |
| `2ce7ad55d2` | stdout-sink environment re-key | identical by construction: `environment === "none"` ≡ `standalone && environment !== "javascript"` on the pre-flip profiles |
| `ba5ca0e213` | WASI flip | WASI changes as tabled; gc/strict/standalone 0 differences. 45 sharded differences were re-compiled in isolation and are identical. |
| `d00ad81c6c` | `expressions/` | 0 differences on all four lanes |
| `e0627b6376` | `statements/` | 0 differences on all four lanes |
| `97c1c15873` | `object-model/` + `object-*.ts` | 0 differences on all four lanes |

**Validation.**

Run and green on the final head:
- `pnpm run typecheck`, Biome on `src/codegen`.
- `check-loc-budget` and `check-func-budget`, each with a dated grant in
  this file's frontmatter.
- `check-coercion-sites`, `check:oracle-ratchet`, `check-import-cycles`,
  `check-flat-dir-budget`, `check:compiler-boundaries:inventory`,
  `check:standalone-arms` (all with `LOC_GATE_BASE` = the S7-b head).
- The `check:dead-exports` audit without `--require-core-nodes`. The
  core-node child times out at its fixed 120 s under this box's load (≈ 60–300).
- At the flip commit: the 251 WASI test files, `issue-4396`, `issue-4035`
  (whose one red row, "honours an explicit off", is red on the base too), and
  `tests/issue-6979-standalone-arms-ratchet.test.ts`.

Not run: `scripts/equivalence-gate.mjs`, `check:host-import-policy`,
`check:ir-fallbacks`, and the `issue-4397`/`4401`/`6978`/`6986`/`6686` suites.
#6980 and #6981 have landed on `upstream/main` since the S7-b head. A
`merge-tree` dry run shows one conflict,
`plan/audit/host-import-policy-baseline.json` (S7-b lowered the ceilings;
#6980 raised the import ceilings). The gate run belongs after that merge.

**Left for later sub-slices.**
- Directories: `array*`, string ops, closures, async, `index.ts` + `registry/`
  + `declarations/`, type coercion / binary ops, `src/ir`. Once those are done,
  remove the field.
- Now that `ctx.standalone` is constant, the remaining WASI-specific arms are
  keyed on `ctx.wasi`. Some of them decline because the old WASI lowering was
  wrong; for example, the #5316 Proxy-invariant gate says WASI answered
  `Object.isExtensible({})` wrongly. They may now be removable.
- WASI function sweep, as above.

**Handoff to the codex recovery lane (2026-10-19).** S7 ownership moved to
`ttraenkler/codex` on branch `codex/6979-s7-recovery`. Adopt this work from
branch `issue-6979-s7c-collapse-standalone-arms` (pushed to `fork`), head
the commit that adds this checkpoint (parent `97c1c15873`), stacked on the S7-b head `aac2b4040d`. No PR was opened.

Before landing:
- merge `upstream/main` (the conflict above);
- re-run the equivalence gate and the policy and ir-fallback checks;
- fold any `ctx.standalone` arms the merge brings into the three
  collapsed directories. The ratchet will flag them.

Scripts used for the scans: `.tmp/hash-corpus.mts` and `.tmp/fold.mjs` in
worktree `agent-a042bbed7c7fea619`.
### S7-a landing (2026-10-20)

Lead lane (Claude Fable) took the slice over from the Codex recovery lane;
claim `ttraenkler/fable`. PR 6701 head `33af6d1cf1` was re-merged with
`upstream/main` `7527a91ce5` (resolutions as agreed on the PR:
`scripts/check-ir-fallbacks.ts` and
`tests/issue-2637-b2-ctor-closure-registration.test.ts` take main's side,
`src/codegen/promise-dynamic-member-read.ts` takes main's side with the S7-a
deletion re-applied). What this landing pass changed on top:

- **The red that broke every compile.** S7-a deletes `isStandalonePromiseActive`
  (constant-true for every WasmGC build once `host-assisted` is gone), but three
  callers had landed on main since the recovery: `promise-dynamic-member-read.ts`
  (#7092/#7099), `promise/receiver-capability.ts` (#7089) and
  `promise/with-resolvers.ts` (#7090). The guard is folded away at all three; the
  missing ESM export is what turned the cheap gate, smoke, sanitizers and every
  issue-test shard red.
- **Three predicate sites the recovery missed**, each constant-true for WasmGC
  (`semanticProviders` is `native-first` for every non-linear target):
  `relational-to-primitive.ts` `admitsAnyRelational`, `coercion-engine.ts`
  `nativeToPrimitive`, `operator-assignment.ts` (#7084 element `+=` arm).
  `grep -rF semanticProviders src`: 234 hits / 94 files on main → 39 / 19.
  `semanticProviders ==|!== "native-first"` comparisons: 191 → 11 (the profile
  itself, the #4401 explicit-spelling publication gate, adapter-manifest
  validation, boundary-policy, and comments).
- **Dead provider body:** `__rethrow_host_exception` in `src/runtime.ts`. Its only
  emitter, `src/codegen/export-throw-boundary.ts` (host-assisted only: it returned
  early under native-first), is deleted by S7-a; the stale inventory entry for it
  in `scripts/compiler-boundaries.json` goes too. `check:host-import-policy`: 33
  probes, 452 imports, 0 legacy-semantic, 0 unknown; `runtime.ts` 20,232 lines,
  `resolveImport` 7,859 lines / 15 cases (under the S7-a ceilings 20,240 / 7,868).
- **README** no longer advertises `--semantic-providers host-assisted` (review
  comment of 2026-10-15).

Byte-neutrality (gc/standalone/wasi), measured by hooking `compile()` in both
trees and running `tests/equivalence/` on each: 1,973 programs in common (gc
1,757, standalone 211, wasi 5); 1,963 identical in the suite run. The other 10
gc rows differ only in the TypeScript checker's process-global symbol counter
(`__@iterator@19` vs `@159` in a struct field name), because the two suites run
different test files before them; compiled in a fresh process per tree all 10
are byte-identical. Net: 0 codegen differences.

Equivalence gate: `20 failing, 2008 passing, 22 known-failures`; "No new
equivalence regressions"; 2 baseline failures now pass.

Tests re-pinned from `host-assisted` to the regime (not skipped):
- `tests/issue-1528-closure-construct.test.ts`: a plain function value is
  constructed in-module (no `__construct_closure`, answers 1); the capability-ctor
  row locks that no `__call_function` helper is imported.
- `tests/issue-1712-capture-closure-dispatch.test.ts`: the acorn-shape row reads
  `.type` in-module; the dispatcher row gets the closure from an export instead of
  intercepting the deleted `__extern_set_strict` path.

GAPs exposed (pre-existing on main's default profile, identical before S7-a; to
be filed against #5385, the allocator was unreachable from this sandbox):
- `Promise.allSettled.call(Constructor, [thenable])` with a plain function
  `Constructor` throws on the regime (Node returns normally).
- A function-constructor instance returned across the export boundary marshals
  to `{}` through `wrapExports` on the regime (`ast.type` reads `undefined`).

Pre-existing reds left alone (red on main tip `7527a91ce5` with main's own copy
of each file, same failing rows): 12 touched files, 25 rows, all host-lane unit
tests on bare codegen contexts or byte/ABI pins (`issue-2949-s5-0/1/2/3/5`,
`issue-2949-slice3`, `issue-3521-fast-mixed-signature-admission`,
`issue-3521-prepared-free-function-routing`, `issue-3526-callable-boundary-callback`,
`issue-3526-string-boundary-concat-many`, `issue-1183`, `native-strings-standalone`).
Not touched here: `issue-5226`, `issue-5247`, `issue-5363` (also red on main).

- **IR-only readiness re-bank (2026-10-24, stakeholder decision):** `scripts/ir-only-baseline.json` single-host lane re-measured under the regime (38/0 → 26/12) because its basis profile `host-assisted` no longer exists; the 12 legacy units are #7103, which ratchets the lane back. Decided by the stakeholder on 2026-10-24 after the lead presented re-bank vs land-#7103-first.

### S7-b landing (2026-10-20)

Re-landed by `opus-s7b-legacy-semantic` (claim `6979:s7b`). The old S7-b head
`aac2b4040d` was merged with the re-landed S7-a head `9dae8246f6` (PR 6701, which
contains `upstream/main` as of 2026-10-20) as `c296cb96b4`; this pass sits on
top of that. Net against the S7-a head: 72 files in `src/` `scripts/` `tests/`,
+1,190 / −14,576 lines.

**Deleted (against the S7-a head).**
- `src/runtime.ts`: 20,232 → 11,539 lines (−8,942 / +249). `resolveImport`
  7,859 → 1,940 lines, 15 → 7 top-level cases. Gone: the retired `builtin`
  provider bodies (`number_*`, `__call_*`, `__array_*`/`__js_array_*`,
  `Promise_*`, `__construct*`, `__extern_*`, `__defineProperty_*`, `parse*`/URI/
  `escape`, `__to_object`/`__to_primitive`/`__box_symbol` …), the ECMAScript part
  of `extern_class`, and in this pass the ten `__temporal_*` providers
  (`_temporal*`, ~500 lines). `resolveDeclaredFunctionImport` keeps #7095's
  `declaredHostFunction` marshalling.
- `src/runtime/compatibility-semantic-adapter.ts`: 110 → 19 lines. The host
  strings / `await` driver / `host_*` operators / `same_value_zero` /
  `proxy_create` providers are gone. It **stays** because it is the provider of
  the `date` accelerator's `date_new` / `date_method` intents (#6978);
  `src/runtime.ts` still calls `resolveCompatibilitySemanticImport`.
- Whole files: `src/codegen/array-method-host.ts`, `array-method-value.ts`,
  `classes/externref-class-fields.ts`, `expressions/linked-free-global-call.ts`
  (none was touched by main this week; their `compiler-boundaries.json` entries
  go with them).
- Large emitter cuts: `new-super.ts` −1,282 (the `!noJsHost` `__construct` /
  `__construct_closure` arms, including #7014's `noSpreadArg` tweak to one of
  them, which was dead code on WasmGC), `calls.ts` −739,
  `declarations/import-collector.ts` −380, `dyn-ops.ts`, `call-identifier.ts`,
  `array-methods.ts`, `array-like-hof-arms.ts`, `host-call-fallback.ts`.

**`own-property-method-shadow.ts` survives (476 → 163 lines).** Old S7-b
deleted the module. Since then #7021 made its closed-dispatcher half live on
the regime: `noteOwnShadowDispatchCandidate` + `closedDispatchGuardsOwnSlot`
make `__call_m_<name>_<n>` user-class arms ask the native object runtime's
`__hasOwnProperty` / `__extern_method_call` for an own slot first (marked's
`use()` hooks). That half and its scan (`fileMayInstallOwnCallableMember`) are
kept, along with the `call-receiver-method.ts` / `closed-method-dispatch.ts`
wiring. The JS-host half is deleted: the `__ownshadow_<C>_<m>_<n>` guard
wrappers (`ownShadowGuardedMethodName`, `ownShadowFuncIdx`,
`fillOwnShadowWrappers`), the guarded member read
(`emitOwnShadowGuardedMethodRead`), and the `env.__hasOwnProperty` registration.
Each returned early whenever `ctx.standalone || ctx.wasi`, which is every
WasmGC build. The textual merge had silently dropped #7021's callers (main
changed only the module itself, so the deleted call sites merged cleanly).
They were restored by hand.

**Regime gaps.** `shared-array-buffer` (closed by #7011) and `temporal-strings`
(closed by #7012's in-module helpers; `check:host-import-policy` refused the
family with "probe no longer needs the gap") are deleted from
`REGIME_GAP_FAMILIES`, the classifier and the name ceiling. Their probes move
to a "closed gaps stay closed" check: each must compile with no `regime-gap`
and no `unknown` import. Left: `eager-generator-buffer` only (#680; probe
imports `__create_async_generator`, `__gen_create_buffer`, `__gen_push_f64`,
`__gen_push_ref`, `__gen_result_value_f64`).

**`check:host-import-policy`**: 33 probes, 452 imports, 0 regime-gap, 0 unknown;
accelerators regexp 4 / date 1 / intl 4. Migration metrics against the
unchanged baseline ceilings (20,240 / 7,868 / 15 / 989): `runtimeTsLines`
11,539, `resolveImportLines` 1,940, `resolveImportCases` 7, `ownedAdapterLines`
898. The ceilings can drop to those numbers; this lane was told not to edit the
baseline.

**Merge fixes beyond conflict markers.**
- `src/compiler/import-manifest.ts`: #7095 set `refResult` only on a `builtin`
  intent that classifies `unknown`. S7-b gives user `declare function`s their
  own `declared_function` intent, so the flag was never set and the declared
  function's string result trapped (`__str_concat` null deref). It now keys on
  `declared_function`.
- `scripts/compiler-boundaries.json`: the `own-property-method-shadow.ts` entry
  is back (inventory mode vs upstream `3902be94df`: valid).

**Byte-neutrality** (equivalence suite with `compile()` hooked in both trees,
S7-a head `9dae8246f6` vs this tree): 1,991 programs in common (gc 1,775,
standalone 211, wasi 5); 1,959 identical. The other 32 (31 gc, 1 standalone)
were recompiled in a fresh process per tree and still differ, by 0–1 byte.
binaryen's normalised WAT is identical for all 32. The only difference is
type-section order. The S7-a tree registers the function type of an
import-collector pre-registration of a retired host import early — e.g. a
`WeakRef_new` extern-class import, later dropped as unused. The S7-b tree never
registers it (`isRetiredEcmaScriptExternClass`), so the same signature is
interned later and type and vec indices shift. No instruction, import or
export changes.

**Equivalence gate** (`.tmp` copy, `--configLoader runner`): 20 failing, 2,008
passing, 22 known failures; "No new equivalence regressions"; 2 baseline
failures now pass (`delete-sentinel` string property, `reflect-api`
`Reflect.construct`), the same as S7-a.

**Tests.**
- `issue-4401`: `SharedArrayBuffer_new` and `__temporal_*` re-pinned from
  `regime-gap` to `unknown`/#6979.
- `issue-7012`: the host-assisted runtime-helper row is deleted (lane and
  providers gone).
- `issue-5748`: the "compatibility operator dispatch" and "semantic intent
  classification" describes are deleted (they covered only the deleted
  `host_*`/`await`/`proxy_create` providers).
- `issue-7095` / `issue-7098`: the two `semanticProviders: "host-assisted"` rows
  are deleted. They already failed on the S7-a head with the S7 rejection.
- `issue-1528`: the capability-ctor row is re-pinned. With `legacy-semantic`
  gone, `Promise.allSettled.call(<plain function>, [thenable])` is a compile
  error naming `env::Promise_allSettled`. That is regime gap #7101; on the S7-a
  head it compiled and leaked the import into standalone binaries too. Flip the
  row to a run when #7101 lands.

Pre-existing reds, identical on the S7-a head (not this slice's):
`issue-3518-host-async-imports` (2 rows: facade number walker, recursion
counter), `issue-4577-standalone-calendar-retirement` (3 rows: 38-terminal
census, TDZ guards / `$__cb_0`, artifact ceilings), and
`issue-6474-linked-script-goal` (3 linked-run rows: the local runtime-eval
provider is not an object).

**Re-merge onto S7-a of 2026-10-24 (2026-10-25, `opus-s7b-remerge`).** S7-a was
re-merged onto 2026-10-24 main (PR 6701, head `665f2bdc52`, ~290 main commits).
That head was merged into S7-b `1e7a64aaa8` as `01f6311935`. Two conflicts:
- `src/codegen/dyn-ops.ts`: main's `3551338437` (IR function-object member
  calls) added `ensureDynamicMemberCallSupport` and its imports
  (`reserveApplyClosure`, `emitWasiErrorConstructor`, and
  `ensureLateImport`/`flushLateImportShifts` from `shared.js`, which S7-b had
  dropped). All of it is kept. Its only import, `__is_callable`, is
  native-finalized. S7-b's deletions are re-applied: the host
  `string-replace` arm and `addStringConstantGlobal`.
- This issue file: S7-a's re-bank bullet goes at the end of the S7-a section,
  and the S7-b section is kept.

Nothing else conflicted. No main commit in the range imports a file S7-b deletes
or adds a `legacy-semantic` import. The `host-assisted` mention counts in `src/`
are the same per file as on the old S7-b head.

Gates on the merged tree: tsc 0, Biome lint 0, Prettier clean. Host-import
policy: 33 probes, 452 imports, 0 regime-gap, 0 unknown. IR fallbacks OK.
`check:ir-only --policy=hybrid` READY, with single-host at 26/12 (unchanged
from S7-a's re-bank). The compiler-boundaries inventory is valid. The ratchet
chain and import cycles are OK against `upstream/main` `7cc5d52322`. No new
grants. Equivalence gate: `20 failing, 2044 passing, 22 known-failures`, "No new
equivalence regressions", and 2 baseline failures now pass.

Byte-neutrality versus the S7-a head: every `compileSourceSync` call the
equivalence suite makes was recorded and replayed in both trees. That gives
2,101 distinct programs (gc 1,839, standalone 257, wasi 5). 2,062 are
identical. The other 39 (38 gc, 1 standalone) still differ when recompiled in a
fresh process per tree, by 0 or -1 byte. All 39 differ only in type-section
order:
- 12 have identical binaryen WAT.
- 27 differ only in type-index-derived helper-name suffixes
  (`__vec_elem_set_<typeIdx>`) and in `i32.const` type tags. The tags map
  consistently and one-to-one, e.g. 147→145.

This is the same cause as the 2026-10-20 run (32 then).

Fix-on-touch: the 17 touched test files plus the 15 `--pinned` files give 545
passing and 8 failing. The failures are the same 8 pre-existing rows listed
above (3518 ×2, 4577 ×3, 6474 ×3, quickjs engine absent locally), and they fail
identically on the S7-a head. I also ran main's 54 test files changed in the
range: 22 rows fail on S7-b (`issue-1102`, `2960`, `3519`, `5164`,
`7106-prophelper`, `7106-s3a`), and every one also fails on the S7-a head.

### S7-c landing (2026-10-25)

Carried forward by `opus-s7c-collapse-arms` (claim `6979:s7c`). The S7-c
branch (head `7063fea46a`, stacked on the old S7-b head `aac2b4040d`) was
merged with the re-landed S7-b head `8a081af2c3` (PR 6705, which contains S7-a
PR 6701 and 2026-10-24 main) as `19535a0b9f`, then folded directory by
directory in seven byte-identical commits. S7 stays `in-progress` (S7-d/e and
the rest of S7-c remain).

**Merge.** Five conflicts; everything else auto-merged and typechecked.
- `statements/loops.ts`: S7-b side (main's new imports).
- `statements/exceptions.ts`: S7-c's fold (unconditional `try_table`) plus
  main's `finishTryFinallyPreBox` (#6993).
- `object-runtime.ts`: S7-c's fold. S7-b had widened the gate to
  `ctx.standalone || ctx.wasi`, which is constant-true after the WASI flip.
- `object-ops.ts`: S7-c's fold, with main's #7061 method-shorthand `value`
  route re-applied, un-nested.
- This file: all sections kept; frontmatter grants unioned.

No S7-b-deleted file was resurrected. The merge brought 55 new
`ctx.standalone` hits from main's 2026-10-16..24 work (1,014 → 1,069); fold 1
removes them.

**Hit counts** (`check:standalone-arms`; the baseline is banked with
`--update-on-decrease` in this commit):

| Directory | Merged tree | After this PR |
| --- | --- | --- |
| `src/codegen` (top level) | 894 | 676 |
| `src/codegen/array` | 22 | 0 |
| `src/codegen/declarations` | 41 | 0 |
| `src/codegen/closures` | 13 | 0 |
| `src/codegen/registry` | 9 | 0 |
| `src/codegen/expressions` | 8 | 0 |
| `src/codegen/object-model` | 2 | 0 |
| `src/codegen/buffers` | 1 | 0 |
| `src/codegen/classes` / `helpers` | 17 / 6 | 16 / 5 |
| `src/codegen/context` / `analysis` | 5 / 3 | unchanged |
| `src/ir` | 42 | 0 |
| `src` (top level) / `src/runtime/contracts` | 4 / 2 | unchanged |
| **total** | **1,069** | **711** |

**The folds** (each folded with the S7-c codemod: `ctx.standalone` → `true`,
then boolean / `if` / unreachable-statement simplification; every remaining
comment mention reworded; host-only code the fold made unreachable deleted,
iterating `tsc --noUnusedLocals` against the merged tree and
`check:dead-exports` to a fixpoint):

| Commit | Scope | Hits | Notable deletions |
| --- | --- | --- | --- |
| `115269e38c` | main's new hits (31 files) | 55 | — |
| `b8fa0dbf7b` | `array*` + `array/` | 81 | `array-push-spread.ts` (+ its compiler-boundaries entry), the JS-host dynamic-spread push, host `__array_flat`/`__array_flatMap`/`__host_eq`/`__same_value_zero` arms, `hofRefElemClosureLaneSafe`, `maybeEmitVecLengthDefine` |
| `13a218335a` | `string-*` / `native-string*` | 21 | — |
| `b507796916` | `closures*` + async | 26 | the host function-name sidecar write, the legacy `try`/`catch_all` rest-apply arm, the #6417 host boolean-callback widening (`hostBooleanCallbackResult`, `FunctionContext.hostBooleanReturn`) |
| `85087e2ce2` | `index.ts` + `registry/` + `declarations/` | 114 | the up-front `__register_*` host-import pre-registration, externref class method/getter/vararg dispatch exports, host eval-string collector facts, `moduleHasFnctorSubclass` |
| `983c75ec68` | `type-coercion` + `binary-ops*` + `dyn-ops` | 29 | the host `__array_from_iter` materializer arm |
| `f6a68cd857` | `src/ir` | 24 | the IR resolver's host arms (`__extern_eval`, `__defineProperty_desc`, host Date extern class, `__date_now`, host `__new_*`/`__extern_has`/`__unbox_number`) |

`addHostStringConstantGlobal` now always answers `undefined` (the regime never
imports a host string). Its callers' host arms are left for a later sub-slice.

**Folds dropped.** None of the merged-tree folds had to be dropped for byte
identity. One codemod rewrite was reverted by hand because it was not a fold:
`X || false` → `X` on a pre-existing (non-`ctx.standalone`) expression in
`funcref-as-closure.ts`, which would change a `boolean` result to
`boolean | undefined`. A fold of the remaining top-level `src/codegen` files
(676 hits in 281 files) was started and backed out: the first half (140 files)
cascaded into whole dead modules (`class-instance-proto.ts`,
`class-object-of.ts`, `class-value-construct.ts`, `generator-eager-refusal.ts`,
the opaque generator dispatch tail) that tests and the boundaries inventory
still name. It is the next sub-slice, together with `classes/`, `helpers/`,
`context/`, `analysis/`, then removal of the field.

**Byte identity.** Corpus as in the checkpoint: 2,494 programs (equivalence
sources, playground examples, 1-in-40 test262 sample over 16 directories) on
gc, standalone and wasi, three fixed shards (7,482 hashes per scan).
- Every fold commit against its predecessor: 0 differences on all three lanes.
- Merge commit against the S7-b head: gc 0 and standalone 0 differences.
- WASI against the S7-b head (the flip, the one intended change): 1,658 of
  2,494 binaries change; 40 programs that failed now compile (the RegExp family
  and `wrapper-constructors` #3); 0 programs that compiled now fail (the
  checkpoint's `Promise.withResolvers` regression no longer reproduces: the S7-b
  head refuses it too). 0 programs gain a non-WASI import; 48 lose one
  (`env.__make_getter_callback` 40, `env.__dynamic_import` 8).

**Gates on the final head.** tsc 0, Biome lint 0, Prettier clean.
`check:standalone-arms` OK (1,069 → 711, banked).
`check:host-import-policy`: 33 probes, 452 imports, 0 regime-gap, 0 unknown;
accelerators regexp 4 / date 1 / intl 4 (same as S7-b). `check:ir-fallbacks` OK
(the informational `async-function` deferred bucket reads 4 against a 0
baseline; it is not gated). `check:ir-only --policy=hybrid` READY, single-host
26/12, standalone 38/0. The compiler-boundaries inventory is valid against
`upstream/main` `93052c9d35`, and `ci.yml` wires `check:standalone-arms` once.
The ratchet chain (loc, func, coercion-sites, oracle, dead-exports) and import
cycles are OK with `LOC_GATE_BASE` = `upstream/main` `93052c9d35`; no new
grants. Equivalence gate: 20 failing, 2,044 passing, 22 known failures, "No new
equivalence regressions", 2 baseline failures now pass (`delete-sentinel`,
`reflect-api`), the same as S7-b.

**Tests.** The 3 touched files (`issue-4035`, `issue-4396`,
`issue-6979-standalone-arms-ratchet`), the 15 `--pinned` files and 49 files
covering the deleted arms (`issue-1047`, `1989`, `2025`, `2161-matchall`,
`2891`, `3048`, `3984`, `4371`, `4397`/`4401`/`6978`/`6986`/`6686`,
`4616-closure-name-leak`, `4617`, `4618-host-class-ctor-bridge`, `5361`,
`6417`, `6715`, `6950`, `7011`, `7057`, every `7106-*`): 626 passing, 20
failing. All 20 fail identically on the S7-b head (run in a tree built from
`8a081af2c3`): `issue-1047` ×1, `1989` ×2, `2025` ×2, `4035` "honours an
explicit off" ×1, `4371` ×1, `4617` ×2, `4618-host-class-ctor-bridge` ×3,
`5361` ×2, `6417` ×3, `6715` ×1, `7106-prophelper` ×1, `7106-s3a` ×1. Most pin
a host lane that S7-b already removed (`standalone: false` contexts, the
host-assisted gc lane, host string constants). They belong to the S7-d test
re-pin, not to this slice. No test was re-pinned or skipped here.
