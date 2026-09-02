## 2026-09-02 Family 3 census — callables, closures, callbacks (where family 3 stands)

Grounded on `origin/main` `33ea8606aa` (`079332e3` on top is one `[skip ci]`
baseline-refresh commit; `src/` and the #3526/#3521 plan files are
byte-identical). Three census probes ran against that commit —
**boundary-surface** (grep/read), **ungoverned-dispatch** (mode-read ranking),
**lane-measurement** (14-shape corpus × 4 lanes, compiled) — under
`.tmp/r6-f3-census/{boundary-surface,ungoverned-dispatch,lane-measurement}/`
(each has an index/summary file). Every line number below was re-read on
`33ea8606aa`; every count names its artifact. Family 3 is the issue's
"Callable/closures/callbacks: direct/indirect calls, bound functions, host
callbacks, closure environments, constructor/callable ABI" (`:998-999`).

### Where family 3 stands (census summary)

- **Zero callable entries in the R6 vocabulary today, bar one record**: no
  callable `IntrinsicId` (`src/ir/intrinsics.ts:95-103` — numeric / number /
  boolean / extern / math only; `boundary-surface/02-intrinsics-id-vocab.txt`),
  **0 of 10** `RuntimeManifestPolicy` fields are callable
  (`src/ir/runtime-manifest.ts:360-413`, frozen twin `:416-427`, freeze
  literal `:1956-1967`; `ungoverned-dispatch/manifest-freeze.grep`), and
  exactly **one** callback-adjacent capability record of 16 func ids:
  `async.callback.wrap` → `env.__make_callback (i32, externref) -> externref`
  with `exceptionPolicy: "module-tag-payload"`
  (`src/ir/runtime-host-capabilities.ts:52-69`, row `:375`, policy `:239-240`,
  field `:253`), cited only by the async projection `host.promise.react`
  (`src/ir/async-runtime-providers.ts:240-245`).
- **Unlike F1/F2, there is no single un-governed resolve table to migrate.**
  Family 2's mode reads sat in one post-freeze table
  (`resolveAndObserveCallableProvider`); family 3's sit in FOUR layers, three of
  them BEFORE `freeze()` (`runtime-manifest.ts:2039`, sole caller
  `intrinsic-support.ts:761`, reached from `prepareBuiltFnRuntimeManifest`
  `integration.ts:1217` at `:4176-4177` — after Phase-1 build, before
  `preregisterCallableProviders` `:4292` and Phase-3 lowering `:4491`):
  1. **Pre-freeze binding-kind decisions in the from-ast resolver**
     (`makeFromAstResolver`, 18 functional mode reads;
     `ungoverned-dispatch/mode-reads-by-function.txt`):
     `functionPrototypeCallTarget` (`integration.ts:6124-6129`: `null` unless
     `standalone && !wasi`, else `irRuntimeFuncRef("__function_prototype_call")`,
     helper `src/codegen/function-prototype-callable.ts:17-19`; consumer
     `from-ast.ts:7553`), `hostIndirectEvalTarget` (`:6046-6051`; consumer
     `from-ast.ts:6395`).
  2. **Pre-freeze selection gates**: host-callback arrows are claimed only
     when `jsHostExterns || supportsStandaloneDomInteraction`
     (`src/ir/calendar-selection-support.ts:27-36`); legacy callers demote a
     claimed unit exactly when `jsHostExterns !== true`
     (`src/ir/legacy-caller-policy.ts:35-44`).
  3. **Pre-freeze program-ABI planning (R1/R2 territory)**: constructor
     identity `hiddenIdentity = !ctx.wasi`
     (`src/codegen/program-abi-fnctor-producer.ts:134`), foreign return
     `standalone || wasi || resultIsExternref` (`:80`,
     `src/ir/fnctor-abi.ts:67`), IR fnctor admission only on
     standalone+nativeStrings+!wasi+!fast+native-first
     (`src/codegen/ir-fnctor-admission.ts:49-53`).
  4. **Post-freeze name-keyed resolution** — the family-3 analog of F2's
     un-governed dispatch: `makeResolver.resolveFunc` (`integration.ts:7032-7068`)
     routes `unit`/`support`/`import`/`runtime|intrinsic` bindings by kind and
     then falls through to `ctx.funcMap.get(adapterName)` (`:7057`) /
     `nativeStrHelperHandle` (`:7066`); `resolveAndObserveCallableProvider`
     (`:6603`) ends in the same name lookup (`:6912`). Which function a NAME
     denotes depends on which lane registered it. `callResultAdapter`
     (`:7070-7080`) reads raw `ctx.nativeStrings`. All 29
     `resolver.resolveFunc(` sites in `lower.ts` funnel here; `lower.ts` itself
     has **0** functional mode reads (`ungoverned-dispatch/lower-callable.txt`,
     `fan-in.txt`).
- **The callback crossing is a bundle, not an import.** Each host callback is
  (a) a maker **import** (`env.__make_callback`, registered by the legacy
  pre-pass `src/codegen/declarations/import-collector.ts:2005-2011`, siblings
  `__make_getter_callback` `:2012-2016` and `__make_callback_ctor`
  `src/codegen/callback-ctor-bridge.ts:52-62`; runtime dispatch on sentinel
  `-2` one-shot / `-1` reusable `src/runtime.ts:17660-17661`), (b) host-facing
  dispatch **exports** resolved by name — `__call_fn_0..4`
  (`src/codegen/index.ts:6038-6056`, `src/codegen/closure-exports.ts:369-372`,
  name `:774`), `__closure_arity` (`:111`) — and (c) closure **types**: header
  `func funcref / $arity i32 / $bag externref` + captures
  (`src/ir/closure-struct-registry.ts:121-125`), the DOM-authority branded
  subtype (`:183-184`), `IrClosureLowering` / `IrFnctorLowering.reservedLayout`
  (`src/ir/backend/handles.ts:127`, `:156-161`), and the `callable<S>`
  externref carrier (`src/ir/nodes.ts:389`). The frozen record schema spells
  only (a) — see "Deferred by design".
- **IR emission is lane-free at the instruction level, lane-bound at one
  site.** `closure.new` (`nodes.ts:1368-1381`, lowered `lower.ts:2349`),
  `closure.call` (`nodes.ts:1419-1423`, lowered `:2390`, wrapper ROOT rationale
  `:2401-2406`) and `call` carry no provider field; the intrinsic arm throws
  on a missing frozen provider (`lower.ts:407-412`). The four surviving `??`
  provider fallbacks in `lower.ts` are all `extern.*`
  (`:3522, :3529, :3537, :3544` — family 6;
  `boundary-surface/22-lower-nullish.txt`). The ONE from-ast lane branch on this
  surface is the host-callback maker: `from-ast.ts:8303-8317` pushes the packed
  closure directly on the exact standalone-DOM path, else emits a plain `call`
  on `irImportFuncRef("env","__make_callback")` with an `i32.const -2` sentinel
  — a spelling and an ABI fact the `async.callback.wrap` record already states,
  and which `hasExactHostVoidCallbackMakerImport`
  (`src/codegen/ir-overlay-finalize.ts:270-275`) re-derives by hand from
  `ctx.funcMap`. Closure-environment shape is chosen at plan time:
  `plan.standaloneDomReusable ? domCallbackAuthority : hostOneShot`
  (`from-ast.ts:14486-14496`, plan flag `src/codegen/index.ts:3380`, gate
  `:2885-2888`; reserve-time re-read
  `src/codegen/standalone-dom-callback-authority.ts:99-104`).
- **Backends**: the closure family lowers on WasmGC only
  (`src/ir/backend/wasmgc-emitter.ts:371-375` pushes the DOM authority brand
  global before `struct.new`); linear (`linear-emitter.ts:485-488`) and
  bytecode (`bytecode-emitter.ts:749-752`) are not-implemented for
  `emitFuncRef` and the rest of the family; plain `call` is legal on all three
  (`legality.ts:269`; `boundary-surface/104-backend-closure-emitters.txt`).
- **Legacy emission is the demote target and carries the bulk of the reads**:
  398 functional `ctx.{nativeStrings,wasi,standalone,strictNoHostImports,fast}`
  reads across 55 callable-path files — `codegen/index.ts` 118, `calls.ts` 57,
  `call-receiver-method.ts` 51, `call-identifier.ts` 30, `integration.ts` 79 —
  plus 32 `noJsHost()` (`= wasi || standalone`, `src/codegen/js-errors.ts:29`)
  calls (`ungoverned-dispatch/mode-reads-functional.grep`, `ranked-sites.tsv`).
  Bound functions have **no IR representation** — `.bind()` is legacy-only
  (`src/codegen/expressions/call-tail-dispatch.ts:1762`:
  `!standalone && !noJsHost` → host bound fn, else closure struct;
  `__bind_function` is the only callable import on the dual-mode allowlist,
  `src/codegen/host-import-allowlist.ts:332`).

### Measured per-shape lane behaviour (`lane-measurement/results.md`, `results.json`)

Lanes: gc-host `{}` · gc-strict `{strictNoHostImports:true}` · standalone
`{target:"standalone"}` (implies nativeStrings, `src/index.ts:517-520`) · wasi
`{target:"wasi"}`; `trackIrOutcomes`/`experimentalIR`/`trackFallbacks` on,
verdict from `result.irOutcomes` (`src/ir/outcomes.ts:281`). **Not measured**:
the exact standalone-DOM lane (`environment:"none"` + `native-first`, the gate
at `index.ts:2885-2888`) — the corpus's standalone cell used the plain target,
so the `domCallbackAuthority` path and the standalone DOM dispatcher
(`standalone-dom-callback-authority.ts:388-392`) have no measured cell. F3-S1's
V-A must add it.

| shape | verdict (all lanes unless noted) | reason · reject arm | bytes gc / strict / standalone / wasi |
|---|---|---|---|
| 01 direct call | **IR, compile-once** 2/2 | — | 183 / 22017 / 22632 / 22659 |
| 04 closure capturing param | **IR, compile-once** 1/1 | — | 2990 / 33007 / 33030 / 33057 |
| 11 `new` class | **IR, compile-once** 3/3 | — | 1100 / 22697 / 23044 / 23071 |
| 02 indirect call via fn-typed var | LEGACY entry 2/3 | `vardecl-typenode:FunctionType` (`select.ts:5723`) | 9974 / 42469 / 60149 / 60016 |
| 03 closure over mutable local | LEGACY 0/1 | `closure-return-type` (`:6010`) | 3282 / 33003 / 51773 / 51725 |
| 05 returned closure | LEGACY 0/2 | `closure-return-type` (`:6010`); entry `call-graph-closure` (`:1153`) | 5942 / 36555 / 54660 / 54634 |
| 06 `.bind` | LEGACY 0/2; `scale` compile-twice | `expr-ident-not-in-scope` (`:9264`) | 3890 / 99725 / 132257 / 107031 |
| 07 `.call`/`.apply` | LEGACY 0/2; `sum3` compile-twice | `function-invocation-method-unsupported` (`:9792`) | 812 / 22433 / 22798 / 22825 |
| 08 `array.map(arrow)` | LEGACY 0/1 | `array-method-unsupported` (`:9769`) | 4333 / 35716 / 53572 / 53498 |
| 09 host callback `addEventListener` | gc-host: IR emitted but **compile-twice**; strict/standalone: LEGACY `body-shape-rejected`; **wasi FAILS** | lane-dependent | 908 / 93602 / 50422 / FAIL |
| 09b pinned B2 (`tests/issue-3214-void-host-callback.test.ts:139-140`) | same as 09 | same | 849 / 93617 / 33180 / FAIL |
| 10 `new` plain function | LEGACY 0/2; `Point` compile-twice | `expr-new-callee-nonident` (`:9047`) | 6425 / 100730 / 131627 / 102595 |
| 12 higher-order compose | LEGACY entry 2/4; `compose` compile-twice on gc-host, `call-graph-closure` elsewhere | `expr-ident-not-in-scope` (`:9264`) | 12005 / 44173 / 61517 / 61330 |
| 13 recursion via local ref | LEGACY 0/1 | `nested-function-self-reference` (`:5881`) | 3288 / 33431 / 52211 / 52150 |

Findings that size the family (`lane-measurement/summary.md`):

- **3 of 14 shapes are IR-claimed compile-once on all four lanes**; 11 have
  a selector-rejected terminal unit. 9 of 14 never reach the IR boundary at
  all — selector coverage (#3522 R3 / adoption lanes) is the gate before most
  of family 3's manifest work, the verdict F2 gave `String()` coercion.
- **Compile-twice is the dominant family-3 hazard**: 5 units on gc-host
  (`scale`, `sum3`, `Point`, `compose`, `install`) carry both an IR and a
  legacy body. `computeIrFirstSkipUnitIds` admits only number/bool/string
  positions via `positionDomain` (`src/codegen/ir-overlay-safety.ts:368`);
  `irFirstBodyIsProvenLowerable` states closure/extern/`new` shapes "all stay
  COMPILE-TWICE" (`src/codegen/ir-first-gate.ts:96-101`). Even the pinned B2
  host-callback shape compiles twice on gc-host.
- **Host-lane-only callable imports** (all `env`; strict/standalone/wasi emit
  0 imports on every shape except the 09/09b DOM leak): `__call_function`,
  `__call_function_0..4`, `__bind_function`, `__make_callback` (09/09b),
  `__register_fnctor_instance` (10; survives on gc-strict too). Shape 04 is
  genuinely IR (`closure.new`/`closure.call`) yet gc-host still imports
  `__call_function_1..4` + `__box/__unbox_number` — the unmatched-callee
  fallback `hostCallableFallbackTerminal`
  (`src/codegen/closure-exports.ts:1268-1290`; `undefined` under
  `standalone || wasi || native-first || arity>4`) is registered on the host
  lane regardless of IR claim, and its import NAME is partly env-var driven
  (`JS2WASM_FIXED_ARITY_HOST_CALLS`, `:1280`,
  `src/codegen/expressions/host-call-fallback.ts:19-30`).
- gc-strict is a native-strings regime (`nativeStringsRequiredByPolicy`,
  `src/target-profile.ts:124-125`; `strictEnvImportGate` `:80`) — hence 22 KB
  for a 2-function module — and is refused by the exact invocation lane
  (`src/codegen/index.ts:4292-4300`).

### Deferred by design (needs a schema slice — the family-3 analog of F2-S2)

The frozen record schema (`src/ir/runtime-host-capabilities.ts`) can spell
`kind: "func"` over `module ∈ {env, wasm:js-string}` (`:157`) with values
`externref | i32 | f64 | ref_extern` (`:143-150`), `kind: "func-family"` for
arity-suffixed **imports** (`:280-290`), and `kind: "global"` over
`{string_constants, string_constants16}` (`:158-161`). A provider may cite
several records (`runtime-manifest.ts:782`). The 12 provider implementation
kinds (`:655-758`) all name something the module CALLS or a symbolic field;
none names an export, a type, or a host→module trampoline
(`boundary-surface/08-manifest-policy-and-provider-shapes.txt`). Consequently:

- (a) **Direction** — no export / host-calls-module kind: `__call_fn_N`,
  `__closure_arity`, `__cb_<id>` are unrepresentable, and `module` has no slot
  for a module-export namespace.
- (b) **Types** — no `funcref` / `ref $T` in the value union, no record kind
  for a struct or func type; the only type-shaped provider arm is
  `carrier-field` with a symbolic role (`:741-746`), deliberately not a type
  index. Closure header, wrapper ROOT, lifted-func type and the fnctor reserved
  layout are outside it.
- (c) **Globals** beyond string constants — the DOM authority brand global
  (`wasmgc-emitter.ts:372-373`) and the function-value trampoline cache global
  have no module in `RUNTIME_HOST_CAPABILITY_GLOBAL_MODULES`.
- (d) **Sentinel semantics** (`-1` reusable / `-2` one-shot) exist only in a
  comment (`from-ast.ts:8307-8310`) and the runtime switch
  (`runtime.ts:17660-17661`); no record field.
- (e) **Backend legality** — the closure family lowers on WasmGC only; a
  manifest freezing a callable provider for `backend: linear/bytecode` would be
  a lie until those emitters exist (`linear-emitter.ts:485-488`).
- (f) **Env-var knob** — `JS2WASM_FIXED_ARITY_HOST_CALLS` decides
  `__call_function_N` vs `__call_function`; a record for that family cannot
  be frozen from `ctx` alone without freezing the knob.
- (g) **Constructor/fnctor ABI facts** (`hiddenIdentity`, `resultIsExternref`)
  are frozen by the R1/R2 program-ABI registry independently of the R6
  manifest; governing them means projecting the R1 plan INTO the manifest or
  declaring them out of R6 scope (as F2 did for `stringMethodPlan`). Open
  question below.
- (h) **Bound functions** — no IR op; adoption work first (shape 06).

### Family 3 slice map (F3-S1 … F3-S6)

| slice | title | size | depends on | files it edits | byte-neutral by construction |
|---|---|---|---|---|---|
| **F3-S1** | host callback maker under manifest policy (`hostCallbackWrap` policy (new), reuse `async.callback.wrap`) | M | F2-S8 merged (adjacent `runtime-manifest.ts` policy fields) | `src/ir/runtime-manifest.ts`, `src/ir/intrinsic-support.ts`, `src/ir/integration.ts` (policy projection + attached-target arm), `src/ir/from-ast.ts` (`:8313` spelling from the record), `src/codegen/ir-overlay-finalize.ts` (sub-B), `src/ir/backend/linear-integration.ts` + `src/codegen/stdlib-selfhost.ts` (disabled policy), tests | **yes** — host arm binds the existing `env.__make_callback` import index; native arm emits nothing today and after |
| F3-S2 | capability-record schema widening for callables: `kind: "export"` (new) host→module records (`__call_fn_N`, `__closure_arity`), maker siblings `callback.wrap.ctor` / `callback.wrap.getter` / `closure.apply` (new ids, `env`), `func-family` rows for `__call_function_N` + `__boundary_callback_call_N` with the env-var knob frozen as a record axis | M | F3-S1 | `src/ir/runtime-host-capabilities.ts`, kind guards in `intrinsic-support.ts` / `runtime-manifest.ts` / `async-runtime-providers.ts`, `tests/issue-3526-callable-boundary-schema.test.ts` (new) | **yes** — moves no boundary (F2-S2 anatomy) |
| F3-S3 | `functionPrototypeCall` policy (new): govern `functionPrototypeCallTarget` (`integration.ts:6124-6129`), one runtime symbol, truth table `standalone && !wasi` | S | F3-S1 machinery | `runtime-manifest.ts`, `integration.ts` (`:6124-6129` + projection), tests | yes if the demote stays at build (see open question 4) |
| F3-S4 | closure-environment policy (new): `hostOneShot` vs `domCallbackAuthority` subtype choice (`from-ast.ts:14486-14496`, `closure-struct-registry.ts:183-184`, `standalone-dom-callback-authority.ts:99-104` reserve-time re-read) | M | F3-S2 (type role + brand global need a record kind) | `from-ast.ts`, `closure-struct-registry.ts`, `standalone-dom-callback-authority.ts`, `runtime-manifest.ts`, tests | yes — same subtype, same brand global |
| F3-S5 | publish host dispatch exports (`__call_fn_0..4`, `__closure_arity`) as manifest export intents (anti-vacuity item 2 for callables) | L | F3-S2 | `closure-exports.ts`, `index.ts:6038-6056`, `runtime-manifest.ts`, tests | yes — publication only, no emission change |
| F3-S6 | unmatched-callee host fallback under policy (`hostCallableFallbackTerminal`, `planHostCallFallback`, `__apply_closure` host late import `src/codegen/array-tolocalestring.ts:153`) | XL | F3-S2, selector coverage for shapes 02/05/12 | `closure-exports.ts`, `calls.ts`, `host-call-fallback.ts`, `object-runtime.ts`, `integration.ts`, tests | **no** — gc-host import set on IR-claimed shapes (04) is the measured target; needs its own before/after cells |

Out of R6 (adoption/selector work first, like F2's `String()`): `.bind`
(06), `.call/.apply` (07), `array.map(arrow)` (08), `new` on a plain function
(10), returned/escaping closures (03/05), local-ref recursion (13); the
compile-twice admission in `ir-overlay-safety.ts` / `ir-first-gate.ts`;
constructor/fnctor ABI (R1 #3520 / R2 #3521); `extern.*` `??` fallbacks
(family 6).

### F3-S1 — host callback maker under manifest policy (contract)

**The arm being governed**: the maker crossing for a checker-certified void
host callback. Host lanes emit `call env.__make_callback(i32.const -2, packed)`
spelled in from-ast (`from-ast.ts:8311-8316`); the exact standalone-DOM lane
pushes `packed` unwrapped (`:8303-8306`); import existence is decided by the
legacy pre-pass (`import-collector.ts:2005-2011`) and re-verified by hand
(`ir-overlay-finalize.ts:270-275`). Truth table:
`jsHostExterns → host maker` · `exact standalone DOM → no maker` · else the
selection gate (`calendar-selection-support.ts:27-36`) never admits the arrow.

1. **New policy** `hostCallbackWrap?: HostCallbackWrapPolicy` (new) —
   `{ wrap: "host" | "native-dispatch" | "unsupported" }`, sibling of
   `stringConcatMany` (`runtime-manifest.ts:412`). Frozen disabled default,
   canonicalized, published, selected fail-closed with typed
   `provider-target-unavailable` naming the policy. Follow the 10-point edit
   list F2-S1 item 2 names (type + default + constructor refreeze around
   `:1956-1967`, feature/provider unions, `#selectProvider` branch, caller
   projection `integrationHostCallbackWrapPolicy(ctx)` (new) beside
   `integration.ts:1226-1237` consulted ONCE before freeze, owner-local
   partition scan, explicit disabled policy in the linear adapter and
   `stdlib-selfhost.ts`, whole-shape pin updates).
2. **Provider rows**: `host.callback.wrap` (new) → `host-callable` over the
   EXISTING record `async.callback.wrap` (`runtime-host-capabilities.ts:375`,
   no rename, no new record — `host.promise.react` keeps citing it);
   `native.callback.dispatch` (new) → a no-import implementation naming the
   standalone DOM dispatcher (mechanism per P1 — `native-managed` today admits
   only `service: "native-promise-runtime"`, `runtime-manifest.ts:754-755`).
3. **from-ast stops spelling the maker**: `:8313` builds the import ref from
   the frozen record (`irImportFuncRef(record.module, record.field)`), binding
   KIND stays `import` (pins compare kinds, the S4 lesson); the `-2` sentinel
   stays a from-ast fact (deferred (d) — do not invent a record field here).
   The exact standalone-DOM branch keeps its plan-driven shape; the slice adds
   the manifest as the authority that ADMITS it (native-dispatch selected) and
   fails closed otherwise.
4. **Import parity is the hard byte constraint**: the host arm must bind the
   funcMap's existing `__make_callback` import index — no `ensureLateImport`,
   no new registration, no union materialization; add attached-target
   recognition (the `attachedExternIsUndefinedArm` shape, `integration.ts:8194`) routing to the
   existing pre-pass registration, keeping every lane's import order
   identical. The native arm emits no call before and after.
5. **Sub-B — record as single source of the maker ABI**:
   `hasExactHostVoidCallbackMakerImport` (`ir-overlay-finalize.ts:270-275`)
   compares the physical `(i32, externref) -> externref` against
   `resolveRuntimeHostCapabilityRecord("async.callback.wrap")` instead of a
   hand-written shape; pin "refuses a maker whose ABI drifts from the record".
   `callback-ctor-bridge.ts:52-62` (legacy `_ctor` maker) is NOT touched —
   its record lands in F3-S2.
6. No change to `plan.invocation`, selection (`calendar-selection-support.ts`),
   `closure.new` flags, or the sentinel; no from-ast change beyond item 3.

**Required pre-implementation probes** (answers go in the checkpoint note):

- **P1 — native-arm mechanism**: how a "no call" provider is expressed —
  extend `native-managed.service` (new value), or record the native arm as
  `unsupported`-for-import with the DOM plan as its own authority. Whichever
  is chosen must not require a record kind from F3-S2. Name the seam that
  reads the selected provider for the import ref (the
  `preparedStringCompareProvider` analog in `intrinsic-support.ts`) and prove
  the host arm binds the SAME `env.__make_callback` index (item 4) — measure
  with `result.imports.map(name)` on the B2 fixture.
- **P2 — the un-measured lane**: compile 09/09b under the exact standalone-DOM
  profile (`environment:"none"`, `native-first`; gate `index.ts:2885-2888`)
  before any edit; record bytes, import set, `irOutcomes`, and whether the
  dispatcher is reserved (`index.ts:4448-4451`). Without this cell the
  native-dispatch row has no baseline.
- **P3 — outcome-pin shift**: which committed pins move — the
  `tests/issue-3214-void-host-callback.test.ts` B2 pins, the
  `issue-3520-callable-provider-abi` binding pins (kinds, not names), the
  whole-shape policy pins in `issue-4104…` / `issue-3526-ir-runtime-manifest`
  (new field), the async-manifest pins that enumerate `async.callback.wrap`
  citers. Record the divergence-4 class: if the maker is total under both arms
  (it is today — selection already refuses the rest), state it is EMPTY.
- **P4 — census**: `pnpm run check:ir-fallbacks` diffed, not eyeballed
  (`unintended: {}` must not move); the linear baseline
  `scripts/linear-ir-baseline.json` byte-exact-pinned must not change.

**Verification matrix** (the 6-point F1 template, verbatim):

- **V-A byte cells**: the 09/09b fixtures + shape 04 (closure without a host
  callback, control) + the F2 `CLEAN` control × six lanes (gc-host,
  gc-native-strings, standalone, exact standalone-DOM, WASI, linear),
  before/after on the same tree: byte length, sha256, import set AND order;
  full WAT diff empty. Expectation: **all cells byte-identical**; wasi cells
  stay the same hard failure ("DOM global 'EventTarget' is not available").
- **V-B import parity**: exact `result.imports.map(name)` on gc-host for 09b
  (`__make_callback` at its pre-slice index), plus a runtime oracle check that
  the wrapped callback fires once with the one-shot sentinel.
- **V-C non-vacuity by revert**: restore only the `:8313` spelling / only the
  sub-B hand-written ABI check; exactly the named new pins fail, all
  schema/policy pins stay green.
- **V-D fail-closed reachability**: refusal per disabled policy with typed
  `provider-target-unavailable` naming `hostCallbackWrap`; owner-local demote
  proven per-owner with a clean co-owner staying emitted; sub-B ABI-drift
  refusal.
- **V-E suites**: new `tests/issue-3526-callable-boundary-callback.test.ts`
  with the per-slice anatomy (a)-(i); controls unchanged:
  `issue-3214-void-host-callback`, `issue-3520-callable-provider-abi`, both
  async suites, all #3526 suites, `issue-4550-linear-ir-census`; five ratchet
  gates chained bare AND under `LOC_GATE_BASE=$(git rev-parse origin/main)`;
  `runtime-manifest.ts` growth needs the dated `loc-budget-allow` block.

**Ownership**: slice claim `#3526:f3s1`. R6 owns `runtime-manifest.ts`,
`intrinsic-support.ts`, `runtime-host-capabilities.ts`, `from-ast.ts`, the
adapters. `src/ir/integration.ts` is under the R2 lock
(`plan/issues/3521-ir-r2-prepared-program-free-function-compile-once.md:953-956`);
F1/F2 precedent is that R6 edits only its own policy-projection and
attached-target lines there — same here, coordinated with the R2 lane before
push. Not written by F3-S1: `src/codegen/ir-prepared-free-functions.ts` and
the R2 selector call sites in `src/codegen/index.ts` (R2 #3521),
`src/codegen/multi-prepared-callable-orchestration.ts` and R5 multi-prepared
files (#3525), `src/ir/outcomes.ts` (#3520), R3 late-feature routing (#3522),
the `src/codegen/declarations.ts` prelift seam (#3523 gap-6a v2, PR #5480),
`import-collector.ts` (C0/M1 single-owner list, `:1015-1024`).

### Open questions (overlaps to settle before dispatch)

1. `src/codegen/ir-overlay-finalize.ts` (sub-B) — is it R2 overlay territory
   or R6? If R2, sub-B moves to a docs-level pin and F3-S1 is sub-A only.
2. F3-S4's `from-ast.ts:14486-14496` / `closure-struct-registry.ts` edits sit
   on the closures compile-once surface (#3522 R3) and the standalone DOM
   capability (#3523 R4) — needs an explicit partition line before F3-S4.
3. Deferred (g): does R1 (#3520) project `hiddenIdentity` / `resultIsExternref`
   into the manifest, or does R6 declare constructor ABI out of scope for good?
4. F3-S3's demote point: `functionPrototypeCallTarget` returning `null`
   demotes at BUILD (`method-call-unsupported`, `from-ast.ts:7553`); a
   resolve-time fail-closed arm would shift it to `late-preparation-unsupported`
   @resolve and change census output — decide build-time projection vs
   resolve-time provider before sizing.
5. The compile-twice admission (`ir-overlay-safety.ts:368`, `ir-first-gate.ts:96-101`)
   dominates family 3's measured cost but is not a boundary — which lane owns it?
6. F3-S2's env-var knob (`JS2WASM_FIXED_ARITY_HOST_CALLS`): freeze it as a
   record axis, or retire the knob first (a #3520/#4397 host-import-policy
   question).
