---
id: 2951
title: "IR-first skip set: include generators and class members (retire the two #2138 standing exclusions)"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-07-02
updated: 2026-08-18
priority: medium
horizon: m
feasibility: hard
model: fable
reasoning_effort: high
task_type: feature
area: codegen, ir
language_feature: generators, classes
goal: ir-full-coverage
model: fable
fable_role: spec
depends_on: [2138]
related: [2950, 1370, 2864]
# The new logic lives in `src/ir/generator-support.ts` (new module). What
# remains in the four god-files is unavoidable in-place growth: the `gen.*`
# provider fields on their node interfaces, the matching arms in the two
# dependency-discovery switches, and the generator admission branch in the R2
# selector — each must sit at the existing dispatch site.
loc-budget-allow:
  - src/ir/nodes.ts
  - src/ir/integration.ts
  - src/ir/prepared-component-dependencies.ts
  - src/codegen/ir-prepared-free-functions.ts
# Same reason at function granularity: the generator preparation step belongs in
# `compileIrPathFunctions`' ordered pass pipeline (it must run right after
# `addGeneratorImports` and before sealing), and the `gen.*` evidence arm belongs
# in `collectFunctionEvidence`' instruction walk. Both bodies grew by the two
# small blocks that call into `src/ir/generator-support.ts`.
func-budget-allow:
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/prepared-component-dependencies.ts::collectFunctionEvidence
origin: "2026-07-02 July Fable audit §1 (#2138 impl-note deviations 3 and 4 had no tracking issue)"
---

# #2951 — generators and class members always compile twice, even under IR-first

## Problem

#2138's landed skip-set computation (`computeIrFirstSkipSet`,
`src/codegen/index.ts:1139`) permanently excludes two families:

1. **Generators** — legacy generator compilation creates auxiliary
   machinery beyond the slot body; IR generator lowering registers its own
   imports (`addGeneratorImports`) but standalone-ness of the IR-only path
   without legacy's side effects is unproven (#2138 impl note, deviation 3).
2. **Class members** — the typeIdx parity contract with legacy callers
   (class-bodies.ts pre-allocated signatures, `integration.ts` parity
   guard) keeps them on the always-legacy-then-overwrite path (deviation 4).

Both exclusions are correct-but-untracked; #2950 (default flip) either
needs them retired or explicitly carved out.

## Approach

- **Generators:** enumerate the aux side effects of legacy generator
  compilation (imports, globals, helper funcs) vs what IR generator claim
  registers; either prove the IR path self-sufficient (then include
  IR-claimed generators in the skip set) or make the IR path register the
  missing pieces first. Probe: compile a claimed generator with the skip
  forced on and diff the module sections.
- **Class members:** carry the typeIdx-parity check into the skip decision
  — a member is skippable iff its IR signature byte-matches the
  class-bodies.ts pre-allocation (the parity guard already computes this;
  reuse, don't re-derive).

## Acceptance criteria

- `CompileResult.irFirstSkipped` lists generator and class-member bodies on
  a claim-dense probe.
- Flag-off byte-identity preserved; index-layout invariance test extended
  to a class+generator corpus.
- Full merge_group net-zero with the flag on (feeds the #2950 gate).

## Predecessor slice contract: IR `gen.setReturn` (fable-gencarrier, 2026-07-04, Opus-executable)

The generator half of this issue has a hard prerequisite the audit missed:
**IR generators throw-defer any `return <expr>` to legacy**
(`src/ir/from-ast.ts lowerTail`, the #2035 arm, ~L763) — so a generator with a
value-carrying return can never be IR-claimed, and no skip-set widening can
cover it. Retire the deferral with a `gen.setReturn` IR instruction that
mirrors the legacy routing (`compileReturnStatement`,
`src/codegen/statements/control-flow.ts:140-170`: coerce to externref →
`__gen_set_return(buffer, value)` → `br` out of the body block).

Mechanical contract (mirror `gen.push` at every layer — `grep -rn
'"gen.push"' src/ir/` enumerates the exact switch arms; there are ~12 across
`nodes.ts` (type + 3 switches), `builder.ts` (emit method), `from-ast.ts`,
`lower.ts` (2), `effects.ts` (2), `verify.ts`, `verify-alloc.ts`,
`select.ts`, `integration.ts`, `passes/inline-small.ts`,
`passes/monomorphize.ts`):

1. **`nodes.ts`**: `IrGenSetReturn { kind: "gen.setReturn"; value: IrValueId;
result: null }` — same shape as `gen.push`; add to the same unions/switches.
2. **`builder.ts`**: `emitGenSetReturn(value)` guarded on
   `funcKind === "generator"` + `generatorBufferSlot` set (copy the
   `emitGenPush` guards).
3. **`from-ast.ts lowerTail`** generator arm: replace the `#2035` throw with:
   lower `stmt.expression` via the SAME dispatch `lowerYield` uses (f64 / i32 /
   ref-coerced-to-externref), `emitGenSetReturn(v)`, then the existing
   `emitGenEpilogue()` + return-terminator. Bare `return;` unchanged.
4. **`lower.ts`** `case "gen.setReturn"`: `__gen_set_return` has signature
   `(externref, externref) -> void` (registered in `addGeneratorImports`,
   `src/codegen/index.ts`). The value must be BOXED:
   - f64 → resolve `__box_number` exactly the way the `__unbox_number`
     resolution does at lower.ts:940 (`resolveHostImport`-style; if the
     resolver doesn't know it, THROW to defer — never emit a raw f64 arg);
   - i32 → `f64.convert_i32_s` first, then box;
   - ref/ref_null → `extern.convert_any`; externref → pass through.
     Then push buffer slot + boxed value, `call __gen_set_return`.
5. **Effects/verify/select/passes**: copy `gen.push`'s classification
   verbatim (side-effecting, non-reorderable past buffer reads, not
   inlinable-across… whatever `gen.push` declares — do not re-derive).

Validation gate: `tests/issue-2035.test.ts` (9 cases) must pass with the IR
path now CLAIMING the for-of program (assert via `trackFallbacks` that the
generator no longer defers); `pnpm run check:ir-fallbacks` must not grow;
js-host lane A/B on the dstr/generator corpus net-zero-or-positive. NOTE the
#3032 W6 horizon: this invests in the eager-buffer model that W6 eventually
retires — it is still worth landing because the IR-first flip (#2950) is
gated on IR parity NOW, and the instr becomes dead code W6 can delete
wholesale.

## Landed slice — IR `gen.setReturn` (opus-2951, 2026-07-04, PR pending)

The predecessor slice is IN. IR generators now handle `return <value>`
natively via a new `gen.setReturn` IR instr; the #2035 throw-defer in
`from-ast.ts lowerTail` is retired.

### What shipped (WHY, not just WHAT)

- **New `gen.setReturn` IR instr** minted as an exact structural twin of
  `gen.push` (statement-level, `result: null`, one `value` operand) across
  all switch sites: `nodes.ts` (interface + union + `forEachNestedBuffer` /
  `mapNestedBuffers` / `directUses` leaf arms), `builder.ts`
  (`emitGenSetReturn`, guarded on `funcKind==="generator"` +
  `generatorBufferSlot`), `from-ast.ts`, `lower.ts` (emit + use-collection),
  `effects.ts` (heap+allSlots classification + DCE must-keep pin),
  `verify.ts`, `passes/monomorphize.ts`, `passes/inline-small.ts`. `tsc`
  enforces exhaustive-switch parity (nodes.ts `never` checks).
- **from-ast** (`lowerTail` generator arm): the throw is replaced by lowering
  the return expr through the SAME dispatch `lowerYield` uses (f64/i32 stay
  native; reference-shaped coerced to externref via
  `coerceYieldValueToExternref`), then `emitGenSetReturn` + the existing
  `emitGenEpilogue` + return terminator. Bare `return;` unchanged. **Scope is
  the TAIL return** — a mid-body generator `return` still throws in
  `lowerEarlyReturn` (the eager-buffer model can't stop the rest of the body),
  same as before; those generators stay selector-rejected/legacy.
- **lower.ts** boxes the value to externref for the `(externref,externref)`
  `__gen_set_return` signature: f64 → `__box_number`; i32 →
  `f64.convert_i32_s` then box; ref/ref_null → `extern.convert_any`;
  externref → pass through. `resolveFunc("__box_number")` is called WITHOUT a
  swallow — if unresolvable (a lane with no host boxing), the throw demotes
  the whole function to legacy via the integration.ts catch, so a raw f64 arg
  can never reach the import (which would fail Wasm validation). Mirrors
  legacy `compileReturnStatement`
  (`codegen/statements/control-flow.ts:144`), which boxes via `coerceType`.

### Verification

- `tests/issue-2035.test.ts` 9/9 green (spread / for-of / Array.from / raw
  next / yield\* / gen.return all exclude the return value).
- Probe (`irPostClaimErrors`): value-returning generators (numeric / object /
  string / bare) now IR-CLAIM with **zero** post-claim demotions — previously
  every non-bare case demoted with the #2035 message.
- `tests/issue-1169f-7a.test.ts` + `7b.test.ts`: were RED on main (verified
  against the `/workspace` control) with STALE pre-#2035 expectations (the
  return literal leaked into the yield stream). Updated to the correct
  return-excluded sequences; both now 16/16 green with legacy≡IR parity.
- `generators.test.ts`, `issue-1017-yield-star`, `issue-2170` (standalone
  native carrier) all green — unaffected (native carrier is `noJsHostTarget`,
  a disjoint lane from the IR eager-buffer path).
- `pnpm run check:ir-fallbacks`: OK, post-claim demotions unchanged (none).
- Pre-existing unrelated RED (NOT this slice, confirmed on control):
  `issue-1169q` "reports non-export-modifier for async functions" — a stale
  async-bucket rename (`async-function` since #1373); out of scope here.

### Banked follow-ups (this slice does NOT fully close #2951)

1. ~~**Generator skip-set widening (gate 2).**~~ **DONE — gate-2 generators
   slice, 2026-07-04 (see Implementation Notes below).**
2. **Class-member half (deviation 4).** Untouched — carry the
   `integration.ts` typeIdx-parity guard into the skip decision (a member is
   skippable iff its IR signature byte-matches the class-bodies.ts
   pre-allocation). Independent of the generator work. #2951 stays
   `in-progress` until this lands.

## Implementation Notes — gate-2 generator narrowing (2026-07-04, opus-2951gate2)

**What changed.** `computeIrFirstSkipSet` (`src/codegen/index.ts`) gate 2 no
longer blanket-excludes every generator. The old line
`if (!fn || fn.asteriskToken) continue;` became `if (!fn) continue;` +
`if (fn.asteriskToken && !generatorsSkippable) continue;`, where
`generatorsSkippable = !(ctx.standalone || ctx.wasi || ctx.strictNoHostImports)`
(the same JS-host condition the selector uses for `jsHostExterns`). The call
site (`generateModule`) computes the flag from `ctx` and threads it in.

**Why this is safe (root-cause reasoning, not symptom-patching).**

- The gate only runs under `JS2WASM_IR_FIRST=1`. Flag OFF (default, all normal
  CI) the whole skip machinery is dead — `irFirstSkipped` is `undefined` and
  output is byte-identical. So the required CI checks cannot regress; this only
  affects the opt-in `ir_first` measurement lane in `test262-sharded.yml`.
- **Self-sufficiency of the IR generator path** was #2138 deviation-3's open
  question. It is now answered: the generator host imports are registered by a
  _source-level_ scan (`state.generatorFound` in `declarations.ts`, which fires
  on any `function*` in the source) **independently of any individual
  generator's legacy body emission**, and the IR path _also_ pre-registers them
  itself (`addGeneratorImports` in `ir/integration.ts`, driven by any
  `funcKind === "generator"` claim) plus its own `__exn` tag. So skipping a
  claimed generator's legacy body drops no import/type/tag the IR body needs.
- **Runtime parity holds by construction**: under the default flag-off IR
  overlay a claimed generator ALREADY ships its IR body (the overlay overwrites
  the legacy slot). Skipping the wasted legacy compile changes only compile
  time, never the shipped body — the same reason gate-1 non-generator skips are
  net-zero.
- **Shape safety is upstream, not in this gate.** Generator shapes the IR path
  can't own never reach gate 2: the selector filters them into
  `body-shape-rejected` / `param-type-not-resolvable` / `deferred-feature`
  (async generators, generator methods, unresolved-param generators,
  return-less/mid-body-shape bodies) so they never enter `safeSelection.funcs`.
  Only selector-claimed generators become skip-eligible, and the #2138
  hard-error overlay promotes any residual skipped-slot IR failure to a loud
  compile error (never a silent trap).
- **Standalone/WASI stay compile-twice.** Legacy restricts standalone
  generators to sequential-numeric-yield native lowering (`function-body.ts`
  #680 guard) and the IR path unconditionally registers JS-host generator
  imports, so standalone self-sufficiency is genuinely unproven — deferred to a
  follow-up with its own standalone measurement.

**Proof (local, criterion-3 is the maintainer-dispatched `ir_first` lane).**

- New `tests/issue-2951.test.ts` (4 cases): JS-host value-returning generator
  now appears in `irFirstSkipped`, compiles with zero hard errors + zero
  `irPostClaimErrors`, and drains to the correct runtime result; standalone does
  NOT skip it; flag-off leaves `irFirstSkipped` undefined.
- Flag-on vs flag-off compile-status sweep over **~550 real test262 generator
  files** (191 with any `function*`, then 359 with a top-level `function*`
  declaration): **0 flag-on-only divergences**, with 11 files actually
  exercising a generator skip — all correct. `bothFail` counts are pre-existing
  and identical in both modes.
- `pnpm run check:ir-fallbacks`: no unintended bucket growth, no post-claim
  demotions (generators don't appear in `playground/examples`, so the budget is
  structurally unaffected).
- `tests/issue-2138.test.ts` (14, incl. funcIdx-layout-invariant +
  byte-identity), `tests/issue-2035.test.ts`, `tests/issue-2173-*.test.ts` (21
  generator tests) all green.

Full merge_group net-zero WITH the flag on (acceptance criterion 3) is the
maintainer-dispatched `ir_first` measurement lane on `test262-sharded.yml`
(`workflow_dispatch` input `ir_first`, which never promotes a baseline) —
flagged to the tech lead to dispatch.

## Implementation Plan (Fable, 2026-07-18) — class-member half, re-grounded against the #3143/#3203 allowlist redesign

> **The issue's framing is stale.** `computeIrFirstSkipSet`
> (`src/codegen/index.ts:1578–1697`) is no longer "blanket exclusions minus
> carve-outs" — it is now an **ALLOWLIST**: a claimed top-level
> FunctionDeclaration is skipped only when (a) its whole signature resolves to
> the numeric/boolean value domains (`positionDomain`, `:1617`), (b) its body
> passes `irFirstBodyIsProvenLowerable` (`src/codegen/ir-first-gate.ts:89`),
> and (c) EVERY caller is itself skipped (signature-parity fixpoint,
> `:1664–1697`). The generator half is done (gate 2 host-gating, `:1657`,
> threaded at `:2277`). Class members never even reach the loop — the skip
> iterates `plan.safeSelection.funcs` (top-level decls in `declByName`);
> class members travel separately (`selection.classMembers`,
> `index.ts:1853–1882`) and are keyed by `classMemberFuncKey`
> (`src/codegen/class-member-keys.ts`). So "carry the typeIdx-parity into the
> skip decision" now concretely means: **extend the allowlist machinery to
> class-member entries**, with two hazards the original approach text
> couldn't see.

### Hazard 1 — the receiver param is outside the numeric domain vocabulary

`positionDomain` admits only `f64` ("number") and annotated-`boolean` `i32`.
A method's Wasm signature carries the **receiver as param 0** (the class
struct ref) — so under the current vocabulary *no member is ever eligible*.
Phase 1 must add a third domain, `"receiver"`, valid ONLY at position 0 of a
member, whose `IrType` is the member's own class struct ref (from the
overrideMap entry / `classShapes`). The body prover must correspondingly
accept `this.<field>` reads/writes **of f64/i32-typed fields of the own
class** (field types from `classShapes` — annotation-driven, checker-free,
same discipline as the boolean disambiguation at `:1611–1620`). Everything
else (string fields, extern fields, inherited fields, accessors, computed
names, constructors — implicit `return this` synthesis) stays compile-twice.

### Hazard 2 — a skipped member's parity mismatch must escalate, not keep-legacy

The existing guard (`src/ir/integration.ts:915–921`) handles a typeIdx
mismatch by "keeping the legacy body". **Under a skip there is no legacy
body** — the slot holds the #2138 `unreachable` placeholder, so silently
"keeping" it would ship a live trap. Change the guard: when the entry's name
is in `irFirstSkipped` and `(entry.classMember || entry.moduleInit)` parity
fails, push a **hard compile error** (the #2138 hard-error overlay channel),
never the keep-legacy warning. To keep that error unreachable in practice,
the skip predicate must be strictly *predictive* of parity: skip a member
only when every param/return position has an **explicit annotation** whose
`resolvePositionType` result is deterministic (no checker-inferred
positions), so both front-ends derive the identical signature and
`addFuncType`'s shape-dedup lands on the pre-allocated typeIdx from
`class-bodies.ts` by construction. (Note the pipeline-order subtlety: under
`JS2WASM_IR_FIRST` the planning block runs BEFORE `compileDeclarations`, so
the pre-allocated typeIdx does not exist yet at skip-decision time — the
decision must be made on signature *shape equality*, never on a typeIdx
number.)

### Phase 1 (M) — member skip eligibility

1. Thread member entries into `computeIrFirstSkipSet` (they carry
   `entry.fn` + `entry.classMember` in the overlay plan; key =
   `classMemberFuncKey`). Extend `resolveSignatureDomains` per Hazard 1.
2. Extend `irFirstBodyIsProvenLowerable` with the own-class `this.<field>`
   f64/i32 arms per Hazard 1.
3. **Caller fixpoint**: `collectLocalCallEdges` walks top-level call
   syntax — it has no edges for `obj.m()` method calls. Add edges
   caller → member-key for *statically-bound* method calls (receiver's
   declared class known, method not overridden — no `extends` involvement);
   any dynamically-dispatched call site ⇒ the member is NOT skippable
   (conservative, same spirit as the `<module-init>` exclusion `:1670`).
4. Guard escalation per Hazard 2 + a test that injects a parity mismatch on
   a skipped member (reuse the #1923 injected-build-throw seam) and asserts a
   loud `severity:"error"`, not a trap and not a silent keep-legacy.

### Phase 2 (S) — `__module_init` skip parity

`moduleInit` already shares the `:915` guard (#3142 Slice 2). Verify the
Hazard-2 escalation covers it identically once module-init units become
skip-eligible; no separate machinery.

### Phase 3 (deferred) — standalone generators

Keep deferred as the gate-2 notes conclude: legacy standalone generators are
the #680 sequential-numeric-yield native lowering and the IR path
unconditionally registers JS-host generator imports — self-sufficiency is
genuinely unproven, and the standalone native carrier (#2170) is a disjoint
lane. Re-open only with a measurement probe (compile a claimed generator
standalone with the skip forced, diff module sections), and only after the
#3032 W6 buffer-model decision — this is explicitly NOT part of closing
this issue.

## Implementation Notes — generator compile-once (2026-08-15, fable, main @ 7add6938)

### Deliverable 1 — class half is DONE (superseded by #3522), verified

A claim-dense class probe (constructors, instance methods, static methods,
instance accessors, static accessors, `extends` + override + `super()`,
implicit constructor, field initializers, generator method) found **zero**
double-compiled units — `TOTAL double-compiled units: 0`. Every IR-claimed
member reports `legacy=false, ir=true`. `check:ir-only` agrees:
`class-member: 10`, `legacy body emitted 0`.

Two member families never IR-CLAIM at all and stay legacy-only. That is
**compile-ONCE on the legacy side**, not the deviation-4 double-compile, so it
is out of scope here — but recorded because it is the residual the widening
track (#2855) still owns:

| family              | outcome code                | note                              |
| ------------------- | --------------------------- | --------------------------------- |
| static get/set      | `class-method`              | plus `static-class-initialization` on the module-init unit |
| generator method    | `class-member-unsupported`  | `*items()` inside a class; #3032 W4 territory |

**Deviation 4 (class members "always legacy then overwrite") is closed.** No
`irFirstSkipped` member-key work was needed: prepared/compile-once class
transactions land the members before the direct emitter ever writes a body,
which is a strictly better outcome than the skip-set widening the 2026-07-18
plan designed (Hazards 1 and 2 in that plan are moot — there is no
skipped-slot-with-no-body window to escalate).

### Deliverable 2 — the generator side-effect delta

The delta is **not** module state. Legacy generator compilation contributes
**no import, global, type, elem or tag** that the IR claim fails to register —
`addGeneratorImports` is driven by a *source-level* scan (`state.generatorFound`
in `declarations.ts`) and again by the IR claim itself
(`ir/integration.ts`), so the auxiliary machinery exists either way. Measured:
the shipped module is **byte-identical** before and after this slice
(`cmp` exit 0 on both probe programs, 1712 B and 413 B).

What legacy compilation actually supplied was **dependency-discovery
evidence**, and that is where the double-compile came from. Forcing the
generator onto the prepared route produced this exact failure list:

```
prepared owner …top-level-function:0 has incomplete dependencies:
  unplanned-abi-binding: external callable import|3:env|19:__gen_create_buffer
    has no Program ABI identity
  implicit-support-reference-unavailable: gen.push      resolves generator runtime callables without explicit symbolic refs
  implicit-support-reference-unavailable: gen.setReturn resolves generator runtime callables without explicit symbolic refs
  implicit-support-reference-unavailable: gen.epilogue  resolves generator runtime callables without explicit symbolic refs
```

Read this as the enumerated delta:

1. `gen.push` / `gen.epilogue` / `gen.yieldStar` / `gen.setReturn` resolved
   their host callables **by name inside `ir/lower.ts`**, so they were opaque
   to `derivePreparedComponentDependencies` — the component could never be
   dependency-complete and was peeled back to the direct route every time.
2. `__gen_create_buffer` (already symbolic, an ordinary `call`) had no Program
   ABI identity yet. That class of failure is retryable
   (`planBlockingCallableImports`) — but the retry only fires when **every**
   failure in the component is a plannable callable, so failure (1) suppressed
   it.

### The fix (why it is registration, not a wider skip predicate)

- **`src/ir/generator-support.ts` (new) — `attachIrGeneratorSupport`.** Mirrors
  `attachIrExternSupport`: after inference and middle-end transforms settle the
  value types, attach the exact runtime callable to each `gen.*` instruction
  (`__gen_push_f64|i32|ref`, `__create_generator`, `__gen_yield_star`,
  `__gen_set_return`, plus `__box_number` as `gen.setReturn.boxProvider` when
  the stashed value is `f64`/`i32`). Re-attachment is idempotent and rejects a
  conflicting binding, so a component cannot seal against one callable and
  lower through another.
- **`observeAttachedGeneratorProviders` (`ir/integration.ts`).** The load-bearing
  half, and the non-obvious one: **prepared-component sealing runs BEFORE the
  bodies are lowered.** A `runtime`-bound provider is only observed by
  `ProgramAbiCallableProviderRegistry` when `resolveAndObserveCallableProvider`
  runs, i.e. during lowering — too late. Sealing therefore reported every
  provider key as `unplanned-abi-binding` even after step 1, and
  `importsForPreparedProviders` returned `undefined`. Observing them right after
  `addGeneratorImports` (the same thing `prepareStrings` does for string
  providers) is what actually makes the owner dependency-complete.
- **`prepared-component-dependencies.ts`.** `implicitSupportRequirement` now
  returns `null` for a `gen.*` carrying a provider, and the providers are
  recorded as ordinary external callables. `gen.setReturn` fails closed when its
  `boxProvider` disagrees with the stashed value type.
- **`ir-prepared-free-functions.ts`.** `selectR2PreparedOwnerComponents` no
  longer excludes `asteriskToken` outright; generators are admitted when
  `generatorsPreparable(ctx)` (`!(standalone || wasi || strictNoHostImports)` —
  the same condition gate 2 uses). A generator's source return contract is the
  opaque generator object, a `val`-externref that the R2 signature vocabulary
  did not admit, so `allowOpaqueExternrefValue` widens it **for generator claims
  only**; `r2SignatureMatchesAllocatedSlot` still compares the projection
  against the already-allocated slot, so admission stays fail-closed.
- **`ir/lower.ts`** consumes `instr.provider ?? irRuntimeFuncRef(<name>)` so the
  emitted call is exactly the sealed one; the by-name fallback keeps the
  non-prepared route working unchanged.

Standalone/WASI generators are untouched by design — the gate-2 reasoning still
holds (legacy standalone generators are the #680 sequential-numeric-yield native
carrier, a disjoint lane whose self-sufficiency is unproven). Phase 3 of the
2026-07-18 plan stands.

## Test Results — 2026-08-15 (fable)

**Probe outcome flip** (`export function* counter(n: number) { for (let i = 0;
i < n; i++) yield i; return n; }`, `trackIrOutcomes`):

| | before (main @ 7add6938) | after |
| --- | --- | --- |
| `counter` unit | `legacy=true, ir=true` | **`legacy=false, ir=true`** |
| `irFirstSkipped` (flag on) | `[]` | `["g"]` / owner listed |
| for-of drain `counter(5)` | `[0,1,2,3,4]` | `[0,1,2,3,4]` |
| terminal `next()` after 2 yields | `{done:true, value:2}` | `{done:true, value:2}` |
| shipped module bytes | 1712 | **1712, byte-identical (`cmp` exit 0)** |

**Class probe** (deliverable 1): 8 programs, 0 double-compiled units — evidence
table above.

**Gates**

| gate | result |
| --- | --- |
| `tests/issue-2035.test.ts` | 11/11 pass |
| `tests/issue-2951.test.ts` | 7/7 pass (2 stale compile-twice assertions updated to the compile-once contract, 3 new cases added) |
| generator suites: `generators`, `generator-iife`, `generator-yield-contexts`, `generator-method-destructuring`, `for-of-string-generator` | 25/25 pass |
| `issue-1665`, `issue-2079`, `issue-2157`, `issue-2169`×3, `issue-2172` (standalone / native carrier) | 56 pass, 1 todo |
| `issue-2571`, `issue-2581`, `issue-2662`, `issue-2864`, `issue-3032`×2, `issue-4412`, `benchmark-module-size-generator` | 87/87 pass |
| `issue-3143`, `issue-3519-ir-only-gate`, `issue-3519-ir-outcomes` | 26 + 38 pass |
| `pnpm run check:ir-only` | **READY** — 5/5 entries, 37 units, `legacy body emitted 0`, 0 unsupported, 0 invariants |
| `pnpm run check:ir-fallbacks` | **OK** — no unintended / post-claim / module-level increases |
| `node scripts/equivalence-gate.mjs` shards 1/8…8/8 | **no new regressions** in any shard (several baseline entries report as newly-fixed; baseline deliberately NOT ratcheted here — unrelated to this slice) |
| scoped test262 generator stride, 640 files (`language/{statements,expressions}/generators`, `built-ins/GeneratorPrototype`, `built-ins/GeneratorFunction`) | **0 divergences** base vs branch — `{ok: 522, ce: 118}` on both, compared per file |
| `npx tsc --noEmit` | clean |

Method note for the two A/B rows: measured by restoring the five touched `src/`
files to `HEAD` (file-copy A/B, never `git stash` — shared stack) and re-running
in the same worktree, so "base" is literally main @ `7add6938` with the same
node/vitest.

**Pre-existing RED, NOT this slice** (both re-verified by restoring the five
touched `src/` files to `HEAD` and re-running — identical failure):

- `tests/issue-2138.test.ts` → `stringy("x")` returns `"x"`, expected `"ax"`
  (1 of 7).
- `tests/issue-2138-multi-module-ir-overlay.test.ts` → V8 heap OOM in this
  container (also OOMs at `--max-old-space-size=6144`).

Not run per instruction: full test262.

**Status call.** Both halves that this issue actually scopes — deviation 3
(generators compile twice) and deviation 4 (class members compile twice) — are
closed and measured. Left at `in-progress` rather than `done` only because this
branch is handed to a merger, who should flip it at merge. Nothing below is a
residual of #2951's own scope:

**Residual scope after this slice** (tracked elsewhere, listed so it is not
mistaken for unfinished #2951 work)

1. Generator **methods** (`class Seq { *items() {} }`) and generator function
   **expressions** still never IR-claim (`class-member-unsupported` /
   `body-shape-rejected`), so they remain legacy-only — a claim-coverage
   question owned by #3032 W4 / #2855, not a compile-once question.
2. Static accessors (`class-method`) + `static-class-initialization` module-init
   — same category.
3. Standalone/WASI generators stay compile-twice by design (Phase 3, deferred).

### Acceptance (updated for the redesign)

- A claim-dense class corpus probe shows member keys in
  `CompileResult.irFirstSkipped`; each skipped member's shipped body is the
  IR body (byte-diff anti-vacuity, the established pattern).
- Flag-off byte identity preserved (default CI path untouched — all of this
  is dead unless `JS2WASM_IR_FIRST=1`).
- `tests/issue-2138.test.ts` index-layout-invariance extended to a
  class+method corpus; the Hazard-2 escalation test above.
- Full `merge_group` net-zero with the flag on via the `ir_first`
  measurement lane (same as the generator half).

## Re-scope + Implementation Plan (fable, 2026-08-15 — IR-path-only migration session)

Live measurement on main @ `7add6938` invalidates half this issue and
confirms the other half:

- **Class-member half: superseded by #3522** on the bounded corpus. The
  `check:ir-only` single-host lane reports `class-member: 10` units, **0
  legacy bodies** (37/37 IR overall) — prepared/compile-once class
  transactions landed. First deliverable: a claim-dense class probe
  confirming no member family still double-compiles; record the evidence
  here and mark the class half done. Residual scope only if the probe finds
  a double-compiled family.
- **Generator half: LIVE.** Probe (2026-08-15): `export function*
  counter(n: number) { for (let i = 0; i < n; i++) yield i; return n; }`
  compiles with `trackIrOutcomes` showing the generator unit at
  `legacy: true, ir: true` — the generator body still compiles twice and
  the legacy body is only later overwritten. `irFirstSkipped` is empty.

### Plan (generator compile-once, host mode)

1. **Measure the side-effect delta.** Compile a claimed generator with
   legacy body emission forcibly skipped (patch or env probe in `.tmp/`);
   diff module sections (imports, globals, funcs, elems) vs the normal
   build. Enumerate exactly which auxiliary machinery legacy generator
   compilation contributes that the IR path (`addGeneratorImports` and
   friends) does not.
2. **Route generators through the prepared/compile-once mechanism free
   functions already use** (`src/codegen/ir-prepared-free-functions.ts`,
   `computePreparedInheritedIrFirstSkipUnitIds`) once the IR path
   registers everything the diff found missing. Prefer making the IR claim
   register the missing pieces over keeping the double-compile.
3. **Standalone generators stay out of scope** (gate-2 notes above stand:
   #680 native lowering is a disjoint lane).

### Acceptance

- The probe generator's unit outcome flips to `legacy: false, ir: true`;
  a for-of driver over it still runs correctly (issue-2035 + generator
  suites green).
- `check:ir-only` single-host lane stays READY (async.ts entry contains
  generator-adjacent shapes — do not regress it).
- `check:ir-fallbacks` no unintended/post-claim growth; `tsc --noEmit`
  clean; scoped generator test262 sample (built-ins/GeneratorPrototype +
  language/generators strides) net-zero vs main.
