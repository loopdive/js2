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
  # 2026-09-12 (S2p) — outlining the standalone realm-global lazy-init seed.
  #   The mechanism itself lives in the NEW module
  #   `src/codegen/native-globalthis-outline.ts`, deliberately not in the
  #   god-file. What remains here is the split the outline needs at its one
  #   existing call site:
  #   array-object-proto.ts  +29  `emitNativeGlobalThisObject` divided into
  #     (a) the cached-global accessor, (b) `buildNativeGlobalThisSeed` — the
  #     unchanged ~200-line seed, now RETURNING its init body instead of
  #     splicing it into the caller — and (c) a four-line dispatch that prefers
  #     the outlined helper and keeps the historical inline splice for the
  #     re-entrant case. The growth is the three function headers plus the note
  #     that the inline arm is not dead code: a realm-global read raised from
  #     inside the seed's own construction MUST stay inline, because calling a
  #     not-yet-initialized ensure helper from within its own initializer
  #     recurses at runtime. A reader who deletes that arm as redundant
  #     reintroduces an infinite loop that no byte A/B would show.
  - src/codegen/array-object-proto.ts
  # 2026-09-12 (S2n) — the `$__vec_base` push/pop arm's resolve-OR-RESERVE.
  #   closed-method-dispatch.ts  +24  the lookup helper plus the rationale. The
  #     code is four lines; the rest records WHY the arm was order-dependent
  #     (`generateModule` calls `emitVecAccessExports` before this fill,
  #     `generateMultiModule` after it) and WHY the reserve is conditional
  #     (unconditional would move the allocation earlier in the single-module
  #     lane and change its bytes). It cannot move to another module: the fix
  #     IS the lookup this arm makes, and the arm is the whole reason #2927's
  #     block lives here. A reader who trims the note will "simplify" it back
  #     to a plain resolve and silently reopen a data-loss bug that only the
  #     multi-module lane shows.
  - src/codegen/closed-method-dispatch.ts
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
  # 2026-09-12 (S2o) — `ensureStructForType` +30. The CODE is a two-line guard
  # ("never register a struct for `typeof globalThis`"); the other 28 lines are
  # the rationale, and they are load-bearing because the guard looks redundant
  # from every angle except the one that matters. It sits immediately after the
  # `.d.ts`-only guard, which a reader will reasonably assume already covers
  # the global scope — it does not, because that symbol is transient and has
  # ZERO declarations, so the existing guard's `length > 0` precondition fails
  # open. The note also records the measurement that justifies the guard's
  # existence at all (2,766 → 929 functions, 694 k → 486 k instructions on a
  # 10.6 KB test262 original-harness row) and names the three use-site repairs
  # — #3365, #4394, #4638 — that are each a workaround for the registration
  # this guard prevents. Without that, the next reader deletes it as a
  # micro-optimisation. The guard cannot move to another module: it is one of
  # a list of sibling early-outs whose ORDER relative to the `.d.ts` check is
  # the point.
  - src/codegen/index.ts::ensureStructForType
  # 2026-09-12 (S2n) — `fillClosedMethodDispatch` +24. The growth is the
  # resolve-OR-RESERVE lookup for the `$__vec_base` push/pop arm plus its
  # rationale. It belongs to THIS function because the arm it feeds is built
  # here and nowhere else, and the bug it fixes is precisely that the lookup
  # answered differently depending on when this function runs relative to
  # `emitVecAccessExports` — a fact only readable next to the arm.
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
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

**Verdict per criterion, S5 close-out (2026-09-12).** Three of four are met;
criterion 4 is **not**, and the issue stays `in-progress` for that reason. The
"Remaining" list at the end of this section names the successor issues.

1. S1: the linked polyfill source compiles under `--target standalone` to a
   binary `WebAssembly.Module` accepts; each reduction is a test.
   **MET (S1, 2026-09-07; PR #5721).** Two reductions (the `anyref` row in the
   #1917 ToBoolean cascade; the `recv.m?.(args)` host/native split), both tests.
2. S2: `buildTemporalProvider` with `target: "standalone"` returns
   `plan=separate`; the host-free smoke test passes.
   **MET (S2n, 2026-09-12): all 3 assertions asserted as a real test** —
   `Object.keys(Temporal).length === 9`, `new Temporal.PlainDate(2024,1,1).day
   === 1`, and `Temporal.Duration.from({hours:1}).total("minutes") === 60`
   (both the chained and bound-local spellings answer 60), plus the
   `durationHours === 1` precursor. The third assertion's last blocker was NOT
   a value-ABI defect: `.pop()` on an `any`-shaped vec receiver was a silent
   no-op in every **multi-module** compile, so JSBI never trimmed its BigInt
   digits and `total` computed NaN inside the provider. See "S2n findings".
   One `it.todo` remains in the block and is **not** an S2 assertion: `typeof
   d.total === "function"` read through a CHAINED receiver (#2984).
3. S3–S4: standalone Temporal rows link the provider in both runners and CI;
   `__temporal_*` leaks are 0.
   **PARTIALLY MET (S3, 2026-09-12; PR #5827) — the wiring is complete and
   unconditional, but the ARTIFACT is opt-in.** Every lane (in-process runner,
   worker, shared harness, CI) resolves the provider per TARGET and fails soft
   without a stamp. The artifact is built only under
   `JS2WASM_TEST262_TEMPORAL_STANDALONE=1` / the `standalone_temporal` workflow
   input, because linking costs 1.76–1.83× a row's compile time and puts the
   60 KB row exactly on the 15 s in-process limit (S2p §4). Successor: #5407.
   **The `__temporal_*` half is MET (S4) — measured 0, by construction.** The
   #4628 gate `temporalIsCompiledBinding` in `src/codegen/temporal-native.ts`
   keys the #661 lowering on whether `Temporal` names a REAL, non-ambient,
   value-producing declaration. The provider prelude binds
   `const Temporal = <provider getter>()`, which is exactly such a declaration,
   so the lowering stands down wherever the provider is linked — and only
   there. That is the "keyed on the binding, not the target alone" property the
   plan asked for, already satisfied, so no new gate was added and nothing in
   the gc or unlinked-standalone lanes can move. Confirmed by measurement on
   three families, 360 linked rows: **0 `__temporal_*` leaks linked, against 74
   on the unlinked side** (48 PlainDate + 26 Duration; ZonedDateTime has none
   because the #661 lowering covers only PlainDate/PlainTime/Duration).
4. S5: samples measured, 0 pass→fail, counts with artifacts; the standalone
   Temporal bucket moves from 170 pass.
   **MET for the sampled families (re-measured S11, 2026-09-13, after #6457).**
   Linked, the three sampled families score **170 pass / 184 fail / 6
   compile_error out of 360** (PlainDate 62, Duration 43, ZonedDateTime 65),
   against **139** on the S10-linked side — **0 pass→fail**, 31 `fail→pass`, and
   every `compile_error` on both sides is a compile TIMEOUT (the five that the
   sampled run scored CE answer `fail` when re-run SOLO at 60 s, so the CE
   counts are equal to base in every family). The
   `TypeError: Cannot convert undefined or null to object` bucket went **18 → 0**
   in ZonedDateTime. The full-corpus "moves from 170 pass" number is still
   unmeasured; only the 360-row sample is. Per-family counts, flip lists and
   the new top buckets are in "S11 findings" below. The S10 text that follows is
   kept for the record:
   **MET for the sampled families (re-measured S10, 2026-09-13, after #6447).**
   Linked, the three sampled families score **139 pass / 215 fail / 6
   compile_error out of 360** (PlainDate 62, Duration 38, ZonedDateTime 39),
   against **122** on the S9-linked side — **0 pass→fail**, 17 `fail→pass`, and
   every `compile_error` on both sides is a compile TIMEOUT. The
   `Cannot read properties of undefined (reading 'sort')` bucket went **24 → 0**
   across the three families. The full-corpus "moves from 170 pass" number is
   still unmeasured; only the 360-row sample is. Per-family counts, flip lists
   and the new top buckets are in "S10 findings" below. The S9 text that
   follows is kept for the record:
   **MET for the sampled families (re-measured S9, 2026-09-13, after #6442).**
   Linked, the three sampled families score **122 pass / 232 fail / 6
   compile_error out of 360** (PlainDate 55, Duration 35, ZonedDateTime 32),
   against **85** on the S8-linked side — **0 pass→fail**, 37 `fail→pass`, and
   every `compile_error` on both sides is a compile TIMEOUT. The
   `RangeError: unknown time zone UTC` bucket went **69 → 0** across the three
   families (ZonedDateTime/prototype alone 62 → 0, which took that family from
   2 pass to 32). The full-corpus "moves from 170 pass" number is still
   unmeasured; only the 360-row sample is. Per-family counts, flip lists and the
   new top buckets are in "S9 findings" below. The S8 text that follows is kept
   for the record:
   **MET for the sampled families (re-measured S8, 2026-09-12, after #5404).**
   Linked, the three sampled families score **85 pass / 267 fail / 8
   compile_error out of 360** (PlainDate 51, Duration 32, ZonedDateTime 2),
   against 44 on the S7-linked side and **0** on the S5/S6-linked sides —
   **0 pass→fail**, 44 `fail→pass` vs S7, and 1 `pass→compile_error` that is a
   15 s compile TIMEOUT and comes back `pass` when re-run solo. The
   `Unsupported dynamic regular expression pattern` bucket went **101 → 0**.
   The full-corpus "moves from 170 pass" number is still unmeasured; only the
   360-row sample is. Per-family counts, flip lists and the new top buckets are
   in "S8 findings" below. The S7 text that follows is kept for the record:
   **MET for the sampled families (re-measured S7, 2026-09-12, after #6432).**
   Linked, the three sampled families score **44 pass / 310 fail / 6
   compile_error out of 360** (PlainDate 17, Duration 26, ZonedDateTime 1),
   against **0 pass** on the S5- and S6-linked sides — **0 pass→fail**, 44
   `fail→pass`, 2 `compile_error→fail` (both S5 compile-timeouts). The S6 text
   that follows is kept for the record:
   **NOT MET (re-measured S6, 2026-09-12).** Linked, the three sampled families
   still score **0 pass** (120 rows each: PlainDate 0 pass / 109 fail / 11
   compile-timeout, Duration 0 / 110 / 10, ZonedDateTime 0 / 111 / 9), so
   **0 pass→fail against the S5-linked side** and 4 legitimate losses against
   the UNLINKED side, unchanged. The compile-timeout rise vs S5 is contention
   (three families run concurrently, S5 ran pairs) — three flipped rows re-run
   solo come back `fail`, not `compile_error`.
   **The reason the bucket does not move is now known and is NOT #5406.** Every
   linked row fails at MODULE INIT, before its first statement: an EMPTY row
   with `features: [Temporal]` fails with the same text, and the reduction is
   six lines (an `eval` in the source plus any linked provider). Filed as
   **#6432**. #5406 itself is fixed (the `Object.prototype.toString` boundary
   answer) and its second half — provider-thrown error identity — was
   re-measured as ALREADY CORRECT; the S5 sub-bucket table below therefore
   classifies rows by a line the failure never reached.

**Remaining, in the order that unblocks the most:**

- **#6432** — the real blocker, found in S6: a standalone module that contains
  `eval` AND links a provider throws
  `Object.prototype.toString is not yet implemented` at MODULE INIT. The
  harness prelude has an `eval`, so every linked row fails before its first
  statement. Six-line reduction; identical on base.
- ~~**#5406**~~ — DONE (S6): the boundary `Object.prototype.toString` answer
  landed (`__js2wasm_link_to_string_tag`). Its error-identity half was
  re-measured as already correct, and the "136 `assert.throws` rows fail on
  this alone" claim does not survive re-measurement — that text is #6432's
  module-init failure.
- **#5408** — `Temporal.PlainDate.from("…")` throws and
  `PlainDate.from(date, options).year` is not a number, through the provider.
- **#5407** — the provider's link cost (1.83×, +214 functions, WAT doubled,
  8 of 360 rows time out). The only blocker to the artifact being default-on.

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

## S2i regression fix (2026-09-12) — a computed static FIELD, shadowed by the class-value call arm

PR #5820 (merged at `ec27f08b`) regressed **32 standalone rows**, one cluster:
`test/language/{statements,expressions}/class/cpn-class-{decl,expr}-fields-methods-computed-property-name-from-*.js`.
Every one failed `Expected SameValue(«null», «<value>»)` under
`--target standalone`; the JS-host lane was untouched. This is the fix, based on
`origin/main` and independent of the rest of the Temporal stack.

### Root cause — S2i's gate was right, its callee resolution was not

S2i widened `classDynamicMemberCallApplies`
(`src/codegen/expressions/class-dynamic-member-call.ts`) to claim **every**
`C[k](…)` whose receiver is an identifier naming a compiled class, and then let
that call reuse the INSTANCE arm's lowering:
`__apply_closure(__extern_get(recv, key), recv, args)`, where `recv` is the
lazily materialized `$ClassName` class-object struct.

That struct does not carry a **computed static field**. The ordinary READ
lowering of `C[k]` does reach it; `__extern_get` on the raw class-object struct
does not. So the fused call form answered null while the identical read answered
the closure — a split the suspects named in the dispatch brief (the
`class-static-sidecar` widening, the `class-proto-lookup` class-object arm, the
`standalone-class-dyn-member` prototype widening) did **not** cause: probes that
disabled `prependClassMethodCallArm` produced a byte-identical module
(`wasm_sha 2afb8fcfed63` both ways), so the call arm was never even emitted for
these modules.

The split, measured on the reduction (one module, runner
`runTest262File(…, "standalone")`):

| probe on `let C = class { [1.1] = () => 3; static [1.1] = () => { hit++; return 2 } }` | main `cf82f78d` | fix |
| ------------------------------------------------------------------------------------- | --------------- | --- |
| `typeof C[String(1.1)]` — the READ                                                      | `"function"`    | `"function"` |
| `C[String(1.1)]()` — the fused CALL                                                     | `null`          | `2`  |
| `hit` after that call — was the closure INVOKED?                                        | `0`             | `1`  |
| `const f = C[String(1.1)]; f()` — read, then call                                       | `2`             | `2`  |
| `c[String(1.1)]()` — the INSTANCE half                                                  | `2`             | `2`  |

The `hit` row is why the encoded probe exists in
`tests/issue-5383-class-value-dynamic-call.test.ts`: a result-only assertion
cannot tell "called, returned null" from "never called", and it was the latter.

### The fix — ask the read lowering instead of re-deriving the callee

`emitClassValueDynamicCall` handles the class-VALUE receiver separately: it
compiles `elemAccess` itself for the callee (the read lowering knows about the
static sidecar — S2i's win — **and** the `staticProps`/own-property surface —
the regression), then recompiles the identifier for `this`.

Recompiling the receiver is sound **only** here, and that is why the two arms
stay split: `classValueReceiverApplies` requires an IDENTIFIER, so the second
evaluation is a global read of the same lazy singleton. The instance arm cannot
do this — `new C()[k]()` would construct twice — which is the constraint that
forced S2i's single-evaluation shape in the first place.

### Measurements (base = `origin/main` `cf82f78d6d`, a detached worktree; fix = this branch)

Full `cpn-*` families, **all 248 rows** (`language/statements/class` +
`language/expressions/class`), run solo per row:

| lane           | base pass/fail | fix pass/fail | delta   |
| -------------- | -------------- | ------------- | ------- |
| `standalone`   | 152 / 96       | **184 / 64**  | **+32** |
| gc (JS host)   | 136 / 112      | 136 / 112     | 0       |

Per-TEST diff, not per-count: **32 fixed, 0 newly broken** on standalone, and the
gc lane's failing-row LIST is byte-identical (`diff` empty). The 32 are exactly
the `fields-methods` rows of both families — the cluster #5820 broke.

Byte A/B on the gc lane: **13 modules** under `website/playground/examples/`
compiled on both trees, sha256 of each binary **identical**. Expected — the gate
is `ctx.standalone`-only.

Suites: `#5383` (incl. the real-provider S2 smoke test), `#5195` ×4, `#5358`,
`#2158` ×2, `#4628` ×2, `#5225`, `#5353`, `#5364` — **256 passed, 0 failed**
(the one failure in the first batch was this PR's own new test before its host
decode was fixed; a standalone export returns a WasmGC ref, so the probe encodes
its four answers as one number).

`npm run -s test:equivalence:gate` →
`equivalence-gate: 22 failing, 1720 passing, 22 known-failures in baseline.`
(exit 0).

Pre-existing red, unchanged and re-measured on this tree: `issue-2151` (1),
`issue-2151-mixed-spread` (1), `issue-3610-standalone-prototype-receiver-brand`
(1), `issue-1051` (3), `issue-5382-temporal-project-publication` (1),
`issue-2358-array-toprimitive` (1) — 8 total, the same 8 recorded on the S2k/S2l
bases.

### What this does NOT claim

S2i's headline probe shape (`class C { static mk(a){…} }`, `C["mk"](5)`) still
answers `NaN` under the test262 harness on **both** trees — measured, identical
before and after. That is a separate residual of the static-method surface, not
something this fix regressed or repaired.

## S2o findings (2026-09-12) — linking is nearly free; `compileMulti` is not

S2o was dispatched to make the linked standalone compile affordable enough to
flip the test262 artifact default-on. It did not get there, and the reason is
that the slice's premise was wrong in a way worth recording: **linking costs
about 2 %. The 3.3× is `compileMulti` vs `compile`,** and
`compileWithTemporalGlobal` is simply the multi-file entry point. S3's table
compared a multi-file compile against a single-file one and read the whole
difference as the linker's.

Half of that multi-file cost is now gone, from one registration-site guard. The
other half is located, measured, and named below; it is a different defect and
it is what the next slice should take.

### 1. Profile first — the delta is not where the brief expected

`.tmp/s2o-isolate.mts`, one process, same options on every line, the row the
brief names (`built-ins/Temporal/PlainDate/prototype/day/basic.js`, 10.6 KB
**assembled original harness**, standalone). Read the steps, not the absolutes —
the box is loaded.

| configuration | ms | vs `compile()` |
| --- | --- | --- |
| A `compile()` — what the UNLINKED lane runs | 1797 | 1.0× |
| B `compileMulti()`, ONE file, **no link** | 5802 | **3.2×** |
| C B + `canonicalRuntimeTypes` | 5604 | 3.1× |
| D B + `sharedExceptionTag` | 5609 | 3.1× |
| E B + both | 6025 | 3.4× |
| F E + the provider stub file, still no link | 6762 | 3.8× |
| G `compileWithTemporalGlobal` — the LINKED lane | 5882 | 3.3× |

B is the whole gap. Neither compile flag matters, and G ≈ B: the provider
contributes **6 functions** to a 2,761-function module. The comparison is the
right one for the lane — `tests/test262-runner.ts` L4388-4393 runs
`compileWithTemporalGlobal` when a provider exists and plain `compile` when it
does not, so multi-vs-single IS linked-vs-unlinked from the lane's point of
view. It is just not *caused* by linking.

Per-phase attribution (`JS2WASM_COMPILE_PROFILE=1`, `.tmp/s2o-phase.mts`) showed
no single hot pass — every whole-module finalize pass was ~3× its single-source
self time, in proportion. That is the signature of a bigger MODULE, not a slower
pass, and the module-scale markers said so directly:

| before-finalize, same source | funcs | instrs | globals | types |
| --- | --- | --- | --- | --- |
| `compile()` | 612 | 102 k | 608 | 351 |
| `compileMulti()` | 2761 | 694 k | 1928 | 533 |

### 2. Root cause A (fixed): a WasmGC struct for `typeof globalThis`

Of `compileMulti`'s 2,766 functions, **1,942 were `__sget_<name>` / `__sset_<name>`
accessor pairs** — 977 getter names against 19 in the single-source module. The
names read `AbortController`, `AudioContext`, `CSSKeyframeRule`: one giant
struct, `$__anon_1`, with ~950 `externref` fields, one per ambient global in
`lib.dom`.

The test262 harness prefix opens with `var $262 = { global: globalThis, … }`.
That makes the checker hand `ensureStructForType` the `typeof globalThis` type,
it registered it, and `emitStructFieldGetters`/`Setters` minted a host-facing
accessor per field. Not one of them is reachable: no value of that type exists
at runtime to read through one.

**This was already known to be wrong — three times, at use sites.** #3365 widens
`var t = this` to externref; #4394 routes `Object.defineProperty(globalThis, …)`
off the struct fast path; #4638 re-represents a data-only literal holding it.
Each exists because a `(ref null $__anon_globalThis)` slot can never `ref.test`
against the host externref (or the standalone `$Object` singleton) that the value
actually is. The fix is the registration-site statement of the rule those three
work around: `src/codegen/index.ts`, `ensureStructForType`, skip the type.

Why the guard directly above it did not already catch this: the `.d.ts`-only
skip (#1287) requires `dtsDecls.length > 0`, and the global scope's symbol is
**transient with ZERO declarations** (`.tmp/s2o-globaltype.mts`:
`symbol.name "globalThis"`, `decls []`, `props 946`). It failed open. Both
conditions are checked so an ordinary user type merely NAMED `globalThis` keeps
its struct.

| before-finalize, 10.6 KB row | funcs | instrs | `__sget_`/`__sset_` |
| --- | --- | --- | --- |
| `compile()` | 612 | 102 k | 28 |
| `compileMulti()`, base | 2766 | 694 k | **1942** |
| `compileMulti()`, S2o | 929 | 486 k | 28 |

−66 % functions, −30 % instructions, ≈ −15…20 % wall on the same box.

### 3. Root cause B (NOT fixed, and it is the rest of the gap)

After the fix the multi module is still **929 funcs / 486 k instrs** against
single-source's 612 / 102 k. The remaining inflation is per-BODY, not per-module,
and it is one mechanism:

| function | single-source WAT lines | multi WAT lines |
| --- | --- | --- |
| harness `assert` | 103 | **5,610** |
| `__module_init` | 5,785 | 47,489 |
| `__closure_56` | 243 | 42,202 |

`assert`'s multi body opens with `__native_globalThis_obj`,
`__builtin_Array_obj`, `__builtin_Object_obj`, `__builtin_JSON_obj`,
`__builtin_Math_obj`, `__builtin_Proxy_obj`, `__builtin_Reflect_obj`,
`__runtime_eval_dynamic_global_obj` — **twice**.

`emitNativeGlobalThisObject` (`src/codegen/array-object-proto.ts` ~L3629) caches
the realm object in a module GLOBAL at runtime, but splices its entire
~5,000-instruction lazy-init seed into the CALLER's body at every call site, at
compile time. Single-source lands one copy in `__module_init`; the multi path
lands ~30 copies across the module.

**Proposed fix for the next slice:** outline the seed into one synthetic
zero-argument helper (`__native_globalThis_ensure() -> externref` holding the
`global.get` / `ref.is_null` / init guard), and emit `call` at each site. It is
not a two-line change — the emitter allocates `objLocal` in the caller's `fctx`,
and the late-import / index-shift discipline it documents ("keep the detached
body live while later seed construction can still add imports") has to be carried
onto the synthetic context. Not attempted here rather than attempted and
half-validated: it is the standalone `globalThis` substrate, every standalone
test262 row runs through it, and it needed more validation budget than remained.
Ruled out on the way: the `#4157` IR inliner (`JS2WASM_IR_INLINE=0` leaves the
before-finalize scale byte-for-byte identical, so the inflation is already
present at codegen time) and `ctx.sourceIsModule` (the multi path pins it `true`
at L10596, but module mode emits strictly *less*).

### 4. Per-row cost, and why the default did NOT flip

`.tmp/s2o-cost.mts`, median of 3, after the fix:

| row | size | unlinked | linked | ratio |
| --- | --- | --- | --- | --- |
| `built-ins/…/PlainDate/prototype/day/basic.js` | 10.6 KB | 1634 ms | 5385 ms | 3.30× |
| `intl402/…/PlainDate/from/era-japanese.js` | 60 KB | 7480 ms | 26826 ms | 3.59× |

The target was ~1.3×. **The artifact therefore stays OPT-IN** —
`standalone_temporal` in CI, `JS2WASM_TEST262_TEMPORAL_STANDALONE=1` locally —
and no runner, worker, shared-harness or workflow file is touched by this slice.
Flipping it now would put the 60 KB row at ~27 s against a 30 s fork kill and a
15 s in-process compile limit: a 10 % margin, on a box measurement, for the
class of failure (a per-row timeout storm) the pre-warm doctrine exists to
prevent. Root cause B has to land first.

### 5. Measured: two NON-Intl families, standalone lane

First 40 rows in path order of `built-ins/Temporal/PlainDate/**` and
`built-ins/Temporal/Duration/**` (driver `.tmp/s2o-family.mts`, one TSV row per
test; `runTest262File(file, "s2o", 15000, "standalone")`). Fresh
`JS2WASM_TEMPORAL_CACHE` per side; the linked side carries a standalone pre-warm
stamp, the base side none, which is exactly how `test262TemporalLaneEnabled`
decides. 40 not 120: each linked row costs ~6 s here and the four runs already
took ~2 h wall.

| | PlainDate base (unlinked) | PlainDate linked | Duration base (unlinked) | Duration linked |
| --- | --- | --- | --- | --- |
| rows | 40 | 40 | 40 | 40 |
| pass | **2** | **0** | 0 | 0 |
| fail | 34 | 37 | 37 | 34 |
| compile_error | 4 | 3 | 3 | 6 |
| — of those, TIMEOUT | 1 | 3 | 0 | 6 |
| `Temporal is not defined` | 16 | **0** | 22 | **0** |
| `__temporal_*` leak | 3 | **0** | 3 | **0** |
| median compile ms | 1745 | 6142 | 2013 | 7026 |
| status flips vs base | — | 7 | — | 9 |

**The bar was 0 pass→fail and the count is 2, so state it as it is: 2 rows flip
`pass` → `fail`, and both were FALSE passes.**
`PlainDate/calendar-string.js` and `PlainDate/calendar-undefined.js` are ordinary
positive tests — `new Temporal.PlainDate(2020, 12, 24)` then
`assert.sameValue(d.calendarId, "iso8601")`. Neither can legitimately pass
without a `Temporal` global, and unlinked there is none; the sibling row
`compare/argument-propertybag-calendar-string.js` reports the honest
`ReferenceError: Temporal is not defined` on the same side, so the unlinked pass
is inconsistent, not systematic. Linked, both rows construct the object and then
fail at line 13 on a **different, real** standalone gap —
`TypeError: Object.prototype.toString is not yet implemented in --target standalone`.
**Zero legitimate passes are lost**, and two rows stop reporting green for a
feature the lane does not have. That is an improvement wearing a regression's
clothes, and it is one more reason the count alone must not be the gate.

Everything else moves the right way: `Temporal is not defined` 38 → 0 and the
`__temporal_*` host-import leak 6 → 0 across both families. The cost is the 3.4×
median and timeouts 1 → 9.

**One measurement was thrown away and re-run, which is worth recording.** The
first pass of this table had 37/40 and 34/40 LINKED rows failing on
`JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built` — a local
prerequisite this box lacked. Linking makes every row reach the runtime-eval
path, so an environment gap that touched 2 rows unlinked touched nearly all of
them linked, and the linked columns were measuring the box. S3 saw the same gap
at 5 rows and reported it as a caveat; at 90 % it is not a caveat, it is a void
measurement. Built with `npx tsx scripts/build-quickjs-eval-provider.mjs` (the
plain `node` invocation fails — it needs `scripts/compiler-bundle.mjs` or tsx)
and re-ran all four sides. The numbers above are the second run.

### 6. Byte A/B

10 modules × {gc, standalone} × {`compile`, `compileMulti`}, base tree vs branch
by file copy (`.tmp/s2o-bytes.mts`, `.tmp/bytes-base.tsv` vs `.tmp/bytes-new.tsv`):
**18 of 20 lane×route pairs byte-identical**, including all 8 gc pairs for the 9
modules that do not mention `globalThis`.

The two that move are the one module written to contain it, on both lanes:

| module | lane | base bytes | S2o bytes |
| --- | --- | --- | --- |
| `gt` (`var $262 = { global: globalThis, … }`) | gc | 209,072 | **5,044** |
| `gt` | standalone | 696,630 | **270,485** |

The brief asked for the gc lane to be identical; it is, for every module except
the one whose whole purpose is to exercise the change. A gc module carrying
`globalThis` in an object literal shrinks 97.6 %, which is the same dead
accessor bank — this is not a standalone-only win.

### 7. Gates and suites

`npm run -s test:equivalence:gate` → `equivalence-gate: 22 failing, 1720
passing, 22 known-failures in baseline. ✓ No new equivalence regressions.`

typecheck · loc-budget (also `LOC_GATE_BASE=origin/main`) · func-budget (also
vs `origin/main`) · coercion-sites · oracle-ratchet · dead-exports ·
compiler-boundaries (`--mode inventory --base origin/main`) · host-import-policy
· `biome lint src tests scripts` — all exit 0. The one grant this slice needs is
`src/codegen/index.ts::ensureStructForType` (+30, almost all of it the
rationale), in the frontmatter above.

Suites: #5383 (×3, incl. the real-provider smoke), #5353, #5248, #5251, #4628
(×2), #4787 (×2), #4376 (×9) — 114 + 74 passing. Three reds, **each measured on
the base tree by file copy and identical there**:

| suite | on S2o | on base | verdict |
| --- | --- | --- | --- |
| `issue-4376-deno-core-bootstrap` | 1 failed (`expected 1 to be +0`, probe L652) | 1 failed, same assertion, same line | pre-existing |
| `issue-4376-module-init-chunking` | 1 failed / 18 passed (`expected ['__module_init_chunk_0'] to not include …`) | identical | pre-existing |
| `issue-4376-deno-infra-destructure` | vitest worker OOM | OOM at 6 GB too | pre-existing |

The brief's known-red list (`issue-2151`, `issue-2151-mixed-spread`,
`issue-3610-*`, `issue-1051`, `issue-5382-temporal-project-publication`,
`issue-2358-array-toprimitive`; `issue-5318-r4-computed-accessor-keys` OOMs) was
not re-run — those are unrelated to a struct-registration guard, and the
equivalence gate plus the byte A/B cover the blast radius better than re-running
a static list would.

## S2p findings (2026-09-12) — the splice is gone; the artifact still stays opt-in

S2o left one named, unfixed defect: `emitNativeGlobalThisObject` caches the
realm object in a module GLOBAL at runtime but spliced its whole
~5,000-instruction lazy-init seed into the CALLER's body at every call site, at
compile time. That is now outlined into one helper. The multi-source penalty
S2o measured is essentially gone; the per-row cost is roughly halved; and the
target that would have flipped the test262 artifact on is still not met, by a
margin small enough to name exactly.

### 1. Why the two lanes differed — it was never the linker, and never `compileMulti` as such

The emitter is reached **5 times** on a single-source compile of the 10.6 KB
assembled harness and **134 times** on a `compileMulti` of the SAME source
(`.tmp/s2p-sites.mts`, stack-tagged counter). The 134 break down as:

| callers | calls |
| --- | --- |
| `compileRuntimeEvalGlobalLexicalRead` (via `emitGlobalEnvironmentObject`) | **105** |
| `tryGlobalThisAndProcessRead` (`compilePropertyAccess`) | 20 |
| the eval/binding-sync runtimes + two plain identifier reads | 9 |

The switch is `ctx.runtimeEvalGlobalFunctionBindings`, set when the IR
runtime-eval boundary plan finds any site. Same source, **0 sites single / 3
sites multi** — and the three are `globalThis.eval`, `__js2wasm_global_script_eval(...)`
and `eval(sourceText)`, all inside the harness's `$262` object.

`compile()` never sees them: `src/compiler.ts` runs the #3418 dead-top-level
binding elision for host-free targets, which length-preserving-BLANKS the unread
`var $262 = { … }`. (Proof, not inference: at offset 2874 the single-source
`sourceFile.text` is whitespace where the multi one reads `eval: globalThis.eval`;
the walk visits 875 nodes against 1,123.) `compileMulti()` does not run that
elision, keeps `$262`, and every bare global lexical read then routes through the
realm object.

So the elision was hiding a per-site cost, not creating one. Fixing the emitter
rather than widening the elision is what makes the win independent of which
entry point erased the evidence.

### 2. The fix, and the two things that make it safe

`src/codegen/native-globalthis-outline.ts` (new): build the seed once into
`__native_globalThis_ensure()`, emit `call` + `global.get` at each site.
`emitNativeGlobalThisObject` splits into the cached-global accessor, the
unchanged seed builder (now RETURNING its init body), and a four-line dispatch.

- **Order-independence** comes from `mintDefinedFunc`'s STABLE handle
  (`func-space.ts`): no late-import shifter renumbers it, so the `call` immediate
  baked at the first site survives arbitrary later import churn. This is a
  resolve-or-reserve at the site, never a finalize-pass rewrite — the
  multi-module finalize order differs from the single-module one (S2n).
- **Runtime behaviour is unchanged** because the cached global already made the
  seed run at most once: only the first site to execute can observe the null
  global, spliced or called.
- The **inline arm is kept and is not dead code.** A realm-global read raised
  from inside the seed's own construction must stay inline — calling a
  not-yet-initialized ensure helper from within its own initializer recurses at
  runtime. Measured residual on the 10.6 KB row: **3** inline splices remain, all
  in runtime-eval bridge functions built during the seed
  (`__js2wasm_intrinsic_indirect_eval`, `__runtime_eval_push_globals`,
  `__runtime_eval_pull_globals`), against 131 sites that now call.

The caller's body and saved bodies are published to `ctx.liveBodies` for the
duration of a first-time build: the seed still registers late imports, and it is
now built against the HELPER's context, so that is where the coverage
`flushLateImportShifts(ctx, fctx)` used to give the caller directly has to come
from.

### 3. Per-row cost (median of 3, one process, standalone)

`.tmp/s2p-cost.mts`. `single` = `compile()` (what the UNLINKED lane runs),
`linked` = `compileWithTemporalGlobal`.

| row | route | base | S2p | change |
| --- | --- | --- | --- | --- |
| `built-ins/…/PlainDate/prototype/day/basic.js` (10.6 KB) | `compile` | 1831 ms | 1647 ms | −10 % |
| | `compileMulti` | 4469 ms | **2695 ms** | **−40 %** |
| | linked | 5105 ms | **2894 ms** | **−43 %** |
| `intl402/…/PlainDate/from/era-japanese.js` (60 KB) | `compile` | 7810 ms | 8244 ms | +6 % (noise) |
| | `compileMulti` | 15333 ms | **8729 ms** | **−43 %** |
| | linked | 29438 ms | **15057 ms** | **−49 %** |

Module scale on the same runs — spliced seed locals and WAT lines:

| row / route | seed locals base → S2p | WAT lines base → S2p |
| --- | --- | --- |
| 10.6 KB `compileMulti` | 117 → 4 | 641 k → 339 k |
| 10.6 KB linked | 150 → 4 | 722 k → 364 k |
| 60 KB `compileMulti` | 490 → 4 | 1.62 M → 851 k |
| 60 KB linked | 789 → 4 | 3.75 M → 1.85 M |

### 4. The artifact stays OPT-IN, and the residual is no longer this defect

Target was ≤1.3× linked-vs-unlinked. Measured **1.76×** (10.6 KB) and **1.83×**
(60 KB). **The 60 KB row is 15.06 s linked — exactly at the 15 s in-process
compile limit**, and the 30 s fork kill is the softer of the two. Flipping
`standalone_temporal` on at that number trades a known-safe opt-in for the
per-row timeout storm the pre-warm doctrine exists to prevent, so no runner,
worker, shared-harness or workflow file is touched by this slice either.

What the residual now IS, stated so the next slice does not re-measure S2o's
question: on the 60 KB row `compileMulti` is within **6 %** of `compile` — the
multi-source penalty is gone. The remaining 1.83× is the PROVIDER: linked adds
214 functions and doubles the WAT again (851 k → 1.85 M). That is a different
problem from the one S2o and S2p worked, and it is where the next ~2× has to
come from.

### 5. Byte A/B

`.tmp/s2o-bytes.mts`, 10 modules × {gc, standalone} × {`compile`, `compileMulti`},
base tree vs branch by file copy: **all 8 gc pairs byte-identical**, and 9 of 10
standalone modules byte-identical.

| module | lane | base bytes | S2p bytes |
| --- | --- | --- | --- |
| `gt` (`var $262 = { global: globalThis, … }`) | standalone `compile` | 270,485 | 270,526 |
| `gt` | standalone `compileMulti` | 267,792 | 267,833 |

+41 bytes on both routes — the helper's own type, function entry and guard,
which a module with ONE call site has nothing to amortise against. The brief
asked for single-source standalone to be identical unless the outlining measured
neutral there; it is +41 bytes on the trivial case and a clear win on a real one
(the 10.6 KB harness row's `compile` WAT: 159,386 → 146,944 lines, −7.8 %), so
it is kept for both.

### 6. Measured: the two NON-Intl families, standalone lane

First 40 rows in path order of `built-ins/Temporal/PlainDate/**` and
`built-ins/Temporal/Duration/**` (`.tmp/s2p-family.mts`, one TSV row per test,
`runTest262File(file, "s2p", 15000, "standalone")`). Fresh
`JS2WASM_TEMPORAL_CACHE` per side; the linked side carries a standalone pre-warm
stamp, the base side none. QuickJS eval provider built first
(`npx tsx scripts/build-quickjs-eval-provider.mjs`) — S2o recorded why that is a
prerequisite and not a detail. Two runs at a time, so the ms column carries
consistent contention and is comparable across sides but not with §3.

| | PlainDate base (unlinked) | PlainDate linked | Duration base (unlinked) | Duration linked |
| --- | --- | --- | --- | --- |
| rows | 40 | 40 | 40 | 40 |
| pass | **2** | **0** | 0 | 0 |
| fail | 35 | 39 | 37 | 38 |
| compile_error | 3 | 1 | 3 | 2 |
| — of those, TIMEOUT | 0 | 1 | 0 | 2 |
| `Temporal is not defined` | 17 | **0** | 22 | **0** |
| `__temporal_*` leak | 3 | **0** | 3 | **0** |
| median row ms | 1309 | 2979 | 1346 | 3314 |
| status flips vs base | — | 6 | — | 5 |

**Two rows flip `pass` -> `fail`, and they are S2o's two — the same
`PlainDate/calendar-string.js` and `PlainDate/calendar-undefined.js`, failing
linked at the same line on the same real standalone gap
(`Object.prototype.toString is not yet implemented in --target standalone`).
S2o established why those unlinked passes are FALSE: both are ordinary positive
tests that construct `new Temporal.PlainDate(...)` and cannot legitimately pass
without a `Temporal` global, which the unlinked side does not have. Zero
legitimate passes are lost, and Duration flips none.**

What S2p changes relative to S2o's table is the COST column and the timeouts,
which is the whole point of the slice:

| | S2o linked | S2p linked |
| --- | --- | --- |
| PlainDate median row ms | 6142 | **2979** |
| PlainDate compile_error / timeouts | 3 / 3 | **1 / 1** |
| Duration median row ms | 7026 | **3314** |
| Duration compile_error / timeouts | 6 / 6 | **2 / 2** |

`Temporal is not defined` 39 -> 0 and the `__temporal_*` host-import leak 6 -> 0
across both families, unchanged from S2o: the provider still does its job, it is
now roughly half the price and times out a third as often.

### 7. Gates and suites

`npm run -s test:equivalence:gate` → `equivalence-gate: 22 failing, 1720
passing, 22 known-failures in baseline. ✓ No new equivalence regressions.`

typecheck · loc-budget (also `LOC_GATE_BASE=origin/main`) · func-budget ·
coercion-sites · oracle-ratchet · dead-exports · compiler-boundaries
(`--mode inventory --base origin/main`) · host-import-policy ·
`biome lint src tests scripts` — all exit 0.

Two gate notes worth keeping: the new module had to be **classified in
`scripts/compiler-boundaries.json`** (an unclassified new file under `src/` fails
the inventory outright, with `unclassified-module` + `unclassified-target`), and
the only LOC grant this slice needs is `array-object-proto.ts` +29 — the
mechanism itself was put in a new module precisely so the god-file would not
absorb it.

Suites: #5383 (×3), #4628 (×2), #5353, #3365, #4638, the #4394 globalThis/error
family (×8), and the S2n pass-order test — 102 + 32 + 116 passing across the
runs. One pre-existing red, **measured on the base tree by file copy and
identical there**: `issue-4638` fails 2 (`Expect test to fail` on the empty-string
gOPD row — a test262 expectation that now passes — and
`WebAssembly.instantiate(): Import #0 module="js2wasm:runtime-eval"` on the
eval-thisArg row). The brief's known-red list was not re-run; the equivalence
gate plus the byte A/B bound the blast radius better than a static list would.

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

## S2n findings (2026-09-12) — the value ABI was never the problem: `.pop()` was a no-op in every multi-module compile

S2m's stop is closed, and its stated hypothesis was FALSIFIED before any code
changed — as was the brief's. The answer was three reductions away from Temporal
and one pass-ordering line away from the codegen it was blamed on.

### The hypothesis, refuted with the type sections

The brief's first hypothesis was that the boxed-primitive carriers are outside
the canonical rec group (`RUNTIME_RECGROUP_TYPE_NAMES`) and therefore
canonicalize differently in provider and consumer, so the consumer's
`ref.test $__box_number_struct` fails. Measured with a raw type-section reader
(`.tmp/s2n-types.mjs`, a re-creation of S2k's — that worktree is gone):

| module | groups / types | canonical group `[0..9]` hash | boxed number | boxed boolean |
| --- | --- | --- | --- | --- |
| consumer | 121 / 130 | `b978f99195cd` | idx 38, group 29, **singleton** `plain struct(f64)` | idx 39, group 30, `plain struct(i32)` |
| polyfill provider | 1057 / 1066 | `b978f99195cd` | idx 72, group 63, **singleton** `plain struct(f64)` | idx 73, group 64, `plain struct(i32)` |

Both carriers are emitted as their own single-member group with no `sub`
wrapper and no finality bit, so their canonical identity is structural and
IDENTICAL in the two modules; the canonical group hashes match too (S2k's fix
holding). `markLeafStructsFinal` cannot touch them either — it only finalizes
structs that have a `superTypeIdx`, and these have none. **No ABI change was
needed and none was made.**

### What the carrier actually was

`typeof v === "number"` answering true while `String(v)` throws is not a
disagreement between two tests. It is one consistent reading of a **boxed NaN**
(`.tmp/s2n-battery.mts`, `.tmp/s2n-nan.mts`, through the real provider):

| probe on `d.total("minutes")` across the link | answer |
| --- | --- |
| `typeof v === "number"` | 1 |
| `Number.isNaN(v)` / `v === v` | **1 / 0** |
| `v === 60`, `v < 61`, `v ? 1 : 0` | 0, 0, 0 |
| `v * 1`, `Number(v)` | NaN, NaN |
| `d.hours` (control) | 1, and it crosses as a JS **number** — a `ref.i31` |

`d.hours` is a small int, so the smi fast path boxes it as `ref.i31`, which JS
sees as a number; `total`'s NaN cannot be an i31, so it is a `$__box_number_struct`,
which JS sees as an opaque object — hence "Cannot convert object to primitive
value" from `String()`. The consumer decoded it correctly the whole time.
(`v + 0` throwing rather than answering NaN is a separate, unrelated gap in the
`+` ToPrimitive path for that carrier; every other numeric operation answered
NaN.)

### Where the NaN came from — not the link, not the arguments

Three reductions, each removing one suspect:

| what was compiled | `total("minutes")` |
| --- | --- |
| polyfill as ONE standalone module (S2m's measurement, re-run) | 60 |
| polyfill as a linked provider, probe INSIDE the provider, zero-arg, f64 return (`.tmp/s2n-probe-project.mts`) | **NaN** |
| same, with the probe exports compiled by `compileProject` in **bundled** mode | **NaN** |

The second row is decisive: no consumer-minted argument, no value crossing the
boundary, no `plan=separate` required. The axis is `compile()` vs
`compileProject()`, and it needs no link at all — a **single-file**
`compileProject` (`plan=none`) reproduces (`.tmp/s2n-axis.mts`).

Narrowing inside the polyfill (`.tmp/s2n-probe3.mts`) put it in
`TimeDuration.fdiv`, and one probe named it: `g(totalNs, 6e10).remainder`
answered **0** solo and **576460752303423500** (2^59) through `compileProject`.
Dropping Temporal entirely (`.tmp/s2n-jsbi.mts`, jsbi alone, ~6 s per compile):

| probe | solo | compileProject |
| --- | --- | --- |
| `JSBI.toNumber(JSBI.subtract(JSBI.BigInt(1e12), JSBI.BigInt(1e12)))` | 0 | **536870912** (2^29) |
| `JSBI.remainder(3600000000000n, 60000000000n)` → `toNumber` | 0 | **throws** |
| … its `.length` (digit count) | 0 | **3** |
| `JSBI.divide(…)`, `JSBI.__clz30`, single-digit remainder | same | same |

A JSBI zero that keeps three zero digits is a failed `__trim`, and `__trim`
truncates with `this.pop()` inside a method of `class JSBI extends Array`.

### The defect

`fillClosedMethodDispatch`'s `$__vec_base` brand arm (#2927) routes `.push` /
`.pop` on an `any`/externref receiver that is really a native vec to the
carrier-generic `__vec_push` / `__vec_pop`. It looked the helper up with a plain
`resolveVecHostBridgeHelper`, and the ALLOCATION that lookup needs is made by
`emitVecAccessExports` — which the two generate entry points call on **opposite
sides of this fill**:

```
generateModule      (src/codegen/index.ts:6098)   emitVecAccessExports BEFORE the fill
generateMultiModule (src/codegen/index.ts:11405)  emitVecAccessExports AFTER  the fill
```

Traced directly (`JS2WASM_S2N_DEBUG` instrumentation, removed before commit):
at the fill, `popIdx=2097441` in the single-module lane and `popIdx=undefined`
in both multi-module lanes, with `want=true` in all three. So the arm was
emitted in one and **silently dropped** in the other: `.pop()` fell to the
open-`$Object` bottom arm, returned `undefined` and mutated nothing. That is the
#2927 data-loss bug, reopened for `compileProject` only, on `--target
standalone` / `--target wasi`, since whenever the two orders diverged.

**Why it hid.** A `.push(…)` ANYWHERE in the module makes the call site reserve
the bridge (`call-receiver-method.ts`), which allocates it before the fill and
masks the pop defect entirely — measured: adding one `p_push` export to the
8-line reduction made the base tree answer 0. The first draft of the regression
test did exactly that and passed on the base tree; it is now two separate
single-call-site sources for that reason.

### The fix

`resolveVecHostBridgeHelper` → **resolve-or-reserve** at the fill
(`src/codegen/closed-method-dispatch.ts`, one small block), so the arm is
order-INDEPENDENT rather than order-correct. Reordering the finalize passes was
the alternative and is a much larger blast radius for the same outcome.
`reserveVecMethodHelper` also sets `usesVecValue`, which is what makes the
finalize vec-export pass fill the placeholder bodies the arm calls into.

Byte-neutral for the lane that already worked: the reserve runs ONLY when the
resolve returns `undefined`, and the whole block is gated on standalone/wasi.
**Byte A/B, 12 module shapes × {gc, standalone} = 24 single-module artifacts
(`.tmp/s2n-ab.mts`, base captured by file copy before the first edit): all 24
sha256-identical**, including the `extends Array` / push / pop shapes.

### The S2 smoke test, per assertion

Through the shipped path (`buildTemporalProvider` + `compileWithTemporalGlobal`,
`--target standalone` / `hostBridge:"off"`, host-free):

| assertion | S2m | S2n |
| --- | --- | --- |
| `Object.keys(Temporal).length === 9` | passes | passes |
| `new Temporal.PlainDate(2024,1,1).day === 1` | passes | passes |
| `Temporal.Duration.from({hours:1}).total("minutes") === 60` | `it.todo` — a NaN carrier | **60 — passes** |
| the same through a bound local (`totalBound`) | a NaN carrier | **60 — passes** |

All three S2 assertions are now asserted as a real test.

### The regression test lives in its own file, for a measured reason

`tests/issue-5383-s2n-vec-mutation-pass-order.test.ts`. Adding the two compiles
to `issue-5383-standalone-temporal-provider.test.ts` — which already spends
~140 s, most of it inside ONE child-process assertion that builds the 3.3 MB
provider — pushed the worker past vitest's `onTaskUpdate` RPC heartbeat:
**every test passed and the FILE exited 1**, reproducibly, while the base file
on the same tree exited 0. Split, both files exit 0 (168 s / 29 s). Worth
knowing generally: a long blocking child process plus a few extra seconds of
sibling work is enough to turn a green file red with no failing assertion.

### The one `it.todo` left in that block — NOT an S2 assertion

`durationHasTotal` still answers 0: `typeof Temporal.Duration.from({hours:1}).total
=== "function"` through a CHAINED receiver, where the bound-local spelling
(`durationHasTotalBound`) answers 1. That is #2984's path-dependent member read
on a chained call result, named as such; `total` itself answers 60 in BOTH
spellings.

### Named residual, not this slice

`v + 0` on a provider-owned `$__box_number_struct` throws "Cannot convert object
to primitive value" where every other numeric operation on the same value
decodes it. Not on the #5383 path (the value is a real number now), but it is a
real gap in the `+` ToPrimitive ladder for that carrier.

### Acceptance criteria — S2 smoke test status (2026-09-12, S2n)

**MET: three of three.** Criterion 2 above is updated.

### Pre-existing red, unchanged by this slice

Re-confirmed as the base state: `tests/issue-2151.test.ts` (1),
`tests/issue-2151-mixed-spread.test.ts` (1),
`tests/issue-3610-standalone-prototype-receiver-brand.test.ts` (1),
`tests/issue-1051.test.ts` (3),
`tests/issue-5382-temporal-project-publication.test.ts` (1);
`tests/issue-5318-r4-computed-accessor-keys.test.ts` OOMs on both trees.

## S5 findings (2026-09-12) — measured; the bar is not met, and the reported error text was hiding the reason

S5 is the measurement-and-close slice: no `src/` change, three non-Intl families
at 120 rows each, both sides, and an honest verdict. The verdict is that the
provider does its job — `Temporal is not defined` goes to zero and the
`__temporal_*` leak goes to zero — and that the linked lane still scores **0
pass**, because one defect in the LINK BOUNDARY (not in Temporal, and not in the
provider) fails 352 of 360 rows and masks every other cause behind a misleading
message.

### 1. The three families, standalone lane, linked vs unlinked

`.tmp/s2p-family.mts` (S2o's runner, `runTest262File(file, "s5", 15000,
"standalone")`), first 120 rows in path order per root, **fresh
`JS2WASM_TEMPORAL_CACHE` per side** — the linked side carries a standalone
pre-warm stamp, the base side none, which is exactly how the runner decides the
lane. QuickJS eval provider built first (`npx tsx
scripts/build-quickjs-eval-provider.mjs`); S2o recorded why that is a
prerequisite and not a detail, and its own first table was void without it.
Each family's two sides ran as a PAIR, two processes at a time, so the ms column
carries consistent contention and is comparable across sides.

| | PlainDate base | PlainDate linked | Duration base | Duration linked | ZonedDateTime/prototype base | ZDT linked |
| --- | --- | --- | --- | --- | --- | --- |
| rows | 120 | 120 | 120 | 120 | 120 | 120 |
| pass | 3 | **0** | 3 | **0** | 4 | **0** |
| fail | 69 | 118 | 91 | 117 | 116 | 117 |
| compile_error | 48 | 2 | 26 | 3 | 0 | 3 |
| — of those, TIMEOUT | 0 | **2** | 0 | **3** | 0 | **3** |
| `Temporal is not defined` | 33 | **0** | 56 | **0** | 34 | **0** |
| `__temporal_*` leak | 48 | **0** | 26 | **0** | 0 | **0** |
| median row ms | 1378 | 3126 | 1372 | 3275 | 1205 | 2886 |
| status flips vs base | — | 53 | — | 32 | — | 7 |

Intl: the three sample roots are all under `built-ins/Temporal/**`, so no
`intl402` row entered the samples. Exactly **one** row names an era
(`built-ins/Temporal/PlainDate/from/one-of-era-erayear-undefined.js`), and it is
a `built-ins` calendar row, not an Intl-dependent one. `built-ins/Temporal/Now/**`
was out of scope per #5405.

### 2. Pass→fail: 10 flips, 6 false, **4 legitimate**

The bar was 0 legitimate losses. It is not met. Every one of the 10 fails
linked with the same reported text, so the loss is a function of ONE defect
(#5406), not of provider semantics — but 4 of them are real product passes
today and a reader must not be told otherwise (`.tmp/s5-passloss.mjs`):

| row | shape | verdict |
| --- | --- | --- |
| `PlainDate/calendar-string.js` | 1 value assertion, 0 `assert.throws` | **legitimate loss** |
| `PlainDate/calendar-undefined.js` | 2 value assertions | **legitimate loss** |
| `PlainDate/from/options-basic.js` | 4 value assertions | **legitimate loss** |
| `Duration/prototype/abs/new-object.js` | 6 value assertions | **legitimate loss** |
| `Duration/get-prototype-from-constructor-throws.js` | throws-only | false pass |
| `Duration/prototype/add/argument-invalid-property.js` | throws-only | false pass |
| `ZonedDateTime/prototype/add/argument-invalid-property.js` | throws-only | false pass |
| `ZonedDateTime/prototype/add/argument-singular-properties.js` | throws-only | false pass |
| `ZonedDateTime/prototype/add/options-wrong-type.js` | throws-only | false pass |
| `ZonedDateTime/prototype/equals/argument-propertybag-calendar-wrong-type.js` | throws-only | false pass |

**The false-pass mechanism, stated so it is not re-derived.** A row whose only
assertions are `assert.throws(TypeError, () => instance.m(x))` passes on the
UNLINKED lane for the wrong reason: with no `Temporal` (the #661 lowering covers
only PlainDate/PlainTime/Duration, so every ZonedDateTime row has none), the
callee is absent and `undefined.m()` throws the very `TypeError` the row
expects. All four ZonedDateTime "passes" are this shape, which is also why ZDT
has 0 `__temporal_*` leaks while PlainDate has 48.

**S2o's claim that `calendar-string.js` / `calendar-undefined.js` were false
passes is CORRECTED here, by measurement rather than by argument.** Compiling
those rows unlinked under standalone gives a binary with **zero imports**
(`.tmp/s5-imports.mts`, `WebAssembly.Module.imports` on the assembled harness
body — `[]` for all six rows probed): the #661 compile-time lowering answers
them host-free, and their assertions are value assertions, which the false-pass
mechanism above cannot satisfy. They are real passes that the linked lane loses.

### 3. The single reported text is the THIRD event in a chain

352 of the 360 linked rows report exactly
`TypeError: Object.prototype.toString is not yet implemented in --target standalone`.
That call appears in **one** place in the harness (`test262/harness/assert.js`,
`formatSimpleValue`), inside the `catch` of `String(value)` — which the harness
only reaches when an assertion has ALREADY failed. So the text names neither the
failing operation nor even the failing formatter; it is the fallback of a
fallback. Sub-classified by the harness call in each row's `at L<n>:` fragment
(`.tmp/s5-subbuckets.mjs`):

| sub-bucket | PlainDate | Duration | ZDT | total |
| --- | --- | --- | --- | --- |
| `assert.throws` over a provider call | 55 | 46 | 35 | **136** |
| `assert.sameValue` on a provider value | 34 | 32 | 58 | 124 |
| no line attributed (threw during setup) | 25 | 30 | 13 | 68 |
| plain `assert()` | 0 | 0 | 9 | 9 |
| `assert.compareArray` | 4 | 2 | 1 | 7 |
| other harness line | 0 | 3 | 1 | 4 |
| `assert.notSameValue` | 0 | 4 | 0 | 4 |
| **compile timeout** (the other 8 rows) | 2 | 3 | 3 | 8 |

### 4. Root cause of the 136, measured host-free: the boundary, not Temporal

`.tmp/s5-firstfail.mts` and `.tmp/s5-throwshape.mts`, through the shipped path
(`buildTemporalProvider` + `compileWithTemporalGlobal`, `hostBridge: "off"`,
`instantiateLinkedProject(result, {})` — empty import object). Bound locals
throughout, so #2984's chained-receiver read cannot confound the answers.

| probe | measured |
| --- | --- |
| `new Temporal.PlainDate(2024,1,1).calendarId === "iso8601"` | **correct** |
| `Temporal.PlainDate.compare(d1, d1)` | **0, correct** |
| `String(new Temporal.PlainDate(2024,1,1))` | **a string — does NOT throw** |
| `Object.prototype.toString.call(<a PlainDate>)` | **throws** |
| `Object.prototype.toString.call({ a: 1 })` (consumer-owned) | **a string** |
| a provider-thrown error: `e instanceof Error` | true |
| …`e instanceof RangeError` | **false** |
| …`e.constructor === RangeError` (consumer's) | **false** |
| …`e.constructor.name` | **`undefined`** |
| control: consumer's own `throw new RangeError` → `e.constructor === RangeError` | true |

Two facts fall out, and they are the whole of #5406:

- `Object.prototype.toString` is not "unimplemented under standalone" — it works
  for a consumer-owned object and refuses a carrier that came across the link.
  The message text misdirects whoever reads it.
- The consumer and the provider each own their intrinsic error constructors, so
  `assert.throws`'s `thrown.constructor !== expectedErrorConstructor` identity
  test can never succeed over a provider call. **136 rows cannot pass, however
  correct Temporal is.** This is a realm question, not a marshalling one.

Two genuine Temporal-lane value defects were also isolated and are filed as
#5408: `Temporal.PlainDate.from("1976-11-18")` throws, and
`PlainDate.from(d, { overflow: "constrain" }).year` is not a number — while the
constructor, `.calendarId`, `compare` and `String()` of a PlainDate are all
correct.

### 5. What this slice changed

Nothing in `src/`. The deliverables are the measurement, the three successor
issues (#5406 boundary identity, #5407 link cost, #5408 `PlainDate.from`), the
acceptance verdict above, and
`plan/agent-context/temporal-standalone-handover-2026-09-12.md`.

### 6. Artifacts

In the S5 worktree's `.tmp/`: `{pd,du,zdt}-{base,link}.tsv` (one row per test:
path, status, ms, detail), `s5-summary.txt` (per-family counts + every flip),
`s5-firstfail.out`, `s5-throwshape.out`, `s5-imports4.out`,
and the scripts `s5-buckets.mjs`, `s5-subbuckets.mjs`, `s5-passloss.mjs`,
`s5-imports.mts`, `s5-firstfail.mts`, `s5-throwshape.mts` (plus S2p's
`s2p-family.mts` / `s2p-prewarm.mts` / `s2p-table.mjs`, reused unchanged apart
from the run label).

### 7. Salvage and independent re-verification (2026-09-12)

The lane that produced §1–§6 was killed by a container restart before it could
commit, and a second attempt wedged. The work was recovered from the dead
worktree and committed by a third lane, which did **not** take the tables on
trust: every number in §1 was recomputed from the six raw
`{pd,du,zdt}-{base,link}.tsv` row files (`.tmp/an.mjs`, an independently written
aggregator) and matches, and the pass→fail classification in §2 was re-derived
from the rows' own sources — `grep -c assert.throws` against
`grep -c "assert.sameValue|notSameValue|compareArray|^assert("` on all ten
files. Result: the six rows called false passes have **0** non-throws
assertions each, and the four legitimate losses have 1, 2, 4 and 6 value
assertions respectively. No measurement was re-run; the artifacts were
sufficient to re-derive every claim, and the tsvs were carried into the
salvaging worktree's `.tmp/` with the probe scripts so they survive the dead
worktree's cleanup.

One thing DID change on the way in: `origin/main` had meanwhile shrunk
`src/runtime.ts` from 19,725 to 19,722 lines, which reset the LOC ceiling under
it. The branch does not touch that file, but carrying the older copy read as
`+3` against the CI merge-preview base (`LOC_GATE_BASE=$(git rev-parse
origin/main)`) — the "ceiling reset by main's post-merge baseline refresh"
failure class, visible only when the gate is run against upstream's tip rather
than the fork point. Merging `origin/main` cleared it; no allowance was added
and nothing was baselined.

## S6 findings (2026-09-12) — the boundary `toString` answer lands, and the lane's 352-row text turns out to be a module-INIT failure

Slice #5406, Opus lane, branch `issue-5383-standalone-temporal-s6` (stacked on
S5). Full tables in `plan/issues/5406-standalone-link-boundary-object-identity.md`;
the three results that matter here:

1. **(A) fixed.** A value minted by a linked provider now answers
   `Object.prototype.toString` in the consumer — `[object Object]` for a class
   instance or plain object, `[object Error]` for an error — via a new
   miss-path terminal `__js2wasm_link_to_string_tag`, the same shape as S2d's
   `__js2wasm_link_member_get`. Exotic carriers whose tag is not the step-13
   default (Date, RegExp, Map/Set, Symbol/BigInt boxes, WeakRef, generator
   result) DECLINE explicitly and keep today's loud refusal; that list is not
   optional — measured without it, `toString.call(new Date(0))` answered
   `[object Object]` where the base threw.
2. **(B) was never broken.** S5/#5406 read `instanceof RangeError === false` off
   `Temporal.PlainDate.from("not-a-date")`. That call throws a **TypeError**
   ("Unsupported dynamic regular expression pattern", #5408). On calls that
   really throw a `RangeError`, identity, `instanceof`, `.name` and `.message`
   all cross correctly — including through function PARAMETERS, which is
   `assert.throws`'s own spelling. S2m's one-tag-per-graph did the work; S6 adds
   the assertions to `tests/issue-5406-standalone-link-boundary-tostring.test.ts`.
   Residual, single-module and not boundary-related: `e.constructor.name` reads
   `undefined`, and `const C = RangeError; C.name` reads the TypeScript
   interface name `"RangeErrorConstructor"`.
3. **The lane's real blocker is #6432.** Six lines — a module containing `eval`
   that links any provider — throw
   `Object.prototype.toString is not yet implemented in --target standalone` at
   `__module_init`, before any statement runs. The test262 harness prelude
   defines `$262.evalScript`, so **every** linked row hits it; an empty row
   fails identically. Same on the base tree and this one. That is the text on
   352 of 360 S5 rows and the reason the linked lane scores 0 pass.

Byte A/B: 12 shapes x {gc, standalone}, **24 of 24 identical** — both new arms
are reachable only inside a linked graph.

## S7 findings (2026-09-12) — the init blocker is fixed; the linked lane scores 44/360 and the buckets are finally about Temporal

**#6432 is fixed.** Root cause, chain, fix and the byte A/B live in that issue
file; the one-line version: `__to_primitive`'s §7.1.1-step-1 "already a
primitive" early-out cascade had no `$Symbol` arm, so a Symbol PROPERTY KEY
(`Array[@@species]`, minted during native-prototype seeding at module init) fell
into `__class_to_primitive`, whose generic walk guards on `__typeof_object ||
__typeof_function` — and `__typeof_object` answers "object" for a Symbol. The
walk therefore sent `sym.toString()` at it, which resolved to the inherited
`Object.prototype.toString` glue and raised that method's loud standalone
refusal. `eval` (forces the full realm seed at init) and a linked provider (the
state that made the glue reachable mid-seed) were amplifiers, not the cause.

### The three-family sample, LINKED, re-measured

120 rows each, `--target standalone`, provider linked, families run
**sequentially**, fresh `JS2WASM_TEMPORAL_CACHE`, quickjs eval provider built.
S5-linked artifacts (`/home/user/js2/.tmp/s5-artifacts/*-link.tsv`) are the base;
S6-linked measured the same 0-pass result.

| family | rows | S5/S6 linked pass | **S7 linked pass** | fail | compile_error | pass→fail |
| --- | --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 120 | 0 | **17** | 102 | 1 | **0** |
| `built-ins/Temporal/Duration/**` | 120 | 0 | **26** | 91 | 3 | **0** |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 120 | 0 | **1** | 117 | 2 | **0** |
| **total** | **360** | **0** | **44** | **310** | **6** | **0** |

46 rows flipped: 44 `fail→pass`, 2 `compile_error→fail` (both were S5
compile-timeouts — contention, not a new defect). No row went `pass→fail`.

The compile-timeout count also fell (S5 8 → S7 6) because the families ran
sequentially this time; S6 recorded the opposite movement for the same reason.

### Top error buckets, LINKED — the first ones that describe Temporal

PlainDate (102 fail):

| count | text |
| --- | --- |
| 21 | `Test262Error: calendar must be string in canonicalizeCalendarEra Expected SameValue(«"undefined"», «"string"»)` |
| 16 | `TypeError: Unsupported dynamic regular expression pattern` |
| 6 | `TypeError: Cannot read properties of undefined (reading 'sort')` |
| 4 | `Test262Error: Expected a RangeError but got a undefined` |
| 4 | `TypeError: map callbackfn is not a function` |

Duration (91 fail):

| count | text |
| --- | --- |
| 15 | `TypeError: Unsupported dynamic regular expression pattern` |
| 9 | `TypeError: Cannot access property on null or undefined at 164:22` |
| 6 | `Test262Error: Expected a RangeError but got a undefined` |
| 4 | `TypeError: expected a string, not null` |
| 4 | `Test262Error: years result: Expected SameValue(«undefined», «0») to be true` |

ZonedDateTime/prototype (117 fail):

| count | text |
| --- | --- |
| 70 | `TypeError: Unsupported dynamic regular expression pattern` |
| 18 | `TypeError: Cannot convert undefined or null to object` |
| 6 | `TypeError: Cannot read properties of undefined (reading 'equals')` |
| 2 | `TypeError: Cannot read properties of undefined (reading 'toZonedDateTime')` |
| 2 | `TypeError: Cannot read properties of undefined (reading 'sort')` |

Read honestly, that gives the next slices a target list rather than one opaque
text:

- **The dynamic-RegExp gap (#5408) is now the single largest bucket — 101 of
  310 failures across the three families, and 70 of ZonedDateTime's 117.** The
  polyfill parses ISO strings with computed patterns; until those compile, the
  whole string-parsing surface of the lane is capped. This is the highest-value
  next slice by a wide margin.
- **`canonicalizeCalendarEra` reads a calendar as `undefined` (21 PlainDate
  rows)** — a distinct, self-contained defect in the calendar-id path.
- **`Cannot read properties of undefined` / `Cannot access property on null or
  undefined` (≈45 rows)** — several different missing members inside the
  provider, not one bug; needs per-row attribution before it can be scoped.

### A trap for whoever measures this lane next

The standalone lane links a provider **only when a standalone-keyed pre-warm
stamp exists in the cache dir** (`test262TemporalLaneEnabled` →
`readTemporalPrewarmStamp`, #5383 S3). Without it every row runs **unlinked and
fails soft** — and it looks exactly like a linked run that went badly. The first
S7 run was exactly that, and the tell was the error texts: 74 `standalone target
emitted host imports: env::__temporal_*` plus 89 `ReferenceError: Temporal is
not defined`, i.e. the UNLINKED numbers already recorded in acceptance criterion
3 above. Two checks make it unambiguous:

- the run log must contain `[test262] Temporal provider (standalone) …
  cacheHit=…`, and
- `__temporal_*` host-import leaks must be **zero**.

`scripts/prewarm-temporal-provider.mjs` needs `scripts/compiler-bundle.mjs`,
which a plain source checkout does not have; `.tmp/s7-prewarm.mts` writes the
same stamp in-process via `temporalProviderCacheKey` + `writeTemporalPrewarmStamp`.

### Acceptance criterion 4 — updated

Criterion 4 above is edited in place to MET-for-the-sample, with the S6 text
kept beneath it for the record. Nothing here claims the full-corpus number: only
360 rows were measured, and a corpus run is the tech lead's to schedule.

### Artifacts

`.tmp/s7fam/{pd,du,zdt}-link.tsv` (+ `.log`) in the S7 worktree
`/home/user/js2/.claude/worktrees/agent-ab8c96460934f2664`, produced by
`.tmp/s7-family.mts` (a copy of S6's, label `s7`) and compared with
`.tmp/s7-table.mjs` against `/home/user/js2/.tmp/s5-artifacts/*-link.tsv`. The
first, UNLINKED run is kept at `.tmp/s7fam-UNLINKED/` as the worked example of
the pre-warm trap. Provider: `cacheHit=true`,
`js2wasm:npm:@js-temporal/polyfill:75c71eaf308041cb`, 3,273,995 B.

## S8 findings (2026-09-12) — the RegExp wall is gone; the linked lane nearly doubles to 85/360

**#5404 is fixed** (details, census and mechanism in that issue's "Resolution").
The one-line version: the standalone backend already const-folded
`new RegExp("^" + a.source + "$")`, but **not** the two spellings the polyfill
actually uses — a template literal with substitutions and `[…].join("")`. It
was never a "runtime pattern" problem; it was two missing spellings of the same
compile-time composition, so no runtime regex compiler was needed. The fold is
gated on a trial compile, because `reportStandaloneRegExpUnsupported` is a
STICKY compile error and a widened fold onto an unsupported construct would
have turned a catchable `TypeError` into a hard build failure for the bundle.

### The three-family sample, LINKED, re-measured

120 rows each, `--target standalone`, provider linked, families run
**sequentially**, fresh `JS2WASM_TEMPORAL_CACHE` (`.tmp/s8cache`), quickjs eval
provider present. Linking confirmed both ways: the run log carries
`Temporal provider (standalone) js2wasm:npm:@js-temporal/polyfill:1528a7d22b729f99
(3278839 B) … cacheHit=true`, and `__temporal_*` leaks are **0** in all three
TSVs.

| family | rows | S7 linked pass | **S8 linked pass** | fail | compile_error | pass→fail |
| --- | --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 120 | 17 | **51** | 68 | 1 | **0** |
| `built-ins/Temporal/Duration/**` | 120 | 26 | **32** | 83 | 5 | **0** |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 120 | 1 | **2** | 116 | 2 | **0** |
| **total** | **360** | **44** | **85** | **267** | **8** | **0** |

44 rows flipped `fail→pass`. One row flipped `pass→compile_error`
(`Duration/from/argument-propertybag-optional-properties.js`) — it is a **15 s
compile timeout**, and re-run solo with a 60 s budget it comes back **`pass`**;
the other new CE (`Duration/from/argument-duration.js`) re-runs to **`fail`**,
the same verdict it had in S7. So there is **no genuine pass→not-pass row**.
Every `compile_error` in both runs is a compilation timeout, which S5/S6/S7
already characterised as contention-sensitive.

The `Unsupported dynamic regular expression pattern` bucket is **101 → 0**
across the three families (PlainDate 16→0, Duration 15→0, ZonedDateTime 70→0).

`built-ins/Temporal/PlainDate/from/**` alone — the sub-family #5408 is about —
went **7 pass → 19 pass**.

### Top error buckets, LINKED, S8

PlainDate (68 fail):

| count | text |
| --- | --- |
| 21 | `Test262Error: calendar must be string in canonicalizeCalendarEra Expected SameValue(«"undefined"», «"string"»)` |
| 8 | `TypeError: Cannot read properties of undefined (reading 'sort')` |
| 4 | `TypeError: map callbackfn is not a function` |
| 4 | `Test262Error: Expected a RangeError but got a undefined` |
| 4 | `RangeError: unknown time zone UTC` |

Duration (83 fail):

| count | text |
| --- | --- |
| 9 | `TypeError: Cannot access property on null or undefined at 164:22` |
| 4 | `TypeError: expected a string, not null` |
| 4 | `TypeError: Cannot read properties of undefined (reading 'sort')` |
| 4 | `Test262Error: years result: Expected SameValue(«undefined», «0») to be true` |
| 3 | `TypeError: called value is not a function` |

ZonedDateTime/prototype (116 fail):

| count | text |
| --- | --- |
| 62 | `RangeError: unknown time zone UTC` |
| 18 | `TypeError: Cannot convert undefined or null to object` |
| 6 | `TypeError: Cannot read properties of undefined (reading 'equals')` |
| 3 | `TypeError: Cannot read properties of undefined (reading 'sort')` |
| 3 | `Test262Error: Expected a RangeError but got a undefined` |

### What the new buckets say about the next slices

- **`RangeError: unknown time zone UTC` is the new ZonedDateTime wall — 62 of
  116, and it did not exist before.** It is the *successor* of the RegExp
  bucket: the ISO/offset strings now parse, and the very next thing the
  polyfill does is resolve a time-zone identifier, which the standalone `Intl`
  refusal shim (`src/temporal-intl-shim.ts`, #5383 S2c) cannot answer. That is
  a self-contained, high-value next slice: the polyfill needs `"UTC"` (and
  fixed-offset zones) to resolve without an `Intl` time-zone database.
- **`canonicalizeCalendarEra` reading a calendar as `undefined` (21 PlainDate
  rows)** is unchanged from S7 — untouched by this slice, still the largest
  PlainDate bucket, still self-contained.
- **`Cannot read properties of undefined` / `Cannot access property on null or
  undefined` (≈45 rows)** is still several different missing members, not one
  bug.
- #5408's residual is attributed in that issue: `from(string)` no longer
  throws, but the object it returns is not a `PlainDate` — and `from(object)`,
  which touches no RegExp, fails the same way. One defect, two entry points,
  in the #5406 class.

### Artifacts

`.tmp/s8fam/{pd,du,zdt}-link.tsv` (+ `.log`) in the S8 worktree
`/home/user/js2/.claude/worktrees/agent-a7074906c110b4c3f`, produced by
`.tmp/s8/s8-family.mts` (a copy of S7's, label `s8`) and compared against
`/home/user/js2/.claude/worktrees/agent-ab8c96460934f2664/.tmp/s7fam/*-link.tsv`
with `.tmp/s8/s7-table.mjs`. Provider `cacheHit=true`,
`js2wasm:npm:@js-temporal/polyfill:1528a7d22b729f99`, 3,278,839 B (S7:
`75c71eaf308041cb`, 3,273,995 B — the artifact re-keys because the composed
patterns now lower to native programs).

### A trap worth repeating from S7, plus one new one

- The pre-warm stamp trap is unchanged: without a standalone-keyed stamp in the
  cache dir, every row runs UNLINKED and fails soft, which looks like a bad
  linked run. Tells: the `cacheHit=` log line, and zero `__temporal_*` leaks.
- **New: the quickjs eval provider must be present in the worktree, or every
  row fails with `JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not
  built`** — 120 rows of a uniform, Temporal-shaped-looking `Error:` that has
  nothing to do with Temporal. Two artifacts are needed, not one: the
  `.test262-cache/quickjs-artifact-<hash>/` directory AND the
  `.test262-cache/quickjs-eval-adapter-<key>.wasm` file. Symlinking only the
  first produces a second, differently-worded refusal naming the adapter.

## S9 findings (2026-09-13) — the `unknown time zone UTC` wall is gone; ZonedDateTime/prototype goes 2 → 32

**#6442 is the slice** (mechanism, census and the differential oracle are in
that issue). The one-line version: the polyfill's zone resolver
(`hr → ht(tz).resolvedOptions()`) was landing in its own `catch` because the
S2c `Intl` shim refuses every member, so every named zone — including `UTC` —
came back `undefined`. #5355's bound is about the CLDR/tzdata tables, and `UTC`
plus the fixed-offset `Etc/GMT±N` family needs no tables at all, so those are
now answered by a Wasm-native `Intl.DateTimeFormat` and everything else still
refuses.

Two route corrections worth carrying forward, both from the bundle census and
both the opposite of the obvious guess:

- **A `src/codegen/` arm would have been dead code.** The polyfill never sees
  the compiler's `Intl`: the S2c shim declares a module-scoped
  `const Intl = {…}` inside the provider's own compilation unit, so all 24
  `Intl.` reads in the bundle bind to that **lexical** name. The fix has to be
  in the shim's SOURCE. (`src/codegen/expressions/new-intl-host-bridge.ts` is
  untouched, and standalone *user* `Intl` is still absent entirely — #5206.)
- **The load-bearing surface is `format()`, not `formatToParts()`.** The offset
  path is `Fn → lr → ur → br → ht(tz).format(epochMs)`, and `br` parses the
  result with `split(/[^\w]+/)` into exactly seven word tokens (month, day,
  year, era, hour, minute, second), inverting the era itself (`o = 1 - o`).
  `formatToParts` is read only by the non-ISO calendar path, which still
  refuses.

### The three-family sample, LINKED, re-measured

120 rows each, `--target standalone`, provider linked, families run
**sequentially**, fresh `JS2WASM_TEMPORAL_CACHE` (`.tmp/s9cache`), quickjs eval
provider + adapter present. Linking confirmed both ways: every run log carries
`Temporal provider (standalone) js2wasm:npm:@js-temporal/polyfill:dc43b7a43e0bd370
(3312078 B) … cacheHit=true`, and `__temporal_*` leaks are **0** in all three
TSVs.

| family | rows | S8 linked pass | **S9 linked pass** | fail | compile_error | pass→fail |
| --- | --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 120 | 51 | **55** | 64 | 1 | **0** |
| `built-ins/Temporal/Duration/**` | 120 | 32 | **35** | 82 | 3 | **0** |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 120 | 2 | **32** | 86 | 2 | **0** |
| **total** | **360** | **85** | **122** | **232** | **6** | **0** |

37 rows flipped `fail→pass` (PlainDate 4, Duration 2, ZonedDateTime **30**).
There is **no pass→fail and no pass→compile_error row** in any family. All six
`compile_error` rows on the S9 side carry `compilation timeout` in their detail
(and the same is true of all eight on the S8 side), so the CE column is the
contention artifact S5–S8 already characterised, not a new refusal. Two of
Duration's S8 CEs resolved on their own this run (one to `pass`, one to `fail`,
matching its S7 verdict).

The `RangeError: unknown time zone UTC` bucket is **69 → 0** across the three
families (PlainDate 4→0, Duration 3→0, ZonedDateTime **62→0**).

**A contention warning, measured twice in this slice.** The first PlainDate run
overlapped two other jobs at load ≈10 and produced **seven** spurious
`fail→compile_error` flips; re-run alone at load ≈2 the same family produced
**one** CE — the same row S8 saw. The numbers above are from the uncontended
re-run (`.tmp/s9fam/pd-link-clean.tsv`); the contended one is kept as
`pd-link.tsv`. If a slice reports a CE rise, check the load before believing it.

### Top error buckets, LINKED, S9

PlainDate (64 fail) — unchanged from S8 except that the zone bucket left:

| count | text |
| --- | --- |
| 21 | `Test262Error: calendar must be string in canonicalizeCalendarEra Expected SameValue(«"undefined"», «"string"»)` |
| 8 | `TypeError: Cannot read properties of undefined (reading 'sort')` |
| 4 | `Test262Error: Expected a RangeError but got a undefined` |
| 4 | `TypeError: map callbackfn is not a function` |
| 3 | `TypeError: Object method called on null or undefined` |

Duration (82 fail):

| count | text |
| --- | --- |
| 9 | `TypeError: Cannot access property on null or undefined at 164:22` |
| 4 | `TypeError: expected a string, not null` |
| 4 | `TypeError: Cannot read properties of undefined (reading 'sort')` |
| 4 | `Test262Error: years result: Expected SameValue(«undefined», «0») to be true` |
| 3 | `TypeError: called value is not a function` |

ZonedDateTime/prototype (86 fail):

| count | text |
| --- | --- |
| 18 | `TypeError: Cannot convert undefined or null to object` |
| 12 | `TypeError: Cannot read properties of undefined (reading 'sort')` |
| 6 | `TypeError: Cannot read properties of undefined (reading 'equals')` |
| 4 | `TypeError: called value is not a function` |
| 3 | `Test262Error: Expected a RangeError but got a undefined` |

### Two standalone samples that must NOT move, and did not

`--target standalone`, first 120 rows of each, base by file-copy revert of
`src/temporal-intl-shim.ts` on the same (post-merge) tree:

| sample | base | S9 | pass→fail | flips |
| --- | --- | --- | --- | --- |
| `intl402/DateTimeFormat/**` | 2 pass / 115 fail / 3 CE | 2 pass / 115 fail / 3 CE | **0** | **0** |
| `built-ins/Date/prototype/**` | 120 pass | 120 pass | **0** | **0** |

Expected, and worth stating why rather than only that: the shim is prepended to
the PROVIDER source only, and these rows carry no `Temporal` feature, so they
never build one. The byte A/B says the same thing structurally — all 22
(module, target) artifacts in the fixed corpus are identical on both `gc` and
`standalone` — and the provider-key A/B pins the lane boundary: the `gc` key is
unchanged at `372a41be…` while standalone (`53f91978…` → `ee23a4e9…`) and wasi
(`4ff8fb73…` → `359c6e28…`) re-key, which is the mechanism that makes serving a
stale standalone artifact impossible.

### What the new buckets say about the next slices

- **The `unknown time zone` successor is `Cannot convert undefined or null to
  object` (18) plus `reading 'sort'` (12) — and `'sort'` GREW from 3 to 12 in
  ZonedDateTime.** That growth is not a regression: those rows previously died
  at zone resolution and now get far enough to hit a later missing member. The
  two together are 30 of the 86 remaining failures and are the obvious next
  census.
- **`canonicalizeCalendarEra` (21 PlainDate rows) is now the single largest
  bucket in the sample and is adjacent to this slice but deliberately outside
  it.** It goes through `new Intl.DateTimeFormat("en-US-u-ca-<id>", …)`, which
  #6442 refuses at the locale gate on purpose: answering it needs era data, and
  `getCalendarParts` also wants `relatedYear` / `eraYear` parts. Whether
  `gregory` alone is answerable table-free is a real question and needs its own
  census before anyone writes code.
- **`Etc/GMT±N` transition queries are slow by construction upstream.**
  `wr`/`vr` early-out only on the literal string `"UTC"`, so
  `getTimeZoneTransition` on a non-UTC fixed zone walks the epoch range in
  14-day steps. Identical on Node with real ICU; it affects only that method.

### Artifacts

`.tmp/s9fam/{pd-link-clean,pd-link,du-link,zdt-link}.tsv` (+ `.log`) in the S9
worktree `/home/user/js2/.claude/worktrees/agent-aaa550e05def3c1e0`, produced by
`.tmp/s9/family.mts` (a copy of S8's, label `s9`) and compared against
`.tmp/s8fam-ref/*-link.tsv` (a copy of the S8 worktree's TSVs) with
`.tmp/s9/table.mjs`. Provider `cacheHit=true`,
`js2wasm:npm:@js-temporal/polyfill:dc43b7a43e0bd370`, 3,312,078 B (S8:
`1528a7d22b729f99`, 3,278,839 B — the artifact re-keys because the shim source
changed, which is the mechanism that makes a stale standalone artifact
impossible). The reduction, the differential oracle, the byte A/B and the
provider-key A/B are `.tmp/s9/{reduce,oracle,ab,keys}.*`.

### Traps, carried forward and added to

- The pre-warm stamp trap and the quickjs-provider trap from S7/S8 are
  unchanged, and both still bite: without a standalone-keyed stamp every row
  runs UNLINKED and fails soft; without BOTH
  `.test262-cache/quickjs-artifact-<hash>/` and
  `.test262-cache/quickjs-eval-adapter-<key>.wasm` every row fails with a
  uniform, Temporal-shaped-looking `Error:` that has nothing to do with
  Temporal.
- **New: do not edit a `src/` file that feeds the provider's cache key while a
  family run is in flight.** The key is recomputed per runner PROCESS, so a
  mid-run edit silently makes the three families measure two different
  artifacts. This cost one S9 re-plan: a three-line receiver guard had to be
  reverted and re-landed as a test-contract change instead, because applying it
  mid-run would have invalidated the measurement.
- **New: a string-returning probe cannot cross into Node.** A WasmGC string ref
  is not `String()`-able from the harness, so a probe that returns one fails
  with `Cannot convert object to primitive value` and says nothing about the
  compiler. Return an integer verdict and, when a string genuinely has to be
  inspected, export a `charCodeAt`-style accessor (`.tmp/s9/dumpstr.mjs`).

## S10 findings (2026-09-13) — the property-bag wall is gone; the linked lane goes 122 → 139, and the boundary turns out not to be the suspect

**#6447 is the slice** (census, mechanism and the reduction are in that issue).
The one-line version: under `--target standalone`, `Array.prototype.concat` and
`.sort` on a receiver whose static type is `any` answered `undefined`, because
the closed-method dispatcher has brand arms for the callback family (#3098/#4394),
`push`/`pop` (#2927) and the collections (#3309) but never had one for the PURE
PRODUCER methods — and `__extern_method_call`, the bottom arm they fell to,
returns `undefined` for every non-`$Object` brand by construction (its own
comment says so). The polyfill's `PrepareCalendarFields` is
`const a = n.concat(r, i); … a.sort();` with `n` an untyped parameter, so every
property-bag entry point died on `a.sort()`.

### The census, and what it changed about where to look

The S9 brief pointed at the link boundary (#5406) for three of the four biggest
buckets. **Measured, the boundary is not at fault for any of them.** Through the
shipped linked path (`.tmp/s10/reduce.mjs`, provider `dc43b7a43e0bd370`,
`cacheHit=true`, `hostBridge: "off"`, empty import object):

| probe, base tree | answer |
| --- | --- |
| `date.calendarId` read through an `any` PARAMETER | correct string |
| `date.year` read through an `any` parameter | 2020 |
| `date.era` through an `any` parameter | `undefined` (correct) |
| `zdt.equals(zdt)`, and the same through parameters | `true` |

So `__js2wasm_link_member_get` and the method-call terminal both answer. What
does NOT answer is anything that reaches the polyfill's field-name machinery —
and that is module-LOCAL codegen inside the provider, reachable with no link at
all. The single-module probe (`.tmp/s10/single6.mjs`, receiver `["b","a"]`
through a function parameter) is the whole finding:

| member on an `any` receiver, standalone | base | S10 |
| --- | --- | --- |
| `concat`, `sort` | **WRONG** | **ok** |
| `slice`, `reverse`, `includes`, `splice`, `flat` | WRONG | WRONG (residual, #6447) |
| `map`, `filter`, `join`, `indexOf`, `push`, `[...n]`, `Array.from` | ok | ok |

### Attribution table (bucket → root cause → terminal)

| bucket (S9 linked sample) | rows | root cause | terminal / site |
| --- | --- | --- | --- |
| `reading 'sort'` | 24 | **A** — `any`-receiver `concat` answers `undefined` | `__call_m_concat_2` → `__extern_method_call`, no `$__vec_base` arm |
| `canonicalizeCalendarEra … undefined` | 21 | **A** for the `from(bag)` rows (14 of 21 are `from/argument-*`): the result is not a `PlainDate`, so the harness's `date.calendarId` reads `undefined` | same |
| `reading 'equals'` | 6 | **A** | same |
| `Cannot convert undefined or null to object` | 18 | **B** — `Object.getOwnPropertyDescriptor(<provider>.prototype, k)` across the link | NOT A; see residuals |

Classified by the THROWN text through the real provider (`.tmp/s10/reduce2.mjs`),
every property-bag entry point was the same defect reached five ways —
`PlainDate.compare(bag, ·)`, `PlainDate.from(bag)`, `ZonedDateTime.equals(bag)`,
`plainDate.with(bag)` all raised `reading 'sort'`, while `from(string)`,
`Duration.from(bag)` and `from(plainDate)` did not. After the fix all seven
return without throwing.

### The three-family sample, LINKED, re-measured

120 rows each, `--target standalone`, provider linked, families run
**sequentially** at load ≈1.3, fresh `JS2WASM_TEMPORAL_CACHE` (`.tmp/s10famcache`),
quickjs eval provider + adapter present. Linking confirmed both ways: every run
log carries `Temporal provider (standalone)
js2wasm:npm:@js-temporal/polyfill:c97cf3351a9120b1 (3313960 B) … cacheHit=true`,
and `__temporal_*` leaks are **0** in all three TSVs.

| family | rows | S9 linked pass | **S10 linked pass** | fail | compile_error | pass→fail |
| --- | --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 120 | 55 | **62** | 57 | 1 | **0** |
| `built-ins/Temporal/Duration/**` | 120 | 35 | **38** | 79 | 3 | **0** |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 120 | 32 | **39** | 79 | 2 | **0** |
| **total** | **360** | **122** | **139** | **215** | **6** | **0** |

17 rows flipped `fail→pass` (PlainDate 7, Duration 3, ZonedDateTime 7). There is
**no pass→fail and no pass→compile_error row** in any family, and the CE counts
are identical on both sides (all carry `compilation timeout`). The
`reading 'sort'` bucket is **24 → 0** (PlainDate 8→0, Duration 4→0,
ZonedDateTime 12→0).

### Top error buckets, LINKED, S10

PlainDate (57 fail):

| count | text |
| --- | --- |
| 21 | `Test262Error: calendar must be string in canonicalizeCalendarEra Expected SameValue(«"undefined"», «"string"»)` |
| 7 | `TypeError: year is required` |
| 4 | `TypeError: map callbackfn is not a function` |
| 3 | `TypeError: Object method called on null or undefined` |
| 2 | `Test262Error: prototype Expected SameValue(«null», «[object Function]») to be true` |

Duration (79 fail):

| count | text |
| --- | --- |
| 9 | `TypeError: Cannot access property on null or undefined at 164:22` |
| 5 | `TypeError: called value is not a function` |
| 4 | `TypeError: expected a string, not null` |
| 4 | `Test262Error: years result: Expected SameValue(«undefined», «0») to be true` |
| 2 | `TypeError: invalid duration-like` |

ZonedDateTime/prototype (79 fail):

| count | text |
| --- | --- |
| 18 | `TypeError: Cannot convert undefined or null to object` |
| 7 | `TypeError: required property 'timeZone' missing or undefined` |
| 6 | `TypeError: Cannot read properties of undefined (reading 'equals')` |
| 5 | `TypeError: called value is not a function` |
| 3 | `Test262Error: Expected a RangeError but got a undefined` |

### Two standalone samples that must NOT move, and did not

`--target standalone`, first 120 rows of each, base by file-copy revert of
`src/codegen/closed-method-dispatch.ts` + parking `dyn-array-producers.ts`, on
the same tree. Both are tied to what this slice touched (dynamic Array method
dispatch, and the `$ObjVec`/`Object.keys` carrier the arm produces):

| sample | base | S10 | pass→fail | flips |
| --- | --- | --- | --- | --- |
| `built-ins/Array/prototype/**` | 79 pass / 40 fail / 1 CE | 79 / 40 / 1 | **0** | **0** |
| `built-ins/Object/**` | 106 pass / 14 fail | 106 / 14 | **0** | **0** |

### Order preservation

17 module shapes × {gc, standalone}, base captured by file copy before the first
edit (`.tmp/s10/ab-{base,new}.out`): **all 17 `gc` artifacts sha256-identical.**
On standalone exactly three moved — `dynConcat`, `dynSort`, `dynSortCmp`, the
three shapes that actually make a dynamic producer call. Everything else is
byte-identical, including the two controls that matter most: `dynSlice` /
`dynMap` / `dynPush` (dynamic calls to members this slice does NOT serve) and
`arraysTypedConcat` / `arraysTypedSort` (the typed path, which keeps its
Timsort). The arm is gated on `ctx.standalone` and on a `$__vec_base`
registration, so the gc lane cannot reach it and a standalone module with no
dynamic `concat`/`sort` never reserves the dispatcher.

### What the new buckets say about the next slices

- **`canonicalizeCalendarEra` (21 PlainDate rows) is now the largest single
  bucket and it did NOT move.** Its successor inside the same family is
  `TypeError: year is required` (0 → 7): those `from(bag)` rows now get past
  the field-name machinery and fail later, in field EXTRACTION. That is the
  #5408 residual, not this one.
- **`Cannot convert undefined or null to object` (18 ZDT rows) is unchanged and
  is a clean, self-contained next slice.** It is the whole
  `ZonedDateTime/prototype/*/{branding,prop-desc}.js` family, and it reduces to
  one line: `Object.getOwnPropertyDescriptor(Temporal.ZonedDateTime.prototype,
  "day")` across a link throws instead of answering an accessor descriptor. It
  needs a `__js2wasm_link_*` descriptor terminal — the #5406 class, one level up
  from the member-get terminal that already works.
- **`x instanceof <provider class>` through an `any` PARAMETER answers `false`**
  where the same test on a directly-bound local answers `true`
  (`.tmp/s10/reduce.mjs`). Measured but not attributed to a bucket; worth a
  census of its own before anyone writes code.
- **Residual inside #6447 itself:** `slice`, `reverse`, `includes`, `splice` and
  `flat` on an `any` receiver are still wrong, by the same mechanism. They are
  PINNED by an executable assertion in
  `tests/issue-6447-standalone-dynamic-array-producers.test.ts` so the residual
  fails loudly when someone fixes it rather than rotting as a note.

### Artifacts

`.tmp/s10fam/{pd,du,zdt}-link.tsv` (+ `.log`) and
`.tmp/s10fam/{arr,obj}-{base,new}.tsv` in the S10 worktree
`/home/user/js2/.claude/worktrees/agent-ad1acad18940e0c59`, produced by
`.tmp/s10/family.mts` (a copy of S9's, label `s10`) and compared against
`.tmp/s10ref/*.tsv` (copies of the S9 worktree's TSVs) with `.tmp/s10/table.mjs`.
Provider `cacheHit=true`, `js2wasm:npm:@js-temporal/polyfill:c97cf3351a9120b1`,
3,313,960 B (S9: `dc43b7a43e0bd370`, 3,312,078 B — the artifact re-keys because
the compiler changed, which is the mechanism that makes a stale standalone
artifact impossible). The census, the reductions and the byte A/B are
`.tmp/s10/{single3..6,reduce,reduce2,reduce3,ab}.*`.

### Traps, carried forward and added to

- The pre-warm stamp trap (S7) and the quickjs-provider trap (S8) are unchanged.
- **New, and it cost this slice a full family run: a SYMLINKED `.test262-cache`
  entry silently outlives its target.** S9's cache was obtained by `cp -a` from
  the S8 worktree, which preserved a symlink into the S7 worktree; when S7 was
  reaped the link dangled. `ls .test262-cache` still lists
  `quickjs-artifact-<hash>`, so the cache reads as PRESENT, and the failure
  arrives 120 rows later as the uniform `Error: JS2WASM_EVAL_ENGINE=quickjs but
  the quickjs provider is not built` that S8 already warned looks
  Temporal-shaped. Copy with `cp -rL` (real files), not `cp -a`, and check
  `ls -la .test262-cache/quickjs-artifact-*/libquickjs.wasm` — not just the
  directory name — before believing a run. Rebuilding from source is cheap
  (`node --import tsx scripts/build-quickjs-eval-provider.mjs`, ~55 s here, needs
  clang-18 + network).
- **New: the worktree harness replaces the tracked `test262` symlink with a
  DIRECTORY of per-entry symlinks, repeatedly.** It did so at worktree setup and
  again after a vitest run. Reads keep working, which is why it goes unnoticed;
  `git status` then shows `D test262`. Never `git add -A`, and run
  `rm -rf test262 && git checkout -- test262` before staging.
- **New: a mid-run `pkill -f test262-worker.mjs` from another lane is
  indistinguishable from a real regression.** It hit this slice's
  `built-ins/Array/prototype` sample at 05:05; the rows were quarantined as
  `*-SUSPECT.tsv` and the sample re-run from scratch. If a sample shows a burst
  of `fail`/`compile_error` with no matching source change, check whether
  another lane was cleaning up before believing it.

## S11 findings (2026-09-13) — the class PROTOTYPE read, and the third wrong boundary attribution in a row

**#6457 is the slice** (census, mechanism and the reduction are in that issue).
The one-line version: under `--target standalone`, `K.prototype` where `K` is a
compiled class OBJECT held in an `any` binding answered `undefined`, because
`__extern_get` reaches a class object through `__class_proto_lookup`'s
class-object arm — which answers the STATIC SIDECAR `$Object` (static methods
and accessors) — and `prototype` is not on it. Nothing else in the dynamic
ladder knew a class value has a prototype singleton at all. Across a link every
`Temporal.X` is a dynamic receiver by construction, so
`Object.getOwnPropertyDescriptor(Temporal.ZonedDateTime.prototype, "day")`
handed `gOPD` an `undefined` and threw.

### The census, and the attribution that was wrong AGAIN

S10's hand-off called the 18-row `Cannot convert undefined or null to object`
bucket "the #5406 class, needs a descriptor terminal". It is not a boundary
defect at all. The reduction (`.tmp/s11/c2.mjs`) is ONE standalone module, no
provider, no link, no `Temporal`:

| probe, `--target standalone` | static receiver `C` | dynamic receiver `K` |
| --- | --- | --- |
| `typeof recv.prototype` | `object` | **`undefined`** |
| `gOPD(recv.prototype, "day")` | descriptor | **throws** |
| `new recv(1) instanceof recv` | `true` | **`false`** |
| `typeof recv` / `typeof new recv(1)` | function / object | function / object (ok) |

That is now **three consecutive slices** where the hand-off blamed the link
boundary and the defect was module-local codegen inside the provider (S9→S10 on
`reading 'sort'`, S10→S11 here). The boundary terminals answer; the ladders
behind them are what miss. Census first, in ONE module, before writing a
terminal.

### Attribution table (bucket → root cause → terminal)

| bucket (S10 linked sample) | rows | root cause | where |
| --- | --- | --- | --- |
| `Cannot convert undefined or null to object` | 18 | **A** — dynamic `K.prototype` answers `undefined` | MODULE-LOCAL: `__extern_get`'s class-object arm, no `prototype` route |
| `prototype Expected SameValue(«null», «[object Function]»)` | 2+3 | **A** | same |
| `Cannot access property on null or undefined at 164:22` | 9 | **C** — SPREAD arguments into a linked constructor lose their values (`new Temporal.Duration(...args)` is not a number where `new Temporal.Duration(1,1,1)` is) | LINKED only; `temporalHelpers.js` L164 is `assertDuration`'s `duration.months` and every row in the bucket constructs with `...args` |
| `calendar must be string in canonicalizeCalendarEra` | 21 | **NOT a member-read shape** — every harness-shape reduction (object-literal method forwarding `date.calendarId` into a second method) answers a correct string; `PlainDate.from(bag)` returns an object whose `year`/`month`/`day` are `NaN`. Field EXTRACTION, the #5408 residual | — |
| `required property 'timeZone' missing` | 7 | **NOT reproduced**: `zdt.equals(<bag with timeZone>)` answers `true` and `ZonedDateTime.from(bag).timeZoneId` answers a string in reduction | — |
| `year is required` | 7 | same family as the 21 | — |

Also measured and not attributed: `typeof <provider-owned instance>` answers
`"function"` where it should answer `"object"` (the single-module control
answers `"object"`) — the `__js2wasm_link_callable_kind` terminal classifies
every provider value as callable. And `Temporal.Duration.from("P1Y")` TRAPS
(`dereferencing a null pointer`) where `from(bag)` and `from(duration)` answer.

### The three-family sample, LINKED, re-measured

120 rows each, `--target standalone`, provider linked, families run
**sequentially**, fresh `JS2WASM_TEMPORAL_CACHE` (`.tmp/s11famcache-new`),
quickjs eval provider + adapter present as real files. Linking confirmed both
ways: every run log carries `Temporal provider (standalone)
js2wasm:npm:@js-temporal/polyfill:2c0506a30fe8f23d (3314480 B) … cacheHit=true`,
and `__temporal_*` leaks are **0** in all three TSVs.

| family | rows | S10 linked pass | **S11 linked pass** | fail | compile_error | pass→fail |
| --- | --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 120 | 62 | **62** | 57 | 1 | **0** |
| `built-ins/Temporal/Duration/**` | 120 | 38 | **43** | 74 | 3 | **0** |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 120 | 39 | **65** | 53 | 2 | **0** |
| **total** | **360** | **139** | **170** | **184** | **6** | **0** |

31 rows flipped `fail→pass` (ZonedDateTime 26, Duration 5, PlainDate 0). The
ZonedDateTime flips are the entire
`prototype/*/{branding,prop-desc,length,name,not-a-constructor}` surface; the
Duration five are `prototype/abs/*`, the same surface.

**The CE column needs its solo re-run to read correctly.** The sampled run
scored five rows `compile_error` that base scored `fail`; re-run SOLO at a 60 s
compile budget (`.tmp/s11/rerun.mts`) **all five answer `fail`**, at 13.0–17.5 s
against the sample's 15 s budget. They are load-induced compile timeouts from
the concurrent lanes this session ran, not the change. With them restored the CE
counts equal base in every family.

### Top error buckets, LINKED, S11

PlainDate (57 fail): 19 `calendar must be string in canonicalizeCalendarEra` ·
7 `year is required` · 4 `map callbackfn is not a function` · 3 `Object method
called on null or undefined` · 2 `prototype Expected SameValue(«null», «[object
Function]»)`.

Duration (74 fail): 9 `Cannot access property on null or undefined at 164:22` ·
5 `called value is not a function` · 4 `expected a string, not null` · 4 `years
result: Expected SameValue(«undefined», «0»)` · 3 `prototype Expected
SameValue(«null», «[object Function]»)`.

ZonedDateTime/prototype (53 fail): 7 `required property 'timeZone' missing` ·
6 `Cannot read properties of undefined (reading a class field)` · 6 `reading
'equals'` · 3 `Expected a RangeError but got a undefined` · 3 `invalid receiver:
method called with the wrong type of this-object`.

### Two standalone samples that must NOT move, and did not

`--target standalone`, first 120 rows of each, base by file-copy revert of
`src/codegen/{index,property-access}.ts` on the same tree. Both are tied to what
this slice touched (descriptors — `gOPD` is the arm's consumer — and class
identity):

| sample | base | S11 | pass→fail | flips |
| --- | --- | --- | --- | --- |
| `built-ins/Object/**` | 106 pass / 14 fail | 106 / 14 | **0** | **0** |
| `language/expressions/class/**` | 70 pass / 38 fail / 12 CE | 70 / 38 / 12 | **0** | **0** |

### Order preservation

21 module shapes × {gc, standalone}, base captured by file copy before the first
edit (`.tmp/s11/ab-{base,new}.out`): **all 21 `gc` artifacts sha256-identical,
and on standalone exactly ONE moved** — `dynProtoGopd`, the
`gOPD(K.prototype, …)` shape this slice exists for. Every control is
byte-identical, including `classesNoDynProto` (a class module with no dynamic
prototype read) and `dynOtherName` (a dynamic read of a different name). The
fill is gated on `ctx.standalone` and on a non-empty dynamic-read demand set, so
the gc lane cannot reach it and an ordinary standalone module never pays.

### Traps, carried forward and added to

- The pre-warm stamp trap (S7), the quickjs-provider trap (S8), the symlinked
  cache trap and the `test262` gitlink trap (S10) are unchanged and all still
  bite: this worktree arrived with `test262` as an EMPTY directory and no
  `node_modules`.
- **NEW, and it cost this slice a full round of linked measurements: the
  standalone Temporal provider cache is NOT keyed on the compiler.**
  `temporalProviderCacheKey` fingerprints the polyfill source, the `Intl` shim
  and the compile OPTIONS — nothing about the compiler build. After a codegen
  change `buildTemporalProvider` reports `cacheHit=true` and serves the artifact
  built by the PREVIOUS tree, so every linked probe answers the old way and the
  delta reads as exactly zero while the single-module probes have already
  flipped. (S10's note that "the artifact re-keys because the compiler changed"
  is not what the key does; those two runs differed because the shim text
  differed.) Point the cache dir at a FRESH directory after every codegen edit,
  and read the `cacheHit=` / namespace-hash line before believing a number.
- **NEW: do not run other lanes during a family sample.** Five rows crossed the
  15 s compile budget purely from concurrent load and scored `compile_error`,
  which reads exactly like a real regression. Run the sample alone, or re-run
  every CE solo at 60 s before reporting it.

### Artifacts

`.tmp/s11fam/{pd,du,zdt}-new.tsv` (+ `.log`), `.tmp/s11fam/{obj,cls}-{base,new}.tsv`
and `.tmp/s11/{c1..c5,ab-base,ab-new,rerun-ce}.out` in this worktree
(`/home/user/js2/.claude/worktrees/agent-ab3088a1741753e94`), produced by
`.tmp/s11/family.mts` (a copy of S10's, label `s11`) and compared against
`.tmp/s11fam/{pd,du,zdt}-s10.tsv` (copies of the S10 worktree's TSVs) with
`.tmp/s11/table.mjs`.

## S12 findings (2026-09-13) — the brief's attribution did not reproduce; the fixed cause is `new` with a spread, and the SCORE does not move

**#6460 is the slice.** Two things are worth more than the delta.

### 1. The hand-off attribution was wrong AGAIN, in the other direction this time

S11 handed S12 "property-bag FIELD EXTRACTION inside the provider
(`PrepareCalendarFields` / `ToIntegerWithTruncation`)". Measured module-locally
— one standalone module, no provider, no link — **every constituent of that
path answers correctly**: `Object.create(null)` computed writes read back
through a dot; `bag[k]` with `k` taken from a `concat`ed and then `sort`ed key
array; `["year","month"].concat(["day"],[]).sort()` → `3:day,month,year`; and
the whole `tn` shape with untyped parameters → `y=1976 m=11 mc=D d=18`.

Where the previous three slices were handed a LINK attribution and found
module-local codegen, this one was handed a MODULE-LOCAL attribution and the
residual is cross-module. The lesson survives inverted: **the census, in one
module, is what decides — not the direction of the previous correction.**

### 2. The dominant residual, named and reduced but deliberately not started

Every `X.from(…)` hands back an object whose accessor and method reads answer
`null`: `PlainDate.from("1976-11-18").day` → `null`, `String(…)` → `null`, and
likewise `PlainDateTime.from`, `PlainTime.from`, `Instant.from`,
`ZonedDateTime.from`. The control `new Temporal.PlainDate(1976,11,18).day`
answers `18`. The polyfill builds `from`'s results with
`Object.create(intrinsic.prototype)` + WeakMap slots (`pn`, bundle L1946), not
with `new` — and the single-module control (`Object.create(C.prototype)` where
`C` has a getter) answers `18` correctly, so this is boundary identity.
Attributed **~40 of the 360 rows** (PlainDate `canonicalizeCalendarEra` 21 +
`year is required` 7, ZonedDateTime `timeZone` 7 + `reading 'equals'` 6).

Cheapest handle for the next slice:
`Object.getOwnPropertyNames(Temporal.PlainDate.prototype)` **TRAPS**
(`illegal cast`). That trap is upstream of everything else in the list.

### What was fixed

A spread whose source is a `const` array binding has no STATIC arity, and two
lowerings were asking the same too-narrow question (`flattenCallArgs`, which only
recognises an inline array literal). The construct drivers are minted one per
call-site arity, so the site declined and `new Temporal.Duration(...args)`
evaluated to **`null`**; and the ordinary-function `new` path put the whole
ARRAY in the first parameter. Fixed in `src/codegen/static-spread-arity.ts`
(standalone/WASI-gated), with the refusal rules and the byte A/B in #6460.

### The three-family sample, LINKED, re-measured

120 rows each, `--target standalone`, provider linked, families run
**sequentially**, FRESH `JS2WASM_TEMPORAL_CACHE` per label
(`.tmp/s12famcache-{base,new}`), quickjs eval provider + adapter present as real
files. Every run log carries `Temporal provider (standalone)
js2wasm:npm:@js-temporal/polyfill:2c0506a30fe8f23d (3314480 B) … cacheHit=true`,
and `__temporal_*` leaks are **0** in all three TSVs.

**The base column is this worktree's own base run** (file-copy revert of the
three touched files), not S11's numbers: S11's Duration figure was 43 and this
tree's base sample scored 42, a one-row compile-budget artifact that the solo
re-runs below resolve to 43. Comparing a new run against another worktree's
number would have manufactured a +1.

| family | rows | base pass | **S12 pass** | fail | compile_error | pass→fail |
| --- | --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 120 | 62 | **62** | 56 | 2 | **0** |
| `built-ins/Temporal/Duration/**` | 120 | 43 | **43** | 72 | 5 | **0** |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 120 | 65 | **65** | 52 | 3 | **0** |
| **total** | **360** | **170** | **170** | **180** | **10** | **0** |

**The score does not move, and that is the finding.** What moves is the bucket:
Duration's `Cannot access property on null or undefined at 164:22` goes
**9 → 4**, and five rows advance to `explicit: years result: Expected
SameValue(«undefined», «1»)` — i.e. the constructor now returns a real Duration
and the row dies one step later, on the residual above. Of the four rows left in
the bucket, two (`microseconds-undefined.js`, `nanoseconds-undefined.js`) spread
8 elements plus a trailing `undefined` = arity 9, over
`MAX_NATIVE_CONSTRUCT_ARITY` (8); the other two use no spread at all.

**Every CE↔fail/pass flip in the sample was a compile-budget artifact, and this
was established by running the SAME six rows solo at 60 s on BOTH trees**, not
by re-running the branch alone and reasoning about the base:

| row | base solo | S12 solo |
| --- | --- | --- |
| `PlainDate/from/argument-plaindate.js` | fail 18.1 s | fail 18.2 s |
| `Duration/call-builtin.js` | fail 13.7 s | fail 15.3 s |
| `Duration/compare/order-of-operations.js` | fail 16.2 s | fail 15.7 s |
| `Duration/from/argument-string-fractional-precision.js` | **pass 29.4 s** | **pass 30.2 s** |
| `Duration/from/argument-string-fractional-units-rounding-mode.js` | fail 14.0 s | fail 13.7 s |
| `ZonedDateTime/prototype/add/constrain-when-ambiguous-result.js` | fail 15.4 s | fail 15.4 s |

All six agree across trees. Had only the branch been re-run, the
`fractional-precision` row (29 s against the sample's 15 s budget) would have
been reported as a +1 in Duration; it is not one.

### Top error buckets, LINKED, S12

PlainDate (56 fail): 20 `calendar must be string in canonicalizeCalendarEra` ·
2 `illegal cast in __class_construct_dispatch()` · 2 `year is required` ·
2 `prototype Expected SameValue(«null», «[object Function]»)`.

Duration (72 fail): 5 `dereferencing a null pointer in sn()` ·
5 `explicit: years result: Expected SameValue(«undefined», «N»)` (NEW — the five
rows this slice advanced) · 5 `years result: Expected SameValue(«undefined»,
«N»)` · 4 `Cannot access property on null or undefined at 164:22` (was 9).

ZonedDateTime/prototype (52 fail): 7 `required property 'timeZone' missing` ·
6 `Cannot read properties of undefined (reading a class field)` · 6 `reading
'equals'` · 4 `dereferencing a null pointer in sn()` · 3 `Expected a RangeError
but got a undefined`.

### Two standalone samples that must NOT move, and did not

`--target standalone`, base by file-copy revert on the same tree. Both tied to
what this slice touched (the `new` lowering and the dynamic object surface its
drivers use):

| sample | base | S12 | pass→fail | flips |
| --- | --- | --- | --- | --- |
| `language/expressions/new/**` (59 rows — the whole directory) | 56 pass / 3 fail | 56 / 3 | **0** | **0** |
| `built-ins/Object/**` (first 120) | 106 pass / 14 fail | 106 / 14 | **0** | **0** |

### Order preservation

Two corpora, base captured by file copy at the FIRST edit
(`.tmp/base-{new-super,fnctor-constructor-identity}.ts`):

- 40 modules (`website/playground/examples/**` + `tests/fixtures/**`) ×
  {gc, standalone}: **80/80 sha256-identical**. That corpus contains no
  spread-into-`new`, so it is a no-collateral control, not a positive one.
- a targeted 11-shape corpus supplies the positive control: **all 11 `gc`
  artifacts identical**, and on standalone exactly three move — the three
  spread-into-function-constructor shapes this slice repairs. Every refusal
  control (mutated source, `let` source, non-literal elements), the class-`new`
  shape, the dynamic-call shape and the plain controls are byte-identical.

### Traps, carried forward and added to

- All prior traps still bite. This worktree arrived with `test262` **absent**
  and no `node_modules`.
- **NEW, and it cost a full round of family measurements: `JS2WASM_EVAL_ENGINE=quickjs`
  with no built artifact fails EVERY row**, with an error that names the missing
  `libquickjs.wasm` — so a first base run scored PlainDate **0 pass / 119 fail**
  and looked like a catastrophic regression. Copying the artifact from a sibling
  worktree's `.test262-cache/` restored the expected 62. Check
  `ls -la .test262-cache/quickjs-artifact-*/libquickjs.wasm` before believing
  any family number, base or branch.
- **NEW: `git push` exit status is not the hook's.** The first push of this
  branch ran the pre-push `typecheck` before `pnpm install` had been run in the
  fresh worktree, printed `Fix typecheck errors before pushing` and pushed
  nothing — while the backgrounded wrapper still reported `[exited with code 0]`.
  The branch looked pushed for two hours. Verify with
  `git ls-remote origin <branch>`, never with the exit code of a backgrounded
  push.
- **The S11 "new namespace hash" tell does not exist.** `temporalProviderCacheKey`
  fingerprints the polyfill source and the compile options, so after a codegen
  change the namespace hash and the artifact BYTE COUNT are both unchanged. The
  only usable tell is `cacheHit=false` against a FRESH cache directory, which is
  what this slice used.

### Artifacts

`.tmp/s12fam/{pd,du,zdt,mnm-new,mnm-obj}-{base,new}.tsv` (+ `.log`),
`.tmp/s12/{census1..6,byteab-{base,new},byteab2-{base,new}}.*` and the probe sets
`.tmp/s12/p-*.mjs` in this worktree
(`/home/user/js2/.claude/worktrees/agent-a07c5e7da05114ff6`), produced by
`.tmp/s12/family.mts` (a copy of S11's, label `s12`) and compared with
`.tmp/s12/table.mjs`.

### Acceptance criterion 4 — S12 update

Unchanged in substance: MET-for-the-sample at 170/360, measured on the same
three families, with **0 pass→fail** and both must-not-move samples flat. The
S12 run adds one qualification that the earlier updates could not make — the
base column was measured **on this tree**, by file-copy revert, so the 170 is a
self-consistent before/after and not a comparison across worktrees. No
full-corpus number is claimed; a corpus run remains the tech lead's to schedule.

## S13 findings (2026-09-13) — the `from()` results are repaired; the linked lane goes 170 → 177, and the defect was never at the link

**#6464 is the slice.**

### 1. The hand-off attribution was wrong for the FIFTH slice running, and the pattern is now nameable

S13 was handed "boundary identity: the consumer reads a provider-created
`Object.create(proto)` object through the link". It is neither a link defect nor
an `Object.create` defect in general. It reproduces in ONE standalone module
with no provider, no package edge and no linker, and the variable is the
**spelling of the prototype argument** (`.tmp/s13/c7.out`):

| carrier, `--target standalone`, one module | `o.self() === o` | `o.day` |
| --- | --- | --- |
| `Object.create(K.prototype)`, `K` a VALUE | **false** | **−1** |
| `Object.create(C.prototype)`, `C` a class identifier | true | 18 |
| `new C()` | true | 18 |

The pattern across S10–S13 is not "the brief points the wrong way"; it is that
**the brief names the place the symptom was OBSERVED, and the census finds the
place the decision was MADE.** Those are different in four of the last four
slices, and they are different in opposite directions (S12 was handed
module-local and found cross-module; S13 was handed cross-module and found
module-local). The only procedure that survives both is: reduce, and let the
single-module control decide.

### 2. A harness property that makes a whole class of census UNATTRIBUTABLE

The first two probe sets of this slice put every probe in one consumer module,
and they **disagreed with each other over the same provider** — `NS.num()`
answered `18` in one set and `null` in another. Module CONTENT decides the
answer (the #6432 action-at-a-distance hazard), so a shared-module census cannot
attribute anything. Every number in #6464 comes from `.tmp/s13/pair2.mjs`, which
builds the provider once and compiles **one probe per consumer module**. The
shared-module harness is kept only as the record of why.

### 3. Root cause

`tryCompileObjectCreateStaticPrototype` lowers the *syntactic*
`<ClassIdentifier>.prototype` to `struct.new $C`. A dynamic `K.prototype` misses
it and falls to the native `__object_create`, which returns a plain `$Object`
that merely inherits from the class prototype — and a compiled class member takes
`this` as a concrete `(ref $C)`, which a plain `$Object` can never satisfy, so
the bridge binds the PROTOTYPE as the receiver. Every WeakMap slot keyed on the
created object then misses.

#5239 fixed exactly this for the JS-host lane. Its emitter opens
`if (ctx.wasi || ctx.standalone || noJsHost(ctx)) return;` — it is an export the
JS runtime's `__object_create` calls back into, so it has no meaning without a
host — and **nothing ever replaced it**. The polyfill emits the dynamic spelling
seven times, once per `X.from(…)` result builder:

```js
function pn(e,t){ const n = ce("%Temporal.PlainDate%");
                  const r = Object.create(n.prototype); return yn(r,e,t), r; }
```

(`Object.create(<var>.prototype)` ×7; `Object.create(null)` ×14, untouched; no
`Object.create(<ClassIdentifier>.prototype)` at all.)

### 4. What was fixed

New module `src/codegen/standalone-object-create-class-instance.ts`: a native
dispatcher that answers a freshly defaulted `struct.new $C` when its argument IS
the class's prototype singleton and `ref.null.extern` for every other shape.
Reserved at the call site (`mintDefinedFunc`, a stable handle), filled at both
finalize sites where `ctx.protoGlobals` is complete. Two deliberate differences
from #5239 and the reasons they are load-bearing are in #6464.

Real linked provider, fresh cache (`cacheHit=false`, namespace
`js2wasm:npm:@js-temporal/polyfill:065e8cd918020d98`):

| probe | base | S13 |
| --- | --- | --- |
| `PlainDate.from("1976-11-18").day` | `null` | **18** |
| `PlainDate.from(…).calendarId` | `null` | **"iso8601"** |
| `typeof PlainDate.from(…).calendarId` | **`"object"`** | **`"string"`** |
| `PlainDate.from(…).year` | `null` | **1976** |
| `PlainDate.from({year,month,day}).day` | `null` | **18** |
| `PlainTime.from("12:30").hour` | `null` | **12** |
| `Instant.from(…).epochNanoseconds` | `null` | a value |
| `new Temporal.PlainDate(1976,11,18).day` | 18 | 18 |

### The three-family sample, LINKED, re-measured

120 rows each, `--target standalone`, provider linked, families run
**sequentially**, FRESH `JS2WASM_TEMPORAL_CACHE` per label
(`.tmp/s13famcache-{base,new}`), quickjs eval provider **and adapter** present as
real files. The base column is **this worktree's own base run**, taken by
file-copy revert of the two edited source files on this tree.

| family | rows | base pass | **S13 pass** | fail | compile_error | pass→fail |
| --- | --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 120 | 62 | **64** | 52 | 4 | **0** |
| `built-ins/Temporal/Duration/**` | 120 | 43 | **43** | 71 | 6 | **0** |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 120 | 65 | **70** | 46 | 4 | **0** |
| **total** | **360** | **170** | **177** | **169** | **14** | **0** |

`fail→pass`: 7 — PlainDate `from/argument-string-calendar-case-insensitive.js`,
`from/options-basic.js`; ZonedDateTime `prototype/day/basic.js`,
`prototype/daysInYear/basic.js`, `prototype/equals/argument-object.js`,
`prototype/equals/argument-valid.js`,
`prototype/equals/constructed-from-equivalent-parameters-are-equal.js`.
`__temporal_*` leaks: **0** in all six TSVs.

Every CE↔fail flip in the sample (9 rows) was re-run **solo at 60 s on BOTH
trees** and every one agrees across trees, so all nine are compile-budget
artifacts, not movement:

| row | base solo | S13 solo |
| --- | --- | --- |
| `PlainDate/compare/argument-plaindatetime.js` | fail 18.5 s | fail 19.0 s |
| `PlainDate/from/argument-propertybag-calendar-string.js` | fail 14.0 s | fail 13.5 s |
| `PlainDate/from/overflow-undefined.js` | fail 14.5 s | fail 14.6 s |
| `PlainDate/from/argument-object-valid.js` | fail 15.0 s | fail 14.3 s |
| `Duration/from/argument-existing-object.js` | fail 13.9 s | fail 13.1 s |
| `Duration/microseconds-undefined.js` | fail 14.9 s | fail 14.0 s |
| `Duration/compare/relativeto-propertybag-infinity-throws-rangeerror.js` | fail 13.2 s | fail 13.3 s |
| `ZonedDateTime/prototype/add/cross-epoch.js` | fail 15.1 s | fail 14.4 s |
| `ZonedDateTime/prototype/add/math-order-of-operations-add-none.js` | fail 13.2 s | fail 13.3 s |

Every one lands at 13–19 s against a 15 s sample budget, which is the artifact
itself.

### Top error buckets, LINKED, S13

PlainDate (52 fail): 20 `calendar must be string in canonicalizeCalendarEra` ·
3 compilation timeout · 2 `illegal cast in __class_construct_dispatch()` ·
2 `year is required` · 2 `prototype Expected SameValue(«null», «[object Function]»)`.

Duration (71 fail): 5 `years result: Expected SameValue(«undefined», «N»)` ·
5 `explicit: years result …` · 5 `dereferencing a null pointer in sn()` (two
distinct call paths) · 5 compilation timeout.

ZonedDateTime/prototype (46 fail): 7 `required property 'timeZone' missing` ·
5 `Cannot read properties of undefined (reading 'equals')` (was 6) ·
4 `dereferencing a null pointer in sn()` · 4 compilation timeout ·
3 `Expected a RangeError but got a undefined`.

### The 20-row `canonicalizeCalendarEra` bucket did NOT move, and that is a finding

S12 attributed ~40 rows to this residual and this slice repaired the mechanism
those 20 rows sit on — `typeof PlainDate.from(…).calendarId` answers `"string"`
now, measured directly against the linked provider — yet the bucket is still
exactly 20. So the harness's `assert.sameValue(typeof calendarId, "string")` is
failing on a value that answers `"string"` when the same read is spelled inline
in the consumer. The difference is that the harness passes it through its own
function PARAMETER first (`TemporalHelpers.canonicalizeCalendarEra(date.calendarId, …)`).

That is a second, independent defect, and it is the single largest remaining
bucket in the sample. It should be the next slice's census target, reduced as:
a provider-owned string read in the consumer, passed into a consumer function
with an untyped parameter, and `typeof`-ed there. Do not assume it is the same
mechanism as this one — that assumption is what cost the last five slices.

### Two standalone samples that must NOT move, and a third, and none did

`--target standalone`, base by file-copy revert on the same tree, 120 rows each.
Tied to what this slice touches: the `Object.create` lowering itself, the dynamic
object surface around it, and the class surface whose prototype singleton the
dispatcher compares against.

| sample | base | S13 | pass→fail | flips |
| --- | --- | --- | --- | --- |
| `built-ins/Object/create/**` (first 120 of 320) | 120 pass / 0 fail | 120 / 0 | **0** | **0** |
| `built-ins/Object/**` (first 120) | 106 pass / 14 fail | 106 / 14 | **0** | **0** |
| `language/expressions/class/**` (first 120) | 70 pass / 38 fail / 12 CE | 70 / 38 / 12 | **0** | **0** |

### Order preservation

Base captured by file copy at the FIRST edit
(`.tmp/base-{call-builtin-static,index}.ts`):

- 40 modules (`website/playground/examples/**` + `tests/fixtures/**`) ×
  {gc, standalone}: **80/80 sha256-identical**. That corpus contains no dynamic
  `Object.create`, so it is a no-collateral control.
- a targeted 9-shape corpus supplies the positive control: **all 9 `gc`
  artifacts identical**, and on standalone exactly two move — `ocDynProto` and
  `ocDynProtoCall`, the two shapes this slice repairs. Every control is
  byte-identical: `ocStaticProto`, `ocNull`, `ocPlainObject`,
  `ocNoClassInModule`, `ocDescriptors`, `classesOnly`, `plainArith`.

### Traps, carried forward and added to

- All prior traps still bite. This worktree arrived with `test262` **absent**
  and no `node_modules`.
- **NEW, and it cost a full round of family measurements: the S12 note to check
  `.test262-cache/quickjs-artifact-*/libquickjs.wasm` is necessary but NOT
  sufficient.** The runner also needs
  `.test262-cache/quickjs-eval-adapter-<hash>.wasm`. With the artifact directory
  present and the adapter missing, every row fails with a message naming the
  adapter and PlainDate scores **0 pass / 118 fail** — indistinguishable at a
  glance from a catastrophic regression. Check for BOTH before believing any
  family number.
- **NEW: `pkill` on a measurement sweep leaves ORPHANS that keep writing your
  TSVs.** Killing the driver script does not kill the `family.mts` child it had
  already spawned, and two writers of one TSV (one at limit 400, one at 120)
  produce a file whose row count means nothing. Kill the children by their own
  pids and re-check with `ps` before restarting; a duplicate sweep also doubles
  the load and manufactures compile-timeout flips.
- **The S12 note that the provider namespace hash does not change after a
  codegen edit is not general.** This slice's fix moved it
  (`2c0506a30fe8f23d` → `065e8cd918020d98`). `cacheHit=false` against a FRESH
  cache directory remains the tell that actually works.

### Artifacts

`.tmp/s13fam/{pd,du,zdt,mnm-oc,mnm-obj,mnm-cls}-{base,new}.tsv` (+ `.log`),
`.tmp/s13fam/solo-{base,new}.tsv`,
`.tmp/s13/{c1..c7,t1}*.out`, `.tmp/s13/byteab{,2}-{base,new}.tsv`, and the probe
sets `.tmp/s13/{c1..c7,t1}.mjs` in this worktree
(`/home/user/js2/.claude/worktrees/agent-a85a674efc7243492`), produced by
`.tmp/s13/{pair2.mjs,family.mts,rerun13.mts,byteab.mts,byteab2.mts}` and compared
with `.tmp/s13/table13.mjs`.

### Acceptance criterion 4 — S13 update

MET-for-the-sample at **177/360** (was 170), measured on the same three
families, with **0 pass→fail**, all three must-not-move samples flat and 0
`__temporal_*` leaks. Base and branch were both measured on this tree by
file-copy revert, so the delta is a self-consistent before/after. No full-corpus
number is claimed; a corpus run remains the tech lead's to schedule.

## S14 findings (2026-09-13) — the harness itself was the input; ONE `new <value>()` poisoned every provider value, and the linked lane goes 177 → 199

**#6601 is the slice.**

### 1. The attribution was wrong for the SIXTH slice running, and this time the census procedure itself was at fault

S14 was handed "a second, independent defect on the parameter path:
`canonicalizeCalendarEra` sees `undefined` because the harness reads
`date.calendarId` through its own function PARAMETER". Against the real linked
provider, **every** spelling of that shape answers `"string"` — value through a
plain parameter, value through an object-literal METHOD parameter, object
through a parameter read inside, the full two-hop `assertPlainDate` →
`canonicalizeCalendarEra`, an 8-parameter method (3 defaulted) called with 5 / 6
/ 8 arguments, and the `for (const [input, ...rest] of tests)` +
`m(recv, ...rest, trailing)` loop the failing tests actually use.

The defect only appears when the **real `test262/harness/temporalHelpers.js` is
in the module**. That is the addition to S13's lesson:

> **When the failing program includes a harness, the harness is part of the
> input.** Five slices of probes that omitted it were measuring a different
> program.

S13 wrote "reduce in ONE standalone module first". That is still right, but it
is not sufficient: the one-module control has to be the one-module control **of
the program that actually fails**, harness and all. Every probe set from S10 to
S13 reduced a hand-written stand-in for the harness, and every one of them
passed.

### 2. Root cause

`$__ta_ctor` is two immutable i32 fields (`kind`, `brand`) — exactly the shape
#2158/#2009 gives a **field-less class ROOT** (`$__tag` + `$__shape_brand`).
WasmGC canonicalizes structurally-identical struct types, so a bare
`ref.test $__ta_ctor` cannot answer a NOMINAL question. Two arms asked it that
way:

- `tryEmitTaStaticOfFrom` (`expressions/call-receiver-method.ts`) —
  `%TypedArray%.of` / `.from` on an `any` receiver. It claimed
  `Temporal.PlainDate.from("2020-12-24")` and built a typed array out of the
  argument list.
- the `$__ta_ctor` arm of `tryCompileNativeConstructFromValue`
  (`expressions/new-super.ts`) — the `[[Construct]]` twin, which is why
  `new Temporal.Duration(1).years` broke alongside it.

The discriminator already existed and its own comment records this exact
collision, measured on this exact provider: `taCtorIdentityTestInstrs`
(#5383 S2f R11) adds the `brand` FIELD-VALUE check. Three call sites used it;
these two did not. **Twelve** bare `ref.test $__ta_ctor` sites remain
(`dataview-native.ts` ×5, `ta-ctor-meta.ts` ×2, `expressions/calls.ts`,
`property-access-dispatch.ts`); none was on a path this slice could measure
moving, so they are written down in #6601 rather than changed blind.

### 3. Why ONE never-called function is the whole input

```js
function mk(K) { return new K(); }          // NEVER CALLED
typeof Temporal.PlainDate.from("2020-12-24").calendarId   // "undefined"
```

The spelling is what arms the module pre-scan's dyn-view flag, which is what
makes the consumer register `$__ta_ctor` at all. `temporalHelpers.js` contains
it — `new construct(...constructArgs)` in `checkSubclassConstructorNotObject` —
so **every Temporal test that `includes:` the harness inherited the failure**,
called or not.

Scale, counted over the S13 three-family TSVs by whether the test file contains
`temporalHelpers.js`:

| family | rows that include it | of those FAIL | of those PASS |
| --- | --- | --- | --- |
| PlainDate | 35 | **34** | 1 |
| Duration | 26 | **24** | 2 |
| ZonedDateTime/prototype | 13 | **13** | 0 |
| **total** | **74** | **71** | **3** |

71 of the sample's 169 failures; 3 of its 177 passes.

### The three-family sample, LINKED, re-measured

120 rows each, `--target standalone`, provider linked, families **sequential**,
FRESH `JS2WASM_TEMPORAL_CACHE` per label (`.tmp/s14famcache-{base,new}`,
`cacheHit=false` on both prewarms), quickjs artifact **and** adapter present.
The base column is **this worktree's own base run**, taken by file-copy revert
of the two edited source files on this tree.

| family | rows | base pass | **S14 pass** | fail | compile_error | pass→fail |
| --- | --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 120 | 64 | **78** | 41 | 1 | **0** |
| `built-ins/Temporal/Duration/**` | 120 | 43 | **49** | 66 | 5 | 2 † |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 120 | 70 | **72** | 46 | 2 | **0** |
| **total** | **360** | **177** | **199** | **153** | **8** | **2 †** |

`fail→pass`: **24** (PlainDate 14, Duration 8, ZonedDateTime 2).
`__temporal_*` leaks: **0** in all six TSVs.

† **Both pass→fail rows were VACUOUS passes on base, and that is measured, not
argued.** `Duration/from/argument-propertybag-optional-properties.js` and
`Duration/from/argument-string-fractional-precision.js` compare two
`Duration.from(…)` results field by field. On the base tree, with the real
harness in the module:

| probe, base tree, real harness | answer |
| --- | --- |
| `Duration.from({hours:1}).hours` | `undefined` |
| `Duration.from(<all 10 props>).hours` | `undefined` |
| `typeof a.hours + "/" + typeof b.hours + "/" + (a.hours === b.hours)` | `undefined/undefined/true` |

The assertion passed because both sides were `undefined`. On the fixed tree the
same three read `1`, `1`, `number/number/true` — the values are real and the
equality still holds. The rows now fail **further downstream**, on the known
`instanceof`-across-the-link residual: `Temporal.Duration.from({hours:1})
instanceof Temporal.Duration` is `false`, so the harness's own
`assert(actual instanceof Temporal.Duration)` throws (`"x: instanceof"`), and
`assertDurationsEqual`'s re-`from` of a Duration object reports
`invalid duration-like`. That residual is the next slice's target.

The one `fail→ce` row
(`Duration/compare/relativeto-propertybag-infinity-throws-rangeerror.js`) is a
compile-budget artifact: re-run **solo at 60 s on BOTH trees** it is `fail` on
both (base 14.5 s, S14 13.9 s). The two pass→fail rows were re-run the same way
and are real status changes, not budget (base pass 17.7 s / 14.0 s; S14 fail
17.9 s / 14.6 s).

### Top error buckets, LINKED, S14

PlainDate (41 fail): 6 `year is required` · 3 `Object method called on null or
undefined` · 3 `dereferencing a null pointer in __closure_N()` · 2 `illegal cast
in __class_construct_dispatch()`. **The 20-row `calendar must be string in
canonicalizeCalendarEra` bucket is GONE.**

Duration (66 fail): 16 `dereferencing a null pointer in sn()` (two call paths) ·
5 compilation timeout · 3 `prototype Expected SameValue(«null», «[object
Function]»)` · 3 `Cannot access property on null or undefined`. **The 10-row
`years result … undefined` bucket is gone.**

ZonedDateTime/prototype (46 fail): 7 `required property 'timeZone' missing` ·
6 `dereferencing a null pointer in sn()` · 3 `Expected a RangeError but got a
undefined` · 2 compilation timeout · 2 `prototype Expected SameValue(…)`.
The `timeZone` bucket did not move; with the harness present it now answers
correctly in isolation (`ZonedDateTime.from(…).timeZoneId` → `"UTC"`), so those
7 rows are a different cause and are the next census target alongside
`instanceof`.

### Symptom reads, with the REAL harness in the module

Every read below is against the real linked provider. The point of the table is
that the harness column now EQUALS the no-harness column:

| read | base + harness | S14 + harness | S14 no harness |
| --- | --- | --- | --- |
| `PlainDate.from(…).calendarId` typeof | `undefined` | **`string`** | `string` |
| `Duration.from({years:1}).years` | `undefined` | **`1`** | `1` |
| `new Duration(1).years` | `undefined` | **`1`** | `1` |
| `ZonedDateTime.from(…).timeZoneId` | `undefined` | **`UTC`** | `UTC` |
| `ZonedDateTime.from(…).equals` typeof | `undefined` | **`function`** | `function` |
| `PlainTime.from("12:30").hour` | `undefined` | **`12`** | `12` |
| `Instant.from(…).epochNanoseconds` | `undefined` | **a value** | a value |
| `Duration.from("P1Y").years` | `undefined` | TRAP `sn()` | TRAP `sn()` |

The last row is the pre-existing `sn()` bucket: it reproduces with no harness at
all, so it is not this slice's and was not made worse.

### Must-not-move samples, and none moved

`--target standalone`, base by file-copy revert on the same tree. Tied to what
this slice touches — the two arms are the TypedArray static `of`/`from` claim
and the dynamic-`new` TA claim, so the samples are the TypedArray surface those
arms exist for. Row counts are the whole directory where it is smaller than 120.

| sample | rows | base | S14 | pass→fail | flips |
| --- | --- | --- | --- | --- | --- |
| `built-ins/TypedArray/from/**` | 21 | 8 pass / 12 fail / 1 CE | 8 / 12 / 1 | **0** | **0** |
| `built-ins/TypedArray/of/**` | 8 | 7 pass / 1 fail | 7 / 1 | **0** | **0** |
| `built-ins/TypedArrayConstructors/**` (first 120) | 120 | 116 pass / 4 fail | 116 / 4 | **0** | **0** |

### Order preservation

Base captured by file copy at the FIRST edit
(`.tmp/s14/base-{call-receiver-method,new-super}.ts`):

- 40 modules (`website/playground/examples/**` + `tests/fixtures/**`) ×
  {gc, standalone}: **80/80 sha256-identical**.
- a targeted 9-shape corpus supplies the positive control: **all 9 `gc`
  artifacts identical**, and on standalone exactly the four shapes that carry
  the two re-guarded arms move — `taStaticFromAnyRecv`, `taStaticOfAnyRecv`,
  `taDynNewAnyCallee`, `dynNewNoTa`. Every control is byte-identical:
  `taNoCtorValue`, `taStaticDirect`, `classesOnly`, `plainArith`,
  `objectsOnly`.
- The linked provider artifact is byte-identical across the two labels (same
  namespace `js2wasm:npm:@js-temporal/polyfill:61b30b6f2d1d6da9`, same 3 314 089
  bytes), so the whole delta is consumer-side.

### Traps, carried forward and added to

- All prior traps still bite.
- **NEW, and it cost a full base run: the family runner needs the Temporal
  PRE-WARM STAMP, not just a cache directory.** With `JS2WASM_TEMPORAL_CACHE`
  set but no stamp written, `runTest262File` does not link the provider at all:
  PlainDate scores **3 pass / 69 fail / 48 CE** with `Temporal is not defined`
  and `standalone target emitted host imports:
  env::__temporal_plain_date_from_string_field`. That is indistinguishable at a
  glance from a catastrophic regression and is NOT what a missing quickjs
  adapter looks like. Run `prewarm` (which calls `writeTemporalPrewarmStamp`)
  first, and check the log line `[test262] Temporal provider (standalone) …`
  before believing any family number.
- **NEW: do not swap source files while a background measurement is running.**
  Two runs were discarded for this. The driver script owns one label end to end;
  nothing under `src/` changes until it prints `LABEL <x> COMPLETE`.
- **NEW: a pass→fail is not automatically a regression, and a pass is not
  automatically a pass.** Two of this slice's three flips were VACUOUS base
  passes (`undefined === undefined`). The check that settles it is cheap —
  evaluate the test's own comparison operands on the base tree — and it is the
  difference between "this slice regressed two rows" and "this slice removed two
  false passes and exposed the next defect".

### Artifacts

`.tmp/s14fam/{pd,du,zdt,mnm-tafrom,mnm-taof,mnm-tactor}-{base,new}.tsv` (+ logs),
`.tmp/s14fam/solo-{base,new}.tsv`, `.tmp/s14/byteab{,2}-{base,new}.tsv`, the
probe sets `.tmp/s14/{r1..r4,t2..t4,b1..b6,c1..c9,h1..h5,w1,w2}.mjs` and the
drivers `.tmp/s14/{one,pair2,probe,harness,harness2,harness3,split-th,bisect-th,bisect2,bisect3,family,rerun14,byteab,byteab2,table14,bytediff,run-all}.{mjs,mts,sh}`
in this worktree (`/home/user/js2/.claude/worktrees/agent-a61a68efa14de71e0`).

### Acceptance criterion 4 — S14 update

MET-for-the-sample at **199/360** (was 177), measured on the same three
families, with **2 pass→fail that were measured to be vacuous base passes**, all
three must-not-move samples flat, the `gc` lane byte-identical on both corpora,
and 0 `__temporal_*` leaks. Base and branch were both measured on this tree by
file-copy revert, so the delta is a self-consistent before/after. No full-corpus
number is claimed; a corpus run remains the tech lead's to schedule.

### S15 findings (2026-09-13) — `sn()` did not need a Temporal fix; it needed the array-HOF callback to stop asserting a nullable element non-null. 199 → 201, and the whole 22-row `sn()` bucket moved one step

**#6602 is the slice.** Full write-up, tables and residuals in the issue file
`plan/issues/6602-standalone-nullable-vec-element-callback-param.md`.

#### 1. Root cause, and why six slices of Temporal work never reached it

The largest remaining bucket — 16 Duration + 6 ZonedDateTime rows reading
`dereferencing a null pointer in sn()` — had **nothing Temporal-specific in
it**. `sn` is the minified `ToTemporalDuration`, and its first act on a
duration STRING is

```js
const t = Ye.exec(e);
if (t.every((e, t) => t < 2 || void 0 === e)) throw new RangeError(…);
```

Standalone `exec` returns a vec whose element type is `ref_null $anyStr` — an
unmatched capture group is a NULL native string, the compiler's `undefined` for
that slot. TypeScript types the same array `RegExpExecArray extends
Array<string>`, i.e. NON-null. So the callback's element parameter resolved to
`ref $anyStr`, the call site coerced the loaded element with a bare
`ref.as_non_null`, and the first unmatched group trapped.

The reduction is ten lines and needs no provider, no link and no harness:
`/^(a)?(b)$/.exec("b").every((e, i) => i < 2 || true)` traps; `.map(…)` and
`m[1]` do not. `map` is the one arm that already pins its callback's first
parameter to the receiver's real element type (#4527/#5319) — the asymmetry was
sitting in the compiler the whole time.

**Method note, and it is the same one S13 and S14 wrote down from the other
side.** S13 learned "reduce in ONE standalone module"; S14 learned "the harness
is part of the input". S15 adds the third: **a trace frame names the function
that traps, not the mechanism that is wrong.** `sn()` in the trace made six
slices read this as a Temporal/provider defect. The question that broke it open
was not "what does `sn` do" but "what is the FIRST compiler mechanism `sn`
touches", and that question is answerable without the provider at all.

#### 2. Fix

One mechanism: `setupArrayCallback` windows the receiver's real element type —
and the index of the parameter that receives it — over the callback compile;
the closure wrapper signature honours it only where the checker handed back
that type's exact non-null twin. `map` keeps its own unconditional override.

The parameter INDEX is load-bearing: `reduce`/`reduceRight` pass the element as
parameter **1**. The first cut pinned parameter 0, fixed 7 of 8 arms and left
`reduce` trapping — measured, not reasoned.

#### 3. The measurement, and the honest version of the win

| family | rows | base pass | **S15 pass** | pass→fail |
| --- | --- | --- | --- | --- |
| `PlainDate/**` | 120 | 78 | 78 | 0 |
| `Duration/**` | 120 | 49 | **51** | 0 |
| `ZonedDateTime/prototype/**` | 120 | 72 | 72 | 0 |
| **total** | **360** | **199** | **201** | **0** |

Base reproduces S14's 199/360 exactly on this tree. `__temporal_*` leaks: 0.
Must-not-move (120 `Array.prototype` HOF rows, standalone): 54/66 on both, 0
flips. `gc` lane: 84/84 + 14/14 artifacts byte-identical.

**+2 rows understates it and the bucket movement is the real number.** All 22
`sn()` rows stopped trapping at the `every`; **18 of them now trap one step
later in the same function**, at `__str_flatten`, on a genuinely different
defect. The row count will move properly when that one goes.

#### 4. Next target, already reduced

**Implicit truthiness of a null native string traps; the explicit
`Boolean(…)` call does not.** `t[4] ? "T" : "F"` and `t[4] || "x"` trap;
`Boolean(t[4])` answers `"false"` correctly; `"" + t[4]` answers `"undefined"`
correctly. The polyfill hits it at `if (d ?? h ?? u ?? l) …` inside `sn`.
Worth 13 Duration + 5 ZonedDateTime rows in this sample — more than this slice
was — and it is the same family of defect: a null native string IS `undefined`,
and each lowering that forgets it has to be taught separately.

Still open behind it: `instanceof` across the provider link with a dynamic RHS
(S11 residual, gates 2 Duration rows), ZonedDateTime's 7-row
`required property 'timeZone' missing`, PlainDate's 6-row `year is required`
and its 3-row `__closure_N()` null pointer — **measured NOT to be the #6602
family**, since PlainDate did not move at all.

#### 5. Traps, carried forward

All S11–S14 traps still bite (provider cache not keyed on the compiler; the
pre-warm STAMP, without which rows read `Temporal is not defined`; both quickjs
artifacts as real files; never swap source files during a measurement; re-run
every flip solo at 60 s on both trees). Two additions:

- **A `vitest` run can exit 1 with every test passing.** The first suite batch
  reported `Test Files 5 passed (5) / Tests 95 passed` and exit 1, on an
  unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"` — an RPC timeout
  under load, not a failure. Read the summary, not only the status.
- **A targeted byte A/B earns its keep by falsifying the plan's own claim.**
  This one showed a CONTROL moving (`["x","y"].every(…)`), because a plain
  string array's element type in standalone is already nullable. The claim
  "nothing else can move a byte" was wrong; the mechanism was right. A corpus
  hash alone would have said "84/84 identical" and told nobody.

### Artifacts

`.tmp/s15fam/{pd,du,zdt}-{base,new}.tsv` (+ logs and prewarm logs),
`.tmp/s15fam/mnm-{base,new}.tsv`, `.tmp/s15/byteab{,2}-{base,new}.tsv`, the
reduction `.tmp/s15/red.mjs`, the residual census `.tmp/s15/q8.mjs`, the
revert copies `.tmp/s15base/*.ts` and the drivers
`.tmp/s15/{run-fam.sh,family.mts,prewarm.mts,mnm.mts,byteab.mts,byteab2.mts,table15.mjs,localpre.mjs}`
in this worktree (`/home/user/js2/.claude/worktrees/agent-a743fbf47ab9ca4bb`).

### Acceptance criterion 4 — S15 update

MET-for-the-sample at **201/360** (was 199), same three families, **0
pass→fail** (none, vacuous or otherwise), the must-not-move Array-HOF sample
flat at 54/66 with 0 flips, the `gc` lane byte-identical on both corpora, and 0
`__temporal_*` leaks. Base and branch were both measured on this tree by
file-copy revert. No full-corpus number is claimed; a corpus run remains the
tech lead's to schedule.

### S16 findings (2026-09-13/14) — the `sn()` bucket is fully retired; two general standalone correctness bugs, 201 → 202, and the row count is the least interesting number here

**Two slices: #6603 (the nullable native-string BINDING) and #6604 (`void 0` in
a nullish comparison).** Full write-ups in
`plan/issues/6603-standalone-nullable-native-string-element-binding.md` and
`plan/issues/6604-standalone-void-0-undefined-comparison.md`.

#### 1. The hand-off attribution was wrong for the SEVENTH slice running, and this time it named the wrong LAYER

S15 handed over "implicit truthiness of a null native string traps; the explicit
`Boolean(…)` call does not", with `t[4] ? "T" : "F"` and `t[4] || "x"` as the
evidence. Both probes actually **bind first** (`const a = t[4]; a ? …`), and
the difference is the binding, not the operator:

| source, base tree, standalone | answer |
| --- | --- |
| `m[1] ? "T" : "F"` (INLINE) | `"F"` ✓ |
| `const a = m[1]; a ? "T" : "F"` | **TRAP** |
| `"" + m[1]` (INLINE) | `"undefined"` ✓ |
| `const a = m[1]; "" + a` | **TRAP** |
| `const a: string \| undefined = m[1]; a ? …` | `"F"` ✓ |
| `(a) => a ? "T" : "F"` applied to `m[1]` | `"F"` ✓ |

Every inline read was already right, and so were a parameter and an annotated
binding. `emitToBoolean` already had the correct arm (#3548's `__str_truthy`);
it simply never saw a `ref_null`. **The named mechanism (ToBoolean) was not
broken at all.** The pattern across S11–S16 now has a name: a symptom read
through ONE call site attributes to that call site. The question that works is
"what is the first thing that differs between the form that works and the form
that does not", and here that is one `const`.

> **Correction, from S17 — read this heading as too harsh.** "Wrong for the
> seventh slice running" lumps together two failures that cost very different
> amounts. A hand-off that names the wrong **area** costs the slice: you spend it
> in the wrong module. A hand-off that names the right area and the wrong
> **mechanism** costs one probe set. Every hand-off in S11–S16, including the one
> this heading is about, was of the second kind — **right area, wrong mechanism,
> which is the shape of a GOOD hand-off**, not a failed one. S17's own inherited
> attribution was wrong in the same way (`link_member_get` on a foreign
> `$Object`) and it still paid for itself, because the area was right. The
> reusable instruction is therefore not "distrust the hand-off" but "take the
> AREA from it and re-derive the mechanism", and the re-derivation is cheap —
> see S17's note on shape + did-not-move as a reduction method, not merely an
> attribution one. Stated here rather than only in S17's section because the
> misleading framing is *this* sentence, and a correction only a later reader
> reaches has not corrected anything.

#### 2. Root causes, both general standalone bugs rather than Temporal ones

**#6603** — `walkStmtForLetConst` (the authoritative let/const slot-typer) ends
its cascade at `resolveWasmType`, which answers the NON-null `ref $anyStr` for
an element the checker types `string`. The store does not fail (a `ref` local
gets a defaultable nullable slot), so the null is written and kept; every later
READ is misinformed and dereferences it. Fixed by a post-filter applied at both
declaration cascades, narrowed to the exact non-null-twin pair for a
native-string element — `resolveWasmType` returns a non-null `ref` for class
and object structs too, and re-typing every `const x = objArray[i]` in both
lanes is a blast radius this defect does not justify.

**#6604** — the null-and-undefined comparison shortcut recognised the undefined
literal as the IDENTIFIER `undefined` only, so a `void 0` operand fell into the
generic reference equality, which on standalone compares carriers structurally
and answers `void 0 !== undefined` as TRUE. **Every minifier emits `void 0`**,
so this is the only form a bundled dependency uses. `sn` guards each fractional
capture group with `if (void 0 !== c) { … (c + "000000000").slice(0, 9) … }`:
the guard admitted a NULL group and the concatenation dereferenced it.

Applied on the native-semantics lane only, and that is **measured**: with a JS
host the fallback this arm replaces hands both operands to the host `===`,
which already answers all seven probed shapes correctly BEFORE the fix
(`.tmp/s16/gcprobe.mjs`, run on both trees). Widening it there would move bytes
for an answer that is already right.

#### 3. The bucket, through all three states — this is the real result

| bucket, in `sn` | base (S15 head) | +#6603 | +#6603 +#6604 |
| --- | --- | --- | --- |
| `null pointer in __str_flatten` | **18** (13 Du, 5 ZDT) | 0 | 0 |
| `null pointer in __str_concat` | 0 | **11** (8 Du, 3 ZDT) | **0** |
| spurious `only the smallest unit can be fractional` | **4** (3 Du, 1 ZDT) | 4 | **0** |

The 22-row `sn()` family that has gated every string-argument Duration entry
point since S10 is now **entirely retired**. #6603 alone moved it one step and
scored nothing; the pair retires it.

#### 4. The three-family sample, LINKED, re-measured

120 rows each, `--target standalone`, provider linked, families **sequential**,
FRESH `JS2WASM_TEMPORAL_CACHE` per label (`cacheHit=false` on every prewarm),
quickjs artifact **and** adapter present. Base is this worktree's own base run,
taken by file-copy revert of the three edited source files on this tree. The
provider binary differs between labels (3,324,826 vs 3,325,244 bytes), which is
independent proof the compiler change reached the linked artifact.

| family | rows | base pass | #6603 only | **S16 pass** | fail | ce | pass→fail |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 120 | 78 | 78 | **78** | 41 | 1 | **0** |
| `built-ins/Temporal/Duration/**` | 120 | 51 | 51 | **52** | 65 | 3 | **0** |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 120 | 72 | 72 | **72** | 46 | 2 | **0** |
| **total** | **360** | **201** | **201** | **202** | **152** | **6** | **0** |

`fail→pass`: **1** (Duration). `__temporal_*` leaks: **0** in all nine TSVs.

**+1 row is an honest but misleading headline, and the honest reading is in the
bucket table above.** 18 rows stopped trapping; 17 of them now fail further
downstream, at `Missing internal slot slot-<unit>` (1 → 10 across the sample)
and `called value is not a function` (10 → 17). Those two are the next causes,
and they are reached only because the parse now completes.

#### 5. Top error buckets, LINKED, S16 (all three families pooled, 152 fail)

8 `called value is not a function` · 7 `required property 'timeZone' missing` ·
7 `Missing internal slot slot-years` · 7 `prototype Expected SameValue(«null»,
«[object Function]»)` · 5 compilation timeout · 5 `Object method called on null
or undefined` · 5 `Expected a RangeError but got a undefined` · 5
`__closure_N()` null pointer · 4 `year is required` · 4 `Proxy get trap is not
callable`.

**The `timeZone missing` (7) and `year is required` (4) buckets are ONE cause,
reduced to shape.** Every row in both is a `*-propertybag-calendar-*` test that
builds a plain object literal in the CONSUMER module and passes it across the
link:

```js
const arg = { year: 1976, monthCode: "M11", day: 18, calendar };
Temporal.PlainDate.compare(arg, new Temporal.PlainDate(1976, 11, 18));
```

`year` IS present, and the polyfill's `Get(bag, "year")` answers `undefined` —
so this is the link-boundary dynamic-read family (#6460 / #6464), not a
Temporal defect and not the nullability family. Neither bucket moved in S16
(7→7, and 15→15 counting all three families), which is consistent with that
attribution.

**CONFIRMED by S17 (#6600), which is worth stating because it is the first time
in this stack that a hand-off attribution held.** S17 found the link boundary to
be one-directional — a consumer-owned object literal or class instance is
undecodable inside a linked provider — installed a reverse channel, and reports
both buckets going to **zero**, with the three families at 202 → 232. The
attribution above was made from the test SHAPE (`*-propertybag-calendar-*`
builds its argument in the consumer) plus the fact that the buckets did not move
under a fix that was definitely not theirs. Neither half is strong alone; the
pair is, and that is the cheap form of attribution worth reusing.

#### 6. Residuals of THIS family, each already reduced

The nullability lie survives at three further boundaries, all measured on the
S16 tree (`.tmp/s16/{red2,red3}.mjs`):

| residual | probe | answers | should be |
| --- | --- | --- | --- |
| checker-keyed `+` | `const a = m[1]; "" + a` | **TRAP** | `"undefined"` |
| checker-keyed `Boolean()` | `const a = m[1]; Boolean(a)` | **TRAP** | `false` |
| checker-keyed `typeof` | `const a = m[1]; typeof a` | `"string"` | `"undefined"` |
| `&&` / `??` RESULT carrier | `const a = m[1]; String(a && "y")` | **TRAP** | `"undefined"` |
| REASSIGNMENT, not declaration | `let a = "z"; a = m[1]; a ? …` | **TRAP** | `"F"` |
| non-inert `void` | `void f() === undefined` | `false` (effect preserved) | `true` |

The first three share one shape: the operator dispatches on the CHECKER's
static `string`, not on the operand's emitted ValType, so the null is asserted
non-null on the way in. The inline forms of all three are correct, which is
what makes them reducible. The reassignment case needs the slot widened by a
whole-function scan rather than at the declaration.

#### 7. Two samples that must NOT move, and neither did

| sample | rows | base | S16 | flips |
| --- | --- | --- | --- | --- |
| `RegExp/prototype/exec` + `expressions/{conditional,logical-or,coalesce}` | 94 | 91 pass / 2 fail / 1 ce | identical | **0** |
| `String/prototype/{split,match}` + `Array/prototype/{join,indexOf}` | 113 | 95 pass / 18 fail | identical | **0** |

The second sample exists because the targeted byte A/B falsified the narrow
reading of #6603: a PLAIN string array's element type is nullable in standalone
too, so `const s = a[0]` re-types there as well. A sample chosen only from the
RegExp surface would not have covered that.

#### 8. Order preservation

Byte A/B on a 42-file fixed corpus (`website/playground/examples` +
`tests/fixtures`) × {gc, standalone}: **no artifact moves on either lane, for
either slice.** A targeted 23-shape A/B: the `gc` lane is byte-identical
throughout; on standalone exactly the intended shapes move (6 for #6603, 5 for
#6604) and every control — an inline element read, a `var`, an annotated
binding, a number/object element, a matched group, the identifier `undefined`
form, `void f()` — is identical.

Equivalence gate at baseline (22 failing / 1720 passing) on both slices.

#### 9. Traps, carried forward and added to

All S11–S15 traps still bite. The provider suite's `onTaskUpdate` RPC timeout
reproduced again (exit 1 with `81 passed | 3 todo`). Three additions:

- **The `test262` submodule is NOT checked out in a fresh agent worktree**, and
  `HARNESS_ROOT` is `<PROJECT_ROOT>/test262/harness` — so every linked family
  run resolves against the worktree's OWN copy and silently has nothing to run.
  `git submodule update --init test262` is instant here (the objects are
  already in `.git/modules/test262`), and the gitlink stays clean afterwards.
- **The provider cache key does not change when the compiler does** (it hashes
  the polyfill source + compile options), so a per-label cache directory is not
  a nicety, it is the whole measurement. The *evidence* that the label actually
  differed is the provider BYTE COUNT in the prewarm stamp, not `cacheHit`.
- **A "control" that moves is a mislabelled teeth row, not a regression.** The
  #6604 witness's `void "x" === a` row failed the base run as a control; it is
  an inert literal, so the fix covers it by design. Reading the diff rather
  than re-expecting the observed value is what caught it.

#### 9a. The hand-picked ids COLLIDED with main, and the whole stack was renumbered 6474–6477 → 6601–6604

`claim-issue.mjs --allocate` has exited **6** (`open-PR id scan DEGRADED — gh
offline/unauthenticated`) for this entire session and pushes are 403, so S14,
S15 and S16 all hand-picked their ids. While those branches sat unpushed, `main`
landed the whole `linked-harness` family on **6474, 6475, 6476 and 6477**, and
`check:issue-ids:against-main` went red on all four at once (reported by the S17
lane, reproduced here on a fresh catch-up merge). They are now:

| was | is | slice |
| --- | --- | --- |
| 6474 | **6601** | S14 — dynamic `new` poisons provider values |
| 6475 | **6602** | S15 — nullable vec element at the HOF callback |
| 6476 | **6603** | S16 — nullable native-string element BINDING |
| 6477 | **6604** | S16 — `void 0` in a nullish comparison |

6600 is left to the S17 lane. Issue files, test filenames and every `#NNNN`
reference in `src/` and `tests/` were rewritten with them.

**One thing the renumber nearly missed, and it is the reusable lesson.** The
rename was done per-slice, so the *cross-slice* references survived: five
`#6475` mentions in S16's own issue file plus one each in
`src/codegen/nullable-native-string-elem-binding.ts` and its witness still
pointed at the old id — which on `main` is now an unrelated
`linked-provider-realm-error-constructors`. `check:issue-ids:against-main` went
**green** with all seven still stale, because it compares FILENAMES, not prose.
A renumber has to be swept repo-wide (`grep -rn '#<old>'`) after the gate passes,
not before it.

**This is the #2531 hazard in its documented form**, and the narrow lesson is
not "the tool was down": an id hand-picked from a `--dry-run` preview is a
point-in-time guess, and the window between picking it and pushing is exactly
how long it stays a guess. With `--allocate` unavailable there is no way to
close that window — so keep the picked ids contiguous and few, because every
stacked branch below has to be rewritten with them.

#### 10. One gate was red before the catch-up merge, on the base tree too, and main fixed it

`node scripts/check-compiler-boundaries.mjs --mode inventory --base origin/main`
exited 1 for most of this slice with `invalid-inventory / activation-demoted:
backend-wasmgc`, naming `src/codegen/prepared-async-frame-adapter.ts` and
`src/backend/wasmgc/async/prepared-async-frame-adapter.ts` as `external-unbound`
— neither file existed in the tree. Measured identical on the S15 base by
file-copy revert, so S16 neither introduced nor changed it; merging `origin/main`
(39 commits, which land that module) makes it **green**. Recorded because the
red would otherwise have looked like this slice's, and because it is a concrete
case of a gate that only a catch-up merge can clear. Both new modules are
classified in `scripts/compiler-boundaries.json` and are bound in the report.

### Artifacts

`.tmp/s16fam/{pd,du,zdt}-{base,new,new4}.tsv` (+ logs and prewarm logs),
`.tmp/s16fam/{mnm,mnm2}-{base,new}.tsv`,
`.tmp/s16/byteab{,2}-{base,new,base2,new2,new3}.tsv`, the reductions
`.tmp/s16/{red,red2,red3,red4}.mjs`, the residual census
`.tmp/s16/{q8,runq}.mjs`, the gc-lane probe `.tmp/s16/gcprobe.mjs`, the revert
copies `.tmp/s16base/*` and the drivers
`.tmp/s16/{run-fam.sh,family.mts,prewarm.mts,mnm.mts,mnm2.mts,byteab.mts,byteab2.mts,table.mjs}`
in this worktree (`/home/user/js2/.claude/worktrees/agent-a13e1501115f31e8e`).

### Acceptance criterion 4 — S16 update

MET-for-the-sample at **202/360** (was 201), same three families, **0
pass→fail**, both must-not-move samples flat with 0 flips, the `gc` lane
byte-identical on both corpora AND on the targeted shapes, the equivalence gate
at baseline, and 0 `__temporal_*` leaks. Base and branch were both measured on
this tree by file-copy revert, with an intermediate #6603-only label, so the
attribution between the two slices is measured rather than argued. No
full-corpus number is claimed; a corpus run remains the tech lead's to
schedule.

### S17 findings (2026-09-14) — the boundary attribution was RIGHT for the first time in eight slices; the link turns out to be ONE-DIRECTIONAL, and the linked lane goes 202 → 232

Full write-up in `plan/issues/6600-standalone-link-reverse-peer-read.md`.

#### 1. The hand-off attribution reproduced, and the reduction took one probe set

S16 handed over "the provider's `Get(bag, "year")` on a consumer-built bag
answers `undefined`", with three candidate mechanisms: `link_member_get` on a
foreign `$Object`, string-key identity across modules, and module-local
hidden-class tables. **None of the three.** The first host-free linked-pair probe
set (`.tmp/s17/c1.mjs`, `c2.mjs`) split the answer on the CARRIER:

| consumer-built carrier, read by the PROVIDER | linked, base | single module |
| --- | --- | --- |
| object literal `{ year: 1976 }` → `o[k]` / `o.year` | **`undefined`** | `1976` |
| class instance → `o[k]` | **`undefined`** | `1976` |
| `Object.keys(bag)` | **`""`** | `year,monthCode,day` |
| `k in bag` | **`false`** | `true` |
| `{}` then a COMPUTED write · `Object.create(null)` bag | `1976` | `1976` |
| array `length`/index, string `length` | ok | ok |

A generic `$Object` is a canonical runtime type, so the provider decodes it; an
object literal and a class instance are CLOSED structs the CONSUMER declared and
appear in no other module's ladder. The key was never the variable — literal,
dot, `const`-bound and sorted-array-element keys all behave identically.

After seven wrong attributions, the one that reproduced is also the one where the
reduction disagreed with all three NAMED mechanisms while confirming the AREA.
"The boundary" was right; "`link_member_get`" was not, because the miss is on the
side that has no peer at all.

**That distinction is worth more than the tally, and it corrects how S11–S16
were written up here.** "The hand-off attribution was wrong for the Nth slice
running" reads as though hand-offs are unreliable. They are not — a wrong AREA
and a wrong MECHANISM inside the right area are different failures with
different costs: a wrong area spends the whole slice in the wrong module, a
wrong mechanism costs one probe set. **Right area, wrong mechanism is the shape
of a GOOD hand-off**, and it is what S16 handed over. Agreed with the S16 lane,
which proposed the correction to its own write-up.

The corollary is about method rather than tone. S16 attributed these 11 rows on
two signals that are weak alone — the test SHAPE (every row a
`*-propertybag-calendar-*` case that builds its argument in the CONSUMER) and
the bucket NOT MOVING under a fix that was definitely not its cause — and
stopped at "not mine". The same pair is also what made the reduction cheap
here: the shape says what to build (a consumer bag handed to a provider `get`),
the not-moving says the mechanism is upstream of everything the previous slice
touched. So it is a cheap REDUCTION method, not merely a cheap attribution one,
and reduction is the expensive half of these slices.

#### 2. Root cause

`standalone-link-boundary.ts` (S2d) is consumer→provider ONLY: the provider
exports its generic terminals, the consumer imports them on a miss. A provider
has no peer, so its own miss arms have nothing to call. That shape cannot be
mirrored — wasm imports may not be cyclic, and the provider is compiled and
CACHED before any consumer exists.

**Fix (#6600): install the channel at runtime instead of linking it.** The
provider exports one setter and holds nullable typed-funcref globals; the
consumer calls the setter from the top of `__module_init` with `ref.func` of its
own normalising terminals; the provider's miss arms `call_ref` through the
globals. A funcref across a wasm→wasm link IS the callee, so nothing is copied,
and a provider whose consumer never installs is unchanged.

Two design points that are load-bearing rather than decorative:

- **The re-entrancy guard is on the reverse hop, not on "am I serving a consumer
  request".** The obvious guard refuses exactly the reads this exists to serve:
  the provider is normally already inside a consumer-initiated call when it reads
  the bag (`PlainDate.from(bag)` runs provider code for its whole duration). It
  is restored through `try`/`catch_all` + `rethrow`, because a provider throw
  propagating out of a reverse call is ordinary (S2m) and a leaked flag is a
  wrong ANSWER for the rest of the instance's life.
- **`__extern_get` needed its OWN arm shape, and the first cut of this slice was
  WRONG without it.** The forward arm reads `null` as "not the peer's"; a bag
  field whose VALUE is `null` arrives as the same `ref.null.extern`. The first
  measured run turned `{ calendar: null }` into an ABSENT key, the polyfill's
  `!== undefined` guard admitted it, and three
  `*-propertybag-calendar-wrong-type` rows stopped throwing. The hop now asks a
  second, consumer-side question on exactly that path
  (`__extern_get(o,k) is null && __extern_has(o,k)`, computed where the raw
  answer is still visible) and the arm returns the null only then. **No gate
  caught that; the three-family run did.**

#### 3. The three-family sample, LINKED, re-measured

120 rows each, `--target standalone`, provider linked, families **sequential**,
FRESH `JS2WASM_TEMPORAL_CACHE` per label (`cacheHit=false` on both prewarms),
quickjs artifact **and** adapter present. Base is this worktree's own base run,
taken by file-copy revert of the two edited source files ON THIS TREE; it
reproduces S16's published numbers exactly (78 / 52 / 72), which is what makes
the delta attributable. The provider binary differs between labels —
3,277,227 B (base) vs 3,277,717 B (S17) — independent proof the compiler change
reached the linked artifact.

| family | rows | base pass | **S17 pass** | fail | ce | pass→fail |
| --- | --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 120 | 78 | **92** | 25 | 3 | 2 |
| `built-ins/Temporal/Duration/**` | 120 | 52 | **56** | 61 | 3 | 0 |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 120 | 72 | **84** | 34 | 2 | 1 |
| **total** | **360** | **202** | **232** | **120** | **8** | **3** |

`fail→pass`: **33**. `__temporal_*` leaks: **0** in all six TSVs.

**Two CE flips are load artifacts, and the solo re-run says so.** Both labels ran
with the must-not-move and byte-A/B jobs alongside them (symmetric, by design),
and two files crossed the 15 s compile budget in one label only. Re-run SOLO at
60 s on BOTH trees they agree exactly: `PlainDate/basic.js` **passes** on both,
`PlainDate/compare/argument-plaindatetime.js` **fails** on both with the
identical message. Counting those verdicts the S17 total is **233**.

#### 4. The three `pass→fail`, and why they are not this slice's

All three are the same test, `*-propertybag-calendar-wrong-type.js`, which loops
over ten wrong-typed `calendar` values and fails at the first that does not throw
a TypeError. They now fail at the LAST entry, `new Temporal.Duration()` — a
PROVIDER-owned instance.

The base-tree control (`.tmp/s17/t2.mjs`, run on both trees) settles it:

| probe, real linked provider | base | S17 |
| --- | --- | --- |
| bound bag, `calendar: null` / `true` / `1` / `{}` / `Symbol()` | THREW TypeError | THREW TypeError |
| bound bag, `calendar: "iso8601"` (**must not throw**) | **THREW TypeError** | NO-THROW ✓ |
| bound bag, `calendar: new Duration()` | THREW TypeError | THREW **RangeError** |
| **INLINE** bag, `calendar: new Duration()` | THREW **RangeError** | THREW **RangeError** |
| **`Object.create(null)`** bag, same | THREW **RangeError** | THREW **RangeError** |
| `typeof <provider Duration instance>` | `"function"` | `"function"` |

On base every BOUND-bag row throws TypeError including the control that must not
— the bag was simply unreadable, so an unrelated TypeError always came out and
the test passed by accident. The two paths that never used this channel already
answered RangeError on base, so the wrong error KIND for a provider-owned
instance is **pre-existing**: it is the S11 `typeof` residual (`"function"`)
reaching a different polyfill branch. S17 replaces an accidental pass with an
exposure of that defect.

#### 5. Top error buckets, LINKED, S17 (all three families pooled, 120 fail)

15 `called value is not a function` (two call sites, 8 + 7) · 7 `prototype
Expected SameValue(«null», «[object Function]»)` · 7 `Missing internal slot
slot-years` · 5 `Object method called on null or undefined` · 5 `__closure_N()`
null pointer · 5 `Expected a RangeError but got a undefined` · 4 `Calling as
constructor Expected a TypeError` · 4 `Proxy get trap is not callable`.

**The two buckets S16 attributed to this cause are GONE**: `required property
'timeZone' missing` **7 → 0** and `year is required` **15 → 0** (S16 counted 4
in one family; pooled over all three it was 15). Total fails 151 → 120, and no
bucket grew.

#### 6. Residuals of THIS family, each reduced

| residual | probe | answers | should be |
| --- | --- | --- | --- |
| provider WRITES a consumer bag | `.tmp/s17/c2.mjs` | old value | new value |
| provider calls a consumer method (15 rows) | `.tmp/s17/c3.mjs` | `called value is not a function` | `7` |
| `typeof <provider instance>` | `.tmp/s17/t2.mjs` | `"function"` | `"object"` |
| `PlainDate#add(bag)` / `#until(…, options)` | `.tmp/s17/t1.mjs` | `""` on BOTH trees | a value |

**The `called value is not a function` bucket — now the LARGEST at 15 pooled
rows — is one step from fixable.**
After this slice `typeof o.m` inside the provider answers `"function"` — the
reverse GET hands the consumer's closure back correctly — and the CALL still
throws, from the `wantIsCallableGuard` in `emitDynamicCall`
(`expressions/calls.ts` ~L4851): `__is_callable` is a module-local ladder that
cannot recognise a foreign closure and refuses before `__apply_closure` is
reached. A consumer closure passed as a plain ARGUMENT and called already works,
which is what makes the guard — not the apply — the attributed terminal. The
forward direction answered the same question with the `callableKind` terminal;
the reverse needs its twin spliced ahead of `__is_callable`'s terminal `0`.

**A reverse `methodCall` hop was built and then REMOVED.** With the guard
throwing first it never fired in any probed shape, and an unexercised arm in a
provider's hot terminal is not worth its global.

#### 7. Two samples that must NOT move, and neither did

| sample | rows | base | S17 | flips |
| --- | --- | --- | --- | --- |
| `Object/keys` + `expressions/object` + `Reflect/{get,has}` | 81 | 77 pass / 4 fail | identical | **0** |
| `Object/{entries,values,getOwnPropertyNames}` + `statements/for-in` | 101 | 81 pass / 20 fail | identical | **0** |

Per-file status diff, not just counts.

#### 8. Order preservation

- **Corpus byte A/B** (42 modules × {gc, standalone} = 84 artifacts):
  **84/84 sha256-identical.** No single-module artifact moves on either lane.
- **Targeted byte A/B** — the LINKED PAIR, because the corpus contains none: on
  `gc` a linked npm package produces no separate wasm provider at all (the host
  mirror owns it), so those rows are absent on both labels; on standalone the
  provider and all five consumers move. That is the mechanism, and it is
  **per-linked-module rather than per-shape**: the `noCarrier` and `nullProtoBag`
  controls move too. Stated rather than hidden — any object literal in a consumer
  can cross, so only an escape analysis would narrow it, and it would buy bytes,
  not answers.
- Equivalence gate at baseline: 22 failing / 1720 passing.

#### 9. Traps, carried forward and added to

All S11–S16 traps still bite; three were paid again here.

- **The `test262` submodule and the quickjs artifacts are BOTH per-worktree.**
  The submodule trap is S16's; the new half is that `.test262-cache/` must also
  carry `quickjs-artifact-*/libquickjs.wasm` **and** the matching
  `quickjs-eval-adapter-<hash>.wasm`. Without them the first 39 rows of the base
  family run scored 0 pass / 38 fail with `the quickjs provider is not built` — a
  result that looks like a catastrophic regression and is a missing file. Copying
  the sibling worktree's `.test262-cache/` is instant.
- **Run the two labels under the SAME background load.** Compile-budget timeouts
  are wall-clock, so a label measured alone and a label measured beside other
  jobs are not comparable. Both labels here ran with the same companions, and
  every CE flip was re-run solo at 60 s on both trees.
- **A fix that opens a previously-dead path can introduce a WRONG answer in the
  same commit.** The null-vs-absent collapse became reachable only because the
  bag became readable; the census, the witness and every gate were green while
  three test262 rows silently stopped throwing. The three-family run caught it —
  an argument for running it BEFORE writing the issue file, not after.

### Artifacts

`.tmp/s17fam/{pd,du,zdt}-{base,new}.tsv` (+ logs and prewarm stamps),
`.tmp/s17fam/{mnm,mnm2}-{base,new}.tsv`, `.tmp/s17/byteab{,2}-{base,new}.tsv`,
the censuses `.tmp/s17/c{1,2,3,4}.mjs` with their `-base`/`-new` outs, the
real-provider reductions `.tmp/s17/{t1,t2}.mjs` with both labels' outs, the solo
re-runs `.tmp/s17/solo-{base,new}.out`, the revert copies `.tmp/s17base/*` and
the drivers
`.tmp/s17/{run-fam.sh,family.mts,prewarm.mts,mnm.mts,mnm2.mts,byteab.mts,byteab2.mts,pair2.mjs,probe.mjs,solo.mts}`
in this worktree (`/home/user/js2/.claude/worktrees/agent-a3013ae2096b93c10`).

### Acceptance criterion 4 — S17 update

MET-for-the-sample at **232/360** (solo-corrected **233**; was 202), same three
families, **33 `fail→pass`**, **3 `pass→fail`** whose cause is measured to be
pre-existing and independent of this channel (base-tree control above), both
must-not-move samples flat with 0 flips, the `gc` lane byte-identical on the
corpus, the equivalence gate at baseline, and 0 `__temporal_*` leaks. Base and
branch were both measured on this tree by file-copy revert. No full-corpus number
is claimed; a corpus run remains the tech lead's to schedule.

### S18 findings (2026-09-14) — the `called value is not a function` attribution was wrong again, and the real Temporal cause is a literal-vs-computed member-name split

Full write-up in `plan/issues/6605-standalone-link-reverse-method-call.md`.

#### 1. The hand-off attribution did not reproduce, and it took three probe sets to say why

S17 handed over: "the reverse GET now hands the consumer closure back correctly,
and the CALL still throws, from the `wantIsCallableGuard` in `emitDynamicCall`
(`expressions/calls.ts` ~L4851) — `__is_callable` is a module-local ladder that
cannot recognise a foreign closure." **That is not where the throw comes from.**

The first probe set (`.tmp/s18/c5.mjs`) refuted it outright: a consumer closure
obtained through the reverse GET and then called dynamically inside the provider
answers **7**, in every shape — plain argument, bag field, array element,
get-then-pass. If the guard refused foreign closures, none of those could work.

The message has **four** emitters in `src/codegen`. Tagging each one
(`A` `emitDynamicCall`, `B` `new-super`, `C` `resolved-callee-guard`,
`D` `fnctor-missing-method-dispatch`) and re-running says **C**, every time, for
every probe and for the real provider. `resolved-callee-guard.ts` is the terminal
miss of `__extern_method_call` — the resolve-then-apply native — and not a
callability test on a value at all.

A second tag (`C-PROV` / `C-CONS`, keyed on `ctx.exportsConsumedByWasm`) split
the bucket into two independent defects:

| tag | the module that threw | what it was doing |
| --- | --- | --- |
| **C-PROV** | the PROVIDER | `o.m()` on a CONSUMER-owned carrier |
| **C-CONS** | the CONSUMER | `Temporal.Duration.from(…)` on a PROVIDER-owned receiver |

**Why the earlier attribution looked right.** S17's census provider contains
`o.m()`, so the failing rows all *mention* a call — but the throw was raised one
frame out, by the consumer's own method call INTO the provider. And the answers
move with provider module CONTENT (the #6432 action-at-a-distance hazard):
adding one provider-own closure to an otherwise identical provider flipped
`f = o.m; f()` from a throw to `7` (`.tmp/s18/c6{a,b,c}.mjs`). Any single-probe
reading of this family is unreliable; only the emitter tag was stable.

#### 2. C-PROV — root cause, and the fix this slice ships

`__extern_method_call`'s non-`$Object` receiver arm consults
`boundaryObjectCallIdx ?? peerMethodCallIdx` — the JS-host boundary call and the
CONSUMER's forward `__js2wasm_link_method_call` terminal (S2h). **A provider has
neither**, so the arm is empty and control falls through to the terminal miss,
which correctly throws for a method it could not resolve. The provider had no way
to resolve it, because the only module that can is the consumer.

S17 built a reverse `methodCall` hop and REMOVED it, reasoning that "with the
guard throwing first it never fired in any probed shape". The guard that threw
first was this one, and the hop was never placed in the arm that reaches it. The
hop was the fix; it was removed for the wrong reason.

#6605 adds it: `__js2wasm_link_reverse_method_call` plus the consumer-side
`__js2wasm_link_local_method_call`, a fifth funcref slot on
`__js2wasm_link_install_peer`.

| probe, host-free linked pair | base | S18 |
| --- | --- | --- |
| provider `o.m()` on a consumer bag | TypeError | **7** |
| the same method reading `this` | TypeError | **42** |
| absent method (control) | TypeError | TypeError |
| provider calling its own method (control) | 5 | 5 |

Base and branch both measured on this tree by file-copy revert
(`.tmp/s18/witness-base.out` vs `witness-new3.out`).

#### 3. Two things this slice built, measured, and then reverted

Both looked correct and both introduced a silent wrong value where the base tree
threw. Neither would have been caught without running the base.

- **The forward null-vs-owned fix.** The forward terminal's `ref.null.extern` is
  THREE states: not-my-receiver, resolved-but-apply-declined, and the method
  legitimately returned `null`. `NS.retnull()` proves the third is real — it
  throws `called value is not a function` while `NS.retundef()` is correct
  (`.tmp/s18/c7`). A consumer-side arm re-asked `memberGet` + `callableKind` on
  the null path and adopted the null when the member was callable. Measured
  (`.tmp/s18/c3-new.out`): six probes went from a TypeError to `"null"`, because
  the apply-declined state passes that test too. **Reverted.** Fixing it properly
  needs a provider-side "I really did run it" channel, i.e. a forward ABI
  addition.
- **Null-adoption in the reverse arm.** The same mistake, mirrored. The first cut
  copied `reverseGetArmInstrs`' `callOwned` shape; `o.add(3, 4)` became `null`
  and `this.v` became `undefined` where both had thrown
  (`.tmp/s18/witness-new.out`). The shipped arm returns **only** a non-null
  answer, which makes it strictly throw-reducing and never answer-changing.

A third defect was found the same way and FIXED rather than reverted:
`localMethodCall` composed `__extern_get` + `__apply_closure` by hand and did not
bind the receiver for an object-LITERAL method — `{ v: 42, readSelf() { return
this.v; } }` answered `NaN` through the hop and `42` in a single module
(`.tmp/s18/c10-new.out`). A class instance bound correctly either way, so the gap
was invisible in half the shapes. It now installs and restores `__current_this`
around the apply, through `try`/`catch_all` + `rethrow`.

#### 4. C-CONS — the real Temporal bucket, localised but NOT fixed here

**This slice does not move the `called value is not a function` bucket.** The
real-provider reduction is identical before and after, character for character
(`.tmp/s18/r1-base.out` vs `r1-new.out`, 16 probes). Said plainly rather than
buried: criterion 4's "the bucket must move" is **not met**.

What the slice delivers instead is where the bucket actually lives. With the
forward terminal instrumented to return a marker string on each of its resolve
exits (`.tmp/s18/r4-inst.out`):

| probe, real linked provider | answer |
| --- | --- |
| `Temporal.Duration.from("P0Y")` | **TypeError** |
| `Temporal.Duration[k]("P0Y")`, `k = "from"` | **works** |
| `const f = Temporal.Duration.from; f("P0Y")` | works |
| `typeof Temporal.Duration.from` | `"function"` |
| `Temporal.Duration.from({[u]: 0}).years` / `.toJSON()` | `0` / `"PT0S"` |
| `f.call(undefined, "P0Y")` | `MC-EXIT-UNDEFGET` |

The literal-name call throws while the computed-key call on the same receiver,
the same member and the same argument answers correctly — and **no marker string
appears on the literal path, so the forward terminal is never consulted there at
all.** A member call written with a literal name takes a per-name dispatch path
(the `__call_m_<name>` family the S2h comment names) that has no link-boundary
arm; only the computed form reaches the generic `__extern_method_call` where the
peer arm lives. That is the next slice, and it is in a third file again.

`f.call` / `f.apply` on a provider-owned closure is a separate residual with its
own evidence: the provider resolves `call` on its own closure as `undefined`, so
`Function.prototype.call` is not reachable across the boundary.

#### 5. Regression sample — two families, 120 rows each, per FILE

`--target standalone`, provider linked, sequential, FRESH `JS2WASM_TEMPORAL_CACHE`
per label (`cacheHit=false` on both prewarms), quickjs artifact and adapter
present. Both labels on this tree by file-copy revert. The provider binary differs
between labels — 3,277,717 B (base) vs 3,277,842 B (new) — independent proof the
change reached the linked artifact.

| family | rows compared | base pass | S18 pass | flips | pass→fail |
| --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 120 | 93 | **93** | 1 (CE↔fail) | **0** |
| `built-ins/Temporal/Duration/**` | 91 (intersection) | 44 | 44 | **0** | **0** |

`__temporal_*` leaks: **0** in all four TSVs.

This is a REGRESSION GUARD, not an improvement measurement: the change provably
cannot move these rows (§4), so a pass delta was never the question. It is
reported as flat because it is flat.

The one PlainDate flip is `compare/argument-plaindatetime.js`, `compile_error` on
base and `fail` on the branch — the SAME file S17 recorded as a compile-budget
load artifact. Re-run **solo at 60 s on both trees** it agrees exactly: `fail` on
both, with the identical message (`TypeError: Object method called on null or
undefined | at L24`). Counting the solo verdicts, PlainDate is 93/93 with **zero**
flips.

**The Duration base label is 91 rows, not 120, and that is a shortfall rather
than a finding.** The base run stalled on a row that ran far past the family's
15 s per-row budget and was stopped; the comparison is therefore over the 91-row
intersection, which is where the "0 flips" applies. The branch label completed all
120. Stated rather than presented as a full family.

#### 6. Traps, carried forward and added to

All S11–S17 traps still bite. New this slice:

- **An error MESSAGE is not a call site.** `called value is not a function` has
  four emitters, and the one everybody reaches for (`emitDynamicCall`'s
  IsCallable guard) is not the one that fires for this family. Tagging each
  emitter took one edit and one run and overturned an attribution that had
  survived a whole slice. Do that FIRST, before reasoning about which guard
  "should" be responsible.
- **Tag the MODULE as well as the site in a linked pair.** `C` alone still
  pointed at one file; `C-PROV` vs `C-CONS` is what split one bucket into two
  unrelated defects, one of which was not a provider problem at all.
- **Measure the base of your own witness before you write its assertions.** The
  #6605 witness was first written asserting "every one of these threw on base",
  taken from the hand-off narrative. Run against base, three of the seven had
  never thrown, and one of the two the slice "fixed" was actually a regression
  (a throw turned into `undefined`). One `cp` and one run; it changed what
  shipped.
- **Apply to your own code the standard you applied to someone else's.** The
  forward null-adoption was rejected for collapsing a three-state answer; the
  reverse arm shipped with the identical collapse until the same test was turned
  on it.

### Artifacts (S18)

`.tmp/s18fam/{pd,du}-{base,new}.tsv` (+ logs and prewarm stamps), the censuses
`.tmp/s18/c{5,6a,6b,6c,7,8,9,10}.mjs` with their `-base`/`-new` outs, the
real-provider reductions `.tmp/s18/r{1,2,3,4}.mjs` with their instrumented outs,
the witness probe `.tmp/s18/witness-probe.mts` with
`witness-{base,new,new2,new3}.out`, the solo re-runs, the revert copies
`.tmp/s18base/*` and the drivers
`.tmp/s18/{run-fam.sh,family.mts,prewarm.mts,pair2.mjs,probe.mjs,solo.mts,table.mjs}`
in this worktree (`/home/user/js2/.claude/worktrees/agent-ac05c86996312c107`).

### Acceptance criterion 4 — S18 update

**NOT met for this slice, and deliberately not claimed.** The
`called value is not a function` bucket does not move (§4 — identical
real-provider reduction before and after). What S18 delivers instead is the
corrected attribution (the bucket is `resolved-callee-guard.ts`; it is two
independent defects; the Temporal half is a literal-vs-computed member-name split
whose dispatch path has no link-boundary arm) plus the C-PROV half fixed and
witnessed. The regression sample is flat with 0 `pass→fail` and 0 `__temporal_*`
leaks over 211 compared rows. No full-corpus number is claimed.

### S19 findings (2026-09-14) — the bucket is not at the link, not in the dispatchers, and not even in `from`: it ends at the polyfill's own intrinsic registry

Full write-up in
[#6606](6606-standalone-class-static-dynamic-dispatch.md). **No compiler change
ships this slice**, deliberately — §4.

#### 1. The hand-off was wrong in every clause, for the ninth slice running

S18 handed over: "a literal-named member call takes a per-name
`__call_m_<name>` dispatch path with no link-boundary arm; only the computed
form reaches the generic native where the peer arm lives, and the forward
terminal is never consulted on the literal path."

Measured on S18's own tip, which is this branch's base:

| S18's claim | what the base tree does |
| --- | --- |
| literal call takes `__call_m_from_1` | the consumer WAT emits `call $__extern_method_call` **directly** (`.tmp/s19/w1-names.txt`, func 228) |
| the forward terminal is never consulted | it IS consulted and exits through its **apply** |
| `Temporal.Duration[k]("P0Y")` works | **`null`** — a silent wrong value |
| `const f = Temporal.Duration.from; f("P0Y")` works | **`null`** |

S18's own marker legend already said what the missing marker meant ("a thrown
TypeError ⇒ it resolved AND applied, and `__apply_closure` answered null"); the
prose recorded the opposite. **An absent marker is evidence about WHICH exit
fired, never evidence that the function was not entered** — that inversion cost
a whole slice, and it is the trap to carry forward.

A synthetic linked pair refused the attribution in the first ten minutes: a
provider-owned class whose static is called by LITERAL name across the link
answers correctly (`"F:x"`), while the COMPUTED form answers `null`
(`.tmp/s19/c1-base.out`) — the exact inverse of the hand-off.

#### 2. The chain, instrumented layer by layer

Seven separate instrumented builds of the real linked provider, fresh
`JS2WASM_TEMPORAL_CACHE` per label, `cacheHit=false` on every prewarm:

| layer | marker | verdict |
| --- | --- | --- |
| consumer `__extern_method_call` `$Object` arm | `MC-OBJARM` | not taken |
| provider forward terminal, resolve exits | `MC-NULLGET` / `MC-UNDEFGET` | neither — the member RESOLVED |
| provider forward terminal, apply exit | `MC-APPLYNULL` | **fires** |
| provider `__apply_closure` | `AC-NULLRES-1` | **fires** — the arity-1 arm ran and returned null |
| provider `__call_fn_method_1` ladder terminal | `MD-MISS-1` | not reached — an arm matched |
| provider native-proto front arm (`S19_NO_NP`) | — | not the culprit |

Every dispatch layer is correct. **The callee returns null on its own.**

#### 3. Below the dispatch — one module, no link, no consumer

A diagnostic injected into the polyfill's frozen `Temporal` namespace literal
lets the provider answer questions about itself (`.tmp/s19/diag3.out`):

| probe, provider-internal | answer |
| --- | --- |
| `Duration.from("P0Y")` | **`null`** |
| `sn("P0Y")` — the entire body of `Duration.from` | **`null`** (`=== null` is `true`) |
| `Ye.exec("P0Y")` | a 12-element match — the parse works |
| `Ae("P0Y")` / `lt("P0Y")` | `false` / `false` — `sn` takes its string branch |
| `new (ce("%Temporal.Duration%"))(1)` `.toJSON()` | **`invalid receiver: method called with the wrong type of this-object`** |
| `new Duration(1).toJSON()` | `P1Y` — the real class is fine |
| the exact `iife + destructure + captured-const new` shape `sn` uses | correct, 7/7 (`.tmp/s19/c6-base.out`) |

So the bucket ends at **`ce()`, the polyfill's intrinsic registry**: `new` on the
value it returns for `%Temporal.Duration%` yields an object that fails its own
brand check. Single-module, standalone, several layers below the link. That is
the next slice and the one that moves rows.

#### 4. Why nothing was changed, said plainly

Criterion 4 asks the `called value is not a function` bucket to move. **It does
not move this slice, and no link-side change could move it** — the boundary
already resolves and already applies; the applied callee answers null. Three
independent single-module defects were found on the way (§5), each real, none on
the failing rows' critical path. Shipping a codegen change into the hottest path
in the compiler, under a hard "0 legitimate `pass→fail`" bar, that provably
cannot move the bucket it is measured against, is not worth the regression risk.

**No family measurement is reported and none was needed.** The branch's source
tree is byte-identical to its base — the diff touches nothing outside
`plan/issues/` — so there is provably nothing to measure, and a run quoted here
would be attribution dressed as measurement. The corpus byte A/B and the
equivalence gate are flat for the same reason.

#### 5. Three reductions handed forward, each ~10 lines, one standalone module

- **A — the receiver is passed as argument 0.** `C[k]("A")` with a
  compile-time-foldable key on a class object emits
  `global.get <class singleton>; call $C_one` — the class lands in the first
  formal and the real arguments shift right. `C[k2]("A","B")` answers
  `two:function () { [native code] },A`. A silent wrong answer. Visible in the
  real provider as `Temporal.PlainDate[k]("1976-11-18")` →
  `Options parameter must be an object, not string`.
- **B — the call emits nothing.** `function callDyn(o,k,a){return o[k](a);}`
  compiles to `ref.null extern; return`.
- **C — a class-derived method value fails every receiver-bearing apply.**
  `f("A")` and `Reflect.apply(f,C,["A"])` are correct; `b.g("A")` answers
  `null` and `f.call(C,"A")` / `f.apply(C,["A"])` throw
  `called value is not a function`. A plain function value is correct in all
  five shapes. This retires #6605's residual 2 as a boundary property — it
  reproduces with no link at all.

#### 6. Traps, carried forward and added to

All S11–S18 traps still bite. New:

- **An absent marker says WHICH EXIT fired, not that the function was skipped.**
  §1. Put a marker on the SUCCESS path too, or the negative space is
  unreadable.
- **`typeof <call>` hides a null.** S18 read `typeof Temporal.Duration[k](…)`
  as "works"; the value was `null` and `typeof null` is `"object"`. Stringify
  the value, never its `typeof`, when the question is whether a call worked.
- **Ask the PROVIDER about itself before blaming the boundary.** Injecting one
  function into the polyfill's namespace literal took ten minutes and moved the
  attribution four layers. Three consecutive slices blamed the link for a
  defect that reproduces in one module.
- **A reduction that disagrees with the brief is the finding.** The synthetic
  pair refuted the hand-off before any compiler file was opened; everything
  after that was confirmation.

### Artifacts (S19)

`.tmp/s19/` and `.tmp/s19base/` in
`/home/user/js2/.claude/worktrees/agent-a93eeeb2d60f16ed8`: censuses `c1`–`c6`
with their `-base` outs, the real-provider reductions `r1-base.out` and
`r1-inst{1,2,3,4,5}.out`, the provider-internal diagnostics `diag{1,2,3}.out`,
the WAT dumps `w1-names.txt` / `sw-{opaque,cmp,c4,c4b}.txt`, and the drivers
`{single,swat,watnames,diag,probe,pair2}.mjs`.

### Acceptance criterion 4 — S19 update

**NOT met, and deliberately not claimed.** The
`called value is not a function` bucket does not move. What S19 delivers is the
corrected attribution — the bucket is not at the link, not in the dispatchers,
and not in `Duration.from`; it ends at `ce("%Temporal.Duration%")` inside the
provider — plus three single-module reductions and a named next target. No
source file changed, so no conformance number is claimed in either direction.

### S20 findings (2026-09-14) — the brand check was the symptom; no instance was ever created, and the arguments were never evaluated

Full write-up in
[#6607](6607-standalone-dynamic-new-call-callee.md). **A container restart
killed the first S20 lane mid-slice**; what survived was an uncommitted 54-line
change to `src/codegen/expressions/new-super.ts` plus its probe outputs in
`.tmp/s20/`. Those were salvaged, re-verified from scratch on a fresh branch
(`issue-5383-standalone-temporal-s20b`, based on S19's tip), and everything
below was re-measured here — no number is inherited from the dead lane's run.

#### 1. The hand-off's mechanism was wrong; its symptom was real

S20's brief read S19's ending state — `new (ce("%Temporal.Duration%"))(1)`
producing an object that fails its own class's brand check — as an instance
IDENTITY defect, and named the candidates: prototype identity, a WeakMap keyed
on the struct vs a boxed carrier, `fnctor-constructor-identity.ts`.

**No instance existed to have an identity.** `compileNewExpression` reaches the
dynamic-`new` dispatch for a bare IDENTIFIER callee, and (JS-host lane only,
#4616) for a MEMBER-ACCESS callee. A **CALL-expression** callee matched neither,
fell through to the `__new___unknown` host import — which exists in no lane and
cannot exist in standalone — and emitted a bare `ref.null.extern`.

Two consequences, and the second is the one no reading of the downstream symptom
would have predicted: the `new` evaluates to **null**, and because the legacy arm
returns **before** the argument loop, **the argument expressions are never
evaluated at all**. The polyfill then calls a prototype method on that null and
its internal-slot lookup reports the wrong-receiver message, several layers away.

The clause of the hand-off that WAS right, and is a different defect: see §4.

#### 2. Reduction — 16 probes, one standalone module, no polyfill, no link

`.tmp/s20/c6.mjs` via `.tmp/s20/single.mjs`, one compiled module per probe. The
prelude is the registry shape the polyfill actually has — a bare `{}`, so `ce`
returns `any`.

| probe | base | S20 |
| --- | --- | --- |
| `new (ce("%C%"))(1).tag` | `undefined` | **`T1`** |
| `new (ce("%D%"))(1, 2).tag` | `undefined` | **`D12`** |
| arg order, `new (ce("%D%"))(mark("a"), mark("b"))` | `/undefined` — **no effects ran** | **`ab/Dab`** |
| literal / named-const spread | `undefined` | **`D12`** |
| zero args · nested · 3-iteration loop | `undefined` | **`Tundefined` · `TT1` · `T0T1T2`** |
| method-call callee `new (({g: ce}).g("%C%"))(1)` | `undefined` | **`T1`** |
| callee side effect, once | `""` | **`k`** |
| 10 args (Duration's real arity) | `undefined` | **`D12`** |
| null / number / plain-fn / missing-key callee (controls) | `undefined` | `undefined` |

The four controls are unchanged **by design**: `plainNullNoMatchBase` pins this
arm's no-match outcome to the pre-existing `ref.null.extern`, so a
non-constructor callee has no new outcome to regress against.

#### 3. Provider-internal, the real polyfill, one module

Diagnostic injected into the frozen `Temporal` namespace literal
(`.tmp/s20/diag2-{base,new}.out`), fresh cache, `cacheHit=false`:

| probe, provider-internal | base | S20 |
| --- | --- | --- |
| `Duration.from("P0Y") === null` | **`true`** | **`false`** |
| `Duration.from("P1Y").years` | throws (null) | **`1`** |
| `Duration.from("P1Y2M")` → months / years / sign | throws | **`2` / `1` / `1`** |
| `Duration.from("P1Y").blank` | throws | **`false`** |
| `Duration.from(Duration.from("P1Y")).years` | throws | **`1`** |
| `new (ce("%Temporal.Duration%"))(1).years` | `undefined` | **`1`** |
| `PlainDate.from("1976-11-18")` → y-m-d | correct | correct (control) |

#### 4. What is still broken, and it is NOT this

`Duration.from("P1Y").toJSON()` still throws *invalid receiver*. The receiver is
NOT the problem — a probe method installed on `Duration.prototype` and called on
that very object reports `this === r`, `slots: yes`, `brand: true`
(`.tmp/s20/diag4-new.out`). The method being **found** is wrong.

`.tmp/s20/c9.mjs` isolates it in ten lines: three classes each declaring
`toJSON`, and a method call by name on a statically-unknown receiver resolves to
the **LAST-declared** class that declares the name, every time. `uniqB()` called
on an `A` instance returns `"UB"` — a method the object does not have. It is a
per-name ladder with **no runtime class test**.

**This is pre-existing and untouched by S20**: the same probe through an
`any`-typed parameter holding a *statically* constructed instance gives the
identical wrong answer on base (`.tmp/s20/c9-base.out`, rows 11–14). It is why
`toString()` on a Temporal object reports *toString() radix argument must be
between 2 and 36* — `Number.prototype.toString`. It is the next slice, and the
first one where the fix is in the hottest dispatch path in the compiler.

Two smaller residuals recorded on the way, both identical on base:
`Object.getPrototypeOf(x) === C.prototype` is **false** for a dynamic-`new`
instance while `instanceof` and `.constructor` are both correct; and
`new WeakMap().set(x, 9)` with such an `x` emits **invalid Wasm**
(`call[1] expected type (ref null 6), found call of type anyref`).

#### 5. Regression sample — three families, 120 rows each

`--target standalone`, provider linked, sequential, FRESH `JS2WASM_TEMPORAL_CACHE`
per label (`cacheHit=false` on both prewarms), quickjs artifact + adapter
present. Both labels on this tree by file-copy revert of `new-super.ts`. The
provider binary differs between labels — **3,277,842 B (base) vs 3,291,080 B
(S20)** — independent proof the change reached the linked artifact.

| family | rows | base pass | S20 pass | fail→pass | **pass→fail** | leaks |
| --- | --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 120 | 93 | 93 | 0 | **0** | 0 |
| `built-ins/Temporal/Duration/**` | 120 | 56 | **64** | 8 | **0** | 0 |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 120 | 84 | **88** | 4 | **0** | 0 |
| total | 360 | 233 | **245** | **12** | **0** | **0** |

**Six of the eight Duration gains are the `called value is not a function`
bucket** — `from/argument-string.js`, `from/lower-limit.js`,
`from/string-with-skipped-units.js`, `from/argument-string-fractional-precision.js`,
`from/argument-string-fractional-units-rounding-mode.js`,
`from/argument-string-negative-fractional-units.js`. The other two, and three of
the four ZonedDateTime gains, are `Missing internal slot slot-years`. This is the
bucket S17–S19 chased through four wrong attributions; it moves.

**Four rows flipped between `compile_error` and a status, in both directions.**
Every one is a compile-budget artifact of the 15 s per-row cap, not a status
change. Re-run **solo at 60 s on both trees** they agree exactly, row for row
(`.tmp/s20fam/solo-{base,new}.tsv`):

| row | in-sample base | in-sample S20 | solo base | solo S20 |
| --- | --- | --- | --- | --- |
| `Duration/milliseconds-undefined.js` | pass | compile_error (15.1 s) | **pass** (18.4 s) | **pass** (18.5 s) |
| `Duration/months-undefined.js` | pass | compile_error (15.6 s) | **pass** (14.7 s) | **pass** (14.9 s) |
| `ZonedDateTime/prototype/add/overflow.js` | pass | compile_error (15.2 s) | **pass** (14.9 s) | **pass** (14.3 s) |
| `Duration/compare/order-of-operations.js` | compile_error | fail | **fail** (16.7 s) | **fail** (15.8 s), identical message |

The table above already counts the solo verdicts. Said plainly rather than
buried: **this change does make consumer compiles measurably slower** — three
rows that sat just under the cap now sit just over it under parallel load. The
margin is sub-second on rows already at 14–15 s, and it is why
`plainNullNoMatchBase` exists (§7).

#### 6. Must-not-move samples — 286 rows, per FILE, 0 flips

`Object/keys` + `expressions/object` + `Reflect/{get,has}` (140 rows) and
`Object/{entries,values,getOwnPropertyNames}` + `statements/for-in` (146 rows),
diffed per file: **0 flips**, both labels on this tree.

Corpus byte A/B — 42 modules × {gc, standalone}: **0 artifacts move on either
lane**, including `gc`. That is the expected result and also a weak probe: the
corpus contains no `new (<call>)(…)` in a host-free module, so the positive
control for "the change reaches an artifact" is the provider byte delta in §5,
not the corpus. Equivalence gate at baseline: **22 failing / 1720 passing**.

#### 7. The `plainNullNoMatchBase` parameter, measured rather than argued

The identifier arm's standalone no-match base inlines a TypedArray construct
plus an `IsConstructor` guard (#2872). A value out of an intrinsic registry can
never be a `$__ta_ctor`, so for this shape that arm could only ever decline —
and it is not free. Three prewarm builds of the real provider, fresh cache,
`cacheHit=false` on each:

| provider build | bytes | vs base |
| --- | --- | --- |
| base (no call-callee arm) | 3,277,842 | — |
| S20, pinned `ref.null.extern` no-match base | 3,291,080 | +13,238 (+0.40 %) |
| S20, TypedArray no-match base | 3,435,885 | +158,043 (+4.8 %) |

~145 KB in an artifact that links into **every** consumer compile, to serve a
shape that cannot reach it. The parameter is the difference between the two.

#### 8. Gates

`typecheck`, `check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`, `check:speculative-rollback`,
`check:issue-ids:against-main`, `biome` (changed files), `update-issues --check`
— all green. Two **inherited** reds, both verified present with the branch's own
change reverted:

- `check:compiler-boundaries` → `inventory-valid-architecture-incomplete`
  (`src/ir/program/errors.ts`), as handed over.
- `LOC_GATE_BASE=origin/main` LOC/func gates fail on **`src/runtime.ts`**
  (19,822 vs a 19,601 ceiling; `buildImports` 308 > 300). S20's own commits
  touch two files and neither is `runtime.ts` — the growth arrived with the
  S12–S17 merge commits and current `origin/main` (14 commits ahead) no longer
  carries it. It resolves when the stack merges `origin/main`; that merge was
  deliberately NOT done here because it would have invalidated every base
  measurement above.

The issue id **#6607** was verified `UNASSIGNED` on `origin/issue-assignments`
(`claim-issue: OK — #6607 is unassigned (read origin/issue-assignments)`) and is
free on `origin/main` and in every local worktree. The claim WRITE could not be
taken: `claim-issue.mjs` exits **5** after every retry — heavy contention on the
ref, nothing written. GitHub pushes return 403 for all lanes today, so no branch
or PR exists yet either.

#### 9. Traps, carried forward and added to

All S11–S19 traps still bite. New:

- **A brand-check failure is not evidence that an instance exists.** Four
  candidate mechanisms in the hand-off all presumed one did. The ten-line
  reduction — a class in a plain object registry, fetched by key, `new`-ed —
  answered `undefined` on the FIRST run and none of the four were reachable.
  Reduce before choosing between mechanisms, not after.
- **Check whether the ARGUMENTS ran.** The null was visible; the dropped
  argument evaluation was not, and it is the half a refactor will silently
  reintroduce. One `effects += x` in the probe made it visible.
- **A unique method name is a different test from a colliding one.** The
  prototype probe that proved the receiver was correct used a name only one
  class declared, which is exactly why it passed — and for one run that looked
  like "receiver fine, mystery elsewhere". Naming the probe `toJSON` would have
  found §4 immediately.
- **Verify the number in the comment you are shipping.** The salvaged patch
  justified `plainNullNoMatchBase` with a byte figure from a run that no longer
  existed. Re-measuring it cost one 72 s provider build and turned an inherited
  claim into §7.
- **A commit survives a container restart; a working tree does not.** The dead
  lane had a correct, complete fix and zero commits. Recovering it cost an hour
  of re-derivation that a 30-second WIP commit would have made free.

### Artifacts (S20)

`.tmp/s20/` and `.tmp/s20base/` in
`/home/user/js2/.claude/worktrees/agent-ab770147db3a03c0f`: the censuses
`c6`–`c9` with their `-base`/`-new` outs, the provider-internal diagnostics
`diag2`–`diag4` with `-base`/`-new` outs, `test-{base,new}.out` (the witness file
run on both trees), `corpus-{base,new}.jsonl`, the revert copies
`new-super.{base,new}.ts` and the drivers
`{single.mjs,family.mts,prewarm.mts,fam.sh,solo.mts,solo.sh,mnm.sh,flips.mjs,corpus.mts,waitfor.sh}`;
the samples in `.tmp/s20fam/` and `.tmp/s20mnm/`.

### Acceptance criterion 4 — S20 update

**MET.** The `called value is not a function` / `Duration.from` bucket moves: six
of those rows go `fail → pass`, plus six more on `Missing internal slot`, for
**233 → 245** over the 360-row three-family sample, with **0 legitimate
`pass→fail`**, **0 `__temporal_*` leaks**, 286 must-not-move rows flat per file,
both corpus lanes byte-identical and the equivalence gate at baseline.

### S21 findings (2026-09-14) — the ladder DID have a class test; it was `ref.test`, and `ref.test` is structural

Full write-up in
[#6608](6608-standalone-per-name-method-ladder-no-class-test.md). Branch
`issue-5383-standalone-temporal-s21`, based on S20b's tip `2e36ca346a`. Every
number below was measured on this tree, both labels, by file-copy revert of the
three changed files (`.tmp/s21base/`); nothing is inherited from S20's run.

#### 1. The hand-off's diagnosis was right about WHERE and wrong about WHAT

S20 handed over "a per-name ladder with **no runtime class test**; add a
`ref.test` per declaring class". The ladder already emits one `ref.test` per
declaring class, and has since #2151. **`ref.test $C` is not a class test.** It
is a *shape* test: WasmGC canonicalizes struct types structurally, field NAMES
do not exist in wasm, and the three probe classes — which keep their state in a
`WeakMap` and therefore have no fields at all beyond the compiler's own
`__tag` — are ONE runtime type. Every arm claims every instance; the ladder's
assembly order then decides which body runs.

The compiler's own registry does keep them apart (`__call_m_toJSON_0 entries:
A#55 | B#59 | E#63`, with distinct tags 0/1/2), which is exactly why reading
the emitter does not show the defect. Canonicalization happens below it.

Two ladders, two different wrong answers, and the second was not in the
hand-off's model at all:

| ladder | assembly | wrong answer |
| --- | --- | --- |
| `__call_m_<name>_<arity>` (closed-method dispatch, fixed + vararg) | later arms wrap outermost | the **LAST** declarer |
| `__call_toString` / `__call_valueOf` (ToPrimitive) | first arm that matches | the **FIRST** declarer |

That is why the hand-off's two symptoms read as unrelated: `toJSON` picked the
last declarer (E), `toString` picked the first (A, and
`Number.prototype.toString` in the real provider). Same defect, opposite
direction, because the two ladders are built in opposite orders.

#### 2. It is a re-run of #4618, which fixed exactly this — for other ladders

#4618 hit the same canonicalization on the JS-host class-member bridge
(React's repeated `class Foo` declarations running a later sibling's
`UNSAFE_componentWillMount`) and introduced a `__tag` guard. That guard was
written as a **local helper inside `index.ts`, twice**, and applied to the two
host ladders only. The standalone any-receiver ladder and the ToPrimitive
ladder never got it. S21 moves the helper to `src/codegen/class-arm-tag-guard.ts`
(index.ts **net −95 lines**) and applies it to both.

The guard declines — emitting the caller's previous two instructions, so the
bytes do not move — unless another emitted struct shares this one's layout.
That is the byte-preservation property the hand-off asked for, and it is a
property of the guard rather than of a flag.

#### 3. Reduction — one standalone module, no polyfill, no link

`.tmp/s21/c9.mjs` (S20's, re-run), `c10.mjs`, `c11.mjs` via `.tmp/s21/single.mjs`.

| probe | base | S21 |
| --- | --- | --- |
| `f(new A(1))`, `f(new B(2))`, `f(new E(3))` → `o.toJSON()`, fieldless classes | `!invalid receiver E` ×2, `EJ3` | **`AJ1` / `BJ2` / `EJ3`** |
| same through a dynamic-`new` receiver | `!invalid receiver E` ×2 | **`AJ1` / `BJ2`** |
| `x.uniqB()` on an `A` — a member A does NOT declare | **`UB`** (B's body ran) | **throws** |
| same-shape classes, DIFFERENT field names (`{p}` / `{q}` / `{r}`) | last declarer's body, wrong field read | **`GA1` / `GB2` / `GC3`** |
| `o.toString()` on `A` / `B` (ToPrimitive ladder) | `AS1` / `!invalid receiver A` | **`AS1` / `BS2`** |
| DISTINCT-layout classes (1 / 2 / 3 fields) — control | already correct | identical |
| number `toString()`, string `toUpperCase()`, array `join()`, Map `get()`, `valueOf` via `+` — controls | — | identical, base and S21 (`c11-{base,new}.out`) |
| subclass inherits parent's method / subclass overrides — controls | `PM/PM`, `PM/QM` | identical |

#### 4. Provider-internal, the real polyfill, linked, fresh cache (`cacheHit=false`)

`.tmp/s21/diag-{base,new}.out` — the S20 diagnostic injected into the frozen
`Temporal` namespace, both labels built on this tree:

| probe | base | S21 |
| --- | --- | --- |
| `Duration.from("P1Y").toJSON()` | **`!invalid receiver`** | **`P1Y`** |
| `Duration.from("P1Y").toString()` | **`!toString() radix argument must be between 2 and 36`** | **`P1Y`** |
| `"" + Duration.from("P1Y")` | `!…radix…` | **`P1Y`** |
| `Duration.from({years:1})` → years / toJSON | `!invalid receiver` | **`1` / `P1Y`** |
| `new (ce("%Temporal.Duration%"))(1).toJSON()` (inline and via a const) | `!invalid receiver` ×2 | **`P1Y`** ×2 |
| `PlainDate.from("1976-11-18").toJSON()` | `!invalid receiver` | **`1976-11-18`** |
| `new Duration(1)` toJSON/toString (static `new` — control) | `P1Y` / `P1Y` | identical |
| `Object.getPrototypeOf(r) === Duration.prototype` | `false` | `false` (#6607 residual 2, unchanged) |

Both hand-off symptom texts are present on base and **absent** on S21.

#### 5. Regression sample — three families, 120 rows each

`--target standalone`, provider linked, sequential, FRESH `JS2WASM_TEMPORAL_CACHE`
per label (`cacheHit=false` on both prewarms), quickjs artifact + adapter
present, both labels on this tree. Provider bytes **3,291,080 (base) vs
3,302,429 (S21)**, +11,349 (+0.34 %) — the positive control that the change
reaches the linked artifact (the corpus A/B cannot provide one, §7).

| family | rows | base pass | S21 pass | fail→pass | **pass→fail** | leaks |
| --- | --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 120 | 92 | **94** | 2 | **0** | 0 |
| `built-ins/Temporal/Duration/**` | 120 | 64 | **65** | 1 | **0** | 0 |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 120 | 88 | **90** | 2 | **0** | 0 |
| total | 360 | 244 | **249** | **5** | **0** | **0** |

The five gains are all `…-propertybag-{calendar,timezone}-wrong-type` rows
(PlainDate `compare`/`from`, Duration `compare/relativeTo`, ZonedDateTime
`equals` ×2) — the shape where the polyfill reads a bag field and dispatches a
method on a value whose class is not static.

**Nine rows flipped between `compile_error` and a status, in both directions.**
Every one is a compile-budget artifact of the 15 s per-row cap. Re-run **solo at
60 s on both trees** they agree exactly, row for row, with identical error
messages (`.tmp/s21fam/solo-{base,new}.tsv`): six pass on both, three fail on
both (`PlainDate/from/argument-plaindatetime.js`,
`PlainDate/from/overflow-wrong-type.js`,
`ZonedDateTime/prototype/add/constrain-when-ambiguous-result.js`). The table
above already counts the solo verdicts on BOTH labels, which is why the base
column reads 92/64/88 rather than the in-sample 89/62/87.

Said plainly: this slice does **not** make consumer compiles slower — the S21
rows ran 1–3 s FASTER than base on the same files under the same load (a
narrower arm short-circuits earlier), which is why the CE drift moved mostly in
the improving direction. That is an observation from two runs, not a benchmark.

The `invalid receiver` text appears once on base and **zero** times on S21
across all 360 rows; `radix` appears in neither — in the sample both are
upstream of the row's reported error, which is why the provider-internal table
in §4 is the load-bearing evidence and the row counts are not.

#### 6. Must-not-move samples — 406 rows, per FILE, 0 flips

Both labels on this tree, diffed per file:

| sample | rows | flips |
| --- | --- | --- |
| `Object/keys` + `expressions/object` + `Reflect/{get,has}` | 140 | **0** |
| `Object/{entries,values,getOwnPropertyNames}` + `statements/for-in` | 146 | **0** |
| `language/expressions/call/**` + `built-ins/Object/prototype/**` | 120 | **0** |

The third sample was added for this slice because it exercises method dispatch
itself rather than the property paths the previous two cover.

#### 7. Order preservation

Corpus byte A/B — 42 modules × {gc, standalone}, 84 artifacts: **0 move on
either lane.** Expected, and a WEAK probe: the corpus has no module with two
same-layout classes declaring one name reached through an unknown receiver, so
it cannot show the change arriving anywhere. The provider byte delta in §5 is
the positive control. Equivalence gate at baseline: **22 failing / 1720
passing**.

#### 8. Gates

`typecheck`, `lint`, `check-loc-budget`, `check-func-budget`,
`check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`,
`check:speculative-rollback`, `check:issue-ids:against-main`,
`update-issues --check`, prettier — all green. The two **inherited** reds
handed over by S20 reproduce unchanged and are not from this slice:
`check:compiler-boundaries` → `inventory-valid-architecture-incomplete`, and
under `LOC_GATE_BASE=origin/main` the `src/runtime.ts` ceiling (19,822 vs
19,601) plus `buildImports` 308 > 300.

The id **#6608** was verified `UNASSIGNED` on `origin/issue-assignments`
(`claim-issue: OK — #6608 is unassigned (read origin/issue-assignments)`). The
allocate WRITE could not be taken: `--allocate` exits **6** (`open-PR id scan
FAILED … gh offline`), nothing reserved. GitHub pushes return 403 for every
lane today, so there is no branch or PR yet.

#### 9. Traps, carried forward and added to

All S11–S20 traps still bite. New:

- **A `ref.test`-per-class ladder is not a class dispatch.** Two readings —
  S20's hand-off, and the first reading of this slice — looked at a ladder that
  emits `ref.test $A / $B / $E` and concluded the class test was missing
  elsewhere. The test is there and it is the wrong test. The one-minute
  discriminator: give the classes DIFFERENT field shapes and watch the bug
  disappear (`c10.mjs`, rows 04–06 correct while 01–03 are wrong).
- **The same defect can point in opposite directions in one program.** `toJSON`
  answered the LAST declarer and `toString` the FIRST, which reads as two
  independent bugs and cost a detour into the extern-class resolver. Ladder
  ORDER, not cause, is what differs.
- **Look for the fix that already exists.** #4618 solved this, named the
  mechanism correctly in its own comment, and left the helper private in
  `index.ts`. Grepping for the *phenomenon* ("canonicaliz") rather than the
  *symptom* found it in one search and turned a design question into a move.
- **`biome check --write` is NOT this repo's formatter.** `npm run format` is
  prettier; `npm run lint` is `biome lint` only. One `biome check --write` on
  the changed files reflowed `index.ts` to 80 columns — a 6,000-line diff that
  looked like a merge accident. Recovered from the `.tmp` revert copies in
  seconds, *because they were taken at the first edit*.
- **A per-row 15 s cap invents status flips in BOTH directions.** Nine of the
  fourteen apparent flips here were budget artifacts; re-running them solo at
  60 s on both trees is not bookkeeping, it is the difference between
  "+5, 0 regressions" and "+11 with three regressions".

### Artifacts (S21)

`.tmp/s21/`, `.tmp/s21base/`, `.tmp/s21fam/`, `.tmp/s21mnm/` in
`/home/user/js2/.claude/worktrees/agent-ad35392e138689617`: the probes
`c9`–`c11` with their `-base`/`-new` outs, `diag-{base,new}.out`, the corpus
hashes `corpus-{base,new}.jsonl`, the per-chunk family TSVs
`{pd,du,zdt}-{base,new}.p{0,60}.tsv`, `solo-{base,new}.tsv`, the ten
must-not-move TSVs per label, the revert copies in `.tmp/s21base/`, and the
drivers `{single,dump,diag}.mjs`, `{famdiff,mnmdiff,buckets}.py`,
`{fam,mnm,solo}.sh`, `{family,solo,prewarm,corpus}.mts`.

### Acceptance criterion 4 — S21 update

**MET.** The wrong-class-method bucket moves: provider-internal,
`Duration.from("P1Y").toJSON()` and `.toString()` go from *invalid receiver* /
*radix argument must be between 2 and 36* to `P1Y`, and seven of the nineteen
provider probes flip from throwing to a correct answer. Over the 360-row
three-family sample that is **244 → 249**, with **0 legitimate `pass→fail`**,
**0 `__temporal_*` leaks**, **406** must-not-move rows flat per file across
three samples, both corpus lanes byte-identical and the equivalence gate at
baseline.

### Next top bucket after S21

With the wrong-class-method bucket retired, the residuals the S21 sample leaves
are, in order: `Test262Error: prototype Expected SameValue(«null», «[object
Function]»)` (7 rows across two line numbers — a prototype-descriptor read),
`TypeError: Object method called on null or undefined` (5), `Calling as
constructor … no TypeError thrown` (4), and the three PlainDate/ZonedDateTime
`compile_error` rows that survive a 60 s solo budget. The two structural
residuals named by #6608 — `__call_@@toPrimitive`'s ladder (same defect, its
entries carry no struct name) and same-shaped OBJECT LITERALS (no `__tag` to
test) — are unmeasured in this sample and are the cheapest next codegen slice.

#### 8b. One gate red was NOT inherited, and is fixed here

`check:compiler-boundaries` reported the new module as `unclassified-module` /
`unclassified-target` — a NEW red, caused by this slice, and easy to wave
through as "the boundaries gate was already red". It is not the same red.
`scripts/compiler-boundaries.json` now classifies
`src/codegen/class-arm-tag-guard.ts` with the entry of
`src/codegen/class-proto-lookup.ts`, the sibling whose mechanism it
generalizes, and the gate is back to the inherited
`inventory-valid-architecture-incomplete` with `inventoryValid: true`.

#### 10. #6606 is NOT this ladder — measured, not assumed

The hand-off asked whether S19's reduction A (`C[k]("A","B")` with a foldable
key shifting its arguments, #6606) is the same defect. It is not.
`.tmp/s21/c12-{base,new}.out`, seven probes, both labels on this tree: the
STATIC computed-key rows are **identical** on base and S21 — still
`"s2:function () { [native code] },A"`, i.e. the callee value arriving as
argument 0 — for both `C[k2](…)` and the literal-key `C["s2"](…)`, and for a
second class. Exactly one row moved, `o.m2("A","B")` through an `any`-typed
parameter, which is this slice's ladder. #6606 is a separate static
computed-member CALL lowering and keeps its own slice.

### S22 findings (2026-09-14) — the bucket was not a descriptor read; it was `Object.getPrototypeOf` of a FUNCTION, and the answer was `null`

Full write-up in
[#6609](6609-standalone-dynamic-callable-getprototypeof.md). Branch
`issue-5383-standalone-temporal-s22`, based on S21's FINAL tip `ebfe5aa8de`.
Every number below was measured on this tree, both labels, by file-copy revert
of the two changed files (`.tmp/s22base/`); nothing is inherited from S21's run
except the S21 row itself, which this slice's base run REPRODUCES exactly
(249/360 — see §5).

#### 1. The hand-off named the wrong assertion, and therefore the wrong mechanism

The brief described the 7 rows as `prop-desc`/`verifyProperty` rows:
"`Object.getOwnPropertyDescriptor(Temporal.X, "prototype")` … the S11-era
`gOPD(K, "prototype")` residual", with `"prototype" in K` and the `constructor`
back-link as the two suspects. **None of that is in these files.** All seven are
`built-ins/Temporal/*/builtin.js`, and their failing line is the THIRD
assertion:

```js
assert.sameValue(Object.getPrototypeOf(Temporal.PlainDate.compare),
  Function.prototype, "prototype");
```

The message in the bucket name is that assertion's third argument. The two the
brief predicted are the FOURTH assertion (`hasOwnProperty("prototype")`, which
**passes**) and nothing at all. Measured on base
(`.tmp/s22/link.mjs`, real provider, linked, fresh cache):
`isExtensible` → `true`, `Object.prototype.toString.call` → `[object Function]`,
`hasOwnProperty("prototype")` → `false`. Three of the four assertions were
already right; only `getPrototypeOf` answered `null`.

The one-minute discriminator was reading the error's VALUES rather than its
text: «null» vs «[object Function]». A `hasOwnProperty` assertion can only
report «true»/«false», so it could not have been the failing one.

#### 2. Root cause — the callable arm is compile-time-only

`object-get-prototype-of.ts` answers `Function` when `ctx.oracle.signatureOf`
proves the argument callable. Across a link every namespace member is `any`, so
there is no signature, and the query fell to the native `__getPrototypeOf` —
whose `$proto` walk decodes `$Object` receivers only. A closure carrier is not
one; the walk hit its terminal and returned `ref.null.extern`.

Fix: one runtime arm on the fallback path, standalone/WASI only —
`__is_callable(v) ? Function.prototype : __getPrototypeOf(v)`, with
`Function.prototype` compiled as the EXPRESSION so its identity is the same
object the static arm and the test's right-hand side both read.

**`__is_callable`, not `__typeof_function`** — the difference is the whole
safety argument. The boundary's `callable_kind` sets bit 1 ([[Construct]]) for a
provider-owned INSTANCE as well, which is exactly why `typeof <provider
instance>` still answers `"function"` (the standing residual). `typeof`'s
predicate masks `& 3` and would have handed every Temporal instance
`%Function.prototype%`; `__is_callable` masks `& 1`. Verified rather than
assumed: `link.mjs` row 19 (`gPO(PlainDate.from(…)) === null`) reads `true` on
both trees.

#### 3. Reduction — one standalone module, no polyfill, no link

`.tmp/s22/{c1,c2,c3}.mjs` via `.tmp/s22/single.mjs`.

| probe | base | S22 |
| --- | --- | --- |
| `gPO(f)` through an `any` param, `f` a function decl | **`null`** | **`Function.prototype`** |
| `gPO(C.prototype.m)` through an `any` param | `false` | **`true`** |
| `gPO(registry["%m%"])` (dynamic lookup) | `false` (`null`) | **`true`** |
| `gPO(<arrow>)`, `gPO(<fn expr>)`, `gPO(C.s)`, `gPO(lit.m)`, `gPO(Math.max)` — static arms | already `true` | identical |
| `gPO({})`, `gPO([])`, `gPO(new C())` — STATIC receivers | `true` | identical |
| array / string / number / Map / instance through an `any` param — 10 controls | `null` | identical (`c3-{base,new}.out`) |
| `gPO(<top-level fn DECL>) === Function.prototype` | `false` | `false` (residual, §7) |
| `gPO(<class value>) === Function.prototype` | `false` | `false` (by design) |

#### 4. The real polyfill, linked, consumer-side, fresh cache (`cacheHit=false`)

`.tmp/s22/link.mjs`, 20 probes, both labels built on this tree. This is the
CONSUMER side — where the test262 rows actually run — not the provider-internal
diagnostic S19–S21 used.

| probe | base | S22 |
| --- | --- | --- |
| `gPO(Temporal.PlainDate.compare) === Function.prototype` | **false** | **true** |
| same for `PlainDate.from`, `Duration.compare`, `Duration.from`, `Duration.prototype.abs`, `ZonedDateTime.prototype.add`, `…equals` | **false** ×6 | **true** ×6 |
| `gPO(Temporal.PlainDate.compare) === null` | **true** | **false** |
| `isExtensible` / `O.p.toString.call` / `hasOwnProperty("prototype")` — the row's other three assertions | `true` / `[object Function]` / `false` | identical |
| `gPO(Temporal.PlainDate.prototype) === Object.prototype` | `true` | identical |
| `gPO(Temporal.PlainDate) === Function.prototype` (class value) | `false` | identical (residual) |
| `gPO(PlainDate.from("1976-11-18")) === PlainDate.prototype` / `=== null` | `false` / `true` | identical — the instance is NOT claimed |
| `typeof Temporal.PlainDate.compare` / `typeof <instance>` | `function` / `function` | identical (the `typeof` residual is untouched) |
| `gPO({})`, `gPO([])` in the consumer | `true` | identical |

Consumer artifact **311,806 → 312,638 bytes (+832)**; the provider artifact is
byte-identical at 3,302,429 (the polyfill's own `getPrototypeOf` calls are all
statically provable, so it never reaches the new arm). The consumer delta is the
positive control that the change arrives where the rows are.

#### 5. Regression sample — three families, 120 rows each

`--target standalone`, provider linked, sequential, FRESH `JS2WASM_TEMPORAL_CACHE`
per label (`cacheHit=false` on both prewarms), quickjs artifact + adapter present
as real files, both labels on this tree.

| family | rows | base pass | S22 pass | fail→pass | **pass→fail** | leaks |
| --- | --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 120 | 94 | **96** | 2 | **0** | 0 |
| `built-ins/Temporal/Duration/**` | 120 | 65 | **68** | 3 | **0** | 0 |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 120 | 90 | **92** | 2 | **0** | 0 |
| total | 360 | **249** | **256** | **7** | **0** | **0** |

The seven gains are exactly the seven `builtin.js` rows. The
`prototype Expected SameValue` text appears **7 times on base and 0 times on
S22** across all 360 rows — the bucket is retired, not displaced.

The base column reads 249, which REPRODUCES S21's reported row on an
independently prewarmed cache. That is the only cross-slice number here and it
was re-measured, not copied.

**Twenty-one rows flipped between `compile_error` and a status, in both
directions** — more than S21's nine, and the new label's in-sample CE count was
higher (PlainDate 11 vs 6). Re-run **solo at 60 s on both trees** all 21 agree
**row for row, with identical error messages** (`.tmp/s22fam/solo-{base,new}.{a,b}.tsv`,
0 disagreements): 12 pass on both, 9 fail on both. The table above counts the
solo verdict on BOTH labels, which is why base reads 94/65/90 rather than the
in-sample 92/62/89. Every row's solo compile time is 13.5–19.7 s against a 15 s
sampled budget — i.e. this family sits ON the cap, and which side of it a row
lands on is noise. Two runs are not a benchmark, but across the 21 the two
labels' solo times differ by −1.4 s to +3.0 s with no consistent sign.

#### 6. Must-not-move samples — 692 rows, per FILE, 0 flips

Both labels on this tree, diffed per file (`.tmp/s22/mnmdiff.out`):

| sample | rows | flips |
| --- | --- | --- |
| `built-ins/Object/getOwnPropertyDescriptor/**` | 150 | **0** |
| `built-ins/Object/defineProperty/**` | 150 | **0** |
| `language/statements/class/**` | 150 | **0** |
| `Object/keys` + `expressions/object` + `Reflect/{get,has}` | 121 | **0** |
| `Object/{entries,values,getOwnPropertyNames}` + `statements/for-in` | 121 | **0** |

The first three were added for this slice because it touches the prototype half
of the MOP; the descriptor samples are the ones that would show a
`%Function.prototype%` singleton leaking into a descriptor answer.

#### 7. Order preservation

Corpus byte A/B — 42 modules × {gc, standalone}, 84 artifacts: **0 move on
either lane.** Expected, and a WEAK probe for the same reason S21's was: the
corpus has no module that asks `Object.getPrototypeOf` about a value whose
callability is only known at runtime, so it cannot show the change arriving
anywhere. The +832-byte consumer delta in §4 is the positive control. The arm is
gated on `ctx.standalone || ctx.wasi` AND on reaching the fallback (every static
arm declined), so the gc lane cannot reach it and a module whose `gPO` arguments
are all provable never pays. Equivalence gate at baseline: **22 failing / 1720
passing**.

#### 8. Gates

`typecheck`, `lint`, prettier, `check-loc-budget`, `check-func-budget`,
`check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`,
`check:speculative-rollback`, `check:issue-ids:against-main`,
`update-issues --check` — all green. **No new budget grant was needed**: neither
changed file crosses a ceiling on either base. The inherited reds handed over by
S21 reproduce unchanged and are not from this slice:
`check:compiler-boundaries` → `inventory-valid-architecture-incomplete`, and
under `LOC_GATE_BASE=origin/main` `src/runtime.ts` 19,822 > 19,601 plus
`buildImports` 308 > 300.

The id **#6609** was verified `UNASSIGNED` on `origin/issue-assignments`
(`claim-issue: OK — #6609 is unassigned (read origin/issue-assignments)`). The
allocate WRITE could not be taken: `--allocate` exits **6**
(`open-PR id scan FAILED … gh offline`), nothing reserved — and its `--dry-run`
preview offered **#6600**, which THIS BRANCH ALREADY USES
(`tests/issue-6600-standalone-link-reverse-peer-read.test.ts`, landed in S17).
With `gh` offline the scan cannot see the stack's own unmerged ids, so the
dry-run preview is not a safe id on a stacked branch; the brief's
"6474–6608 are TAKEN" is what kept this slice off a collision. GitHub pushes
return 403 for every lane today, so there is no branch or PR yet.

#### 9. Traps, carried forward and added to

All S11–S21 traps still bite. New:

- **Read the assertion's VALUES, not its message.** The bucket is named after
  `assert.sameValue`'s third argument, which here is the string `"prototype"` —
  and two different assertions in the same file mention "prototype". «null» vs
  «[object Function]» identifies which one in one glance; the message alone sent
  the hand-off (and the first ten minutes of this slice) at a descriptor read
  that does not exist in these files.
- **A predicate that is nearly right is the dangerous kind.** `__typeof_function`
  and `__is_callable` differ by one bit and agree on every genuine closure. That
  one bit is the ONLY thing standing between this fix and handing
  `%Function.prototype%` to every provider-owned Temporal instance — silently,
  because those rows already fail for other reasons and would not have
  reported it. The residual that made this a hazard (`typeof <instance>` ===
  `"function"`) was already written down; what was missing was checking whether
  the predicate about to be reused was the one that carries it.
- **Capture the revert copies AND the new copies.** `.tmp/s22base/` was taken at
  the first edit as the rules say — and then the first A/B flip overwrote the
  NEW files, which existed only in the editor's history. Re-applying cost ten
  minutes. A file-copy A/B needs BOTH ends on disk before the first flip.
- **A family that sits ON the compile budget invents flips at ~6 % of rows.**
  Twenty-one of 360 here (S21 saw nine). Every one was noise, in both
  directions, and the in-sample numbers alone would have read as "+7 with two
  regressions and five new compile errors". The solo re-run at 60 s on BOTH
  trees is the measurement; the sampled run is a screen.

### Artifacts (S22)

`.tmp/s22/`, `.tmp/s22base/`, `.tmp/s22fam/`, `.tmp/s22mnm/` in
`/home/user/js2/.claude/worktrees/agent-a9d4f1d7c86f72460`: the probes `c1`–`c3`
with their `-base`/`-new` outs, `link.mjs` with its two label runs, the corpus
hashes `corpus-{base,new}.jsonl`, the per-chunk family TSVs
`{pd,du,zdt}-{base,new}.p{0,60}.tsv`, `solo-{base,new}.{a,b}.tsv`, the 22
must-not-move TSVs per label, the revert copies in `.tmp/s22base/` and the new
copies in `.tmp/s22/*.new.ts`, and the drivers `{single,link}.mjs`,
`{famdiff,famdiff2,mnmdiff}.py`, `{fam,mnm2,solo2,mk}.sh`,
`{family,solo,prewarm,corpus}.mts`.

### Acceptance criterion 4 — S22 update

**MET.** The `prototype Expected SameValue(«null», «[object Function]»)` bucket
moves from 7 rows to **0**: consumer-side, `Object.getPrototypeOf(
Temporal.PlainDate.compare)` goes from `null` to `Function.prototype`, and all
seven `builtin.js` rows flip fail→pass. Over the 360-row three-family sample
that is **249 → 256**, with **0 legitimate `pass→fail`**, **0 `__temporal_*`
leaks**, **692** must-not-move rows flat per file across five samples, both
corpus lanes byte-identical and the equivalence gate at baseline.

### Next top bucket after S22

Re-counted over the 360 rows on the new label, with the solo verdicts
substituted (so the CE-capped rows are counted where they actually land):

| bucket | rows |
| --- | --- |
| `TypeError: called value is not a function` | **9** |
| `TypeError: expected a string, not null` | 8 |
| `TypeError: Object method called on null or undefined` | 6 |
| `Test262Error: Expected a RangeError but got a undefined` | 6 |
| `RuntimeError: dereferencing a null pointer in __closure_N()` | 5 |
| `Test262Error: Calling as constructor … Expected a TypeError` | 4 |
| `Test262Error: property bag where milliseconds balance into seconds` | 4 |
| `TypeError: Proxy get trap is not callable` | 4 |

Two things worth saying plainly. **`called value is not a function` is the top
bucket again at 9** — S18/S20/S21 each retired one of its causes, so what is
left is a fourth, not a relapse; it needs its own census before anyone assumes
which. And the three `calendar-temporal-object` rows (`PlainDate/compare`,
`Duration/compare`, `ZonedDateTime/prototype/equals`) are the cheapest next
target: one file name, three families, all three answering
`Object method called on null or undefined`, and all three invisible in a
sampled run because the 15 s cap scores them `compile_error`.

Structurally, #6608's two named residuals (the `__call_@@toPrimitive` ladder's
unnamed entries and same-shaped OBJECT LITERALS) remain the cheapest codegen
slice, and this slice adds two of its own: `gPO(<top-level function
declaration>)` answers a different object from `Function.prototype`, and
`gPO(<class value>)` answers neither.

### S23 findings (2026-09-14) — the fourth cause is ONE missing member on ONE receiver brand: `Number.prototype.toPrecision` on a number PRIMITIVE

Full write-up in
[#6610](6610-standalone-number-primitive-dynamic-method-call.md). Branch
`issue-5383-standalone-temporal-s23`, based on S22's FINAL tip `cd4a115386`.
Every number below was measured on this tree, both labels, by file-copy revert
of the three changed files (`.tmp/s23base/`; the new copies in
`.tmp/s23/*.new.ts`).

#### 1. Census — all nine rows, one emitter site, one property name

The brief asked which of `resolved-callee-guard.ts`'s sites fires. Instrumenting
every emitter of `called value is not a function` with a distinct marker
(the guard's four splice points, plus `calls.ts`'s `wantIsCallableGuard`,
`new-super.ts` and `fnctor-missing-method-dispatch.ts`) answered it in one run:

```
all 9 rows → TypeError: called value is not a function [RCG-null-PROTO-TERMINAL]
```

— `buildProtoNamedMethodMissArm`'s terminal miss, ABSENT (null) arm, inside
`__extern_method_call`. No other site fires for any row.

A second instrumentation pass replaced that site's constant message with the
NAME local (param 1), which is the whole census:

```
all 9 rows → TypeError: toPrecision
```

One property, one receiver brand. The nine rows split across
`Duration/compare` (5), `Duration/from` (1), `ZonedDateTime/prototype/add` (2)
and `…/day` (1), and the shared input is large-magnitude arithmetic: the
polyfill's exact-arithmetic helper does

```js
var o = n.toPrecision(a);
return { div: r * Number.parseInt(o.slice(0, a - t), 10), … };
```

on a number PRIMITIVE reached through an `any` parameter.

**Which clauses of the hand-off were wrong.** The brief offered three plausible
fourth causes from S19's #6606 — the foldable-key `C[k]("A","B")` arg shift, the
`o[k](a)` → `ref.null.extern` return, and the class-derived method VALUE — plus
the `typeof <provider instance>` residual. **None of them is this bucket.** All
four are about resolving a CALLEE through a dynamic key or a class value; this
is a receiver-brand routing gap with a literal member name, and the census
settles it before any of those hypotheses costs a probe. The brief's framing
"instrument the sites as S18 did" was exactly right; its candidate list was not.

#### 2. Root cause

`__extern_method_call` dispatches `ref.test $Object` → resolve-and-apply, ELSE
the vec / closure-prop arms, ELSE the terminal miss, whose consult is the
#4160/#4176 proto-index store — the table of members a MODULE installed on a
builtin prototype. A bare number primitive (`$box_number` / i31) is none of the
first three, and `Number.prototype`'s BUILTIN members are not in the store, so
the consult answered null and #4221's absent-callee guard turned that into the
TypeError.

The answer machinery was never missing. On the same base:

| probe (`.tmp/s23/c1.mjs`, one module, no polyfill, no link) | base |
| --- | --- |
| `(1234.5678).toPrecision(3)` — static receiver | `"1.23e+3"` |
| `f(x,p){return x.toPrecision(p)}; f(1234.5678,3)` | **TypeError** |
| `Number.prototype["toPrecision"]` through an `any` binding | `"function"` |
| that value `.call(1234.5678, 3)` | **`"1.23e+3"`, PRIMITIVE `this`** |

So both halves of the route already work; only the routing for one receiver
brand was absent.

#### 3. Fix — `src/codegen/number-primitive-method-call.ts`

A `block` + `br_if 0` arm unshifted onto `__extern_method_call`, in the
`native-proto-method-call.ts` / `ta-dyn-method-call.ts` shape:
`__typeof_number(recv)` → decline if the proto-index store answers (a module's
own `Number.prototype` write, §10.5) → `__extern_get(%Number.prototype%, name)`
→ decline if null → `__apply_closure(m, recv, args)` with the primitive as
`this`.

Two ordering facts, both measured rather than reasoned:

- The singleton must be built **after** `__protoidx_companion` exists (so not
  during the source scan) and **before** `unshiftExternGetProtoMethodArm` (so the
  brand is in that pass's minted/seeded set). It therefore lives in its own
  `prepareNumberPrimitiveMethodCallArm` pass between the two. **The first cut got
  the second half wrong and measured as a complete no-op**: the arm was emitted,
  the receiver test passed (verified by splicing a probe throw into the arm), and
  resolution answered null on every call.
- The arm must also take #4619's `ensureWrapperProtoDynamicMember` mint.
  `__extern_get`'s `$NativeProto` ladder is assembled from MINTED members, and a
  module that only CALLS `x.toPrecision(p)` never names
  `Number.prototype.toPrecision`.

#### 4. The one way a prepended arm can be WRONG, and it fired

A member the MODULE installs on `Number.prototype` must outrank the builtin
(§10.5). Without the store consult, `.tmp/s23/c5.mjs` measured
`Number.prototype.toPrecision = f; x.toPrecision(2)` going from `"user2"` on
base to the builtin's `"5.0"` — a wrong answer where the base was right. That is
the only regression this slice produced, it was produced by the obvious version
of the arm, and it is caught only by a probe that asserts the OVERRIDE, not the
builtin. It has its own module in `tests/issue-6610-*.test.ts`.

#### 5. Reduction — one standalone module (`.tmp/s23/c8.mjs`, both labels)

| probe | base | S23 |
| --- | --- | --- |
| `f(1234.5678, 3)` | threw | **`"1.23e+3"`** |
| `f0(1234.5678)` — no argument (§21.1.3.5 step 2) | threw | **`"1234.5678"`** |
| `f(NaN, 3)` — non-finite before the range check (step 4) | threw | **`"NaN"`** |
| `f(-1234.5678, 5)` | threw | **`"-1234.6"`** |
| `f(0.0000001234, 3)` — `e < -6` | threw | **`"1.23e-7"`** |
| `f(7, 2)` — i31 receiver | threw | **`"7.0"`** |
| `f(new Number(1234.5678), 3)` — WRAPPER | threw | **`"1.23e+3"`** |
| `f(1, 0)` — out of range (step 5) | **TypeError** | **RangeError** |
| `(1234.5678).toPrecision(3)` static · `"abc"`/`true` receiver · `(5).nosuch()` | — | identical |

The wrapper row is not this arm (`__typeof_number` is false for a `$Object`); it
is the #4619 mint reaching `__extern_get`'s ladder, which the wrapper's existing
`$Object` route already consults.

`toFixed` / `toExponential` were tried in the member list and measured: they
resolve to `refusalBodyFallback`'s stand-in and answer
`"Number.prototype.toFixed is not yet implemented in --target standalone"` — a
different TypeError, not a working call. Only `toPrecision` has a reflective
native body (#5269 J-1), so the list is exactly one name and the other two are
left on their base behaviour.

#### 6. The real polyfill, linked, fresh cache (`cacheHit=false` on both prewarms)

`.tmp/s23/link23.mjs`, 12 probes, both labels built on this tree.

| probe | base | S23 |
| --- | --- | --- |
| `Duration.compare({days: 104249991374, …}, new Duration())` | TypeError | **`1`** |
| `Duration.compare({milliseconds: 4.5e18, microseconds: 4.5e21}, same)` | TypeError | **`0`** |
| `Duration.compare(d1, d2, {relativeTo: "1970-01-01T00:00-00:45:00[-00:45]"})` | TypeError | **`0`** |
| `new ZonedDateTime(86400000000001n, "-00:02").day` | TypeError | **`1`** |
| `new ZonedDateTime(1580511600000000000n, "-08:00").add({months: 1})` | TypeError | **answers** |
| `PlainDate.from(…).toString()` · `Duration.from("P1Y").toJSON()` · `typeof PlainDate.compare` · `gPO(PlainDate.compare) === Function.prototype` | — | identical |

Provider artifact **3,302,429 → 3,307,526 bytes (+5,097)**; consumer
**259,458 → 273,050 (+13,592)**. Both are positive controls that the change
arrives on both sides of the link — the provider is where the polyfill's own
`n.toPrecision(k)` lives.

#### 7. Regression sample — three families, 120 rows each

`--target standalone`, provider linked, sequential, FRESH
`JS2WASM_TEMPORAL_CACHE` per label (`cacheHit=false` on both prewarms), quickjs
artifact + adapter present as real files, both labels on this tree.

| family | rows | base pass | S23 pass | fail→pass | **pass→fail** | leaks |
| --- | --- | --- | --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 120 | 97 | 97 | 0 | **0** | 0 |
| `built-ins/Temporal/Duration/**` | 120 | 68 | **77** | 9 | **0** | 0 |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 120 | 93 | **97** | 4 | **0** | 0 |
| total | 360 | **258** | **271** | **13** | **0** | **0** |

The `called value is not a function` text appears **10 times on base and 0 times
on S23** across all 360 rows — retired, not displaced. (Ten, not nine: the tenth
row, `Duration/from/argument-existing-object.js`, was scored `compile_error`
under the 15 s cap in the post-S22 census and only its solo re-run shows the
text. It flips fail→pass here too.)

**Thirty rows needed a solo re-run** and every one was taken at 60 s on BOTH
trees: the 16 CE↔status flips, plus the 14 rows that scored `compile_error` on
BOTH labels — those cannot flip by construction, but leaving them capped
understates both columns and makes the base incomparable with S22's row. All 30
agree **row for row, with identical error messages** (0 status disagreements,
0 message disagreements), so the table above has **no `compile_error` cell at
all**. Per-row solo compile times are 13.2–24.6 s (base) and 13.4–26.5 s (S23)
against the 15 s sampled budget — this family still sits ON the cap.

The base column reads **258**, where S22 reported **256** for the same tree. The
difference is method, not drift: S22 solo-corrected 21 rows, this slice 30, and
the 9 extra are all in the both-CE set (2 of them pass solo). The delta is
unaffected — both columns were measured here, the same way, on the same tree.

#### 8. Must-not-move samples — 474 rows, per FILE, 0 flips

Both labels on this tree, diffed per file (`.tmp/s23/mnmdiff.out`):

| sample | rows | flips |
| --- | --- | --- |
| `Object/keys` + `expressions/object` + `Reflect/{get,has}` | 101 | **0** |
| `Object/{entries,values,getOwnPropertyNames}` + `statements/for-in` | 102 | **0** |
| `language/expressions/call/**` (first 150) | 92 | **0** |
| `language/expressions/new/**` (first 100) | 59 | **0** |
| `built-ins/Number/prototype/**` | 120 | **0** |

The call/new samples are there because this touches call dispatch; the
`Number/prototype` sample was added for this slice because it touches
`Number.prototype`'s member ladder. (The first two roots yield fewer files than
their limits — 92 and 59 — because those trees are smaller than the cap.)

#### 9. Order preservation

Corpus byte A/B — 42 modules × {gc, standalone}, 84 artifacts: **0 move on
either lane.** Expected and WEAK for the same reason S21's and S22's were: no
corpus module calls a Number format method through a dynamic receiver, so the
demand scan never fires, and the gc lane cannot reach the arm at all
(`ctx.standalone`). The §6 byte deltas are the positive control. Equivalence
gate at baseline: **22 failing / 1720 passing**.

#### 10. Gates

`typecheck`, `lint`, prettier, `check-loc-budget`, `check-func-budget`,
`check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`,
`check:speculative-rollback`, `check:issue-ids:against-main`, `check:issues` —
all green. **No new budget grant was needed.** The new module is classified in
`scripts/compiler-boundaries.json` (`unmigrated` / `mixed-needs-split` /
`backend-wasmgc`, matching its neighbours); the gate reports
`inventoryValid: true` and fails only on the inherited
`inventory-valid-architecture-incomplete`. Under `LOC_GATE_BASE=origin/main` the
two inherited reds reproduce unchanged and are not from this slice:
`src/runtime.ts` 19,822 > 19,601 and `buildImports` 308 > 300.

The id **#6610** was verified `UNASSIGNED` on `origin/issue-assignments`
(`claim-issue: OK — #6610 is unassigned (read origin/issue-assignments)`). The
allocate WRITE could not be taken — `--allocate` exits **6**
(`open-PR id scan FAILED … gh offline`), nothing reserved — and its `--dry-run`
preview again offered **#6600**, which this branch has used since S17. That is
the same trap S22 recorded, one slice later, unchanged: **with `gh` offline the
dry-run preview is not a safe id on a stacked branch.** GitHub pushes return 403
for every lane, so there is no branch or PR yet; `.tmp/pr-body.md` is ready.

#### 11. Traps, carried forward and added to

All S11–S22 traps still bite. New:

- **Instrument the emitter, then instrument the NAME.** Two five-minute
  instrumentation passes — one distinguishing the seven emitters of the message,
  one replacing the message with `__extern_method_call`'s name parameter —
  reduced a nine-row bucket to a single property name before any hypothesis was
  tested. The hand-off's three candidate causes were all plausible and all
  wrong; none survived contact with the marker.
- **A finalize-time arm has TWO ordering constraints, and one of them is
  invisible.** "Build it late enough that the runtime exists" is the obvious one.
  "Build it early enough that the pass which assembles the lookup table can see
  your brand" is not, and getting it wrong produces a fix that emits, passes its
  own receiver test, and answers null — i.e. measures as a perfect no-op with no
  error anywhere. The probe that found it was a throw spliced into the arm; a
  byte diff would have shown the arm present and told you nothing.
- **When a prepended arm answers a builtin, ask what the MODULE may have put
  there.** The proto-index store exists precisely because a module can install
  its own `Number.prototype.toPrecision`, and the terminal miss this arm runs
  ahead of consults it. Prepending without that consult is a silent
  wrong-answer, and the probe that catches it has to assert the user's value —
  a probe asserting "the call works" passes either way.
- **A module-local control is only valid in the module you measured it in.**
  `(1234.5678).toPrecision(3)` answers correctly in a module without a
  `class C { toPrecision(p) }`, and TRAPS in a module with one — identically on
  both trees. The first draft of this slice's test asserted the correct value
  and failed on the branch for a reason that had nothing to do with the branch.
  Measure the control in the exact module the test compiles.

### Artifacts (S23)

`.tmp/s23/`, `.tmp/s23base/`, `.tmp/s23fam/`, `.tmp/s23mnm/` in
`/home/user/js2/.claude/worktrees/agent-a06a4b559afff05cd`: probes `c1`–`c8`
with their `-base`/`-new` outs, `link23.mjs` / `link24.mjs` with both label runs,
the corpus hashes `corpus-{base,new}.jsonl`, the per-chunk family TSVs
`{pd,du,zdt}-{base,new}.p{0,60}.tsv`, `solo-{base,new}.{a,b}.tsv`,
`soloce-{base,new}.{a,b}.tsv`, `nine-{base,instr,instr2,new}.tsv`, the 22
must-not-move TSVs per label, the revert copies in `.tmp/s23base/` and the new
copies in `.tmp/s23/*.new.ts`, and the drivers `{single,link23,link24}.mjs`,
`{flips,famdiff3,mnmdiff}.py`, `{fam,nine,solo3,soloce,mnm2}.sh`,
`{family,solo,prewarm,corpus}.mts`.

### Acceptance criterion 4 — S23 update

**MET.** The `TypeError: called value is not a function` bucket moves from
**10 rows to 0** — the whole of it, not a share. Over the 360-row three-family
sample that is **258 → 271**, with **0 legitimate `pass→fail`**, **0
`__temporal_*` leaks**, **474** must-not-move rows flat per file across five
samples, both corpus lanes byte-identical, and the equivalence gate at baseline.

### Next top bucket after S23

Re-counted over the 360 rows on the new label, with the solo verdicts
substituted (so no row is scored `compile_error`):

| bucket | rows |
| --- | --- |
| `TypeError: expected a string, not null` | **9** |
| `TypeError: Object method called on null or undefined` | 6 |
| `Test262Error: Calling as constructor … Expected a TypeError` | 4 |
| `TypeError: Proxy get trap is not callable` | 4 |
| `TypeError: Cannot access property on null or undefined at 164:22` | 4 |
| `RuntimeError: dereferencing a null pointer in __closure_N()` | 4 |
| `TypeError: Cannot read properties of undefined (reading 'apply'/'abs')` | 4 |
| `Test262Error: Built-in objects must be extensible.` | 2 |

(89 non-pass rows in total; a further 13 are bare `Test262Error:` assertion
texts with no shared message, which is a grab-bag rather than a bucket.)

`called value is not a function` is **gone from the list for the first time in
six slices**. The top bucket is now `expected a string, not null` at 9.

The `calendar-temporal-object` family the S22 hand-off flagged as the cheap trio
is **four rows, not three** — `PlainDate/compare`, `PlainDate/from`,
`Duration/compare` and `ZonedDateTime/prototype/equals` — and all four answer the
SAME error, `TypeError: Object method called on null or undefined`. That is four
of the six rows in the second bucket, so one cause plausibly retires two thirds
of it. All four were scored `compile_error` under the 15 s cap in the sampled
run and only show their real verdict solo, which is why the count has been wrong
twice; the solo re-runs here agree on both labels, so it is a real target.

Two residuals this slice adds, both reduced and neither fixed: `x.toFixed(d)` /
`x.toExponential(d)` through an `any` receiver still throw, because their
REFLECTIVE bodies refuse (`number-proto-format.ts` answers `toPrecision` only) —
wiring §21.1.3.2/§21.1.3.3 there would make the member list a three-name
constant and cost nothing else. And `x.toString(radix)` through an `any`
receiver still throws while `x.toString()` does not.

### S24 findings (2026-09-14) — the fifth cause is an ARITY CEILING, not a lookup: `new <foreign ctor>(…)` above eight arguments answered null and never evaluated its arguments. 271 → 300

Full write-up in
[#6611](6611-standalone-dynamic-new-arity-above-eight.md). Branch
`issue-5383-standalone-temporal-s24b`, based on S23's tip; the code is the
salvaged S24 commit `8d11a10336`.

**This slice was interrupted.** The container restarted mid-measurement and
killed the S24 lane. Salvaged from its worktree, unchanged: the WIP fix commit
(`src/codegen/native-construct.ts`, `src/codegen/expressions/new-super.ts`, both
byte-verified against its validated copies), the #6611 issue file, its probes,
and four of six family halves. Re-measured here: `du-base` p60, `zdt-base` p0
and p60, and every solo correction on both trees. The base column below was
produced on THIS tree by file-copy revert (`.tmp/s24base/`), and it lands on
**271** — S23's number, independently reproduced, which is the strongest
available check that the salvage did not disturb the base.

#### 1. The brief's bucket and the cause are the same thing, one frame apart

The brief asked for the 9-row `TypeError: expected a string, not null` bucket.
That message is the POLYFILL's own guard, several frames downstream: with ten
arguments `new Temporal.Duration(…)` evaluated to `null`, and the polyfill
carried the null into `ToTemporalDuration`, whose string branch called
`RequireString(null)`. So the bucket is a symptom of the construct, not a
separate mechanism — and it is **fully retired**:

| `expected a string, not null` | base | new |
| --- | --- | --- |
| rows in the three-family sample | **9** | **0** |

Seven of the nine flip to `pass`. The other two
(`ZonedDateTime/prototype/add/math-order-of-operations-add-{constrain,none}`)
stop producing a null, construct correctly, and then fail LATER and
differently — `TypeError: Cannot read properties of undefined (reading
'equals')`. That is a new, separate residual, not this one persisting.

#### 2. Root cause — the ceiling was the WRONG CONSTANT

`tryCompileNativeConstructFromValue` declined above
`MAX_NATIVE_CONSTRUCT_ARITY` (8). That constant is not a property of the
construct driver: it is the range over which `closure-exports.ts` emits the
`__call_fn_method_<N>` dispatcher family (`/^__call_fn_method_([0-8])$/`), used
only by the driver's ordinary module-local-closure tail. Every other arm —
class, link-boundary, proxy, runtime-marker — already packs an argument VECTOR
and is arity-generic.

Declining is not a graceful fallback. For a callee the compiling module does not
own — every linked-provider class — `emitDynamicNewFallback` has no candidate
classes to tag-dispatch on, so the site lands on the pre-existing
`ref.null.extern` no-match base, and that base is emitted *instead of* the
argument evaluation. The arguments are dropped too. A module-local class takes
the per-class tag-dispatch fallback and is correct at any arity, which is why no
single-module probe ever showed this.

`Temporal.Duration` takes **ten** parameters; `Temporal.PlainDateTime` takes
nine. The corpus's most ordinary spelling sat one argument past the ceiling.

Same signature as S20's #6607 (`new (<call>)(…)`), one ceiling further out.

#### 3. Fix

`MAX_DYNAMIC_CONSTRUCT_ARITY = 16` becomes the call-site admission ceiling and
the fill/scan bound; `MAX_NATIVE_CONSTRUCT_ARITY = 8` keeps its real meaning.
Above 8 the ordinary tail packs an argv and calls `__apply_closure` — the same
terminal the runtime-marker arm already used. Gated strictly on
`arity > MAX_NATIVE_CONSTRUCT_ARITY`, so the long-standing
`methodCallIdx === undefined` case at arities ≤ 8 (a driver reserved only for
Proxy → admitted-JS construction) keeps its exact previous null tail.

#### 4. Three-family sample — 120 rows each, standalone, provider linked, sequential, fresh cache, solo-corrected

| family | rows | base | new | Δ | pass→fail | fail→pass | `compile_error` cells |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `PlainDate/**` | 120 | 97 | 101 | **+4** | 0 | 4 | 0 |
| `Duration/**` | 120 | 77 | 97 | **+20** | 0 | 20 | 0 |
| `ZonedDateTime/prototype/**` | 120 | 97 | 102 | **+5** | 0 | 5 | 0 |
| **total** | **360** | **271** | **300** | **+29** | **0** | **29** | **0** |

`__temporal_*` host-import leaks: **0**.

**The partial `pd` table the dead lane left behind was noise, and it is worth
saying why.** Its first-half PlainDate rows read base 48 / new 46 — a two-row
apparent REGRESSION, which is what made this the first thing to re-check. Every
one of those flips was `pass → compile_error` with a `compilation timeout
(15.0–15.5 s)` detail, against a 15 s batch budget; the base column carried its
own mirror artifacts (`compile_error → fail`). This family sits ON the cap, so
at batch budget the cap decides the cell, not the compiler. Solo-corrected at
60 s, PlainDate is 97 → 101 and the sample contains **no `compile_error` cell on
either tree and no pass→fail row at all**. A batch-budget delta on this family
is not a measurement.

#### 5. Controls — what did NOT move, and the byte story

**Must-not-move samples, per file, base vs branch: 331 rows, 0 flips.**

| sample | rows | flips |
| --- | --- | --- |
| `Object/keys` + `language/expressions/object` + `Reflect/{get,has}` | 101 | 0 |
| `Object/{entries,values,getOwnPropertyNames}` + `statements/for-in` | 121 | 0 |
| `language/expressions/new/**` + `Function/prototype/apply/**` + `Reflect/construct/**` | 109 | 0 |

The third group is the one this slice owes: it touches construct arity, so
`new`, `apply` and `Reflect.construct` are where an arity change would surface.

**Corpus byte A/B — 42 modules × {gc, standalone} = 84 artifacts, 0 move.**
That is a NULL control, and saying only "0 moved" would overstate it: no module
in that corpus has a `new <runtime ctor value>(…)` site above arity 8, so the
corpus can only show the change is not a broad perturbation. It cannot show the
change does anything. The evidence that it does is a separate, deliberate byte
control (`.tmp/s24/bytes6489.mts`), one linked pair, three consumers:

| artifact | base | branch | |
| --- | --- | --- | --- |
| provider (`Wide`/`Narrow` classes) | `5989617a8d3a63a1` 155,718 B | **identical** | the PRODUCING side never moves |
| consumer with an above-8 dynamic `new` | `1f9219d64ce45c52` 132,000 B | `12ba8ca9b7256c5b` 134,060 B | **+2,060 B** — the only thing that moves |
| consumer with an arity-**8** dynamic `new` | `21b7a98164941aa7` 133,803 B | **identical** | the gate on `arity > MAX_NATIVE_CONSTRUCT_ARITY` holds |
| consumer with no dynamic `new` | `3d67dc7d87ef1933` 48,980 B | **identical** | |

The real provider says the same thing at scale: the compiled
`@js-temporal/polyfill` artifact is **3,307,526 B with the same cache key
`a11c84e5…` under BOTH labels**. The fix is entirely on the consumer side, in
exactly the modules that construct above arity 8.

**Equivalence gate**: 22 failing / 1,720 passing / 22 known-failures — the
baseline exactly.

**`__temporal_*` host-import leaks**: 0.

#### 6. The reduction that does NOT reproduce — worth knowing before the next slice

Across the link, only the MEMBER-ACCESS spelling `new NS.wide(…)` is this
defect. Binding the class to a local first — `const C = NS.wide; new C(…)` —
answers null on BOTH trees, and it answers null at arity **eight** as well
(`.tmp/s24/probe6489.mts`). Being arity-independent, it is a different,
pre-existing mechanism, and it DOES evaluate its arguments, so it is not even
the same failure shape. A `new (<call>)(…)` callee whose class is foreign is
null on both trees too.

The first linked reduction written for this slice used the bound-identifier
spelling and failed identically before and after the fix — which would have read
as "the fix does not work" rather than "the reduction is the wrong spelling".
All four residuals are pinned in
`tests/issue-6611-dynamic-new-arity.test.ts` so the distinction is not
rediscovered. `new Temporal.Duration(…)` — the real corpus spelling — is the
member form.

#### 7. Next bucket

With the sample's `expected a string, not null` retired, the largest remaining
groups in the 360 rows are `Calling as constructor Expected a TypeError` (4) and
`TypeError: Proxy get trap is not callable` (4), then a spread of 2-row groups
including two `RuntimeError: illegal cast in __class_construct_dispatch()`. No
single dominant cause remains in this sample.


### S25 findings (2026-09-15) — the sixth cause is a MISSING SPEC STEP, not a lookup or a ceiling: `new <value>` never ran §13.3.5.1 step 5. Four families, 404 → 410, and the hand-off's "no single dominant cause remains" was the clause that was wrong

Full write-up in
[#6612](6612-standalone-dynamic-new-not-a-constructor.md). Branch
`issue-5383-standalone-temporal-s25b`, based on S24's tip; the code is the
salvaged S25 commit `50db519d23`.

**This slice was interrupted too.** The container restarted mid-measurement and
killed the S25 lane, the second slice in a row to be cut that way. Salvaged from
its worktree, unchanged: the WIP fix commit (`src/codegen/native-construct.ts`,
`src/codegen/expressions/new-super.ts`, plus the new module
`src/codegen/construct-is-constructor-guard.ts`; all three byte-verified against
its validated copies), the `.tmp/s25` probes `p1`–`p4`, and **all four family
halves on both labels** — 960 cells, already complete. What was missing was
everything downstream of the numbers: the per-file diff, the must-not-move new
labels, the corpus and byte controls, the equivalence gate, the witness test and
both issue files. Those were produced here.

Two things the salvage let this slice check rather than assume: the four family
halves were run **solo at a 60 s budget from the start** (the dead lane's
`fam.mts` passes `60000`, and `run.sh` passes it through), so there is **no
`compile_error` and no `timeout` cell anywhere in the 960** — the brief's
instruction to "solo-correct every CE-involved row" had nothing to correct, and
that is a measured statement, not an assumption: the slowest cell in the matrix
is 22.6 s. And the provider is byte-identical under both labels (cache key
`a11c84e5…`, 3,307,526 B, `cacheHit: false` on a FRESH cache per label), so no
cell was served a stale artifact.

#### 1. The defect — `new` on a callable with no [[Construct]] quietly returned an object

`__native_construct_<N>` implements §10.2.2 OrdinaryCallEvaluateBody and nothing
else. Its tail — `Object.create(callee.prototype)`, run the body, return the
object — is unconditional. Every arm above it answers for a callee that HAS
[[Construct]]; nothing answered for one that does not. So an arrow, a static or
prototype method, an object-literal method, a built-in function, or a foreign
function whose `callableKind` publishes bit 1 without bit 2 fell into the tail
and **constructed successfully**, where §13.3.5.1 EvaluateNew step 5 requires a
TypeError.

The fix is one new module, `src/codegen/construct-is-constructor-guard.ts`,
spliced immediately before that tail — after every arm that answers for a
constructible callee has declined. It reads `__reflect_is_constructor`, the same
predicate test262's own `isConstructor.js` harness reads, with three
narrowings (must present as `typeof "function"`; the runtime-eval
interpreted-callback marker is exempt; no-JS-host lanes only) because a
wrongly-firing guard turns working code into a hard throw — a worse regression
than the defect.

**Why inside the driver, not at the call site**: §13.3.5.1 evaluates the
argument list (step 4) BEFORE the IsConstructor test (step 5). The call site has
already spilled callee and every argument into locals by the time it emits
`call <driver>`, so the driver's entry is the first program point where that
order holds — and it is one place instead of one per call site. The witness pins
it: the arguments still run, once, left to right, before the throw.

#### 2. The result — four families, and a histogram that moves in exactly one place

| family (first 120 files) | base | branch | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `PlainDate/**` | 101 | 103 | +2 | 0 | 2 |
| `Duration/**` | 97 | 99 | +2 | 0 | 2 |
| `PlainDateTime/**` | 104 | 106 | +2 | 0 | 2 |
| `ZonedDateTime/prototype/**` | 102 | 102 | 0 | 0 | 0 |
| **total** | **404** | **410** | **+6** | **0** | **6** |

Zero pass→fail, so there is nothing to explain. The stronger statement is the
histogram: aggregating all 480 base rows and all 480 branch rows by
digit-normalised message, the bucket `Calling as constructor Expected a
TypeError to be thrown but no exception was thrown` goes **6 → 0**. The base
histogram has 41 buckets; one retires and **the other 40 are unchanged, count
for count**. A one-bucket delta across 41 is a sharper safety claim than the row
count.

ZonedDateTime is flat because its sample is the `prototype/**` subtree, which
contains no `not-a-constructor.js` file — not because the fix missed it.

#### 3. Which clause of the hand-off was wrong

S24's §7 listed four candidates and closed with **"No single dominant cause
remains in this sample."** That sentence is the wrong clause, and it is wrong in
kind rather than in size.

`Calling as constructor Expected a TypeError` was presented as a **4-row**
residual, tied with `Proxy get trap is not callable` for the top of a flat
distribution. It is not a 4-row residual. It is a **missing spec step**:
`not-a-constructor.js` is **123 files under `built-ins/Temporal/**` alone and
536 files corpus-wide**, and the same defect is reachable from plain
`language/expressions/new/**` with no Temporal in sight — this slice's
must-not-move group C caught exactly that (see §4). The "4" measured the
SAMPLE, not the defect, and reading it as a tie between two equally-sized
leftovers is what made it look like the sample had gone flat.

The size correction is real too, and it points the same way: on the widened
480-row four-family sample **every** listed candidate is bigger than the
hand-off's three-family figure —

| hand-off candidate (360-row sample) | stated | measured on 480 rows | fixed here |
| --- | --- | --- | --- |
| non-constructor `new` not throwing TypeError | 4 | **6** | **yes, → 0** |
| `Proxy get trap is not callable` | 4 | **6** | no |
| `illegal cast in __class_construct_dispatch()` | 2 | **4** | no |
| `const C = NS.wide; new C(…)` → null residual | — | unchanged | no, and still correct |

The last row is the clause that **held**: S24 pinned that spelling as a
different, pre-existing, arity-independent mechanism, and
`tests/issue-6611-dynamic-new-arity.test.ts` still passes unchanged on this
branch, its `-2` residual intact. Widening the sample corrected the sizes; it
did not overturn that attribution.

#### 4. Controls

**Must-not-move — 314 rows, per file.**

| group | rows | base pass | branch pass | flips |
| --- | --- | --- | --- | --- |
| A: `Object/keys` + `language/expressions/object` + `Reflect/{get,has}` | 100 | 95 | 95 | 0 |
| B: `Object/{entries,values,getOwnPropertyNames}` | 45 | 25 | 25 | 0 |
| C: `language/expressions/new/**` (59) + `Reflect/construct/**` (10) + `language/statements/class/subclass/**` (100) | 169 | 119 | **120** | **1, fail→pass** |

A and B are the insensitive controls and are flat to the file. C is the
deliberately SENSITIVE group — the core-language corpus for the exact path this
change touches — and it is the one that moved:
`language/expressions/new/non-ctor-err-realm.js`, **fail → pass**. Nothing moved
the other way. That single row is the best evidence in the slice that the guard
implements the spec rule rather than a Temporal-shaped special case, and it is
why §3 calls the hand-off's framing wrong in kind.

Method note worth keeping: the second label was driven from the FIRST label's
own row list (`.tmp/s25/list.mts`), not from a `root:limit` spec re-walked per
label. A limit that clipped a directory differently between runs would otherwise
compare two different populations and report the difference as flips.

Two `compile_error` cells survive (one in A, one in C). Both are **feature**
compile errors — "native generator lowering currently supports only sequential
numeric yields", "standalone Reflect.construct currently requires …" — identical
on both labels. A longer budget cannot remove them and they say nothing about
this change.

**Corpus byte A/B**: 42 modules × {gc, standalone} = **84 artifacts, 0 move**.
As in S24 this is a NULL control and saying only "0 moved" overstates it: no
module in that corpus compiles a dynamic `new <value>` site, so it can show the
change is not a broad perturbation but cannot show it does anything.

**Byte control** (`.tmp/s25/bytes6490.mts`) — the evidence the corpus cannot
give, and it answers in both directions:

| artifact | base | branch | |
| --- | --- | --- | --- |
| provider (no `new <value>` site) | `12f3866d…` 165,069 B | identical | |
| consumer with no `new` at all | `af0b92c7…` 48,980 B | identical | |
| ONE module, statically-resolved `new K(5)` | `93c494e1…` 137,661 B | identical | the unarmed case |
| consumer, `new <param>()` across the link | `6a607192…` 164,097 B | `b0e3b74e…` 164,088 B | moved |
| consumer, `new NS.PD(5)` across the link | `5429282b…` 133,138 B | `112a461e…` 133,230 B | moved |
| ONE module, `new <param>(5)` | `d61b742d…` 246,044 B | `c74c651c…` 245,995 B | moved |

Exactly the three artifacts that compile a dynamic `new <value>` site move;
every artifact that does not is byte-identical. That is reserve-then-fill proven
in both directions, not only the safe one.

**One row of that table was written expecting the opposite answer and is kept as
measured.** `new NS.PD(5)` was labelled "directly-named `new`" and predicted
byte-identical. It moved — `NS.PD` is a member access on a runtime namespace, so
it IS a dynamic `new <value>` site. The single-module named case was added
afterwards precisely because no linked fixture can express a statically-resolved
callee. (Two of the three moved artifacts got SMALLER, −9 B and −49 B, though
the guard only adds instructions; function-index and LEB widths shift around the
driver bodies. Noted, not chased.)

**Equivalence gate**: 22 failing / 1,720 passing / 22 known-failures — baseline
exactly.

#### 5. The witness, and the spelling trap that made the first cut vacuous

`tests/issue-6612-dynamic-new-is-constructor.test.ts`, six cases, measured on
both trees by file-copy revert: base **3 fail / 3 pass**, branch **6 pass**.

Unlike #6611, BOTH the single-module and the linked arms are witnesses. This
defect is a property of the DRIVER, not of callee ownership, so it reproduces
with no link at all; the linked arm additionally covers the foreign-function
path, where the callable/constructible distinction arrives as a `callableKind`
bitmask rather than as a closure the module owns.

The trap, which cost a full cycle and is the reason this is written down: the
callee must arrive as a **function PARAMETER** (`nw0(F) { return new F(); }`).
The obvious alternative — a registry read, `const C = reg["%K%"]; new C()` — does
NOT reach this driver in a single module. It falls to `emitDynamicNewFallback`'s
tag dispatch, whose only candidates are module-local CLASSES, so a plain
function or a built-in answers `null` there on BOTH trees. The first cut of the
witness was written that way and **four of its six cases were vacuous** — they
asserted `null` and never exercised the guard. Measured, not reasoned.

A second discipline point from the same file: the linked `it` now asserts the
argument-ORDER expectation FIRST. An expectation placed after a failing one is
never reached on the base tree, so its inline "base tree: …" note would have
been written from inference rather than from a run. Reordering made 146 and 5 a
measurement.

#### 6. Next bucket — chosen from the widened sample

`PlainDateTime/**` residual, branch tree, solo-corrected (14 rows):

| bucket | rows |
| --- | --- |
| `TypeError: Proxy get trap is not callable` | 2 |
| `year result: Expected SameValue(«N», «N,N,MN,…»)` | 2 |
| `RuntimeError: illegal cast in __class_construct_dispatch()` | 2 |
| `RuntimeError: dereferencing a null pointer in __closure_N()` | 2 |
| six singletons | 6 |

Across all four families (70 branch-tree residual rows, 40 buckets) the three
largest are `Proxy get trap is not callable` (**6**), `dereferencing a null
pointer in __closure_N()` (**6**) and `illegal cast in
__class_construct_dispatch()` (**4**). The tail is genuinely flat — 33 of the 40
buckets have ≤2 rows.

So the honest read of "next" is the opposite of picking the biggest number, and
S25 is the cautionary case for it: `Proxy get trap is not callable` and
`illegal cast in __class_construct_dispatch()` are both **shaped like spec
steps** (a MOP invariant and a brand/cast invariant), and this slice just showed
that a spec-step cause's corpus footprint is invisible in a Temporal-only
sample — six rows here, 536 files corpus-wide. Size the candidate by counting
its test262 FAMILY corpus-wide before committing a slice to it, not by its row
count in this sample.

### S26 findings (2026-09-15) — the seventh cause is a CARRIER hole an existing proof documents and declines, not a lookup, a ceiling or a spec step. Four families, 410 → 411, and BOTH of the hand-off's named hypotheses were wrong

Full write-up in
[#6613](6613-standalone-heterogeneous-array-literal-carrier.md). Branch
`issue-5383-standalone-temporal-s26`, based on S25b's tip `3e0825eb09`; the fix
is commit `e80ee7c571`.

The headline number is small and the slice is deliberately reported that way:
**+1 row on the 480-row sample, 0 pass→fail, exactly one of 38 message buckets
moves.** What makes it worth a slice is the shape of what moved — a hard TRAP
during array-literal CONSTRUCTION, on four lines of ordinary JavaScript with no
Temporal, no provider and no link in sight.

#### 1. The defect — a heterogeneous array literal trapped while being built

```js
const obj = { year: -271821, month: 4, day: 18 };
[obj, "str"].length; // RuntimeError: dereferencing a null pointer
```

`.length` is enough; the elements are never read. `compileArrayLiteral` keys the
vec to element zero's carrier — here the closed `$__anon_N` struct for `obj` —
and guard-casts every later element into it. A string, number, boolean or
nested vec cannot inhabit that struct, so the guard emits
`ref.test` → `ref.null`, and the non-nullable element slot hits the null with
`ref.as_non_null`. Disassembled, it is four instructions:

```wat
(array.new_fixed $13 2
  (ref.as_non_null (global.get $global$9))
  (ref.as_non_null
    (if (result (ref null $7))
      (ref.test (ref $7) (local.tee $0 (global.get $global$14)))
      (then (ref.cast (ref null $7) (local.get $0)))
      (else (ref.null none)))))
```

The fix is one predicate, `hasNonStructElementForStructCarrier`, added beside
#4289/#5327's `hasIncompatibleElementCarrier` in
`src/codegen/struct-carrier-inhabits.ts` and called from the same decision table
in `literals.ts`, standalone/WASI-gated.

**The most useful thing in this slice is that the gap was already written
down.** #4289's doc comment says, in its own words, that it "stays narrow on
purpose: only elements that themselves resolve to a closed data struct are
consulted (**a string / number / vec element is another widening's
business**)". There was no other widening. A documented deferral with no owner
read as a documented decision for two slices.

Two adjacent measurements explain why nobody tripped over it sooner:

- the INLINE spelling `[{ year: 1 }, "str"]` already widened (the first-object
  arm rejects any non-object sibling outright) — only the BINDING spelling
  reached the hole, because `unwrapObjectLiteralElement` does not resolve an
  identifier to its initializer. The two spellings of the same array disagreed;
- the JS-host/GC lane does not trap for a STRING sibling (a string is plain
  `externref` there), which is why the standalone lane owned this alone.

#### 2. The result — four families, and a histogram that moves in exactly one place

| family (first 120 files) | base | branch | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `PlainDate/**` | 103 | 104 | +1 | 0 | 1 |
| `Duration/**` | 99 | 99 | 0 | 0 | 0 |
| `PlainDateTime/**` | 106 | 106 | 0 | 0 | 0 |
| `ZonedDateTime/prototype/**` | 102 | 102 | 0 | 0 | 0 |
| **total** | **410** | **411** | **+1** | **0** | **1** |

The base total **reproduces S25's 410 family for family** (103/99/102/106) on a
freshly prewarmed cache, so the two slices' numbers are directly comparable.

Aggregating all 480 base rows and all 480 branch rows by digit-normalised
message: 38 buckets on each side, and **exactly one moves** —
`dereferencing a null pointer in __closure_N()` **7 → 6**. The other 37 are
unchanged, count for count. The moved row is
`Temporal/PlainDate/from/limits.js`, whose `[tooEarly, tooLate,
"-271821-04-18", "+275760-09-14"]` is the defect written in test262's house
style.

Runs were solo, sequential, at a **60 s** per-row budget from the start, on a
FRESH `JS2WASM_TEMPORAL_CACHE` per label (`cacheHit: false` on both prewarms,
key `a11c84e5…`, 3,307,526 B). There is **no `compile_error` and no `timeout`
cell anywhere in the 960**.

#### 3. Which clauses of the hand-off were wrong — both named hypotheses

The brief ranked three candidates and named a mechanism for the first. Both
named mechanisms are wrong, and the ranking inverted once the buckets were
reduced rather than counted.

**(a) `illegal cast in __class_construct_dispatch()` — "the construct ladder
tests classes structurally (S21's problem on the CONSTRUCT side)".** It does
not. `ensureStandaloneClassConstructDispatch` discriminates by **identity**:
`ref.eq` against each class-object singleton global, each arm guarded by a
`ref.test` on the lazily-materialised global. Its own header says why —
"keyed by the class's IDENTITY … the same discriminator #5383 S2f R13 had to
use for `typeof`". S21's structural hazard cannot exist here, and the `__tag`
guard has nothing to attach to.

The real cause, reduced to ONE module with no link: `externArgCoercionInstrs`'
ref arm emits a **hard** `ref.cast` into the formal's type. `f64`/`i32` formals
are lenient (NaN / 0); a ref formal traps. A parameter typed by INFERENCE from
its default (`calendar = "iso8601"` ⇒ `string`) is unsound for a dynamic
caller:

```js
class PD { constructor(y, m, d, cal = "iso8601") { this.cal = cal; } }
mk(PD, 2020, 12, 24, undefined);  // TRAP illegal cast
mk(PD, 2020, 12, 24, 1);          // TRAP illegal cast
mk(PD, 2020, 12, 24, "gregory");  // "gregory" — only a matching type survives
```

**(b) `dereferencing a null pointer in __closure_N()` — "a closure-call null …
if it is one mechanism".** It is not one mechanism; it is at least two, and the
BIG half is not a closure defect at all. Bisecting `limits.js` reached a variant
with **no Temporal in the file** that still trapped — the array-literal carrier
hole this slice fixes. The remaining 6 rows
(`infinity-throws-rangeerror.js`) reduce to something else entirely:
`TemporalHelpers.toPrimitiveObserver`, an object-literal METHOD returning an
object whose GETTERS return closures over the method's parameters. Three
distinct defects sit on that one shape, all measured standalone:

| spelling | answer |
| --- | --- |
| object-literal METHOD form (the harness's own) | `Cannot access property on null or undefined` |
| plain FUNCTION form | right value, but the getter's side effect is LOST (`calls` stays empty) |
| single-getter form | `o.valueOf()` answers `[object Object]` |

**(c) The sizing instruction was right and it is what picked this slice.** The
hand-off said to size a candidate by its test262 family corpus-wide before
committing. Doing that showed the three candidates' file-name footprints —
`infinity-throws-rangeerror.js` 74 files, `order-of-operations.js` 64,
`overflow-wrong-type.js` 20, `limits.js` 23, against `calendar-undefined.js` 5
and `calendar-wrong-type.js` 8 — and then reduction showed the name counts were
attached to the WRONG mechanisms. The lesson S25 wrote ("size by the FAMILY, not
the row count") needs one amendment after this slice: **size by the family, then
REDUCE before you believe the size**, because a bucket's rows can belong to two
or three unrelated causes and the name count then measures a coalition, not a
defect.

#### 4. Controls

**Must-not-move — 604 rows, six groups, per file, 0 flips.**

| group | rows | base pass | branch pass | flips |
| --- | --- | --- | --- | --- |
| A: `Object/keys` + `expressions/object` + `Reflect/{get,has}` | 100 | 94 | 94 | 0 |
| B: `Object/{entries,values,getOwnPropertyNames}` + `statements/for-in` | 116 | 93 | 93 | 0 |
| C1: `class/subclass` + `Reflect/construct` + `new.target` | 133 | 80 | 80 | 0 |
| C2: `expressions/arrow-function` (first 100) | 100 | 96 | 96 | 0 |
| **D1: `language/expressions/array` + `Array/prototype/join`** | 75 | 69 | 69 | 0 |
| **D2: `Array/prototype/{map,forEach}` (first 40 each)** | 80 | 54 | 54 | 0 |

A/B/C are the hand-off's groups and are the INSENSITIVE controls here — they
were chosen for the construct-ladder hypothesis this slice did not take. **D is
the group this change actually needs** and was added for it: the core-language
array-literal corpus plus the HOFs that read a widened vec back. Running only
the inherited groups would have produced a flat table that proved nothing about
the change that was made.

Four `compile_error` cells (2 in C1, 2 in C2) are identical on both labels and
are feature compile errors, not budget artefacts.

**Byte A/B — the control the corpus cannot give, and it answers in both
directions:**

| artifact | base | branch | |
| --- | --- | --- | --- |
| standalone, `[obj, "str"]` | `de5b9fe1…` 51,209 B | `68da276d…` 50,859 B | **moved** |
| standalone, `[obj, 7]` | `0693c3ec…` 51,161 B | `be25d351…` 50,889 B | **moved** |
| standalone, `[obj, obj]` (homogeneous) | `1a6399b8…` 51,165 B | identical | |
| standalone, `[{year:1}, "str"]` (inline elem 0) | `ee6bfe28…` 136,190 B | identical | |
| standalone, no array literal | `fb2f7abd…` 49,625 B | identical | |
| **gc lane, the SAME armed source** | `97d908fc…` 2,856 B | identical | the lane gate |
| linked provider (no mixed literal) | `f9c3d1e4…` 155,696 B | identical | |

Exactly the two armed artifacts move; every unarmed one is byte-identical,
including the gc lane compiled from the same source — that row is the lane gate
proved rather than asserted. Both armed artifacts got SMALLER (−350 B, −272 B):
the externref vec drops the per-element guard-cast-and-assert sequence the
closed carrier needed.

**Temporal provider**: the cached artifact is byte-identical between the two
labels (same sha256, 3,307,526 B), so no family cell was served a differently
compiled polyfill — the whole family delta is in the TEST module.

**Corpus byte A/B**: 42 modules × {gc, standalone} = **84 artifacts, 0 move**.
As in S24/S25 this is a NULL control and saying only "0 moved" overstates it: no
module in that corpus writes a mixed array literal, so it can show the change is
not a broad perturbation but cannot show it does anything. The byte table above
is what shows that.

**Equivalence gate**: 22 failing / 1,720 passing / 22 known-failures — baseline
exactly.

#### 5. The witness

`tests/issue-6613-heterogeneous-array-literal.test.ts`, four `it`s, measured on
both trees by file-copy revert: base **3 fail / 1 pass**, branch **4 pass**.

Both arms have teeth. The single-module arm is the defect itself; the linked arm
compiles the same consumer-local literal in a module that also links a provider,
proving the widening survives a linked build where the rec group and the type
indices are not the single-module ones. Its FOREIGN-element case is labelled a
control, not a witness, because a provider-built object crosses the link as
`externref`, which this predicate skips by construction — and the control
assertions run FIRST, so their "base tree: …" notes are measurements rather than
inference (the #6612 discipline point, applied).

The spelling trap here is the mirror of #6612's: element zero must be an
IDENTIFIER bound to an object. Written inline (`[{ year: 1 }, "str"]`) every
case passes on BOTH trees and the witness is vacuous.

#### 6. Next bucket — and an inherited red that must be cleared first

**BLOCKER, not this slice's, and it wedges the merge queue if ignored:**
`npm run -s check:issue-ids:against-main` FAILS on this stack. Main has since
taken ids **6600, 6601 and 6602**, which S17/S15/S16 also used
(`6600-standalone-link-reverse-peer-read.md`,
`6601-standalone-dynamic-new-poisons-provider-values.md`,
`6602-standalone-nullable-vec-element-callback-param.md`). Three renames plus
their in-branch references are needed before this stack can be enqueued. Note
also that `claim-issue.mjs --allocate --dry-run --no-pr-scan` answers **#6606**
on this box — it cannot see the stack's unpushed issue files — so do NOT take
its suggestion; #6613 was verified free on `origin/main` and `UNASSIGNED` on
`origin/issue-assignments` before use.

Residual buckets, branch tree, all four families (69 rows, 38 buckets):

| bucket | rows | reduced to |
| --- | --- | --- |
| `dereferencing a null pointer in __closure_N()` | 6 | the `toPrimitiveObserver` getter/closure cluster (§3b) — three defects, one shape |
| `Proxy get trap is not callable` | 6 | not reduced; standalone Proxy support, a slice of its own |
| `illegal cast in __class_construct_dispatch()` | 4 | a hard `ref.cast` in `externArgCoercionInstrs` for a formal typed by inference from its default (§3a) |
| `Built-in objects must be extensible` | 3 | not reduced |
| `constructor.js: Expected a TypeError` | 3 | not reduced |
| `null pointer in __anon_N_checkStringOptionWrongType` | 3 | same cluster as row 1 |
| 32 further buckets | ≤2 each | |

Recommended next slice: **the `toPrimitiveObserver` getter cluster** — 9 rows
across two buckets, one reduction, and the three symptoms (a null return, a lost
getter side effect, a getter that answers the receiver) suggest a single
accessor-lowering cause rather than three.

Filed but not fixed here, each with a reduction in
[#6613](6613-standalone-heterogeneous-array-literal-carrier.md): a
numeric-first mixed vec read through a HOF answers `"nullnull"` and, in two
spellings, produces an **INVALID MODULE** (`typeof a[0]` on `[1, "a"]`;
`for (const v of [1, true])`). An invalid module is strictly worse than a trap —
nothing in it runs at all — and neither spelling appears in any current bucket,
which is its own warning about sizing by symptom.

### S27 findings (2026-09-15) — the eighth cause is ONE existing rule reaching ONE spelling of "function". Four families, 411 → 419; corpus-wide the two target families go 14 → 79 of 93

Full write-up in
[#6614](6614-standalone-accessor-literal-return-carrier.md). Branch
`issue-5383-standalone-temporal-s27`, based on S26's tip `528db1579e`; the fix
is commit `9b41de035e`.

The 480-row sample moves **+8, 0 pass→fail**, and the eight rows that move are
exactly the eight `__closure_N` / `checkStringOptionWrongType` rows S26
recommended. The number worth reporting, though, is the **corpus-wide** one: the
two test262 families those rows belong to are 93 files, and they go **14 → 79
pass (+65, 0 pass→fail)**. The 120-row-per-family sample sees 8 of that 65
because it clips each family at its first 120 files.

#### 1. The defect — an accessor object is null-dropped by the RETURN slot

```js
const M = { mk(pv) { return { get g() { return pv; } }; } };
const r = M.mk(5);
r.g;   // TypeError: Cannot access property on null or undefined
       // spec, and the JS-host/WasmGC lane: 5
```

`compileObjectLiteralWithAccessors` builds such a literal as a HOST object
(`__new_plain_object` + `__defineProperty_accessor`, an externref). The checker
types the enclosing function's return as the anonymous shape the accessor
implies, so the receiving binding is laid out as a **closed struct**; the store
guard (`ref.test $__anon_N` on a host object) always fails, `ref.null` is
written, and the first read is a `struct.get` on null. Disassembled:

```wat
(global $global$10 (mut (ref null $27)) (ref.null none))   ;; r — a CLOSED struct
(struct.get $27 0 (local.get $0))                          ;; r.g — on the null
```

**The rule that prevents this already exists and is 300 lines away.**
`declarations.ts::functionReturnsHostObjectLiteralCarrier` walks a function's
returns for exactly this literal and registers its return type in
`ctx.objectHashConsumerTypes`, which `resolveWasmType` answers `externref` for.
It is reached from two call sites that both take a **`ts.FunctionDeclaration`**
and both walk **source-file-level statements only**. So it fired for one
spelling of "a function that returns an object":

| spelling | base | branch |
| --- | --- | --- |
| top-level `function mk() { … }` | **correct** | correct |
| `const mk = function () { … }` | trap | correct |
| `const mk = () => ({ … })` | trap | correct |
| `{ mk() { … } }` object-literal method | trap | correct |
| `class C { mk() { … } }` | trap | correct |
| `function` NESTED in another function | trap | correct |
| IIFE | trap | correct |

`TemporalHelpers.toPrimitiveObserver` is the object-literal-METHOD row.

#### 2. Why seven wrong hypotheses preceded it, and what the reduction actually cost

S26's symptom table named three distinct defects on one shape (a null return, a
LOST getter side effect in the plain-function spelling, and a single-getter
version answering `[object Object]`) and inferred "a single accessor-lowering
cause". Reduced one module at a time, that resolves differently:

- the **null return** and the **lost side effect** are the SAME defect — the
  return-slot null-drop. `+obs` on a null answers `0` with `calls` empty, which
  is what "the side effect is lost" looked like. The hand-off's note that the
  plain-FUNCTION form kept the value and lost only the effect did **not**
  reproduce: a top-level `function` spelling is the one spelling that was always
  correct, side effect included (measured, `.tmp/s27/p1.mjs`);
- the **`[object Object]`** symptom is a genuinely separate defect, and it is
  **lane-INDEPENDENT** — the JS-host/WasmGC lane gives the same wrong answer.
  It is therefore out of a standalone-only slice (see §7a).

**What found it was a spelling matrix, not a deeper trace.** Thirteen one-line
spellings of the same three-line program, each compiled as its OWN module
(module CONTENT changes answers), split "object-literal method" from "function
declaration" in one run and made the rule-with-one-spelling visible. The
diagnostic cost was two `console.error` lines in `moduleGlobalWasmType` printing
the chosen ValType and each named arm's answer; every arm reported `false` on
both trees, which is what pointed at `resolveWasmType`'s type-identity set
rather than at any of the widening arms.

#### 3. The fix

`src/codegen/accessor-literal-return-carrier.ts` — a standalone/WASI-gated
pre-pass, driven from `index.ts` at the same deterministic point as
`collectDynamicObjectReturnCarrierTypes` (before `collectDeclarations`, so
before any binding is typed), in both the single- and multi-source paths. It
mirrors the existing body scan for every function-LIKE node.

It also registers the **call-site** type, and that second step is not
belt-and-braces: a class method's declaration return type and its call site's
resolved type are **two different `ts.Type` objects that both print
`{ readonly g: any; }`**, and `objectHashConsumerTypes` is keyed by identity —
so with only the first step, `new C().mk()` kept the closed-struct slot while
`C_mk` already returned externref (measured; it is the one case of the matrix
that stayed broken until the consult was added). That is the
`oracle-ratchet-allow` in #6614's frontmatter, and the reason it is a genuine
ValType-lowering question.

Narrowed to **accessor** literals, the same scoping #5376 chose for the
struct-FIELD twin of this defect; the other `objectLiteralForcesHostPath`
reasons stay a separate, separately-measured change.

#### 4. The result

| family (first 120 files) | base | branch | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `PlainDate/**` | 104 | 107 | +3 | 0 | 3 |
| `Duration/**` | 99 | 100 | +1 | 0 | 1 |
| `PlainDateTime/**` | 106 | 109 | +3 | 0 | 3 |
| `ZonedDateTime/prototype/**` | 102 | 103 | +1 | 0 | 1 |
| **total** | **411** | **419** | **+8** | **0** | **8** |

The base total **reproduces S26's 411 family for family** (104/99/106/102) on a
freshly prewarmed cache, so the two slices' numbers are directly comparable.

**Corpus-wide, the two target families:** every `infinity-throws-rangeerror.js`
and `overflow-wrong-type.js` under `Temporal` — **93 files**, run per file on
both labels at 60 s, solo:

| | base | branch | Δ |
| --- | --- | --- | --- |
| 93 files, both target families | **14 pass** | **79 pass** | **+65, 0 pass→fail** |

Aggregating the 480 sample rows by digit-normalised message: **exactly three
buckets move**, and the other 36 are unchanged count for count:

| bucket | base | branch |
| --- | --- | --- |
| `dereferencing a null pointer in __closure_N()` | 6 | **0** |
| `dereferencing a null pointer in __anon_N_checkStringOptionWrongType` | 3 | **0** |
| `object with toString … «[object Object]n»` (new) | 0 | 1 |

Both target buckets are retired outright. The single new row is
`ZonedDateTime/prototype/add/overflow-wrong-type.js`, which clears this defect
and lands on a **BigInt** one: `assert.sameValue(result.epochNanoseconds,
1_000_086_400_987_654_321n)` renders the expected value as `[object Object]n`.
Unrelated to accessors, and counted as fail→fail.

Runs were solo, sequential, at a **60 s** per-row budget from the start, on a
FRESH `JS2WASM_TEMPORAL_CACHE` per label (`cacheHit: false` on both prewarms,
key `a11c84e5…`, 3,307,526 B). There is **no `compile_error` and no `timeout`
cell anywhere in the 960**.

#### 5. Controls

**Must-not-move — 497 rows, five groups, per file, 0 flips.**

| group | rows | base pass | branch pass | flips |
| --- | --- | --- | --- | --- |
| A: `Object/keys` + `expressions/object` + `Reflect/{get,has}` | 100 | 94 | 94 | 0 |
| B: `Object/{entries,values,getOwnPropertyNames}` + `statements/for-in` | 116 | 93 | 93 | 0 |
| **E1: `language/expressions/object/accessor-*`** | 24 | 23 | 23 | 0 |
| **E2: `built-ins/Object/defineProperty` (first 150)** | 150 | 150 | 150 | 0 |
| **E3: `template-literal` + `Symbol/toPrimitive` + `addition`** | 107 | 99 | 99 | 0 |

A/B are the inherited groups and are the INSENSITIVE controls here. **E is the
group this change needs** and was chosen for it: the accessor corpus itself, the
descriptor-install corpus that mints the same host objects, and the two
ToPrimitive consumers (`` `${obj}` `` and `+obj`) that read them back. The one E1
`compile_error` cell is identical on both labels.

**Byte A/B — the control the corpus cannot give, and it answers in both
directions:**

| artifact | base | branch | |
| --- | --- | --- | --- |
| standalone, object-literal METHOD carrier | `044dd6a1…` 145,362 B | `2e79bfcf…` 144,270 B | **moved** |
| standalone, ARROW carrier | `fbc1fbc8…` 144,562 B | `65900e54…` 143,547 B | **moved** |
| standalone, CLASS-METHOD carrier | `06d40ec2…` 146,121 B | `b76862ae…` 145,489 B | **moved** |
| standalone, top-level `function` carrier (already correct) | `cb8b7068…` 142,014 B | identical | |
| standalone, same shape with NO accessor | `5dd93d63…` 142,469 B | identical | |
| standalone, top-level accessor literal, no carrier | `d5576819…` 143,101 B | identical | |
| **gc lane, the SAME armed method source** | `adfa13cf…` 6,604 B | identical | the lane gate |
| **gc lane, the SAME armed arrow source** | `e2dea7b2…` 6,359 B | identical | the lane gate |
| linked provider (no accessor carrier) | `ce50b3f3…` 155,696 B | identical | |

Exactly the three armed artifacts move; every unarmed one is byte-identical,
including both gc-lane artifacts compiled from the same armed sources — the lane
gate proved rather than asserted. All three armed artifacts got SMALLER (−1,092 /
−1,015 / −632 B): an externref slot drops the guarded-cast-and-store sequence the
closed struct needed.

**Temporal provider**: the cached artifact is byte-identical between the two
labels — and byte-identical to S26's (`dc159623…`, 3,307,526 B) — so no family
cell was served a differently compiled polyfill and the whole delta is in the
TEST module.

**Corpus byte A/B**: 42 modules × {gc, standalone} = **84 artifacts, 0 move**. As
in S24–S26 this is a NULL control and saying only "0 moved" overstates it: no
module in that corpus returns an accessor literal from a function, so it shows
the change is not a broad perturbation but cannot show it does anything. The byte
table above is what shows that.

**Equivalence gate**: 22 failing / 1,720 passing / 22 known-failures — baseline
exactly.

#### 6. The witness

`tests/issue-6614-accessor-literal-return-carrier.test.ts`, four `it`s, measured
on both trees by file-copy revert of `src/codegen/index.ts`: base **3 fail /
1 pass**, branch **4 pass**.

The side-effect arm is separate on purpose. A fix that merely stops the
null-drop could still hand back an object whose accessor became a DATA property
— right value, no side effect — and that is exactly what
`checkStringOptionWrongType`'s `assert.compareArray(actual, expected, "order of
operations")` catches. The arm asserts the getter is observed **exactly once, in
spec order**, for `+obs` (valueOf first), for `` `${obs}` `` (toString first) and
for a double read (4 log entries, not 0 and not 8).

#### 7. Residuals, each reduced

**(a) `o.valueOf()` as a DIRECT call answers the receiver.** LANE-INDEPENDENT —
the gc lane gives the same wrong answer, so fixing it would move gc bytes and it
is out of a standalone-only slice.

```js
const o = { get valueOf() { return function () { return 11; }; } };
o.valueOf();                                           // "[object Object]"  spec: 11
(function () { var f = o.valueOf; return f(); })();    // 11 — correct
```

Name-specific: `o.toString()`, `o.zz()` and `o.f()` are all correct with the
identical shape, and a DATA-property or METHOD `valueOf` is correct too. A
`valueOf` call fast path is reaching the receiver's builtin without first asking
whether the own property is an accessor. No row in the current buckets depends
on it.

**(b) The reverse peer GET does not dispatch an ACCESSOR.** A provider reading
`o.g` off a consumer-built object gets `undefined` where the consumer installed
a getter; the DATA-property twin reads back correctly. Measured on BOTH trees
with a TOP-LEVEL accessor literal — a spelling that was already correct locally
— which pins it to the reverse channel and not to the return slot. Pinned as an
expectation in the witness so it cannot rot silently. This answers the brief's
"check the reverse GET honours accessors": it does not.

#### 8. Residual buckets, branch tree, all four families (61 rows, 37 buckets)

| bucket | rows | file-name footprint corpus-wide | reduced to |
| --- | --- | --- | --- |
| `Proxy get trap is not callable` | 6 | `order-of-operations.js` 64 + `observable-get-overflow-argument-primitive.js` 5 | not reduced; standalone Proxy support, a slice of its own |
| `illegal cast in __class_construct_dispatch()` | 4 | `calendar-undefined.js` 5 + `calendar-wrong-type.js` 8 | S26 §3a: a hard `ref.cast` in `externArgCoercionInstrs` for a formal typed by INFERENCE from its default (`calendar = "iso8601"` ⇒ `string`), unsound for a dynamic caller |
| `Built-in objects must be extensible` | 3 | `builtin.js` 129 | not reduced |
| `constructor.js: Expected a TypeError` | 3 | `constructor.js` 16 | not reduced |
| `Expected a RangeError … no exception` | 3 | mixed | not reduced |
| 32 further buckets | ≤2 each | | |

**Read the footprint column with S26's amendment applied**: a file-name count
measures a COALITION, not a defect — `builtin.js` is 129 files of which 3 fail
here. This slice is the counter-example that makes the amendment cut both ways:
the two families it retired footprint at 93 files and **65 of them really did
move**, because there the name and the mechanism happened to coincide. Size by
the family, reduce before you believe the size, and then MEASURE the family.

**Recommended next slice: the `illegal cast in __class_construct_dispatch()`
bucket.** It is the only remaining bucket already reduced to a named mechanism
in one module with no link, S26 did that reduction, and the shape (a parameter
whose type is INFERRED from its default, hard-cast at a dynamic call) is general
rather than Temporal-specific. `Proxy get trap is not callable` is larger (6
rows, 69 files) but is unreduced standalone-Proxy work.

#### 9. Traps, carried forward and added to

Everything in S26 §Traps still holds. Two additions:

- **`wabt` cannot read this tree's modules** (`readWasm failed: unexpected type
  form (got -0x30)`). Use `./node_modules/.bin/wasm-dis -all` (binaryen), which
  is already in `node_modules/.bin`. A disassembler that refuses is not a signal
  about the module.
- **A probe file with a SHARED prelude is one module**, so a single case that
  fails to compile poisons every other case's answer — the first `p4` run
  reported a uniform `stack-balance (#2090)` CE for all ten cases and said
  nothing about any of them. Drive each case as its own module
  (`.tmp/s27/each.mjs`); it costs one compile per case and is the only form in
  which a spelling matrix means anything.

### S28 findings (2026-09-15) — the ninth cause is a marshal that answers a DECLARED type where the caller supplied a DYNAMIC value. Four families, 419 → 423; corpus-wide the two target families go 3 → 13 of 13

Full write-up in
[#6615](6615-standalone-dynamic-ref-arg-hard-cast.md). Branch
`issue-5383-standalone-temporal-s28`, based on S27's tip `1438da85ab`; the fix
is commits `a306c24168` + `8828ace5a5` + `0406214506`.

The 480-row sample moves **+4, 0 pass→fail**, and the four rows that move are
exactly the four `illegal cast in __class_construct_dispatch()` rows S27
recommended. Corpus-wide the two target families are **13 files and they go
3 → 13 pass** — every one of them.

#### 1. The defect — a hard `ref.cast` into a formal typed by its own default

```js
class PD { constructor(y, m, d, cal = "iso8601") { this.t = typeof cal; } }
function mk(C, a, b, c, d) { return new C(a, b, c, d); }

mk(PD, 2020, 12, 24, undefined);  // TRAP illegal cast — spec: run the default
mk(PD, 2020, 12, 24, null);       // TRAP illegal cast
mk(PD, 2020, 12, 24, 1);          // TRAP illegal cast
mk(PD, 2020, 12, 24, {});         // TRAP illegal cast
mk(PD, 2020, 12, 24, Symbol());   // TRAP illegal cast
mk(PD, 2020, 12, 24, "gregory");  // "gregory" — only a MATCHING type survives
mk3(PD, 2020, 12, 24);            // "iso8601" — a MISSING argument is fine
```

`externArgCoercionInstrs`' ref arm was two instructions — `any.convert_extern`
+ a NON-null `ref.cast` — and a failed `ref.cast` is a wasm **trap**, which
kills the instance so no `catch` in the program can see it. The formal is
whatever the checker inferred, and `cal = "iso8601"` makes that `string`
(lowered to `(ref null $string)`). **The declared type describes the DEFAULT,
not the argument**, and a dynamic caller is under no obligation to honour it.

S26 reduced this in one module and named the mechanism; that reduction
reproduced exactly, line for line (`.tmp/s28/cases-a.mjs`, 16 spellings, each
its own module).

#### 2. The fix — three arms, and arms 1 and 3 are reachable ONLY where the cast already trapped

`src/codegen/extern-arg-marshal.ts` mints, per formal type, a lenient
replacement for the inline cast: `__extern_arg_ref_<typeIdx>[_opt]
(externref) -> (ref [null] $T)`.

1. **`undefined` into a DEFAULTED nullable formal → `ref.null`.** The callee's
   parameter prologue fires a ref-typed default on `ref.is_null`
   (`function-body.ts`), so a typed null IS the "run your default" signal — the
   ref-lane twin of #5380's f64 sNaN sentinel.
2. **A value that inhabits `$T` → the same cast as before**, byte for byte.
   `ref.test (ref $T)` succeeds exactly where `ref.cast (ref $T)` does.
3. **Anything else → a catchable `TypeError` INSTANCE** (`e instanceof
   TypeError` **and** `e.constructor === TypeError`, measured — `assert.throws`
   reads both). It is also what the callee itself would have done for all ten
   values `calendar-wrong-type.js` passes: the polyfill's `Ve` is
   `if ("string" != typeof e) throw new TypeError(…)`.

**That structure is the whole safety argument, and it is a proof rather than a
sample**: arm 2 is the old behaviour, and arms 1 and 3 are reached only for
values that previously TRAPPED. A trap always fails a test262 row, so the change
is monotone — 0 pass→fail is not a measurement that came out lucky.

A helper FUNCTION rather than inline instructions, for the reason
`ensureUnboxNumberOrOmitted` already is one: the argument may come from
`__extern_get_idx`, so the sequence must not evaluate it twice — and a function
needs no scratch local in callers whose local layout was fixed at reserve time.
Being in the one shared marshal, it reaches BOTH finalize-time callers (the
construct trampolines and the closed-method dispatchers), which is what that
module exists for.

#### 3. What the hand-off got right, and the one clause that was wrong

The brief's mechanism was **right** — this is the first slice in the S9–S28 run
where the inherited attribution survived reduction intact. Its two suggested
fixes split, though:

- **"a `ref.test`-guarded cast that falls back to the extern carrier"** — the
  fallback cannot be the extern carrier. The callee's formal is
  `(ref null $string)`; there is no way to put a number or a symbol in it, so
  "carry the value as the boxed/any carrier and let the body's own checks run"
  is unavailable without changing the callee's SIGNATURE.
- **"widening the formal to the any-carrier for dynamically-invoked callees"**
  is the semantically correct fix and was rejected on measurement, not taste:
  the checker still types the parameter `string`, and every use site inside the
  body resolves its ValType from that type. The established widening mechanism
  (`ctx.objectHashConsumerTypes`, keyed by `ts.Type` IDENTITY — S27's fix) cannot
  express it, because the identity in question is the SHARED primitive `string`.
  Registering it would make every string in the module an externref.

  The compiler already contains the widened answer for one spelling, which is
  what makes the tradeoff concrete: an ARROW with a defaulted string parameter
  called through a value answers `"number"` correctly, because an arrow's
  closure formals are externref. A `function` declaration with the identical
  body traps.

So arm 3 throws where a widened formal would have let the body decide. That is
a deliberate approximation, and it is stated as one: for THIS corpus it is
exactly right, and everywhere else it replaces a trap with a catchable error.

#### 4. The result

| family (first 120 files) | base | branch | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `PlainDate/**` | 107 | 109 | +2 | 0 | 2 |
| `Duration/**` | 100 | 100 | 0 | 0 | 0 |
| `PlainDateTime/**` | 109 | 111 | +2 | 0 | 2 |
| `ZonedDateTime/prototype/**` | 103 | 103 | 0 | 0 | 0 |
| **total** | **419** | **423** | **+4** | **0** | **4** |

The base total **reproduces S27's 419 family for family** (107/100/109/103), so
the two slices' numbers are directly comparable.

**Corpus-wide, the two target families:** every `calendar-undefined.js` and
`calendar-wrong-type.js` under `Temporal` — **13 files**, run per file on both
labels at 60 s, solo:

| | base | branch | Δ |
| --- | --- | --- | --- |
| 13 files, both target families | **3 pass** | **13 pass** | **+10, 0 pass→fail** |

Aggregating the 480 base rows and the 480 branch rows by digit-normalised
message: 37 buckets on the base side, 36 on the branch side, and **exactly one
moves** — `illegal cast in __class_construct_dispatch()` **4 → 0**. The other 36
are unchanged, count for count.

Runs were solo, sequential, at a **60 s** per-row budget from the start, on a
FRESH `JS2WASM_TEMPORAL_CACHE` per label (`cacheHit: false` on both prewarms,
key `a11c84e5…`). There is **no `compile_error` and no `timeout` cell anywhere
in the 960**, and no `__temporal_*` leak in any row of any label.

#### 5. Controls

**Must-not-move — 356 rows, three groups, per file, 0 flips.**

| group | rows | base pass | branch pass | flips |
| --- | --- | --- | --- | --- |
| A: `Object/keys` + `expressions/object` + `Reflect/{get,has}` | 81 | 79 | 79 | 0 |
| B: `Object/{entries,values,getOwnPropertyNames}` + `statements/for-in` | 97 | 77 | 77 | 0 |
| **F: `class/dstr` (150) + `function`/`arrow-function` `dflt-params-*` (18) + `Reflect/construct` (10)** | 178 | 143 | 143 | 0 |

A/B are the inherited INSENSITIVE controls. **F is the group this change needs**
and was chosen for it: the parameter-DEFAULT corpus (the semantics arm 1
changes) plus the dynamic-CONSTRUCT corpus (`Reflect/construct`, the other way
into the same trampolines). Its 3 `compile_error` cells are identical on both
labels.

**Byte A/B — the control the corpus cannot give, in both directions:**

| artifact | base | branch | |
| --- | --- | --- | --- |
| standalone, dynamic `new` + defaulted STRING formal | `ffbf7bc2…` 210,032 B | `766f1ee9…` 210,375 B | **moved** |
| standalone, dynamic `new` + defaulted OBJECT formal | `688fa998…` 210,398 B | `f96abaa9…` 210,748 B | **moved** |
| standalone, dynamic `new`, `f64` formals ONLY | `792a1803…` 210,205 B | identical | the arming gate |
| standalone, same class, NO dynamic `new` site | `9f9cb3bb…` 138,431 B | identical | |
| **gc lane, the SAME armed string-formal source** | `096400ac…` 5,704 B | identical | the lane gate |
| **gc lane, the SAME armed object-formal source** | `b9463566…` 6,236 B | identical | the lane gate |
| **linked provider, class with a defaulted ref formal** | `e8af7103…` 155,982 B | `1147f0ee…` 156,546 B | **moved** |
| linked provider, no class at all | `f765e43d…` 157,098 B | identical | |

Exactly the three armed artifacts move; every unarmed one is byte-identical,
including both gc-lane artifacts compiled from the same armed sources.

**The `f64`-formals-only row is a fix, not a decoration.** The first cut armed
at every dynamic `new <value>` site and that module moved **+232 B** — a
TypeError message string it could never reach. `moduleHasRefTypedConstructFormal`
now gates both arming sites; it reads `structMap` (filled by
`collect-declarations`) rather than `classObjectGlobals`, which is materialised
LAZILY and is still empty at the expression site that arms the guard.

**Temporal provider**: `dc159623…` 3,307,526 B → `a7bd3c5f…` 3,308,117 B
(**+591 B**) — the provider artifact is SUPPOSED to move here, and that is the
second half of a finding, not a caveat: see §6.

**Corpus byte A/B**: 42 modules × {gc, standalone} = **84 artifacts, 0 move**. As
in S24–S27 this is a NULL control and saying only "0 moved" overstates it: no
module in that corpus constructs from a runtime value into a ref formal. The
byte table above is what shows the change does anything.

**Equivalence gate**: 22 failing / 1,720 passing / 22 known-failures — baseline
exactly.

#### 6. The arming site the expression could not reach — and how it announced itself

The first working cut fixed the single-module reduction completely and moved
**nothing** across the link: all 13 corpus-wide rows still trapped in
`__class_construct_dispatch`. The tell was one number in the prewarm stamp —
the provider artifact was **byte-identical** to S26's and S27's.

`classConstructWanted` turns the construct trampolines on for *two* reasons: a
`new <value>` site in THIS module, or `ctx.exportsConsumedByWasm` — and in the
second case the dynamic caller is in another module entirely
(`__js2wasm_link_construct`, provider side). The `@js-temporal/polyfill` provider
compiles **no dynamic `new <value>` site of its own**, so arming at the
expression site never fired in the artifact that needed it.

`armExternRefArgTypeGuardForLinkedProvider` runs post-bodies in BOTH codegen
paths. Post-bodies rather than at finalize because building the throw
materialises an error constructor; no `fctx` to flush against because no body is
live there, and none is needed: under `semanticProviders: "native-first"`
`__new_TypeError` routes to `emitWasiErrorConstructor` (a DEFINED function, no
import, no index shift), and with `nativeStrings` the message adds a string-pool
entry rather than an imported global.

**Generalisation worth carrying**: for anything gated on "this module compiles
X", ask whether the PROVIDER spelling of the same feature has an X at all. Three
slices' worth of link-boundary work (S17, S18, S24) each turned on a
provider-side path whose trigger lived on the consumer side.

#### 7. Residuals, each reduced rather than listed

**(a) The same hard cast has at least three more homes, and they are NOT this
module's** (measured, `.tmp/s28/cases-b.mjs`, one module per case, unchanged by
this slice):

| dynamic entry | defaulted `string` formal given `1` |
| --- | --- |
| class construct trampoline | **fixed here** |
| `o.m(1)` closed-method dispatcher | fixed here **when the module is armed**; otherwise still traps |
| `f(1)` through a plain-`function` value | traps — the closure bridge, a different marshal |
| `K.s(1)` static method through a value | traps — same closure bridge |
| `(x = "a") => …` arrow through a value | **already correct** — arrow formals are externref |

The arming gate is a CONSTRUCT-formal predicate, so the method dispatcher rides
along only when some class in the module also has a ref-typed constructor
formal. That is arbitrary, and it is stated as arbitrary: it is strictly better
than the previous trap everywhere it fires, and never worse anywhere it does
not.

**(b) A defaulted ref formal still cannot express `null`, and this is
structural.** The callee's prologue fires a ref-typed default on `ref.is_null`,
so a typed null is indistinguishable from "absent" — passing null would silently
apply the default, which is exactly what the spec forbids. Arm 3 therefore
throws for `null`, which is also what `calendar-wrong-type.js` wants. Pinned as
an executable expectation in the witness so a future widening that CAN carry
null has to update it.

**(c) The secondary candidate the brief named is TWO mechanisms, and neither is
this one** (`constructor.js: Expected a TypeError`, 3 rows / 16 files —
reduced, `.tmp/s28/cases-d.mjs`):

- the 3 `constructor.js` rows are `Temporal.PlainDate(1970, 1, 2)` — a class
  called AS A FUNCTION, which must throw because NewTarget is undefined. In ONE
  module that **already throws TypeError correctly**, so the rows are the
  CROSS-LINK spelling: a class reached through a provider namespace and called,
  not constructed. That is the call-side twin of #6612's IsConstructor guard,
  at the link boundary;
- the 2 `invalid-type.js` rows in the same bucket ARE this marshal — on the
  **f64** lane, failing in the opposite direction. `new Temporal.Duration(Symbol())`
  and `(1n)` answer `NaN` where ToNumber must throw a TypeError, because
  `__unbox_number` is silently lenient. Deliberately untouched here: making the
  f64 arm throw changes the bytes of every numeric dynamic argument in every
  module, which is a slice of its own.

The S26 amendment applies again — a bucket NAME measures a coalition. This time
the coalition split 3/2 across two unrelated causes.

#### 8. Residual buckets, branch tree, all four families (57 rows, 37 buckets)

| bucket | rows | file-name footprint corpus-wide | reduced to |
| --- | --- | --- | --- |
| `Proxy get trap is not callable` | 6 | `order-of-operations.js` 63 + `observable-get-overflow-argument-primitive.js` 5 | not reduced; standalone Proxy support, a slice of its own |
| `Built-in objects must be extensible` | 3 | `builtin.js` 129 | not reduced |
| `Expected a TypeError … no exception` | 3 | `constructor.js` 16 | §7c: a class CALLED as a function across the link — correct module-locally |
| `Expected a RangeError … no exception` | 3 | mixed | not reduced |
| `Cannot read properties of undefined (reading 'apply'/'equals')` | 4 | `subclassing-ignored.js` 45 + `math-order-of-operations-*.js` | not reduced |
| 33 further buckets | ≤2 each | | |

**Recommended next slice: the `Proxy get trap is not callable` bucket** (6 rows,
68 files corpus-wide). It is now the largest by both measures and the only one
left whose size and mechanism plausibly coincide — but it is unreduced
standalone-Proxy work, so **size it by reducing one `order-of-operations.js` row
in a single module before committing to it** (the S26 amendment). The cheaper
alternative with a named mechanism already in hand is §7c's f64-lane twin:
`__unbox_number` must throw a TypeError for a Symbol or a BigInt instead of
answering `NaN`. Small, reduced, and it is the same defect family this slice
only half-closed.

#### 9. Traps, carried forward and added to

Everything in S26 §Traps and S27 §9 still holds. One addition:

- **A prewarm stamp's `bytes` is a free before/after check on the PROVIDER
  half of any linked fix, and it is the fastest one available.** A provider
  artifact that is byte-identical to the previous slice's means the compiler
  change did not reach it — a complete answer in ~30 s, before any test262 row
  runs. It is how §6 was found; running the 13-file corpus first would have cost
  12 minutes to say the same thing less precisely.

### S29 findings (2026-09-15) — the tenth cause is a missing argument ABI: a spread into a STATIC or OBJECT-LITERAL method was bound as ONE argument. Four families 423 → 423; the 45-file target family is now ONE cause away, and that cause is named

Full write-up in
[#6616](6616-standalone-static-objlit-spread-and-static-rest-abi.md). Branch
`issue-5383-standalone-temporal-s29`, based on S28's tip `11fcafe07c`; the fix
is commits `349b3f3c66` + `433d83525f`.

**The headline is flat and that is the finding, not a failure to report one.**
The dispatched bucket is retired to zero corpus-wide, the 45-file target family
moves as a body — but it moves from one failure to the NEXT failure, because a
second, unrelated cause sits behind the first. Reporting +0 with the successor
cause named and sized is the honest result; reporting the bucket retirement as a
win would not be.

#### 1. The defect — two halves of the known-callee argument ABI, missing from four arms

test262's `temporalHelpers.js` forwards through its own object literal:

```js
checkSubclassingIgnoredStatic(...args) { this.checkStaticInvalidReceiver(...args); }
checkStaticInvalidReceiver(construct, method, methodArgs) {
  const result = construct[method].apply(value, methodArgs);
```

`TemporalHelpers` is an OBJECT LITERAL, so `this.checkStaticInvalidReceiver(...args)`
is an object-literal method reached with a spread — and that arm never flattened
it. Each argument NODE was bound to one formal, so `construct` received the whole
rest ARRAY and `method` received `undefined`; `construct[method]` was therefore
`undefined` and the closed-method dispatcher's nullish-receiver guard threw

    TypeError: Cannot read properties of undefined (reading 'apply')

which is the bucket name — raised at the CALL SITE, not at the member read
everyone (including this brief) assumed.

Reduced to ONE module, no link, no Temporal:

```js
const H = { m2(a, b) { … }, fwd(...args) { return this.m2(...args); } };
H.fwd(1, 2);                 // base: "1,2/undef"
H.m3(...[1, 2, 3]);          // base: "[object Object]/undef/undef" — a TUPLE struct
class K { static s2(a, b) { … } } K.s2(...xs);   // base: "1,2/undef"
class K2 { static f(...args) { return args.length; } } K2.f(1, 2);
                             // base: TRAP dereferencing a null pointer
```

The last line is the second half: the static-through-a-class-object arm also
never materialised the hidden REST vec, so a `static f(...rest)` formal arrived
**null** — with no spread at the call site at all. Object-literal methods, plain
functions and instance methods were all already correct; only the static arm was
missing it.

**The two halves had to ship together, and that is a result rather than a
convenience.** Fixing the spread alone turned
`static fwd(...args) { return K.m2(...args); }` from a wrong value into an
**uncatchable trap** — the flattened path actually READS the rest formal.
Measured in that intermediate state, before the second half landed. A trap is
worse in kind than a wrong value, so a spread-only slice would have been a
regression in failure MODE even where the row failed either way.

#### 2. The fix — four arms, each a copy of what the class-INSTANCE arm already had

| file | arm | `paramOffset` | added |
| --- | --- | --- | --- |
| `call-namespace-static.ts` | static through a class-object identifier | 0 | spread **+ rest** |
| `call-receiver-method.ts` | static (class arm) | 0 | spread |
| `call-receiver-method.ts` | struct receiver, nullable | 1 | spread |
| `call-receiver-method.ts` | struct receiver, non-nullable | 1 | spread |

`compileSpreadCallArgsWithArguments` first when the callee reads `arguments`
(#5093 — it publishes a RUNTIME `__argc` and the extras split), else
`compileSpreadCallArgs`; extras loop, default padding and
`maybeSetArgcForKnownCall` gated off when either path claimed the arguments.

**Bounded by construction, not by sampling**: the new code is reached only at a
call site carrying a `SpreadElement`, or a static callee declaring `...rest`.
Every such site was previously wrong — a wrong value, a module that did not
validate, or a null-deref trap. There is no site where the old path was right
and the new path differs.

#### 3. The result

| family (first 120 files) | base | branch | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `PlainDate/**` | 109 | 109 | 0 | 0 | 0 |
| `Duration/**` | 100 | 100 | 0 | 0 | 0 |
| `PlainDateTime/**` | 111 | 111 | 0 | 0 | 0 |
| `ZonedDateTime/prototype/**` | 103 | 103 | 0 | 0 | 0 |
| **total** | **423** | **423** | **0** | **0** | **0** |

The base reproduces S28's branch family for family (109/100/111/103), measured
HERE by file-copy revert on both labels rather than inherited. No
`compile_error`, no `timeout`, and no `__temporal_*` leak in any of the 960 rows.

**The 57 residual rows are not unchanged — 6 of them moved bucket:**
`Cannot read properties of undefined (reading 'apply')` **2 → 0**, and four
`year result: Expected SameValue(«N», «N,N,MN…»)` rows — whose expected value was
literally the STRINGIFIED ARRAY, the mis-binding showing through the assertion
message — now report distinct real values.

**Corpus-wide, the two target families (61 files, per file, both labels):**

| | base | branch | Δ |
| --- | --- | --- | --- |
| 45 `subclassing-ignored.js` + 16 `constructor.js` | **8 pass** | **8 pass** | 0, 0 flips |

and the bucket table for those 61 rows moves in exactly one place:
`Cannot read properties of undefined (reading 'apply')` **10 → 0**. Every other
bucket is identical count for count.

#### 4. Where the 45-file family now stops — the successor cause, named and sized

All **45** `subclassing-ignored.js` files now fail on **one** assertion, the
helper's last line:

```js
assert.sameValue(Object.getPrototypeOf(result), construct.prototype);
// «null» vs «undefined»
```

`Object.getPrototypeOf(<instance produced by a linked provider class>)` answers
**null**, and `construct.prototype` through the real polyfill answers
**undefined**. Reduced in a synthetic linked pair (`.tmp/s29/cases-j.mjs`), where
the split is sharper: `NS.PD.prototype` IS a value, but
`Object.getPrototypeOf(new NS.PD(1))` is `null`, `… === NS.PD.prototype` is
false, and `new NS.PD(1) instanceof NS.PD` is **"no"** — despite #5354 having
landed linked-class `instanceof`. So the prototype LINK of an instance minted by
a provider class is not visible to the consumer.

That is the whole remaining distance for this family: 45 files, one cause, and it
is the largest single-cause block left in the Temporal corpus.

#### 5. Controls

**Must-not-move — 270 rows, three groups, per file, both labels, 0 flips.**

| group | rows | base pass | branch pass | flips |
| --- | --- | --- | --- | --- |
| A: `Object/keys` + `expressions/object` + `Reflect/{get,has}` | 60 | 56 | 56 | 0 |
| B: `Object/{entries,values,getOwnPropertyNames}` + `statements/for-in` | 60 | 50 | 50 | 0 |
| **C: `Function/prototype/{apply,call,bind}` + `Reflect/apply` + `class/subclass`** | 150 | 140 | 140 | 0 |

C is the group this change needs and was chosen for it: the whole
apply/call/bind corpus plus the subclass corpus — the two places an argument-ABI
change would surface first. A and B are the inherited insensitive controls.

**Byte A/B — the control the corpus cannot give, in BOTH directions and on BOTH
lanes:**

| source | lane | base | branch | |
| --- | --- | --- | --- | --- |
| object-literal method + spread | standalone | `f3f88147` 139,937 B | `6689bda2` 140,134 B | **moved** |
| object-literal method + spread | gc | `d1c05435` 4,889 B | `0c5cf864` 4,947 B | **moved** |
| static method + spread | standalone | `66cfa41f` 135,753 B | `cc4187a7` 135,950 B | **moved** |
| static method + spread | gc | `e84770ba` 6,616 B | `6e8eff20` 6,673 B | **moved** |
| static `...rest` formal | standalone | `d3fc081b` 50,499 B | `84e59444` 50,601 B | **moved** |
| static `...rest` formal | gc | `8e543f09` 6,324 B | `5bf92378` 6,333 B | **moved** |
| the SAME callees, positional call (objlit) | both | `be897334` / `a57491fa` | identical | |
| the SAME callees, positional call (static) | both | `cb2586f0` / `177b6130` | identical | |
| object-literal `...rest` (the arm already right) | both | `1cdadc99` / `5695616f` | identical | |
| INSTANCE method + spread (the arm already right) | both | `1b4f999d` / `daf10f35` | identical | |
| plain FUNCTION + spread (a different arm) | both | `e38b5fe2` / `8da4de1c` | identical | |

**The gc lane moves here, deliberately, and that is a departure from S24–S28.**
Every earlier slice in this stack gated its change to standalone and pinned gc
byte-identical. This defect is **not lane-specific** — `H.m2(...xs)` bound the
array into formal 0 on the WasmGC lane too — so gating it to standalone would
have left the same wrong answer in the default lane in order to protect a
control that was measuring lane-independence, not safety. The five unarmed rows
being byte-identical on both lanes is what actually bounds the change.

**Corpus byte A/B**: 42 modules × {gc, standalone} = **84 artifacts, 0 move**.
As in S24–S28 this is a NULL control and "0 moved" overstates it: no module in
that corpus spreads into a static or object-literal method. The table above is
what shows the change does anything.

**Provider artifact**: `a7bd3c5f…` 3,308,117 B on BOTH labels — **byte-identical,
and correctly so.** S28 §9 reads a byte-identical provider as "the fix did not
reach it"; here it means the fix has no business there. The forwarding object
literal is in the test262 HARNESS, which compiles into the CONSUMER module; the
pre-transpiled `@js-temporal/polyfill` provider contains no such site. The check
is still the right first move — it just answers "which side", not "wired or not".

**Equivalence gate**: 22 failing / 1,720 passing / 22 known-failures — baseline
exactly.

**Witness**: `tests/issue-6616-static-objlit-spread-rest-abi.test.ts`, 8 `it`s.
Run against the reverted base: **6 fail, 2 pass** — the six teeth-bearing ones
fail with exactly the values recorded in their comments (including the linked
one reproducing `Cannot read properties of undefined (reading 'apply')`), and
both controls pass on both trees.

#### 6. Which clause of the hand-off was wrong

The brief's mechanism for family 1 was **wrong, and wrong in an instructive
way**. It proposed: "a PROVIDER function value reached through the link has no
`apply`/`call` member — the member GET path needs S22's `Function.prototype`
fallback." Measured (`.tmp/s29/cases-a.mjs`, linked pair):

- `Object.getPrototypeOf(NS.pf)` **is** `Function.prototype` — S22's fix is
  there;
- `typeof NS.PD.from.apply` **is** `undefined` — so the member-GET claim is
  literally TRUE;
- and it is **irrelevant**, because `f.apply(…)` as a CALL never reads that
  member. Every spelling works in a single module on the BASE tree
  (`plain.apply`, `arrow.apply`, a static through a value, an object-literal
  method through a value). The failing rows never got that far: the receiver was
  already `undefined` two frames up.

The generalisation is a cheap one this stack keeps re-buying: **a bucket named
after a member read may be a call-site defect.**
`Cannot read properties of undefined (reading 'X')` is emitted by
`closed-method-dispatch.ts` for a NULLISH RECEIVER, so it names where the
receiver was CONSUMED, not where it was produced.

The brief's family-2 clause (`constructor.js`, "a class CALLED as a function
across the link") was **not reached** — 8 of those 16 files already pass and the
other 8 are unchanged here. The f64 `__unbox_number` twin was left untouched, as
instructed.

#### 7. Residual buckets, branch tree, all four families (57 rows)

| bucket | rows | file-name footprint corpus-wide | reduced to |
| --- | --- | --- | --- |
| **`Object.getPrototypeOf` of a linked-class instance is null** | 4 (+35 already there) | **`subclassing-ignored.js` 45 — the whole family** | §4, reduced in a synthetic linked pair |
| `Proxy get trap is not callable` | 6 | `order-of-operations.js` 63 + `observable-get-overflow-argument-primitive.js` 5 | not reduced; standalone Proxy support |
| `Built-in objects must be extensible` | 3 | `builtin.js` 129 | not reduced |
| `Expected a TypeError … no exception` | 3 | `constructor.js` 16 (8 already pass) | S28 §7c; untouched here |
| `Expected a RangeError … no exception` | 3 | mixed | not reduced |
| `Cannot read properties of undefined (reading 'equals')` | 2 | `math-order-of-operations-*.js` | NOT the `apply` cause — a chained `zdt[op](…)` returning undefined |
| ~30 further buckets | ≤2 each | | |

**Recommended next slice: §4's prototype link.** It is the only candidate whose
size and mechanism are both already established — 45 files, one assertion, and a
reduction in hand (`.tmp/s29/cases-j.mjs`) showing `instanceof` across the link
failing for a provider-minted instance despite #5354. Every other bucket is
either unreduced (Proxy, extensibility) or ≤3 rows.

#### 8. Traps, carried forward and added to

Everything in S26 §Traps, S27 §9 and S28 §9 still holds, with one correction and
two additions:

- **CORRECTION to S28 §9.** A byte-identical provider does *not* always mean the
  fix failed to reach the corpus. It means the fix did not reach the PROVIDER —
  which, for a defect living in the test262 harness (consumer-side), is the
  expected answer. Keep running the check first; read it as "which side", not as
  "wired or not".
- **Instrumentation can be broken in the module you are instrumenting.** A probe
  written as `function t(x) { return typeof x; }` answered **`null`** for every
  argument inside the assembled test262 harness module — while the identical
  function is correct in an ordinary module and in a linked pair. Two probe
  generations were spent reading that noise as signal. When a probe's answers
  are impossible (a `typeof` that is none of the eight values), suspect the
  probe's own lowering before the subject's. Filed as a residual on #6616.
- **Module CONTENT changes answers, again, and this time it nearly decided a
  diagnosis.** The arity-2 object-literal spread "still failed" after the fix in
  a shared-prelude probe and was clean in its own module — the shared prelude
  carried several object literals with methods, which is an independent
  interference. One module per case is not hygiene here; a shared prelude would
  have sent this slice chasing a defect it had already fixed.

### S30 findings (2026-09-15) — the eleventh cause is an identity the OWNER alone can answer. Four families 423 → 423; the 45-file family is fixed on the assertion it stops at and stops one cause EARLIER instead

Full write-up in
[#6617](6617-standalone-linked-class-instance-prototype.md). Branch
`issue-5383-standalone-temporal-s30`, based on S29's tip `15d7c211ff`; the fix
is commits `29141ed3fc` + `518ac029d1`.

**The headline is flat for the second slice running, and the reason is
different from S29's.** S29 retired its bucket and the family moved to the NEXT
failure. S30 fixes the assertion that family stops ON — verified against the
real polyfill, not only synthetically — and the family still does not move,
because a SECOND, upstream cause kills the row two lines earlier. Both halves
are needed; this one is now done and the other is reduced.

#### 1. The defect — the prototype link of a compiled class instance is invisible to every dynamic reader

`Object.getPrototypeOf(x)` under `--target standalone` answered correctly only
where the CHECKER could name `x`'s class. Reduced to ONE module, no link, no
Temporal (`.tmp/s30/cases-a.mjs`):

```js
class C { constructor(y) { this.y = y; } }
const NS = { C };
Object.getPrototypeOf(new C(1)) === C.prototype;   // true  — the static fold
Object.getPrototypeOf(NS.C ? new C(1) : null);     // null  ← the gap
```

The generic native `__getPrototypeOf` walks `$Object.$proto`; a compiled class
instance is a closed `$ClassName` struct with no such field. `ref.test $Object`
fails, the #4643 fnctor ladder answers null, the boundary import is absent — so
the helper answered `null`. Across the link that is total, because no value that
crosses the seam has a checker type at all.

**The brief's mechanism was RIGHT, and its file was wrong in a way worth
recording**: it named `src/codegen/object-get-prototype-of.ts`, which does not
exist — the expression-level folds live in
`src/codegen/expressions/object-get-prototype-of.ts`, and the defect is not
there at all. It is in the RUNTIME helper
(`object-runtime-prototype.ts::buildObjectPrototypeHelpers`), which is exactly
what the brief's own sentence about "`__getPrototypeOf`'s `$proto` walk decodes
`$Object` receivers only" describes. Second inherited attribution in the stack
to survive reduction (after S28's).

#### 2. The fix — the standalone twin of a host-lane dispatcher, plus the hop

| file | what |
| --- | --- |
| `standalone-class-instance-proto.ts` (new) | `__std_class_instance_proto`: `ref.test` + `__tag` + `ref.eq` cascade, most-derived first, declines the class OBJECT, builds the singleton via `__class_proto_build_<C>`; prepended to `__getPrototypeOf` |
| `standalone-link-boundary.ts` | terminal `__js2wasm_link_get_prototype_of`, reserved with the miss body, filled at finalize |
| `object-runtime.ts` | consumer miss arm: `boundaryObjectGetPrototypeIdx ?? peerGetPrototypeOfIdx` |
| `expressions/call-builtin-static.ts` | the generic site raises the per-class prototype demand (#6457's arming twin) |

The terminal wraps the DISPATCHER, not the provider's `__getPrototypeOf`. That
distinction is the correctness argument: the consumer reaches the terminal only
after its own answer was null, so anything returned replaces a null — and the
wider wrapper would hand back the PROVIDER's `%Object.prototype%`, a foreign
intrinsic the consumer can never name.

#### 3. The result

| family (first 120 files) | base | branch | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `PlainDate/**` | 109 | 109 | 0 | 0 | 0 |
| `Duration/**` | 100 | 100 | 0 | 0 | 0 |
| `PlainDateTime/**` | 111 | 111 | 0 | 0 | 0 |
| `ZonedDateTime/prototype/**` | 103 | 103 | 0 | 0 | 0 |
| **total** | **423** | **423** | **0** | **0** | **0** |

Base measured HERE by file-copy revert to `HEAD~1` on both labels, and it
reproduces S29's branch family for family. No `compile_error`, no `timeout`, no
`__temporal_*` leak in 960 rows. **The 34-bucket residual message table is
identical count for count** — not one bucket moves, which for a change this
narrow is the expected reading, not a disappointment.

**Corpus-wide, the 45 `subclassing-ignored.js` (per file, both labels): 0 → 0
pass, all 45 messages byte-identical.**

#### 4. Why the family did not move, and the proof that the fix is real

Against the REAL polyfill in one consumer module (`.tmp/s30/t/p1.js`):
`gpoInst=object match=true matchR=true` — i.e.
`Object.getPrototypeOf(new Temporal.Duration(1)) === Temporal.Duration.prototype`
is now **true**. The rows die two lines earlier, in the harness's own
`checkSubclassConstructorNotObject`, where `construct.prototype` reads
`undefined` and `new construct(...constructArgs)` answers `null`
(`.tmp/s30/t/p2.js`: `c=function cProto=undef … instT=null resT=null`).

That read is CONTENT-SENSITIVE — `c.prototype` answers `undef` in a module whose
only member read it is, and `object` as soon as the module also contains any
static two-level member read, a read of a different class, a dynamic read of a
sibling member, or a second copy of itself (`p4`–`p10`). The synthetic linked
pair does not reproduce it. Filed as #6617 R1 with all six reductions rather
than chased: it is a different mechanism, and the instability already cost one
probe generation read as signal.

#### 5. Controls

**Must-not-move — 270 rows, four groups, per file, both labels, 0 flips.**

| group | rows | base pass | branch pass | flips |
| --- | --- | --- | --- | --- |
| A: `Object/keys` + `expressions/object` + `Reflect/{get,has}` | 60 | 58 | 58 | 0 |
| B: `Object/{entries,values,getOwnPropertyNames}` + `statements/for-in` | 60 | 47 | 47 | 0 |
| C1: `Object/{getPrototypeOf,setPrototypeOf}` + `Object/prototype/isPrototypeOf` | 47 | 44 | 44 | 0 |
| C2: `expressions/instanceof` + `statements/class/subclass` | 103 | 70 | 70 | 0 |

**Targeted byte A/B**: ONE of twelve artifacts moves — the armed standalone
module (`c922c20b` 200,869 B → `dee9a486` 201,067 B). The static fold, the
no-class module, the class-without-the-query module, the dynamic MEMBER read and
`setPrototypeOf` are all identical, and **the entire gc lane is identical**.
That is a deliberate return to the S24–S28 posture after S29's lane-independent
fix: the host lane already answers this through `__class_instance_proto`
(#5347), so a shared fix would be a second mechanism for a solved problem.

**Corpus byte A/B**: 42 modules × {gc, standalone} = 84 artifacts, 0 move — a
NULL control, stated as such: nothing in that corpus asks the question.

**Provider artifact**: 3,308,117 B → 3,311,079 B (+2,962 B), `cacheHit=false` on
both prewarms. A MOVED provider is the right reading here (S28 §9 / S29's
correction): the instance's owner is the only module that can answer, so the
change has to be on that side.

**Equivalence gate**: 22 failing / 1,720 passing / 22 known-failures — baseline
exactly, on both trees.

**Witness**: `tests/issue-6617-class-instance-prototype.test.ts`, 13 `it`s.
Against the reverted base: **8 fail, 5 pass**.

#### 6. Residual buckets, branch tree, all four families (57 rows, 34 buckets)

Unchanged from S29 count for count. The `subclassing-ignored.js` family's blocker
is now **#6617 R1** (`construct.prototype` → `undefined`, content-sensitive),
not the prototype link. The other named residuals are #6617 R2 (`instanceof`
across the link — `__instanceof_dynamic` walks `$Object.$proto` through
`__isPrototypeOf` and so does NOT compose out of the now-correct
`__getPrototypeOf`), R3 (`isPrototypeOf`, same root), R4 (a module-local dynamic
`.constructor`), R5 (`getPrototypeOf` of a union-typed plain object).

#### 7. Traps, carried forward and added to

Everything in S26–S29 still holds, with one addition:

- **A file named in a brief may not exist, and the nearby file that does may be
  the wrong layer.** Two `object-get-prototype-of.ts`-shaped things exist here —
  the EXPRESSION folds (`expressions/`) and the RUNTIME helper
  (`object-runtime-prototype.ts`). The brief named a path that is neither. Grep
  for the SYMBOL (`__getPrototypeOf`), not the filename.
- **A byte-identical gc lane can be the right answer for a reason other than
  gating.** Here the host lane is not missing the fix — it has had its own since
  #5347. "Which lane needs this" is a question about where the answer already
  exists, not only about where the flag is set.

### S31 findings (2026-09-16) — the twelfth cause is the CALL-side twin of #6612: a class reached through `ns.C()` fell through to `__apply_closure`'s legacy null instead of throwing. Four families 423 → 426; the 16-file `constructor.js` family goes 8 → 16 of 16

Full write-up in
[#6618](6618-standalone-class-through-method-call-no-throw.md). Branch
`issue-5383-standalone-temporal-s31`, based on S30's tip `bc2f314de8`; the
fix is commit `0728f3094e`.

#### 1. The defect

Three ways to reach a class VALUE dynamically and call it without `new`; only
the third missed §10.2.1 step 2's TypeError:

| shape | mechanism | answered |
| --- | --- | --- |
| `C()` | `class-call-without-new.ts` (#4483) | throws |
| `const f = C; f()` | `wantIsCallableGuard` (#6420) | throws |
| `ns.C()`, `ns` a linked provider namespace | `__extern_method_call`'s guard (`resolved-callee-guard.ts`) | **null** |

`Temporal.PlainDate(1970, 1, 2)` is exactly the third shape — 8 of the 16
`built-ins/Temporal/**/constructor.js` files, one per class, all failing
identically: `Expected a TypeError to be thrown but no exception was thrown
at all`. Measured directly against `compileWithTemporalGlobal` (the same
machinery the test262 runner uses): `const f = Temporal.PlainDate; f(1,1,1)`
already threw; `Temporal.PlainDate(1,1,1)` did not — proof the defect is the
method-call arm, not the class/callable classifier (which was already
correct in both directions, module-locally and across the link).

#### 2. The fix

`resolved-callee-guard.ts`'s `buildResolvedCalleeGuard` gained one arm,
alongside its existing primitive-brand checks: when `__typeof_function` and
`__is_callable` are both already registered, throw when the resolved callee
is `typeof_function() && !is_callable()`. The two natives share every
classifier arm except one — `__is_callable` excludes a class-constructor
identity that `__typeof_function` includes — so that conjunction can only be
true for a class, and stays silent (not a wrong throw) for anything the
callable classifier fails to recognise, since `__typeof_function` is built
from the same base arms and would miss it too.

#### 3. The result

| family (first 120 files) | base | branch | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `PlainDate/**` | 109 | 110 | +1 | 0 | 1 |
| `Duration/**` | 100 | 101 | +1 | 0 | 1 |
| `PlainDateTime/**` | 111 | 112 | +1 | 0 | 1 |
| `ZonedDateTime/prototype/**` | 103 | 103 | 0 | 0 | 0 |
| **total** | **423** | **426** | **+3** | **0** | **3** |

`ZonedDateTime/prototype/**` has no `constructor.js` of its own (that file is
one level up, in the 16-file family). No `compile_error`, no `timeout`, no
`__temporal_*` leak in 960 rows.

**Corpus-wide, the 16 `constructor.js` files, per file, both labels: 8 → 16,
+8, 0 pass→fail.**

#### 4. Controls

**Must-not-move, per file, both labels, 0 flips.**

| group | rows | base pass | branch pass | flips |
| --- | --- | --- | --- | --- |
| A: `Object/keys`(30) + `expressions/object`(30) + `Reflect/{get,has}`(21) | 81 | 77 | 77 | 0 |
| B: `Object/{entries,values}`(41) + `getOwnPropertyNames`(30) + `for-in`(30) | 101 | 81 | 81 | 0 |
| C: `expressions/call`(92) + `statements/class`(100) + `Function/prototype/call`(49) | 241 | 192 | 192 | 0 |

#### 5. Byte A/B — not a null control this time

Targeted: the armed case (`ns.C()`) moves (+42 B standalone). Three UNARMED
controls ALSO move by the same amount — `f()` via a bare value, `ns.fn()`,
and `new ns.C(...)` — because the new check lives in the SHARED
`__extern_method_call` native's body, spliced once whenever both natives
happen to be registered, not gated per call site. Two controls stay
byte-identical (a class with no dynamic call site; a plain-object method call
in a module where neither native gets registered), confirming the
byte-neutral case documented in the file still holds where it applies. Every
`gc`-lane artifact, targeted and corpus, is identical. Corpus (42 modules ×
2 lanes): 14/42 standalone artifacts move, same mechanism — not a null
control, and reported as such rather than claimed as one.

**Equivalence gate**: 22 failing / 1,720 passing / 22 known-failures —
baseline exactly, on both trees.

**Witness**: `tests/issue-6618-class-through-method-call.test.ts`, 7 `it`s.

#### 6. Traps, carried forward and added to

Everything in S26–S30 still holds, with one addition:

- **A single-module reduction can be the WRONG reduction, three ways at
  once.** `const f = C; f()` (bare value) already worked before this fix; a
  same-module `NS.C()` compiled without a link reaches a THIRD path
  (`class-call-without-new.ts`) that also already worked. Only the
  MULTI-MODULE link shape (`ns.C()` where `ns` crosses the wasm→wasm
  boundary) was broken. Three near-identical one-liners, three different
  compile paths, one of them broken — reducing to the wrong one would have
  reported a false negative.

### S32 findings (2026-09-16) — the thirteenth cause: the f64 twin of #6615. Four families 426 → 427; R1 reduced past the S30/S31 hand-off but NOT fixed this slice (see #6619)

Full write-up in
[#6619](6619-standalone-f64-arg-marshal-symbol-bigint-throw.md). Branch
`issue-5383-standalone-temporal-s32`, based on S31's tip `4c91fc99c6`; the
fix is committed WIP `2d2f277396`.

**This slice spent its first probing budget on #6617's R1** (`construct.prototype`
answers `undefined`, content-sensitive) — the dispatch brief's designated
primary target — and reduced it substantially past the S30/S31 hand-off's
six one-variable probes to a single, precise trigger: **any dynamic
`new <any-typed-value>(...)` call ANYWHERE in the module** (not necessarily
on the same class, not necessarily in the same function) flips every dynamic
`.prototype` read on a provider-linked class from `object` to `undefined`.
Traced to `sourceHasDynamicTaConstruct` (`source-scan-predicates.ts`, #2872)
— a conservative whole-module TypedArray-construction pre-scan that cannot
distinguish "this dynamic `new` might be a TypedArray" from "this dynamic
`new` is definitely something else" and sets `ctx.moduleUsesDynTaView = true`
either way, which arms `proto-index-store.ts`'s companion/protoidx machinery
module-wide and roughly doubles `__extern_get`'s compiled body (1,656 →
3,473 WAT lines). The exact KEY-specific wrong arm inside that machinery
(ruled out: mis-registered boundary import, wrong `$Object` classification,
the S30 `__std_class_instance_proto` mechanism — none present) was not
pinned down within this slice's probing budget, so per the dispatch brief's
own fallback clause the slice moved to the f64 target rather than risk an
under-verified patch to a subsystem the codebase's own comments describe as
delicate. Full reduction, ruled-out list, and the exact next-step pointer
(`proto-index-store.ts`'s `__protoidx_get_k`/`__protoidx_companion`) are in
#6619's Residuals section — this is a running start for the next slice, not
a restart.

#### 1. The defect — `__unbox_number`'s Symbol/BigInt leniency reaches a SECOND caller with no guard

`new Temporal.Duration(Symbol())` / `(0n)` answered `NaN` (a Duration with
all-zero fields) where §7.1.4 ToNumber requires a TypeError
(`built-ins/Temporal/Duration/invalid-type.js`). #6615's own fix (S28)
already solved this for `ref`-typed dynamic construct/dispatch arguments;
the `f64` arm of the SAME marshal (`extern-arg-marshal.ts`'s
`externArgCoercionInstrs`) called `__unbox_number` directly, with no guard —
`__unbox_number` is deliberately lenient (it doubles as the numeric-key
probe for `__extern_set` on a vec receiver, which must NOT throw), so the
Symbol/BigInt guard has to live in the CALLER, exactly as
`tonumber-fast-paths.ts`'s `symbolThrowArm` already does for the GENERAL
ToNumber path. This dynamic construct/dispatch marshal had none.

#### 2. The fix — `__unbox_number_checked`, mirroring #6615's arming discipline exactly

`extern-arg-marshal.ts` gains `__unbox_number_checked(externref) -> f64`:
throws `TypeError` for a `$Symbol`/`$BigInt` operand, else calls
`__unbox_number`. Consulted only by the f64 arm, and only when
`moduleHasF64TypedConstructFormal` (new, `standalone-class-construct.ts`,
mirrors `moduleHasRefTypedConstructFormal` field for field) says this
module has an `f64`-typed construct formal to protect — an unarmed module
pays nothing. Two arming sites, the SAME two #6615 uses (the module's own
dynamic `new <value>` expression; post-bodies for a linked provider whose
consumer is wasm, since `@js-temporal/polyfill` compiles no dynamic `new`
site of its own). A defaulted `f64` formal composes with #5380's
omitted-argument sentinel: `ensureUnboxNumberOrOmitted` now takes the
checked funcIdx as its fallback, so `new C(undefined)` still runs the
default while `new C(Symbol())` on the same formal still throws.

#### 3. The result

| family (first 120 files) | base | branch | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `PlainDate/**` | 110 | 110 | 0 | 0 | 0 |
| `Duration/**` | 101 | 102 | +1 | 0 | 1 |
| `PlainDateTime/**` | 112 | 112 | 0 | 0 | 0 |
| `ZonedDateTime/prototype/**` | 103 | 103 | 0 | 0 | 0 |
| **total** | **426** | **427** | **+1** | **0** | **1** |

The single fail→pass is `Duration/invalid-type.js`. No `compile_error`, no
`timeout`, no `__temporal_*` leak in any row.

**Corpus-wide, the two files a Symbol/BigInt construct argument can reach**:
`Duration/invalid-type.js` (this fix — fail → pass) and
`Duration/from/invalid-type.js` (a DIFFERENT mechanism — `.from()` extracts
object-literal properties inside the provider's own body, never reaching
this marshal at all — unchanged, filed as R-from in #6619).

**The 45 `subclassing-ignored.js` files stay 0 → 0**, unchanged from
S30/S31 — R1 (not this slice's target) still blocks the family, and every
failure message is the SAME `SameValue(«null», «undefined»)` R1 already
names.

#### 4. Controls

**Must-not-move — 231 rows, four groups, per file, both labels, 0 real
flips** (22 raw diffs across groups B/C2 are a measurement-environment
artifact — this session ran `JS2WASM_EVAL_ENGINE=interpreter` with only the
refusal-only runtime-eval provider built, so every eval-dependent test in
those groups fails identically regardless of this fix; every one of the 22
carries the identical `dynamic code evaluation is not supported` detail
string).

| group | rows | base pass | branch pass | real flips |
| --- | --- | --- | --- | --- |
| A: `Object/keys` + `expressions/object` + `Reflect/{get,has}` | 81 | 77 | 77 | 0 |
| B: `Object/{entries,values}` + `getOwnPropertyNames` + `for-in` | 101 | 69 | 69 | 0 |
| C1: `Object/{getPrototypeOf,setPrototypeOf}` + `isPrototypeOf` | 47 | 44 | 44 | 0 |
| C2: `expressions/instanceof` + `statements/class/subclass` | 104 | 70 | 60 | 0 |

**Targeted byte A/B**: one of four synthetic artifacts moves — the armed
case (dynamic `new f(1)` into an `f64` construct formal): standalone
208,815 B → 209,079 B (+264 B). The unarmed-ref-formal control (dynamic
`new f("x")` into a `string`-only formal, no `f64` formal at all) stays
byte-identical, confirming `moduleHasF64TypedConstructFormal` gates
independently of #6615's ref-formal gate. Every `gc`-lane artifact is
identical.

**Temporal provider**: 3,311,079 B → 3,311,522 B (+443 B), `cacheHit: false`
on both prewarms — the provider is the module that needed the fix, exactly
as #6615's linked-provider arming site existed for the same reason.

**Corpus byte A/B**: 42 modules × {gc, standalone} = 84 artifacts, 0 moved —
a genuine null control this time: no module in that corpus constructs
dynamically from a runtime value into an `f64` formal.

**Equivalence gate**: 22 failing / 1,720 passing / 22 known-failures —
baseline exactly, on both trees.

**Witness**: `tests/issue-6619-f64-arg-symbol-bigint.test.ts`, 5 `it`s — 2
fix-witnesses (Symbol, BigInt) measured failing on the file-copy-reverted
base (`NaN`, no throw) and passing on branch; 3 controls (ordinary number,
omitted-argument default composition, static non-dynamic construct) pass on
both trees unchanged.

#### 5. Traps, carried forward and added to

Everything in S26–S31 still holds. One addition:

- **A module-wide pre-scan flag set for reason A can silently change
  behaviour for reason B, with no textual overlap between the two.** R1's
  reduction (§ above) found `sourceHasDynamicTaConstruct` — built to detect
  possible TypedArray construction — arming `proto-index-store.ts`'s
  unrelated prototype-companion machinery via a single shared boolean
  (`ctx.moduleUsesDynTaView`). Grep every consumer of a broad pre-scan flag
  before trusting that "my feature doesn't use TypedArrays" means "this
  flag never affects my feature."

### S33 findings (2026-09-16) — #6617 R1 FIXED: a bare `ref.test $__ta_ctor` collides with a field-less provider class's compiled root

Full write-up in
[#6620](6620-standalone-ta-ctor-brand-prototype-collision.md). Branch
`issue-5383-standalone-temporal-s33`, based on S32's tip `2d2f277396`.

#### 1. The reduction

Continuing S32's reduction of R1 (the trigger: ANY dynamic
`new <any-typed value>(...)` anywhere in the consumer flips every dynamic
`.prototype` read on a provider-linked class from `object` to `undefined`,
traced to `ctx.moduleUsesDynTaView` arming `proto-index-store.ts`'s
companion machinery), this slice bisected FURTHER:

1. **Forcing `ctx.moduleUsesDynTaView = true` with NO real dynamic
   construct anywhere in source** still broke a single, isolated
   `readProto(Temporal.PlainDate)` probe (zero other module content) —
   ruling out anything that needs an actual TypedArray-shaped syntax to
   fire, and ruling out `proto-index-store.ts`'s companion machinery
   specifically: two OTHER arming paths into that SAME store
   (`protoIndexDirty` via `Object.defineProperty(Array.prototype, …)`,
   `protoMemberDirty` via a bare `Array.prototype` read) did NOT break the
   probe, so whatever breaks it is unique to `moduleUsesDynTaView`, not
   shared store-reservation machinery.
2. Instrumenting `fillTaDynViewMopArms` (`ta-dyn-mop.ts`) confirmed
   `ctx.taDynViewTypeIdx` gets minted from the bare boolean alone (via the
   standalone link boundary's `Object.prototype.toString` classifier, which
   calls `getOrRegisterTaDynViewType` unconditionally once the flag is set —
   reserved for every provider-linked module, real TA construct or not).
3. **Disabling `fillTaDynViewMopArms` entirely** (flag still forced)
   restored the correct answer.
4. **Disabling ONLY its `$__ta_ctor` receiver arm** (~70 lines, the
   `TA.prototype`/`TA.BYTES_PER_ELEMENT` block) — every other dyn-view arm
   left active — ALSO restored correctness. Pinpointed.

That arm's receiver gate was a bare `ref.test $__ta_ctor`. `$__ta_ctor` is
`{kind: i32, brand: i32}` — EXACTLY the shape of a field-less class's
compiled root, `{__tag: i32, __shape_brand: i32}` (`class-bodies.ts`
#2158/#2009). Both shapes were independently widened to two i32 fields to
escape two DIFFERENT PRIOR collisions (`$__ta_ctor`'s own 1-field form
collided with `__box_boolean_struct`, #5194 r3 review F1; the empty class
root's 1-field form collided with `$AnyString`, #2158/#2009) — and the two
widened shapes then collided with EACH OTHER. `Temporal.Duration` compiles
to exactly this root shape (its numeric fields live in an expando
side-table, not native struct fields), so once armed, `ref.test $__ta_ctor`
on its class-object value returned true, and the arm's "prototype" key
check matched, returning the wrong TypedArray-view prototype glue instead
of falling through to `__js2wasm_link_member_get`.

**This exact collision was already discovered and fixed once.**
`taCtorIdentityTestInstrs` (`registry/types.ts`, #5194 r3 review F1) is a
brand-VALUE-checked identity test built FOR this exact shape collision — its
own doc comment measures the IDENTICAL symptom on THIS SAME provider
(`new qi.Duration(...)`/`new qi.PlainDate(...)` answering `typeof
"function"`). That fix landed at two call sites
(`builtin-callable-brand.ts`, `reflect-construct-native.ts`) but not at
`ta-dyn-mop.ts`'s `$__ta_ctor` receiver arm — the one this slice fixes.

#### 2. The fix

`ta-dyn-mop.ts`'s `$__ta_ctor` receiver arm now consults
`taCtorIdentityTestInstrs` (the established helper) instead of a bare
`ref.test`. Answer-preserving for a genuine TypedArray constructor value
(both mint sites write the brand); can only ever REMOVE a false positive.

#### 3. The result

| probe | base | branch |
| --- | --- | --- |
| dynamic `.prototype` read, armed by an unrelated `new c(1)` elsewhere | `undef` | `object` |
| same receiver, `.name` (control) | `string` | `string` (unchanged) |
| `.prototype` with no dynamic `new` anywhere (control) | `object` | `object` (unchanged) |
| a genuine `Uint8Array`/`Int32Array` `.prototype`/`.BYTES_PER_ELEMENT` (control) | `object`/`4` | `object`/`4` (unchanged) |

**Corpus-wide, all 45 `subclassing-ignored.js` test262 files**: every one
moved PAST the `.prototype` blocker — the failure message changed uniformly
from `SameValue(«null», «undefined»)` (R1's signature) to
`SameValue(«null», «null»)` (a DIFFERENT, already-documented residual: a
dynamic `new construct(...)` on a linked class value still answers a
receiver `SameValue` disagrees with — S30's hand-off already named this in
its own `p2` probe; #6619 names a sibling mechanism for `.from()`).
**0 → 0 pass for this family** — R1 is fixed and verified by the uniform
error-signature change corpus-wide, but this SECOND, distinct blocker still
stops the family from fully passing. Filed as R-construct in #6620, not
reduced further this slice (own repro budget needed).

A repo-wide grep for the same bare `ref.test` pattern against
`ctorIdx`/`taCtorTypeIdx` (excluding the `taCtorIdentityTestInstrs`-routed
sites) found 7 MORE unguarded consult sites (`dataview-native.ts` ×5,
`property-access-dispatch.ts`, `ta-ctor-meta.ts` ×2) — the SAME shape of
bug, none reduced to a concrete failing test262 row this slice. Filed as
R-other-bare-ref-test in #6620.

**Criterion 4** (full tables in #6620): four-family sample (first 120 each,
file-copy revert, fresh cache per label) — **427 → 427**
(110/102/112/103, 0 pass→fail, 0 fail→pass, 0 per-file flips), an honest
null for this sample (`subclassing-ignored.js` isn't among the first 120 in
any of the four families — the corpus-wide 45-file measurement above is
where R1's effect shows). Must-not-move: 1,136 rows across groups A/B
(`Object/keys`+`expressions/object`+`Reflect/{get,has}`,
`Object/{entries,values,getOwnPropertyNames}`+`for-in`) plus
`built-ins/TypedArray` (150) + `TypedArrayConstructors/ctors` (100) +
`expressions/member-expression` (1) + `statements/class/subclass` (100),
**0 flips**. Corpus byte A/B: 42 modules × {gc, standalone} = 84 artifacts,
**0 moved** (byte-identical both lanes). Provider bytes: base 3,311,522 B →
branch 3,311,544 B (+22 B — `ta-dyn-mop.ts` also runs during the
PROVIDER's own compile, since the polyfill carries the same internal
dynamic-TA-construct pattern).

**Equivalence gate**: unchanged from baseline (this fix touches only the
standalone `$__ta_ctor` receiver arm, `noJsHost`-gated, never reached by the
gc-target equivalence corpus).

**Witness**: `tests/issue-6620-ta-ctor-brand-prototype-collision.test.ts`, 4
`it`s — 1 fix-witness measured failing on the file-copy-reverted base
(`undef`, expected `object`) and passing on branch; 3 controls (`.name` on
the same armed receiver, a lone unarmed `.prototype` read, a genuine
TypedArray constructor) pass on both trees unchanged.

#### 4. Traps, carried forward and added to

Everything in S26–S32 still holds. One addition:

- **A struct shape widened to escape collision A is not proof against
  collision B with a DIFFERENT equally-widened shape.** `$__ta_ctor` was
  widened from 1 to 2 i32 fields to escape a collision with
  `__box_boolean_struct` (#5194 r3 review F1); a field-less class's root was
  independently widened from 1 to 2 i32 fields to escape a collision with
  `$AnyString` (#2158/#2009). The two widened shapes then matched EACH
  OTHER. When a struct carries a VALUE-level discriminator for exactly this
  reason (a `brand`/`TA_CTOR_BRAND` sentinel field), a bare `ref.test` alone
  throws that discriminator away — every consult of the struct's real
  IDENTITY needs the value check too, and a codebase-wide grep for the
  type's naked `ref.test` is how the other 7 sites in this slice's residual
  were found.

### S34 findings (2026-09-16) — R-construct FIXED: a runtime-length spread into a foreign/linked dynamic construct answered null. Four families 427 → 430; the 45-file family's NEXT blocker is verified directly and named, not chased

Full write-up in
[#6621](6621-standalone-dynamic-new-runtime-argv-spread.md). Branch
`issue-5383-standalone-temporal-s34`, based on S33's FINAL tip `020a8aba23`;
the fix is committed WIP `c59f1d3145`.

#### 1. The defect

`new construct(...constructArgs)` — test262's own
`checkSubclassConstructorNotObject` shape, `construct` and `constructArgs`
both PARAMETERS forwarded through two layers of `...args` — answered `null`
(or a field-less placeholder) whenever the spread's length could not be
resolved at compile time AND the callee was not a module-local class. Two
arms both had to decline for this shape to have no lowering at all:
`tryCompileNativeConstructFromValue` gave up unconditionally on ANY
unresolvable spread (`args.some(isSpreadElement) => return undefined`), and
`emitDynamicNewFallback` — the only other standalone dynamic-`new`
fallback — declines whenever the callee is not a LOCAL class and is never
even reached for a member-access callee in standalone at all. Blocks all 45
`built-ins/Temporal/**/subclassing-ignored.js` test262 files, pinned as
S30's `p2` probe and named "R-construct" in #6620.

#### 2. The fix

`native-construct.ts`'s existing `__class_construct_dispatch` /
`__js2wasm_link_construct` terminals were ALREADY arity-generic
(`(callee, argsVec, argc)`); only the call site lacked a way to build that
`argsVec` from a runtime-length call. One new module-level driver
(`__native_construct_argv`, `reserveNativeConstructDriverArgv` +
`fillArgvConstructDriver`) reuses those terminals unchanged, and a new
call-site helper (`buildRuntimeConstructArgvVec` in `new-super.ts`) builds
the runtime argv via the generic `__extern_length`/`__extern_get_idx`
reader pair — the same protocol `Object.groupBy`'s native helper already
uses for an arbitrary array-like source, so an untyped JS array PARAMETER
(the harness's `constructArgs`) works. Standalone/WASI only; the JS-host
lane already handles this correctly through `__construct_closure` and is
untouched.

#### 3. The result

| family (first 120 files) | base | branch | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `PlainDate/**` | 110 | 111 | +1 | 0 | 1 |
| `Duration/**` | 102 | 104 | +2 | 0 | 2 |
| `PlainDateTime/**` | 112 | 112 | 0 | 0 | 0 |
| `ZonedDateTime/prototype/**` | 103 | 103 | 0 | 0 | 0 |
| **total** | **427** | **430** | **+3** | **0** | **3** |

No `compile_error`, no `timeout`, no `__temporal_*` leak in 960 rows.

**The 45-file `subclassing-ignored.js` family stays 0 → 0** — verified
directly, not assumed, by injecting a debug throw into a disposable COPY of
the real `temporalHelpers.js` (never the shared `test262/` submodule
checkout): `new construct(...constructArgs)` now genuinely constructs a
real, field-populated instance with the CORRECT prototype link
(`Object.getPrototypeOf(instance) === construct.prototype` flips
false→true, a real constructor field flips `undefined`→a real value on the
branch tree) — the fix is reached and correct. The family's headline does
not move because the NEXT assertion is blocked by a SEPARATE, PRE-EXISTING
mechanism: a dynamically-constructed class value's `typeof` answers
`"function"` and `instanceof` answers `false`, identically on the UNFIXED
base tree for the ALREADY-WORKING no-spread/member-direct construct paths
too — matching S20 §4's already-documented "per-name ladder, no runtime
class test" residual, named there as "the next slice, and the first one
where the fix is in the hottest dispatch path in the compiler." Not chased
this slice.

#### 4. Controls

**Must-not-move — 1,684 rows, four groups, per file, both labels, 0 flips.**

| group | rows | base pass | branch pass | flips |
| --- | --- | --- | --- | --- |
| `Object/keys` + `expressions/object` + `Reflect/{get,has}` | 1,250 | 1,125 | 1,125 | 0 |
| `Object/{entries,values,getOwnPropertyNames}` + `for-in` | 205 | 179 | 179 | 0 |
| `language/expressions/new`(150) + `Reflect/construct` + `class/subclass`(100) | 169 | 120 | 120 | 0 |
| `built-ins/TypedArrayConstructors/ctors`(60) | 60 | 34 | 34 | 0 |

**Targeted byte A/B**: one of three synthetic artifacts moves — the armed
case (a spread through a param callee into a local class): standalone
140,670 B → 140,620 B. An unarmed no-spread control and an unarmed
no-class control are byte-identical. Every `gc`-lane artifact is identical.

**Corpus byte A/B**: 42 modules × {gc, standalone} = 84 artifacts, **0
moved** — a null control (no module in that corpus constructs dynamically
with a runtime-length spread into a foreign ctor).

**Temporal provider**: `3,311,544 B` on BOTH labels — byte-identical,
`cacheHit=false` on both fresh prewarms. The fix is reached only from a
CONSUMER's own dynamic construct; the pre-transpiled
`@js-temporal/polyfill` provider contains no such site.

**Equivalence gate**: 22 failing / 1,720 passing / 22 known-failures —
baseline exactly.

**Witness**: `tests/issue-6621-dynamic-new-runtime-argv-spread.test.ts`, 5
`it`s — 2 fix-witnesses measured failing on the file-copy-reverted base and
passing on branch; 3 controls pass on both trees unchanged. Run alongside
the other 22 `tests/issue-66*.test.ts` files: 23 files / 104 tests, all
pass, ~136 s wall, no OOM.

#### 5. Traps, carried forward and added to

Everything in S26–S33 still holds. One addition:

- **Two arms both had to decline for a shape to have NO lowering — check the
  WHOLE fallback chain, not just the first decline.** A census reduced only
  by LOCAL-class spellings (where `emitDynamicNewFallback`'s own runtime-argv
  path already worked) would have reported "already works" and missed the
  actual corpus blocker — which needs a FOREIGN class, the one shape that
  never reaches ANY working fallback in standalone.
- **A corpus-wide "0 → 0" needs its own direct verification.** The pass
  count alone cannot distinguish "the fix did not work" from "the fix
  worked and a different blocker is now first." A debug throw injected into
  a disposable copy of the real harness told them apart here — the fix did
  work, and the successor blocker is a distinct, already-documented (S20
  §4) mechanism.

### S35 findings (2026-09-16) — the S11/S22 `typeof <provider instance>` residual and the #6617 R2 `isPrototypeOf` gap, both ROOT-CAUSED and FIXED; the headline 45-file count not yet re-measured

Full write-up in
[#6622](6622-standalone-class-instance-callable-kind-and-isprototypeof.md).
Branch `issue-5383-standalone-temporal-s35`, based on S34's FINAL tip
`0a66b22d9b`; the fix is committed WIP `4836b866151024d2ff622633bd115d9619b90fd6`.

#### 1. Two root causes, both traced to the exact same structural-collision
pattern (#5195/#5194/#2158/#2009), now hit at two NEW sites

**Mechanism A** — `reflect-construct-native.ts`'s `__reflect_is_constructor`
and `__is_native_reflect_target` each had ONE bare `ref.test $__ta_ctor` site
(unlike every OTHER `$__ta_ctor` site in this backend, all of which already
route through `taCtorIdentityTestInstrs`, #5383 S2f R11). `$__ta_ctor`
(`{kind: i32, brand: i32}`) is structurally identical to a field-less compiled
class root (`{__tag: i32, __shape_brand: i32}`), so WasmGC's isorecursive type
canonicalization makes them the SAME runtime type: `ref.test` cannot
distinguish a genuine TypedArray constructor from an instance of ANY colliding
class. Measured against the real provider: 30+ field-less Temporal/helper
classes (`TimeDuration`, `Instant`, `PlainDate`, `PlainDateTime`,
`PlainMonthDay`, `PlainTime`, every calendar-helper class, …) share this exact
shape. The bare test made `IsConstructor(instance)` answer `true` for every
one of them — which is what fed the wrong bit into
`standalone-link-boundary.ts`'s `callable_kind` terminal, producing the S11/S22
standing residual: `typeof <provider instance>` answering `"function"`.

**Mechanism B** — `object-runtime-prototype.ts`'s native `__isPrototypeOf`
never seeded its `$proto` chain walk from a class instance (a closed
`$ClassName` struct has no `$proto` field at all). Fixed with
`classInstanceIsPrototypeOfSeed`, mirroring the EXISTING
`fnctorIsPrototypeOfSeed` precedent one function up, reusing
`__getPrototypeOf` — which already composes the module-local class-instance
dispatcher (#6617/S30) AND the link-boundary hop — rather than adding a third
prototype mechanism, exactly per #6617 R2's own conclusion.

#### 2. The fix

| file | what |
| --- | --- |
| `reflect-construct-native.ts` | both bare `taCtorTypeIdx` pushes replaced with `taCtorIdentityTestInstrs` |
| `object-runtime-prototype.ts` | new `classInstanceIsPrototypeOfSeed` + `classInstanceProtoLocal`, spliced into `__isPrototypeOf` right after the existing fnctor seed |

#### 3. The result, measured against the real provider

| probe (`.tmp/s35/probe1.mjs`, fresh cache each side) | base | S35 |
| --- | --- | --- |
| `typeof (new Temporal.Duration(1))` through `any`, linked | `"function"` | `"object"` |
| `typeof (new Temporal.Duration(1))` (bare) | `"function"` | `"object"` |
| `Temporal.Duration.prototype.isPrototypeOf(new Temporal.Duration(1))` | `"no"` | `"yes"` |
| `Object.getPrototypeOf(inst) === Duration.prototype` (#6617/S30, control) | `"yes"` | `"yes"` — unaffected |
| provider artifact size | 3,311,544 B | 3,311,638 B (+94 B) |

`(new Temporal.Duration(1)) instanceof Temporal.Duration` (dynamic RHS) stays
`"no"` on both trees — `native-dynamic-instanceof.ts` acquires
`target.prototype` through a THIRD, separate mechanism from `__isPrototypeOf`
(`ownedPrototypeOrdinaryHasInstance`'s own-property-bag read, which has no
concept of "own properties" for a `$ClassName` class value). Filed as this
issue's Residual, not chased this slice — full `instanceof` needs a new arm in
that native, parallel to `ownedPrototypeOrdinaryHasInstance`, corpus footprint
unmeasured.

**Four-family sample, reduced to the first 40 files per family (a third of
the usual 120)** — time budget, stated plainly rather than hidden:

| family (first 40 files) | base pass | S35 pass | Δ | pass→fail | fail→pass |
| --- | --- | --- | --- | --- | --- |
| `PlainDate/**` | 39 | 39 | 0 | 0 | 0 |
| `Duration/**` | 36 | 36 | 0 | 0 | 0 |
| `PlainDateTime/**` | 39 | 39 | 0 | 0 | 0 |
| `ZonedDateTime/prototype/**` | 25 | 25 | 0 | 0 | 0 |
| **total** | **139/160** | **139/160** | **0** | **0** | **0** |

Per-file diff (not just counts): zero flips in either direction. Consistent
with S30's own reading of a count-neutral result — the two assertions this
slice fixes are not the FIRST failing assertion in most of these 160 rows, so
the fix is real and reached (verified directly above, not inferred from the
count) but does not move THIS sample's headline. No `compile_error`, no
`timeout`, no `__temporal_*` leak in either 160-row run.

**Update (2026-09-17, same slice resumed after a container restart)** — every
remaining battery listed above as "not completed" is now done, on this same
tree, and the earlier 40-file-per-family draft is corrected:

- **Four-family sample, FULL 120 files each**: 430/480 both labels, 0 flips.
- **45-file `subclassing-ignored.js` corpus-wide** (the headline metric):
  still **0/45 both labels** — NOT moved by this slice. Every row's residual
  signature is `Test262Error: […]Expected SameValue(«null», «null») to be
  true` (an earlier draft of this note said `«false», «true»` — that text
  never appeared in either run; corrected). Traced with three purpose-built
  probes to `checkSubclassConstructorUndefined` (`class MySubclass extends
  Temporal.Duration`, then a method call): `Object.getPrototypeOf(result)` is
  a genuine real `null` — a THIRD, previously undocumented mechanism, distinct
  from Mechanism A (`typeof`) and Mechanism B (`isPrototypeOf`) above and from
  the `instanceof` residual in §3: the prototype link of a Temporal method's
  RETURN VALUE is lost when the receiver is a user-defined subclass instance.
  (The OTHER "null" in the pair is a stringification red herring —
  `String(construct.prototype)` itself prints the literal text `"null"` even
  though the object is real and non-null; `assert.js`'s `formatSimpleValue`
  falls back to `String()` for any non-primitive.) Full trace, tables and the
  next-slice pointer are in
  [#6622](6622-standalone-class-instance-callable-kind-and-isprototypeof.md).
- **Must-not-move, 1,634 rows across 3 groups, file-copy A/B revert**: 0
  pass→fail, 0 fail→pass on any group.
- **Corpus byte A/B**: 0/42 `gc`-lane artifacts moved; 14/42 `standalone`-lane
  artifacts moved (all still compile `ok` — the two touched files are shared
  standalone-runtime natives, so any module reaching Reflect/dynamic-class/
  prototype machinery is expected to move).
- **Equivalence gate, run to completion**: 22 failing / 1720 passing / 22
  known-failures — unchanged from every prior S-slice in this stack.

#### 4. Traps, carried forward and added to

Everything in S26–S34 still holds. Two additions:

- **`$__ta_ctor` needs to ACTUALLY be minted in the colliding module** for the
  collision to fire — reading a TypedArray constructor's `.of`/`.from` (a
  static METHOD call) registers `ctx.taCtorTypeIdx`; merely reading
  `.BYTES_PER_ELEMENT` off a `const T = Int8Array` binding does NOT (measured,
  `.tmp/s35/probe5.mjs`) — narrower than #6601/#6620's own reductions state.
  Worth re-checking if a future witness for this family reads "unexpectedly
  still passing".
- **A structural-collision fix at one call site does not imply the fix is
  complete for the WHOLE backend.** `#5194`/`#6601`/`#6620` each independently
  fixed the SAME `$__ta_ctor`/field-less-class collision at their own call
  site; this slice is the fourth. A grep for a bare `ref.test` on
  `ctx.taCtorTypeIdx` (or any typeIdx sourced from `getOrRegisterTaCtorType`)
  NOT wrapped in `taCtorIdentityTestInstrs` is a reasonable audit for
  whichever slice touches this area next — `reflect-construct-native.ts` had
  TWO such sites in ONE file, found only by reading the whole file rather than
  stopping at the first.

### S36 findings (2026-09-17) — a NEW cross-module `__tag` collision found and fixed (silent wrong prototype claims); the 45-file headline's REAL blocker traced to a third mechanism and filed, not fixed

Full write-up in
[#6623](6623-standalone-subclass-cross-module-tag-collision.md). Branch
`issue-5383-standalone-temporal-s36`, based on S35's FINAL tip `2402502cae`;
the fix is commit `0612e1a082`.

#### 1. The defect

`class S extends <heritage the compiler cannot statically resolve>` — a
property-access into a linked provider namespace (`class S extends NS.PD
{}`) or an identifier bound to a runtime PARAMETER (`class S extends
construct {}`, test262's own `checkSubclassingIgnored(construct, ...)`
shape) — compiles, under `--target standalone`/`wasi`, as an independent ROOT
struct with no relationship to its true superclass
(`class-bodies.ts`'s heritage-detection loop resolves only
`Identifier`/`ClassExpression` bases; the property-access arm gets NO
standalone/wasi handling at all, and an unresolved identifier falls back to a
bogus `parentClassName = baseExpr.text`). When such a class is field-less
(the common shape — a bare `super(...)`-forwarding constructor), its struct
canonicalizes to the SAME WasmGC type as ANY other field-less class,
including one a LINKED PROVIDER exports. `standalone-class-instance-proto.ts`'s
`__std_class_instance_proto` dispatcher (#6617/S30) disambiguates same-shape
classes ONLY by `__tag` — a small per-module counter starting at **0 in
every module independently**. Two field-less classes in DIFFERENT modules
can therefore share both shape AND tag by pure coincidence, and the
dispatcher answers the CONSUMER's subclass's prototype for a value the
PROVIDER genuinely minted — a silently WRONG non-null answer, worse than the
`null` it would otherwise decline to. Reduced in THREE steps per the brief's
required order: (1) single module, no link — does NOT reproduce (the static
same-module fold already handles it); (2) synthetic linked pair,
`.tmp/s36/link-probe6.mts`/`link-probe7.mts` — reproduces cleanly, both
heritage shapes, confirmed by direct `classTagCounter` instrumentation
(`PD` and `S`/`MySubclass` both land on `__tag = 0`, each the first class in
its own module); (3) real provider, `.tmp/s35probe/debug2.js` — does NOT show
this specific wrong-answer symptom (`Duration`'s real tag almost certainly
doesn't collide with a lone `MySubclass` in that one test file), consistent
with the mechanism rather than contradicting it, and pointing at a THIRD,
separate, unreduced mechanism as the actual 45-file blocker (see §4).

#### 2. The fix

`ctx.classDynamicUnresolvedHeritageSet` (new, `context/types.ts`/
`create-context.ts`) is populated at both heritage-detection sites in
`class-bodies.ts::collectClassDeclaration` that leave a class unlinked under
standalone/wasi. `standalone-class-instance-proto.ts`'s `collectEntries`
excludes a flagged, field-less class from ever claiming a `getPrototypeOf`
answer — declining (falling through toward `null`) rather than risking the
false-positive match, the same "can only ever REMOVE a false positive"
reasoning #6620/S33's `taCtorIdentityTestInstrs` used for a sibling
collision. A class with genuine own (or inherited) fields is NOT excluded —
verified directly (witness control #5) that such a class's own instances
still answer correctly.

#### 3. The result

Four-family sample, full 120 files each, file-copy revert, fresh cache per
label: **430/480 both labels, 0 flips** (111/104/112/103) — unchanged from
S35's tip, as predicted (this fix targets a different mechanism). **45-file
`subclassing-ignored.js` corpus-wide: 0/45 both labels, unchanged**, message
set byte-identical (verified with a full per-file diff, not just counts).
Must-not-move, 1,649 rows across three groups (A/B/C per the brief's exact
spec), 0 flips, byte-identical `.tsv` diff on all three. Corpus byte A/B: 42
modules × {gc, standalone} = 84 artifacts, **0 moved** — a genuine null
control (nothing in that generic corpus declares an unresolved-heritage
field-less class reaching a `getPrototypeOf` site). Equivalence gate: 22
failing / 1,720 passing / 22 known-failures — baseline exactly. Targeted
synthetic probes DO move: `plain.m()`'s prototype (a receiver that never
touches the colliding class) flips from the WRONG `S.prototype`/
`MySubclass.prototype` to a declined non-claim on both the property-access
and identifier heritage shapes.

#### 4. Residual — the real 45-file blocker, sized and filed, not fixed

`Object.getPrototypeOf(result)` where `result` comes from a dynamic METHOD
CALL (`instance.abs()`) on an unresolved-heritage subclass receiver does not
fall through to the `__js2wasm_link_get_prototype_of` boundary terminal
(#6617/S30) the way a direct `new NS.PD()`/`NS.PD.from()` construction
already does (#6617's own witness covers exactly those two shapes and both
pass). This is a THIRD mechanism, distinct from this slice's fix and from
S35's Mechanisms A/B — filed in #6623 rather than chased, per the brief's
explicit instruction to size and file when a reduction needs its own budget.
A much smaller, purely diagnostic residual (`String(<linked class>.prototype)`
renders the literal text `"null"` for a real, non-null object —
`assert.js`'s `formatSimpleValue` falls back to `String()`) is also named in
#6623 for a future slice, unfixed.

#### 5. Traps, carried forward and added to

Everything in S26–S35 still holds. One addition:

- **A "field-less" check must exclude the compiler's OWN bookkeeping
  fields.** `__tag`/`__shape_brand` are appended to EVERY class's
  `structFields` entry AFTER the declared-field collection loop, so
  `structFields.length === 0` is NEVER true for any class — a naive version
  of this fix's guard silently never fired. The right test is
  `structFields.every(f => f.name === "__tag" || f.name === "__shape_brand")`.
  Caught only by re-running the targeted probe after the "fix" and seeing the
  wrong answer persist unchanged, not by any type or compile error — worth a
  re-check for any future "is this class field-less" query in this codebase.

### S37 findings (2026-09-17) — `Object.isExtensible` FIXED across the link boundary for both a class object and an instance; a new boundary terminal generalises #6617's pattern to a second predicate

Full write-up in
[#6624](6624-standalone-link-boundary-is-extensible.md). Branch
`issue-5383-standalone-temporal-s37`, based on S36's FINAL tip `0612e1a082`.

#### 1. The defect

`Object.isExtensible(Temporal.PlainDate)` — the FIRST assertion in every
`built-ins/Temporal/*/builtin.js` test262 file — answered `false` under
`--target standalone` with a linked provider, where the spec requires
`true`. Root cause: `Object.isExtensible(v)` on an `any`-typed `v` compiles
to the general (non-`_obj`) `__object_isExtensible` native
(`object-integrity-carrier.ts`), whose carrier-bag lookup
(`registerIntegrityBagResolver`) recognises only four carrier kinds — vec,
closure, error, #4194 instance-expando — via `ref.test` chains built from
types the CONSUMER module itself registered. A value the PROVIDER minted
(its class-object struct, or an instance of one of its classes) is a closed
struct in the provider's own type space; absent a structural accident, none
of the consumer's four ladders recognise it, and the native falls to its
non-object terminal (`false`) — wrong for a value that genuinely IS
extensible. Reduced in the required order: (1) single module, no link —
does NOT reproduce (the oracle proves `class C {}` callable, routing to the
already-`true` `_obj` variant); (2) single module, `any`-typed indirection —
still does NOT reproduce (the CONSUMER's own class is in its OWN carrier
ladder regardless of static typing); (3) synthetic linked pair — reproduces
cleanly for BOTH a class object and an instance; (4) real
`@js-temporal/polyfill` — confirmed, 9 of 129 `builtin.js` files fail here
corpus-wide (one per top-level class/namespace export reached directly).

#### 2. The fix

A new wasm<->wasm link-boundary terminal, `__js2wasm_link_is_extensible`
(`standalone-link-boundary.ts`), the same shape as #6617's `getPrototypeOf`
terminal: the provider forwards to its OWN (already-correct)
`__object_isExtensible`; the consumer's `buildIntegrityPredicate`
(`object-integrity-carrier.ts`) gains an optional `peerFallbackIdx`,
consulted in place of the bare `terminalResult` constant on a carrier-bag
miss — threaded through `buildObjectIntegrityPredicates` to exactly ONE
predicate (`__object_isExtensible`; `isFrozen`/`isSealed` untouched, no
reported defect). Simpler than `callableKind`/`getPrototypeOf`'s
reserve-then-fill-at-finalize two-step: `__object_isExtensible` already has
a body by the time the provider-side terminal is emitted
(`buildObjectDescriptorHelpers` registers it earlier in
`ensureObjectRuntime`), so this is a direct forward. The SAME terminal fixes
a class-object miss AND an instance-carrier miss — a strict improvement
beyond the assigned "class object" scope, verified with its own witness.

#### 3. The result

Corpus-wide, all 129 `built-ins/Temporal/**/builtin.js` files, fresh cache
per label: **120/129 pass on BOTH labels, 0 flips.** All 9 failing files
move PAST the `isExtensible` assertion to a later, already-documented
residual (mostly #6609's `getPrototypeOf(<class value>)` gap; `Now`'s file
moves to a DIFFERENT residual, `Object.prototype.toString`, since `Now` is a
namespace object, not a class). Four-family acceptance sample (first 120
files each, file-copy revert, fresh cache per label): **430/480 both
labels** (111/104/112/103), 0 flips — an honest null, none of the moved
rows live in these four families' first 120 files. Provider bytes:
3,311,638 B → 3,311,710 B (+72 B). Equivalence gate: 22 failing / 1,720
passing / 22 known-failures — baseline exactly.

**Witness**: `tests/issue-6624-standalone-link-boundary-isextensible.test.ts`,
5 `it`s — 2 fix-witnesses (class object, instance) measured failing on the
file-copy-reverted base (`false`, expected `true`) and passing on branch; 3
controls (linked function value, local plain object, local class through an
`any` indirection) pass unchanged on both trees. Full suite alongside the
other 25 `tests/issue-66*.test.ts` files: 26 files / 122 tests, all pass.

#### 4. Residual — the real next blocker, already named, not fixed here

8 of the 9 moved `builtin.js` files stop on `Object.getPrototypeOf(<linked
class value>)` still answering `null`, not `Function.prototype` —
S22/#6609's own table already names this exact case a residual. `Now`'s
file stops on `Object.prototype.toString.call(Temporal.Now)` answering
`"[object Object]"` instead of `"[object Temporal.Now]"` — a namespace
object takes a different §20.1.3.6 classifier path than the class-shaped
members this slice and its siblings target; a distinct, unreduced
mechanism.

#### 5. Traps, carried forward and added to

Everything in S26–S36 still holds. One addition:

- **The "ask the owner" boundary-terminal shape (#6617) generalises cleanly
  to a SECOND predicate with no new architecture** — a new export name, a
  `TERMINALS` entry, a reserve-or-forward block, and one new optional
  parameter threaded through an existing predicate builder. When a
  `__object_*` general (non-`_obj`) native's terminal is a bare constant on
  a carrier-bag miss, check whether the miss is genuinely non-object
  (terminal stays a constant) or a foreign-but-real provider value (terminal
  should ask the peer) before assuming a constant answer is correct across a
  link.

### S38 findings (2026-09-17) — `Object.getPrototypeOf(<class object>)` FIXED across the link boundary for base classes; 8 of the 9 S37-moved `builtin.js` files reach `pass`

Full write-up in
[#6625](6625-standalone-link-boundary-class-object-prototype.md). Branch
`issue-5383-standalone-temporal-s38`, based on S37's FINAL tip `783aaa3cbb`.

#### 1. The defect

`Object.getPrototypeOf(Temporal.PlainDate)` — the THIRD assertion in every
`built-ins/Temporal/*/builtin.js` file, and the exact residual S22/#6609
named and S37/#6624 confirmed as the blocker for 8 of the 9 files it moved
past `isExtensible` — answered `null` under `--target standalone` with a
linked provider, where §15.7.14 step 4 requires `%Function.prototype%` for an
ordinary (non-`extends`) class. Root cause: `Object.getPrototypeOf(v)` on an
`any`-typed `v` falls to #6609's `tryEmitDynamicCallableGetPrototypeOf`,
gated on `__is_callable` — which deliberately excludes class objects (a class
has [[Construct]] but no [[Call]]). The value then reached the generic
`__getPrototypeOf`, whose class-instance dispatcher (#6617's
`STANDALONE_CLASS_INSTANCE_PROTO`) explicitly declines a class-object
identity match by design (it answers only for instances).

#### 2. The fix

A new runtime predicate `__is_class_object` — an IDENTITY ladder (`ref.eq`
against every class-object singleton, reusing `typeof-natives-finalize.ts`'s
`classObjectIdentityArms` verbatim, now parameterised over an optional
global-idx list) — ORed into #6609's existing `tryEmitDynamicCallableGetPrototypeOf`
dynamic dispatch alongside `__is_callable`. Across a link, `__is_class_object`
asks the owner for a BOOLEAN only (a new `__js2wasm_link_is_class_object`
terminal), never a value — the value this arm answers is always
`Function.prototype` compiled on the CALLER's own side (S22's identity rule),
so it agrees with the caller's own later read of it. Both the local and
boundary identity ladders are restricted to classes absent from
`ctx.classParentMap` (base classes only) — a subclass's [[Prototype]] is its
PARENT, not `Function.prototype`, and the naive unfiltered predicate was
measured to introduce a NEW wrong answer for a subclass (verified: base
answers `false` for `gPO(<subclass>) === Function.prototype`; an unfiltered
predicate flips it to a wrong `true`; the parent-map filter keeps it `false`,
matching base).

First cut was a SEPARATE function mirroring #6624's two-terminal shape;
measured (via `wasm-dis`) to be minted but never CALLED, because
`tryEmitDynamicCallableGetPrototypeOf`'s contract is "return `true` once the
runtime dispatch is emitted", not "return `true` only when callable" — its
caller's early-return on the first arm's `true` pre-empts any second
sequential arm regardless of which side of the first arm's internal `if/else`
fired. Folded into ONE function instead; full account in #6625's "Attempt
log".

#### 3. The result

Corpus-wide, all 129 `built-ins/Temporal/**/builtin.js` files, fresh cache
per label: **base 120/129 pass** (reproduces S37 exactly on this tree) →
**branch 128/129 pass, 0 pass→fail, 8 fail→pass** — exactly the 8 files S37
§4 named (`Duration`, `Instant`, `PlainDate`, `PlainDateTime`,
`PlainMonthDay`, `PlainTime`, `PlainYearMonth`, `ZonedDateTime` top-level
`builtin.js`). The 9th, `Now/builtin.js`, is unchanged — its blocker is the
separate namespace-`toString` mechanism S37 already named, untouched here.
Provider bytes: 3,311,710 B → 3,312,720 B (+1,010 B).

**Four-family acceptance sample: completed to the brief's full 480/480 spec
in a follow-up measurement pass** (same branch tip, same fix, new
worktree — the original session left this PARTIAL, see #6625's "What did
not get measured" for the full accounting). All four families 120/120 rows
each, both labels (base = file-copy revert of the same 5 files, fix = this
branch): **430/480 base → 433/480 fix, 0 pass→fail, +1 each in
`PlainDate/builtin.js`, `Duration/builtin.js`, `PlainDateTime/builtin.js`**
(each sorts into its family's first-120 walk); `ZonedDateTime/prototype`
unchanged (no `builtin.js` at that root). Base reproduces S37's own cited
111/104/112/103 exactly. Must-not-move groups A/B/C also completed in the
same pass: **0 pass→fail across 1,804 rows** (groups A and B exactly flat;
group C has one legitimate `fail→pass`,
`class-definition-null-proto.js`, a correct consequence of the fix's own
`extends`-null handling — see #6625 for the full analysis). Corpus byte
A/B (42 modules × {gc, standalone}): **0/42 `gc`-lane moved** (confirms
standalone-gating), **25/42 `standalone`-lane moved, 0 CE/status flips**.

Equivalence gate: 22 failing / 1,720 passing / 22 known-failures in
baseline — 0 new regressions, exactly the S37 baseline.

**Witness**: `tests/issue-6625-standalone-link-boundary-class-object-prototype.test.ts`,
7 `it`s — 1 fix-witness (linked class object → `Function.prototype`) measured
failing on the file-copy-reverted base (`false`, expected `true`) and passing
on branch; 6 controls (linked function value, linked instance, linked
subclass, `isExtensible` on the same class object, a local plain object, a
local class through an `any` indirection) pass unchanged on both trees.
Full suite alongside the other 26 `tests/issue-66*.test.ts` files (27
files / 129 tests total): all pass together — this run also caught and fixed
TWO now-stale assertions in `tests/issue-6617-class-instance-prototype.test.ts`
that pinned the PRE-#6625 "declines, answers null" behavior for a
class-object query.

#### 4. Residual — the real next blocker, already named, not fixed here

The `Now/builtin.js` namespace-`toString` mechanism (S37 §4) is untouched.
The `extends`-parent case for `Object.getPrototypeOf(<subclass>)` is a NEW,
narrower residual this slice names and declines to fix (§2 above) — no real
Temporal top-level class currently uses `extends`, so it does not block this
slice's corpus target.

#### 5. Traps, carried forward and added to

Everything in S26–S37 still holds. Two additions:

- **A dynamic-dispatch function's "return `true` once emitted" contract can
  silently swallow a second, sequential arm placed after it at the same call
  site** — check the RETURN CONTRACT of a function you are extending before
  assuming #6624's "just add a second independent terminal" pattern
  transfers. `Object.isExtensible` had no such early-return arm ahead of its
  second terminal; `Object.getPrototypeOf`'s dynamic dispatch did. Fold into
  the SAME function instead when the contract doesn't allow sequencing.
- **A boundary terminal answering a VALUE vs a BOOLEAN is a real design
  choice, not a detail** — `getPrototypeOf`/`isExtensible` (#6617/#6624) hand
  the PROVIDER's own answer back because the provider's value IS the answer
  (an object identity, an integrity bit that has no realm-local competing
  singleton). `Object.getPrototypeOf(<class object>)`'s correct answer
  (`Function.prototype`) is a REALM-LOCAL singleton with no cross-module
  identity, so the boundary must answer a fact ("is this yours") and let the
  CONSUMER produce the value locally — the same reasoning #6609/S22 already
  established for the ordinary-function case, generalised.

### S39 findings (2026-09-17) — the last batch of #6620/S33's own `R-other-bare-ref-test` list audited and fixed; 4 sites confirmed wrong, 4 fixed defensively with no reachable wrong answer found

Full write-up in
[#6626](6626-ta-ctor-identity-remaining-bare-tests.md). Branch
`issue-5383-standalone-temporal-s39`, based on S38's FINAL tip `ea2277af98`.

#### 1. The defect

#6620 (S33) flagged 7 other bare `ref.test $__ta_ctor` / `taCtorTypeIdx`
receiver sites, none reduced to a concrete failing row that slice.
#6622 (S35) fixed 2 more (`reflect-construct-native.ts`), leaving 5 files /
8 call sites unaudited: `dataview-native.ts` (5 sites), `property-access-dispatch.ts`
(1 site), `ta-ctor-meta.ts` (2 call sites, one — `isTaCtor()` — shared across 5
splice points into `__builtinfn_get_meta`/`__builtinfn_gopd`/`__builtinfn_delete`).
Same collision shape every time: `$__ta_ctor` is `{kind: i32, brand: i32}`,
WasmGC-identical to a field-less class's compiled root `{__tag: i32,
__shape_brand: i32}` (#2158/#2009).

#### 2. The fix

All 8 sites now route through `taCtorIdentityTestInstrs` (#5194 r3 F1 / #5383
S2f R11) — the same swap #6620/#6622/#6601 already applied at every other
`$__ta_ctor` receiver test. Answer-preserving for a genuine `$__ta_ctor`
value (both mint sites write the brand), can only ever REMOVE a false
positive.

#### 3. A cheaper reduction than #6620/#6622's

#6620/#6622's collisions needed a LINKED cross-module provider (a class-object
VALUE specifically gets the instance-sharing representation per #3976). Four
of these sites — `emitTaCtorBytesPerElement` and all three `ta-ctor-meta.ts`
`isTaCtor()`-guarded arms exercised — reproduce with a purely LOCAL,
single-module field-less class **instance** cast through an `any` parameter,
no linking required. Measured by file-copy revert of the ONE named file:

| Expression (`x: any = new PD()`, `PD` at `__tag` 3) | Base (file reverted) | Fixed |
| --- | --- | --- |
| `x.BYTES_PER_ELEMENT` (`dataview-native.ts`) | `2` | `0` |
| `typeof x.prototype` (`ta-ctor-meta.ts`) | `"object"` | `"undefined"` |
| `Object.getOwnPropertyDescriptor(x, "BYTES_PER_ELEMENT")` (`ta-ctor-meta.ts`) | `{value:2,...}` | `null` |
| `hasOwnProperty(x, "prototype")` (`ta-ctor-meta.ts`) | `true` | `false` |

#### 4. Residual — 4 sites fixed defensively, not independently witnessed

The 3 remaining `dataview-native.ts` dynamic-`new ctor(...)` construct sites
(`emitDynamicTaViewConstruct`, `emitTaDynCtorConstructFromLocals` ×2) and
`property-access-dispatch.ts`'s `$262.createRealm().global` receiver arm did
NOT reproduce a wrong answer within this slice's budget. Two reduction
attempts for the construct sites — a local field-less ctor value (declines to
the correct `emitDynamicNewFallback` path before the vulnerable arm is even
reached) and a LINKED cross-module provider ctor value (mirroring #6620's own
harness) — both answered correctly on base AND fixed `dataview-native.ts`; the
mechanism that resolves them correctly either way was not isolated. The Realm
site needs the real test262 `$262` harness object, out of reach of a synthetic
vitest probe. All 4 are fixed with the SAME answer-preserving pattern and
covered by control tests instead of fix-witnesses.

#### 5. Corpus / acceptance

`tests/issue-6626-*.test.ts` (9 tests: 4 fix-witnesses, 5 controls) plus the
full `tests/issue-66*.test.ts` regression suite (28 files / 138 tests) pass
together. The four-family/must-not-move/corpus-byte-A/B acceptance battery
was deferred at S39's own tip and **completed in the S39b measurement-only
slice** (branch `issue-5383-standalone-temporal-s39b`, same tip `21d3178748`,
no `src/` changes): four-family sample **433/480 base → 433/480 fix, 0
pass→fail, 0 fail→pass**; must-not-move groups A/B/C (S38b's own definitions)
**plus a new group D** (`TypedArray`/`TypedArrayConstructors`/`DataView`,
mandatory this slice since #6626 touches TA-constructor identity directly) —
**2,004 rows total, 0 pass→fail, 0 fail→pass**; corpus byte A/B (42 files ×
{gc, standalone}) — **0 moved either target, 0 CE/status flips**, provider
bytes `3,312,720 B → 3,313,801 B` (+1,081 B). Equivalence gate **22/1720/22**,
unchanged from S39's own baseline. Full per-group tables in #6626's
"Criterion 4" section. Verdict: the fix is a pure no-op on every corpus slice
measured — expected, since the 4 confirmed-buggy sites are
collision-triggered and none of the measured corpora happens to land a
receiver on a colliding `$__ta_ctor` tag; the 9 `tests/issue-6626-*.test.ts`
tests remain the only positive evidence the fix does something, by design
(synthetic reduction, not corpus-found).

### S40 findings (2026-09-17) — a real oracle fixpoint bug found while chasing the `Proxy get trap is not callable` bucket, fixed, but confirmed NOT to close that bucket; the bucket's real mechanism named, not yet fixed

Full write-up in
[#6627](6627-reflect-namespace-numeric-inference-fixpoint.md). Branch
`issue-5383-standalone-temporal-s40`, based on S39b's tip `9875b99735`.

#### 1. The defect (fixed)

S40's dispatch brief targeted `Proxy get trap is not callable` (6 rows in the
four-family sample). Reducing
`PlainDate/from/observable-get-overflow-argument-primitive.js`
(`TemporalHelpers.propertyBagObserver`'s `get` trap:
`const result = Reflect.get(target, key, receiver); … return result;`)
surfaced an independently-reproducible defect: any object-literal method
literally named `get` (the near-universal Proxy trap name) that stores a
`Reflect.X(...)` result in a local before returning it gets that local
narrowed to an **f64** slot by the whole-program `numericFunctions`
name-keyed usage oracle (`src/codegen/numeric-property-analysis.ts`, #4122)
— regardless of the value's actual type. Downstream this is either a
silently wrong value or a hard Wasm validation trap
(`struct.get[0] expected type (ref null 6), found local.get of type f64`).

Root cause: `isNumeric`'s bare-identifier-receiver fallback,
`sets.numericFunctions.has(callee.name.text)`, treats `Reflect` (a namespace
object, not a user instance) the same as any user class. `Reflect.get`'s
method name is `"get"` — the same string as the Proxy trap convention. The
`numericFunctions` set starts seeded with every function/method name and is
pruned by a fixpoint that removes a name once ANY of its declarations
returns non-numeric; for a `get` method whose own return is `Reflect.get`'s
result, deciding "is `get` numeric" recurses into `numericFunctions.has("get")`
— the very fact the fixpoint hasn't yet decided — so it answers `true`, a
self-reinforcing loop with no external anchor. Fixed by a new
`NON_INSTANCE_GLOBAL_NAMESPACES` exclusion set (`Reflect`, `JSON`, `Object`,
`Array`, `String`, `Number`, `Symbol`, `Promise`, `Proxy`, `Intl`) checked
before the `numericFunctions` fallback — the same targeted narrowing
`Math`/`Date` already have.

#### 2. What it does NOT fix

Measured directly: the real test262 row's compiled `wasm_sha` is
**byte-for-byte identical** with and without the fix, and the row still
fails identically with `TypeError: Proxy get trap is not callable`. The real
`propertyBagObserver.get` trap has an early `return undefined;` branch,
which is non-numeric and disqualifies `numericFunctions` for `"get"` on its
own — the self-reinforcing fixpoint this issue fixes was never actually
engaged by the real corpus row (the minimal reduction needed a SIMPLER trap
body, with no early non-numeric return, to hit it).

#### 3. The bucket's real mechanism (named, not fixed)

Reduced to a 9-line linked-vs-unlinked repro:

```js
// consumer, LINKED to any provider (content irrelevant, not even called):
var options = new Proxy({ overflow: "reject" }, {
  get(target, key, receiver) {
    return target[key]; // Reflect.get is NOT required to reproduce this
  },
});
export function probeToString() {
  var v = String(options.overflow);
  return v === "reject" ? 1 : -2; // answers -2 when linked, 1 when not
}
```

No `Reflect`, no `propertyBagObserver` wrapper, no `calls` array,
module-scope OR function-scope `new Proxy(...)` — all irrelevant. The ONLY
variable that flips the answer is whether the CONSUMER module has ANY
package `link:`ed at all (`ctx.standalone && peerNamespace(ctx) !==
undefined`, i.e. whether `emitStandaloneLinkReverseLocalTerminals`
(`src/codegen/standalone-link-reverse-peer.ts`) runs for this module).

Hypothesis, not yet verified: `ensureProxyRuntime` (`object-runtime-proxy.ts`,
called from `ensureObjectRuntime` around `object-runtime.ts:6769`) "patches
the `ref.test $Proxy` front-guard onto
`__extern_get`/`__extern_set`/`__extern_has`" — and
`emitStandaloneLinkReverseLocalTerminals` (called right after, `~6852`) also
reads/wraps `ctx.funcMap.get("__extern_get")` to build the CONSUMER's
`localGet`/`localKeys`/`localHas`/`localIsNull`/`localMethodCall` terminals
installed into the PROVIDER at `__module_init`. Both touch `__extern_get`'s
identity/body in the same narrow window; whether one observes a stale copy
of the other, or whether the terminal-install `ref.func` captures shift
something the Proxy dispatch relies on, was not pinned down within S40's own
~2h budget. Next step: a WAT diff of
`__extern_get`/`__proxy_get_dispatch`/`__module_init` between linked and
unlinked builds of the 9-line repro above.

#### 4. Corpus / acceptance

`tests/issue-6627-reflect-namespace-numeric-inference.test.ts` (2
fix-witnesses, 3 controls) plus the full `tests/issue-66*.test.ts` regression
suite (28 files / 138 tests) pass together. The four-family/must-not-move/
corpus-byte-A/B acceptance battery was deferred at S40's own tip and
**completed in the S40b measurement-only slice** (branch
`issue-5383-standalone-temporal-s40b`, same tip `66acff773f`, no `src/`
changes): four-family sample **433/480 base → 433/480 fix, 0 pass→fail, 0
fail→pass**; must-not-move groups A/B/C/D (S39b's own definitions, group C
reusing S39b's own 0:249 slice) — **2,004 rows total, 0 pass→fail, 0
fail→pass**; corpus byte A/B (42 files × {gc, standalone}) — **0 moved
either target, 0 CE/status flips**, provider bytes unchanged at
`3,313,801 B` (this fix touches only compile-time oracle inference, not
codegen bytes emitted into the linked Temporal provider). Equivalence gate
**22/1720/22**, unchanged. The assigned 6-row bucket reproduces
byte-for-byte unchanged — every row still answers `TypeError: Proxy get trap
is not callable`. Full per-group tables in #6627's "Criterion 4" section.
Verdict: the fix is a pure no-op on every corpus slice measured, exactly as
S40's own "THIS DOES NOT CLOSE #5383'S TARGET BUCKET" section predicted —
the `NON_INSTANCE_GLOBAL_NAMESPACES` exclusion only fires for a
bare-identifier receiver whose text is one of ten well-known global names
calling a method also present in `numericFunctions`, and no corpus measured
here lands on that intersection. The `Proxy get trap is not callable` bucket
remains open, with the linked-vs-unlinked repro and `ensureProxyRuntime` /
`emitStandaloneLinkReverseLocalTerminals` hypothesis above as its next
slice's starting point.

### S41 findings (2026-09-17) — the `Proxy get trap is not callable` bucket's mechanism found and PARTIALLY fixed: a real, independently-verified `__apply_closure` misrouting bug for LOCAL Proxy trap invocation, but the bucket's actual blocker is a second, deeper CROSS-MODULE trap-invocation problem, named but not fixed

Full write-up in [#6628](6628-standalone-proxy-trap-peer-callable-kind-misclassification.md).
Branch `issue-5383-standalone-temporal-s41`, based on S40b's tip `ef08f7a8f0`.

#### 1. Root cause (found, not what S40 suspected)

S40's own two named suspects (`ensureProxyRuntime` /
`emitStandaloneLinkReverseLocalTerminals`) were a dead end: a ctx-level Instr
dump of every function in the dispatch chain (`__extern_get`'s Proxy
front-guard, `__proxy_get_dispatch`, `__proxy_call_get`, `__call_fn_method_3`,
`__typeof_function`) showed them structurally identical between linked and
unlinked builds. The real mechanism is `fillApplyClosure`'s #6420
"peer-owned callable" front-guard (`src/codegen/object-runtime.ts` ~line
7766): it asks the linked PROVIDER "is this externref callable?" for EVERY
value `__apply_closure` invokes, including ones that never crossed the link
boundary. Under `canonicalRuntimeTypes` a purely LOCAL closure's WASM shape
canonicalises to the SAME type as the provider's own shapes, so the
provider's structural `__is_callable` check answers "yes" for a closure it
has never seen, and `__apply_closure` hijacks the call into the provider's
own apply terminal — which cannot run it and silently returns null. Confirmed
via a WAT trace (`.tmp/s41/apply_closure_linked.txt`) and a side-effect
witness (a trap that increments a counter regardless of its arguments proved
the trap body NEVER RUNS in the linked build).

#### 2. Fix (real, narrow, verified — does not close the bucket)

`fillProxyDispatch`'s trap-invoke drivers now call `__call_fn_method_<N>`
directly (bypassing `__apply_closure` and its peer-callable-kind guard
entirely) when the Proxy dispatch is running in the SAME module that
constructed the trap. Two earlier attempts that tried to fix this on the
SHARED `__apply_closure` (a structural "is this locally owned" `ref.test`
gate, tried against both the deduped closure-root type list and the full
per-site closure-type list) both regressed `tests/issue-6605-*` and
`tests/issue-6616-*`: `canonicalRuntimeTypes` makes "my closure" vs
"identically-shaped foreign closure" fundamentally undecidable by `ref.test`
on the SHARED function — fixing the CALL SITE instead (Proxy's own
fixed-arity invocation) sidesteps the ambiguity. 7 new tests
(`tests/issue-6628-*.test.ts`, 3 fix-witnesses base-fail/fix-pass + 4
controls), full `tests/issue-66*.test.ts` regression suite green
(30 files / 150 tests).

#### 3. Why it does NOT close #5383's bucket

The real corpus row is not "a consumer builds and reads its own local
Proxy" — it is `Temporal.PlainDate.from(date, options)`, where the CONSUMER
builds `options = TemporalHelpers.propertyBagObserver(...)` (a Proxy) and
hands it to the PROVIDER, which reads `options.overflow` FROM INSIDE ITS OWN
COMPILED MODULE. The trap the provider's own `__proxy_get_dispatch` finds is
unavoidably the CONSUMER's — this fix's direct-`__call_fn_method_N` dispatch
is WRONG for that direction (the trap can never be local to the provider, so
it needed the OLD peer route). Built and ran a minimal reduction of exactly
this shape (`.tmp/s41/crossmodule.mts`): a provider `readOverflow(o){ return
o.overflow; }` called with a consumer-owned Proxy — **throws an uncaught
`WebAssembly.Exception` identically on BOTH base and fix**, proving this is a
PRE-EXISTING, separate mechanism, not a regression introduced here, and not
what this fix reaches. `__apply_closure`'s #6420 peer bridge is therefore
load-bearing for THIS direction even though it is wrong for the opposite
one — no single front-guard using structural `ref.test` alone can get both
right under canonical types; a correct general fix needs real per-instance
ownership (a module-origin tag set at `struct.new` time), out of scope here.

#### 4. Criterion 4 acceptance

6-row bucket: unchanged, all 6 still `TypeError: Proxy get trap is not
callable` (fresh provider cache, rebuilt bundle, `cacheHit=false` confirmed
at prewarm). Four-family sample (first 120 × 4 families): **433/480**,
exactly matching S40b's base measurement per-family (112/105/113/103) — 0
movement. Corpus byte A/B (42 files × {gc, standalone}): 0 CE/status flips;
6 `standalone`-target rows changed SHA despite containing no literal `Proxy`
text — `ensureProxyRuntime` runs unconditionally for every standalone module
reaching the object runtime, so this fix's smaller dead-code Proxy drivers
shift bytes even where Proxy is never constructed; benign. Equivalence gate
**22/1720/22**, unchanged. **Must-not-move groups A/B/C/D were NOT run this
slice** (time-budget cutoff) — flagged as an open verification gap.

**S41b (2026-09-17, `issue-5383-standalone-temporal-s41b`, branched from
S41's `d9d43e634d`) closed that gap**: groups A (1250 files)/B (205)/C
(249)/D (300) all reproduce exactly (1125/179/196/219 pass, per the task's
expected floor) with **0 pass→fail and 0 fail→pass**, exact per-file TSV
match base vs fix. Added a new group E (`Proxy` first 200 + `Reflect` first
100, standalone) since #6628 is inside Proxy dispatch: unlinked variant 0
diff (235/300 both states); a docs-only forced-link variant (injects
`features: [Temporal]` into a shadow copy of each file so the SAME
production `compileWithTemporalGlobal` path every Temporal test already
takes also runs these) shows 220→228/300 (0 pass→fail, 8 fail→pass), all 8
in the engine-triggered trap-dispatch family (`apply`/`has`/`get`/etc.
`call-parameters.js`) that #6628's `fillProxyDispatch` fix targets — the
remaining ~64 linked failures (identical on both trees) are manual
`.apply()`/`.call()` trap invocations in test harness code, which go
through the still-unfixed general `__apply_closure` peer guard, exactly as
predicted below. PlainDate re-confirmed 112/112 both states, 0 diff.
Equivalence gate re-run 22/1720/22, unchanged. Full tables in
[#6628](6628-standalone-proxy-trap-peer-callable-kind-misclassification.md).

The bucket remains open. Next slice's starting point: fix the FORWARD
direction correctly (provider invoking a genuinely foreign/consumer-owned
trap must still route to `__apply_closure`'s peer bridge) while keeping the
BACKWARD direction fixed here (a module invoking its own local trap must
not) — requires either (a) real per-closure ownership tagging, or (b) a
different signal at the Proxy-CONSTRUCTION site that lets `$ptraps` record
"this trap is mine" for later `__proxy_get_dispatch` reads to consult instead
of asking `__apply_closure` to guess.

### S42 findings (2026-09-17) — merge sync onto origin/main (4a5d5c1dfb): a clean merge, one real regression from main's own #6484 S1 short-circuiting #6609/#6625's mechanism (found + fixed), one pre-existing dormant defect the fix exposed (found, filed as #6630, not fixed)

Full detail: [#6629](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6629-standalone-temporal-stack-main-sync-2026-09-17).

Merged `origin/main` (`4a5d5c1dfb`) onto S41b's accepted head (`b84898a96c`)
— clean, zero conflicts (merge commit `527310b81f`). The merge broke the
same 12 witnesses (`Object.getPrototypeOf` paths in `tests/issue-6609-*`,
`tests/issue-6617-*`, `tests/issue-6625-*`) the earlier parked attempt
(`s41-main-merge-attempt`) also hit — but the mechanism these witnesses pin
(`tryEmitDynamicCallableGetPrototypeOf`, `object-get-prototype-of.ts`) is
BYTE-IDENTICAL across the merge; the actual break is main's #6484 S1
iterator-prototype branch in `call-builtin-static.ts` short-circuiting
BEFORE the stack's arm is ever reached (an idiom collision, not a touched-line
conflict — no conflict marker could have caught it). Fixed by delegating the
new branch's non-`$__IterRec` arm to the stack's existing predicate via the
project's `pushBody`/`popBody` swap. All 150 witnesses green post-fix.

The fix's necessary side effect — `Function.prototype` now materialises in
far more modules than before — exposed a second, PRE-EXISTING (proven
independent of this merge, reproduced on unmodified `b84898a96c`) defect:
`ensureObjectRuntime`'s `fctx=null` bootstrap bakes `__extern_method_call`'s
body with whatever funcIdx values are live at that moment, and has no
tracking to correct itself if a native gets registered afterward — any
later, unrelated `.call()` in the same module then calls the wrong function.
Filed as #6630 for a proper architecture-level fix; not attempted here
(out of scope for a sync task, and one narrow mitigation attempt did not
close it).

**Not run this session** (time-boxed by the #6484 root-cause depth): the
criterion-5 re-baselined measurement battery (four families × 120 files,
must-not-move A–D, E-unlinked/E-linked, corpus byte diff, `test:equivalence:gate`).
Next agent/tech lead must run it before the stacked PR (S13→S42) opens.

### S43 findings (2026-09-17) — #6630's root cause found to be BROADER than filed (any early `ensureObjectRuntime` trigger, not just `Function.prototype`); one real, regression-free narrowing fix landed; `tests/issue-6484-iterator-prototypes.test.ts`'s one failing case still NOT green — a second, unrelated trigger path exists that this fix does not reach

Full detail with WAT/debug evidence: [#6630](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6630-ensureobjectruntime-bootstrap-late-import-staleness).

Decoded the S42 repro's opaque `WebAssembly.Exception` (it read as
`[Object: null prototype] {}` when printed directly — decoding via
`e.getArg(tag, 0)` gives the real payload). The message is
`"Function.prototype.call is not yet implemented in --target standalone"` —
a native-proto glue member-miss refusal, NOT a stale-funcIdx crash. WAT
evidence (func-index-order cross-reference) confirms `buildResolvedCalleeGuard`'s
captured `isCallableIdx`/`typeofFunctionIdx`/`__new_TypeError` funcIdx values
are all CORRECT in the final module — the mechanism #6630 originally named is
not what is happening. Compile-time dispatch tracing shows `g.call(o)` takes
the identical STATIC codegen path in both the working and failing case; the
divergence is purely a runtime effect of something `ensureObjectRuntime`'s
bootstrap does differently depending on WHEN it first runs.

Fixed the one call site S42/#6609/#6625 own:
`tryEmitDynamicCallableGetPrototypeOf` (`object-get-prototype-of.ts`) used to
eagerly materialise `%Function.prototype%` for EVERY dynamic
`Object.getPrototypeOf(<any-typed value>)`, regardless of whether the value
turned out callable at runtime. Restructured to check
`__is_callable`/`__is_class_object` first and only materialise
`%Function.prototype%` inside the `then:` arm (via `pushBody`/`popBody`) —
same result for the #6609/#6625 witnesses, but a non-callable receiver (the
common case) no longer triggers `ensureObjectRuntime`'s bootstrap through this
path. Verified regression-free: `tests/issue-66*.test.ts tests/issue-6484-*
.test.ts` (32 files / 188 tests) — same 187 pass / 1 fail before and after.

**That one remaining fail is NOT fixed by this change.** Bisected
(`.tmp/s43/bisect2.mts` case `I1`) to a THIRD, unrelated trigger:
`ensureIterRecPrototypeHelper` (`iterator-proto-next.ts`, main-authored,
untouched by S42/S43) unconditionally builds all four iterator-prototype
singletons — which itself calls `ensureObjectRuntime` — on the FIRST
`Object.getPrototypeOf(<any-typed iterator>)` in a module, regardless of
which family is actually used. A module doing nothing more than
`Object.getPrototypeOf(someIterator)` once, then an ordinary `fn.call(...)`,
reproduces the same failure with zero involvement from either S42's or S43's
diffs. This confirms #6630's real shape: `ensureObjectRuntime`'s bootstrap has
an ordering hazard that fires whenever ANYTHING triggers it early/mid-
expression, not specifically when `Function.prototype` is read — so a
call-site-local fix closes that one caller's exposure but not the underlying
class of bug. Filed the corrected analysis in #6630 (kept `status: ready`,
NOT closed) with the two remaining architecture-level directions.

**Stack state at S43's head (`e57ab2a0f9`): NOT yet PR-ready.** The required
green set (`tests/issue-66*.test.ts tests/issue-6484-*.test.ts`, 32 files) is
187/188 — the one pre-existing #6484 failure is still red. Closing it needs
either (a) #6630's architecture-level fix, or (b) accepting a narrower
mitigation that also touches `ensureIterRecPrototypeHelper`/
`emitIteratorPrototypeSingleton` (main-authored; out of this sync's stated
scope) to defer that path's `ensureObjectRuntime` trigger too. The
criterion-5 re-baselined measurement battery from S42 is STILL not run this
session either (time-boxed by this investigation) — next agent must run both
before the stacked PR opens.

### S44 findings (2026-09-17) — #6630 CLOSED: the gap was never an ordering
defect, it was two never-implemented glue members; `tests/issue-6484-*`'s one
failing case is now green

S44 (branch `issue-5383-standalone-temporal-s44`, worktree
`/home/user/js2/.claude/worktrees/agent-ae02d763b3f66aedb`, head
`0c3316f9f1` on top of S43's `e57ab2a0f9`) traced #6630 one hop further than
S43's WAT-verified dispatch trace and found the mechanism S43 was searching
for (bootstrap-ordering state that differs between early and natural-order
`ensureObjectRuntime` runs) does not exist. The actual defect: once
`%Function.prototype%` is materialized and wired as a closure's
`[[Prototype]]` (by ANY trigger — S43 already established the trigger is
broad, not specific to `Function.prototype` reads), a `.call()`/`.apply()`/
`.bind()` own-property lookup off that closure correctly walks the §10.2
chain and finds `%Function.prototype%`'s own property for that name — which
`makeGlue` (`array-object-proto.ts`) had never wired a real body for (`call`/
`apply`/`bind` were the ONLY three `Function`-family members still on the
#2984 Phase-2 refusal path; `toString`/`@@hasInstance` already had real
bodies). `closure-call-fast.ts`'s fast arm and `closure-props.ts`'s
`__closure_method_call` own-property route both correctly see that as a HIT
and correctly defer to it, which then throws the refusal. No bootstrap state
needed tracking and no trigger needed delaying — the fix is implementing the
three missing invoker bodies.

Landed `src/codegen/function-proto-invokers.ts`: `call`/`apply`/`bind` now
forward to the SAME generic "invoke any callable" primitives the rest of the
runtime already uses for this question (`__apply_closure(target, thisArg,
argsVec)` for call/apply, `__bind_dyn(target, argsVec)` for bind — the
existing #3140 dynamic-bind helper), rather than special-casing the WasmGC
closure struct family. This closes the defect for EVERY receiver kind that
reaches this glue (bound functions, native builtin singleton closures, …),
not just the one path #6630's repro exercised — and makes
`Function.prototype.call`/`.apply`/`.bind` correct reflective values in
standalone generally. Full trace, exact ABI/unpacking details and
verification numbers are in #6630's own `### S44 findings` section
(`plan/issues/6630-ensureobjectruntime-bootstrap-late-import-staleness.md`) and the handover's post-S44 stack-state entry —
not restated here.

**Stack state at S44's head (`0c3316f9f1`): the required green set closes.**
`tests/issue-66*.test.ts tests/issue-6484-*.test.ts` (33 files, including the
new `tests/issue-6630-function-prototype-call-after-bootstrap.test.ts`
witness file) is 194/194, 0 failed — the `%IteratorPrototype%` case S43 left
red is now green. `tests/issue-64*.test.ts tests/issue-65*.test.ts` (S43's
own sweep) is 441/442 (1 pre-existing unrelated skip), 0 failed — S43
measured 440/442 with one red on this same sweep. `npm run -s
test:equivalence:gate`: 22/1720/22, unchanged from S43's documented number,
no new regressions. **The criterion-5 re-baselined measurement battery from
S42 is STILL not run** — S44's dispatch brief scoped that out explicitly
("Do NOT run the family/must-not-move battery — that is the next measurement
lane's job"). Next agent runs that battery before the stacked PR opens.
