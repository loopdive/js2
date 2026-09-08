---
id: 5383
title: "standalone: a real `Temporal` global for `--target standalone` — link the compiled polyfill provider into the standalone lane (baseline 170 / 4,603 Temporal rows pass; 1,506 `Temporal is not defined`, 454 `__temporal_*` host-import leaks); first blocker measured: the polyfill compiles under standalone but emits INVALID Wasm (`WeakMap.get(x)` as an `if` condition leaves an anyref where i32 is required)"
status: in-progress
assignee: ttraenkler/dev-5383
sprint: current
priority: high
horizon: l
goal: standalone
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-07
loc-budget-allow:
  # 2026-09-08 (S2b) — the externref-backed-subclass family fix (own-field
  # write/read + dynamic method dispatch on `class B extends Array`). Every
  # entry is a net-new guarded arm plus the measurement that justifies it; the
  # dispatch machinery itself lives in the new module
  # src/codegen/standalone-subclass-method-install.ts, not in these files.
  #   assignment.ts             +29  the unknown-backing write redirect (R6)
  #   property-access-dispatch  +20  its READ twin (R6)
  #   property-access.ts         +3  the backing-override parameter (R6)
  #   class-bodies.ts            +8  the one call into the new module (R7)
  - src/codegen/expressions/assignment.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/property-access.ts
  - src/codegen/class-bodies.ts
  # 2026-09-07 (S2) — three more codegen fixes, each reduced from the exact
  # statement in the linked polyfill bundle that hit it (see "S2 findings"
  # below for the measurement behind each). Plain-path spelling: the gate's
  # frontmatter reader takes `- <path>` items and stops at the first line that
  # is not one, so a mapping-style entry silently ends the list.
  - src/codegen/index.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/math-value-read.ts
  - src/codegen/builtin-static-plain-alias.ts
  - src/codegen/native-ordinary-instanceof.ts
  # 2026-09-07 (S1) — two codegen fixes that make the compiled
  # @js-temporal/polyfill a VALID, import-free standalone module. Both are
  # net-new arms plus the rationale comments that keep the next reader from
  # re-deriving why the host lane is byte-identical; neither replaces existing
  # lines, so the growth is real and intended.
  - path: src/codegen/coercion-engine.ts
    lines: 40
    reason: "#5383 S1 R1 — the missing `anyref` row in the #1917 ToBoolean cascade (WeakMap/Map `get` used as a condition emitted an anyref where the `if` needs i32 -> invalid Wasm)."
  - path: src/codegen/expressions/calls-optional.ts
    lines: 60
    reason: "#5383 S1 R2 — `recv.m?.(args)` host/native split so the standalone lane uses __objvec_new/__objvec_push/__apply_closure instead of leaking env::__js_array_new/__js_array_push/__call_function/__get_undefined (#2961)."
  # 2026-09-07 (S2) — three more codegen fixes, each reduced from the exact
  # statement in the linked polyfill bundle that hit it. Growth is the fix plus
  # the measurement that justifies it; no lines are replaced.
  - path: src/codegen/index.ts
    lines: 30
    reason: "#5383 S2 R3 — `registerModuleClassStaticAssignments` must admit a minifier's comma-chained `C.a = 1, C.f = function(){}` statement; on a class extending Array the missing value cell made the later call read a non-callable."
  - path: src/codegen/builtin-value-read.ts
    lines: 20
    reason: "#5383 S2 R4 — pre-register the `Math.<fn>` value-read substrate before the closure is built (#2704 forbids a first registration mid-body), which is why every Math value read kept the refusal body."
func-budget-allow:
  # 2026-09-08 (S2b) — both grants are a guarded ARM added to an existing
  # dispatch cascade, in the one place the cascade's order is load-bearing: the
  # write redirect must sit between the externref-backed check and the struct
  # path, and the read twin must sit between the own-field read and the struct
  # ladder. Lifting either into a helper would move the arm away from the
  # ordering constraint its comment exists to document, and would not shrink
  # the cascade — the call would still be a line in the same place.
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/builtin-value-read.ts::ensureStandaloneBuiltinStaticMethodClosure
  - path: src/codegen/builtin-value-read.ts::ensureStandaloneBuiltinStaticMethodClosure
    reason: "#5383 S2 R4 — the 8-line pre-registration hook plus its rationale; splitting a single call out of this dispatcher would hide the ordering constraint it exists to document."
  - path: src/codegen/coercion-engine.ts
    reason: "#5383 S1 — no new functions; allowance restated here so the grant is not stranded in a file this PR does not touch."
  - path: src/codegen/expressions/calls-optional.ts
    reason: "#5383 S1 — no new functions; allowance restated here so the grant is not stranded in a file this PR does not touch."
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

## Implementation notes — S1 (dev-5383, Opus 5 High, 2026-09-07)

**S1 is DONE and S2's structural half is DONE. What remains for S2 is a runtime
defect that has nothing to do with the provider seam — see "Where S2 stops".**

### R1 — the missing `anyref` row in the ToBoolean cascade

`src/codegen/coercion-engine.ts`, `emitToBoolean`. The plan offered two options;
**option (b) is vacuous** and that is worth recording, because it is the obvious
first move: `tryCompileNativeMapMethodCall` (`map-runtime.ts` L1744) returns
`{ kind: "anyref" }` for `get` too — *exactly* what the WeakMap arm returns. The
`map_get_if` row in `red1.mts` was valid only because it binds through a local
(`const t = m.get(k); t && 1`), which coerces on the way in. A bare
`if (m.get(k))` on a native **Map** is the same invalid Wasm, and is now a test.

So the fix is (a): an `anyref`/`eqref` row that does `extern.convert_any` and
calls `__is_truthy` — the same ToBoolean provider the `externref` row already
uses, so the two agree by construction rather than by coincidence. In standalone
that helper is a Wasm-native body (`registry/imports.ts` §7) that classifies the
#2106 tag-0/1 null/undefined singletons, i31, boxed number/bool/bigint and
`$AnyString`; a plain `ref.is_null` test would have made a `get` MISS, `0` and
`""` all truthy.

**Why this cannot perturb existing bytes in either lane:** before the row, an
`anyref` fell through to the i32 no-op tail, leaving an `anyref` where the
consumer requires i32. No module that reaches that tail can validate. So every
byte this changes belonged to a module that did not exist as a valid artifact.
Measured, not argued — see the A/B below.

### R2 — `recv.m?.(args)` leaked four host imports (#2961)

`src/codegen/expressions/calls-optional.ts`, `compileOptionalPropertyValueCall`.
It registered `__js_array_new` / `__js_array_push` / `__call_function` /
`__get_undefined` unconditionally. Attribution was measured, not guessed: a
temporary print at the `addImport` fallthrough in `ensureLateImport` named **one
call site** (the polyfill's `hr`) as the source of the compiled polyfill's entire
`env` import set.

Fixed with the host/native split `tryCompileCallableStaticField` already uses:
native lane takes `__objvec_new` / `__objvec_push` / `__apply_closure` (same
`(callee, thisArg, args) -> result` signature as `__call_function`) and
`canonicalUndefinedExternInstrs` for the short-circuit result. The host lane
keeps its four registrations, in the same order, emitting the same instructions.

The short-circuit value matters and is asserted: `ref.null.extern` surfaces as
JS **null**, so `o.missing?.(1) === undefined` needs the #2106 singleton.

### Measurements

| check | result |
| --- | --- |
| whole linked polyfill, `{target:"standalone", hostBridge:"off"}` | compiles in 60 s, **`WebAssembly.Module` ACCEPTS**, 2,956,918 B |
| its import list | **EMPTY** — no `env`, no `wasm:js-string`, no `string_constants` (S1 step 3: zero #2961 leaks) |
| host (gc) Temporal provider, before vs after | `temporalProviderCacheKey` `372a41be…` and artifact sha256 `baff93a9…` **identical**, 2,090,802 B both sides |
| standalone modules with no WeakMap / no optional-call (arith, classes, Map) | **byte-identical** before/after, on BOTH `standalone` and `gc` |
| the `o.f?.(a,b)` shape | standalone bytes change (that IS the fix); **`gc` bytes identical** |
| `equivalence-gate` | 0 new regressions; **2 baseline failures now PASS** (`fn?.()` on a closure — R2 collateral), baseline ratcheted |

Only ONE compiler defect stood between the polyfill and a valid binary; R2 was
found by the import audit, not by a further `CompileError`.

### Where S2 stops (precisely)

S2's link half is **already satisfied**, and `buildTemporalProvider` proves it
rather than reporting it: it *throws* unless the plan is `separate` with a
`Temporal` **getter** boundary (`src/temporal-provider.ts` L202-215). With
`compileOptions: {target:"standalone", hostBridge:"off"}` it now returns OK in
53 s — namespace `js2wasm:npm:@js-temporal/polyfill:3de2aca05e190a7f`, getter
`__js2wasm_get_Temporal_ba822575`, **`__module_init` exported**, artifact imports
**empty**. A consumer compiled with `compileWithTemporalGlobal(..., standalone)`
imports exactly one namespace — the provider — and nothing else.

**The remaining failure is not in the seam.** `instantiateLinkedProject(result,
{})` throws a WasmGC exception from the provider's `__module_init`, i.e. the
polyfill's own top-level init, *before* any consumer code runs — and it throws
**identically with no linker at all**, from a plain
`compileMulti(polyfill, {standalone, hostBridge:"off", deferTopLevelInit:true})`
whose `__module_init` is called directly (`.tmp/s2c.mts`). So it is a standalone
runtime defect in the polyfill's module init, not a provider-linking defect, and
it is the next slice.

**Naming it is blocked by a second, separate gap worth its own issue:**
`emitExceptionRenderExports` (#2962) does not put `__exn_render_prepare` /
`__exn_render_char` in the export list for an ordinary standalone compile — a
two-line `throw new TypeError("boom")` module exports only `run,__exn_tag`, even
though every documented gate passes (`standalone` ✓, `nativeStrings` ✓,
`exnTagIdx` 0, and the four prerequisites inside the emitter all resolve). Without
them the thrown payload is host-opaque and `renderHarnessThrownText` can only say
"non-stringifiable payload". Until that is fixed, the S2 throw cannot be attributed
to a line of the polyfill.

### Probes (this worktree's `.tmp/`)

`probe3.mts` (whole-polyfill compile + import audit) · `s2.mts` (provider +
host-free consumer link) · `s2b.mts` / `s2c.mts` (provider vs no-linker
`__module_init`) · `s2d.mts` (the render-export gap) · `ab.mts` (small-module
byte A/B) · `host-ab.mts` (host-lane provider key + sha A/B).

## S2 findings (2026-09-07) — three more defects fixed, and where init still stops

Re-ran the S2 probe with #5384's renderer in place (that fix is what made any of
this legible — before it, every one of these read as
`"uncaught Wasm-GC exception (non-stringifiable payload)"`).

Probe: `linkPolyfillSource(setupTemporalPolyfill())` (157,541 B) →
`compileMulti({ "polyfill.js": src }, "polyfill.js", { target: "standalone",
hostBridge: "off", allowJs: true, skipSemanticDiagnostics: true,
deferTopLevelInit: true })` → ~50 s, **2.92 MB, ZERO imports**, instantiates with
`{}` → call `__module_init` → render the payload.

| # | error the probe reported | root cause | fix |
| --- | --- | --- | --- |
| R3 | `TypeError: called value is not a function` | `registerModuleClassStaticAssignments` (`src/codegen/index.ts`) admitted only an expression statement whose WHOLE expression is `=`. A minifier writes `JSBI.__kBitConversionInts = …, JSBI.__clz30 = …, JSBI.__imul = …` as ONE comma statement, so no static value cell was registered. A plain class survives on the host class-object setter; `class JSBI extends Array` has no such singleton, so the write went through `null`. | flatten top-level comma operands before the existing per-assignment admission (admission-only; no order/CF/delete change) |
| R4a | `TypeError: Math.imul is not yet implemented in --target standalone` | `emitMathValueReadBody` READS `__any_from_extern` / `__any_to_f64` / `__box_number` from `funcMap`, and nothing had registered them at that point — a body emitter must not register a native mid-body (#2704). So EVERY `Math.<fn>` value read declined, including #4565's own transcendentals: `[1,4,9].map(Math.sqrt)` still threw. | `prepareMathValueRead` in the value-read switch, before the wrapper/`FunctionContext` is built |
| R4b | same | no inline-kernel bodies: `Math.imul` / `clz32` / `floor` / `ceil` / `trunc` / `abs` / `sqrt` / `fround` have a short direct-call lowering, not a `Math_<name>` provider, so the value read had nothing to point at | `MATH_INLINE_F64_OPS` + the exact §7.1.6/7.1.7 ToInt32/ToUint32 reuse from `ir/backend/wasm-int32-coercion.ts`. `round`/`sign` deliberately excluded — `f64.nearest` rounds ties to even, §21.3.2.28 rounds toward +∞, so an entry would be a WRONG ANSWER, not a miss |
| R5 | `TypeError: Cannot access property on null or undefined at 1:381` (`_(i)`, jsbi's `var _ = Math.floor` in `BigInt(number)`) | two gates: `FIXED_ARITY_PLAIN_ALIAS_STATICS` did not include `Math.*`, and `identifierIsWrittenTo` was a file-wide SPELLING test — a minified bundle binds `_`/`t`/`g` in hundreds of scopes and assigns most of them, so the alias declined everywhere | widen the alias set to `Math.<fn>` names that have a real body (`mathValueReadHasBody`), and make both soundness gates scope-aware via an optional `sameBinding` predicate resolved through `ctx.oracle` (an unresolvable identifier still counts as a write, so it still declines) |

All four are reduced to ≤10-line cases in
`tests/issue-5383-standalone-temporal-provider.test.ts` (S2 R3 / S2 R4), each
asserting the value, plus a negative case (a genuinely reassigned alias still
declines) so the widening cannot silently swallow its own soundness gate.

### Where `__module_init` still stops

`TypeError: Cannot access property on null or undefined at 1:4117` —
jsbi's `static subtract(i,_){const t=i.sign; …}`, i.e. `subtract` is reached
with a **null argument**. Not reproducible in isolation: with the jsbi prefix
alone, `JSBI.subtract(JSBI.BigInt(5), JSBI.BigInt(3))`, `add`, `unaryMinus` and
`a.sign` all answer correctly. Prefix-bisecting the 342 top-level statements for
this exact signature first reaches it at statement **224**
(`function xo(t){ … return e.multiply(e.BigInt(t), c) }`), so the null is
produced by a top-level computation between statements 29 and 224 and only
observed later. Note prefix bisection is no longer sound past statement ~29 on
its own — a truncated prefix legitimately raises `ReferenceError: xo is not
defined` for a binding the full file declares later; the signature filter
(`SIG=1:4117`) is what keeps it usable.

Next step for whoever picks this up: instrument which top-level statement first
stores a null into a module binding that later reaches `JSBI.subtract`, rather
than bisecting further. One suspect worth checking first — measured while
reducing R4 and NOT yet fixed — is that a property write on a `class … extends
Array` instance (`constructor(n, s) { super(n); this.sign = s; }`) throws
`Cannot access property on null or undefined` on this lane; `subtract` reads
exactly `i.sign`.

### Not reached

The S2 smoke test from the plan (`buildTemporalProvider` +
`compileWithTemporalGlobal` + host-free `instantiateLinkedProject`, asserting
`Temporal.PlainDate.from("2024-01-01").day === 1` and
`Temporal.Duration.from({hours:1}).total("minutes") === 60`) is NOT written:
it cannot pass while `__module_init` throws, and a skipped assertion would be
worse than an honest gap.

## S2b findings (2026-09-08) — the externref-backed subclass family, and the new stop

The handover's suspect was right and INCOMPLETE. A property write on a
`class … extends Array` instance does throw — that is R6 below — but fixing it
alone changed nothing at the module level, because a second, larger defect sat
behind it: **a user METHOD on such an instance is unreachable through any
dynamic receiver**, and it fails SILENTLY, answering `null`. That silence is
why `JSBI.subtract` was reached with a null: it is not where the null was made.

Probe used throughout: the jsbi PREFIX of the linked bundle (28,942 B, up to
`l=e.multiply(h,i);`) plus a handful of exported one-liners. It compiles in
**5 s** against the whole file's ~45 s, exercises the same class, and is what
made the iteration loop usable — the whole-file probe was only re-run to
confirm each step.

### R6 — own-field write/read on an externref-backed subclass instance

`class B extends Array { constructor(n, s) { super(n); this.sign = s; } }`
threw `TypeError: Cannot access property on null or undefined` at the write.

Root cause: `compilePropertyAssignment` (`src/codegen/expressions/assignment.ts`)
consults `externrefBackedOwnFieldBacking`, which knows two carriers —
`$Error_struct` and a native `$Object` — and answers `undefined` for every
other parent. On `undefined` the code FELL THROUGH to the struct.set path, and
that path is unreachable-by-design here: the instance is a `$__vec_externref`
and never a `$B`, so `ref.test $B` always misses, the receiver narrows to
`ref.null $B`, and the #2084 null guard throws.

The field only reaches that path because the constructor's own assignment
FLOW-GROWS a `sign` slot onto the vestigial `$B` struct. The identical write
from outside the class (`b.sign = 1`) finds no slot, takes the #4149
`fieldIdx === -1` dynamic-store arm, and has always worked — so the class's own
constructor was the one place the write failed. Fix: route the unknown-backing
case to that SAME dynamic store, plus its read twin in
`property-access-dispatch.ts` (scoped to keys that actually have a flow-grown
slot, so a builtin member like `length` still reaches the array paths).

### R7 — a method is unreachable through a dynamic receiver (the real blocker)

| receiver spelling | `o.d(0)` before | after |
| --- | --- | --- |
| `var x = new B(1); x.d(0)` | 5 | 5 |
| `function f(o) { return o.d(0); } f(b)` | **null** | 5 |
| `new B(1).d(0)` | **null** | null (unchanged, see below) |

A statically-typed receiver compiles to `call $B_d`. Anything the checker
cannot pin — and jsbi's statics take UNANNOTATED parameters
(`static toNumber(i) { … i.__unsignedDigit(0) … }`) — goes out through the
dynamic terminal, which resolves a method by `ref.test`ing instance identity
against each closed struct plus the open `$Object`. The carrier is none of
those. The host lane's answer is `__set_subclass_proto`, a JS host import, so
`emitSetSubclassProto` is a documented NO-OP standalone: nothing on the
instance says "B".

Measured consequence on the jsbi prefix, before the fix:
`JSBI.toNumber(JSBI.BigInt(5))` → `null`, `JSBI.add(5,3)` → `null`,
`JSBI.unaryMinus(x)` → `null`, `x.__copy()` → `null`. After: `5`, `8`,
non-null, non-null. The polyfill's `Ne = xo(ke), xe = e.unaryMinus(Ne),
Le = e.add(e.subtract(xe, l), n)` is one top-level statement; `unaryMinus`
returned null and `subtract` reported it, five frames later.

Two halves, both in the fix:

1. **`standalone-subclass-method-install.ts` (new).** At construction, install
   each declared instance method on the instance as an own data property at §17
   attributes — the same closure singleton, `__defineProperty_value` and flags
   `class-proto-object.ts` (#3976) uses for `C.prototype`. The dynamic
   terminals already consult the carrier's own-property side table (#3537 vec
   bag / #3468 closure bag).
2. **The method trampoline's `this` slot** (`closures/method-trampolines.ts`).
   Installing alone was not enough: the trampoline builds `this` by
   `ref.test`ing `__current_this` against the method's object struct, so the
   carrier failed that test too and every method ran with `this === null`
   (`this[0]` threw, `this.sign` answered null). For a method whose declared
   `this` is `externref` AND whose owner is externref-backed, the carrier is now
   passed straight through. The #2025 absent-receiver TypeError is preserved and
   tested.

**Alternatives measured and rejected** (each would put the methods where the
spec puts them, and each is a dead end today): `Object.setPrototypeOf(inst,
B.prototype)` → the standalone dynamic member path does not consult an explicit
prototype link on a non-`$Object` carrier, so the call still answers `null`;
`inst.__proto__ = B.prototype` → same; leaning on `B.prototype` itself →
`emitStandaloneClassProtoObject` explicitly DECLINES for a builtin-parent class,
so it is still the legacy defaulted struct. The deviation shipped instead is
that the methods are OWN rather than inherited (`hasOwnProperty("d")` answers
`true`); they are non-enumerable, so `Object.keys` / `for-in` are unchanged.

`extends Error` is EXCLUDED by measurement, not by policy: `__defineProperty_value`
does not reach an `$Error_struct`'s `$props` side-slot, so such a class got
5.8 kB of machinery and still answered "called value is not a function".
Deleting that one line is the whole fix once the Error carrier's dynamic member
path reads `$props`.

### Byte A/B (`.tmp/ab-base.txt` vs `.tmp/ab-new2.txt`, sha256, 6 modules × 2 targets)

**gc lane: all six byte-identical** (arith, plain class, `extends Array`,
`extends Error`, object-literal method, Map/WeakMap). Standalone: **only the
`extends Array` module changes**; arith, plain class, object-literal method,
Map/WeakMap and — after the Error exclusion — `extends Error` are byte-identical.

### Where `__module_init` stops NOW

Not in jsbi any more. `TypeError: Cannot access property on null or undefined`
at **4:94864**, which is
`"formatToParts" in ai.prototype || delete DateTimeFormatImpl.prototype.formatToParts`
— `ai` is `Intl.DateTimeFormat`, and standalone deliberately leaves the `Intl`
identifier `ref.null.extern` (#5206: "a compiled shim for it is a separate, much
larger gap"). The polyfill reads that namespace at top level in two places: the
cache `ct = Intl.DateTimeFormat` at 4:10198 and this `.prototype` probe.

An `Intl.<member>` → `undefined` arm was written and **reverted**: it clears the
first read and the second one then throws on `.prototype`, so it moved the
failure without removing it while changing standalone `Intl` semantics. Getting
past this needs one of, in increasing order of honesty:

1. the provider builder strips/stubs the Intl-dependent section of the polyfill
   for standalone (a provider-side decision — the 66 Intl-dependent Temporal
   rows are already out of scope per this issue's own plan);
2. a standalone `Intl` namespace whose members are constructible refusal
   closures carrying a real `.prototype` (the #5206 gap, properly);
3. ICU in Wasm (out of scope, permanently, for this issue).

Recommendation: **(1)**, as the S2 continuation — it is the only one that does
not require deciding the `Intl` shim question to link Temporal.

### Not reached (unchanged from S2)

The S2 smoke test (`buildTemporalProvider` + `compileWithTemporalGlobal` +
host-free `instantiateLinkedProject`) is still NOT written: `__module_init`
still throws, and a skipped assertion is worse than an honest gap. Everything
else in this slice is a test in
`tests/issue-5383-standalone-temporal-provider.test.ts` (S2b R6 / S2b R7,
9 cases, including the non-enumerability of the installed methods, the
untouched element/length surface, an unaffected plain class, and the preserved
absent-receiver TypeError).

## S2c findings (2026-09-08) — the Intl shim; `__module_init` RETURNS; the stop moves to the getter boundary

`__module_init` now **returns** under `--target standalone`, both as a plain
`compileMulti` of the bundle and through `buildTemporalProvider`'s real link
path. The S2 smoke test is still **not** written, and the reason is new and
elsewhere: the `Temporal` object does not survive the linked-provider **getter
boundary** on this lane.

### R8 — the `Intl` refusal shim (`src/temporal-intl-shim.ts`, provider-local)

S2b stopped at `"formatToParts" in ai.prototype`, because standalone leaves the
`Intl` identifier null by decision (#5206). The fix is **lexical and
provider-local**, not a codegen change: `buildTemporalProvider` writes the
synthetic package's `index.js` as `<shim>\n<bundle>` when
`compileOptions.target` is `standalone` or `wasi`, and verbatim otherwise.

The shape is dictated by the polyfill's own EAGER uses, each measured:

| polyfill line (top level) | what the shim must provide |
| --- | --- |
| `ct = Intl.DateTimeFormat`, `const ai = Intl.DateTimeFormat` | a constructor VALUE (`typeof === "function"`) |
| `"formatToParts" in ai.prototype \|\| delete DateTimeFormatImpl.prototype.formatToParts` (and the `formatRangeToParts` twin) | a real `.prototype` carrying both names, so the answer is TRUE and the polyfill does **not** delete its own methods |
| `di.supportedLocalesOf = ai.supportedLocalesOf` | any value; a static is fine (measured: a class static read as a VALUE answers `undefined` on this lane — harmless here, noted below) |
| `const {format,formatToParts} = Intl.DurationFormat?.prototype ?? …` and `Intl.DurationFormat?.prototype && (…)` | `DurationFormat: undefined`, so both short-circuit |
| `Intl.supportedValuesOf?.("timeZone")` (lazy, `hr`) | `supportedValuesOf: undefined` → the polyfill's own fallback, not a throw |

Everything else — the constructor and every method on the prototype — throws a
`RangeError` naming `--target standalone`. `DurationFormat`/`supportedValuesOf`
are deliberately `undefined` rather than throwing bodies: every use of them is
behind `?.` or `typeof … === "function"`, so a body would convert a graceful
degradation (`Duration.prototype.toLocaleString` falls back to the ISO string)
into a throw.

**A module-scoped `const Intl` DOES shadow the builtin on this lane** — measured
first, because the whole design depends on it: with the shim prepended,
`typeof ct === "function"`, `"formatToParts" in ai.prototype` is `true`, and
`new Intl.DateTimeFormat()` throws the shim's RangeError rather than reaching
`tryCompileIntlHostOnlyNew` (#5355). Standalone `Intl` semantics for user code
are unchanged: the binding lives in ONE compilation unit.

The shim text is part of the provider's identity: `temporalProviderCacheKey`
now fingerprints the EFFECTIVE source, so editing the shim re-keys the
standalone artifact and a stale binary cannot be served. **Host lane A/B, run
both ways in this worktree** (`.tmp/gc-ab.mts`, fresh cache per side):
key `372a41be…`, artifact sha256 `acd6ff4d…`, 1,701,105 B — **identical** before
and after.

Whole-bundle measurement with the shim (`--target standalone`,
`hostBridge: "off"`, `deferTopLevelInit: true`): 158,585 B of source (shim
1,043 B + bundle 157,541 B) compiles in **44 s**; through `buildTemporalProvider`
the artifact is **3,167,456 B** with an **empty** import list, and
`__module_init` **RETURNS**.

### Where it stops now — the getter boundary, not the polyfill

Measured two ways, which is what localises it:

| probe | `Object.keys(Temporal).length` |
| --- | --- |
| inside the standalone module itself (`Object.keys(qi)` appended to the bundle, after `__module_init`) | **9** |
| through `compileWithTemporalGlobal` + `instantiateLinkedProject(result, {})`, standalone | **0** |
| the same consumer probe on the host `gc` lane (control) | **9** (`Duration,Instant,Now,PlainDate,…`) |

So the standalone consumer receives an object (`typeof` `"object"`,
`String(...)` `[object Object]`, not null) with no own properties, and
`Temporal.PlainDate` is `undefined` — hence
`TypeError: Cannot read properties of undefined (reading 'from')` for both smoke
assertions. `__module_init` ran (the linker calls it in `wireProviderInstance`)
and the namespace IS populated inside the provider. **This is a standalone
cross-module object-boundary defect and it is the next slice (S2d).**

Two further stops sit BEHIND that one, found by driving the polyfill from
inside its own module (so they are real, not boundary artifacts):

- `Temporal.PlainDate.from("2024-01-01")` → `TypeError: Unsupported dynamic
  regular expression pattern` — the polyfill parses ISO strings with a
  dynamically-built RegExp, which the standalone RegExp backend refuses.
- `Temporal.Duration.from({hours:1}).total("minutes")` and the
  `new Temporal.Duration(…)` spelling → `TypeError: invalid receiver: method
  called with the wrong type of this-object`.
- `new Temporal.PlainDate(2024,1,1)` → `RangeError: invalid calendar identifier`.

Fixing the boundary alone therefore will NOT make the two smoke assertions pass;
S2d needs all three. Recording them now so the next lane does not re-derive them
at 45 s per compile.

### Two small measured facts worth not re-deriving

- **A class STATIC read as a value answers `undefined`** on this lane
  (`ai.supportedLocalesOf` where `ai` is a class with `static
  supportedLocalesOf(){…}`). Harmless for the polyfill (it just copies the
  value onto its own object), but it is not what the spec says.
- **`Temporal.Now.timeZoneId()` answers `null` instead of throwing the shim's
  RangeError.** The polyfill's `Uo()` is
  `(new Intl.DateTimeFormat).resolvedOptions().timeZone`, and an isolated
  reduction of that exact spelling — a `new`-expression chain whose result is
  discarded by the caller — also swallowed the constructor's throw. The
  direct spellings (`new Intl.DateTimeFormat()`, `const f = new …; f.m()`,
  via an alias, with arguments) all throw correctly and are tests. The
  swallowing shape is NOT fixed here; it is filed with the S2d work above,
  and it is why the smoke test's "`Now.timeZoneId()` throws" assertion is not
  written either.

### Tests

`tests/issue-5383-standalone-temporal-provider.test.ts` gains six S2c cases:
the eager-use bitmask (all five shapes in one module), the lazy RangeError with
its `--target standalone` text, a prototype-method refusal, the `gc` cache key
recomputed from the raw bundle (the host-lane no-change guard), standalone/wasi
keys distinct from `gc`, and the shim's own shape (one `const Intl`, prefixed
binding).
