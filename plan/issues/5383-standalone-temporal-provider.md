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
  # 2026-09-12 (S2l) — `Object.fromEntries` over a computed pair list on the
  # standalone lane. Both defects are AT existing call sites, so neither can
  # move to a new module without separating a decision from the code that makes
  # it:
  #   expressions/call-builtin-static.ts  +39  the standalone admission, inside
  #     the one `Object.fromEntries` branch, ahead of the `ensureLateImport`
  #     fall-through it replaces. Most of the growth is the rationale, and it is
  #     load-bearing twice over: it records that the OLD outcome (refuse vs.
  #     compile) was decided by unrelated module content rather than by the
  #     source construct, and it states why a `Map` argument must KEEP refusing
  #     — the native would answer `{}`, which is the silent-wrong failure this
  #     slice exists to delete. A reader who trims it will "finish the job" by
  #     widening the gate to every argument and reintroduce it.
  - src/codegen/expressions/call-builtin-static.ts
  # 2026-09-12 (S2l) — STRANDED GRANTS restated. `builtins.ts` (+96) and
  # `call-receiver-method.ts` (+9) are grown by the S2h/S2i commits this branch
  # is stacked on, not by S2l; against `origin/main`'s baseline (which has not
  # refreshed past them) CI sees that growth in this PR's merge preview. They
  # are restated here, in a file this PR modifies, so the allowance travels
  # with the diff that carries the growth (#3102's stranded-grant case).
  - src/codegen/expressions/builtins.ts
  - src/codegen/expressions/call-receiver-method.ts
  # 2026-09-12 (S3) — a THIRD stranded grant, found by running the gate with
  # LOC_GATE_BASE=origin/main on both this branch and its predecessor and
  # getting the identical failure: `async-cps.ts` (+50) is grown by an earlier
  # stacked slice, and S3 touches no `src/` file at all. Restated here so the
  # allowance travels with the merge preview that carries the growth; without
  # it `quality` fails on a diff that does not contain the lines it names.
  - src/codegen/async-cps.ts
  # 2026-09-12 (S2i) — the runtime-key STATIC-member read on a class VALUE. The
  # mechanism is the new module src/codegen/standalone-class-dyn-static.ts; the
  # only god-file line this slice adds is ONE:
  #   registry/imports.ts  +1  `shiftMap(ctx.classStaticSidecarGlobals)`, next to
  #     the `protoGlobals` / `classObjectGlobals` lines it mirrors. The sidecar
  #     global was the one class-global map NOT shifted when a late string
  #     constant inserts an import global — a latent #2043 staleness that
  #     predates this slice and that S2i makes reachable, because it now
  #     registers that global at FINALIZE rather than at class collection. It
  #     cannot live anywhere but in that shift block.
  - src/codegen/registry/imports.ts
  # 2026-09-08 (S2h) — the runtime-key PROTOTYPE-member read, standalone. The
  # mechanism is the new module src/codegen/standalone-class-dyn-member.ts;
  # what lands in these files is only the wiring, and each line has to sit
  # exactly where it does:
  #   context/types.ts  +10  the `standaloneRuntimeKeyClassProtos` field. It is
  #     a ctx field, so it can only live in the ctx type; the doc block is what
  #     records that this set being EMPTY is the whole byte-neutrality argument
  #     (a reader who trims it loses the reason the field is never populated
  #     under a JS host).
  #   property-access.ts  +8  the two runtime-key read sites, each beside its
  #     #5358 host-lane twin — the two demands are lane-disjoint and drift
  #     apart the moment they are recorded in different places.
  #   index.ts  +16  the mint call at BOTH finalize sites, ahead of the
  #     closure-dispatcher emission rather than beside the lookup fill it
  #     serves. That position is counter-intuitive and measured (an accessor
  #     read answered `undefined` from the other one), so the comment stating
  #     why is load-bearing.
  - src/codegen/context/types.ts
  # 2026-09-08 (S2g) — the standalone construct-from-a-class-VALUE path. The
  # mechanism itself is two NEW modules (src/codegen/standalone-class-construct.ts
  # and src/codegen/extern-arg-marshal.ts, the latter an extraction that makes
  # closed-method-dispatch.ts SHRINK); what lands in new-super.ts is only the
  # admission:
  #   expressions/new-super.ts  +22  the member-callee admission
  #     (`new NS.PlainDate(…)`) must sit ON the callee-shape decision inside
  #     `tryCompileNativeConstructFromValue` and on the one `if` that gates it —
  #     that is exactly where the host lane makes the same decision
  #     (`usesHostConstructClosureBase`), and separating the two would let the
  #     lanes drift apart silently. The rest of the growth is the rationale for
  #     why an UNDECLARED base must keep declining (#4728).
  - src/codegen/expressions/new-super.ts
  # 2026-09-08 (S2e) — scope-discriminating the `defineProperty` sidecar key.
  # The mechanism itself is the new module src/codegen/sidecar-owner-scope.ts;
  # what lands in these four files is ONLY the wiring, and it has to sit on the
  # exact `.add`/`.has` line it qualifies, because the whole defect is that the
  # key and the binding it was recorded for were separated:
  #   object-ops.ts              +3  record the owner where the key is added
  #   expressions/assignment.ts  +3  same, for the destructuring-target writer
  #   object-shape-widening.ts   +5  the two widening writers mark the key
  #                                  UNSCOPED (they hold a name, not a node) —
  #                                  that is what keeps their behaviour identical
  #   property-access.ts         +4  the two READ guards
  - src/codegen/object-ops.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/property-access.ts
  # 2026-09-08 (S2d) — the standalone cross-module OBJECT boundary. The whole
  # mechanism lives in the new module src/codegen/standalone-link-boundary.ts;
  # what lands in object-runtime.ts is the two places the mechanism has to be
  # WIRED, and both are wired next to their JS-host twin on purpose:
  #   object-runtime.ts  +24  the peer-terminal registration (beside the
  #                           `__boundary_object_*` late imports, which must all
  #                           exist before the #1984 index-space freeze), the
  #                           `??`-fallback on the two arms that already ask
  #                           "this carrier is not mine, who can decode it?",
  #                           and the one call that emits the provider-side
  #                           terminals. Moving any of it away from the arm it
  #                           guards would hide the ordering constraint its
  #                           comment exists to document.
  - src/codegen/object-runtime.ts
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
  # 2026-09-12 (S2l) — `Object.fromEntries` over a computed pair list,
  # standalone. Two growths, each on the function that already owns the
  # decision:
  #   object-runtime.ts::fillExternArrayLikeStructArms  +63  the TUPLE carrier
  #     arm. This function IS the finalize-time candidate collector for the
  #     standalone dyn-reader trio (`__extern_length` / `__extern_get_idx` /
  #     `__extern_has_idx`); a tuple is a third array-like shape alongside the
  #     closed struct and the typed vec, and it has to be minted in the SAME
  #     pass, in the same `cands` order, or the spliced arms land at a
  #     different body offset than the vec arms they must follow (#4443). Most
  #     of the growth is the measurement that motivates it — the contextual
  #     tuple lowering of `[k, v]` under `Object.fromEntries`'s
  #     `Iterable<readonly [PropertyKey, T]>` signature, which made the SAME
  #     expression work when bound to an `any` local first and answer
  #     `{undefined: undefined}` when passed inline.
  #   expressions/call-builtin-static.ts::compileBuiltinStaticCall  +39  the
  #     standalone admission; see the loc-budget-allow note above for why it
  #     cannot leave the `Object.fromEntries` branch.
  - src/codegen/object-runtime.ts::fillExternArrayLikeStructArms
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  # 2026-09-12 (S2l) — STRANDED GRANT restated, same reason as the loc twin
  # above: `compileReceiverMethodCall` (+10) is grown by the stacked S2h/S2i
  # commits, not by S2l, and `origin/main`'s baseline has not refreshed past
  # them.
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  # 2026-09-12 (S3) — same stranded-grant case, measured the same way:
  # `src/runtime.ts::resolveImport` is ONE line over its ceiling (7734 > 7733)
  # on the predecessor branch as well as on this one, and S3 edits no `src/`.
  - src/runtime.ts::resolveImport
  # 2026-09-08 (S2h) — the runtime-key prototype-member read. Four call-site
  # growths, all one-liners plus the comment that makes them auditable; the
  # mechanism itself is a new module (standalone-class-dyn-member.ts):
  #   index.ts::generateModule / ::generateMultiModule  +13 / +2  the
  #     `mintStandaloneClassProtoBuilders` call at each finalize site. Its
  #     POSITION is the finding (ahead of the closure-dispatcher emission, not
  #     beside the lookup fill it feeds), so the comment stating why travels
  #     with the call — extracting the pair into a helper would put the reason
  #     one indirection away from the ordering it constrains.
  #   binary-ops-in.ts::compileInOperator  +5  the `k in c` twin of the read
  #     demand, on the same guarded arm as its #5358 host-lane sibling.
  #   create-context.ts::createCodegenContext  +1  the field initializer.
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/binary-ops-in.ts::compileInOperator
  - src/codegen/context/create-context.ts::createCodegenContext
  # 2026-09-08 (S2g) — +5 lines in `compileNewExpression`: the one `if` that
  # lets a MEMBER callee reach the native construct driver under standalone.
  # It is a condition on the existing dispatch `if`, not a block — there is
  # nothing to extract, and moving the predicate away from the dispatch it
  # guards is precisely how the host and standalone lanes drifted apart in the
  # first place (the host lane's twin is three lines further down).
  - src/codegen/expressions/new-super.ts::compileNewExpression
  # 2026-09-08 (S2f R12/R13) — three arms that CANNOT move out of the cascade
  # they qualify, because in each case the position IS the correctness argument:
  #   typeof-natives-finalize.ts::fillStandaloneTypeofClosureArms  +33
  #       the class-object IDENTITY arm has to be built where the shared
  #       `onMatch`/`mv` closures and the per-native splice points live — this
  #       file's whole invariant is "one predicate, all three natives", and a
  #       helper that took the arms elsewhere would be free to drift from it.
  #       (The builder is a local const, not a repeated block; the +33 is the
  #       arm plus the rationale for why identity, not `ref.test`, is the only
  #       sound discriminator for a carrier that shares its TYPE and its
  #       `__tag` with an instance.)
  #   native-construct.ts::fillNativeConstructDrivers                +7
  #       the `?? peer` fallback must sit on the same two `const` lines the
  #       existing `canBoundaryConstruct` guard reads, or the host and
  #       standalone twins can be wired inconsistently without the diff showing
  #       it.
  #   object-runtime.ts::fillApplyClosure                            +6
  #       same: the peer apply is the LAST fallback of `linkedFallback`, and it
  #       is only sound because every module-local arity dispatcher has already
  #       missed by that point — a fact that is visible only here.
  - src/codegen/typeof-natives-finalize.ts::fillStandaloneTypeofClosureArms
  - src/codegen/native-construct.ts::fillNativeConstructDrivers
  - src/codegen/object-runtime.ts::fillApplyClosure
  # 2026-09-08 (S2e) — the second sidecar READ guard lives inside this function,
  # on the `isDynamicSidecarRead` line it qualifies. Moving it out would separate
  # the key from the binding check, which is the defect being fixed.
  - src/codegen/property-access.ts::compileElementAccessBody
  # 2026-09-08 (S2d) — same wiring, same argument: `ensureObjectRuntime` is
  # where every dynamic terminal is registered and where the late-import freeze
  # point is, so the peer registration and the terminal emission cannot move out
  # of it without moving away from the constraint they depend on.
  - src/codegen/object-runtime.ts::ensureObjectRuntime
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
   **Status (S2m, 2026-09-12): 2 of 3 assertions asserted as a real test**
   (`Object.keys(Temporal).length === 9`, `new Temporal.PlainDate(2024,1,1).day
   === 1`, plus the `durationHours === 1` precursor). The third,
   `Temporal.Duration.from({hours:1}).total("minutes") === 60`, is `it.todo`:
   it answers **60 in one standalone module** and a provider-owned carrier that
   does not decode across the link — a wasm↔wasm VALUE ABI slice, not a
   Temporal defect. Its two earlier blockers are closed (the JSBI
   `constructor`-identity read, and a provider throw that never reached the
   consumer's `catch`). See "S2m findings".
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

## S2d findings (2026-09-08) — the getter boundary, root-caused and fixed; the stop moves INSIDE the provider

The S2 smoke test is still **not** written, and the reason moved again. What is
fixed: the cross-module object boundary, end to end, on a reduction. What now
stops Temporal is a provider-INTERNAL read, measured from both sides.

### R9 — why a provider-minted object arrived empty (two causes, not one)

**Cause 1 — the linker handed the consumer a JS host MIRROR.**
`instantiateLinkedProviders` wrapped every non-function boundary value in
`wrapLinkedProviderValue` → `_wrapForHost`, unconditionally. That mirror is
bound to the provider's `__struct_field_names` / `__sget_*` exports, which a
standalone binary does not have (#4035 strips the host bridge), and it is handed
to a consumer that is **wasm** and cannot read a JS proxy at all. Fixed by
skipping the mirror when the provider's own `targetProfile.environment` is not
`"javascript"` — the raw struct now crosses.

**Cause 2 — nothing on a standalone value says what it is.** With the raw struct
crossing, every read still answered `undefined`: standalone has no
self-describing property bag. `__extern_get` / `__object_keys` are module-local
`ref.test` ladders over the struct types THAT module declared (filled at
finalize), so a provider-minted struct misses every arm. The JS lane hides this
because #5225's `_crossModuleStructs` registry re-points a read at the module
that can decode it; there is no standalone twin.

Fixed by building that twin in pure wasm (`src/codegen/standalone-link-boundary.ts`):
a standalone provider whose consumer is wasm (`exportsConsumedByWasm`) publishes
`__js2wasm_link_member_get` / `__js2wasm_link_object_keys` / `__js2wasm_link_apply`,
and the consumer calls them on the arms where its own ladder has ALREADY missed
— the same two arms the host lane's `__boundary_object_get` /
`__boundary_object_keys` occupy, so neither lane grows an arm and the
single-module lane is untouched.

The two published reads are **wrappers, not re-exports**: each normalises "I do
not know this value" to `ref.null.extern`. Without that the consumer would have
to trust another module's `undefined` singleton, and the peer's empty key-vec
would out-rank the consumer's own carrier bags. Both normalisations are
answer-preserving (a genuinely-`undefined` property and a genuinely-empty object
fall back to the consumer's local miss, which answers the same).

**Measured** (`.tmp/s2d/probe3`, host-free `instantiateLinkedProject(result, {})`,
three carrier shapes — object literal, assigned own props, `defineProperty`):

| probe | base | after |
| --- | --- | --- |
| `Object.keys(NS).length` | 0 | **3** |
| `NS.a` | `undefined` | **1** |
| `NS.zzz === undefined` | true | true |
| gc control | 3 / 1 | unchanged |

Four cases in `tests/issue-5383-standalone-temporal-provider.test.ts`.

Two things the facade does NOT yet cover, both measured: **calling a
provider-minted closure** (`keysOf(NS)` → `null`) and `hasOwnProperty` / `in` /
`for-in` for the non-`defineProperty` carriers — those terminals have their own
miss arms and were left for a follow-up rather than guessed at.

### Where it stops NOW — inside the provider, not at the boundary

Through the real provider the consumer still reads nothing, and the reason is no
longer the boundary. Measured with the terminals called directly from JS on the
EXACT value the consumer holds (identity checked, `.tmp/s2d/temporal-probe`):

- `__js2wasm_link_object_keys(Temporal)` → **non-null** (the provider enumerates
  its own namespace fine — 9 keys);
- `__js2wasm_link_member_get(Temporal, <consumer-minted "PlainDate">)` → **null**,
  and with the normalisation disabled it is the provider's own `undefined`
  singleton (the consumer agrees — `x === undefined` answers true for it, so the
  singleton itself crosses correctly).

So the provider's own `__extern_get` answers `undefined` for `qi.PlainDate`
while its own `__object_keys` lists all nine. That asymmetry is provider-local:
driving the polyfill from INSIDE its own module (`compileMulti` of shim+bundle,
`.tmp/s2d/in-provider`, referencing the bundle's real binding `qi` — a bare
`Temporal` identifier is intercepted by the #661 compile-time lowering and tests
nothing) answers `Object.keys(qi).length === 9`, `typeof qi.PlainDate ===
"function"`, `qi["Plain"+"Date"]` resolvable, `"PlainDate" in qi` true. **Next
lane's target: find which terminal serves the in-module read and why
`__extern_get` — the one the boundary can call — does not.** A first reduction
attempt (`.tmp/s2d/probe13`, an object literal whose values are classes) does
NOT reproduce it: there `__extern_get` returns the right class by identity, it
only mis-reports `typeof` as `"object"` instead of `"function"` (a separate,
smaller defect worth its own reduction).

### The other three stops, re-measured in-module (`.tmp/s2d/in-provider`)

Messages read back through the #5384 renderer (`__exn_render_prepare` /
`__exn_render_char`), host-free, zero imports:

| probe | answer |
| --- | --- |
| `Object.keys(qi).length` | **9** |
| `new qi.PlainDate(2024,1,1).day` | throws `invalid calendar identifier` |
| `qi.Duration.from({hours:1}).total("minutes")` | throws `invalid receiver: method called with the wrong type of this-object` |
| `qi.PlainDate.from("2024-01-01")` | throws `Unsupported dynamic regular expression pattern` → filed as **#5404** |
| `qi.Now.timeZoneId()` | **no-throw** (must raise the shim's RangeError) |

The last one is NOT a boundary artifact and NOT the "discarded result" shape the
S2c note guessed at — ten isolated spellings of that guess (bare `new`, no-paren
`new`, two-step, result used, result returned, result discarded, via a namespace
object, on both lanes) all propagate the constructor's throw correctly
(`.tmp/s2d/probe14`, `probe15`, `probe16`). The real trigger is narrower and
worse, and it reproduces in ten lines on BOTH lanes: **a property read on the
result of a `never`-returning call elides the entire receiver expression**, so
`(new Intl.DateTimeFormat).resolvedOptions().timeZone` never runs the
constructor at all (`ctorHits === 0`). Filed as **#5405** with the reduction and
the shape of the fix. Every shim method has a `throw`-only body, which is why
the shim is where it surfaced.

`invalid calendar identifier` and `invalid receiver` remain unreduced — S2d
spent its budget on the boundary and on root-causing the two above.


## S2e findings (2026-09-08) — `invalid calendar identifier` root-caused and fixed; the boundary miss re-measured; the receiver stop narrowed

S2 is **not** complete. One of the three stops is fixed at the root, one is
re-measured into a smaller and different defect than S2d recorded, and one is
narrowed to a ten-word statement but not yet reduced. The S2 smoke test is
therefore still not written — what blocks it is named exactly below.

### R10 — `invalid calendar identifier` was a SCOPE-BLIND compiler key, not a Temporal defect

`ctx.sidecarDefinedPropertyKeys` is keyed by `"<identifierTEXT>:<propName>"` —
module-wide, no scope discrimination. The polyfill bundle contains one
`Object.defineProperty(e, "length", …)`, which put `e:length` in that set, and
from then on **every** `e.length` read anywhere in the module was routed to
`emitRuntimeDescriptorGet`. For any *other* binding named `e` the runtime
sidecar has no descriptor, so the read answered `undefined`.

The victim is the polyfill's ASCII-lowercase helper
`function Ao(e){let t="";for(let n=0;n<e.length;n++){const r=e.charCodeAt(n);t+=…}return t}`:
its loop bound read `undefined`, so the loop never ran, `Ao("iso8601")`
answered `""`, and `zo()` threw `RangeError: invalid calendar identifier `
(note the empty tail — that is the whole diagnosis, and it is why the S2d note
recorded the message without a name).

**How it was identified** (this is the measurement, not a deduction): three
byte-identical copies of the same function appended to the real bundle,
differing only in the local's NAME. `zqx` → 9, `t` → 9, `e` → **0**. Then the
compiler was instrumented at each arm of the property-access dispatch chain and
printed `sidecar=true key=e:length` for the `e` copy only.

Fixed in the new module `src/codegen/sidecar-owner-scope.ts`: each writer records
the *declaration node* the key was recorded for (via `ctx.oracle.valueDeclarationOf`,
not the raw checker), and the two readers in `property-access.ts` decline when the
receiver provably resolves to a different declaration. Answer-preserving by
construction: a key with no recorded owner, or an unresolvable receiver on either
side, keeps its old module-wide meaning, so the change can only ever REMOVE a
wrong-binding match. The two `object-shape-widening` writers hold a variable NAME
rather than a node and therefore mark their keys unscoped — deliberately
unchanged.

Measured on the real provider source (shim + bundle, `--target standalone`,
`hostBridge:"off"`), before → after:

| probe | base | after |
| --- | --- | --- |
| `Ao("iso8601")` | `""` (length 0) | `"iso8601"` (length 7) |
| `zo("iso8601")` | throws `invalid calendar identifier ` | `"iso8601"` |
| `new qi.PlainDate(2024,1,1)` | `RangeError: invalid calendar identifier ` | reaches the NEXT stop (`invalid receiver`) |
| the same helper with the local renamed `zqx` | already correct | unchanged |

**JS-host (`gc`) lane byte-identical**: sha256 A/B over five modules including
the reduction itself (`4c15a99694d22840`, `dc793b1437505d5d`,
`540af5b064e0ee41`, `a162c242eca6b7a4`, `b8514a76991378d8`) — same before and
after, same byte lengths.

Two S2e cases in `tests/issue-5383-standalone-temporal-provider.test.ts`: the
ten-line reduction (a module-level `Object.defineProperty(e,"length",…)` plus a
shadowing local string `e`; base answers 0, fixed answers 17, and the
defineProperty receiver still reads 3 through the sidecar), and the polyfill's
`Ao` + `CALENDARS.includes` shape.

### The boundary miss is NOT what S2d measured — re-measure before fixing it

S2d recorded `__js2wasm_link_member_get(Temporal, "PlainDate")` answering the
provider's `undefined`. On this branch, with S2d landed, a four-variant
reduction through `buildProvider`/`runConsumer` (host-free
`instantiateLinkedProject(result, {})`) says something narrower:

| provider export | `Object.keys(NS).length` | `NS.b` (number) | `NS.Now.a` | `NS.PlainDate` |
| --- | --- | --- | --- | --- |
| `{ PlainDate: class, Now: {a:1}, b: 2 }` | 3 | 2 | 1 | **`undefined`** |
| `Object.freeze({ … })` | 3 | 2 | 1 | **`undefined`** |
| `{ __proto__: null, … }` | 3 | 2 | 1 | present, `typeof` **`"object"`** |
| `Object.freeze({ __proto__: null, … })` — the polyfill's own shape (`var qi=Object.freeze({__proto__:null,Duration,Instant,Now:Bi,PlainDate,…})`) | 3 | 2 | 1 | present, `typeof` **`"object"`** |

So numbers and nested objects cross correctly; a **class VALUE** does not. For
the polyfill's exact shape the value now crosses but reports `typeof "object"`,
which makes `new Temporal.PlainDate(…)` unreachable from the consumer
(`typeof v !== "function"`, and `new v()` was not attempted past that). Two
sub-defects, not one: the plain/frozen literal loses the class value entirely,
the `__proto__: null` forms keep it but mis-tag it. Neither is fixed here.

### The remaining in-provider stop, narrowed to one sentence

`invalid receiver: method called with the wrong type of this-object` is thrown by
the polyfill's `vt(e,t){if(!t(e))throw new TypeError(…)}` when its brand check
`ne(e,...t){if(!e||"object"!=typeof e)return!1;const n=Q(e);return!!n&&t.every(e=>e in n)}`
answers false. Every component of that check was measured to work — and the one
that does not is `typeof`:

| probe (in-provider, after R10) | answer |
| --- | --- |
| `Q(d)` for `d = new qi.Duration(0,0,0,0,1)` | a bag with **10** keys |
| `Object.keys(bag)[0]`, `Y in bag`, `bag[Y]` | `slot-years`, true, `number` |
| `t.every(k => k in bag)` in a hand-written copy, plain object | **1** (works) |
| `typeof d` at the site that made `d` | `"object"` |
| `typeof zv` for the SAME `d` inside `function tp(zv){return typeof zv}` | **`"function"`** |
| the same for a class declared in the probe section of the same module | `"object"` |
| the same for `{}`, `Object.create(null)`, `qi`, the slots bag | `"object"` |

**A polyfill class instance reports `typeof "function"` once it crosses a call
boundary**, so `ne`'s first line rejects it and every accessor and method on
every Temporal object throws. `Duration.from({hours:1})` reports `"function"`
even at the call site for the same reason (it arrives as a return value).

Not reproduced in a small module by: a static factory (`D.from`), an aliased or
namespaced class, a frozen `__proto__:null` namespace, `Object.defineProperty`
of `Symbol.toStringTag` on the prototype, the `ae()` non-enumerable-statics
loop, a `WeakMap.set(this, …)` escape in the constructor, a field-less
constructor, or any combination of those tried. The discriminator that DOES hold
is "declared in the polyfill" vs "declared in the probe section of the same
module", which points at a whole-module classification — most plausibly the
canonicalisation of structurally-identical struct types (a field-less instance
struct sharing a wasm type with a closure carrier would `ref.test` as callable).
That is the next lane's first experiment; the probe harnesses are
`.tmp/s2e/{sa,inprov}.mts` in the S2e worktree.

### What still blocks the S2 smoke test

All three, in this order: the `typeof`-on-a-parameter defect above (blocks every
Temporal method call, in-provider AND through the boundary), the class-value
boundary crossing (blocks `new Temporal.PlainDate` from a consumer), and #5405
(`Now.timeZoneId()`, already filed, deliberately out of scope). #5404 (dynamic
RegExp) remains why the smoke test must not use the string form of `from`.

## S2f findings (2026-09-08) — the `typeof "function"` stop root-caused and fixed

### R11 — two independent "make the struct shape unique" fixes landed on the SAME shape

S2e narrowed the first stop to one sentence: *a polyfill class instance reports
`typeof "function"` once it crosses a call boundary*, with the discriminator
"declared in the polyfill" vs "declared in the probe section" — i.e. a
whole-module property. It is struct-type canonicalisation, exactly as
hypothesised, and the colliding pair can be named:

| type | shape | declared by |
| --- | --- | --- |
| `$__ta_ctor` (a TypedArray CONSTRUCTOR value) | `(struct (field kind i32) (field brand i32))`, both immutable | `registry/types.ts`, widened from ONE field by **#5194 r3 F1** precisely to dodge a canonicalisation collision with `__box_boolean_struct` |
| an empty class ROOT | `(struct (field $__tag i32) (field $__shape_brand i32))`, both immutable | `class-bodies.ts`, widened from ONE field by **#2158/#2009** precisely to dodge a canonicalisation collision with `$AnyString` |

WasmGC canonicalises structurally-identical struct types, so in any module that
BOTH holds a TypedArray constructor value AND declares a field-less class, every
instance of that class passes `ref.test $__ta_ctor`. The standalone `typeof`
natives (`__typeof_function` / `__typeof_object` / `__typeof`) all consult that
`ref.test` through `buildTaCtorBrandTestArm` (`builtin-callable-brand.ts`), so
they answered `"function"` — and the polyfill's own brand check
`ne(e,...t){ if (!e || "object" != typeof e) return !1; … }` therefore rejected
every Temporal receiver, which is where `invalid receiver` came from.

**How it was identified** (measurement, not deduction). The `typeof` natives'
callable ladder was instrumented so each arm returns a DISTINCT integer, and the
real provider was compiled and driven in-module:

| probe (in-provider, `--target standalone`, `hostBridge:"off"`) | arm |
| --- | --- |
| `typeof zv === "function"` for `new qi.Duration(0,0,0,0,1)` | **13** = the builtin-callable arm |
| the same for `new qi.PlainDate(2024,1,1)` | **13** |
| `{a:1}` · a probe-section class instance | 0 (no arm) |

Arm 13 is `taArm + $Object-flag arm`. Replacing the `$Object` half with a
`flags`-dump answered 0 for the Duration instance (so it is not a `$Object` at
all) and `1000` for `{a:1}` — which isolates the `$__ta_ctor` half. Dumping that
struct's two fields for the matched value gave **`{35, 0}`** for `Duration` and
**`{33, 0}`** for `PlainDate`: a class TAG and a `__shape_brand`, not
`{kind, TA_CTOR_BRAND}` (`TA_CTOR_BRAND` is `0x5441`).

**Fix** — `taCtorIdentityTestInstrs` (`src/codegen/registry/types.ts`): the
identity test is `ref.test $__ta_ctor` **plus** `struct.get brand == TA_CTOR_BRAND`.
Widening the shape a third time would only move the collision to the next
two-i32 struct; the brand VALUE is the discriminator that no other type's field 1
holds by accident, and #5194 r3 F1 already WROTE that brand at both mint sites —
it was simply never READ. Answer-preserving for a genuine `$__ta_ctor`, so the
change can only ever REMOVE a false positive.

Wired at the `typeof`/`IsConstructor` classifier (`builtin-callable-brand.ts`
`buildTaCtorBrandTestArm`, shared by all three `typeof` natives and by
`__reflect_is_constructor`) and in `reflect-construct-native.ts`.

Measured before → after, in-provider on the real bundle:

| probe | base | after |
| --- | --- | --- |
| `typeof d` for `d = new qi.Duration(0,0,0,0,1)`, read inside `function tp(zv){return typeof zv}` | `"function"` | `"object"` |
| `typeof zv === "function"` for `new qi.PlainDate(2024,1,1)` | 1 | 0 |
| `__module_init` | returns | returns |

Reduction (now a test, `#5383 S2f R11`): a module that mentions
`[Uint8Array, Int16Array]` as a VALUE and declares `class Empty {}` — base
answers `typeof new Empty() === "function"`, fixed answers `"object"`, and the
genuine `Uint8Array` keeps `typeof === "function"` with
`Int16Array.BYTES_PER_ELEMENT === 2`. **The `$__ta_ctor` VALUE is what makes it
reproduce in a small module** — that is why S2e's eight small shapes did not.

**JS-host (`gc`) lane byte-identical**: sha256 A/B over five modules
(`202a326e4eef0a7d`, `ab176f739049e143`, `5ffd7f1204da40dd`, `9c1160cd685343f1`,
`e8e39fd373135946`) — same before and after, same byte lengths. Under
`--target standalone` only the two modules that hold a TypedArray constructor
value change; `classes`, `reflectCtor` and `plain` are byte-identical there too.

### The same `ref.test` is used as an identity test at 14 more sites — 11 deferred

`ref.test $__ta_ctor` appears at 16 sites. All 16 were converted and measured;
the TypedArray suites (`#2175 S3b-3`, `#3054 D/E`, `#3054 B1/C`, `#5194 r2/r3`,
`#3239`, 39 tests) stay green with the full conversion, but on the real provider
converting `ta-ctor-meta.ts` and/or `dataview-native.ts` moves `__module_init`
to a NEW stop — `TypeError: Cannot access property on null or undefined at
19:128628` — which this slice does not have the budget to chase. Bisected: the
classifier (`builtin-callable-brand.ts`) plus `reflect-construct-native.ts` keeps
`__module_init` returning AND fixes the `typeof` answer, so only those two ship
here. The other 11 sites (`ta-ctor-meta.ts` ×2, `dataview-native.ts` ×5,
`expressions/{calls,new-super×2,call-receiver-method}.ts`,
`property-access-dispatch.ts`) still ask a structural question and remain a real
— but narrower — false-positive channel: they only misfire where a TypedArray
constructor is already expected. The converted-everything patch and the exact
next stop are recorded here so the follow-up starts from the measurement rather
than re-deriving it.

**Pre-existing red, NOT caused by this change:** `tests/issue-3610-…` "a
reflective `.call` on a real instance is NOT gated" fails identically on the S2e
base (`(Uint8Array.prototype.join as any).call(a, "-")` answers 2 = caught a
TypeError, expected 1). Verified by running that single case with the three
changed files reverted.

### R13 — a class VALUE is not callable at RUNTIME, and that is not a boundary defect

S2e recorded the second stop as a boundary one: *the class value crosses but
`typeof` reports `"object"`, so `new Temporal.PlainDate(…)` is unreachable from
a consumer*. Re-measured on this branch, the boundary is not where it breaks.

First, one of S2e's two sub-defects is **gone**: all four namespace shapes now
carry the class value across (`NS.PlainDate === undefined` is false for the
plain literal, the frozen literal, the `__proto__:null` literal and the
polyfill's own `Object.freeze({__proto__:null, …})`). Only the mis-tagging
remained.

Second, the mis-tagging reproduces **inside one standalone module**, with no
link boundary at all:

```js
class PlainDate { constructor(y) { this.y = y; } day() { return 1; } }
function isFn(x) { return typeof x === "function" ? 1 : 0; }
export function test() { const v = PlainDate; return isFn(v); }   // base: 0
```

The bare identifier answers `"function"` through the compile-time fold; the same
value read through a parameter answers `"object"`. That is the #2984
path-dependence, and the cause is structural: a class VALUE is a `$ClassName`
struct with the **same type and the same `__tag` as an instance** (#3976,
documented at length in `class-object-of.ts`), so no `ref.test` can separate
them. The only thing that can is IDENTITY — the lazily-materialised
class-object singleton global (`ctx.classObjectGlobals`).

**Fix (R13)** — `fillStandaloneTypeofClosureArms` gains a class-object identity
arm (`ref.eq` against each singleton), spliced into all three natives so the
inline compare and the materialised `const t = typeof C` agree. Exact in both
directions: an instance is a different object and can never match; an
unmaterialised singleton holds null, which `ref.eq` answers false for, so the
arm degrades to today's answer rather than to a wrong one.

**Fix (R12)** — the wasm→wasm twin of the JS-host lane's boundary terminals, so
the consumer can ask the module that OWNS the value. The consumer-side arms
already existed and were already correct (`native-construct.ts`,
`typeof-natives-finalize.ts`, `fillApplyClosure`); the standalone lane was
simply never given anything to put in them, because
`__boundary_object_callable_kind` / `__boundary_object_construct` are JS-host
imports gated on `environment === "javascript"`. Added to
`standalone-link-boundary.ts`:

| terminal | body |
| --- | --- |
| `__js2wasm_link_callable_kind(v) -> i32` | `__typeof_function(v)&1 \| (__reflect_is_constructor(v)&1)<<1` — the SAME bit encoding the host lane uses, so the consumer arms that mask `&1` and `&2` needed no change |
| `__js2wasm_link_construct(target, argsVec, newTarget) -> externref` | the ordinary §10.2.2 tail: `proto = target.prototype`, `self = Object.create(proto)`, `r = target.[[Call]](self, args)`, return `r` when it is an Object else `self` |

Both are RESERVED in `ensureObjectRuntime` (the index space freezes after it,
#1984) and FILLED at finalize, because each composes helpers that have no body
until then. `standaloneLinkBoundaryPeerIndex` is a CONSUMER-only lookup on
purpose: the provider registers the same names in its own `funcMap` to export
them, and a bare `funcMap.get` would make a provider route its own `typeof` and
`new` into its own boundary terminal.

Measured on a four-variant reduction through a real linked provider, host-free
(`instantiateLinkedProject(result, {})`):

| probe | base | after |
| --- | --- | --- |
| `Object.keys(NS).length` · `NS.b` · `NS.Now.a` | 3 · 2 · 1 | unchanged |
| `NS.PlainDate === undefined` | false | false |
| `typeof NS.PlainDate` | **`"object"`** | **`"function"`** |
| in-module: `typeof PlainDate` through a parameter | `"object"` | `"function"` |

**gc lane byte-identical**: the same five-module sha256 A/B as R11, all five
unchanged. Under `--target standalone` the `classes` and `plain` modules are
byte-identical too — `classObjectGlobals` is populated only by a class read as a
VALUE, so a module that never does that emits identical bytes.

### What still blocks the S2 smoke test — one defect, with a three-line reduction

`new` on a class VALUE reached dynamically produces an EMPTY object, in one
standalone module, with no boundary involved:

```js
class PlainDate { constructor(y) { this.y = y; } }
const mk = (K) => new K(5);
export function test() { return mk(PlainDate).y; }   // undefined; the result is
                                                     // Object.create(null)-shaped
```

`fillNativeConstructDrivers`'s ordinary tail is `proto = callee.prototype`,
`self = Object.create(proto)`, `result = __call_fn_method_N(self, callee, …)`.
For a class-object singleton the callee is a `$ClassName` STRUCT, not a closure,
so the module-local closure dispatcher misses, `result` is null and the driver
returns the bare `self` — an object with none of the constructor's own fields.
R13 makes `typeof`/`IsConstructor` answer correctly for that carrier, and R12
routes a FOREIGN one to the owning module, but neither supplies the missing
piece: **a per-class entry point that runs the constructor body from an args
vec**, keyed by the class-object singleton's identity the same way R13 keys
`typeof`. That is the next slice; it is a new mechanism (marshalling an
externref args vec into the constructor's typed parameters), not a wiring
change, which is why it is not in this one.

Consequently the S2 smoke test is **not** written: `new Temporal.PlainDate(2024,1,1).day`
cannot run, and `Temporal.Duration.from({hours:1})` needs the same carrier to be
callable as a static-method receiver. `Object.keys(Temporal).length === 9` is
the only one of the three assertions that would pass today. Writing a smoke test
that asserts only that would hide what is missing, so the reduction above is the
deliverable instead.

## S2g findings (2026-09-08) — construct-from-a-class-VALUE fixed; the stop moves to PROTOTYPE members

### R14 — `new K(…)` on a class value now runs the constructor body

S2f's three-line reduction reproduces exactly as recorded (`mk(PlainDate).y`
answered an `Object.create(null)`-shaped object, not `5`). Two things were
missing, not one:

| # | missing piece | where it was |
| --- | --- | --- |
| 1 | a per-class entry point that runs the ctor from an args vec | nowhere — the driver only knew how to dispatch a CLOSURE |
| 2 | admission of a MEMBER callee under standalone | `tryCompileNativeConstructFromValue` took identifiers only, so `new NS.PlainDate(…)` never reached any construct path and evaluated to **null** |

**The mechanism** — `src/codegen/standalone-class-construct.ts`:

```
__class_construct_<Name>(args: externref-vec, argc: i32) -> externref
    a_i = i < argc ? coerce(args[i]) : <zero of the formal's type>
    (new.target := <Name>; __argc := min(argc, formals))
    return box(<Name>_new(a_0 … a_n))

__class_construct_dispatch(callee, args, argc) -> externref
    ref.eq the callee against each class-object singleton; on a hit, tail into
    that class's trampoline. No hit ⇒ null.
```

Keyed by **identity**, not type — the same discriminator R13 needed for
`typeof`, and for the same reason (a class value is a `$ClassName` struct with
the same type and `__tag` as an instance, so no `ref.test` can separate them).
The null answer is what lets both callers keep their previous behaviour
verbatim on a miss.

Two callers, one dispatcher:

- `fillNativeConstructDrivers` — an arm ahead of the ordinary §10.2.2 tail;
- `__js2wasm_link_construct` (the R12 provider terminal) — the SAME arm, which
  is why `new NS.PlainDate(…)` works across the host-free boundary. Its ordinary
  tail had the identical defect.

`<Name>_new` is the constructor entry a STATIC `new Name(…)` calls, so field
initializers, `super(…)` and parameter defaults come from the one lowering
rather than a second copy of it. Missing arguments are zero-padded and the real
defaults come from the callee's own prologue via the `__argc` global (#5244) —
the trampoline publishes `min(argc, formals)`. Argument marshalling is
`closed-method-dispatch.ts`'s, extracted verbatim to
`src/codegen/extern-arg-marshal.ts` so the #5380 omitted-argument sentinel has
one implementation for both callers (that extraction makes
`closed-method-dispatch.ts` **shrink**).

**R14b — `__reflect_is_constructor` had no class arm.** With the trampolines in
place the boundary still returned an empty object, because the provider's
`callableKind` terminal publishes bit 1 from `__reflect_is_constructor`, which
answered 0 for a class-object singleton — so the consumer's driver never asked
the owning module at all and fell into its own ordinary tail. Same identity arm,
standalone/WASI only.

Measured (`.tmp/r1.js` … `.tmp/r6.js`, `.tmp/linkprobe.mts`):

| probe (`--target standalone`, `hostBridge:"off"`) | base | after |
| --- | --- | --- |
| `mk(PlainDate).y` (the S2f reduction) | `Object.create(null)`-shaped | **5** |
| more args than declared / fewer (default runs) / `super(…)` / field initializer | 0 / 0 / 0 / 0 | 5 / 7 / 10 / 7 |
| `new K(3)` on a plain function value (control) | 3 | 3 |
| `new NS.PlainDate(2024,1,1)` through the linked boundary, host-free | **null** | an instance; `.y` = 2024, `.d` = 1 |

**Byte A/B** (sha256, 6 modules × 2 targets, `.tmp/ab-base.txt` vs
`.tmp/ab-new3.txt`): all twelve identical, gc AND standalone. The gate is a
`new <runtime value>` site in the module (or being a wasm-consumed provider),
not "a construct driver exists" — `array-species.ts` / `array-from-native.ts`
reserve a driver in any module that touches those builtins, and gating on that
changed a two-class module with no dynamic `new` by **+134 B**.

**Pre-existing red, NOT caused by this slice** (measured both ways, base =
`issue-5383-standalone-temporal-s2f` with the S2g files reverted by file copy):
`tests/issue-2026-dynamic-new-spread.test.ts` (5),
`tests/issue-2026-dynamic-new-varspread.test.ts` (5) and
`tests/issue-3981-standalone-construct-function-value.test.ts` (1, "links the
instance to the constructor's prototype") fail **identically — the same 11 —
before and after**. Two of the three are gc-lane tests, which the byte A/B
already says this slice cannot touch. Worth an owner; not this one.

### The NEW stop — a PROTOTYPE member of a class instance, read dynamically

Not a boundary defect. It reproduces in ONE standalone module, 6 lines, no
Temporal (`.tmp/r6.js`):

```js
class PlainDate { constructor(d) { this._d = d; } get day() { return this._d; } sum(k) { return this._d + k; } }
function readDyn(o, k) { return o[k]; }
function callDyn(o) { return o.sum(1); }
export function accessor() { const v = readDyn(new PlainDate(7), "day"); return typeof v === "number" ? v : -1; }
export function method()   { return callDyn(new PlainDate(7)); }
export function ownField() { const v = readDyn(new PlainDate(7), "_d"); return typeof v === "number" ? v : -1; }
```

| probe | answer |
| --- | --- |
| `ownField` — dynamic read of an OWN field | **7** (works) |
| `method` — dynamic CALL of a prototype method | **8** (works, via `__call_m_sum_1`) |
| `accessor` — dynamic READ of a prototype ACCESSOR | **−1**, i.e. `undefined` |

A dynamic read of a prototype METHOD is the same miss (`typeof o["day"]` is
`"undefined"` for `day() {…}` too). So the generic `__extern_get` ladder serves
own fields but never consults the class PROTOTYPE; only the dynamic-method-CALL
path (`closed-method-dispatch`) does, and that path is module-local.

Across the boundary both halves fail, and for two different reasons — worth not
re-deriving (`.tmp/linkprobe.mts` with `.tmp/prov2.js` / `.tmp/cons2.js`):

| consumer probe on a provider-owned value | answer |
| --- | --- |
| `d.y` (own field) | 2024 ✓ |
| `typeof d.day` (prototype method, read) | `"undefined"` |
| `d.day()` (prototype method, called) | throws — "is not a function"; the closed dispatcher's arms are module-local and there is **no `__js2wasm_link_method_call` terminal** |
| `NS.PlainDate.mk(7)` (STATIC method on the class value) | throws, same shape |

**Consequence for the S2 smoke test: still not writable, and the missing piece
is now named.** `new Temporal.PlainDate(2024,1,1).day` needs the accessor read
(module-local defect above); `Temporal.Duration.from({hours:1}).total("minutes")`
needs BOTH a static-method read on a class value and a method call on a
provider-owned instance. `Object.keys(Temporal).length === 9` remains the only
one of the three that passes today, and asserting only it would hide exactly
this. The next slice is therefore: (a) make the generic dynamic member read
consult the class prototype (own-field ladder → prototype accessors/methods),
and (b) add the `method_call` terminal to `standalone-link-boundary.ts` beside
`memberGet`/`apply`, wired into the consumer's `__extern_method_call` miss path.

## S2h findings (2026-09-08) — the prototype-member read fixed, module-locally and across the boundary; the stop moves to STATICS

### R15 — a runtime-key read now consults the class PROTOTYPE (standalone)

S2g's six-line reduction (`.tmp/r6.js`) reproduces exactly as recorded. The fix
is three separate pieces, and each one was independently necessary — measured in
this order, because each only became visible once the previous was in place.

| # | missing piece | where it was |
| --- | --- | --- |
| 1 | the lookup only knew classes with a RUNTIME-KEYED member | `class-proto-lookup.ts::classesNeedingLookup` seeds from `ctx.classDynamicMembers` only |
| 2 | for every other class `__proto_<C>` is LAZY, so a widened lookup answers **null** | ClassDefinitionEvaluation force-builds the prototype `$Object` only for a #5195 seed |
| 3 | the delegation ran the getter with the **PROTOTYPE** as `this` | `__extern_get(proto, key)` — §6.2.5.5 threads the RECEIVER, not the walk cursor |

Piece 2 is #5195's own deferred "Step 4.3 needs the force-init question answered
for the general case first", and it is why widening ALONE measures as **zero**:

| `.tmp/r6.js` probe (`--target standalone`, `hostBridge:"off"`) | base | widen only | + builder | + receiver |
| --- | --- | --- | --- | --- |
| `readDyn(new PlainDate(7), "day")` — prototype ACCESSOR | −1 | −1 | THROW | **7** |
| `readDyn(new PlainDate(7), "sum")` — prototype METHOD value | 0 | 0 | **1** | 1 |
| `f = readDyn(…, "sum"); f.call(new PlainDate(3), 1)` | −1 | −1 | **4** | 4 |
| `readDyn(new PlainDate(7), "_d")` — OWN field (control) | 7 | 7 | 7 | 7 |
| `new PlainDate(7).sum(1)` — closed dispatcher (control) | 8 | 8 | 8 | 8 |
| `o[k](2)` — dynamic method CALL (control) | 9 | 9 | 9 | 9 |

The THROW column is the whole argument for piece 3 and it was only observable
after piece 2: with the prototype built but the delegation left as a plain
`__extern_get(proto, key)`, `get day() { return this._d; }` ran against an
`$Object` that has no fields. `__reflect_get_receiver(proto, key, recv)` — the
runtime's existing one-shot explicit-receiver channel, already consumed at the
top of `__extern_get` for `Reflect.get` — is the fix, and it needed no new
machinery. A METHOD read is insensitive to it (a data property does not read
`this`), which is exactly what made the accessor miss look like an
accessor-INSTALL bug for a while.

**The mechanism** — `src/codegen/standalone-class-dyn-member.ts`:

```
read site (o[k], k not numeric, standalone)  ->  record the class family in
                                                 ctx.standaloneRuntimeKeyClassProtos
finalize                                     ->  mint __class_proto_build_<C>()
                                                 ( = emitLazyProtoGet + drop )
__class_proto_lookup arm                     ->  if __proto_<C> is null: call the builder
__extern_get delegating arm                  ->  __reflect_get_receiver(proto, key, recv)
```

Demand-recording mirrors #5358's host-lane twin
(`recordRuntimeKeyClassMethodRead`) arm for arm, and the two are lane-disjoint —
that one returns early under standalone, this one under a JS host — so a read
site calls both unconditionally.

**Two ordering findings, both silent when wrong.**

- The builder must be minted **before the `__call_fn_method_<N>` dispatchers are
  emitted**, not beside the lookup fill it feeds. The builder creates the
  getter's canonical closure singleton, and `__call_accessor_get` dispatches
  through `__call_fn_method_<arity>`; minting later left the accessor's arity
  with no dispatcher, so `fillAccessorDrivers` used its return-undefined
  fallback. The prototype object itself was **correct** the whole time — the
  accessor property WAS installed, `__reflect_get_receiver` DID resolve — and
  the read still answered `undefined`.
- `index.ts` has **two** finalize blocks and they order these two phases
  **oppositely**: `generateModule` runs the closure exports first and the lookup
  fill much later; `generateMultiModule` runs the lookup fill first. So "before
  the dispatchers" and "before the fill" are different positions, and only the
  earlier of the two satisfies both. Getting this wrong cost a full
  measure-and-re-measure cycle: every single-module probe passed while every
  BOUNDARY probe answered `undefined`, because in the multi-module path the fill
  saw an empty demand set.

**Byte A/B** (sha256, 7 modules × {gc, standalone}, `.tmp/ab-base.txt` vs
`.tmp/ab-new2.txt`): **13 of 14 identical**. The gc lane is identical for all
seven, INCLUDING the module that has the dynamic read. The one that moves is
`m7-dynread.js` under standalone (138,874 -> 146,074 B) — a standalone module
that actually performs a runtime-key read, which is exactly the gate. The corpus
spans: no class at all, class+methods, class+accessors, inheritance,
array/string, an object literal, and the dynamic-read module.

### R16 — `__js2wasm_link_method_call`, and why `memberGet` + `apply` is not enough

With R15 in place the boundary READ crosses, and the CALL still did not:

| consumer probe on a provider-owned value (`.tmp/linkprobe.mts`) | S2g base | after R15 | after R16 |
| --- | --- | --- | --- |
| `d.y` — own field | 2024 | 2024 | 2024 |
| `d.day` — prototype ACCESSOR | −1 | **1** | 1 |
| `typeof d.sum` — prototype METHOD value | 0 | **1** | 1 |
| `d.sum(1)` — prototype METHOD call | throws "is not a function" | throws | **2025** |
| `f = d.sum; f.call(d, 1)` — extracted | null | null | routes through the terminal |
| `Object.keys(NS).length` | 2 | 2 | 2 |

The read handing back a working value did **not** make the call work, and the
reason is worth not re-deriving: what crosses is the provider's method-closure
SINGLETON, whose trampoline resolves `this` from the **provider's**
`__current_this` global. The consumer has its own copy of that global, so
invoking the closure on the consumer side binds nothing — `f.call(d, 1)`
answered **null**, not a wrong number. The call has to happen on the side that
owns the receiver binding.

`__js2wasm_link_method_call(recv, name, args)` is that terminal, wired into the
consumer's `__extern_method_call` miss path exactly where the host lane's
`__boundary_object_call` sits (`boundaryObjectCallIdx ?? peerMethodCallIdx`), so
no consumer arm changed shape.

It is a **wrapper, not a re-export of `__extern_method_call`** — measured, after
publishing that native directly first. The native gates its resolve-then-apply
on `ref.test $Object`; a provider's own class instance is a closed `$ClassName`
struct, so it takes the non-`$Object` else arm and **the provider itself** threw
"is not a function". A provider has no `__call_m_<name>` dispatcher for the
method either: those are reserved per NAME at a CALL SITE, and a provider has no
call site for a method only its consumer calls. The wrapper does
resolve-then-apply directly (`__extern_get` -> `__apply_closure`), both halves
being correct on that side, and normalises a null/undefined resolution to
`ref.null.extern` = "not mine" so the consumer keeps its local answer — the same
contract the `memberGet` wrapper uses.

A provider also has no read site of its own to record R15's demand (the read
happens in the OTHER module), so a wasm-consumed provider seeds every class it
owns. That is the same argument the terminals themselves rest on: the provider
cannot know which key will be asked.

### The NEW stop — a STATIC method on a class VALUE

Not fixed, and **not regressed** — measured both ways by file-copy revert
(`.tmp/r7.js`, identical answers on the S2g base and on this branch):

| probe | module-local | across the boundary |
| --- | --- | --- |
| `typeof PlainDate.mk` via a runtime key | `"undefined"` | `"undefined"` |
| `K.mk(7)` through a dynamic receiver | throws "is not a function" | throws, same |
| `PlainDate[k](5)` with `k = "mk"` | `undefined` | — |

The class OBJECT is a `$ClassName` struct (#3976 deliberately did not convert
it: `emitDynamicNewFallback` `ref.test`s that value), so its static surface
lives in the #5195 Step 2 static **sidecar** — which is built only for a class
with a RUNTIME-KEYED static. `__class_proto_lookup`'s class-object arm already
routes a class-value receiver to that sidecar and answers **null** when there is
none, so widening is a self-contained next step rather than a new mechanism.

Widening is the rest of #5195 cluster B and is **not** free: the sidecar carries
static METHODS and ACCESSORS but deliberately not static FIELDS (mirroring a
mutable slot would create two sources of truth), so routing every class-value
read through it would shadow the `staticProps` lowering for a static field. That
precedence question has to be answered before the widening, which is why it is
its own slice.

**Consequence for the S2 smoke test:** two of the three assertions are now
reachable and one is not.

| assertion | state |
| --- | --- |
| `Object.keys(Temporal).length === 9` | passed before this slice |
| `new Temporal.PlainDate(2024,1,1).day === 1` | the prototype-ACCESSOR read this slice fixes (R15, proven on the reduction and through a real linked provider) |
| `Temporal.Duration.from({hours:1}).total("minutes") === 60` | **still blocked** — needs the static read above |

So the three-assertion smoke test is not writable as a whole, and asserting only
the passing subset would hide exactly the stop that is left. What is committed
instead is the reduction-level guard for both halves that now work —
module-local (accessor / method value / method `.call`, plus the three controls)
and host-free across a real linked provider (accessor, method value, method
CALL, own field, key count) — with the static case as an `it.todo` naming the
stop.

**Pre-existing red, NOT caused by this slice** (measured both ways, base = this
branch with the four touched files reverted by file copy): `tests/issue-2151.test.ts`
(1, "wasi: custom iterable driven via any-method .next()") and
`tests/issue-2151-mixed-spread.test.ts` (1, "empty dynamic spread: trailing
numeric param reads 0") fail **identically — the same 2 — before and after**.

## S2i findings (2026-09-12) — the STATIC read fixed, module-locally and across the boundary; the stop moves OFF the class surface entirely

### The precedence question S2h deferred, answered by measurement BEFORE widening

The sidecar carries static METHODS and ACCESSORS and deliberately not static
FIELDS (a mirrored mutable slot would be two sources of truth). S2h's stated
blocker was that routing every class-value read through it "would shadow the
`staticProps` lowering for a static field".

**It does not, and there was never an overlap to shadow.** `ctx.staticProps` is
a purely SYNTACTIC lowering — `C.sf` becomes `global.get __static_C_sf`
(`property-access-dispatch.ts`). There is no runtime name→slot map, so the
DYNAMIC read never consulted it. Measured on the six-export reduction
(`.tmp/probe.mts`, one module, `--target standalone` / `hostBridge:"off"`),
base = this branch with the five touched files reverted by file copy:

| probe (`readDyn(o,k)` is an externref-receiver runtime-key read) | base | after |
| --- | --- | --- |
| `readDyn(C, "mk")` — static METHOD value, then `f(5)` | `undefined` (−1) | **6** |
| `readDyn(C, "acc")` — static ACCESSOR | −1 | **11** |
| `C[k](5)`, `k` not const-folded — static CALL | −1 | **6** |
| `K.mk(7)` via a dynamic receiver — named static CALL | **THROW** "is not a function" | **8** |
| `typeof K.mk` via a dynamic receiver | 0 | **1** |
| `K.acc` via a dynamic receiver | −1 | **11** |
| `readDyn(C, "sf")` — static FIELD | `undefined` | `undefined` |
| `readDyn(C, "sf")` AFTER `C.sf = 42` | `undefined` | `undefined` |
| `C.sf` / `C.sf` after the write — TYPED | 7 / 42 | 7 / 42 |
| `C.mk(5)` / `C.acc` — TYPED (controls) | 6 / 11 | 6 / 11 |
| `readDyn(new C(3), "day")` — S2h prototype (control) | 3 | 3 |
| `new K(3)._d` via a dynamic receiver (S2g control) | 3 | 3 |

So the answer is: **the typed ladders keep `staticProps` as the one source of
truth for a static field — including after a write — and the sidecar answers
only the method/accessor surface.** The residual is the pre-existing #5195 one
(a dynamic read of a static FIELD is `undefined` rather than its value),
unchanged in either direction. Closing it does NOT require the two-sources-of-
truth mirror S2h feared: the field could be installed as an ACCESSOR PAIR over
its own `staticProps` global, which keeps the global authoritative. That is a
slice of its own (a per-field minted getter/setter) and is not done here.

### The mechanism

```
read site (o[k] / C[k], k not numeric, standalone)  ->  the SAME demand set S2h
                                                        records, ctx.standaloneRuntimeKeyClassProtos
finalize (before the closure dispatchers)           ->  mint __class_static_build_<C>()
                                                        ( = register the sidecar global,
                                                          then emitClassStaticSidecar + drop )
__class_proto_lookup class-object arm               ->  if __static_<C> is null: call the builder
__extern_method_call (prepended)                    ->  lookup non-null? resolve via __extern_get,
                                                        and if it RESOLVES, __apply_closure
```

Three findings worth not re-deriving.

- **The demand set is SHARED with S2h's, not a new one, and that is forced.**
  A class OBJECT and its instances are the SAME wasm struct type (`$C`) — the
  whole of #3976. At a read site the only narrowing available is the receiver's
  struct type (or nothing, for an externref), so "may land on an instance of C"
  and "may land on the class object C" are literally the same predicate. A
  separate set would be populated from the identical condition at the identical
  two sites.
- **The sidecar global is registered at FINALIZE**, not at class collection,
  which is what keeps a module with statics but no dynamic read byte-identical
  (`m3-statics` in the A/B below). That exposed a latent bug: of the class
  global maps, `classStaticSidecarGlobals` was the only one NOT in the
  late-import shift block, so a string-constant import inserted after
  registration left every baked read one slot off. Fixed in the same place as
  `protoGlobals` / `classObjectGlobals`.
- **Making the VALUE resolve did not make the CALL work, and the split is the
  same one S2h hit at the boundary.** With only the read arm in place,
  `typeof K.mk` answered `1` and `const f = C[k]; f(5)` answered `6` while
  `K.mk(7)` still threw: `__extern_method_call`'s resolve-then-apply is
  `ref.test $Object`-gated and a class object is a `$ClassName` struct, so it
  fell to the non-`$Object` arm and hit the resolved-callee guard. The prepended
  arm resolves FIRST and takes over only when the member actually resolves,
  which is why it can sit at the front without claiming any receiver it does not
  own.

**Byte A/B** (sha256, 7 modules × {gc, standalone}, `.tmp/ab-base.txt` vs
`.tmp/ab-new.txt`): **13 of 14 identical**. The gc lane is identical for all
seven. The one that moves is `m7-dynread` under standalone
(147,837 → 148,141 B, +304) — the only module in the corpus that performs a
runtime-key class-member read, which is the gate. In particular `m3-statics`
(a class with a static field, a static method and a static accessor, no dynamic
read) is byte-identical under BOTH targets, and so is `m4-inherit` (statics
across an `extends`). The refactor that split `fillClassProtoLookupArm` for the
#3400 budget was separately verified byte-neutral.

### The S2 smoke test is still not writable — and the stop moved OFF the class surface

Through a REAL provider (`buildTemporalProvider` + `compileWithTemporalGlobal`,
`--target standalone` / `hostBridge:"off"`, host-free
`instantiateLinkedProject(result, {})`, provider 3,311,806 B, `.tmp/smoke.mts`):

| consumer probe on the linked `Temporal` | answer |
| --- | --- |
| `Temporal === null` / `Temporal === undefined` | 0 / 0 |
| `Object.keys(Temporal).length` | **0** (needs 9) |
| `Object.getOwnPropertyNames(Temporal).length` | 0 |
| `"PlainDate" in Temporal` | 0 |
| `new Temporal.PlainDate(2024,1,1).day` | −1 |
| `Temporal.Duration.from({hours:1}).total("minutes")` | throws |

This is a stop **AHEAD** of the static read this slice fixes, not behind it:
the namespace OBJECT crosses (non-null, `typeof` an object) while its entire
member surface reads empty, so all three smoke assertions fail on the FIRST
one — including `Object.keys(Temporal).length === 9`, which S2h's notes recorded
as already passing (that was the reduction lane, not the real provider).

What the measurement rules OUT: it is not the plumbing this slice touches, and
not the S2d/S2h boundary terminals in general. The identical shape built by
hand — `Object.freeze({__proto__: null, PlainDate, b: 2})` through a real
`compileProject` provider, host-free — crosses correctly in
`tests/issue-5383-standalone-temporal-provider.test.ts` ("STATIC members of a
PROVIDER-owned class value"): keys 2, static value, static CALL, static
accessor and the prototype accessor all reachable. The provider's raw export
list confirms every terminal is present (`__js2wasm_link_member_get`,
`__js2wasm_link_object_keys`, `__js2wasm_link_method_call`, …) and its import
list is empty.

What it does NOT yet isolate: whether the polyfill's exported `Temporal` is a
shape the provider's own `__extern_get` cannot serve, or whether the object
that crosses is a different one from the populated one. Calling the provider's
`__js2wasm_link_member_get` from JS answers null for `"PlainDate"`, but that is
NOT evidence — a standalone module's keys are wasm-native i16 arrays, so a JS
string argument is undecodable by construction. The decisive probe is one
INSIDE the provider, and the linker does not publish it: an extra
`export function __probe_keys()` appended to the polyfill source produces a
provider whose `exportBoundaries` still contains only `Temporal` (measured).
Getting that probe published is the first step of the next slice.

**Pre-existing red, NOT caused by this slice** (measured both ways, base = this
branch with the five touched files reverted by file copy and the new module
removed): `tests/issue-2151.test.ts` (1), `tests/issue-2151-mixed-spread.test.ts`
(1), `tests/issue-3610-standalone-prototype-receiver-brand.test.ts` (1) and
`tests/issue-1051.test.ts` (3) fail **identically before and after**.
`tests/issue-5318-r4-computed-accessor-keys.test.ts` OOMs the vitest worker on
BOTH trees (also at `--max-old-space-size=6144`), so it is not a signal either
way.

## S2j findings (2026-09-12) — the premise was wrong: there is no regression, and the stop is the whole wasm↔wasm VALUE ABI

Two results, and the second one supersedes every carrier-specific hypothesis in
S2c…S2i.

### 1. The bisect — `Object.keys(Temporal).length` was NEVER 9 through a real provider

The dispatch brief recorded a regression: 9 on 2026-09-08, 0 now, with ~94 main
commits (including #5795, "publish complete Temporal package generations") and
slice S2i in between. Measured at three points with one probe
(`.tmp/s2j-probe.mts`, `buildTemporalProvider` + `compileWithTemporalGlobal`,
`--target standalone` / `hostBridge:"off"`, host-free
`instantiateLinkedProject(result, {})`, a **fresh `JS2WASM_TEMPORAL_CACHE` per
point** so no stale artifact can answer for a compiler):

| point | what it is | keys | provider bytes | cache key | polyfill src sha | init |
| --- | --- | --- | --- | --- | --- | --- |
| `c01abc32` | S2h, main merged, **before** #5795 | **0** | 3,282,057 | `fcd881da30bc` | `68b811af2824` | ok |
| `8b42b7ab` | S2h, + S2f/S2g merged | **0** | 3,282,057 | `fcd881da30bc` | `68b811af2824` | ok |
| `d1f9cbb3` | S2i head (this stack) | **0** | 3,311,806 | `fcd881da30bc` | `68b811af2824` | ok |

So: **no regression, at any point.** `"PlainDate" in Temporal` is 0 and
`new Temporal.PlainDate(2024,1,1).day` is −1 at all three.

**#5795 is ruled out as an input change, by measurement rather than by argument:**
the linked polyfill source is byte-identical across it (same sha, same 157,541 B)
and so is the provider cache key. It moved WHERE the package generation lives,
not WHAT is compiled.

**Where the "9" came from.** It is a real number, measured INSIDE the provider
(S2c/S2d: `Object.keys(qi).length === 9` driving the polyfill from inside its own
module). S2f wrote "`Object.keys(Temporal).length === 9` is the only one of the
three assertions that would pass today" — an inference, not a boundary
measurement — and S2h restated it as "passed before this slice". S2i caught the
restatement but attributed the 0 to a new stop. It was never 9 across the
boundary; the in-provider figure was carried forward three slices as if it were.

### 2. The root cause — from the polyfill provider, NOTHING structured crosses

The decisive probe is not about `Temporal` at all (`.tmp/s2j-valueabi.mts`). Four
ordinary values are exported from the provider and read by the consumer, with the
tiny hand-built provider as the control — same consumer source, same link path,
same target:

| consumer read of a PROVIDER-minted value | tiny provider | polyfill provider |
| --- | --- | --- |
| `typeof num === "number"` → its value | 42 | **42** |
| `typeof str === "string"` | 1 | **0** |
| `str.length` / `str === "hello"` | 5 / 1 | **0 / 0** |
| `Array.isArray(arr)` / `arr.length` / `arr[0]` | 1 / 3 / 1 | **0 / 0 / −1** |
| `Object.keys({a:1,b:2}).length` / `.a` | 2 / 1 | **0 / −1** |

A number crosses (it is unboxed f64). **Every reference value is unreadable** — a
string is not even a string. So this is not the namespace carrier, not
`Object.freeze`, not `__proto__: null`, and not anything S2d…S2i touched: the
wasm↔wasm value ABI is dead for this provider, and `Temporal` was only the first
value anyone happened to read.

Four supporting measurements, each of which rules something out:

- **It is not size, and not a feature the module uses.** A grown provider (up to
  300 extra object shapes + 300 functions, 731 KB) crosses fine
  (`.tmp/s2j-grow.mts`), as does the tiny provider with each of 20 features added
  one at a time — `defineProperty`, `defineProperties`, getters/setters, `Proxy`,
  symbol keys, `for-in`, `delete`, `Object.create`, `seal`,
  `preventExtensions`, `setPrototypeOf`, `assign`, spread, computed keys, array
  expandos, `Map`/`WeakMap`, class statics, `Symbol.toStringTag`
  (`.tmp/s2j-feature.mts`, all 21 rows ok). Nor is it the export spelling: all six
  of `export const` / `export var` / `var`+alias / `const`+alias / `let`+alias /
  same-name re-export cross correctly (`.tmp/s2j-export-shape.mts`).
- **The provider side is correct.** Called from JS on the exact value the consumer
  receives, the polyfill provider's own terminals answer:
  `__js2wasm_link_object_keys(ns)` non-null, `__js2wasm_link_member_get(ns, k)`
  non-null — **with a PROVIDER-minted `k`** (`.tmp/s2j-terminal.mts`). With a
  CONSUMER-minted `k` the same call answers **null** for the polyfill provider and
  **non-null** for the tiny one — the same one-way failure the table above shows,
  in the other direction.
- **The wiring is correct and the consumers are identical.** Both providers export
  all six terminals; both consumers import all six; the two consumer binaries are
  the same size and the terminals' bodies call the right natives
  (`__js2wasm_link_object_keys` → `__object_keys` + `__extern_length`,
  `__js2wasm_link_member_get` → `__extern_get` + `__extern_is_undefined`) —
  disassembled in both (`.tmp/s2j-calls.mjs`).
- **The polyfill works perfectly INSIDE its own module**, through the generic
  dynamic path, not a folded one: with the answers computed at provider init and
  published as value exports, `Object.keys(qi).length` is 9, `"PlainDate" in qi`
  is 1, `typeof qi.PlainDate === "function"` is 1, and
  `new qi.PlainDate(2024,1,1).day` is **1** — and the same through a function
  parameter (`__p_dynKeys(qi)` 9, `__p_dynGet(qi,"Plain"+"Date")` 1), so it is not
  constant-folded (`.tmp/s2j-inside.mts`).

**Method note that unblocked all of this:** S2i recorded "the linker does not
publish an in-provider probe export". The real rule is narrower and usable — a
package export whose boundary is a FUNCTION with an inferred/`any` signature makes
the whole plan fall back to `bundled` ("inferred/any package signatures require
side-effect-free engine validation", `.tmp/s2j-facade.mts`). **VALUE exports are
getter boundaries and ARE published**, so any in-provider question can be answered
by computing it at module init and exporting the result. That is how the table
above was measured, and it is the tool the next slice needs.

### What the fix is NOT (two pieces built and measured, each necessary, both insufficient)

Both were implemented and then reverted rather than shipped, because neither moves
a user-visible answer and both change a hot native:

1. **The consumer never consults the peer for this receiver.** `ref.test $Object`
   SUCCEEDS on the provider-minted namespace, so the S2d miss-path arms — which
   sit in the NOT-a-`$Object` branch — are unreachable, and the `$Object` walk
   reads an ordered map that enumerates nothing. Peer call count measured at
   **zero** for `Object.keys` / `.b` / `in` (`.tmp/s2j-count.mts`). Adding a
   terminal consult in `__extern_get` and a zero-keys consult in `__object_keys`
   makes the peer fire.
2. **It still answers 0.** With the consult in place `__js2wasm_link_object_keys`
   returns **non-null** — and `Object.keys(...).length` on the returned vec is
   still 0, because the provider-minted key vec is itself unreadable by the
   consumer. Which is finding 2 again: the answer cannot cross either.

So a miss-path change alone cannot fix this, and the ordering matters — piece 1 is
required before piece 2 is even observable.

### The next stop, exactly

**Why is the polyfill provider's type space not shared with its consumer, when the
tiny provider's is?** The first rec group (10 types, including the string struct
`$11`) is textually identical in both providers, so the canonical prefix is not
obviously the difference; the poly provider declares 618 types in the prefix the
consumer declares 130 of, in a different order. The reduction is
`.tmp/s2j-valueabi.mts`: four one-line value exports, a nine-line consumer, tiny
vs polyfill, ~60 s. It needs no Temporal knowledge at all, and every earlier
Temporal-specific symptom should fall out of it.

## S2k findings (2026-09-12) — confirmed: one `final` bit on one rec-group member killed the whole value ABI

S2j's stop is resolved. The rec-group hypothesis was correct, and the mechanism
is narrower and more mundane than "the polyfill's type space is different".

### The type-section comparison

`.tmp/s2k-types.mjs` reads a module's type section raw (no Binaryen, no names,
no absolute indices) and renders each recursive group index-relatively.
Measured on the four binaries S2j's `.tmp/s2j-dump.mts` produces:

| module | groups / types | canonical group `[0..9]` hash |
| --- | --- | --- |
| consumer (identical source in both runs) | 121 / 130 | `2d74afdb81b1` |
| tiny provider (works) | 123 / 132 | `2d74afdb81b1` |
| **polyfill provider (fails)** | 1057 / 1066 | **`bc74a429728b`** |

Group `[0..9]` is the frozen link ABI — `RUNTIME_RECGROUP_TYPE_NAMES`: the vec
family (`__vec_base`, `__arr_externref`, `__vec_externref`, `__arr_f64`,
`__vec_f64`) and the string family (`__str_data`, `AnyString`, `NativeString`,
`ConsString`, `HashedString`). Diffing it member by member, **nine of ten are
byte-identical and exactly one differs**:

```
2 DIFF
   consumer: subfinal[t0] struct(mut i32,mut (ref null t1))   # $__vec_externref
   provider: sub     [t0] struct(mut i32,mut (ref null t1))
```

S2j's note that "the first rec group is textually identical in both providers"
compared the two PROVIDERS to each other at a coarser granularity; the
difference is provider-vs-consumer, and it is one bit.

### The mechanism

WasmGC canonicalizes a recursive type group **as a whole**, and finality is
part of a member's structure. So a single differing `final` bit makes all ten
types a *different runtime type* in the engine. Every consumer-side check on a
peer-minted value is a type-identity test — `ref.test $AnyString` for
`typeof x === "string"`, `ref.test $__vec_externref` for `Array.isArray`, the
`$Object` walk for `Object.keys` — so all of them fail at once, while an
unboxed `f64` crosses fine because it is not a reference. That is precisely the
S2j table, and `Temporal` was only the first value anyone happened to read.

**Why the bit differed.** `markLeafStructsFinal` (`src/codegen/fixups.ts`)
marks a struct `final` when nothing in *that module* subtypes it. The polyfill
uses `arguments`; on the standalone lane that registers
`$__arguments_vec_externref` as a subtype of `$__vec_externref`
(`getOrRegisterArgumentsVecType`, `src/codegen/registry/types.ts`), and
`arguments-length-brand.ts` hangs a further 5-field subtype off that. The
consumer uses no `arguments`, so its `$__vec_externref` stayed a leaf and went
`final`. Confirmed by walking the subtype chain in the failing binary
(`.tmp/s2k-chain.mjs`): `t697 <: t2`, `t698 <: t697`, and nothing else in the
module touches the group.

`arguments` is only the *trigger that happened to be reachable*. Any
module-local subtype of any group member does the same thing, which is the real
defect: **the identity of a frozen cross-module ABI was a function of module
content.**

### The fix

`finalizeLeafStructTypes` (`src/codegen/index.ts`) now adds every member of the
canonical group to `keepOpenTypeIdxs`, so all ten are emitted non-final
unconditionally and the group's encoding is a constant of the ABI. This reuses
the mechanism `markLeafStructsFinal` already documents for exactly this reason
("ABI roots whose non-finality is observable across separately compiled
modules" — the funcref-wrapper root, and #5349's ArrayBuffer byte vec).

Gated on `mod.canonicalRuntimeRecGroup` being present, which
`createCodegenContext` sets only for runtime providers, linked namespaces, or
explicit `canonicalRuntimeTypes`. **Byte A/B over 20 artifacts** (10 module
shapes × {gc, unlinked standalone}, `.tmp/s2k-ab.mts`, base captured by file
copy before the first edit): every sha256 identical. The JS-host lane and any
standalone module that is not part of a link are untouched.

No struct-shape collision is reintroduced (#2158 `$AnyString` vs the empty-class
root, #5194 `$__ta_ctor`, S2f R11): the change only clears `final`, it does not
merge, reshape or reorder anything, and `tests/issue-2158-class-identity-standalone.test.ts`
(whose whole subject is AnyString canonicalization) passes.

After the fix all three canonical groups hash `2a034407b1d9`, and S2j's own
`.tmp/s2j-valueabi.mts` reduction reads identically for the tiny and polyfill
providers: `strType 1, strLen 5, strEq 1, arrIs 1, arrLen 3, arr0 1,
objKeys 2, objA 1`.

### The S2 smoke test, per assertion

Through the shipped path (`buildTemporalProvider` + `compileWithTemporalGlobal`,
`--target standalone` / `hostBridge:"off"`, host-free), now a permanent test via
`tests/dogfood/temporal-s2-smoke-harness.mjs`:

| assertion | base (S2j, all three bisect points) | S2k |
| --- | --- | --- |
| `Object.keys(Temporal).length === 9` | 0 | **9 — passes** |
| `new Temporal.PlainDate(2024,1,1).day === 1` | −1 | **1 — passes** |
| `Temporal.Duration.from({hours:1}).total("minutes") === 60` | threw | still throws — `it.todo` |

The harness runs as a child process: the 3.3 MB provider compile OOMs a vitest
worker in-process (measured — a V8 OOM before the first assertion), the same
reason every other dogfood adapter is a child process.

### The next stop, exactly (`total`)

Not a boundary problem any more, and not this slice's lane. The Duration
crosses and reads correctly (`Duration.from({hours:1}).hours === 1`,
`typeof d.total === "function"`), and `.total(…)` fails **identically inside the
provider's own module** (`.tmp/s2k-inside-total.mts`, via the S2j value-export
trick), with the error text:

```
RangeError: unit must be one of year, month, week, day, hour, minute, second,
millisecond, microsecond, nanosecond, null, null, null, null, null, null,
null, null, null, null, not minutes
```

The ten PLURAL unit names are missing. They come from the polyfill's
`ot = Object.fromEntries(nt.map(([e, t]) => [t, e]))`. Reduced
(`.tmp/s2k-red2.mts`, standalone / host-free):

| form | result |
| --- | --- |
| `Object.fromEntries([["year","years"]])` (literal pairs) | works |
| `Object.fromEntries(nt.map(([e,t]) => [t,e]))` | keys present (3), **values `undefined`** |
| `Object.fromEntries(nt.map(e => [e[1],e[0]]))` | **COMPILE FAIL** — `'__object_fromEntries' (dynamic-shape object/property operation) is not yet supported in --target standalone` |
| `Object.fromEntries(nt.map(function (e) {…}))` | **COMPILE FAIL** — same |

So `Object.fromEntries` over a computed pair list is partly unimplemented on the
standalone lane, and in the destructured-arrow form the polyfill happens to use
it **silently builds the right keys with lost values** — the worse of the two
failures, and the one to fix first.

### Pre-existing red, unchanged by this slice

`tests/issue-2151.test.ts` (1), `tests/issue-2151-mixed-spread.test.ts` (1),
`tests/issue-3610-standalone-prototype-receiver-brand.test.ts` (1) and
`tests/issue-1051.test.ts` (3) — 6 failures, exactly the count recorded on the
base branch. `tests/issue-5318-r4-computed-accessor-keys.test.ts` OOMs on both
trees and is not a signal either way.

## S2l findings (2026-09-12) — `Object.fromEntries` over a computed pair list, standalone

S2k's stop is closed. Both shapes it named turned out to be ONE call site with
two independent defects, and neither was a capability boundary — each was an
accident of something unrelated.

### (A) The silent-wrong values: a pair is a TUPLE STRUCT, and the dyn reader had no arm for one

`Object.fromEntries`'s lib signature is `Iterable<readonly [PropertyKey, T]>`.
That contextual type reaches the callback, so `([e, t]) => [t, e]` returns a
**tuple**, and `resolveWasmType` lowers a heterogeneous tuple to a nominal
struct — `$__tuple_0 (struct (field $_0 externref) (field $_1 externref))` —
not to the indexable pair vec the identical expression produces when it is
bound to an `any` local first. Confirmed by diffing the two type sections
(`.tmp/s2l-wat.mts`): the inline form carries `$__tuple_0` and a
`$__vec_ref_51` (vec OF tuple); the via-a-local form carries neither and uses
`$__vec_ref_2` (vec of `$__vec_externref`).

The self-hosted `__object_fromEntries` (`src/stdlib/object-runtime.ts`) reads
each pair with `__extern_get_idx(pair, 0)` / `(pair, 1)`. That helper had arms
for `$ObjVec`, typed vecs (`fillExternGetIdxVecArms`) and closed array-like
structs (`fillExternArrayLikeStructArms`, which requires a real `length` field
AND canonical integer field names) — **none of which a tuple matches**. It
answered `undefined` for both slots, so all ten polyfill entries wrote
`out[undefined] = undefined` and the table came out as the single key
`"undefined"`. That is why the RangeError listed `null` ten times.

**Fix**: `fillExternArrayLikeStructArms` now admits tuple carriers as a third
array-like shape — length = field count (a constant, no field to read), `_i` =
index `i` — `ref.test`-guarded per type like every other arm. A TS tuple value
IS a JS Array at runtime, so this is the spec answer, not a workaround; it is
also the same answer the JS-host lane already gets from #5205's `__sget_*`
struct-read exports.

### (B) The refusal: decided by unrelated module CONTENT, not by the construct

`ensureLateImport` returns a funcMap hit **before** the #1472 Phase B refusal
check. `__object_fromEntries` is in funcMap only when something else in the
module already pulled in `ensureObjectRuntime`. So the outcome depended on what
else the module happened to contain:

| form (`nt: any[]` of pairs) | base | S2l |
| --- | --- | --- |
| `Object.fromEntries([["year","years"]])` (array literal) | works | works (same bytes) |
| `Object.fromEntries(nt.map(([e,t]) => [t,e]))` | 1 key `"undefined"` | **3 keys, right values** |
| `Object.fromEntries(nt.map((e) => [e[1],e[0]]))` | 1 key `"undefined"` | **3 keys, right values** |
| `Object.fromEntries(nt)` | **REFUSED** | **3 keys, right values** |
| `Object.fromEntries(nt.slice(0))` / `.concat([])` / `.map((e) => e)` | **REFUSED** | **3 keys, right values** |
| `Object.fromEntries(mk())` where `mk(): any` | REFUSED | REFUSED (arg not statically array/tuple) |
| `Object.fromEntries(someMap)` | REFUSED | REFUSED — deliberate, see below |

S2k's table recorded `nt.map((e) => [e[1],e[0]])` as a COMPILE FAIL and the
destructured form as compiling. Re-measured here (`.tmp/s2l-red.mts`,
`.tmp/s2l-red3.mts`) both compiled — the difference is module content, which is
the finding rather than a discrepancy.

**Fix**: the call site ensures the object runtime itself and calls the native
directly when `ctx.oracle.typeFactOf(entriesArg)` says `array` or `tuple`. No
new host import — the native is a defined function, so no import is added and
no index shifts (#1984).

**A non-indexable iterable deliberately KEEPS refusing.** For a `Map` the
native would walk with `__extern_length` → 0 and hand back `{}` — precisely the
silent-wrong failure this slice exists to delete. Native iterator-protocol
consumption is #2190; until then the loud compile error is the correct answer.

### Byte A/B

12 module shapes × {gc, unlinked standalone} = 24 artifacts (`.tmp/s2l-ab.mts`,
base captured by file copy before the first edit). **23 of 24 sha256-identical.**
The single difference is `fromEntriesMap:standalone` — the direct subject. In
particular the gc lane is identical for all 12 shapes (including `tuples`,
`arraylike`, `maps`, `objects`), and standalone modules that do not use
`Object.fromEntries` over a computed list — including the `tuples` and
`arraylike` shapes — are byte-identical, because the tuple arms are minted only
when the standalone dyn-reader trio is reserved AND a tuple type exists.

### test262

`built-ins/Object/fromEntries/**`, all 25 files × {gc, standalone}, run solo via
`runTest262File` (`.tmp/s2l-t262.mts`):

| | gc pass | gc fail | sa pass | sa fail | sa compile_error |
| --- | --- | --- | --- | --- | --- |
| base | 13 | 12 | 9 | 15 | 1 |
| S2l | 13 | 12 | 9 | 15 | 1 |

**0 of 50 rows changed**, so 0 pass→fail. No gain either: the remaining rows
exercise generic iterables / iterator-close observability, which is #2190's
lane, not this one.

### The S2 smoke test, per assertion

| assertion | S2k | S2l |
| --- | --- | --- |
| `Object.keys(Temporal).length === 9` | passes | passes |
| `new Temporal.PlainDate(2024,1,1).day === 1` | passes | passes |
| `Temporal.Duration.from({hours:1}).total("minutes") === 60` | `it.todo` (unit table) | still `it.todo` — **new stop, named below** |

### The next stop, measured — a JSBI instance is implicitly ToNumber'd

The unit table is fixed; the error message CHANGED, which is what makes this a
new stop rather than the old one. Measured with the polyfill compiled as ONE
standalone module (the Intl shim + the linked bundle + a probe export, plain
`compile({target:"standalone", hostBridge:"off"})` — `.tmp/s2l-solo-total.mts`),
so no link is involved, and re-measured with only the two S2l source files
reverted by file copy:

| tree | message length | `null`s | text |
| --- | --- | --- | --- |
| base | 175 | 10 | `unit must be one of year, …, nanosecond, null ×10, not minutes` |
| S2l | 58 | 0 | ``Convert JSBI instances to native numbers using `toNumber`.`` |

That is JSBI's own `valueOf` guard: something on the `total` path applies an
implicit ToNumber/ToPrimitive to a JSBI BigInt instance instead of calling
`toNumber()`. It is **not** caused by this slice — `total("minute")`, a
SINGULAR unit that was always present in the table, fails identically on both
trees.

Two further facts, each measured on BOTH trees so neither is an S2l regression:

- **A provider-side throw does not cross the link as a catchable JS error.**
  The consumer's own `try { d.total(…) } catch (e) { … }` never runs — the raw
  `WebAssembly.Exception` escapes to the embedder. So the smoke harness's
  `total` probe can only ever report `throw`, never the message.
- **The harness's `durationHasTotal` probe reads 0 on both trees**, while the
  identical question through a bound local (`const d = …; typeof d.total`) reads
  1 (`.tmp/s2l-method-red.mts`). That is #2984's path-dependent `typeof` on a
  CHAINED member access, not a missing method: `d.toString()` works across the
  same boundary, and a tiny hand-written provider answers the whole chain
  including `d.total("minutes") === 60`. S2k's note that `typeof d.total ===
  "function"` was measured through a different probe than the harness's.

### Acceptance criteria — S2 smoke test status (2026-09-12)

**Two of the three S2 assertions pass through the real standalone provider and
are asserted as a real test** (`tests/issue-5383-standalone-temporal-provider.test.ts`,
`#5383 S2 smoke`): `Object.keys(Temporal).length === 9` and
`new Temporal.PlainDate(2024,1,1).day === 1`, plus the `durationHours === 1`
precursor. The third, `Temporal.Duration.from({hours:1}).total("minutes") === 60`,
does **not** pass and remains `it.todo`, now blocked on the JSBI implicit-
ToNumber stop above rather than on `Object.fromEntries`.

### Pre-existing red, unchanged by this slice

`tests/issue-2151.test.ts` (1), `tests/issue-2151-mixed-spread.test.ts` (1),
`tests/issue-3610-standalone-prototype-receiver-brand.test.ts` (1) and
`tests/issue-1051.test.ts` (3) — the same 6 recorded on the S2k base.
`tests/issue-5318-r4-computed-accessor-keys.test.ts` OOMs on both trees.

## S3 findings (2026-09-12) — the lane is wired per TARGET, and linking is not free

S2l's provider is reachable from every test262 lane now. The slice's own
surprises were both measurements that contradicted the plan, in opposite
directions: the #2961 guard needed no work at all, and the per-row cost needs
more than this slice can give it.

### What was wired, and where

| file | change |
| --- | --- |
| `scripts/test262-temporal.mjs` | ONE stamp per target (`prewarm.json` unchanged for host, `prewarm-standalone.json` for standalone); `temporalProviderCompileOptions`; `test262TemporalLaneEnabled` — the single lane gate all three lanes call |
| `scripts/prewarm-temporal-provider.mjs` | `--target host\|standalone\|both`; the key is computed with the same options the build uses |
| `scripts/test262-worker.mjs` | host-only refusal dropped; provider resolved and memoised per target; the no-cold-build rule unchanged, and standalone additionally REQUIRES a stamp |
| `tests/test262-shared.ts` | `IS_HOST_LANE &&` → `TEMPORAL_LANE_ENABLED &&`, read once per process |
| `tests/test262-runner.ts` | had **no lane gate at all** — a standalone row linked the HOST provider. Gated and keyed per target now |
| `.github/workflows/test262-sharded.yml` | standalone artifact under `run_standalone` **and** the new `standalone_temporal` input; both shard jobs download the directory |
| `scripts/run-test262-vitest.sh` | pre-warms the provider for the lane it is about to run |

The in-process runner's missing gate is worth stating on its own: since #5248 a
`--target standalone` row in that lane linked the `--target gc` provider. It was
invisible because the standalone lane is a probe lane there, and because the
failure it produces is a wrong VALUE, not an error.

### The #2961 guard needed no relaxation — measured

The plan expected the provider's imports to read as a host-import leak. They do
not. A standalone consumer linked against the standalone provider reports
`result.imports === []` (`.tmp/s3-imports.mts`):

| module | `result.imports` (what the guard reads) | engine import list |
| --- | --- | --- |
| provider | — | `[]` |
| consumer, `hostBridge:"off"` | `[]` | 6 × `js2wasm:npm:@js-temporal/polyfill:d7c6…::__js2wasm_link_*` |
| consumer, `hostBridge:"always"` | `[]` | same 6 |

The six real imports all live in the provider's `link:` namespace, which the
compiler's import list deliberately excludes because the linker satisfies them.
So the guard keeps its full strength for every other row — the outcome to
prefer, since a widened #2961 guard is exactly how a real leak would stop being
visible.

### The stop: linking multiplies a standalone row's COMPILE time

Measured on what the lane actually compiles — an **assembled** harness row, not
a bare body (`.tmp/s3-cost.mts` vs `.tmp/s3-cost2.mts`, both on a loaded box, so
read the ratio rather than the absolute):

| source | size | unlinked | linked | ratio |
| --- | --- | --- | --- | --- |
| bare body, `PlainDate/prototype/day/basic.js` | 1 KB | 0.71 s | 0.94 s | 1.3× |
| assembled row, same file | 10.6 KB | 4.2 s | 10.9 s | 2.6× |
| assembled row, `intl402/…/from/era-japanese.js` | 60 KB | 17.4 s | 61.1 s | 3.5× |

The bare-body number is why this did not surface earlier: the cost scales with
the CONSUMER's source, not with the provider, so it only appears once the
harness is in the picture. The sharded lane kills a fork at 30 s and the
in-process lane fails a row at 15 s of compile, so a default-on standalone
artifact converts large-harness Temporal rows from an honest `Temporal is not
defined` fail into a per-row TIMEOUT — the storm the pre-warm doctrine exists to
prevent, on a lane whose baseline was never measured linked.

**So the artifact is OPT-IN**: the `standalone_temporal` `workflow_dispatch`
input in CI, `JS2WASM_TEST262_TEMPORAL_STANDALONE=1` locally. The wiring is
unconditional; the flag decides only whether the ARTIFACT exists, and the stamp
gate turns that into the lane's answer. With it off, the default path is
byte-identical to pre-S3. Making it the default is a follow-up that has to
attack the linked-compile cost first.

### Fail soft, from the negative side

| state | `test262TemporalLaneEnabled("standalone")` | lane |
| --- | --- | --- |
| no stamp (the default today) | `false` | unlinked, pre-S3 behaviour |
| truncated / non-JSON stamp | `false`, no throw | unlinked |
| stamp with no `key` | `false` | unlinked |
| stamp present, key mismatch (worker) | provider `null`, announced once on stderr | unlinked |
| linear / wasi, stamp present | `false` | unlinked |
| `JS2WASM_TEST262_TEMPORAL=0` | `false` on every lane | unlinked |

In CI the same property is carried by three separate decisions, each of which
had to be made explicitly: the standalone build step is `continue-on-error`
(the host one is not, and must not be — its baseline IS measured linked); the
host-stamp guarantee moved out of `if-no-files-found: error` into its own named
check, because a shared directory can no longer carry it; and the provider
directory is always uploadable, since `download-artifact` fails hard on a
missing artifact and would otherwise turn the soft path into a red lane.

### Measured: the 123-row family (`family-123.txt`), standalone lane

Driver `.tmp/bucket-run-sa.mts` — the #5248 row-by-row driver with
`runTest262File(file, category, 15000, "standalone")`, one TSV row per test so a
flip cannot hide inside a count. Fresh `JS2WASM_TEMPORAL_CACHE` per side. The
list is the one every earlier slice used (sha `979f0047cd09…`, the first 123
`built-ins`/`intl402` Temporal rows in path order); no regeneration was needed.

THREE configurations, because the honest base differs per lane. The in-process
runner had no lane gate, so on `main` a standalone row links the **gc** provider;
the sharded lane was host-only, so there a standalone row is **unlinked**.

| | base: linked, gc provider | branch DEFAULT: no artifact | branch OPT-IN: linked, standalone provider |
| --- | --- | --- | --- |
| rows scored | 84 / 123 | **123 / 123** | 61 / 123 |
| pass | 0 | **0** | 0 |
| fail | 12 | 111 | 10 |
| compile_error | 72 | 12 | 51 |
| — of those, compile TIMEOUT | 64 | **0** | 45 |
| `Temporal is not defined` | 0 | 82 | 0 |
| `__temporal_*` leak | 0 | 12 | 0 |
| host-import-leak verdicts | 0 | 12 | 0 |

**0 pass→fail, and structurally so: this family has ZERO passing rows on the
standalone lane in every configuration measured.** It cannot regress a pass
because it has none — which is worth stating rather than implying, since a
0-flip count on a family with no passes is a weaker fact than it looks.

- **A. The opt-in path changes nothing on the rows measured.** Base-linked-gc vs
  branch-linked-standalone over the 61 aligned rows: **0 status flips**, same 45
  timeouts, same everything. Swapping a gc provider for the standalone one is
  neutral here — these rows are dominated by the compile timeout and by Intl
  refusals, not by the provider's values.
- **B. The default path changes 62 of 84 rows, all in the right direction.**
  Base-linked-gc vs branch-default: 61 × `compile_error(timeout)` → `fail` with a
  real diagnostic (`missing required Temporal.PlainDate field`,
  `Temporal is not defined`, …), and 1 × `fail` → `compile_error` where the row
  now compiles far enough to surface its own `__temporal_*` host-import leak
  (`intl402/…/PlainDate/prototype/equals/canonicalize-calendar.js` —
  `env::__temporal_plain_date_from_string_field`, an S4 target). Not linking a
  **gc** provider into a **standalone** consumer is the fix; the timeouts it was
  producing were never conformance signal.
- **This affects the in-process probe lane only.** The sharded lane — the one
  that writes the published baseline — was host-only before this slice and stays
  unlinked by default after it, so the committed standalone numbers do not move.

**Coverage, stated plainly:** the two LINKED runs were stopped at 84 and 61 rows
(`SIGTERM`, not a failure) after ~2 h, because each linked row costs 1-3 min on
this box and they were starving the required equivalence gate. The configuration
that SHIPS — default, no artifact — is complete at 123/123. The two linked
prefixes cover the whole `intl402` head of the list, i.e. every Intl-dependent
row in the family.

**Intl-dependent rows, separately** (`intl402/**`, the first 111 of the 123): all
111 of the scored rows in every configuration are `intl402`, so the table above
IS the Intl breakdown for the prefixes. They are expected to stay red — the
standalone provider ships the `Intl` refusal shim (`src/temporal-intl-shim.ts`),
so a calendar-dependent row cannot pass by construction.

**One environment caveat**, equal on all three sides: 5 rows report
`JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built` — a local
prerequisite this box lacks, not a verdict about the slice.

### Pre-existing red, unchanged by this slice

`tests/issue-5382-temporal-project-publication.test.ts` fails 1 of 33
("materializes the pinned project", the Intl shim now in the polyfill source) —
**measured on the S2l base commit as well**, same single failure, so S3 neither
caused nor fixed it. The brief's known-red list (`issue-2151`,
`issue-2151-mixed-spread`, `issue-3610-*`, `issue-1051`) is unchanged; those were
not re-run here because S3 touches no `src/` file.

## S2m findings (2026-09-12) — the JSBI guard was never OUR coercion, and a graph shares ONE tag

Both stops S2l named are closed. Neither was what its name said, and the first
one's stated hypothesis was FALSIFIED before any code changed — which is the
main thing worth carrying forward.

### (1) The JSBI `valueOf` guard: not an implicit ToNumber of ours

S2l's read was "our standalone lowering coerces a JSBI object where JS would
not". Tested first, directly. A class whose `valueOf` throws, exercised through
**27** operations the spec does not coerce through — strict equality, `typeof`,
ToBoolean (`if` / `!` / `&&` / `?:` / `Boolean()`), property read, method call,
`instanceof`, argument passing, spread, rest, destructuring, `for-of`, array
store / `indexOf` / `push`, object property, computed key, `Map` set/get,
return, `??`, `== null`, optional chaining, `String()`, `Array.isArray`
(`.tmp/s2m-valueof.mts`):

| divergences from node, standalone | **0 of 27** |
| --- | --- |

So the coercion is the POLYFILL's own. `JSBI.__toPrimitive`, `__isBigInt` and
`JSBI.BigInt` all open with `i.constructor === JSBI`; when that reads false
`__toPrimitive` falls through to `const t = i.valueOf; t.call(i)` — JSBI's
deliberately-throwing one, verbatim the message S2l measured. `class JSBI
extends Array`, and standalone that read answered **`Array`**:

| probe, `class C extends Array`, standalone (`.tmp/s2m-narrow*.mts`) | node | base | S2m |
| --- | --- | --- | --- |
| `x.constructor === C`, `x` a typed local | 1 | 1 | 1 |
| `f(x)`, `function f(i){ return i.constructor === C }` | 1 | **0** | 1 |
| which constructor did it answer? | `C` | **`Array`** | `C` |
| the JSBI-shaped `__toPrimitive` reduction | 1 | **throws** | 1 |
| a PLAIN `class C` (same questions) | 1 | 1 | 1 |

An externref-backed subclass instance's carrier is a `$__vec_externref`,
indistinguishable from a plain array, so the generic `__extern_get` ladder
served the Array builtin's `constructor`. The JS-host lane has answered this
since #5377 — the FOURTH argument to `__set_subclass_proto`, which
`emitSetSubclassProto` documents as a no-op standalone.

**Fix**: `emitStandaloneSubclassMethodInstall` now also installs `constructor` →
the class-object singleton as an own data property at the same §17 flags
(`{writable, !enumerable, configurable}`) it already uses for the METHODS, and
not gated on the class declaring any method. Same mechanism, same trade-off the
method install already documents: `hasOwnProperty("constructor")` answers `true`
where the spec says `false`. A/B'd by file copy (`.tmp/s2m-keys.mts`), the
enumerable surface is byte-for-byte the base's — `Object.keys` length, the
`for…in` count, and `constructor`'s absence from both key lists are identical on
the two trees.

**Result on the real polyfill**: compiled as ONE standalone module,
`Temporal.Duration.from({hours:1}).total("minutes")` answers **60**
(`.tmp/s2m-solo-total.mts`; base: the JSBI throw). `total("minute")` too.

### (2) A provider throw now crosses the link as a catchable error

A wasm exception is matched by TAG IDENTITY, and two separately compiled
standalone modules each DEFINE their own `__exn`. The JS-host answer (#5226
`sharedExnTag`, a JS-owned `WebAssembly.Tag` imported as `env.__exn`) needs a
host and is explicitly off for standalone.

The host-free twin needed **no new ABI**, because both halves already existed:
every module already EXPORTS its tag as `__exn_tag`, and
`instantiateLinkedProviders` already publishes each provider's whole export
record under its namespace on the consumer's import object. So a standalone
CONSUMER now imports `<provider-namespace>.__exn_tag` and uses it as its own
tag. One tag per graph, resolved by the linker that is already there, and the
namespace is in `linkedNamespaces`, which `isHostImportAllowed` already
admits — **no `env` import, no #2961 leak** (asserted in the test).

Direction is one-way by necessity: the provider keeps its module-defined tag,
because the linker instantiates providers first.

| probe, host-free across a real link (`.tmp/s2m-exn.mts`) | base | S2m |
| --- | --- | --- |
| `NS.ok()` | 7 | 7 |
| the `catch` clause runs at all | **raw `WebAssembly.Exception` escapes** | 1 |
| `e.message === "x"` | — | 1 |
| `e instanceof RangeError` | — | 1 |
| `e.constructor === RangeError` (what `assert.throws` compares) | — | 1 |
| `e instanceof TypeError` for a thrown `TypeError` | — | 1 |
| a plain `Error` is NOT a `RangeError` | — | 1 |
| re-`throw` from the `catch` | — | 1 |
| `finally` runs | — | 11 |

Registration is EAGER, from `standaloneLinkBoundaryPeerIndices` (the consumer-only
pre-freeze window), because `ensureExnTag` is lazy — it runs at the first
`throw`/`try`, which can be after the #1984 index-space freeze, where a tag
import cannot be added. With no peer, or past the freeze, it degrades silently
to the module-local tag, i.e. exactly today's behaviour.

**Named residual, NOT caused by the link:** `e.constructor.name` and
`typeof e.constructor` on a BUILTIN error are already wrong in a single
standalone module with no link at all (`.tmp/s2m-ctorname.mts`: identity 1,
`instanceof` 1, `.message` 1, but `.name` and `typeof` both wrong). The
identity comparison — the one upstream `assert.throws` actually makes — holds.

### The S2 smoke test, per assertion

| assertion | S2l | S2m |
| --- | --- | --- |
| `Object.keys(Temporal).length === 9` | passes | passes |
| `new Temporal.PlainDate(2024,1,1).day === 1` | passes | passes |
| `Temporal.Duration.from({hours:1}).total("minutes") === 60` | `it.todo` (JSBI ToNumber) | still `it.todo` — **third stop, below** |

### The next stop, measured — the RESULT of one provider method does not decode

The harness `total` probe no longer throws; it answers a value. Two harness
probes were added (`durationHasTotalBound` / `totalBound`) so the chained and
bound-local spellings are scored separately, and the bound one is not the
blocker either:

| real provider | solo module | linked |
| --- | --- | --- |
| `d.hours`, `d.sign` (getters) | 1 / 1 | 1 / 1 |
| `d.abs().hours`, `p.equals(p)`, `p.day` | — | ok |
| `typeof d.total === "function"` (bound local) | — | 1 |
| `d.total("minutes")` | **60** | a provider-owned carrier |

It is **not** "primitives cannot cross". A tiny hand-written provider answers
**9 of 9** shapes correctly — number, string, boolean, object, zero-arg,
one-arg, free function, own field, accessor (`.tmp/s2m-prim.mts`) — and on the
REAL provider the object-returning and boolean-returning methods cross too.
What arrives wrong is specifically `total`'s result: the consumer's `typeof`
ladder calls it `"number"` while `String()` of it throws "Cannot convert object
to primitive value", i.e. the ladder and the value decode disagree about a
provider-owned carrier. That is a wasm↔wasm VALUE ABI slice of its own.

(`d.toString()` is NOT evidence for it — that call throws in the SOLO module as
well, so it is a separate pre-existing gap.)

### Byte A/B

12 module shapes × {gc, standalone} = 24 artifacts (`.tmp/s2m-ab.mts`, base
captured by file copy before the first edit). **21 of 24 sha256-identical.**

- **All 12 gc-lane artifacts are identical**, including every subclass shape.
- The 3 standalone differences are exactly the externref-backed subclass shapes
  — `extendsArray`, `extendsArrayNoMethod`, `extendsMap` — the direct subject.
- `extendsError:standalone` is **identical**: the method install's measured
  error-struct exclusion still holds, so the `constructor` install inherits it.
- Every standalone shape that throws or uses `try`/`finally` locally
  (`throwsLocal`, `tryFinally`) is identical — the tag change fires only for a
  CONSUMER that links a provider, never for a lone module and never for a
  provider.

### Acceptance criteria — S2 smoke test status (2026-09-12, S2m)

Unchanged in count and moved in kind: **two of three** S2 assertions pass
through the real standalone provider and are asserted as a real test. The third
is still `it.todo`, now blocked on the wasm↔wasm decode of one method's RESULT
rather than on a throw — the provider no longer throws at all on that path, and
the same expression answers 60 inside one standalone module.

### Pre-existing red, unchanged by this slice

The brief's list, re-confirmed as the base state: `tests/issue-2151.test.ts` (1),
`tests/issue-2151-mixed-spread.test.ts` (1), `tests/issue-3610-standalone-prototype-receiver-brand.test.ts` (1),
`tests/issue-1051.test.ts` (3), `tests/issue-5382-temporal-project-publication.test.ts` (1);
`tests/issue-5318-r4-computed-accessor-keys.test.ts` OOMs on both trees.
