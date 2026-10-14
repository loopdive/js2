---
id: 6708
title: "S6: `semanticProviders` defaults to native-first in every environment; host semantics only as named opt-in accelerators"
status: in-progress
assignee: ttraenkler/opus-6708-a
created: 2026-09-27
updated: 2026-10-14
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: refactor
area: compiler, cli, ci, docs
language_feature: compiler-internals
goal: architecture
sprint: current
parent: 5385
depends_on: [6706, 6707]
related: [679, 682, 1535, 4396, 4397, 4401, 6191]
# 2026-10-14 (S6-A): the default flip needs the regime to keep the JS
# environment's platform capabilities — DOM globals + their string/closure
# arguments, and the wall clock (playground default example regressed without
# them); plus the publication-contract call, the CLI/API doc comments. Each
# site grows by a guard line or two; the runtime marshal lives in its own
# module (src/runtime/platform-arg-marshal.ts).
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/extern-declarations.ts
  - src/codegen/declarations.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - src/index.ts
  - src/compiler.ts
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
---

# #6708 — S6: flip the default policy to native-first

Slice S6 of the #5385 "Implementation Plan v2". After S5 (#6191) a build
that *selects* `native-first` already lowers with the native regime plus the
JS value bridge. S6 makes that the default and turns the remaining host
semantics into named, opt-in accelerators. Stakeholder constraints
(2026-09-07): keep `wasm:js-string` strings, host RegExp (and by the same
rule Date/Intl) available as opt-ins, and keep the Web-API/platform layer.

## Evidence bar (must hold BEFORE the flip PR is opened)

1. Two consecutive nightlies with the native-first lane ≥ the host lane on
   the three-lane join (first: 35,384 vs 34,099 on 36305955119; the second
   must include S4 #6186 eval linking and, if #6707 has landed, the regime
   Temporal provider).
2. `scripts/test262-edition-ratchet.ts` over the native-first JSONL: no
   ratcheted edition below its floor (run it with `--results` on the lane's
   JSONL; the floors were banked on the host lane, so this is the per-edition
   guard against a silent ES5/ES2015 regression hiding under a higher total).
3. npm-compat `js-host-native` lane: no package regresses from `measured` to
   an error state versus the `jsHost` lane on the same run (the dashboard
   JSON is CI-owned; read `benchmarks/results/npm-compat.json` after the next
   refresh, do not hand-run the whole generator).
4. Performance: the unmeasured row of the program acceptance. NOTE: the
   sidebar runner passes `--experimental-wasm-custom-descriptors`, which
   Node 22 rejects (`bad option`); it needs Node ≥ 24 (S1's implementer used
   25.9). On a box with only Node 22 this item must run on CI or another
   machine — do not skip it. Run
   `node scripts/generate-playground-benchmark-sidebar.mjs --kernels-only --output=.tmp/host.json`
   and the same with `--semantic-providers=native-first` (S1 already fixed
   the DOM row), plus the npm-compat perf lanes for acorn/cookie/redux/hono,
   and record host vs regime medians in #5385. A regression > 2× on any
   kernel is a blocker to investigate, not a note.

## Change

### A. Default and spellings (`src/target-profile.ts`, `src/cli.ts`, `src/index.ts`)

- `SemanticProviderSelection` becomes `"native-first" | "host-assisted"`;
  `"auto"` is accepted as a deprecated alias of `"native-first"` that prints
  one deprecation warning per process (CLI and API).
- `resolveCompileTargetProfile`: with no selection, `semanticProviders` is
  `"native-first"` for `gc`, `standalone` and `wasi`. `"host-assisted"` is
  the explicit rollback: it restores today's `gc` behaviour exactly
  (`capabilityPolicy: "ambient-js"`, host-assisted providers, `nativeRegime:
  false`). The byte-identity test in `tests/issue-4396-target-profile.test.ts`
  is re-pinned: `{}` ≡ `{ semanticProviders: "native-first" }` and
  `{ semanticProviders: "host-assisted" }` ≡ the pre-S6 default (capture the
  pre-S6 binaries for the three representative programs into the test
  fixtures BEFORE flipping, so the rollback path is proven byte-for-byte).
- `--semantic-providers native-first|host-assisted` in `src/cli.ts`; the
  help text names `host-assisted` as the compatibility profile scheduled for
  removal in S7.

### B. Per-family opt-in accelerators (`src/target-profile.ts`, `src/host-import-policy.ts`)

Add `readonly accelerators: ReadonlySet<"js-string" | "regexp" | "date" | "intl">`
to the profile, populated from a new option `hostAccelerators?: readonly
string[]` (CLI `--host-accelerator <name>`, repeatable). Each family keeps
its native provider as the fallback and is classified `host-accelerator` in
`src/host-import-policy.ts` (`wasm:js-string`/`string_constants` for
`js-string`; `RegExp_*` + `src/runtime/legacy-regexp.ts` for `regexp`;
`Date_*`/`__date_parse_host` for `date`; `Intl` remains host-only and is
the `intl` family). Emission sites key off `profile.accelerators.has(...)`:
strings at `src/codegen/native-strings.ts` / `src/ir/integration.ts`
(`wasm:js-string` import selection) and RegExp at
`src/codegen/context/create-context.ts` `selectNativeRegExpEngine`. An
accelerator is only legal when `environment === "javascript"`; selecting one
for standalone/WASI is a compile error, never a silent no-op.

### C. Lanes and dashboards

- `scripts/run-test262-vitest.sh`, `tests/test262-shared.ts`,
  `scripts/test262-worker.mjs`, `.github/workflows/test262-sharded.yml`: the
  host lane (`TEST262_TARGET=gc`, no provider override) now *is* the regime
  lane; retire the separate `test262-native-first` job and its
  `TEST262_SEMANTIC_PROVIDERS` plumbing only after one nightly where both
  produce the same numbers (keep it for one cycle as the control). Add
  `TEST262_SEMANTIC_PROVIDERS=host-assisted` as the explicit control spelling
  for the retired profile (measurement only, never promoted).
- `scripts/generate-npm-compat-report.mjs`: `js-host` lane = default (now
  regime); `js-host-native` lane becomes the alias and is retired next cycle;
  add `js-host-assisted` as the control.
- README conformance lines and `docs/cli.md`: the JS-environment number is
  the regime number; the wording "JS-host path … supplies host imports for
  some built-ins" goes.

### D. Docs that describe two modes

`CLAUDE.md` "Architecture Principles → Dual-mode" becomes: one native
semantic core; a JS environment adds the value adapter, explicit platform
capabilities and named accelerators; no new feature may depend on a host
semantic import. `docs/architecture/codegen-axes.md` and the per-cell mode
matrix in `docs/architecture/marshaling-contract.md` collapse to one
semantic column with an "accelerator" note.

## Acceptance

- [ ] Evidence bar items 1–4 recorded in #5385 with run ids.
- [ ] `tests/issue-4396-target-profile.test.ts`: `{}` ≡ `native-first`;
      `host-assisted` ≡ pre-S6 default byte-for-byte; `"auto"` warns once.
- [ ] Accelerator opt-ins: `js-string` and `regexp` each have a focused test
      proving the host provider is used only when selected, the native
      provider otherwise, and that selecting one for `standalone`/`wasi` is a
      compile error.
- [ ] `pnpm run check:host-import-policy`: the compatibility control probe
      now spells `host-assisted` explicitly and still reports ≥ 1 legacy
      import (non-vacuity); the default probe reports zero.
- [ ] Nightly after merge: host lane number equals the previous native-first
      lane number ± flake; standalone floor unchanged; edition ratchet green.
- [ ] npm-compat dashboard: no `measured → error` on the js-host lane.

### 2026-10-14 — evidence verdict and S6-A

**Verdict: the evidence bar for the default flip (slice A) is taken as met.**
The bar was written when two CI lanes measured the JS environment — the
host-assisted lane and the `test262-native-first` regime lane. On 2026-10-12
both were retired on main: `test262-native-first` in
`.github/workflows/test262-sharded.yml` carries `if: false`, all 102 shard
runners measure standalone, and the host baseline is frozen by
`scripts/preserve-frozen-host-baseline.mjs`. Items 1–2 can therefore no longer
be re-measured by a nightly; they rest on the last measurements and on an
architectural fact:

| item | verdict | evidence |
| --- | --- | --- |
| 1. regime ≥ host on two nightlies | **met** | 09-27 35,384 vs 34,099; 09-28 36,327 vs 34,099; 10-07 (run 37596924980) **41,816 vs 39,700**; 10-09 regime 42,014 |
| 2. per-edition ratchet on the regime | **met (by the fixing slices + the standalone ratchet)** | the 10-09 run left ES5 −41 / ES2016 −3 / ES2023 −5; all three were owned by #6880 / #6912 / #6881, which merged after that run. The regime arms are `ctx.standalone` ≡ `targetProfile.nativeRegime`, i.e. exactly the code the standalone edition ratchet guards on every merge (42,067 / 48,232 on main today) |
| 3. npm-compat regime-lane parity | **pending, not this slice** | the refresh workflow has failed on every run since 10-06; fixed by loopdive/js2#6664 |
| 4. perf (Node ≥ 24) | **still unmeasured** | carried forward to #5385 program acceptance; not a blocker for A per the lead's 10-14 decision |

**Slice split.** A (this PR, `issue-6708-a-default-native-first`): default
and spellings, lanes, docs, rollback proof. B (#6978, branch
`issue-6978-host-accelerator-opt-ins`): the `js-string`/`regexp`/`date`/`intl`
host accelerators. A keeps its `src/target-profile.ts` edits inside the
selection/default logic; B only adds fields.

#### S6-A implementation notes (2026-10-14)

**Rollback proof (byte identity).** Before any source change, at upstream
main `45f6c9db15`, three programs were compiled under the then-default and
hashed (sha256 of the binary); after the flip the same sources were compiled
with `{ semanticProviders: "host-assisted" }` at the same base:

| program | pre-S6 default | post-S6 `host-assisted` |
| --- | --- | --- |
| `add` (from `tests/issue-4396-target-profile.test.ts`) | `8ef3e1e32716f9b15f995ab46af36870623b7e8b11ccb228d88ae8b6931509fe` | identical |
| strings (template literal + `split`/`join`/`replace`) | `529adf60457bdab34b431b017da8a42ee0a3c3c7f07f6b43e622bcb036ccb0bb` | identical |
| `RegExp` + `Date.parse` + `JSON.stringify` | `94650ebe14d26f5064e00ff69df8cb843b535e7612534e92dec1fa1571b680fb` | identical |

Verdict: the rollback is byte-identical for all three. Cross-check: the
post-flip `{}` hashes equal the pre-flip explicit `native-first` hashes
(`25acec86…`, `23f0d772…`, `64ec6a08…`) — measured before the DOM/clock fixes
below, which do not touch these three programs' import sets. The re-pinned
`tests/issue-4396-target-profile.test.ts` asserts `{}` ≡ `native-first`
byte-for-byte, `host-assisted` ≡ the pre-S6 profile fields with ≥ 1
`legacy-semantic` import, the default with 0, and the once-per-process
`"auto"` warning; no binary fixtures are committed.

**The #4401 publication contract stays an explicit-only opt-in.** An explicit
`semanticProviders: "native-first"` still refuses to publish a module with a
`legacy-semantic`/`unknown` host import; the default does not. A first cut
applied the contract to the default too, and the equivalence suite showed why
that is wrong: user-declared host functions (`declare function
updateCamera(...)` → `env::updateCamera`, classified `unknown`) are explicit
embedder capabilities, not semantic fallbacks, and the default must keep
compiling them. So `{}` and `"native-first"` produce byte-identical binaries
whenever both compile and differ only in that refusal. Nothing the compiler
itself emits needs the gate: `check:host-import-policy` measures the default
probes at 0 legacy / 0 unknown imports.

**Why `"auto"` resolves like an omitted option.** Before S6 `"auto"` meant
"the default", and the standalone test262 lane passes it explicitly. Had it
become an explicit native-first spelling, the standalone lane would have
gained the #4401 contract. So `"auto"` warns once and then is exactly `{}`.

**Equivalence harness.** The regime's JS value boundary lives in the compiled
export adapter (`wrapCompiledExports`), not in raw `instance.exports` — a raw
string result is a Wasm string carrier. `tests/equivalence/helpers.ts` now
reads exports the way an embedder does (adapter for native-first, raw for
host-assisted); before that change 272 equivalence tests "regressed" on
`expected {} to be 'hello world'`.

**Lane identity.** `scripts/test262-lane.mjs` keeps `"auto"` as the default
lane token (spellings `""`, `auto`, `native-first`) and adds
`host-assisted`. The compile option is derived by
`test262CompileSemanticProviders` (default → no option, control →
`"host-assisted"`), so standalone compiles get exactly what they got before.

**Two regime defects the flip exposed (fixed here, found by
`tests/playground-example.test.ts`).** The regime had only ever been measured
by test262, which has no DOM and no wall clock:

1. DOM globals (`document`, …) were dropped under `ctx.standalone` even in a
   JS environment, and their string/closure arguments reached the host as Wasm
   carriers. Fix: `extern-declarations.ts` keeps `global_<DOM name>` when the
   environment is JavaScript; `declarations.ts` exports the native-string
   bridge for such modules; `src/runtime/platform-arg-marshal.ts` converts
   carrier arguments of `extern_class` imports (a no-op for modules without
   the bridge, i.e. every host-assisted module).
   `runtime.ts` grows by exactly two lines (one import, one call; the marshal
   body lives in its own module), so `plan/audit/host-import-policy-baseline.json`
   `maximumRuntimeTsLines` moves 20222 → 20223 (granted here, 2026-10-14).
2. `Date.now()` / `new Date()` returned the epoch (0) under the regime in a JS
   environment. Fix: the epoch fallback now applies only host-free; a JS
   environment uses the `__date_now` clock capability (classified
   `platform-capability`).

**Open — the equivalence gate is RED; this PR must not merge as is.** After
the harness fixes above, `node scripts/equivalence-gate.mjs` reports
`70 failing, 1700 passing, 22 known-failures in baseline` and `50 NEW
equivalence regression(s)` (floor 1700 < 1740). These are defects of the
native regime *in a JavaScript environment* that the test262 measurements
never exercised: custom iterables / `[Symbol.iterator]` in spread and
destructuring ("value is not iterable"), IR-path `Error.message` reads
returning `""`, Map/Set IR capability violations, generator `.return()`
values, `Symbol.toPrimitive` in arithmetic, `await null` interleaving,
`indexOf(undefined)`, `import.meta.url`, five compile failures, and nine
`issue-1197` WAT-shape assertions that pin the host-assisted element
specialisation. The equivalence baseline was NOT touched.

**Decision (lead, 2026-10-14): fix, not pin.** The rows reproduce today with an
explicit `semanticProviders: "native-first"`, so they are fixed on main by
#6980 (iterators/generators), #6981 (IR path + compile failures) and #6982
(toPrimitive/indexOf/await/import.meta); this PR re-merges main once they land.
The one exception: the nine `issue-1197` structure rows pin the host-assisted
element specialisation that S7 deletes, so they are re-pinned to
`semanticProviders: "host-assisted"` (#6979). 41 rows remain. Status stays
`in-progress` until the gate is green.

The original 50 rows (file :: test):

- array-indexof-no-arg :: indexOf / lastIndexOf finds an element that IS undefined; finds the LAST element that is undefined
- await-settled-operand-yields :: `await null` in an async arrow returns to the caller first; sibling async functions interleave like JS
- binding-null-guard :: class method with destructured param — a harness defect: `tests/equivalence/helpers.ts` `buildImports` stubbed env lacked the `__boundary_object_*` hooks and the string bridge (LinkError); it now fills missing imports from the runtime (fixed here, found by opus-6981-ir)
- destructuring-require-object-coercible :: `let {} = 5` is coercible (compile failure)
- element-assignment-externref :: numeric key assignment on any-typed parameter
- generator-return-method :: return() propagates the supplied value
- gradual-typing :: typeof any boolean runtime tag check; typeof any number comparison (compile failures)
- import-meta :: import.meta.url stored in a variable; reflects the loader-injected value
- ir-slice10-error :: (a)(b)(c)(e) were a harness defect — `tests/helpers/compile.ts` never called `setInstance`, so the string bridge memory was unbound (fixed here, found by opus-6981-ir); (d) `new Error().message` is a real regime defect (#6981)
- ir-slice10-map-set :: (d) `new Set().size === 0`; (e) Set add + size + has
- issue-1197 :: nine "structure: WAT contains __vec_i32 …" assertions — re-pinned to host-assisted (#6979)
- issue-1388 :: static async generator method, detached + iterator
- issue-1454 :: plain-array fast path; Map destructure; null/undefined throws; rest element
- issue-2033 :: all eight custom-iterable spread / destructure rows
- issue-6798 :: resolve-stage-catch; string-bool-union; yield-star-return
- iterator-protocol-custom :: generator returned from [Symbol.iterator]() is itself
- symbol-iterator-class :: bracket-access [Symbol.iterator]; object-literal computed key
- symbol-toPrimitive :: comparison operators; arithmetic
- yield-as-expression :: yield in template literal
