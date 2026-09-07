---
id: 5385
title: "Merge JS-host and standalone modes: one native semantic core, host semantics only as opt-in accelerators"
status: ready
created: 2026-09-07
updated: 2026-09-07
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: epic
area: runtime, host-interop, compiler, codegen
language_feature: compiler-internals
goal: architecture
sprint: current
parent: 4395
depends_on: [4397, 4399, 4401]
model: fable
fable_role: spec
related: [679, 682, 1535, 2514, 2860, 3178, 4035, 4396, 4398, 4402, 4576, 4577]
---

# #5385 — Merge JS-host and standalone modes into one native semantic core

## Stakeholder question (2026-09-05)

> Merge standalone and JS host mode; only keep what has value. Is the main
> reason for JS host mode (despite its poor performance) that it helps JS host
> interop? Does it really, and how?

## Finding: host mode does NOT earn its keep through interop

"JS host mode" (`target: "gc"`, the default) conflates two unrelated things:

1. **The JS value adapter** — `_wrapForHost`/`_unwrapForHost`, the `__vec_*` /
   `__sget_*` / `__call_fn*` hostBridge exports, callback wrapping, exception
   translation, instance wiring. This _is_ the interop. #4396 already put it
   on its own policy axis (`hostValueInterop` in `src/target-profile.ts`),
   independent of semantics.
2. **Borrowed V8 semantics** — the `legacy-semantic` `env` imports (`JSON_*`,
   `Promise_*`, `Map_*`/`Set_*`, `__object_*`, `__extern_get/set`, `__gen_*`,
   `__iterator*`, `number_*`, `bigint_*`, host Date, `host_*` dynamic operators,
   `wasm:js-string`, host RegExp). This is a **second ECMAScript
   implementation**, not interop.

The only interop benefit of (2) was incidental: a caller-owned JS object
passed as `any` stayed a JS object for free, because every dynamic value was
already an externref. #4399 replaced that with the explicit per-instance
boundary-object MOP (`src/runtime/boundary-object-adapter.ts`,
`__boundary_object_get/set/has/delete/keys/call`), so the benefit no longer
requires host semantics.

Proof that the two are separable — `semanticProviders: "native-first"` in a
JS environment (#4397) keeps arrays, objects, closures, callbacks, Promises and
exceptions live and identity-stable while emitting **zero** `legacy-semantic`
imports; `check:host-import-policy` ratchets 33 probe families at zero
(`plan/audit/host-import-policy-baseline.json`). One probe program (`any`
param + `Object.keys`, class with getter, `Map`, RegExp `.test`, `JSON.stringify`,
`Date`, `async/await`), measured on the fork checkout 2026-09-05:

| profile                    | binary | imports | classification                          |
| -------------------------- | ------ | ------- | --------------------------------------- |
| `gc` (host, default)       | 6.7 KB | 30      | 26 legacy-semantic, 3 value-adapter, 1 lifecycle |
| `gc` + `native-first`      | 112 KB | 19      | 19 value-adapter                        |
| `standalone`               | 144 KB | 0       | —                                       |

Re-run on `upstream/main` @ `10312a066b` (2026-09-07): `standalone` still
compiles host-free (188 KB); **`native-first` now REJECTS the same program**
with `string_constants::name / P / d (legacy-semantic, owner #4397)` — the
property-name constant pool leaks under native-first for `Object.keys` on an
`any` receiver plus class-member names. That is a real native-first gap and the
first item on this issue's census (Phase 1.4).

So the merged mode already exists: it is `native-first`. What is missing is
(a) the evidence to flip it to default, (b) closing its residual gap to the
host lane, and (c) deleting the host implementation.

## What has value (KEEP) — stakeholder constraints 2026-09-07

- **JS value adapter** (#4399): `src/runtime/boundary-*-adapter.ts`,
  `instance-lifecycle-adapter.ts`, `_wrapForHost`/`_unwrapForHost`,
  `wrapCompiledExports`, `buildCompiledAdapterImports`, hostBridge exports.
- **Platform capabilities / Web API integration** (#4398, #4576, #4577):
  console, timers, clock, randomness, DOM, node:\*, Web Storage, dynamic
  import, JSX, declared globals, `extern_class` for **non-ECMAScript** classes.
  `src/runtime/platform-capability-adapter.ts`, `src/capability-registry.ts`.
  Untouched.
- **`wasm:js-string` strings as an opt-in provider.** Zero-copy host strings at
  the JS boundary have value for JS callers. Becomes a per-family override
  (e.g. `semanticProviders: { strings: "js-string" }`); the default is native
  i16 strings. The `string_constants` pool goes with the option.
- **JS builtin accelerators as opt-in**: host RegExp (`src/runtime/legacy-regexp.ts`
  + `RegExp_*` arms, #682 host half), and by the same rule host Date/Intl,
  isolated eval (`__extern_eval`/`__extern_direct_eval`), `__date_parse_host`.
  All re-registered under the `host-accelerator` class in
  `src/host-import-policy.ts` with the native provider as fallback. Never
  implicit.
- **Small binaries** (6.7 KB vs 112 KB above) — the one genuine advantage of
  borrowing V8. Answered by shared-runtime linking (#2514), not by host
  semantics. Follow-on, not a blocker.

## What to retire (no value once the core is native)

The implicit ECMAScript semantic fallbacks only:

- `LEGACY_SEMANTIC_BUILTIN_PREFIXES` in `src/host-import-policy.ts` **minus**
  `RegExp_` (JSON_/Promise_/Map_/Set_/WeakMap_/WeakSet_/number_/bigint_/
  parse\*/URI/escape/string_/`__array_`/`__js_array_`/`__async_iterator`/
  `__bind_function`/`__call_`/`__concat_`/`__construct`/`__create_*generator`/
  `__defineProperty_`/`__delete_property`/`__extern_`/`__for_in_`/`__gen_`/
  `__getOwnPropertyDescriptor`/`__getPrototypeOf`/`__host_set_struct_proto`/
  `__is_truthy`/`__iterator`/`__new_`/`__object_`/`__reflect_`/`__typeof`),
  `extern_class` for ECMAScript builtins (`ECMASCRIPT_EXTERN_CLASSES`), the
  `await` host driver, `host_eq/loose_eq/add/compare/bigint_binop`,
  `same_value_zero`, `proxy_create`, `typeof_check`, `any_to_index`,
  `truthy_check`.
- `src/runtime/compatibility-adapter.ts`,
  `src/runtime/compatibility-semantic-adapter.ts`, the legacy arms of
  `resolveImport` in `src/runtime.ts` (ceiling today: 7,775 lines / 15 cases),
  and the semantic helper modules listed in the size table.
- Dual codegen paths gated on `ctx.standalone` (**1,213** sites on upstream),
  `ctx.wasi` (**698**), `ctx.nativeStrings` (**463**) that choose native-vs-host
  _semantics_. Gates that choose _environment_ behavior (`_start` vs
  export-driven init, hostBridge exports, WASI `fd_*` providers, console
  capability) stay, re-expressed on `ctx.targetProfile.environment`.

## How much code goes (measured 2026-09-05/07, heuristic — verify per PR)

Upstream `src/` is 778k lines; `src/runtime.ts` 19,725 (at its ratchet
ceiling); `src/runtime/` 6,969.

| Region                                                                   | Retire (est.) | Keep                                                                                   |
| ------------------------------------------------------------------------ | ------------: | -------------------------------------------------------------------------------------- |
| `resolveImport` legacy arms (7.2–7.8k lines)                             |   **~5.5–6k** | `wasm:js-string` arms ~730, `RegExp_*` ~130, web-API `extern_class`, value-adapter ~200 |
| `runtime.ts` semantic helpers (`_safeSet` 381, `_hostToPrimitive` 266, `_toPrimitive` 239, `_safeGet` 223, `_instanceofResult` 222, `_vecDefineOwnProperty` 196, descriptor/JSON/proxy-bridge helpers) | **~3–3.5k** | `_wrapForHost` 503, `_wrapCallableForHost`, `_wrapVecForHost`, `wrapExports`, `buildImports` (~3.8k) |
| `src/runtime/` semantic modules: `iterator-polyfills.ts` 1,353, `class-method-host-bridge.ts` 305, `strict-iterator-host.ts` 266, `wasm-struct-host-semantics.ts` 231, `array-proto-sparse.ts` 192, `compatibility-semantic-adapter.ts` 121, `fixed-extern-method-call.ts` 62, `fnctor-instanceof.ts` 40, `date-host-method.ts` 34, `compatibility-adapter.ts` 21 | **~2.5k** | `legacy-regexp.ts` 209 (option), all boundary/capability adapters |
| codegen host-only branches (`if (!ctx.standalone)` bodies + else-arms of `if (ctx.standalone)`) | **~1–1.5k** | the native arm |
| codegen host-semantic helper files: `extern-get-inline-ic.ts` 404, `extern-eq-fast.ts` 225, `data-struct-host-bridge.ts` 197, `host-fnctor-method-driver.ts` 166, `host-string-prefix-suffix.ts` 127, `array-method-host.ts` 121, `extern-get-cache-arm.ts` 107 | **~1.3k** (+ up to ~1.8k partial from `closed-struct-extern-set.ts` 704 / `expressions/extern.ts` 1,153) | externref paths still needed for boundary / web-API objects |
| scaffolding that only polices host imports: `host-import-allowlist.ts` 595, `legacy-body-audit.ts` 826, `ir-legacy-caller-abi.ts` 107 | **~1.5k** | `scripts/check-host-import-policy.ts` (keeps ratcheting accelerators) |
| host-only tests (18 files matching host-import/legacy/extern)            |     **~2–3k** | native-first / boundary tests                                                          |

**Total: roughly 17–20k lines deleted (~2.5% of `src/`), ~10k of it from
`runtime.ts` (19.7k → ~9k), plus ~2,400 mode conditionals collapsing to one
path.** The line count is modest. The payoff is one ECMAScript implementation
to conform, one path to test, and the end of the "fixed in host, still broken
in standalone" class of issues — #2860's child list alone is ~250 of those.

Method notes (so the numbers can be re-derived): `resolveImport` regions were
segmented by handler key and classified with the same prefix lists
`src/host-import-policy.ts` uses; helpers by function-name heuristics; codegen
branches by two brace/indent parsers that agreed within 25%. Ternary host arms
are uncounted. No committed artifact compares host-mode vs native-first
runtime **performance** — the "poor performance" premise is measured in
Phase 1, not assumed.

## Implementation Plan (Fable spec — Opus implements phase by phase)

Each phase is one or more independently mergeable PRs, each gated on both
test262 lanes in `merge_group` + `check:host-import-policy`. Do not fork the
#4395 program: #4397/#4399/#4401 stay the owners of family migration, the
adapter, and the ratchets; this issue owns the **lane evidence, the default
flip, and the deletion**.

### Phase 1 — Measure native-first where it counts (evidence for the flip)

1. **test262 native-first lane.** `tests/test262-shared.ts` reads
   `TEST262_TARGET`; add `TEST262_SEMANTIC_PROVIDERS=native-first` → pass
   `semanticProviders` into the worker's compile options, fold it into
   `getCachePaths` and into `RESULT_PREFIX` in `scripts/run-test262-vitest.sh`
   (`test262-native-first-…`). `workflow_dispatch` + nightly matrix entry in
   `.github/workflows/test262-sharded.yml` (66-shard host matrix, lane label
   `native-first`); baseline file
   `benchmarks/results/test262-native-first-current.json`.
2. **npm-compat native-first lane.** `scripts/generate-npm-compat-report.mjs`
   `--lane` gains `js-host-native` (js-host placement +
   `semanticProviders: "native-first"`), and its perf lanes report `jsHost`
   vs `jsHostNative` vs `standalone` side by side (acorn, cookie, react, hono,
   redux, clsx, lit are the packages that run today).
3. **Perf.** Run the `benchmarks/` sidebar suite (fib/loop/string/array) and
   `npm-compat-perf` under both profiles; commit the comparison here.
4. **Gap census.** Diff native-first vs host baseline by `file|strict` (the
   #2860 census shape). Bucket by leaked family / error category; every
   bucket gets an owner among #2860/#3178/#4402 children or a new slice.
   First known item: the `string_constants` property-name leak above.

Exit: numbers in this issue; a ranked gap list.

### Phase 2 — Close the native-first gap to host parity

Work the census in yield order. Known open families from #4397: Promise
subclass conformance, Proxy MOP invariants (#4402), `__dynamic_import`
(route via #1046), remaining ECMAScript `extern_class` arms. Deferred and
excluded from the parity bar: Intl, Temporal, SharedArrayBuffer, eval-code
rows already deferred. Rule from #4401: each retirement proves value/error
parity **and** JS-boundary parity with a focused differential test in the
`tests/issue-4397-native-semantic-js-host.test.ts` style.

Exit: native-first official pass ≥ host official pass minus the deferred set;
zero regressions on the standalone high-water floor.

### Phase 3 — Flip the default

- `resolveCompileTargetProfile` in `src/target-profile.ts`: `semanticProviders`
  default becomes `native-first` for every backend; `capabilityPolicy` for
  `gc` becomes `explicit-only`; `hostValueInterop` unchanged (`required` in a
  JS environment).
- Per-family opt-ins land here: `semanticProviders` accepts an object
  (`{ strings: "js-string", regexp: "host", date: "host" }`); `src/cli.ts`
  `--semantic-providers` mirrors it.
- Keep whole-profile `"host-assisted"` (rename of `"auto"`) as a one-release
  rollback alias with a deprecation warning — #4401's "explicit rollback
  switch".
- The native-first lane becomes the host lane (`test262-current.json`); retire
  the separate lane. Standalone lane unchanged.
- README conformance lines: "JS-host" → "JS environment (same semantics, plus
  value adapter)".

### Phase 4 — Delete the host-semantic implementation

1. **Runtime**: remove `compatibility-adapter.ts`,
   `compatibility-semantic-adapter.ts`, the legacy `resolveImport` arms, and
   the semantic helper modules in the size table. **Keep** `legacy-regexp.ts`
   + `RegExp_*` and the `wasm:js-string` / `string_constants` arms,
   re-registered as `host-accelerator` behind the per-family opt-in; their
   emission sites (`src/ir/lower.ts`, `src/ir/integration.ts`,
   `src/codegen/index.ts`, `src/codegen/native-strings.ts`) key off that
   opt-in instead of `!ctx.nativeStrings`. `src/host-import-policy.ts`:
   `legacy-semantic` becomes a hard compile error in **every** profile
   (today only under native-first); `LEGACY_SEMANTIC_BUILTIN_PREFIXES` →
   empty → delete the class.
2. **Codegen collapse**: for each `ctx.standalone || ctx.wasi || …` site decide
   _semantics_ (drop the host branch, keep native unconditionally) vs
   _environment_ (rewrite to `ctx.targetProfile.environment !== "javascript"`).
   File by file in gate-count order (`src/codegen/index.ts`,
   `expressions/calls.ts`, `expressions/call-receiver-method.ts`,
   `object-ops.ts`, `object-runtime.ts`, `closed-method-dispatch.ts`,
   `expressions/call-builtin-static.ts`, `declarations/import-collector.ts`,
   `property-access.ts`, `ir/integration.ts`, …), each PR byte-identical for
   standalone output (equivalence gate) and green on the host lane.
3. **Ratchets**: `plan/audit/host-import-policy-baseline.json` compatibility
   window removed with the control; `runtime.ts` / `resolveImport` ceilings
   ratchet down per PR; `check-standalone-highwater.mjs` floor unchanged.
4. **Docs**: `CLAUDE.md` "Dual-mode" principle → "one native semantic core;
   new features need no host import; JS gets a value adapter + explicit
   capabilities + named accelerators". `docs/architecture/codegen-axes.md`,
   `docs/cli.md`, the per-cell mode matrix in
   `docs/architecture/marshaling-contract.md` → single column.

### Phase 5 — Follow-on (not blocking)

- #2514 shared semantic-core module to recover host mode's small-binary
  property.
- Retire `hostBridge: "auto"` special-casing once the only difference between
  `gc` and `standalone` is `environment`.

## Acceptance criteria

- [ ] A native-first test262 lane and npm-compat lane exist, run in CI on
      dispatch/nightly, and their baselines are committed (Phase 1).
- [ ] Host-vs-native-first runtime performance is measured and recorded here
      (Phase 1).
- [ ] Native-first official pass ≥ host official pass minus the explicitly
      deferred set; standalone floor unchanged (Phase 2).
- [ ] `semanticProviders` defaults to `native-first` in every environment;
      `wasm:js-string`, host RegExp/Date/Intl are per-family opt-ins; a
      whole-profile rollback alias exists for one release (Phase 3).
- [ ] `legacy-semantic` is a compile error in every profile;
      `compatibility-*-adapter.ts` and the legacy `resolveImport` arms are
      deleted; `runtime.ts` ≤ ~9k lines; `ctx.standalone`/`ctx.wasi`/
      `ctx.nativeStrings` gates remaining are environment- or opt-in-shaped
      only (Phase 4).
- [ ] No npm-compat package regresses from `measured` to error on the JS
      lane; the value-adapter identity/callability/multi-instance tests
      (`tests/issue-4399*`, `tests/issue-4397*`) stay green throughout.
- [ ] `CLAUDE.md`, `docs/cli.md`, `docs/architecture/codegen-axes.md` and
      `marshaling-contract.md` describe one semantic core, not two modes.

## Verification

- Phase 1: the native-first lane completes on the 66-shard matrix; baseline
  file committed; census artifact attached to this issue.
- Every PR: `pnpm run check:host-import-policy`, both test262 lanes in
  `merge_group` (host regression diff + standalone high-water floor),
  `npm test -- tests/issue-4396-target-profile.test.ts tests/issue-4397-native-semantic-js-host.test.ts tests/issue-4401-host-import-policy.test.ts`,
  the equivalence gate, `tests/issue-4399*`.
- Phase 4 acceptance: `grep -rc "legacy-semantic" src/` → 0; `resolveImport`
  has no ECMAScript-semantic arms; the gate counts above are re-measured and
  every remaining site names an environment or an opt-in accelerator.
