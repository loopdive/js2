---
id: 2951
title: "IR-first skip set: include generators and class members (retire the two #2138 standing exclusions)"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-04
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
