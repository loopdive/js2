---
id: 6708
title: "S6: `semanticProviders` defaults to native-first in every environment; host semantics only as named opt-in accelerators"
status: done
completed: 2026-10-18
assignee: ttraenkler/codex
created: 2026-09-27
updated: 2026-10-18
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
- [x] `tests/issue-4396-target-profile.test.ts`: `{}` ≡ `native-first`;
      `host-assisted` ≡ pre-S6 default byte-for-byte; `"auto"` warns once.
- [x] Accelerator opt-ins: `js-string` and `regexp` each have a focused test
      proving the host provider is used only when selected, the native
      provider otherwise, and that selecting one for `standalone`/`wasi` is a
      compile error.
- [x] `pnpm run check:host-import-policy`: the compatibility control probe
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
   `maximumRuntimeTsLines` moves 20222 → 20223 (granted here, 2026-10-14); after merging main with #6978 (20225) the measured ceiling is 20227 (2026-10-15).
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

**2026-10-15 — after merging upstream/main (#6978 accelerators, #6983).**
`node scripts/equivalence-gate.mjs` on merge `823403f532`: `56 failing, 1714
passing, 22 known-failures in baseline` / `FLOOR: 1714 passing tests <
committed passingFloor 1740 (26 fewer)` / `36 NEW equivalence regression(s)`.
The 36 = the 41 above minus the five harness rows (ir-slice10-error a/b/c/e,
binding-null-guard). Every one is owned by a fix PR that has not merged yet
(the row → PR assignment is mine, by symptom; owners may re-home a row):

| fix | PR | rows |
| --- | --- | --- |
| #6980 iterators/generators | 6678 | issue-1454 ×4, issue-2033 ×8, iterator-protocol-custom, symbol-iterator-class ×2, generator-return-method, issue-1388 |
| #6981 IR path + compile failures | 6673 | ir-slice10-error (d), ir-slice10-map-set ×2, destructuring-require-object-coercible, gradual-typing ×2, yield-as-expression, issue-6798 resolve-stage-catch |
| #6982 toPrimitive/indexOf/await/import.meta | 6676 | symbol-toPrimitive ×2, array-indexof-no-arg ×2, await-settled-operand-yields ×2, import-meta ×2, element-assignment-externref, issue-6798 string-bool-union |
| #6984 yield* return value | 6683 | issue-6798 yield-star-return |

**2026-10-16 — final state (S6-A done).** #6980, #6981, #6982, #6984 and
#6986 are on main and merged into this branch (merge `1d20eeee45`; the
runtime.ts conflict resolved like the S7-a branch: an Intl-accelerated import
takes the #6986 marshal, every other import the #6708 platform marshal).
`node scripts/equivalence-gate.mjs`: `equivalence-gate: 20 failing, 1787
passing, 22 known-failures in baseline.` / `✓ No new equivalence regressions.`
(passing 1787 ≥ floor 1740; the nine `issue-1197` rows stay pinned to
host-assisted, #6979). `pnpm run check:host-import-policy`: default probes 33
probes / 452 imports / 0 legacy / 0 unknown; host-assisted control 23 legacy;
`runtimeTsLines` 20240 under main's ceiling 20243. Focused suites on the
merged tree: 4396 18/18, 6686 5/5, 6978 9/9, 6986 17/17, playground 1/1,
4401 7/7, 4397 29/30 (the known `assignmentRest` row, red on main too).
Evidence item 3 (npm-compat parity, #6664) remains open in #5385. Item 4
(performance) is now met by #7087's 2026-10-18 evidence in #5385; the
accelerators are #6978 (done).

### 2026-10-18 — current-main landing refresh and handoff

PR [#6672](https://github.com/loopdive/js2/pull/6672) was refreshed from its
stale 2026-10-16 head onto `upstream/main` `1990d67b28` (merge
`338d62e16b`), then through the baseline-only main tip `5495eb6102` (merge
`430b2254fa`), and finally through the npm-compat refresh tip `50a1734711`
(merge `7ea774fd6c`). The original S6 implementation is unchanged: omitted
`semanticProviders` selects native-first, `host-assisted` is the named
compatibility profile, and JS values/objects still cross through the boundary
adapter rather than becoming host-backed core representations.

The refresh exposed implicit uses of the old default in tests and quality
ledgers added after the S6 branch was cut. They now name their intended lane:

- legacy closure/constructor bridge suites (#1116b, #1528, #1712, #2623,
  #2637 B2, #3520, #6419 and the #6651 D4 host-constructor control)
  compile with `semanticProviders: "host-assisted"`; #2637 B2 specifically
  asserts the JS-synthesized Promise-subclass registration path, so S7 must
  delete or replace that implementation-specific guard when the path goes;
- the test262 worker extraction test receives the production
  `test262CompileSemanticProviders` free variable instead of accidentally
  capturing no provider selection;
- `check-ir-fallbacks` and the `check-ir-only` `single-host` lane explicitly
  use `host-assisted`, matching their existing `jsHostExterns: true` planning
  contract; the native/standalone lanes remain native;
- the #6995/#6996 async reference lanes and #7002/#7003 host-IR controls added
  on main explicitly use `host-assisted`. The rest of the equivalence corpus
  continues to exercise the new native-first default.

No semantic-equivalence or host-import baseline was widened. Exact-main
control at `1990d67b28` also reproduced the two unrelated focused reds seen
during the refresh: #4397 object-rest
`CopyDataProperties` traps with `illegal cast`, and #5383's named static
method call on a dynamic class-value receiver returns `-1` instead of `8`.
They are not S6 regressions. The #5383 Temporal smoke child also needs Node's
exnref support enabled when run under local Node 24.

Validation on the refreshed tree:

- `pnpm run typecheck` — pass;
- `node --experimental-wasm-exnref --import tsx scripts/check-host-import-policy.ts`
  — 33 native-first probes / 452 imports / **0 legacy / 0 unknown**;
  host-assisted control remains non-vacuous at 23 legacy imports;
- `node --experimental-wasm-exnref --import tsx scripts/check-ir-fallbacks.ts`
  — pass, no unintended, post-claim or module-level increases;
- `node --experimental-wasm-exnref --import tsx scripts/check-ir-only.ts`
  — READY in both lanes (38 emitted, 3 non-executable, 0 unsupported or
  invariants per lane);
- focused provider/bridge/Temporal/Intl suites — 138 passed, 2 skipped;
- refreshed #6995/#6996/#7002/#7003 controls — 92 passed;
- Node 25.9.0 `node scripts/equivalence-gate.mjs` — 2,020 passing, 20
  baseline-known failures, 2 baseline rows newly fixed, **0 new
  regressions** (floor 1,740). The baseline was deliberately not ratcheted in
  this refactor.

The required `quality` job then made one intentional cost of the default flip
visible: the deterministic #3437 harness compile-work probe measures the
default profile, so its shared-`forEachChild` count moved from the committed
142,936 to 260,711 on a cold native-first compile. The unit guard also exposed
that 28,760 of those walks are one-time provider initialization, not per-file
harness work. The production probe and its test now warm that initialization
outside the meter, matching the thousands-of-files-per-worker test262 path.
On the same tree, the steady explicit host-assisted control measures 158,639
and explicit native-first measures 231,951, confirming that the remaining
increase is the selected provider family rather than a de-memoized scan or
runner variance. The #3437 contract allows an explicit rebank for a justified
default-path change, so `scripts/harness-compile-budget.json` was refreshed
with its documented `--update` flow to 231,951 (15% margin). This is a
compile-work ratchet update, not a semantic waiver; future per-file growth
still fails against the native-first default that users and test262 now
exercise.

The next required `quality` ratchet was also default-sensitive. The fixed
#1918 playground corpus reproduces its old baseline exactly under explicit
host-assisted (`drop-excess=0`, `default-value-lossy=43`,
`call-arg-coerce=1`) and reports the already-existing native-provider floor
under explicit native-first (`11`, `57`, `1248` respectively; every other
bucket remains zero). S6 did not add those repairs; it made the lane that
already contained them the omitted-option lane. The baseline was refreshed
with `check:stack-balance -- --update` so CI now rejects growth from the
native-first floor instead of comparing two different provider families.
This is recorded as inherited emitter debt in #1918 Phase 2, not described as
clean codegen or erased by the equivalence result.

The #1524 host-import/strict-mode gate also contained one deliberate
non-WASI JS-host control that asserted `JSON_stringify` was imported while
calling `compile(src)` with no provider selection. That assertion described
the old default rather than strict-mode policy. It now selects
`semanticProviders: "host-assisted"` explicitly; the adjacent omitted-option
and strict-mode checks continue to prove native JSON lowering. S7 should
remove this compatibility-only import assertion when it deletes the
host-assisted provider, not weaken the native/strict checks to preserve it.

The 2026-10-18 npm-compat refresh on main made the last S6 product-bar row
directly auditable: Lit was still `measured` under host-assisted but the stale
`jsHostNative` record was `runtime-error`. The exact S6 head was therefore
remeasured instead of accepting the aggregate at face value. All eleven
currently host-measured workloads are `measured` under the new default at O4,
with matching expected/actual checksums: acorn 422/422, clsx 7/7, cookie 1/1,
hono 9/9, Lit 7/7, marked 75/75, Moment 10/10, Prettier 49/49, React 8/8,
Redux 7/7 and UUID 2/2. Moment used the keyed QuickJS pair built and
canary-verified by `scripts/build-quickjs-eval-provider.mjs`; the other ten
ran without a linked eval provider. Focused fragments were written outside
the repository and no dashboard artifact was hand-edited. The post-merge CI
refresh remains the publication proof required before S7 opens.

Landing handoff: merge #6672, then observe the post-merge native-first lane
and npm-compat refresh already required by the acceptance list. S7 deletion
remains #6979; it must remove host semantics without weakening the boundary
object/value adapter or the named accelerator contract.
