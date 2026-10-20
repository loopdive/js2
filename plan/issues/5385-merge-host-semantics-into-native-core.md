---
id: 5385
title: "Merge JS-host and standalone modes: one native semantic core, host semantics only as opt-in accelerators"
status: in-progress
assignee: ttraenkler/codex-5385
created: 2026-09-07
updated: 2026-10-20
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

### 2026-09-26 evening checkpoint — S1, S1b, S2, S3-a landed; two spec corrections

Merged to main today (all byte-identical for default `gc`/`standalone`/`wasi`;
the regime stays behind `JS2WASM_NATIVE_REGIME_JS=1`):

| PR    | slice | what it moved                                                                                                                                     |
| ----- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| #6147 | S1    | `hostFreeEnvironment(ctx)`; console lowers to the `console_log_*` capability in a JS env; runner drains `__stdout_*` by feature, not target name |
| #6156 | S1b   | Wasm-owned strings reach the host console (`hostStringBridgeUsable` keyed on environment; `src/runtime/console-host-marshal.ts`, injected converter); async-function sample 31 → 65 / 74 |
| #6153 | S2    | `jsValueBoundary(ctx)`; string marshal at exports, admitted-object reads, JS callbacks/bind, closure-export unwrap; boundary suite 12 → 29 / 30; policy ratchet measures the regime by default |
| #6152 | S3-a  | `__box_number` minted as a #1916 stable handle (the index went stale during async-resume compilation); ~600-row invalid-Wasm cluster validates |
| #6159 | #6697 | `tests/issue-3520-…` moved its host-free compiles to a child process; the 512 MB pinned-test fork no longer OOMs when closure files are touched |

**Spec corrections (keep these, they supersede the text above):**

- `jsValueBoundary(ctx)` is `hostValueInterop === "required"`, not `!== "off"`.
  The standalone test262 lane compiles with `hostBridge: "always"`, which is
  `"enabled"` without a JS embedder; `!== "off"` would have made that lane
  import `env::*` adapters.
- The standalone leak scan (`src/codegen/index.ts` ≈ L7100) keys on
  `targetProfile.target === "standalone"`, not `hostFreeEnvironment`, because
  non-strict WASI builds would otherwise start warning.
- S3-a's root cause was **not** a pre-shift read in `destructuring-params.ts`:
  the index was fresh at emit and went stale while `__async_resume_fmethod`
  compiled and three JS-env late imports landed with the method body out of
  reach of every shifter root. Fix was the stable-handle regime, not a re-read.
- The boundary suite has 30 tests, not 16; the one residual red
  (`assignmentRest`, `illegal cast`) fails identically under plain
  `--target standalone` — a native object-rest provider defect, not a
  boundary arm.

**Next:** S3-c (#6689, `__extern_set_decide` cast) is specced and claimed,
dispatch waits on box load; the first nightly after these merges re-baselines
the lane (expect the 2,121 async-marker rows and the ~600 `C_method` rows to
move); then S5 (regime on by default for `native-first`) is evaluated against
that number.

### 2026-09-27 — S5 evidence and flip: the regime lane now leads both lanes

Nightly 36305955119 (main @ `7443ab4826`, with S1/S1b/S2/S3-a/S3-c/#6697 in;
S4 #6186 not yet), 48,735 rows incl. proposals, `census.py` join by `file|strict`:

| lane                                                 |       pass |
| ---------------------------------------------------- | ---------: |
| host (`gc`, host-assisted)                           |     34,099 |
| standalone (host-free)                               |     35,237 |
| **native regime in JS env**                          | **35,384** |

Official-scope summary (48,232 rows): regime 35,149 pass / 10,626 fail /
2,419 compile errors. Lane agreement: all three 29,630 · regime+standalone
only 3,911 · host only 2,314 · host+standalone but not regime 1,195 ·
regime+host only 960 · regime only 883 · standalone only 501. The
host-passes-but-regime-fails set fell **6,109 → 3,509**; the async-marker
(2,121) and `C_method` invalid-Wasm (~600) buckets are gone. What remains,
by signature:

| rows | signature                                                            | owner                  |
| ---: | -------------------------------------------------------------------- | ---------------------- |
|  509 | policy rejected `__gen_*` / `__create_async_generator` / `SharedArrayBuffer_new` / `__array_from_async` | #3178 carriers, SAB deferred |
|  473 | eval refusal tier                                                    | S4 #6186 (in CI)       |
|  192 | `m should be an own property`                                        | #3468                  |
| ~200 | `Array.prototype.reduce/reduceRight … not yet callable as a value`  | S3-b (to spec)         |
|  129 | `Expected a TypeError … no exception`                                | S3-d triage            |
|  116 | `called value is not a function`                                     | S3-d triage            |
|   82 | `async continuation threw … illegal cast [in __call_fn_method_N]`   | NEW — S3-e candidate (class-method trampoline under the regime) |
|   74 | native generator lowering (sequential numeric yields only)           | #3178                  |
|  ~150 | Temporal (`until`/`since`/`round`, `Temporal is not defined`)       | S4 part B (blocked on `env::__exn` under native-first, see #6706) |

**S5 flip (this checkpoint's PR):** `resolveCompileTargetProfile` now sets
`nativeRegime` for `semanticProviders: "native-first"` in a JS environment
by default; `JS2WASM_NATIVE_REGIME_JS=0` is the one-release kill switch.
Guards on the flip: byte identity 12/12 (default `gc`/`standalone`/`wasi`
unchanged — the default policy is still host-assisted), boundary/slice
suites 55/56 (the one red is the known `assignmentRest` standalone provider
defect), `check:host-import-policy` green with no ceiling change, ratchet
gates green, 321-row sample **227/321**.

**Program acceptance after S5:** rows 1 (lanes exist) and 3 (regime ≥ host)
now hold; row 2 (perf) is still unmeasured on the full workload — schedule
it before S6; rows 4–7 (default policy flip, `legacy-semantic` as a
universal error, deletion, docs) are S6/S7.

### 2026-09-29 — second nightly, S6 evidence verdict: NOT YET (three blockers filed)

Nightly 36399520787 (2026-09-28, main @ `cb50f21b90`, with S4 eval linking,
S3-e Temporal linking, S3-b reduce-as-value): regime **36,327** vs host
34,099 / standalone 35,237 (48,735 rows). Eval-refusal bucket 473 → 0.
S3-f (#6291) landed after this run. Evidence bar for S6 (#6708):

| item | verdict | detail |
| --- | --- | --- |
| 1. two nightlies regime ≥ host | **met** | 35,384 then 36,327 vs 34,099 |
| 2. per-edition ratchet on the regime JSONL | **FAIL** | ES5 −99, ES2016 −9, ES2023 −4, ES2026 −179 vs the host floors → #6750 |
| 3. npm-compat regime lane | **FAIL** | of 10 host-measured packages only `clsx` measures on the regime; `cookie`/`hono`/`redux` give wrong checksums; `uuid` crypto imports unclassified; `moment` eval provider not wired in the npm harness; `react` `require`; `acorn`/`marked`/`lit` throw → #6749 (critical) |
| 4. perf | blocked locally | needs Node ≥ 24 for the sidebar flags; run on CI/another box |

Also new: the regime-compiled Temporal provider now links but every Temporal
row dies with `wasm exception during module init` (0 pass vs host 581 /
standalone 170) → #6748.

**Reading:** test262 totals are no longer the constraint; real-package
correctness (three wrong checksums) and the completed-edition floors are.
S6 waits on #6749 (product bar) and #6750 (edition floors); #6748 is needed
for the Temporal share of the ratchet. Order: #6749 A (mechanical wiring)
and B (wrong values) first — a wrong value in the merged mode is worse than
a missing feature.

### Program acceptance

- [ ] A native-first test262 lane and npm-compat lane exist, run in CI on
      dispatch/nightly, and their baselines are committed (Phase 1).
- [x] Host-vs-native-first runtime performance is measured and recorded here
      (Phase 1). #7087 closed the one string-kernel blocker at 1.426x
      native-first / host-assisted; the S6 runtime-performance bar is met.
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


### 2026-10-14/15 checkpoint — S6 implemented, flip PR waiting on five fix PRs (Fable lead, Opus implementers)

**State change on main that reframed S6.** On 2026-10-12 the JS-host
test262 CI lane and the native-first measurement lane were retired
(`ae7991db21`, Codex lane): `test262-native-first` is `if: false`, all 102
shard runners measure standalone, the host baseline is frozen at
39,379 / 48,232 (SHA `f56c6933`, `scripts/preserve-frozen-host-baseline.mjs`).
Evidence-bar items 1–2 of #6708 therefore cannot be re-measured by a
nightly. Verdict recorded in #6708: taken as satisfied by the 10-07 and
10-09 runs plus the standalone ratchet (42,067 / 48,232 on main), which
guards the same regime arms (`ctx.standalone` ≡ `nativeRegime`). Whether a
`schedule`-only regime lane should be re-enabled is a stakeholder decision
(S7 plan #6979, entry condition 5).

**Landed today (all via PRs on `loopdive/js2wasm`):**

| PR | Issue | What |
| --- | --- | --- |
| 6664 | #6749 | npm-compat refresh workflow fixed (prebuild step needs `build:compiler-bundle`); the refresh had failed on every run since 10-06 |
| 6665 | #6979 | S7 deletion plan (five slices, measured state table, entry conditions) |
| 6670 | #6978 | per-family host accelerators: `regexp` and `date` end to end; `js-string` and `intl` refuse selection with measured follow-ups |
| 6674 | #6983 | regime npm-compat parity: acorn (closure-bag lookup on a host receiver), prettier (`-O4` 832 s → 154 s via the return-tail funnel); lit was a stale dashboard row |
| 6677 | #6985, #6986 | follow-ups filed: lodash-es `coalesce-locals` timeout; Intl is a regime gap (host `Intl_*` imports fail at run time on regime and standalone) |

**Open, blocking the flip (#6672, draft):** the flip itself works (`{}` ≡
`native-first` byte-for-byte, `host-assisted` ≡ the pre-S6 default on three
programs, `"auto"` warns once, default probe 0 legacy / 0 unknown imports,
control probe 23) but its equivalence gate exposed 50 regime-in-JS rows that
test262 never exercised. Decision: fix, not pin. Nine `issue-1197` WAT-shape
rows pin the host element specialisation and were re-pinned to
`host-assisted` (#6979 deletes them); five rows were test-harness defects
(missing `setInstance`, stub import list without the boundary hooks) fixed on
the flip branch; the remaining rows are fixed on main by:

| PR | Issue | Rows | Status |
| --- | --- | --- | --- |
| 6678 | #6980 | 17 iterator/generator rows (GetIterator on user objects and host iterables, host exceptions rethrown on the module tag, `.return(v)`, async generators, nested yields) | review P2 fixed (completion provenance carried in the frame, not inferred from bits); hold pending reviewer |
| 6673 | #6981 | 15 IR-path/compile rows (`Error.message`, Map/Set IR selection, `typeof` on specialised `any`, `let {} = 5`, boundary indexed read, `mayBeBoolean`) | review P2 fixed (`""` default yields to a touched builtin prototype); hold pending reviewer |
| 6676 | #6982 | 8 rows (`Symbol.toPrimitive`, `indexOf(undefined)`, `await` of settled values yields in a JS environment + host microtask checkpoint, `import.meta.url`) | green-able |
| 6683 | #6984 | `yield*` evaluates to the delegate's return value (nested-yield planner, spread of a boxed carrier, `next(v)` forwarding) | green-able |

Combined gate on slice A + #6980 + #6981 + #6982: 1,749 passing (floor
1,740), one new regression (the `yield*` row, #6984). After these land the
flip branch merges main, resolves the four-file conflict with #6978
(`target-profile.ts`, `cli.ts`, `compiler-boundaries.json`,
`host-import-policy-baseline.json`), re-runs the gate, sets `done`, un-drafts.

**Process facts worth keeping:** agent worktrees cannot `checkout -B
upstream/main` (protected `.claude/` paths) — use `reset --mixed` +
`restore` with the three excludes; the pre-push LOC hook measures the stale
`/Users/thomas/Code/js2` checkout when the leading `cd` is stripped, so the
lead pushes from agent worktrees; `gh` fails TLS inside agent sandboxes, so
the lead opens PRs; CI's import-cycle and inventory gates evaluate the merge
preview, so grants must be measured against main's tip; the review lane
(`ttraenkler`) holds PRs with `[P2]` findings and expects a bounded
correction plus a recorded handoff comment.

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

### 2026-10-07 — nightly after #6748: the regime leads the host lane by 2,116 rows

Nightly 37596924980 regime artifact vs the host baseline of the same day:
**41,816 vs 39,700** (standalone-vs-host gap of 10-06 closed and reversed).
ES2026 +4,228. Remaining per-edition regressions ES5 −90 / ES2016 −3 /
ES2023 −5, all owned by in-flight slices (#6880, #6894, #6898, #6912, #6881).
npm-compat regime lane: react now measures on BOTH lanes (#6877 + #6890),
acorn and prettier measure (#6879), cookie/hono/redux/moment/clsx/marked/lit
measured since 10-06; uuid waits on the next refresh. S6 (#6708) evidence
items: (1) test262 ≥ host — **met**; (2) per-edition ratchet — three
editions pending the slices above; (3) npm-compat parity — prettier `-O4`
and uuid pending the refresh; (4) perf — still needs Node ≥ 24.

### 2026-10-18 — host vs native-first performance evidence (Node 24)

Measured sequentially on macOS arm64, Node 24.4.1 / V8
13.6.233.10-node.17, at main commit `730b984168`, using the exact kernel and
npm-compat lanes required by #6708. The checked-in machine-readable record is
`plan/audit/5385-native-first-perf-evidence-20261018.json`.

Kernel medians are Wasm microseconds; ratio is native-first / host-assisted:

| kernel | host-assisted | native-first | ratio | verdict |
| --- | ---: | ---: | ---: | --- |
| fib | 2342.666 | 2335.806 | 0.997x | pass |
| loop | 86.170 | 86.853 | 1.008x | pass |
| string | 0.05975 | 1.21779 | **20.380x** | **blocker: #7087** |
| array | 10.5546 | 10.5752 | 1.002x | pass |

The string row is a narrow profile delta, not a broad claim that native
strings are slow: native-first still beats its plain-JS control (1.218 us vs
2.099 us), while host-assisted produces an unusually small 0.060 us row.
#7087 owns the required optimized-IR/Wasm comparison to distinguish a legal
provider-specific fold from a benchmark that stopped measuring equivalent
work. Under #6708's stated rule, this >2x row blocks the performance bar until
investigated.

The real-package rows all measured, matched their native-oracle checksums and
favoured native-first runtime execution:

| npm workload | host-assisted | native-first | native-first / host | reading |
| --- | ---: | ---: | ---: | --- |
| acorn | 1,826,638.750 us | 66,317.675 us | 0.0363x | 27.54x faster |
| cookie | 178.681 us | 17.928 us | 0.1003x | 9.97x faster |
| redux | 37.589 us | 1.830 us | 0.0487x | 20.54x faster |
| hono | 98.738 us | 2.388 us | 0.0242x | 41.34x faster |

**Architecture verdict:** these runtime measurements do not justify retaining
host-assisted semantics as the general model. They support the one-native-core
direction and the existing separation of boundary interop from semantics. The
measured string exception is exactly the kind of narrow case for which a named
`js-string` accelerator can remain available while #7087 closes or explains
the native-provider gap. This evidence does not erase the compile-time and
binary-size costs already recorded elsewhere; it answers the runtime row only.

### 2026-10-18 — #7087 post-fix: S6 runtime-performance bar met

Optimized-Wasm inspection proved the 20.38x row was not constant folding. The
host path retained `repeat`/concat/length and let V8 keep a rope; the native
`__str_repeat` path doubled to 5,120 code units and then flattened/copies via
`substring(0, 5000)` before reading the length. #7087 changes the shared native
kernel to binary decomposition, producing an exact 5,000-code-unit rope with
no substring tail. Repeat-count normalization, RangeError handling, prepared
provider provenance and the JS value/boundary adapter are unchanged.

The exact #6708 kernel lanes were rerun sequentially at
`5b36f318c5e9a5b1a9e11da6b924d64f5be8d1b2` on the same Node 24.4.1 / V8
13.6 environment:

| kernel | host-assisted | native-first | native-first / host | verdict |
| --- | ---: | ---: | ---: | --- |
| fib | 2347.651 us | 2340.268 us | 0.997x | pass |
| loop | 86.057 us | 85.413 us | 0.993x | pass |
| string | 0.06365 us | 0.09078 us | **1.426x** | **pass** |
| array | 10.5734 us | 10.5358 us | 0.996x | pass |

The string blocker falls from 20.38x to 1.426x, below the explicit 2.0x gate;
`bench_string()` still returns 5000. Acorn, cookie, redux and hono were also
remeasured under native-first from that commit, all with optimization verified
and checksums 422/422, 1/1, 7/7 and 9/9 respectively. Their recorded host
comparisons remain 27.24x, 9.09x, 18.18x and 36.53x in native-first's favour.
The machine-readable pre/post record is
`plan/audit/5385-native-first-perf-evidence-20261018.json`.

**Handoff:** runtime performance no longer blocks S6. This does not by itself
authorize the default flip or S7 deletion; the other #6708 correctness,
ratchet and active-PR entry conditions still decide those steps. Architecturally
the result strengthens the existing verdict: keep one native semantic core,
retain JS-host interop as a boundary adapter, and reserve `js-string` or other
host machinery for explicit accelerators rather than object representation in
the core.

### 2026-10-18 — S6 current-main landing handoff

#6708 / PR [#6672](https://github.com/loopdive/js2/pull/6672) is refreshed on
current main and locally green. The refresh did not move JS machinery into the
semantic core: the default is native-first, JS-backed objects remain confined
to the boundary adapter, and `host-assisted` is now explicit wherever a
legacy control genuinely needs it. The detailed conflict resolution, control
repins and command-level evidence are recorded in #6708.

The decisive refreshed acceptance result is Node 25.9.0's full equivalence
gate: 2,020 passing, 20 baseline-known failures and zero new regressions.
Host-import policy remains 0 legacy / 0 unknown across 33 native-first probe
families, while the explicit compatibility control still observes 23 legacy
imports. IR fallback and IR-only readiness gates are green after their
pre-existing JS-host control lanes were made explicit.

Handoff after #6672 lands: observe the post-merge lane/npm refresh, then take
the measured S7 deletion plan in #6979. The migration is not complete until
that deletion removes the compatibility semantic providers; the JS value,
object, callback, exception and lifecycle adapters remain required interop.

### 2026-10-18 — S6 npm-compat product bar verified on the candidate

Main's fresh `npm-compat.json` exposed one stale blocker rather than hiding it:
Lit was host-measured but `jsHostNative` still reported a runtime exception.
The exact #6672 head, after merging main through `50a1734711`, was run through
the focused O4 JS-host perf lane for every currently host-measured workload.
All eleven measured and matched their native-oracle checksum: acorn 422,
clsx 7, cookie 1, hono 9, Lit 7, marked 75, Moment 10, Prettier 49, React 8,
Redux 7 and UUID 2. The expected and actual value was identical in every row.
Moment ran through the repository's keyed, canary-verified QuickJS provider.

This closes the pre-merge S6 product-bar question without broadening the
architecture: the packages use the native semantic core plus the existing JS
boundary/capability adapters. It does not yet satisfy S7's post-merge entry
condition. The CI npm refresh must publish the same no-`measured → error`
result after #6672 lands; only then may #6979 delete the compatibility policy.

The landing CI also exposed two default-profile quality ratchets. #3437 now
meters the steady per-file native-first harness path after an unmetered
one-time provider warm-up and is banked at 231,951 traversals. #1918's fixed
playground corpus reproduces the old `0/43/1` fixup floor under explicit
host-assisted and the inherited native-provider `11/57/1248` floor under
explicit native-first (`drop-excess` / `default-value-lossy` /
`call-arg-coerce`). Both baselines now gate the new default. The stack-balance
numbers remain explicit Phase 2 emitter debt; the rebank prevents S6 from
comparing different provider families and does not declare the repairs clean.

### 2026-10-19 — S7 current-work PR handoff

The in-flight shared-code refactoring is published in
[Separate native semantics from JS host mode](https://github.com/loopdive/js2/pull/6762).
The detailed handoff lives in [S7: delete the host-semantic implementation](6979-s7-delete-host-semantic-implementation.md),
sections "S7-c native constructor lookup checkpoint and landing handoff",
"S7-c carrier materialization deduplication handoff", and
"S7-d orphaned host JSON retirement handoff", and "S7-d private operator
retirement handoff". The JSON retirement proves a closed private group before
deleting 422 lines; the operator retirement removes another 316 dead lines,
bringing runtime source to 11,328 with live boundary conversion retained.
The 98-row JSON and 70-row operator populations respectively remain unchanged.
The latter handoff also records an open native dynamic-instanceof gap for
JS-owned constructors/handlers; preserving object identity at admission does
not yet make those operator cases correct.
It records the implementation, parent-controlled test evidence, substantial
constructor-program binary growth, dependency stack and remaining decisions.
Native lookup and JS-owned boundary identities pass their focused controls,
but the import policy is **456 against an unchanged 452 ceiling**. The PR
remains draft, not merged; publishing the checkpoint does not approve a
ceiling increase or complete the migration. Resume with that decision and
the binary-cost review, not another untracked refactoring slice.

The later "S7 native dynamic-instanceof suspended-work handoff" section in
the same issue preserves the unsuccessful five-file IR/shared-runtime
prototype as a non-executable audit patch, with a self-contained repro and
ordered next steps. It still fails both JS-owned positive cases and only
achieves hybrid IR patching (`param-signature-unstable`), not IR-only body
ownership. The published runnable compiler does not enable that prototype;
publication in the existing PR is a handoff, not a merge or acceptance claim.

Subsequent local work is documented under "Local repair verified; still
unpublished" in that same S7 issue: the JS-owned default-constructor and
custom-handler cases now pass through prepared IR bodies (zero legacy body
emissions), with 28/28 focused controls versus 7/28 on the clean parent.
The original failed prototype stays archived for provenance. The new repair
remains local because signing is blocked; the published PR head is unchanged.
Ordinary membership after an own nullish Symbol.hasInstance override still
fails positively, and the full migration/import/dependency acceptance remains
open. Do not equate the focused repair or PR publication with completion.

The latest "S7-f foreign prototype identity and signed-publication handoff"
section records the next repair: ordinary JS-owned prototype identity now
works through a native walk plus one admission-gated identity primitive, and
a native type probe removes observable JS-Proxy classification reads. The
focused population is 55/55; the 189-case comparison has twelve improvements
and no new failures, retaining ten known failures and eleven skips. The new
identity primitive changes the import gate to **457/452**, still unapproved.
An existing matching macOS signing agent was found, allowing signed checkpoint
publication without bypassing hooks. This supersedes the earlier signing
blocker, not the PR's dependency, semantic acceptance or readiness blockers.

The subsequent "S7-g runtime binder retirement handoff" closes a low-level
runtime bypass: ambient shims no longer permit retired semantic manifests.
Six missing builtin class names are retired, and unreachable class-specific
host handlers are deleted. Runtime source is now **10,580 lines**, a **744-line**
net reduction, with **97/97** focused controls. A fresh **194-case** comparison
retains **128 passing/41 failing/25 skipped**, with no new failures; six native
binaries and all 33 import inventories match. The **457/452** gate, 8,000-line
runtime target and full program acceptance remain open. The scoped proof is
`plan/audit/6979-runtime-binder-retirement-20261019.json`.

Its qualified-capability follow-up distinguishes explicit API namespaces from
same-named global builtins, keeping eleven declared API constructors live.
The final focused population is **100/100**; native binaries/import inventories
and the 194-case population remain unchanged. Runtime source is **10,581**
lines after namespace-first constructor resolution. Compiled `api.Function`
and `api.Date` are still failing lowerer probes (Number/Map work), explicitly
recorded with a repro in the S7 handoff. Do not infer full host interop or
program acceptance from the low-level binder controls.

A further missing-provider control prevents a missing arbitrary namespace
from silently selecting global Date/RegExp/SharedArrayBuffer instead. Final
focused controls pass **101/101**, with runtime source **10,582** lines
(**742 net removed** since `f99bd729cc`). The 457/452 gate and full acceptance
remain open; selected Intl binding and declared capability identity are kept.

### 2026-10-19 — qualified constructor prepared-IR checkpoint

The S7 issue's "S7-h qualified constructor IR handoff" now supersedes the
specific compiled API Function/Date failures above. Exact ambient namespace
constructors use prepared IR and full qualified registry keys, preserving
same-leaf providers and JS-owned result/exception identity without copying.
No frozen direct-AST semantic body or new host semantic provider was added.

Local boundary/support controls pass **125/125**. The focused parent comparison
is **17/24 → 24/24**, including six ownership assertions, not six new runtime
wins. The separate four-shape execution probe improves **2/4 → 4/4**.
Fresh broad **194-case** and prepared **145-case** comparisons retain exactly
their existing **41** and **16** failures respectively; six native binaries and
33 detailed import inventories match the parent. See
`plan/audit/6979-qualified-extern-ir-20261019.json` for provenance and limits.

Published as another checkpoint in [PR 6762](https://github.com/loopdive/js2/pull/6762),
not merge-ready: predecessor PR 6701 remains unmerged, the import gate is
**457/452**, runtime remains **10,582** lines against the 8,000-line target,
and full compatibility/conformance, strict closure and other S7 acceptance
remain open. Continue from the detailed S7 handoff; do not mark this parent
issue complete from the scoped repair or PR publication.

### 2026-10-19 — remaining runtime provider retirement

The detailed S7 issue now has "S7-i remaining provider retirement handoff".
It removes orphaned Promise provider closures/registry state and unreachable
host call/array materializer providers, including two private provider modules.
Lifecycle imports now admit exactly eleven implemented registrations; unknown
builtin registration spellings reject instead of slipping through a prefix
allowance. Explicitly declared embedder functions remain capabilities.

Boundary/support controls pass **137/137**. The fresh **230-case** parent
comparison retains **155 passing/50 failing/25 skipped**, with only two
failure stack coordinates relocated to the exact same runtime source line.
Six native binaries and all 33 detailed import inventories match.
Runtime source is **10,160 lines**, **422 net removed**; the 8,000-line target
still has a **2,160-line gap**, and the hard import gate remains **457/452**.
See `plan/audit/6979-provider-retirement-20261019.json` for scoped proof and
source hashes. The live gap families, predecessor stack and full acceptance
remain open; do not mark this parent complete.

### 2026-10-19 — exact declared capability / accelerator identities

The S7 issue's "S7-j declared capability / accelerator isolation handoff"
records a verified boundary repair: same-named API Date/RegExp classes no
longer coerce compiled object arguments, qualified Test262Error receives a
normal live facade, and nested Intl capabilities cannot select global
constructors or receive the intrinsic Intl wrapper merely by prefix.
Selected intrinsic accelerators remain intact. JS object/result/exception
identity is preserved, without copying or a frozen AST body-emitter change.

Boundary controls pass **151/151**. The focused parent comparison improves
**57/68 → 68/68**; the broad **230-case** population remains **155 passing/50
failing/25 skipped**. Six native binaries and all 33 import inventories match.
Evidence and proof limits are in
`plan/audit/6979-capability-accelerator-isolation-20261019.json`.

Runtime is now **10,163 lines** (three additional routing lines), leaving
**2,163** against the 8,000-line target. The **457/452** import gate and all
remaining program/dependency acceptance stay open. This corrects interop at
the existing shared boundary; the measured object-argument body still uses
the existing direct route and is not claimed as new IR-only coverage.

### 2026-10-19 — import-budget blocker closed by native key filtering

The S7 issue's "S7-k native boundary key filtering / import gate handoff"
supersedes the preceding **457/452** blocker. The unchanged official
33-probe gate now passes at **433/452**, with zero unknown/gap entries in that
population. Native string/symbol filtering shares the existing admitted-object
own-key primitive: **44** redundant provider occurrences removed, **20**
existing-primitive occurrences added, **24 fewer net imports**. No baseline,
probe or detector relaxation.

Boundary controls pass **158/158**; the **230-case** and **145-case** parent
comparisons retain their existing outcomes after explicitly re-pinning the
removed-import expectation. Six native binaries are byte-identical. Three
measured JS key programs grow **319/319/443 bytes**; that tradeoff and the
remaining program-wide cost review are not hidden by the import reduction.
See `plan/audit/6979-native-boundary-own-keys-20261019.json`.

Runtime remains **10,163 lines**, **2,163** above target. The predecessor stack,
opaque bound functions, raw-mode retirement, named native-provider gaps,
strict closure and full compatibility/conformance/accelerator acceptance
remain open. Do not mark this parent complete from the now-green import gate.

### 2026-10-19 — one shared native object-source runtime on WASI

The S7 issue's "S7-l shared native object source handoff" removes three
obsolete mode guards that made WASI silently skip closed-struct and Proxy
Object.assign sources. The same screened classifier also enables the existing
JSON.stringify and Object.defineProperties closed-struct paths on WASI.
No AST body, selector, JS semantic provider or boundary identity change.

The new matrix passes **33/33**; nine WASI rows fail on the unchanged parent
and pass now. The **170-case** comparison improves **158/12 → 167/3** with
the three existing linked object-rest failures unchanged. All **33** JS
policy binaries and inventories are byte-identical; the hard gate stays
**433/452**. Five of six minimal native controls match; WASI dynamic grows
**1,443 bytes**, and two minimal WASI assign probes grow **1,434/1,475 bytes**.
No overall size/performance improvement or new IR coverage is claimed.

Raw mode references fall **804 → 799** without banking the 818 ceiling.
Runtime stays **10,163 lines**. The discovered captured-Object.assign
variadic-argument loss is still open, alongside the earlier migration
acceptance gaps and prerequisite stack. Exact evidence:
`plan/audit/6979-shared-native-object-sources-20261019.json`.

### 2026-10-19 — native captured Object.assign ABI and JS boundary sources

The S7 issue's "S7-m native Object.assign argv and boundary-source handoff"
reuses the native variadic ABI for every supplied source, preserves captured
result storage as externref and copies admitted JS-owned source properties
through the same native MOP loop. Exact value/key/throw identity is retained;
there is no boundary object-graph copy or new host semantic implementation.
WASI shares strict Proxy write rejection and Object member patch handling.

New controls pass **69/69**. The **268-case** comparison improves
**227/41 → 265/3**, zero skipped, with 38 changed rows in the new test and
the same three linked object-rest failures. All **33** policy inventories match
and the gate stays **433/452**. Five JS probe binaries shrink while two native
dynamic controls grow **547/3,418 bytes**; the separately measured gc fixture
needs three more occurrences of existing value adapters (**19 → 22**).
No overall footprint/performance win or new IR body coverage is claimed.

Raw mode references fall **799 → 795** without banking the 818 ceiling.
Primitive-target wrappers and generic patched-Math aliases still fail all six
target/fixture controls exactly as on the parent. A newly checked import-cycle
gate also fails on both parent/candidate with the same reported violations.
Those, runtime retirement (**10,163 lines**), strict closure and the remaining
program acceptance/predecessor stack stay open. Evidence and exact source
hashes: `plan/audit/6979-native-object-assign-argv-20261019.json`.
The final callable-escape probe also remains broken on both parent/candidate:
returning native Object.assign to JS produces a function-shaped facade whose
call dispatchers were not exported. Full host interoperability is not certified.
The flat-directory gate is now satisfied at **833** files by locating the new
helpers under existing subsystems and moving the unchanged boundary filters;
binary/test equivalence of that relocation is recorded in the audit.

### 2026-10-19 — native callable argv at the live boundary

The S7 issue's "S7-n native callable argv and returned-function handoff"
corrects the preceding dispatch diagnosis: exports existed, but a duplicate
return wrapper ignored them. Returned functions now use the existing cached
bridge; exact native builtin identity declares packed argv through the
authenticated rest discriminator, independently of reflective arity. Existing
argument-list adapters preserve JS target/source/token identity and all native
builtin arguments, including 32-argument calls. Ordinary callback objects and
receivers are admitted live, with native primitive/error translation. No host
semantic implementation, new import, frozen AST body or selector change.

New controls pass **17/17**. The **376-case / 22-file** comparison improves
**349/27 → 366/10**, zero skipped; no previous expectations changed. Two of
the retained failures are linked-harness controls whose pinned test data is
present but QuickJS execution is unavailable, not compatibility passes.
All **33** import inventories match and the guard stays **433/452**. Eleven
policy binaries match, eighteen grow **5 bytes**, four grow **149**; two native
dynamic controls grow **83 bytes**, with all six native controls still
import-free. No overall size/performance improvement is claimed.

Runtime is **10,161 lines**, **2,161** above target. Wider ordinary rest calls,
five-parameter returned functions, JS facade name/length and typed JS array
identity/mutations/aggregate returns remain failing in fresh controls. The
previous six primitive-target / patched-Math controls also remain unchanged.
These, inherited cycle failures, strict closure, opaque bound functions,
source retirement, the prerequisite stack and full program acceptance stay
open. Do not mark this parent complete. Evidence:
`plan/audit/6979-callable-boundary-argv-20261019.json`.

### 2026-10-19 — bounded native callable argv publication

The S7 issue's "S7-o bounded native callable argv publication and handoff"
publishes the existing native apply contract through an instance-authenticated
boundary, rather than widening JS dispatch ladders. Ordinary five/nine-formal
calls and `any[]` rest calls through 32 inputs now pass the scoped controls;
objects/receivers/throw tokens remain live identities. Native enumerable string
keys use existing OwnPropertyKeys/descriptor primitives. No new host semantic
implementation, frozen AST semantic body, selector or IR coverage claim.

The new matrix passes **31/31**. The **495-case / 26-file** comparison improves
**467/28 → 483/12**, zero skipped. All 16 changed rows are new controls,
including structural/inventory assertions, not independent defect counts.
The audit records retained failure shapes, not just aggregate counts. Import
policy passes **437/452** on 33 probes with zero unknown/gap entries, versus
parent 433. Its required-adapter assertion changes to the new primitive contract
and now forbids the retired enumerable-key selector; population and ceiling
do not change. Nine policy binaries match and 24 grow. The typed-callable fixture
grows **22,678 → 107,033 bytes**; six native standalone/WASI binaries remain
byte-identical and import-free. Runtime grows 74 lines to **10,235**. Footprint
is an open tradeoff, not a claimed improvement.

Typed rest with 32 inputs still observes 5, null receivers still normalize incorrectly, and
wide fixed over-application explicitly throws until native extras are fixed.
Callback construct rejection, init-window/opaque callable handling, facade
metadata, typed JS array identity/mutations, prior primitive/Math residuals,
source retirement, strict modeled closure/cycles and full program acceptance
remain open. Keep this issue in progress and PR6762 draft on the prerequisite
stack. Detailed source/gate hashes, transitions, costs and negative-control
source: `plan/audit/6979-complete-callable-argv-20261019.json`.

### 2026-10-19 — shared native argument-tail repair

The S7 issue's "S7-p shared native argument-tail repair" fixes typed numeric
rest truncation, above-cap extras and padded argc through the existing native
calling contract. Preserve the actual count across reentrant getters, avoid
out-of-range Get when padding, and use existing typed-vector element conversion
on the full canonical extras list. The temporary JS wide-over-application
refusal is removed after native nine/fourteen-formal execution controls pass.
No frozen AST semantic body, driver/selector, new host import or IR-coverage
claim; no baseline/ceiling/allowance changes.

New controls pass **107/107** across standalone/WASI/JS boundary. The **638-case /
30-file** comparison improves **569/69 → 623/15**, zero skipped or status
regressions. All 15 retained normalized full errors match. Import policy remains
**437/452** with all 33 inventories identical. Nine policy binaries match,
twelve shrink 95 bytes and twelve grow 377–4202; two native dynamic controls grow
1499/1486 bytes, with all six still import-free. Runtime drops 5 lines to 10230.

Fresh boolean/string rest probes also improve, but BigInt/native Number still
overflows and typed JS-object rest elements still fail (property error → illegal
cast), not live identity/mutation preservation. These, strict receiver and
callable semantics, typed-array/aggregate interop, tuple-rest compile failures,
source/raw-mode retirement, strict closure/cycles and full acceptance remain
open. Both migration issues stay in progress and PR6762 draft on its prerequisite
stack. Detailed evidence and next steps:
`plan/audit/6979-native-argument-tails-20261019.json`.

### 2026-10-19 — IR object identity and typed-object ABI diagnosis

The S7 issue's "S7-q IR object identity and live typed-object ABI handoff"
adds native IR identity comparison for logical objects through the canonical
boxing/equality engine, without changing selectors, prepared admission or
frozen AST bodies. New controls pass 32/32; the 670-case/31-file comparison is
643/27→655/15, zero skipped or status regressions. The 12 changed rows prove
actual IR body emission, not 12 newly fixed JS interop behaviors. All 15
retained full errors match after tree normalization. All 33 policy inventories
and binaries and six native control binaries match; policy remains 437/452.

The separate 16-case boundary diagnostic remains 5/11: every JS-owned typed
object case still fails. Its native/dynamic controls work, but typed public
parameters require GC structs. Read/write/echo have IR overlays after direct
emission, not prepared ownership; the signature vocabulary excludes logical
objects. The implementation must declare a foreign-capable native interop ABI
and propagate its carrier/operations through calls and returns, not just relax
an admission guard or copy fields. The old architecture doc's deep-copy proposal
is replaced by the normative live-reference contract with these gaps explicit.

Runtime remains 10230 lines and the full migration remains in progress. Source
hashes, counters, expected/actual negative cases, costs and next steps:
`plan/audit/6979-live-object-abi-and-ir-identity-20261019.json`.

### 2026-10-19 — reference-object backend carrier and early effect projection

S7-r continues from signed `ad1907e64cc732376ab116fcda0981b49f02a8e8`.
The same logical object IR can now lower over an explicitly declared reference
ABI, with structural Get/Set callable providers and consistent signatures,
SSA spills, construction erasure, calls and returns. Property operations become
real IR calls **before optimization**, preserving getter effects through DCE,
GVN and scheduling; late raw reference field lowering fails closed. Native-only
lowering stays unchanged. No frozen AST/selector/admission changes, graph
copier, nominal default-field wrapper, new host import or extra semantic engine.

The new backend matrix passes **26/26**, including live JS references and native
zero-import controls, but its primitive providers are manually bound fixtures.
This is **not production entry/provider/ABI publication**. Existing 670-case
comparison stays 655 passing/15 failing; additional 49 backend cases stay
47 passing/2 failing. All 17 retained normalized errors match. All 33 policy
binaries/inventories and six native binaries match; unchanged guard 437/452.
The separate public typed-object diagnostic stays **5/16 passing, 11 failing**,
with an identical binary. Do not convert backend-fixture results into a claim
that public source interop or exclusive prepared ownership is fixed.

Next: attach the projection before source optimization, plan exact native
property resources and complete reachable reference-capable callable ABIs,
then publish authenticated boundary metadata atomically. Mutable physical
slots, nested/container/vector/rest/class/capture carriers and all earlier
acceptance obligations remain open. Runtime remains 10230 lines; strict
modeled closure and inherited cycle gates still fail. Both migration issues
remain in progress and PR6762 stays draft. Detailed handoff and exact evidence:
`plan/audit/6979-reference-object-lowering-20261019.json`.

### 2026-10-19 — source write policy and logical record contract handoff

S7-s continues from signed `de036a4a4f71a208f816b5e7cf6610b66a2df63b`.
Source ObjectSet now preserves strict/sloppy failed-write behavior; early
reference projection requires that fact and the corresponding structurally
declared setter. Unknown policy or absent provider fails closed. One frontend
strictness owner serves IR and compatibility callers, also fixing inheritance
through enclosing arrows/accessors: four real standalone/WASI probes change
-1→42 with no imports. Their bodies remain direct, not newly IR-owned.

Checker-derived logical record contracts now survive whole-program source
preparation and codec replay for aliases/interfaces/inheritance/nested/generic
records. Unsupported recursive/optional/indexed/empty/union/nominal shapes
fail explicitly; expanding generic recursion is bounded. Logical annotation
is not physical-layout or foreign-entry authority. The prepared driver still
rejects read/echo/write at physical acceptance, and the public typed-object
diagnostic remains **5/16 passing, 11 failing**, identical binary.

Focused candidate **73/73**, exact parent **36/73** with identical tests;
33 transitions concern source/provider contracts and four actual native
strictness behavior. Existing cohorts stay **655/670**, **66/68** and **35/41**,
with all 23 retained normalized full errors matching, zero skips. All 33
policy inventories/binaries and six zero-import native binaries match; guard
437/452. Typecheck/lint/format, size/function/coercion/oracle, layering/fallback,
flat/inventory and issue checks pass without new allowances. Strict modeled
closure remains open; cycles now also expose frontend→ir 17→18,
frontend→ts-api 2→5, ir→frontend 7→9, not waived or called green.

Next owner: project on raw source IR **before optimization**, plan the complete
reachable reference-callable component and canonical native strict/sloppy
Get/Set resources, then atomically publish authenticated ABI/entry metadata.
Plan mutable/container/rest/class/capture carriers and actual-carrier equality;
cut the measured cycles. No graph copy, frozen AST/selector/admission expansion
or new host imports. Complete component planning/public entry publication and
all prior retirement/acceptance obligations remain open. Both issues stay in
progress; PR6762 stays draft pending prerequisites. Detailed actionable handoff:
the S7 issue's "S7-s source write-mode and logical record contracts" section and
`plan/audit/6979-source-reference-contracts-20261019.json`.

### 2026-10-19 — reference planning in the real source preparation transaction

S7-t continues from signed `b0d73c4b9f3dfa4ee03c98cab2cae50db7c92bc9`.
An internal live projection now derives the complete current logical record
population and exact per-field Get/strict-Set/sloppy-Set declarations in the
existing Program ABI. Property operations become calls before hygiene;
direct-call signatures are checked before optimization, including imported
callees. The logical plan is frozen with the program and authenticated against
current shapes/declarations after codec replay. Backend adapters consume the
same pure semantic projection; no backend handles or TypeScript dependencies
cross the clean program boundary, and no boundary rule was weakened.

New matrix **17/17**, prior focused matrix **73/73**; genuine preparation retains
an unused getter, strict and sloppy source stores, exact thrown tokens, aliases
and nested contracts. Emitted record bodies still use test-only admitted
foreign primitive bindings, not canonical production resources. Independent
WasmGC/standalone and linear/WASI scalar controls execute with zero imports
and identical bytes with projection off/on. Four paired existing-API record
probes still reject at physical acceptance; public typed-object diagnostic
stays **5/16 passing, 11 failing**, identical binary.

Fresh **779-case / 38-file** comparison against the published parent stays
**756 passing / 23 failing**, zero skips/transitions; all 23 normalized full
errors match. All 33 policy binaries/inventories and six native binaries match;
guard 437/452. Normal size/function/coercion/oracle, typecheck/lint/format,
layering/fallback, flat/inventory and issue checks pass without new allowances.
The inherited five cycle pairs and two strict-closure dynamic imports remain
open; runtime stays 10230 lines.

Next: reserve/fill canonical native property resources with actual native
record allocation/carrier ownership, complete storage and indirect-callable
representation, then atomically publish authenticated entries. An old native
fixed-field struct does not automatically have ordinary-object descriptor/
prototype semantics. No copied graph/default-field wrapper or partially
reference-capable public entry is permitted. The plan currently declares all
three operation contracts per field, not a proof of physical cost or unused
provider elision. All prior retirement/acceptance/prerequisite obligations stay
open. Both issues stay in progress; PR6762 stays draft. Detailed S7-t handoff
and exact evidence: `plan/audit/6979-reference-program-planning-20261019.json`.

### S7-u handoff: preserve construction inputs, not a completed constructor

The current checkpoint in [refactor(codegen): separate native semantics from JS host mode](https://github.com/loopdive/js2/pull/6762)
preserves literal insertion order separately from canonical storage order,
distinguishes special `__proto__`/method requirements, and retains detached
allocation source facts through cloning and replay. Structural validation of
facts is not a runtime/provider certificate. No host import, graph copy or
public interop admission was added.

Native construction remains next: join actual source allocations and operands,
then compose canonical storage, descriptors and value resources. The full native
Object/Function realm is not complete; implicit default prototypes must not be
replaced with null or fake Object.prototype. An explicit-prototype kernel would
be a prerequisite, not full literal semantics. Physical property providers,
actual foreign field-value carriers and publication remain open.

Detailed next-owner instructions and current verification are in the S7-u
section of `plan/issues/6979-s7-delete-host-semantic-implementation.md`
(**S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators**).
Both issues remain in progress; PR6762 remains a draft handoff, not a merge-ready
migration. The existing prerequisite stack and inherited acceptance failures
are unchanged. Tracking stays in repo Markdown; no GitHub issues or comments.

### S7-v: owned native record initialization prerequisite

The next checkpoint implements real explicit-prototype WasmGC initialization
from actual prepared record allocations, using the canonical storage,
descriptor and primitive owners. Source insertion order is independent of
storage order; nested references retain identity. Canonical fills, complete
dependency ownership and current source requirements are required—not caller
placeholders or type/layout lookalikes. Duplicate logical fields are rejected
by source-fact validation.

New native-resource tests pass **13/13**, alongside the prior **135/135** focused
cases. Three instances execute without imports, including displaced indices and
codec replay. Fresh parent/candidate resource tests retain **147 pass / 14 fail
of 161** with identical full errors; the 779-case cohort retains **756 pass /
23 fail**. All 33 policy binaries/inventories, six native controls and the
5-pass/11-fail public typed-object diagnostic remain unchanged.

This does not complete source default prototypes, the native Object/Function
realm, foreign field carriers, provider wiring, callable/storage closure,
Linear/WASI record construction or public boundary publication. Architecture
cycles now include backend→ir 115→117; no waiver is added. The detailed S7-v
handoff also records an inferred method-object return erased to void, which
must not become an absence/construction proof. Both issues remain in progress;
PR6762 stays draft. Evidence:
`plan/audit/6979-native-construction-resource-20261019.json`.

### S7-w: do not erase inferred object returns into void

Whole-source preparation now distinguishes an unknown lattice result from void.
Inferred data/empty records retain their allocations and Boolean brands;
unknown method/cast results are explicit unsupported contracts. Callable returns
remain intact. Proven literal undefined keeps its valid zero-result ABI without
adding a host import or claiming a general undefined value carrier.

Fresh paired probes confirm the parent emitted deep/empty object factories as
52/51-byte functions returning undefined. The candidate preserves four/one
allocations and constructor demands, then correctly exposes incomplete native
default-realm/carrier ownership. This is removal of false acceptance, not public
interop completion. Both scalar targets still execute identical 85-byte modules
returning 42/7, and known undefined retains its 51-byte binary.

**15/15 new / 184/184 focused** cases pass. Existing 779-case and fresh paired
161-case resource populations retain **756/23** and **147/14** pass/fail rows,
respectively, with identical full errors. All 33 policy binaries/inventories,
six native controls and the 5-pass/11-fail public typed-object diagnostic remain
unchanged. The six cycle pairs and strict-closure gaps remain open; no waiver or
full Test262 claim. Exact evidence:
`plan/audit/6979-inferred-return-contracts-20261019.json`.
Both issues remain in progress; default realm, actual field carriers, provider
publication, Linear/WASI construction and architecture completion still remain.

### S7-x: native records retain actual realm state

The existing construction resource now optionally borrows the genuine realm
layout owner sharing its exact own-storage layout. It allocates the ordinary
subtype with a fresh prototype/realm state, then uses the existing canonical
descriptor engine for source-order fields. Missing runtime realm identity traps;
non-null identity is not proof of completed standard intrinsics. No second
property engine, copied graph, host import or default/public admission is added.
The old non-realm constructor recipes and three binary witnesses stay identical.

**9/9 new, 69/69 focused** cases pass, with four real zero-import stateful
instances including displaced indices, codec replay, empty allocation and
storage growth. The 779-case cohort retains **756 pass / 23 fail**, and the
161-case resource suite **147 pass / 14 fail**, with identical full rows against
retained published-parent reports. All 33 policy inventories/binaries and six
native controls remain unchanged. Architecture cycles and strict-closure gaps
remain open; preservation-only checks do not certify retirement.

The detailed S7-x handoff also corrects the earlier S7-w ad-hoc source probe:
its literal-plan errors used incomplete required backend options, not a normal
consumer request. Complete options execute the genuine captured-call control
(94, zero imports); only the incomplete input reproduces that ownership error.
Do not weaken authentication to repair a malformed probe.

Evidence: `plan/audit/6979-realm-record-construction-20261019.json`.
Both issues remain in progress. Actual default Object/Function algorithms and
population, authenticated mixed prototype/field carriers, canonical provider
publication, Linear/WASI construction and retirement acceptance remain required.

### S7-y: correct native NaN SameValue before realm publication

The actual native SameValue/descriptor kernel now equates distinct Number NaN
payloads, without coercing other value brands. Paired carrier round trips prove
the payloads survived: the parent wrongly rejects six of nine NaN pairs and
their frozen-property redefinitions; the candidate accepts all nine. Signed
zero and finite/infinite controls are unchanged. The frozen historical recipe
and compiler binaries remain untouched; no JS callback or second property
engine is introduced.

**40/40 new, 120/120 focused execution cases** pass. Existing resource cases
retain **147 pass / 14 fail of 161**, and the 779-case cohort **756 pass / 23
fail**, with matching full rows. A fresh exact-parent custody control confirms
the candidate's **9 pass / 26 fail of 35** with identical full errors; no
receipt, skip or expectation is rewritten. All 33 policy binaries/inventories
and six native compiled controls stay identical. Four native construction
test modules preserve behavior and grow by 37 bytes each for the correction.

Evidence: `plan/audit/6979-native-same-value-nan-20261019.json`.
This fixes the native kernel prerequisite, not public Object.is admission or
the whole realm. Actual catalog algorithms/population, public provider/carrier
closure, Linear/WASI construction and architecture/retirement gates remain
open. Both issues stay in progress and the PR remains draft.

### S7-z: owned native Object.is catalog algorithm

The actual Object.is algorithm slot now composes the existing Call transport,
corrected SameValue kernel, canonical omitted undefined and an issued Boolean
boxer. Full realm declarations borrow that exact slot, not a copied signature
or a second implementation. Program/projection identity, argument/string and
value owners and canonical completion are checked independently of the
remaining realm population. No caller-filled body, non-null realm anchor or
count can promote this to whole-realm/public entry authority.

**56/56 new, 183/183 focused cases** pass, with real zero-import execution across
displaced/decoded resources and both Boolean boxing modes. Missing/null values,
NaN/signed zero, native primitive/reference identity, mixed UTF-8/UTF-16 String
equality and argument-vector growth are covered. The 779-case cohort retains
**756 pass / 23 fail**, and the 161-case resource cohort **147 pass / 14 fail**,
with identical full rows against retained published-parent reports. All 33
policy inventories/binaries and six native compiled controls stay identical.

Evidence: `plan/audit/6979-native-object-is-algorithm-20261019.json`.
This is native-value-ABI algorithm completion, not raw host value admission,
lifted-call/singleton publication or complete public Object.is support. The
remaining catalog, foreign carriers/identity, source/public provider closure,
Linear/WASI and architecture/retirement requirements stay open. Both issues
remain in progress and the PR remains draft.

### S7-aa: canonical base catalog callable algorithms

The actual full-catalog Function.prototype and ThrowTypeError algorithm slots
now use canonical native undefined, TypeError and public exception owners.
Full realm declarations borrow these exact reservations, without duplicate
implementations or fabricated bodies for the remaining catalog. Completion
checks source/value, argument/string and exception identities; it does not
grant singleton population, lifted-call or source/public-entry authority.

The final focused run passes **159/159** cases, including **16/16** new cases.
Three actual zero-import instances verify canonical undefined and shared-tag
TypeError payloads at ordinary/displaced/decoded resources. Four emitted
definitions are identical to the exact signed parent's pure algorithms.
Existing callable tests pass **36/36**; the three object-resource suites retain
**147 pass / 14 fail of 161**, matching full retained-parent rows. All **33**
policy inventories/binaries and **six** native compiled controls stay identical.
No new host import, graph copying, module, root, allowance or selector path.

The remaining catalog algorithms/population, foreign value identity, canonical
mixed providers, source/public publication, Linear/WASI and architecture/full
retirement acceptance remain open. Both issues stay in progress; the PR stays
draft. The 779-case compatibility cohort and full Test262 were not rerun here.

Evidence: `plan/audit/6979-native-realm-base-algorithms-20261019.json`.

### S7-ab: frontend dependency cuts

Frontend helpers now use the existing canonical TypeScript leaf rather than
the legacy runtime-selection facade, and the existing shared diagnostic class
directly. Index-free source allocation facts have one shared owner, preserving
the original namespace/schema and exact validator declaration; IR compatibility
exports retain the same identities. No source or public-provider admission
changes, new host imports or boundary graph copying.

**49/49 focused cases** pass, including **15/15 new**. Fresh exact-parent
comparison confirms the broader **189 cases remain 40 pass / 149 fail**, with
identical full rows/errors after worktree-path normalization only. The two
historical custody suites still stop at earlier source-receipt guards; this
does not certify deeper retirement invariants. Native construction passes
**22/22**, data replay **8/8** and detector controls **7/7**. All **33** policy
binaries/inventories and **six** native compiled controls remain identical.

Frontend-to-IR value edges fall **19 → 17** and frontend-to-legacy-shim edges
**5 → 0**. Growing direction metrics drop **six → four** without a waiver;
the largest file-level SCC is still **712** and total value edges grow by one
for the shared compatibility export. Architecture/strict closure and the
historical custody suites remain incomplete. The remaining catalog, foreign
identity, source/public publication, mixed providers and Linear/WASI work also
stay open. Both issues stay in progress and the PR stays draft.

Evidence: `plan/audit/6979-frontend-dependency-cuts-20261019.json`.

### S7-ac: native mixed-object extensibility

The genuine mixed structural owner now reserves, fills and audits native
IsExtensible/PreventExtensions internals. They authenticate the existing
carrier/realm and own bag before reading or changing its canonical storage
flags. PreventExtensions preserves every other flag and property; insertion,
descriptor and prototype operations observe the same nonExtensible bit.
Source/realm/missing-bag readiness and unsupported foreign values remain
distinct from Boolean results. No public Object/Reflect admission follows,
and JS-owned boundary values/callables remain live references without copying.

Actual catalog algorithm composition must use genuine argument/value/error/
Boolean and mixed owners with reviewed realm declaration/fill ordering, not
raw function handles or caller-filled bodies. Mixed Get/Call, full intrinsic
population, source/public entry, foreign identity, Linear/WASI construction
and architecture/retirement acceptance remain open. Both issues remain in
progress; the PR remains draft.

Final verification passes **201/201 native-focused** and **38/38 callable**
cases, including **44 new** cases and three real zero-import mixed modules at
normal/displaced/decoded coordinates. The existing callable definitions are
unchanged; both routes use one ordinary-storage flag kernel, with independent
instruction trees. The 779-case cohort retains **756 pass / 23 fail** and the
object-resource cohort **147 pass / 14 fail of 161**, with complete historical
rows/errors equal to retained reports. All **33** policy inventories/binaries
and **six** native compiled controls remain identical. No receipt, expectation,
skip, root, floor or waiver changes. The final native run exits zero with no
runner errors; the initial worker-reporting timeout is retained in the audit.

Typecheck/lint/format and size/function, coercion/oracle, layering/fallback and
flat-directory gates pass. The complete cycle report remains unchanged,
including the four growing direction counts. Strict retirement closure and
historical custody/conformance obligations remain open, not certified by
preservation-only checks. Evidence:
`plan/audit/6979-native-mixed-extensibility-20261019.json`.

### S7-ad: authenticated owned catalog Call entries

Canonical private Call entries now borrow the actual reserved realm slots for
the genuinely owned Function.prototype, ThrowTypeError and Object.is algorithms.
Their metadata/realm/singleton/signature predicate and guarded transport share
the existing native implementations, preserving six complete bootstrap
definitions at normal/displaced indices. Algorithm/lifted completion compares
re-derived definitions independently of fill receipts, including exact scalar
bits; completed globals and failed partial fills cannot become Call authority.
No raw-handle/body binder, duplicated algorithm, host import, value graph copy
or source/public admission is introduced. The remaining catalog stays unfilled.

The final focused run is **425 pass / 1 fail of 426**, with **268/268 native**
and **38/38 new** cases passing. Three real zero-import component modules cover
normal/displaced/decoded resources, stored Call, canonical undefined and exact
shared-tag TypeError payloads, SameValue/argument growth and identity refusal.
These named component initializers do not certify production population.

The sole remaining focused failure is reproduced on a fresh clean signed
parent: **148 pass / 1 fail of 149** original physical tests, with identical
complete rows/errors after path-only normalization. Nine new physical checks
pass. No receipt, expectation or skip is changed. The initial concurrent run's
mixed-owner 35-second timeout is retained in the audit; the final run passes
that case with the original limit and no ignored errors. The clean control
checkout was recoverably archived and its reports retained.

Final-source broader runs retain **147 pass / 14 fail of 161** object-resource
cases and **756 pass / 23 fail of 779** compatibility cases, with identical
complete rows/errors against retained S7-ac reports. No fresh exact-parent
resource/compatibility comparison is claimed for these two runs.

All 33 policy inventories/binaries and six native compiled controls match the
published parent. Size/function and the usual code-quality gates pass, without
a new allowance. Policy/classifications and all cycle metrics are unchanged;
one shared-predicate value edge is added. The four growing direction counts,
strict dynamic-import closure, historical custody and complete conformance
requirements remain open. Remaining catalog/population, mixed Get/Call,
foreign identity, source/public entry and Linear/WASI remain required. Both
issues stay in progress; the PR stays draft.

Evidence: `plan/audit/6979-owned-catalog-lifted-calls-20261020.json`.

### S7-ae: native Object extensibility catalog composition

Continue from `cde92c0be290e16821d70a0e26eeccec32bae6fb`. Compose the actual
Object.isExtensible/preventExtensions algorithm and guarded Call slots downstream
of the genuine realm/mixed structural owners. Include the native primitive
rules, not an object-only shortcut; unknown/unready values must not become
false/success. No JS-owned boundary value or object graph is copied.

The actual reserved algorithm/guarded Call slots are filled by their genuine
downstream owner, with no raw-handle/body binder. Initial runtime execution
caught the omitted native i31 Number representation; the final algorithms
consume the existing primitive-classification owner, whose executed Number,
Boolean and BigInt predicates are now independently audited. Canonical undefined
identity and exact global initializer bits remain strict. No public/source
admission, complete catalog population or retirement completion follows.

Final focused verification is **673 pass / 1 fail of 674**, no skips or reported
runner errors. All **63 new cases** and **185 existing classifier cases** pass.
Four zero-import component witnesses execute actual producer slots; the
unimplemented catalog remains unfilled in the real unsealed ledger. Every
complete row/error of the prior **426-case** cohort matches retained S7-ad
results exactly without normalization. Only the existing physical receipt fails;
this comparison is not a fresh parent run. No existing expectation is relaxed.

All 33 policy inventories/binaries and six native compiled controls match the
published parent. Quality and budget gates pass; inventory valid with two new
classified modules, no root/floor/allowed-edge changes. The same four growing
directions, largest SCC712 and strict dynamic-import gaps remain open. Broader
161/779 cohorts, full Test262 and historical custody were not rerun here.

Harness note: the CLI requests two workers, while the base configuration derives
the effective pool limit from available RAM. Actual concurrency was not sampled;
no timing/concurrency A/B inference is made. The case timeout is unchanged.
The explicit Node control shows native i31 7 and raw JS 7 are the same number;
this is native primitive representation, not host-object authority or copying.

Evidence: `plan/audit/6979-native-object-extensibility-20261020.json`.
Remaining catalog/constructors, genuine ToObject/default prototypes, complete
population and mixed Get/Call, atomic source/public publication, foreign/live
boundary identity, first-class undefined, Linear/WASI and the architecture/
custody/retirement/conformance gates remain required. Both issues stay in
progress; the PR stays draft.

### S7-af checkpoint handoff: native Object.setPrototypeOf

The actual Object.setPrototypeOf algorithm and guarded Call slots now compose
the existing authenticated primitive/mixed-object/error owners. Nullish O is
rejected before reading P; P must be Object or null even when O is a primitive.
Primitive results retain their exact reference; objects mutate their real state,
not a copied bag or the stale ordinary prefix. Immutable, non-extensible and
cycle behavior remains the existing mixed owner's responsibility. Unknown,
unready and foreign private-ABI values still refuse loudly. No public/source
Object support or whole-realm completion is implied.

The shared fixed producer lives in
`src/backend/wasmgc/resources/native-object-structural-algorithms.ts`. Its two
exported factory families retain distinct issued scopes and no caller-selected
entry, function handle or body may certify completion. Existing extensibility
expectations are unchanged. No new host import, semantic engine or graph copying.

Detailed implementation, verification and next-owner instructions are in
[S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators](6979-s7-delete-host-semantic-implementation.md),
under **S7-af implementation and landing handoff**. Work is published through the
existing draft [refactor(codegen): separate native semantics from JS host mode](https://github.com/loopdive/js2/pull/6762),
not a new GitHub issue. The prerequisite PR is still open; conflicts, the four
architecture-direction violations and strict retirement proof gaps remain.

Next: genuine ToObject/default-prototype owners, remaining catalog/constructors,
mixed Get/Call and complete population before atomic source/public admission;
then the live foreign-boundary, undefined, Linear/WASI, custody and conformance
obligations already listed above. Both issues stay in progress; do not mark the
migration complete or ready this PR on the strength of component completion.

Final new-file verification is **38/38 passing**, with no skips or reported
runner errors: 33 runtime cases and five owner controls. Three zero-import
component witnesses exercise actual slots; the real realm remains incomplete.
All four existing extensibility binaries equal retained parent hashes. The 63
existing assertions also report passing, but their enclosing intermediate run
has three subsequently corrected new assertions and one onTaskUpdate runner
error; no clean combined-run claim. Before merge, obtain a clean complete
regression run. No old receipt/expectation was changed.

All 33 policy inventories/binaries and six native standalone/WASI controls equal
retained parent reports. Selected quality/budget gates pass, but the same four
architecture directions and strict dynamic-import proof gaps remain red/open.
Full Test262 and the complete earlier 674-case/broader cohorts were not rerun.
Source/report hashes and failed development observations are retained in
`plan/audit/6979-native-object-set-prototype-20261020.json`. The auxiliary
issue-ID checker's failed/empty scans are tracked in the detailed handoff and
are not treated as passing verification.

### S7-ag: complete the retained prototype setter before realm population

Continue from `d54d8454130e9721dc37e429ca081c9b4e0771aa`. The actual
`%set Object.prototype.__proto__%` algorithm and guarded Call owner now use the
existing mixed mutation/primitive/error owners. Unlike Object.setPrototypeOf,
this operation reads its receiver from `this`, ignores invalid native primitive
P and returns canonical undefined. Its false result still throws a native
TypeError; unknown/unready private inputs still refuse loudly. No objects are
copied and no host import or public admission is added. A distinct fixed scope
prevents one structural algorithm family from certifying another.

This retained normative-optional member is part of the existing Object.prototype
catalog and is a real population prerequisite, not a replacement for the larger
migration. Verification and the next handoff are tracked in
[S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators](6979-s7-delete-host-semantic-implementation.md).

Next owner work remains concrete: `to-object-body.ts` supplies control flow but
not provider authority. Native value/Boolean resources supply primitive payload
unboxing; wrapper storage requires an explicit prototype and has no intrinsic
selection authority; StringCreate separately supplies the own length/virtual
index behavior. The Object/Function catalog currently has no genuine primitive
prototype family owner. Issue real intrinsic singleton/default-prototype
ownership and compose these existing producers; do not bless arbitrary globals,
raw handles or explicit-null test prototypes as ToObject completion. Canonical
undefined and unknown/native-object admission must remain strict at that entry.
Full population and atomic source/public publication, foreign live boundary
identity, Linear/WASI and the existing architecture/retirement/conformance
obligations remain required. Both issues remain in progress.

S7-ag verification is **76/76 plus 63/63 in two separate clean executions**,
zero skips/reported runner errors and exit zero in both: the new 38-case setter,
existing 38-case Object.setPrototypeOf and full 63-case extensibility files.
Seven existing component binaries retain exact parent hashes. The first
76-case run reported all cases passing but exited one with an onTaskUpdate
timeout even while JSON said success; that failure is retained, not hidden.
Expensive test fixtures now yield between the same real audit/emission phases,
with the original case/hook/RPC deadlines and semantic checks intact. This is
not proof of a performance/concurrency cause, nor a single combined 139-case run.

All 33 default-path policy inventories/binaries and six native compiled controls
match retained parent reports; they do not prove IR/source admission. Source
growth is two files/net +62 LOC, with no new allowance or policy/graph changes.
The same four growing dependency directions, strict dynamic-import gaps,
prerequisite and mergeability obligations remain open. Broader/full conformance
and custody runs were not repeated. Exact source/report hashes and remaining
producer acceptance are in the detailed issue and
`plan/audit/6979-native-object-prototype-setter-20261020.json`. The PR remains
draft, both issues stay in progress, and the full migration is not complete.

### S7-ah publication handoff: primitive prototype identity bootstrap, unfinished

The user requested the current work be published in the existing draft PR6762.
The checkpoint adds fixed Boolean/Number/String/Symbol/BigInt identity roles,
pure capsule initializer/getter builders and an authentic dependency-bound
backend owner. It adds no host import, object graph copy, production consumer,
ToObject admission or complete prototype-member population. Its scope is
identity bootstrap only; executable bootstrap and backend owner acceptance
tests are still missing. **11/11 structural builder tests pass**, zero skips;
typecheck and lint pass after correcting a declaration-observation type error.
Prior component/compiler results are not fresh execution of this checkpoint.

The detailed file map and ordered next steps are in
[S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators](6979-s7-delete-host-semantic-implementation.md),
section “S7-ah publication checkpoint and actionable handoff”. First wire an
opt-in genuine native fixture and verify identities/payloads/generation changes
and owner rejection controls; then compose ToObject with genuine unary factories
and strict native input admission. Full population/publication, live foreign
boundary references, Linear/WASI and architecture/custody/conformance/retirement
remain open. The same four dependency directions still fail against main;
architectureComplete=false, and the prerequisite PR6701 remains OPEN/unmerged.
Keep both issues in progress and this incomplete PR draft; no merge readiness
or migration completion is claimed.

### S7-ai: close executable primitive prototype bootstrap evidence

Continue from `28119417bc729d92118cd50e19fde713befc297e`. The opt-in genuine
native component now wires the owner-issued bootstrap and five getters; fixture
defaults remain unchanged. The tests cover native payloads/String descriptors,
stable identities and user mutations, independent realm/Object.prototype
generation changes and missing/stale refusal. Owner controls include genuine
positive completion and copied/foreign/mixed-family/substituted-body/literal/
signature/partial-fill rejection. They do not add public/source admission or
complete member population. The first development run's 16/28 pass result and
12 failures are retained in the detailed issue; current complete regression
verification is pending, not assumed green. No production source changed in
this follow-on checkpoint. ToObject composition and the full migration
acceptance remain required.

S7-ai corrected native verification is terminal: **47/47 pass**, zero skips and
runner exit zero (18 runtime, 18 owner controls, 11 structural checks). Two real
zero-import components execute all seven bootstrap slots, with the real ledger
still unsealed/incomplete. All ten old component hashes/configurations/imports/
reachability rows match retained audits. No production source changed. The
combined earlier run is terminal183/186 pass, exit one, retaining three
subsequently corrected new test-control failures. All139/139 older cases pass,
with complete identities/statuses/error fields equal retained reports; this is
not claimed as a clean186-case run. Detailed failure history, exact hashes,
scope limits and the concrete next ToObject producer contract are in the S7
issue and `plan/audit/6979-native-primitive-prototype-identities-20261020.json`.
The same architecture/strict retirement proof gaps remain; broader conformance,
custody and compiler-control cohorts were not rerun. Both issues stay in
progress and the PR stays draft. Resume with actual ToObject composition,
not another placeholder prototype/member catalog or a narrowed migration goal.

### S7-aj: native ToObject composition through genuine intrinsic identities

The new private kernel composes the existing pure operation with fixed owned
factories, genuine Boolean/Number unboxers, StringCreate, native classification,
native TypeError/tag and the retained primitive-prototype role getters. It
preserves admitted object/payload identity and refuses unknown/stale private
inputs instead of blessing a generic passthrough. No public constructor, host
semantic import or object graph copy is added. Constructor/member population,
source/public admission and the full migration remain unfinished.

The initial executable run passes48/48 runtime cases; three negative-control
assertions need the actual terminal failed-ledger diagnostic rather than
`missing canonical`. Source canonical checks are unchanged. Shared body
preservation passes107/107 in two files. Expanded String slice/rope/surrogate
and selector controls, corrected native verification and full older-suite
preservation runs are active; no complete passing cohort is assumed. Detailed
failed evidence and scope are tracked in
[S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators](6979-s7-delete-host-semantic-implementation.md).
Keep the goal and both issues in progress; the conflict/architecture/retirement,
Linear/WASI, live boundary-reference and conformance obligations remain open.

#### S7-aj published-checkpoint handoff

The expanded pre-correction run is terminal64/68, all50 runtime cases pass;
four negative controls expected the wrong diagnostic after canonical refusal
had already failed the physical ledger. Current controls assert the actual
failed state/refusal without changing production checks. Shared bodies remain
107/107 pass. Corrected native68 and older175-case jobs are still active at
handoff preparation, so neither full passing result nor all12 older binary
witnesses is claimed. See [the exact ToObject audit](../audit/6979-native-to-object-20261020.json)
and the **S7-aj PR checkpoint and actionable handoff** section in
[S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators](6979-s7-delete-host-semantic-implementation.md).

Publish to existing [migration PR](https://github.com/loopdive/js2/pull/6762),
which remains draft/conflicted; prerequisite PR6701 is freshly OPEN/unmerged.
Resume those same jobs first, then implement actual Object.getPrototypeOf and
Object.prototype.valueOf catalog/guarded Call consumers. Full population,
source/public admission, live foreign boundary references (no graph copies),
first-class undefined, both no-host targets and all architecture/retirement/
custody/conformance acceptance remain required. This is a work-so-far handoff,
not migration completion or a merge-ready claim. No GitHub issue/comment.

### S7-ak: real ToObject catalog consumers and closed prior verification

The previously active S7-aj jobs now finish clean: corrected native68/68
(50 runtime +18 owner) and older175/175 across four files, zero skips, both
terminal exit zero. All175 full case identity/status/error records and all12
component binaries match their exact retained populations, with positive floors.
The [native ToObject audit](../audit/6979-native-to-object-20261020.json) records
the original and terminal evidence without erasing earlier failed controls.

Implement actual Object.getPrototypeOf, Object.prototype.valueOf and the
retained __proto__ getter as fixed genuine realm algorithm/guarded Call slots.
All consume the actual ToObject owner; successful mixed prototype status1 is
the only returned prototype result. Keep private native completion distinct
from full realm population/source/public admission and live foreign references.
New helper/catalog verification is separate from the now-proven S7-aj source.
Full migration and both no-host targets remain in scope and unfinished.

The larger new catalog fixture now uses fourteen exactly counted bounded
preparation hooks, retaining every actual fill/audit/emission and old fixture/
case/RPC deadlines; its total setup is split, not claimed to keep the old
single120-second total. Corrected full-file verification runs separately while
the original run and older243-case run are retained. No complete new cohort
result is yet claimed. Typecheck/lint/format of the correction pass.

A fresh named host-import-policy recheck with Node's required exnref feature
passes33/33 compiled probes,437 adapter imports, zero unknown/regime-gap
imports, with regexp4/date1/intl4 selected accelerator imports. Retain the
initial no-feature invocation's validation refusal separately. This default
compiler-route probe suite is not full IR/source-admission or semantic
conformance proof. Runtime.ts10230 lines remains above its8000 target;
resolveImport1371/7 is below its2000-line bar. The arm gate's reductions do
not establish zero arms or field retirement. Full acceptance remains open.

S7-ak intermediate native verification is now terminal47/54,7 failures/zero
skips:38/40 runtime cases pass, with two negative controls incorrectly invoking
another genuine callee through stored transport, plus five owner test-control/
deadline failures. Corrected tests call the intended lifted entry directly for
negative self checks and positively retain legitimate supplied-callee dispatch.
Receipt-valid kernel and guard-error dependency substitutions pass in a separate
live execution, proving independent canonical checks beyond fill receipts.
Compile-time positive authentication and interrupted-fill preparation are
explicit bounded setup, retaining all checks and old case/RPC deadlines.
The full current56-case run is active; older243-case verification is still
active too. No clean full current cohort, full source admission or completed
migration is claimed. Exact revisions/failures are retained in
[the catalog ToObject audit](../audit/6979-native-to-object-catalog-20261020.json).

#### S7-ak verified private catalog checkpoint

The final corrected execution now passes**56/56** (40 runtime +16 owner), zero
skips and exit zero. Separate older preservation passes**243/243** in five
files; full original case/error records and all14 component witnesses match
their retained evidence with positive floors. These are separate runs, not one
299-case run. Earlier9/54,47/54 and54/56 failures remain preserved in
[the exact catalog audit](../audit/6979-native-to-object-catalog-20261020.json).

The three real catalog consumers and six owned algorithm/Call slots are verified
without any production guard change, host semantic import or graph copy. This
remains private native completion, not full realm members/constructors or actual
source/public admission. Publish to the existing draft migration PR with the
**S7-ak verified catalog checkpoint and next producer handoff** in
[S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators](6979-s7-delete-host-semantic-implementation.md).
Next implement genuine mixed Get/Call and remaining catalog/population owners;
do not bless source bodies or foreign refs through layout/count/receipt claims.
All runtime/arm/three-gap, Linear/WASI, architecture/strict-retirement/custody/
conformance/interop and stacked-PR conflict obligations remain open. Both issues
and the full migration stay in progress; no GitHub issue/comment was created.

#### S7-al actual source-body custody, not mixed Call admission

The original prepared source emission now retains independently cloned actual
IR-lowerer definitions before ledger fill and compares the original locals/body
at completion, rather than trusting a fill receipt. Interrupted source fills
remain terminal. A separately issued, rechecked `realm-source-body-custody`
capability binds the genuine full source-unit/realm association and ledger;
it does not certify resolver/ABI/dependency bindings, allocation, mixed Get/Call,
full realm population or public/boundary admission.

Focused verification is **18/18 pass**, zero skips and exit zero, including eight
receipt-valid substituted definitions and four before/after-ledger interruptions.
The original14/16 opaque-matcher failures remain in
[the exact source-body custody audit](../audit/6979-native-source-body-custody-20261020.json).
Five-file source/invocation/getter/realm/mixed preservation now passes**171/171**,
zero skips and exit zero, with positive five-file/171-row and per-file count
checks; session64251 is closed, do not poll or restart it. These are two separate
clean executions, not one189-case run; no before/after byte comparison is claimed.
Signed source checkpoint `38532b0c901b63a45e39b5d1c0703ec89a706c68` is pushed with
normal hooks including18/18 numeric-local tests. The detailed **S7-al verified
source-body custody; mixed Call join remains pending** handoff lives in
[S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators](6979-s7-delete-host-semantic-implementation.md).
Full mixed invocation and remaining catalog/population, live boundary refs,
Linear/WASI, runtime retirement, architecture/closure/conformance and PR conflicts
remain open. Both issues and the full migration remain in progress.

#### S7-am code identity joined to actual native source allocation

Actual native IR allocations now append an immutable per-unit/per-instance code
box after unchanged captures and realm state. Canonical boxed targets come only
from genuine completed source-body custody, with independent initializer/matcher
audit and terminal partial fills. Semantic selection remains in IR, physical
declarations below it; source-subset descriptions cannot issue completion.
The actual String-key function now lives in runtime contracts, and the timer
bridge reads the existing canonical exception policy without importing IR.
Compatibility identities and historically pinned closure-layout bytes remain.

Focused verification is**24/24**, zero skips/exit zero, with real same-ABI/same-shape
source units and runtime code-box/realm identity. Earlier real phase/reference
producer defects (1/22 and4/22, each with6 skipped runtime cases) remain in
[the exact source-code identity audit](../audit/6979-native-source-code-identities-20261020.json).
Preliminary260-case preservation is not final-source certification. Final
nine-file preservation now passes**284/284**, zero skips/exit zero, with exact
file/case/error comparisons to retained evidence and positive population floors.
It is separate from24/24, not one308-case run. Session65692 is closed; do not
poll or restart it. Final source hashes remain unchanged.
The detailed **S7-am source code identities and actual allocation join** handoff
lives in
[S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators](6979-s7-delete-host-semantic-implementation.md).

The runtime→IR dependency pair is removed without waivers; four earlier red
directions and strict-closure retirement failures remain. Code identity does not
certify compatibility-header funcrefs, full allocation/ABI/dependency ownership,
general Call adaptation or public realm completion. Mixed Get/Call, remaining
catalog/constructors/population, live foreign boundary refs, first-class undefined,
Linear/WASI, runtime retirement and all conformance/architecture/merge acceptance
stay in the full active goal. Both issues remain in progress.

#### S7-an original factory-body and physical ABI custody (in progress)

The actual source producer now retains original allocation-owner functions and
slots alongside lifted units. A distinct realm allocation-body scope must
independently verify every genuine factory definition and its actual physical
ABI; lifted-only completion must not imply this stronger scope. Source capture,
ref-cell, code-tail and target-handle resolution comes from the genuine source
owner rather than caller overrides. Raw fill receipts and matching caller
signatures are not authority; missing/interrupted/substituted factories remain
incomplete. Async-frame and non-source dependency custody are not certified.

Implementation and verification are recorded under **S7-an allocation-owner
body and physical ABI custody** in
[S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators](6979-s7-delete-host-semantic-implementation.md).
General mixed Call/Get, semantic argument/receiver/result adaptation, full realm
population/publication, live foreign boundary references without copying,
first-class undefined, Linear/WASI and all existing retirement/architecture/
conformance/PR acceptance remain required. No migration completion is claimed.

The implementation is ready for an **unfinished draft checkpoint**, not a clean
or merge-ready claim. Preserve first35/37 and expanded35/39 focused failures in
[the allocation-custody audit](../audit/6979-native-source-allocation-custody-20261020.json).
The count controls now compare each original factory with its projected sites;
both actual default/mutable compilations use the existing120-second setup hook,
with case deadlines unchanged at35 seconds. Current39-case session20998 and
final11-file preservation54748 remain confirmed live; retain and recheck their
exact handles, alongside earlier live13369. Intermediate59707 is now closed at
37/39, only two inline mutable setup deadlines failing; exact target controls
pass. All earlier failed handles73796/45757/59707 are closed. No current clean cohort
result is claimed. Source/ABI body custody still does not certify non-source
dependency ownership, generic Call, full source/public admission or Linear/WASI.

#### S7-ao work-so-far PR and continuation handoff (2026-10-20)

The latest checkpoint belongs to
[refactor(codegen): separate native semantics from JS host mode](https://github.com/loopdive/js2/pull/6762),
still an unfinished, conflicting draft above the open prerequisite
[refactor(runtime): remove the host-assisted semantic policy](https://github.com/loopdive/js2/pull/6701).
Do not merge this as completed migration. No GitHub issues/comments were filed.

The authoritative IR planner now retains exact owned nested-call sites; the
genuine consumer independently reconciles synchronous primary definitions,
actual callable/global ABIs and scalar initializers instead of trusting ledger
receipts. Generic physical mechanics moved below IR into the real Wasm resource
leaf. Source private expectations are not exposed through returned data.
This is not async/native algorithm completion or full realm/public admission.

All older live handles in the preceding S7-an note are now closed. Focused
cooperative preparation passes39/39 cleanly;357/357 combined assertion records
still have unexplained runner exit1. The newer source cohort has81/81 assertion
records but a real worker RPC timeout/exit1. Broader consumer preservation is
255/259: two ambiguous-SSA async cases and two31-versus43 formatter support
counts remain red. Four selected on/off planning controls reproduce exactly the
same failures; this is not a historical clean baseline. No assertion, floor,
dependency edge, historical pin or deadline was relaxed.

The detailed implementation, retained test failures, exact controls and ordered
continuation instructions are in **S7-ao publication handoff — requested
work-so-far PR** under
[S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators](6979-s7-delete-host-semantic-implementation.md).
Next join the genuine source/code/allocation owners into the real realm
transaction and semantic mixed Call/Get, including live identity-backed foreign
boundary objects without copying. Preserve first-class undefined, Linear/WASI,
full population/publication, runtime/host-arm retirement and every existing
architecture/conformance/merge acceptance obligation. Both issues remain in progress.

Final focused checkpoint verification closes cleanly at **13/13**, two files,
zero skips/exit0, including actual999 execution after removal of only the new
primary-definition audit. The earlier12/13 inlined-fixture control is retained,
not rewritten as a successful wrong-result witness. See
[the exact source/report/gate audit](../audit/6979-native-consumer-primary-custody-20261020.json).
All current handles are closed; broader failures, reporting errors, full migration
and the conflicting/open prerequisite PR stack remain unresolved.

#### S7-ap real consumer demand ownership and formatter source mismatch

The unchanged full async family legitimately keeps the same SSA definition IDs
in its logical plan and runtime representation. The object-demand producer had
merged those namespaces and refused actual realm selection. It now resolves
definitions/provenance per representation while rejecting duplicates across all
states within each representation and retaining the entire occurrence census.
Intermediate focused66/66 is clean; the unfiltered four-file consumer run is
75/77, zero skips/exit1, with both prior ambiguous-SSA acceptance cases passing.
The remaining two31-versus43 formatter errors exactly match earlier records.

An exact old/current source comparison under the same current IR builder proves
31 buffers for the original1618-byte formatter and43 for the current2226-byte
integer-fast-path formatter. The producer still stamps the original hash/length
on the current body. Do not normalize the counts or repin historical evidence;
the next source/version migration must authenticate the actual successor while
preserving old-version custody. Details, exact source hashes and ordered next
steps live in **S7-ap actual consumer async-demand ownership prerequisite** in
[S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators](6979-s7-delete-host-semantic-implementation.md).
This repair is a prerequisite, not full async execution or full realm/source
admission. The genuine public population/initializer join, semantic mixed Call/Get,
live foreign identity-backed boundary, undefined, Linear/WASI, retirement and all
existing acceptance requirements remain in scope. Both issues stay in progress.

The exact-parent removal control now verifies5/8 versus restored66/66 cleanly;
separate realm/startup/Linear preservation is52/52, zero skips/exit0. These are
separate executions, not one combined cohort. All current handles are closed.
[The S7-ap audit](../audit/6979-native-object-demand-scopes-20261020.json) records
source/report hashes, the still-red75/77 consumer run and the concrete formatter
successor work. Preserve both no-host targets and the full migration scope.

#### S7-aq explicit formatter successor and real transported-body verification

The formatter no longer stamps old-source provenance onto the current algorithm.
New preparation selects radix-v2 with its verified2226-byte/hash source; genuine
historical1618-byte radix-v1 remains available and decodable. The default stdlib
factory still returns the unchanged current definition. Incorrect newer bodies
mislabeled as v1 are refused, not silently upgraded. No historical pin changed.

Transported support now independently matches its complete source-derived IR
body, not just a caller digest or refreshed receipts. Only genuine declaration
identities and allocation-ID renaming vary; all arithmetic/control/data fields
and allocation-sharing relations stay exact. A lossless824-cell retained table
passes the unmodified size gate; no allowance was added. Both pinned sources and
their exact bodies are checked by the maintained generator without rewriting data.

Intermediate version/source tests39/39 and table custody19/19 are clean. Removing
only the new body comparison changes19/19 to5/19, with14 corruption refusals lost;
the exact guard is restored. Separate runtime component/resource execution26/26
covers both versions, codec replay, options, independent zero-import instances
and decimal/radix corpora. Five older symbolic-reference source-receipt failures
remain and reproduce under the exact parent test-source control on unchanged
parent-equal files; no repin or clean historical-suite claim. Details and final
stable-revision results belong under **S7-aq explicit formatter source successor
and transported-body custody** in
[S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators](6979-s7-delete-host-semantic-implementation.md).
Full realm population/initializer/source admission, semantic mixed Call/Get and
boundary identity, undefined, Linear/WASI and all earlier retirement/conformance/
architecture acceptance remain required. Both issues and the full goal stay active.

Final S7-aq five-file verification is **108/108, zero skips/exit0**, including
both source-version runtime matrices after lossless-table conversion and exact
guard restoration. The two formatter failures are resolved by verified v2 source
selection; no original pin changed. The five historical symbolic receipt failures
remain separate and unwaived. All current handles are closed. See
[the exact S7-aq audit](../audit/6979-native-radix-source-versions-20261020.json).
The full public realm population/initializer and actual consumer source join are
next, not certified by these formatter/component results. Both issues remain in
progress; keep the open prerequisite/draft PR and every full acceptance obligation.

#### Requested work-so-far PR and implementation handoff, 2026-10-20

Work is published in
[refactor(codegen): separate native semantics from JS host mode](https://github.com/loopdive/js2/pull/6762).
Fresh readback confirms OPEN/draft/CONFLICTING, with the prerequisite still
OPEN/unmerged. Latest implemented checkpoint is `ff212b1bdf`; the S7-ar full
catalog initializer is planned, **not implemented**. No new runtime result is
claimed by this Markdown-only publication. Both issues remain in progress.

Resume from **Publication handoff — work so far, 2026-10-20** and the S7-ar plan in
[S7: delete the host-semantic implementation — one native semantic core, host imports only as capabilities, adapters and named accelerators](6979-s7-delete-host-semantic-implementation.md).
That handoff records the actual next files/owner joins, retained verification and
failures, and the full remaining scope including both no-host targets and live
boundary identity without copying. It does not authorize merging the unfinished
stack or replacing full migration acceptance with a formatter checkpoint.
