---
id: 5383
title: "standalone: a real `Temporal` global for `--target standalone` — link the compiled polyfill provider into the standalone lane (baseline 170 / 4,603 Temporal rows pass; 1,506 `Temporal is not defined`, 454 `__temporal_*` host-import leaks); first blocker measured: the polyfill compiles under standalone but emits INVALID Wasm (`WeakMap.get(x)` as an `if` condition leaves an anyref where i32 is required)"
status: ready
sprint: current
priority: high
horizon: l
goal: standalone
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-07
---

# #5383 — `Temporal` in standalone mode

## Problem

Every Temporal PR to date (#4628, #5248, #5353, #5364, #5373, #5374, #5376,
#5377, #5378, #5380, #5381) targets the JS-host lane: the compiled
`@js-temporal/polyfill` is linked as a provider built with `--target gc` plus
the JS host adapter. **The standalone target has no `Temporal` at all.** The
project owner's direction (2026-09-07) is standalone only.

Standalone baseline (`test262-standalone-current.jsonl`, 2026-09-07, sha
d4258c82), `built-ins/Temporal/**`:

| status | rows |
| --- | --- |
| pass | 170 |
| fail | 3,979 |
| compile_error | 454 |
| **total** | **4,603** |

Top reasons: `ReferenceError: Temporal is not defined` 1,506;
`standalone target emitted host imports: env::__temporal_plain_date_from_string_field`
and siblings 454 (the #661 compile-time lowering in
`src/codegen/temporal-native.ts` still emits host imports under standalone);
`called value is not a function` 361; `Cannot read properties of undefined
(reading 'since'|'until'|'toString')` 460.

### What is NOT a blocker (measured, do not re-derive)

- **The "deferred export is unavailable for WASI" note is about `--target wasi`,
  not `standalone`.** `src/package-linker.ts` L1882 already compiles every
  provider with `deferTopLevelInit: true`, and standalone honours it: a
  top-level-statement module compiled with `{ target: "standalone",
  deferTopLevelInit: true }` exports `__module_init` (probe
  `.tmp/sa-temporal/red2.mts`, 2026-09-07). The linker's
  `hasTopLevelStatements && !initExport` fallback will not fire for standalone.
- **`Intl` and `BigInt` references compile under standalone with zero `env`
  imports** (same probe: `new Intl.DateTimeFormat(...)`, `typeof Intl`,
  `BigInt(3)` all valid, `env` import set empty). Only **66 of 4,603** Temporal
  rows reference `Intl.` or `toLocaleString`, and 0 use a non-ISO calendar
  literal; those 66 stay out of scope.
- The polyfill's own host-only surface is small: `Intl.DateTimeFormat` ×14
  (calendar helpers, non-ISO only), `Intl.DurationFormat` ×9
  (`toLocaleString`), `Intl.supportedValuesOf` ×1, `WeakMap` ×2, `Reflect.ownKeys` ×1.

### The first real blocker (measured)

`compileMulti({ "polyfill.js": <jsbi+polyfill linked source> }, …, { target:
"standalone", hostBridge: "off", allowJs: true })` **succeeds in 58 s with zero
errors** and emits a binary that `WebAssembly.Module` rejects:

```
Compiling function #225:"OneObjectCache_setObject" failed:
if[0] expected type i32, found call of type anyref @+812257
```

Reduced to two lines (`.tmp/sa-temporal/red1.mts`, standalone, `hostBridge: "off"`):

| source | result |
| --- | --- |
| `class C { setObject(e){ if (C.objectMap.get(e)) throw …; C.objectMap.set(e,this);} } C.objectMap = new WeakMap();` | **INVALID** — `C_setObject`: if[0] expected i32, found anyref |
| `const m = new WeakMap(); … m.get(o) ? "hit" : "miss"` | **INVALID** — `__module_init`: same |
| the same with `Map` (`this.map.get(e)`, `t && 1`) | valid |

Root cause site: `tryCompileNativeWeakMethodCall`
(`src/codegen/weak-collections-runtime.ts` ~L191-197) returns
`{ kind: "anyref" }` for `get`, and the condition path
`ensureI32Condition` → `emitToBoolean` (`src/codegen/index.ts` L14950,
`#1917` cascade) has no row that turns a bare `anyref` into i32 — the Map
path returns a type the cascade does handle. Through `buildTemporalProvider`
with `compileOptions: { target: "standalone", hostBridge: "off" }` the linker
reports exactly this as `plan=bundled, reason=@js-temporal/polyfill provider
emitted invalid Wasm: … OneObjectCache_setObject …` after 113 s
(`.tmp/sa-temporal/probe2.mts`).

## Implementation Plan (Fable, 2026-09-07)

Slices land as separate PRs in this order. Each is measured, never assumed.

**S1 — the polyfill validates under standalone.**
1. Fix the reduction: `emitToBoolean` must accept `anyref` (route through the
   existing `__is_truthy` / `__any_unbox_bool` helper arm the cascade already
   has for `any`-typed values, or have the WeakMap `get` arm return the same
   ValType Map's `get` returns — pick whichever keeps Map and WeakMap
   byte-identical for the untouched shapes; state which). Add the two-line
   reduction to `tests/issue-5383-standalone-temporal-provider.test.ts`
   (standalone, `new WebAssembly.Module` must validate; run the module and
   assert `"hit"` / the RangeError message).
2. Re-run `.tmp/sa-temporal/probe3.mts` (copy it into your worktree's `.tmp/`).
   The polyfill is 157 KB of dense source; expect MORE invalid-Wasm defects
   behind this one. Iterate: for each `CompileError`, reduce to ≤10 lines the
   same way, fix, add the reduction to the test file. Stop when
   `WebAssembly.Module` validates. Record every reduction + function name in
   the PR. Budget: if a defect needs more than ~150 lines of compiler change,
   file it separately with the reduction and continue on the others.
3. Audit the validated binary's imports (`WebAssembly.Module.imports`): the
   standalone provider must import nothing outside `wasm:js-string` /
   `string_constants*` / declared `link:` targets — any `env.*` import is a
   #2961 leak and must be closed (native lowering) or reported with its
   count.

**S2 — the provider links separately under standalone.**
`buildTemporalProvider({ …, compileOptions: { target: "standalone", hostBridge:
"off" } })` must return `plan=separate` with a `Temporal` getter boundary and a
`__module_init` export. Fix whatever `fallbackReason` the linker gives next.
Then instantiate consumer + provider host-free (`instantiateLinkedProject`, no
JS host adapter — mirror how `scripts/test262-worker.mjs` instantiates
standalone modules) and assert `Temporal.PlainDate.from("2024-01-01").day ===
1` and `Temporal.Duration.from({hours: 1}).total("minutes") === 60`. This is
the smoke test for the slice.

**S3 — runner + CI wiring (after S2).**
- `tests/test262-shared.ts` / `scripts/test262-temporal.mjs`: the needs-Temporal
  gate is host-only; open it for `target === "standalone"` when a
  standalone-keyed prewarm stamp exists (`temporalProviderCacheKey` already
  fingerprints `target`; the stamp must carry the key of the artifact the lane
  will ask for — one stamp per target).
- `scripts/prewarm-temporal-provider.mjs`: build both artifacts (or take
  `--target`); `scripts/test262-worker.mjs` L1158-1180: drop the host-only
  refusal, keep the no-cold-build rule; the #2961 host-import guard must not
  count the provider's string-namespace imports as leaks.
- `.github/workflows/test262-sharded.yml` `temporal-provider` job: currently
  gated on `run_host`; add the standalone artifact under `run_standalone`.
- FAIL SOFT stays: a missing/invalid standalone artifact leaves rows unlinked.

**S4 — retire the #661 lowering under standalone (after S3).** With a
provider linked, `src/codegen/temporal-native.ts` must not emit `__temporal_*`
host imports (454 compile_errors today): gate the lowering off when a
`Temporal` binding is linked (or off under standalone entirely — measure which
loses nothing).

**S5 — measure.** Per row, base vs fix, standalone lane, driver
`.tmp/bucket-run.mts` (copies in `agent-ad1118902ba570f58/.tmp` and
`agent-a5a33516fa53a63fe/.tmp`), fresh `JS2WASM_TEMPORAL_CACHE` per side:
the 123-row family (`family-123.txt`) and
`built-ins/Temporal/ZonedDateTime/prototype/**` (≤400 rows), then a bounded
`built-ins/Temporal/PlainDate/**` sample. 0 pass→fail against the standalone
high-water (#2097). Never the full bucket. Report Intl-dependent rows (66)
separately; they are expected to stay red.

**Order-preservation constraints.** The host lane is untouched: no change to
`--target gc` provider bytes (compare `temporalProviderCacheKey` and the host
artifact sha before/after S1). `Map`/`WeakMap` lowering in the JS-host lane is
byte-identical. Standalone modules that never mention `Temporal` compile
byte-identically (S4's gate must be keyed on the binding, not on the target
alone, unless measured as neutral).

## Acceptance criteria

1. S1: the linked polyfill source compiles under `--target standalone` to a
   binary `WebAssembly.Module` accepts; each reduction is a test.
2. S2: `buildTemporalProvider` with `target: "standalone"` returns
   `plan=separate`; the host-free smoke test passes.
3. S3–S4: standalone Temporal rows link the provider in both runners and CI;
   `__temporal_*` leaks are 0.
4. S5: samples measured, 0 pass→fail, counts with artifacts; the standalone
   Temporal bucket moves from 170 pass.

## Notes

- Predecessors: #4628 (provider, host lane; "Standalone scope — OUT"), #5353
  (sharded host lane), #2041 (standalone Temporal null-deref bucket, the
  pre-provider era), #2860 (standalone gap umbrella), #2162 (native
  WeakMap/WeakSet), #1917 (ToBoolean cascade), #2961 (host-import leak guard).
- Id reserved via `claim-issue --allocate --allow-unscanned` (PR scan degraded,
  no `gh`); open PRs hand-checked 2026-09-07 — highest in-flight issue file is
  #5381; fork PRs #5715-#5717 are #3518/#3527 slices.
- Probes: `/home/user/js2/.tmp/sa-temporal/{probe2,probe3,red1,red2}.mts`,
  `polyfill.mjs` (linked source), `polyfill-sa.wasm` (the invalid binary).
