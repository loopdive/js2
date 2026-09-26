---
id: 5385
title: "Merge JS-host and standalone modes: one native semantic core, host semantics only as opt-in accelerators"
status: in-progress
assignee: ttraenkler/codex-5385
created: 2026-09-07
updated: 2026-09-26
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

| profile               | binary | imports | classification                                   |
| --------------------- | ------ | ------- | ------------------------------------------------ |
| `gc` (host, default)  | 6.7 KB | 30      | 26 legacy-semantic, 3 value-adapter, 1 lifecycle |
| `gc` + `native-first` | 112 KB | 19      | 19 value-adapter                                 |
| `standalone`          | 144 KB | 0       | —                                                |

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
  - `RegExp_*` arms, #682 host half), and by the same rule host Date/Intl,
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
  `RegExp_` (JSON*/Promise*/Map*/Set*/WeakMap*/WeakSet*/number*/bigint*/
  parse\*/URI/escape/string*/`\_\_array*`/`**js*array*`/`**async*iterator`/
`**bind_function`/`**call*`/`**concat\_`/`**construct`/`**create\_\*generator`/
`**defineProperty*`/`**delete_property`/`**extern*`/`**for*in*`/`**gen*`/
`**getOwnPropertyDescriptor`/`**getPrototypeOf`/`**host_set_struct_proto`/
`**is_truthy`/`**iterator`/`**new*`/`**object\_`/`**reflect\_`/`\_\_typeof`),
`extern_class` for ECMAScript builtins (`ECMASCRIPT_EXTERN_CLASSES`), the
`await`host driver,`host_eq/loose_eq/add/compare/bigint_binop`,
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

| Region                                                                                                                                                                                                                                                                                                                                                            |                                                                                            Retire (est.) | Keep                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------: | ---------------------------------------------------------------------------------------------------- |
| `resolveImport` legacy arms (7.2–7.8k lines)                                                                                                                                                                                                                                                                                                                      |                                                                                              **~5.5–6k** | `wasm:js-string` arms ~730, `RegExp_*` ~130, web-API `extern_class`, value-adapter ~200              |
| `runtime.ts` semantic helpers (`_safeSet` 381, `_hostToPrimitive` 266, `_toPrimitive` 239, `_safeGet` 223, `_instanceofResult` 222, `_vecDefineOwnProperty` 196, descriptor/JSON/proxy-bridge helpers)                                                                                                                                                            |                                                                                              **~3–3.5k** | `_wrapForHost` 503, `_wrapCallableForHost`, `_wrapVecForHost`, `wrapExports`, `buildImports` (~3.8k) |
| `src/runtime/` semantic modules: `iterator-polyfills.ts` 1,353, `class-method-host-bridge.ts` 305, `strict-iterator-host.ts` 266, `wasm-struct-host-semantics.ts` 231, `array-proto-sparse.ts` 192, `compatibility-semantic-adapter.ts` 121, `fixed-extern-method-call.ts` 62, `fnctor-instanceof.ts` 40, `date-host-method.ts` 34, `compatibility-adapter.ts` 21 |                                                                                                **~2.5k** | `legacy-regexp.ts` 209 (option), all boundary/capability adapters                                    |
| codegen host-only branches (`if (!ctx.standalone)` bodies + else-arms of `if (ctx.standalone)`)                                                                                                                                                                                                                                                                   |                                                                                              **~1–1.5k** | the native arm                                                                                       |
| codegen host-semantic helper files: `extern-get-inline-ic.ts` 404, `extern-eq-fast.ts` 225, `data-struct-host-bridge.ts` 197, `host-fnctor-method-driver.ts` 166, `host-string-prefix-suffix.ts` 127, `array-method-host.ts` 121, `extern-get-cache-arm.ts` 107                                                                                                   | **~1.3k** (+ up to ~1.8k partial from `closed-struct-extern-set.ts` 704 / `expressions/extern.ts` 1,153) | externref paths still needed for boundary / web-API objects                                          |
| scaffolding that only polices host imports: `host-import-allowlist.ts` 595, `legacy-body-audit.ts` 826, `ir-legacy-caller-abi.ts` 107                                                                                                                                                                                                                             |                                                                                                **~1.5k** | `scripts/check-host-import-policy.ts` (keeps ratcheting accelerators)                                |
| host-only tests (18 files matching host-import/legacy/extern)                                                                                                                                                                                                                                                                                                     |                                                                                                **~2–3k** | native-first / boundary tests                                                                        |

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
   - `RegExp_*` and the `wasm:js-string` / `string_constants` arms,
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

### Phase 1 implementation checkpoint — 2026-09-07

Taken over from merged specification PR #5725. Initial source baseline:
`79b0e7c4dc47949fb9708a9ca45d0e7e5bade2ae`. Measurements and complete
diagnostics: `plan/audit/5385-native-first-initial-evidence.json`.

- Added `TEST262_SEMANTIC_PROVIDERS=native-first` throughout worker,
  fixture, retry and in-process compilation. Cache keys, filenames and
  report metadata distinguish the provider; mixed-provider reports fail.
- Added an independent nightly / `native_first` dispatch lane using the
  **current 57 chunks**, superseding the spec's stale 66-shard count.
  Completeness-validated JSONL and JSON baselines are uploaded as separate
  artifacts. **A complete CI baseline has not yet been measured or committed.**
  Temporal is deliberately unlinked in this lane because its cached provider
  compiles with host semantics; those rows are excluded from the parity bar
  as specified in Phase 2. Native-first dispatch cannot promote host baselines.
- Added npm `--lane js-host-native`; default `both` now records `jsHostNative`
  alongside existing performance lanes. This selects the performance workload,
  not the independent upstream package correctness suite. Existing npm refresh
  CI collects the additional lane; its broader correctness census remains open.
- Sidebar runner accepts `--semantic-providers=native-first` and `--output`.
  `--kernels-only` (requiring an explicit output) removes the DOM entry point
  and helper module identically in both profiles. Values must match JS before
  timing; native results use the compiled adapter manifest in the child process.

Local exploratory timing (macOS arm64, Node 25.9.0, O4/TurboFan, nine rounds;
other development processes active) measured **4/4 isolated kernels** in each
profile. Host/native-first medians in microseconds: fib **3993.13/4112.36**,
loop **205.22/233.29**, string **0.163/2.919**, array **22.22/24.94**. These are
optimized fixed workloads with constant folding enabled, not application-wide
performance or evidence to flip the default. The full sidebar native-first
run fails on its first DOM-bearing program; its other three rows are unmeasured.

Initial gap list (individual reproductions, **not a ranked population census**):

1. Property-name constants: native-first rejects `string_constants` names
   `""`, `name`, `P`, `d`; identical source compiles in host mode (4,348 bytes)
   and standalone (138,086 bytes, zero imports). Owner **#4397**.
2. Sidebar DOM setup: native-first rejects `__extern_get`, `__js_array_new`,
   `__call_function`; also reports an `innerHTML` IR lowering diagnostic.
   Owner **#4397**, with capability routing under **#4398**.
3. Cookie native performance workload: implicit-any `parseCookie(str)`
   compile diagnostic while its host performance workload measures.
   Owner **#5385 Phase 2** to minimize and route to the existing compiler owner.
4. Redux native workload: string/array legacy imports (**#4397**) and
   unclassified builtin/process-environment imports (**#4401/#4398**).
   **0/2 selected native npm workloads measured**; failures remain explicit.

Validation: 31 npm tests; 3 new test262 tests; 14 existing Temporal tests;
8/8 real worker probes across both profiles. Host-import policy: **33/33 probes,
zero legacy/unknown imports**. Existing native-core tests: **49/51 pass** on
unchanged compiler source; URI native string conversion returns null and an
older standalone generator-import expectation fails. Both reproduce in a
focused rerun. They remain open; no full-green claim is made.

Reproduction commands (build `scripts/compiler-bundle.mjs` first; use a Node
version supporting the repository's Wasm flags):

```sh
TEST262_SEMANTIC_PROVIDERS=native-first pnpm run test:262
node --experimental-wasm-stringref --experimental-wasm-custom-descriptors --import tsx scripts/generate-npm-compat-report.mjs --only cookie --perf-only --lane both --partial-output .tmp/npm-cookie-all.json
node --experimental-wasm-stringref --experimental-wasm-custom-descriptors scripts/generate-playground-benchmark-sidebar.mjs --kernels-only --output=.tmp/sidebar-host-kernels.json
node --experimental-wasm-stringref --experimental-wasm-custom-descriptors scripts/generate-playground-benchmark-sidebar.mjs --semantic-providers=native-first --kernels-only --output=.tmp/sidebar-native-kernels.json
```

Next: run the complete native-first CI lane, commit its measured baseline,
join fresh host/native-first rows by `file|strict`, rank real gaps and route
them to existing family owners. Phases 2–4 remain unstarted; all acceptance
checkboxes below stay open until their full evidence exists.

### 2026-09-24 checkpoint — the regime lever (fable, merged upstream/main @ 9b1ba0d19f)

**Measured:** the nightly native-first CI lane (run 35833863334, artifact
`test262-native-first-baseline-…`) reports **4,411 pass / 43,800 compile
errors** of 48,232 — 91 % of rows never compile. The top rejected imports are
all in the assembled harness (`structuredClone`, `__new_Test262Error_ctor`,
`__js_array_new/push`, `__proto_method_call`, `__instanceof_check`,
`__call_function`): those codegen sites are gated on `ctx.standalone`, not on
the semantic-provider policy, so a native-first JS build still takes the host
path and the publication gate then rejects it. Standalone passes 34,978 of the
same rows host-free — **the standalone codegen regime IS the native semantic
core; `native-first` only re-routes ~15 families on top of the host regime.**

**Experiment (local, 321-row sample: `built-ins/Object/keys`,
`built-ins/Array/prototype/map`, `language/expressions/class/accessor`):**

| lane | pass / 321 |
| --- | ---: |
| host baseline | 228 |
| standalone baseline | 253 |
| native-first, as on main | 0 (harness rejected) |
| native-first + `ctx.standalone` regime, eval provider unlinked | 0 (318 × unresolved `js2wasm:runtime-eval` import) |
| native-first + regime + eval provider linked | **218** |

Of the 103 residual sample failures: 41 fail in all three lanes (shared
gaps), 33 pass in BOTH host and standalone but fail here (regime-in-JS-env
defects: `__extern_set` illegal cast in `__set_member_nonstrict_length`,
callback `this` binding, `__call_1_f64` leak), 10 host-only, 10
standalone-only, 4 V8 SIGABRT.

**Cost of the blunt flip:** setting `ctx.standalone` for native-first JS
builds breaks 10 of 16 boundary-interop tests in
`tests/issue-4397-native-semantic-js-host.test.ts` (console capability,
JS-owned object admission, callbacks, error translation, `__str_*` marshal,
DataView/bind admission) and OOMs V8 in one. Those are the environment-shaped
`ctx.standalone` arms; they must read `targetProfile.environment` /
`hostValueInterop` instead. That enumerated list is the next slice.

**Landed in this checkpoint (PR from `issue-5385-merge-host-semantics-native-core`):**

- `CompileTargetProfile.nativeRegime` — the explicit "which ECMAScript
  implementation lowers this" axis; `ctx.standalone` now reads it. The JS
  arm is opt-in via `JS2WASM_NATIVE_REGIME_JS=1` until the boundary gates
  are re-keyed, so default output is byte-identical.
- `projectIrBackendTargetProfile` projects a native-regime JS build as the
  standalone regime with `allowHostImports: false` (pinned in
  `tests/issue-4396-target-profile.test.ts`).
- The native-first test262 lane links the `js2wasm:runtime-eval` provider
  like standalone (`scripts/test262-import-object.mjs`, worker, in-process
  lane, `run-test262-vitest.sh`), and the CI lane builds the refusal
  interpreter tier in-job and sets the regime opt-in, so the next nightly
  measures the regime on the full corpus.
- Side effect: the `string_constants` property-name leak (gap item 1) is
  gone under the regime — every class-shape probe compiles with zero imports.

Two pre-existing failures on main are unchanged (`#4401 preserves
target-derived standalone compatibility fallbacks`, `#4397 parse/URI string
globals`), as codex-5385 recorded on 2026-09-07.

**Next slice (Phase 2, concrete):** re-key the 10 boundary arms above, then
turn `JS2WASM_NATIVE_REGIME_JS` on by default for `semanticProviders:
"native-first"`, then re-run the census on the full nightly lane.

### Implementation Plan v2 (Fable, 2026-09-26) — merge the host lane INTO the native regime, then retire it

> Supersedes the Phase 1–4 ordering above for the *codegen* half. Phase 1 is
> done; this is the careful, slice-by-slice path from "regime measured behind
> an opt-in" to "one path". Every slice is one PR, byte-identical for the
> default `gc` build until slice S5, and each carries its own regression
> guard. Opus implements from this spec; measurements below are the
> before-state to compare against.

#### Where the numbers stand (nightly run 36228065594, main @ `ddbbea229c`, 48,735 rows incl. proposals)

| lane                                                  |   pass |
| ----------------------------------------------------- | -----: |
| host (`gc`, host-assisted)                            | 34,099 |
| standalone (host-free)                                | 35,237 |
| **native regime in JS env** (`JS2WASM_NATIVE_REGIME_JS=1`, refusal eval tier, no Temporal link) | **31,840** |

Lane agreement (regime, host, standalone) → rows: all three pass 27,399 ·
none 9,627 · host+standalone pass but regime fails **3,426** · regime+standalone
pass, host fails 3,253 · host only 2,683 · standalone only 1,159 · regime only
597 · regime+host 591. The regime already passes **3,844 rows the host lane
does not**; the 6,109 rows the host passes and the regime does not decompose
as:

| rows | signature                                                                    | root cause class                        | slice |
| ---: | ---------------------------------------------------------------------------- | --------------------------------------- | ----- |
| 2,121 | `async completion marker not observed`                                      | console/print sink is environment-shaped | S1    |
|  473 | `dynamic code evaluation is not supported … refusal`                         | measurement lane links the refusal tier | S4    |
|  507 | native-first policy rejected `__gen_*`/`__create_async_generator`/`SharedArrayBuffer_new`/`Promise_allSettled`… | standalone gaps (#3178 carriers, SAB deferred) | #3178 |
|  ~600 | invalid Wasm `C_method`/`C___priv_method` "not enough arguments" / stack-balance (all `language/statements/class/dstr/async-gen-meth-*`) | regime-in-JS codegen defect (class async-gen method ABI vs hostBridge trampolines) | S3-a  |
|  192 | `m should be an own property`                                                | #3468 function-object own-property residual | #3468 |
|  ~243 | `Array.prototype.reduce/reduceRight/values is not yet callable as a value in --target standalone` | standalone refusal; host lane satisfies via `__array_proto_method` | S3-b  |
|   73 | `illegal cast [in __extern_set_decide() ← __set_member_nonstrict_length]` (`reduce/reduceRight/15.4.4.2x-*`) | regime-in-JS defect: dynamic `length` write picks extern path | S3-c  |
|  116 | `called value is not a function`                                             | mixed; triage in S3                     | S3    |
|  rest | Temporal (`until`/`since`, 1,507 total incl. shared) — lane does not link the provider | S4 |

**Reading:** the regime is ~2.3k rows behind host today and ~2.1k of that is
one runner/console gate. After S1+S4 the regime is expected to sit at or above
the host lane; S3 is the genuine parity work; S5–S7 are the flip and the
retirement.

#### Design rule for every slice (how "not break anything" is enforced)

Three predicates, no new compound checks (the #4396 rule):

- `ctx.standalone` ≡ `targetProfile.nativeRegime` — *which ECMAScript
  implementation lowers this*. Already wired (PR #6083).
- `hostFreeEnvironment(ctx)` ≡ `targetProfile.environment !== "javascript"`
  — *is there a JS embedder*. NEW helper in `src/codegen/context/types.ts`
  (next to the other ctx predicates). Only environment-shaped arms move to it.
- `jsValueBoundary(ctx)` ≡ `targetProfile.hostValueInterop !== "off"` — *does
  the module keep the JS value bridge* (wrappers, `__str_*`, boundary MOP,
  callbacks, error translation). NEW helper, same file. The pattern already
  exists at `src/codegen/object-runtime.ts` (`boundaryObjectInterop` ≈ L937)
  and `src/codegen/export-throw-boundary.ts:76`; generalize it, do not copy it.

Per-slice guard, run before every commit and asserted in CI:

1. `tests/issue-4396-target-profile.test.ts` "preserves legacy default
   projections byte-for-byte" — default `gc`, `standalone`, `wasi` binaries
   unchanged (the regime only changes output when the opt-in is set).
2. `JS2WASM_NATIVE_REGIME_JS=1 npx vitest run tests/issue-4397-native-semantic-js-host.test.ts tests/issue-4399*.test.ts tests/issue-4401-host-import-policy.test.ts` — the boundary/interop contract; the two pre-existing failures (URI globals; standalone generator fallback) stay the only red until their owners land.
3. `JS2WASM_NATIVE_REGIME_JS=1 pnpm run check:host-import-policy` — zero legacy/unknown imports in the 33 probes (S2 adds the env var to the script itself).
4. The 321-row sample (`TEST262_PATH_FILTER="built-ins/Object/keys/|built-ins/Array/prototype/map/|language/expressions/class/accessor"`, `JS2WASM_EVAL_ENGINE=interpreter TEST262_SEMANTIC_PROVIDERS=native-first`) — before-state **218 / 321**; a slice may not lower it. Record the number in the PR.
5. `merge_group`: standalone high-water floor + host regression diff are unchanged by construction (byte identity); the nightly native-first lane number is recorded in this issue after each slice lands.

#### S1 — console/print is a capability in a JS environment (fixes 4397 "selects native strings…" + ~2.1k async rows)

Under the regime a JS-environment build currently mints the host-free
`__stdout_acc` sink (#3469) and the runner only drains it for
`target === "standalone"` (`scripts/test262-worker.mjs:2473`), so `$DONE` never
reaches `harnessOutput`. In a JS environment `console.*` must lower to the
`console_log_*` platform-capability import (already `platform-capability`
class in `src/host-import-policy.ts`) and the `__stdout_*` inspection exports
must not be minted.

- `src/codegen/declarations/import-collector.ts` ≈ L1565 (sets
  `ctx.usesStandaloneConsoleSink`): gate on `hostFreeEnvironment(ctx)` instead of
  `ctx.standalone || ctx.wasi`.
- `src/codegen/index.ts` ≈ L5636 (mint sink), ≈ L6267 / ≈ L11699 (emit
  `__stdout_prepare`/`__stdout_char`): same predicate.
- `src/codegen/standalone-console-object.ts` (`console` as a VALUE, #6671):
  keep for `hostFreeEnvironment`; in a JS environment the bare `console` value
  routes to the declared-global capability (`declared_global` intent), which
  is how the host lane already handles it.
- `scripts/test262-worker.mjs:2473` and the in-process twin in
  `tests/test262-shared.ts` (≈ L1050): drain `__stdout_*` when the exports
  carry it (`typeof exp.__stdout_prepare === "function"`), not by target name;
  after the codegen change a JS-env regime module carries none, so the host
  console proxy path is taken.
- Acceptance: 4397 console test green; sample ≥ 218; nightly async rows
  drop from 3,399 toward the standalone lane's count (standalone passes these
  via the drain).

#### S2 — the JS value boundary under the regime (fixes the other 9 4397 tests)

Assertions and their gate sites (each is a `!ctx.standalone`/`ctx.wasi ||
ctx.standalone` arm that must read `jsValueBoundary(ctx)` instead):

| 4397 test                                        | observed under regime                       | gate to re-key                                                                                              |
| ------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Wasm-owned objects live & identity-stable; native JSON provider | `type incompatibility when transforming from/to JS` | string params/results cross raw as i16-array refs: `src/codegen/closure-exports.ts` ≈ L773 / L1319 / L1516 (export wrapper string marshal), `src/codegen/native-strings.ts` ≈ L1711 (`__str_from_mem`/`__str_to_mem` bridge) |
| matches host-assisted string values              | `expected {} to be 'ALPHA'`                 | same string-marshal sites (result side)                                                                    |
| object-rest with JS-owned source (`any`)         | `illegal cast`                              | `any`-receiver reads cast externref→`$Object` instead of consulting the admitted-object MOP: `src/codegen/property-access.ts` / `property-access-dispatch.ts` `any` arms gated `ctx.standalone`; the MOP itself is already gated correctly (`object-runtime.ts` ≈ L937) |
| DataView admitted view; scopes admitted objects  | `expected null to be 9`; `expected undefined to be 42` | same admitted-object read path (`__boundary_object_get`)                                                    |
| compiled bind / JS function at the boundary      | `[object Object] is not a function`         | `src/codegen/expressions/calls.ts` ≈ L4711–L4960 (`allowHostBoundaryFallback` arms gated `!ctx.standalone && !ctx.wasi`) → `jsValueBoundary`; `planHostCallFallback(arity, nativeBoundary)` in `host-call-fallback.ts` already selects `__boundary_callback_call_N` |
| translates Wasm-owned errors at the boundary     | `expected Error to be an instance of TypeError` | error-kind translation when a native error struct crosses out: `src/runtime.ts` `_wrapForHost` error arm consults the native `$Error` kind tag only when… (find via `__exn_render_*` consumers); codegen side `src/codegen/js-errors.ts` `noJsHost()` consumers that skip minting the kind tag under `ctx.standalone` |
| struct-field exports with Symbol fields          | (guard)                                     | `src/codegen/struct-field-exports.ts` L219 / L482 / L572 / L783 — `ctx.standalone || ctx.wasi` there means "no host Symbol"; under the regime with a JS bridge use the boundary Symbol map (#4397 Symbol slice) |

Method: take the tests one at a time in the order of the table; for each,
write the failing expectation as the acceptance line, find the arm with the
grep `grep -rn "ctx\.standalone" src/codegen | grep -iE "boundary|export|marshal|str_|callback|wrapForHost"`,
re-key, re-run guard 2. Do NOT widen `hostValueInterop` semantics; do not
touch arms whose question is "which provider" (those stay on
`ctx.standalone`). Also add `JS2WASM_NATIVE_REGIME_JS=1` to
`scripts/check-host-import-policy.ts` so the ratchet measures the regime, and
raise `plan/audit/host-import-policy-baseline.json` maxima only with a
measured reason.

- Acceptance: 4397 15/16 (URI pre-existing), 4399 suites green, ratchet
  zero legacy/unknown under the regime, sample ≥ 218, `wrapCompiledExports`
  live-view/copy/opaque policies unchanged.

#### S3 — regime-in-JS codegen defects (parity work with named repros)

- **S3-a** class async-generator methods emit invalid Wasm (`C_method` /
  `C___priv_method`, "not enough arguments" / stack-balance, ~600 rows). Repro:
  `test/language/statements/class/dstr/async-gen-meth-static-dflt-ary-ptrn-rest-ary-elem.js`
  under the regime. Hypothesis to verify first: the hostBridge
  `__call_fn_method_*` trampolines (JS-env only) are minted against the host
  method ABI while the body is lowered with the native async-generator
  carrier; standalone never mints the trampolines so never hits it. Fix at
  the trampoline emitter (`src/codegen/init-class-dispatch-helpers.ts` /
  `class-method-host-bridge` consumers), not in the carrier.
- **S3-b** `Array.prototype.reduce/reduceRight/values … not yet callable as a
  value` (~243): the standalone refusal; add the native method-as-value
  carrier (same shape as #3170's indexOf/includes work) — this also lifts the
  standalone lane.
- **S3-c** `__set_member_nonstrict_length` → `__extern_set` illegal cast (73):
  the dynamic `length` write on a non-array object picks the extern arm; the
  arm at `src/codegen/member-set-dispatch.ts` ≈ L162/L263 is `ctx.standalone`
  gated but the *receiver classification* upstream is not — repro
  `test/built-ins/Array/prototype/reduceRight/15.4.4.22-5-6.js`.
- **S3-d** `called value is not a function` (116) and `Expected a TypeError
  … no exception` (130): triage from the nightly JSONL after S1/S2 land;
  file child issues with `parent: 5385` only if they are regime-specific
  (fail here, pass in both other lanes).

Each S3 item: byte-identical default gc, standalone floor unchanged, the
named repro flips, sample non-decreasing.

#### S4 — measurement lane parity with the standalone lane

`.github/workflows/test262-sharded.yml` `test262-native-first` job: (a) link
the selected eval provider like the standalone shard (download step +
`Verify shared runtime-eval provider cache`, ≈ L1672–L1690) — requires the
`runtime-eval-provider` job (≈ L665) to run on `schedule`; add the arm the
`temporal-provider` job already has (≈ L789); (b) link the Temporal provider
for the regime (`prewarm-temporal-provider.mjs --target host` produces a
host-semantics binary — the regime needs one built with
`semanticProviders: "native-first"`; extend `scripts/test262-temporal.mjs`
`temporalProviderCompileOptions`). Expected: −473 eval rows, −1,507 Temporal
rows. Only after this does the lane number become comparable to host.

#### S5 — turn the regime on by default for `semanticProviders: "native-first"`

Remove the `JS2WASM_NATIVE_REGIME_JS` condition from
`resolveCompileTargetProfile` (`src/target-profile.ts`); keep the env var as a
kill switch that *disables* it for one release. Default `gc` output stays
byte-identical (host-assisted is still the default policy). Gate: S1–S3
acceptance green without the env var, the nightly lane number ≥ host lane
minus the deferred set (Temporal/SAB/eval-code), npm-compat js-host-native lane
no `measured → error` regressions.

#### S6 — flip the default policy (Phase 3 above, unchanged)

`semanticProviders` default → `native-first` in every environment; per-family
opt-ins for `wasm:js-string`, host RegExp/Date/Intl as `host-accelerator`;
whole-profile `"host-assisted"` rollback alias with a deprecation warning for
one release; host test262 lane becomes the regime lane; README/CLAUDE.md
wording. Evidence bar: S5 numbers held for two consecutive nightlies; the
edition ratchet (`scripts/test262-edition-ratchet.ts`) shows no edition below
its floor on the regime lane.

#### S7 — retire the host implementation (Phase 4 above, unchanged)

Delete `compatibility-*-adapter.ts`, the legacy `resolveImport` arms, the
semantic helper modules and the host-only codegen helper files listed in the
size table; `legacy-semantic` becomes a compile error in every profile;
collapse `ctx.standalone` arms to unconditional native where the question was
"which provider" (by then every remaining `ctx.standalone` site *is* a
provider question, because S1/S2 moved the environment/boundary ones).
`ctx.standalone` is then renamed `ctx.nativeRegime` and finally removed.

#### Out of scope for this plan

- Making host-assisted output faster or smaller; the small-binary property is
  #2514's shared-runtime packaging.
- Any change to the standalone/WASI targets' semantics.

### Program acceptance

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
