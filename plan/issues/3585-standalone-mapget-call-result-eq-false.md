---
id: 3585
title: "Standalone: `m.get(k) === lit` false in direct call-result position (true via a local); an any-keyed Map poisons even typed Maps module-wide"
status: ready
sprint: current
created: 2026-07-25
updated: 2026-07-25
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: Map, equality
goal: standalone-gap
related: [2773, 2141, 2040, 3053]
origin: "2026-07-25 Fable substrate/async review (plan/agent-context/fable-substrate-async-review-2026-07-24.md), probe s2h/s2i"
---

# Standalone: Map.get result compared in direct call-result position answers false

## Problem (verified on main 7652f0337, target: standalone)

Comparing a `Map.get()` call result **directly** against a numeric literal
answers `false`, while routing the identical value **through a local** answers
`true` — in the same module, same map, same key:

```ts
export function test(): number {
  const a: any = { v: 1 };
  const arr: any[] = [a];
  const m = new Map<any, number>();
  m.set(a, 7);
  let code = 0;
  if (m.get(a) == 7) code += 1; // direct loose  — FALSE (wrong)
  if (m.get(a) === 7) code += 2; // direct strict — FALSE (wrong)
  const g = m.get(a);
  if (g == 7) code += 10; // local loose  — true
  if (g === 7) code += 20; // local strict — true
  if (arr.length === 1) code += 100;
  return code; // node/gc: 133 · standalone: 130
}
```

**Silent wrong answer** — no trap, no refusal. `if (map.get(k) === v)` is an
extremely common idiom, so the blast radius is large.

### Module-composition sensitivity (worse)

The presence of an **any-keyed Map elsewhere in the module** poisons even a
fully **typed** `Map<object, number>`:

```ts
export function test(): number {
  const a: any = { v: 1 };
  const m = new Map<any, number>();
  m.set(a, 7); // ← any-keyed map present
  const m2 = new Map<object, number>();
  const plain = { v: 2 };
  m2.set(plain, 3);
  const g = m2.get(plain);
  let code = 0;
  if (g === 3) code += 1; // via local  — true
  if (m2.get(plain) === 3) code += 10; // direct strict — FALSE (wrong)
  if (m2.get(plain) == 3) code += 100; // direct loose  — FALSE (wrong)
  return code; // node/gc: 111 · standalone: 1
}
```

In **isolation** (no any-keyed Map in the module) the typed-map version passes
(probe s2c: 111110 everywhere). So which reader/eq path `m2.get` takes is
decided by unrelated module contents — a representation-coherence violation of
exactly the #2773 class: the call-result-position value reaches the eq lowering
in a different representation than the local-materialized one, and the
module-wide carrier selection shifts when an any-keyed Map exists.

Not IR-related: identical divergence with `experimentalIR: false`.

Host (gc) lane is correct in all variants. `m.has(...)` is correct; arithmetic
on the value (`(g as number) + 0 === 7`) is correct — only the ==/=== lowering
against the direct call result is wrong.

## Suspected area

Standalone Map carrier value read (collections codegen) returning an
externref/boxed rep in expression position, vs the any-eq / tag-5 classifier
path (`src/codegen/any-eq-helpers.ts`, `any-helpers.ts` tag5 emit) not
unboxing that rep. The local-assignment path forces an unbox via rep
inference, which is why the local variant works.

## Acceptance

- Both probes above return the node value (133 / 111) under
  `target: "standalone"`.
- Add both as standalone regression tests (direct-position and
  module-composition variants).

## 2026-10-04 — Astra PR6234 nullish observation repair proposal

### Authority and exact unfinished acceptance

Docs-only plan in
`/Users/thomas/Code/js2/.codex-worktrees/3585-map-nullish-plan-astra`, branch
`codex/3585-map-nullish-plan-astra`, explicit root-authorized base
`7c8edb29224f7497bc2be8544dfabc166f4dd63d`. The preceding 96 lines are preserved,
SHA256 `75b3b5d6a803ac80435d4a87c6565f76033b5749b191b0ae7891a49d25e9f17c`.
No source, test, runtime, provider, IR, registry, dependency, assignment or PR
was changed. The older R2-A and peer planning worktrees remain immutable.
The local upstream/main ref still names ec3c; no fetch or configuration repair
was attempted. This plan deliberately uses the explicit approved 7c8 base.

Read the complete 369-line donor MD, complete 337-line test and entire three-
file PR diff in `/Users/thomas/.codex/worktrees/intl-hostfree-plan/js2` at
`9bb4f293940e0029dff22ad1d224febde903d424`. Live GitHub read confirms PR6234 is
OPEN/DRAFT at that head, three changed files. Root reports the same three
current CI failures; the retained `.tmp/3585/root-post-main-focused.log` also
records 7 PASS / 3 FAIL of the unchanged ten tests:

- `nullishAndTypeMismatch`: actual 2, required 3.
- `mixedSeedStringAndNullish`: actual 687, required 1023.
- `nullishMapResults`: actual 42, required 63.

The existing numeric 133/111, typed-string 5, object identity 15, mixed-string
15, alias 3 and source-defined Map 1 controls must remain. The combined object/
nullish test also retains its separate object-identity assertion. Test counts
and exported-function assertion counts are different denominators.
No new execution was performed for this architecture review.

These are existing PR acceptance repairs, not four original Test262 gains.
The frozen Map originals concern append-new-values (NaN versus valid), two
iterator-entry abrupt completions (Test262Error versus TypeError), and
proto-from-ctor-realm (null property access). No direct-nullish original has
been attributed to this seam. The frozen 11,778 corpus/oracle remains authority.

### Actual producer, reader, and representation proof

`map-runtime.ts::tryCompileNativeMapMethodCall` returns raw `anyref` for get.
`ensureMapHelpers`'s `__map_get` reads `$MapEntry.F_VALUE` unchanged on a hit.
Under `undefinedSingletonActive`, its miss is the tag-1 undefined singleton;
legacy flag-off misses are raw null. `compileCollectionElementArg` stores
literal undefined as that singleton and literal null as `ref.null NONE_HEAP`.
Other already-boxed GC values pass through `coerceArgToAnyref` unchanged.
Therefore an AnyValue tag-0 box can also represent a stored null: do not assume
that every Map null arrived as a literal or raw null.

The nullish shortcut in `binary-ops.ts::compileBinaryExpression` runs before
`compileTypedBinaryDispatch`. It calls
`property-nullish-read.ts::compileNullishObservedExpression`; calls currently
fall through to ordinary compileExpression, so the actual raw anyref reaches
a consumer without an anyref arm. The retained WAT has call/drop/constant
comparisons. Changing only the later typed-dispatch equality arm cannot repair
this earlier loss. Neither Map storage nor the native get implementation is
the demonstrated defect in these three acceptances.

The existing externref nullish arm is coherent for a CANONICAL external value:
strict null uses ref.is_null; strict undefined invokes __extern_is_undefined;
loose comparisons OR those predicates; inequality negates the result.
`ensureExternIsUndefinedImport` routes native-first through ensureObjectRuntime,
whose `buildIsUndefinedExternBody` recognizes tag-1 and the exact numeric
undefined sentinel while rejecting raw null in the singleton regime.
No semantic host import is needed or permitted in standalone.

`type-coercion.ts::coerceType` has an exact raw-anyref-to-externref arm:
`extern.convert_any`, without allocation, a cast, a drop, or value conversion.
That preserves raw null and the undefined box, but ALONE is insufficient for
boxed tag-0 null: its externref is non-null. The existing
`any-helpers.ts::ensureAnyToExternHelper` supplies the missing projection:
tag-0 becomes raw external null under the singleton regime; tag-1 remains its
boxed undefined representation; numeric/Boolean and proven native-string tags
use their established projections; other boxes retain their identity-bearing
wrapper. This helper must only receive a proven AnyValue, never an unchecked
arbitrary anyref. There is no new representation or Map field change.

### Chosen implementation: one observation seam, shared pure classifier

Request root's review of the following three production-file groups, plus the
existing owned test and this MD. Do not implement both this and a binary-ops
reroute as competing fixes. No source GO is implied.

1. NEW `src/codegen/helpers/direct-map-get-observation.ts`: move the PR's
   `unwrapDirectMapGetOperand` and `isDirectOracleClassifiedMapGet` here with
   unchanged semantics. Export only the predicate; keep wrapper unwrapping
   private. Runtime imports may be syntax utilities from ts-api only; context
   is a type-only import (or minimal structural oracle argument). No shared,
   index, registry, compileExpression, coercion or Map-runtime value import.
   This is a dependency leaf, not another member of the codegen cycle.
2. `binary-ops-typed-dispatch.ts`: replace those two private definitions with
   the leaf import, keeping `tryCompileDirectOracleMapGetEquality`, its native-
   first lane gate, call site and emitted comparison behavior unchanged. This
   is mechanical reuse of the parked author's classifier, not new equality
   scope or a rewrite of the 5357 reference arms.
3. `property-nullish-read.ts::compileNullishObservedExpression`: add the narrow
   call-observation branch BEFORE the generic final compileExpression fallback,
   using the shared classifier. Keep `compilePropertyAccessForNullishObservation`
   and its private-field, 5312 uninitialized-field, realm-global, fnctor-prototype,
   moduleUsesDelete and arguments.callee decisions unchanged.

The new observation branch's pre-admission is standalone OR WASI, nativeStrings,
native-first semantic providers, and active undefined singleton, plus the exact
existing oracle Map-get predicate. Unknown oracle answers decline; a source
class named Map and arbitrary `.get` are not admitted by spelling. Type-only
wrappers may be removed for CLASSIFICATION, but compile the original expression
once, not its receiver/key again or a newly synthesized helper call. Do not
assume an expected externref argument to compileExpression coerces its result.

Preparation for an admitted source occurs before live operands: reserve the
existing union boxing helpers through `addUnionImportsViaRegistry`, the existing
AnyValue type, __any_to_extern and native __extern_is_undefined; flush existing
late shifts. Use existing exports/delegates, no new registration hook or index.ts
import. Missing required helpers must be an explicit implementation stop, not
the generic null/undefined fallback. All helpers are existing definitions.

Compile the original call once and inspect its returned ValType. Only actual
`kind === anyref` enters the new normalizer. Other results are returned exactly
as compiled; never recompile on a post-emission decline. Stage raw anyref in a
proper scratch local; emit ref.test against the REAL existing AnyValue type:

- True: load that same local, ref.cast AnyValue, call the current registered
  __any_to_extern handle, producing externref.
- False: load that same local and use existing coerceType(anyref, externref),
  preserving raw null, ordinary refs, native strings and other real carriers.

Join both arms as externref and return that actual ValType to binary-ops. Use
fresh instructions, correctly scoped scratch lifetime, and re-resolve live
handles after preparation/expression lowering rather than bake a stale index.
No ToPrimitive, valueOf, property Get, clone, new Map lookup or user hook occurs
in this projection. The pre-existing call retains its evaluation/throw behavior.
Do not admit all raw anyref producers merely because this representation bridge
would also happen to compile for them.

Singleton-off lanes cannot distinguish producer-conflated null and undefined;
leave them byte/behavior-preserved, do not claim conformance there. Pure host
and non-nativeStrings paths remain unchanged. The native-first/WASI boundary
must be measured with the same real regime as the selected test lane; no hidden
flag/provider change may manufacture a pass. No Map, WeakMap, Set, IR, global
equality, oracle, context-field or primitive-layout edit is authorized.

### Finite verification, including representation controls

First integrate PR6234's current three-file patch on the explicit current source
base without dropping the donor MD history. Root must approve the full exact
test/supplement manifest before a runtime lease. The existing ten test sources,
exports, assertions, expected numbers and WAT checks are frozen. Their required
result is 10/10, not merely three values repaired with another PASS lost.

Freeze a separate supplemental matrix before implementation/runs:

- Missing key, stored undefined, raw literal null, and a value supplied through
  a heterogeneous number/string/null/undefined binding. Observe all four
  operators ==, !=, ===, !== against both nullish literals in BOTH orders.
  Require WAT evidence that the boxed-null witness actually stores a tag-0
  AnyValue; if it does not, it is not a boxed-null positive control. Do not
  silently substitute a plain literal-null witness or change the frozen ten.
  Independently prove the stored boxed tag-1 and nominal raw-null witnesses;
  source annotation alone does not establish any of these physical carriers.
- For missing and stored undefined: strict undefined true, strict null false;
  for stored null: strict null true, strict undefined false. Each loosely equals
  both nullish values. Every inequality is the exact complement.
- Number zero, Boolean false, ordinary NaN, empty string, object identity,
  Symbol and BigInt values are neither null nor undefined. No numeric coercion
  or fake null may enter the observation normalizer.
- Direct/local parity, ordinary const alias, and transparent type wrappers.
  Unknown receiver, source-defined Map, unrelated get and returned non-anyref
  keep established paths. Include native-first, pure host and singleton-off
  preservation controls without changing the primary options.
- Receiver and key side effects each run exactly once in source order; key
  throw preserves the same thrown object and performs no second get. A get
  that mutates an observable counter does not run twice. Preserve existing
  nested comparisons and get-as-key calls without scratch-local lifetime reuse
  corrupting an outer staged value. Preserve existing
  method dispatch behavior; a new method-override defect is not authority to
  edit Map-call lowering as part of this observation fix.
- Uninitialized public/private field, deleted property, function `.prototype`,
  realm-global binding, element read and nullable string/field sentinels retain
  their existing property-observation routes and baseline PASS results.

Use matched baseline/candidate/removal/restored with identical manifests/options,
actual terminal outcomes, validation, imports, source/binary/WAT hashes. Positive
WAT proof must name actual numeric callable targets: get once, raw conversion
or AnyValue guard/projection, then the native undefined predicate or null test.
An absent drop/constant pattern alone is not proof; neither is compiler success.
No env semantic imports. Stop on the first complete bounded repair, any baseline
PASS loss, or the exact first unsupported representation; no adaptive fixture
changes, storage rewrite or population gain estimate.

Run normal type/lint/format, LOC/function, coercion, dependency-cycle, codegen/IR
boundary and flat-directory gates. The syntax leaf lives in helpers, outside
the flat codegen root, and may not import its consumers at runtime. Confirm the
graph rather than assuming a move fixed a cycle. Existing issue allowances do
not authorize new unrelated growth; request only exact justified scope if needed,
never edit ratchet baselines or grant a gate waiver. Publication hooks remain.

### Current ownership and exact overlap adjudication

Maintained pre-dispatch gate returned STOP, not whole-file CLEAR. It positively
found PR6234, bare 3585, umbrella5151 and Temporal5383. Live maintained reads of
upstream/issue-assignments found 1033 held records. The server ref was verified
as `6ceba539d4d75e61b6c3413fa181b636ca6afdb2`; exact raw records were read at
that immutable object, not inferred from age or a done MD.

- Real Map leaf `3585:direct-result-equality`: held by
  `ttraenkler/codex-3585-map-result-equality`, branch
  `codex/3585-map-result-equality`, write `38766-eiag86he`. Root has the parked
  author's positive handoff. Its old authority covers typed-dispatch/test/MD,
  NOT this newly proposed observation seam.
- `3585:pr-6234-nullish-repair`: current maintained check UNASSIGNED. Proposed
  own repair leaf only; no ledger mutation performed. The bare held 3585 is
  `senior-dev-vacuity`/`issue-3585-toplevel-throw`, the unrelated July work
  renumbered3592, as donor MD lines88–110 explain; do not steal or release it.
- MD5151 lines724–747 explicitly identifies the direct-equality defect as
  separate issue3585, not proof of its original storage/read failure. The
  umbrella record is unassigned/reserved; dynamic-size-descriptor and other
  collection owners are untouched. No Map-runtime or inference edit proposed.
- Held5312 (`14388-aljt3ds2`) owns uninitialized-field observation inside
  compilePropertyAccessForNullishObservation and binary-ops's field arms.
  Held4480 (`23832-66ofrl3g`) owns the fnctor-prototype interception in that
  property function. Both are positive SAME-FILE adjacency, distinct unchanged
  hunks from the proposed direct-call branch in compileNullishObservedExpression.
- Held5357 (`21241-8zzyxptl`) owns reference-equality helpers and typed-dispatch
  wrapper/Boolean-reference arms. Those remain unchanged; moving our private
  Map classifier does not transfer that equality ownership. Held5383's relevant
  current mechanisms are ToBoolean and mixed-BigInt/Temporal consumers; none
  requires changing binary-ops, coercion-engine or its provider here.

The complete 16-PR path inventory retained by the R2-A donor was consulted;
no property-nullish-read path appears in that snapshot. This is not a timeless
absence/clearance claim. PR6468 was independently read through all five file
pages (402 unique paths), same head `3c8df848b88b74d085df64ae787be8b20bba3980`:
its actual typed-dispatch patch adds the S19 explicit default ToPrimitive hint
and imports in the later loose-equality arm; it does not edit the proposed
Map classifier or observation branch. Preserve that positive same-file patch.
PR5753's coercion/equality and PR5784's binary-ops paths stay outside this plan.
The author's three-file PR6234 patch itself was fully read, not inferred from
an inventory. Refresh exact changed heads/hunks before actual dispatch.

Requested root decision: clear only the three production groups above under
the parked-author repair leaf, plus immutable tests/MD, after confirming the
5312/4480 distinct-function and 5357 distinct-arm adjudication. No broad binary-
ops permission is needed for this chosen plan. If another owner reserves the
exact new call-observation hunk, ask that owner rather than infer release.
No source GO, claim, runtime acceptance, merge readiness or issue closure here.

## 2026-10-04 — fixture modernization after actual three-program diagnosis

Docs-only supplemental plan in this planner's original isolated worktree.
The complete preceding 341 lines are preserved, SHA256
`d735fb5885e2b6e858f7c8e3c37e767f5b429034015de4ed283b855c715cc2b9`.
Read the complete current 337-line published fixture and donor terminal
handoffs in `/Users/thomas/.codex/worktrees/pr-6234-nullish-repair/js2`.
No source/test/IR edit, runtime execution or ownership change was made.
This separate dirty MD is EXCLUDED from the already approved two-MD docs
publication checkpoint until root reads and separately accepts this addition.

### What the actual diagnostic establishes

The retained three unchanged source programs require 1023, 15 and 3. Actual
matched baseline/candidate runtime values are 687/1023, 15/15 and 3/3.
All three unchanged structural assertions still FAIL because the exported
bodies have no direct call target named `__extern_strict_eq`. That historical
failure remains a failure; modernization cannot relabel its old receipt.
Mixed-string and alias binary/WAT/exported-body bytes match across both arms.
The frozen fixture itself hashes to
`e57e1ee4c5785d3631256d62487d60794eefc7ef2dd940a9c7984aacee56d476`.

Independently read the actual alias candidate binary section 7, without
compiling or executing it: function export `aliasedMapGet` is index 50;
renderer exports are 340/341 and exception-tag export is tag index 0.
The WAT text says `(export "aliasedMapGet" (func 2097202))`; that is an
opaque internal handle spelling, NOT physical function ordinal 2097202.
The zero-import binary's physical function 50 agrees with the WAT declaration
ordinal 50 and its `aliasedMapGet` body. Function ordinal 324 named
`__extern_strict_eq`, type 77, is exactly an `unreachable` stub. The exported
body instead contains `__inl3_p0/p1` externref locals and
`__inl3_a_any/b_any` anyref locals plus the expanded equality logic.
Binary SHA256 is
`4b311cbe77c05a2e525ee8e2a1d9c43b7656952cea495e719e8ca92bb9701b6a`;
WAT SHA256 is
`ed67770912b9f148bc9a22bfae0a8217277e28b6fe1691a73404b4b72dc898ea`.

This is supported by exact compiler producers/consumers, not a name-only guess:

- `strict-eq-reference-arm.ts:122–141`, `nativeStrictEqualityInstrs`,
  reserves `ensureExternStrictEqHelper`, flushes shifts, re-resolves the live
  `funcMap` handle and emits a genuine call over the two staged externrefs.
- `codegen/index.ts:7122–7123` runs `inlineUserFunctions` and immediately
  `sweepAfterInline` in ordinary finalization.
- `ir-inline.ts:1183–1186` reads the existing `JS2WASM_IR_INLINE` flag on
  every invocation. Unset selects the shipped on preset; `0` disables this
  pass. Its rewrite at 1442–1490 creates fresh typed parameter/local copies,
  spills arguments in reverse order, relocates instructions and wraps them
  in a result block. The generated local names match the retained artifact.
- `function-reachability-sweep.ts:179–209` replaces unreachable bodies with
  a single `unreachable`, preserving function slots instead of renumbering.
  Thus a remaining helper declaration does not prove it is a live call edge.

The default alias value 3 does NOT alone prove its generic equality fallback
executed: a native-string fast branch can settle a comparison earlier. Do not
use cloned local names, helper presence, or a broad inliner poison trap as a
standalone proof of that specific branch's execution.

### Chosen minimal correction: default behavior plus no-inline attribution

Use the ALREADY EXISTING per-compile `JS2WASM_IR_INLINE=0` inspection lane,
not a new compiler flag, forced production call, IR edit or source-shape trick.
`tests/issue-4780-devirtualization-routes.test.ts:142–166` is an existing
precedent for saved/restored environment scope around one compile while
retaining a real default lane. `tests/issue-4157-ir-inline.test.ts` independently
documents the on/off behavioral contract. This proposal does not change either
foreign fixture or their inliner ownership.

Scope proposed for Sol after root's fixture grant is ONLY
`tests/issue-3585-map-get-direct-equality.test.ts` and its own MD handoff:

1. Keep all ten original test identities, all original source literals,
   filenames, compilation options and EVERY existing runtime expectation.
   In particular retain default 1023/15/3 and 133/111/5, both object-identity
   expectations, nullish 3/63, both-orders 15 and user-Map 1. Keep validation,
   zero-import assertion, direct-string anti-drop check and user-class negative
   native-Map check. Default means the ordinary shipped flag state, not a
   suite-wide off pin. Record/restore any incoming environment faithfully.
2. In the three affected tests, first execute the unchanged default compilation
   and its runtime assertion. THEN compile the identical source/options once
   in the narrow no-inline lane, validate/instantiate it normally, and require
   the SAME expected runtime result. Preserve the one-distinct-numeric-target
   assertions for `__any_eq` where currently required and
   `__extern_strict_eq` in all three, but apply these call-edge assertions to
   that independently inspectable no-inline artifact. Do not loosen them to
   "helper declared somewhere", an optional empty set, or a call OR name regex.
3. Save the old flag before setting it and restore it in `finally`, deleting
   only when originally absent. Execute the two arms serially, with no
   concurrent test changing process-wide flags. Do not set optimize, provider,
   native-string, singleton, host-bridge or IR routing flags to obtain edges.
   No-inline is a supplemental structural arm, never replacement default
   acceptance. If it still lacks the expected edge, STOP: do not broaden flags
   or relax the requirement until actual producer evidence explains why.
4. Retain the compiler's returned binary in the fixture-local result type.
   Resolve the named function export from actual binary section 7, with bounded
   unsigned LEB128/name decoding and function-kind validation. Under the
   existing zero-import invariant, map physical index to declaration ordinal;
   require the corresponding function and type/signature to exist. Never use
   the opaque numeric WAT export operand as the ordinal or select the first
   duplicate display name. Existing direct call operands must be checked for
   range and mapped to actual declarations. Fail closed on unsupported WAT
   shape, imports, malformed sections or unresolved targets.
5. Strengthen the inspected helper proof: all matching calls use ONE registered
   physical target index of the intended helper and compatible real signature
   (strict helper: two externrefs to i32), and its no-inline body is not a
   dead `unreachable` stub. Do not demand a globally unique display name:
   unused same-name declarations do not change the numeric call identity.
   Preserve `__any_eq`'s separate required identity/signature assertion.

This is a finite behavioral equivalence check plus an independent pre-inlining
call-edge witness, not a general proof that all inliner transformations are
correct. The source rewrite and observed default expansion explain why the
old post-pass direct-call condition is obsolete. No pre-pass compiler hook,
shared IR instrumentation or bespoke optimizer implementation is necessary.

### Positive and negative controls: do not merely remove an assertion

Before fixture changes, root should freeze a small additive manifest, separate
from the unchanged original ten and the existing 33 repair supplements:

- One new deterministic standalone Map comparison program, run in both ordinary
  and no-inline lanes, must exercise positive numeric equality and negative
  Number-versus-String strict equality; loose Number/String equality; same and
  different object identity; strict null-versus-undefined inequality; NaN
  inequality and signed-zero equality. Compare both operand orders. Use
  explicit truth expectations and complementary equality/inequality checks
  so replacing the result with constant true OR constant false loses controls.
  Root must read the exact source, expected bit assignment and carrier evidence
  before execution. This is proposed supplemental coverage, not an invented
  measured result or a replacement for missing boxed-null/number witnesses.
- Fixture-local observer unit controls use tiny controlled WAT/binary fixtures,
  not compiler or corpus mutations: a real export/call mapping passes; helper
  declaration with no call fails; a call to the wrong same-name index/type or
  two distinct matching indexes fails. Also reject an opaque WAT export token
  as a physical index and an out-of-range binary export. These demonstrate
  that the new structural reader cannot pass through mere name presence.
- Preserve the real default three-artifact evidence and collect no-inline
  counterparts. Record binary/WAT hashes, section-7 export mapping, helper
  target index/type/body and actual values for each arm. The default helper
  may be live or inlined; neither optimizer choice changes the runtime oracle.
  A generic `on,poison` affects every inlined site and is not selective enough
  to attribute failure to this equality helper; do not adopt it as that proof.

Keep all existing repair source/runtime/removal obligations and all 33
supplemental expectations, including unresolved physical and held-boundary
controls. Fixture modernization does not certify those remaining mechanisms.
Expected current candidate success must actually be measured; original
baseline 687 is still wrong even if the revised structural observation passes.

### Ownership, measurement and publication gate

The parked author's original test/MD scope and root's own PR6234 repair lane
are the intended fixture owners. Root must grant this exact fixture hunk after
reading the full plan; no new source permission is requested. Positive5357
reference-equality ownership, 4157 inliner and 6768 sweep ownership are READ
dependencies only. No codegen/index, backend, IR, sweep, registry, emitter,
shared fixture helper, guard manifest or ratchet change belongs to this plan.
No fresh claim/PR scan was performed or implied by this source-only review.

Under a later lease, run the unchanged original fixture once as the historical
contract arm and the explicitly versioned revised fixture under the same
compiler/source, followed by the approved finite observer/semantic controls.
Report source/runtime versus structural assertion verdicts separately and
retain the old three failures. The ordinary candidate must retain all runtime
expectations; revised structural acceptance must fail its negative observer
controls and preserve one-index registration in the no-inline lane. Stop on
any default-pass loss, bad binary mapping or missing inspection edge. No
adaptive test weakening or compiler change follows from such a stop.

Normal formatting/type/changed-root and relevant publication gates still apply.
Do not claim three new original Test262 passes, erase earlier FAIL receipts,
or mark PR6234 complete on fixture modernization alone. This appendix needs
root's full read before implementation and before any later docs-PR transfer.

## 2026-10-04 — transfer manifest for the existing docs PR6477

Root authorized a source-only transfer into the ONE existing docs publication
vehicle, [PR6477](https://github.com/loopdive/js2/pull/6477), after fully reading
both owned planning appendices. Publication worktree is
`/Users/thomas/Code/js2/.codex-worktrees/4016-split-residual-plan`, branch
`codex/4016-split-residual-plan`, published HEAD
`ab0ded1bbd1dd38959ad8352ef76f5964e84da82` at transfer time.
No new PR, hook, commit, push, build, test or CI-status read occurred here.

The destination was read completely: exactly 96 lines, SHA256
`75b3b5d6a803ac80435d4a87c6565f76033b5749b191b0ae7891a49d25e9f17c`.
It is byte-identical to the original donor prefix. No intervening or foreign
paragraph was present to reconcile. An append-only patch transferred ONLY
the 419 owned lines 97–515 from
`/Users/thomas/Code/js2/.codex-worktrees/3585-map-nullish-plan-astra`:
the original 245-line observation-seam proposal and the subsequent 174-line
fixture-modernization proposal. Entire transferred 515-line content hashes to
`7720b2206e0c5c2ec8c63c5fc3324d249cdbc232a83f7c4dc5636f8e7ee4e1b0`.
The donor remains unchanged. Earlier statuses and scope statements are dated
history, not new measurement or an assertion that old ownership snapshots
remain current. This additive manifest follows, rather than edits, that history.

The maintained check returned UNASSIGNED for
`3585:map-nullish-fixture-plan-docs`; the separately authorized normal claim
then returned verified upstream success, session85385 exit0, actor
`ttraenkler/join_residual_plan_astra`, current docs branch. This is a docs-only
leaf; neither the parked author's direct-result-equality leaf nor Sol's
production repair leaf was reassigned. No compiler/fixture/IR claim is implied.

Only this MD is newly dirty in the docs vehicle. Published MD4016 and MD2929
must remain byte-identical to their current published versions. Root must read
the exact transfer diff and this manifest before a later commit/push lease.
At that point the existing PR description should accurately say three issue
Markdown files instead of two, without changing the unsigned CLA or closing
any epic. Do not open another docs PR, stage the donor worktree, copy source or
fixtures, or start hooks while the native-provider build owns the heavy lease.

## 2026-10-04 21:44 UTC — current-head owned-PR audit and publication gate

Root requested one bounded audit of PR6476 and PR6477. The complete preceding
553-line transfer is preserved, SHA256
`5f54d68acd05b99eee1f36def638d97c229692a44fc0fbed8b077630db0b292c`.
This is an additive read-only-state handoff, not a watch. No hooks, builds,
tests, commit, push, CLA acceptance, review reply or queue mutation occurred.
The autopilot skill was used only for conflict/review/CI triage order; root's
explicit no-watch/no-repair restriction controls this pass.

### PR6476: queued current head, no repair justified

[PR6476](https://github.com/loopdive/js2/pull/6476) is OPEN, non-draft,
head `ff5c7c8d4a3af8c50fd962ae81ce70884e906a65`, base
`1787b1af4a2f010f51ca1f45fc68fa540bfa4673`, MERGEABLE/CLEAN, no labels,
merge queue position 1. Issue comments and review threads are both zero with
no next page; reviewDecision is null. The full head check-rollup connection
has no next page and no failing, pending or cancelled non-skipped context.

All six actual required workflow jobs are SUCCESS: [quality](https://github.com/loopdive/js2/actions/runs/37236089269/job/111535360606),
[equivalence-gate](https://github.com/loopdive/js2/actions/runs/37236089269/job/111535963270),
[CLA](https://github.com/loopdive/js2/actions/runs/37236087532/job/111535356221),
[cheap gate](https://github.com/loopdive/js2/actions/runs/37236089267/job/111535361738),
[merge reports](https://github.com/loopdive/js2/actions/runs/37236089267/job/111535377617)
and [regression aggregation](https://github.com/loopdive/js2/actions/runs/37236089267/job/111535377687).
Three same-name PR-stub jobs are SKIPPED and duplicate legacy CLA is SUCCESS;
neither adds semantic verification. All eight equivalence shards, changed
artifact fixture, native libquickjs build and non-required QuickJS lane are
SUCCESS. The PR's actual Test262 shard contexts are skipped; aggregation
success must not be counted as new original execution or measured goal gain.

Action: preserve this queued head; there is no source or CI failure to repair,
no unresolved thread to answer, and no reason to rerun or re-enqueue. Do not
push additional notes onto this producer PR while it is queued. Queue admission
is verified, not inferred, but merger/completion is not asserted. Root owns
any later event-driven check. No failure log was fetched because none is red.

### PR6477: quality pending; Map checkpoint remains private

[PR6477](https://github.com/loopdive/js2/pull/6477) is OPEN, non-draft,
head `ab0ded1bbd1dd38959ad8352ef76f5964e84da82`, same base1787,
MERGEABLE/BLOCKED, no labels and no queue entry. Comments and review threads
are zero, both complete; reviewDecision null. Its complete rollup has no red.

Required [quality](https://github.com/loopdive/js2/actions/runs/37236649943/job/111536976296)
is IN_PROGRESS. [CLA](https://github.com/loopdive/js2/actions/runs/37236649173/job/111536974514)
is SUCCESS (also one duplicate legacy success). Required equivalence-gate is
SKIPPED, not executed. Required cheap/report/regression jobs are SUCCESS in
the **Test262 PR stub** workflow, jobs111537026800/111537026796/111537026786
of run37236649811. They establish docs-path workflow disposition, not a
Test262 sweep. No failed log or speculative source repair is warranted.

Action: wait for root's separate hook/publication lease, not an automatic CI
watch. The accepted Map transfer and this dated handoff are the ONLY newly
dirty path in the docs worktree; published MD4016/MD2929 remain exact and
unstaged. No current source change can fix a merely pending quality result.
On a later grant, revalidate publication head/base and queue safety at that
meaningful new-checkpoint boundary, then stage only this MD, run all normal
commit/pre-push gates, and update the SAME PR body to three Markdown files
after the push is verified. Preserve unsigned CLA, original issue history,
all diagnostics and both production ownership leaves. If the PR has entered
the queue by that boundary, stop for root's direction rather than push over
a live queue head. A new red would require its actual failed log and exact
owned-hunk analysis, not gate relaxation or foreign adoption.

Fresh server main at this audit remains1787. No merge, fetch or base rewrite
was needed for this source-only preparation. This record supersedes the old
17fd P1 status only as a dated snapshot; it does not rewrite earlier evidence.

### 2026-10-04: actual Map25 checkpoint; completion remains withheld

Root supplied and fully reviewed the complete candidate25 row receipt
b5606d, actual handle16070 terminal exit1 with signal=null. All25 rows are
present:22PASS/3FAIL. The original ten assertions and twelve MOCK controls
pass; the added paired255 case fails with an __any_eq null-pointer trap.
The two additive observations both return runtime1, but their physical
helper attribution remains UNPROVEN. Preserve the paired255 expectation
and the unresolved physical checks; do not convert these into acceptance,
silently omit them, or mark PR6234 ready. The prior published three failures
remain historical evidence, not retroactively passing measurements.

The root-reviewed before/after inventory covers all7673 inputs with zero
mismatches (7cf74a inventory receipt); postverification fc8ebb and survivor
receipt3bddba completed before the implementation lane yielded its heavy
lease. This is a handoff of those actual receipts, not a new run by the docs
planner. No original Test262 gain or compiler repair is attributed to a
fixture-modernization observation. Any proposed trap repair needs its own
first-loss evidence, exact owned scope and separately reviewed plan.

This append preserves the accepted622-line prefix exactly, SHA256
8c83f45f80138083d74016b9d9aec8e30fab506c7e35125847b42b5b97d6361f.
It accompanies the separately frozen334-line native-observation transfer
in the same docs PR6477. Unfinished N1 instrumentation planning and the
newly exposed older-PR failed-log investigation are outside this checkpoint.
No hook, commit, push or runtime permission is inferred from this record.

## Astra: matched supplemental255 diagnosis and physical-proof boundaries

2026-10-04, source-only version after the frozen docs checkpoint. Preserve
the preceding649 lines, SHA256
3f0c5a3651eeec29fb441911fb0e2d440d311bcfc0113f2a2ef3dfa7f1efd187.
This appendix is NOT in the already queued PR6477 head. No source, fixture,
claim, provider, runtime, staging or publication action accompanies it.

### Reviewed inputs and exact source distinction

The read-only implementation worktree is
`/Users/thomas/.codex/worktrees/pr-6234-nullish-repair/js2`. Its complete
`.tmp/6234-supplemental-255-arm-contract.json` has SHA256
5041de06cf62b2e40e12ba96240c13529767f332396af2e70f483a55a1cbce04;
the complete `.tmp/6234-physical-variant-handoff-plan.json` has SHA256
66f20776b82ce90d7e939258c1c940f522cc510af7a4bd7c16d42f60d6594dd8.
Both were read fully, not inferred from their filenames or summaries.

The four proposed cases have identical source SHA256
4d3ccbe99f3adf0d48edb1615b5f091439e3f7429b8b4f89947496e07dd0a911,
export equalityComplements, no arguments and required255. Null/undefined
occur as Map.set values, never as equality operands. In the actual candidate,
binary-ops.ts:909–989 selects compileNullishObservedExpression only for a
literal-nullish operand (subject to its existing union-carrier exclusion).
Thus the new3585 observation guard is not selected by this source. This is
a source-routing fact, NOT proof of equal emitted code or a pre-existing trap.

The retained Map classifier still admits actual anyref direct Map.get operands
in binary-ops-typed-dispatch.ts::tryCompileDirectOracleMapGetEquality45–82.
strict-eq-reference-arm.ts::emitReferenceEqualityFromStack85–107 parks the
already-evaluated operands as externrefs; loose comparisons call
coercion-engine.ts::emitAnyEqFromExternTemps1075–1095, which converts each
through the existing fromExtern helper then invokes __any_eq. Strict compares
use the separate __extern_strict_eq route. A stack naming __any_eq does not
identify which of the many loose comparisons, carrier conversions or helper
fields first failed. Held5357 write21241-8zzyxptl covers these shared reference
equality contracts; its done frontmatter does not release the maintained hold.

### Finite four-arm diagnostic: approve the contract, not a repair

Use the independent ignored collector proposed in5041de, byte-identical in
the two already owned matched worktrees. Do not transplant the candidate
fixture into baseline. Baseline is the fdb116928 source integrated with public
9bb4f293,7672 inputs/8abaded4; candidate is the same integration plus the four
listed repair paths and v3 fixture,7673 inputs/7cf74a. Pin the complete
inventory, not only Git HEAD, because both contain intentionally uncommitted
integration/repair state. Exact paths/hashes remain in the reviewed contract.

Run baseline/default and baseline/no-inline as independent test identities,
to one actual terminal; stop for root review. Only a separate runtime GO may
run candidate/default and candidate/no-inline to their own terminal. Retain
Node24.19.0, parent/fork1024, one worker, standalone target, emitWat=true and
the frozen filename/options. Default explicitly unsets JS2WASM_IR_INLINE;
off sets it to0 only for compile and restores the incoming state in finally.
This uses an existing compiler option; it does not authorize IR edits.

Persist binary and WAT BEFORE invocation, then complete phase/result/error
metadata even when runtime throws. Prove nonzero valid binary, zero imports,
actual binary-section7 export index, function type, complete exported body,
numeric call targets and relevant helper definitions. Numeric opaque WAT
handles are not binary function indices. Record full stack/function-offset
data when available, without manufacturing an offset if the runtime omits it.
Each failure must leave the other lane's outcome observable. Missing artifact,
source mismatch or absent terminal means incomplete diagnosis, never PASS.

Interpret outcomes per lane, not by aggregate: candidate-only loss requires
tracing the four approved production deltas; matched failure in both states
supports a pre-existing failure only for that identical source/lane. Default
versus off divergence identifies an optimization-sensitive observation, not
proof of an optimizer defect. Even four identical signatures do not prove one
first-loss instruction. If offsets/call paths cannot select a subexpression,
stop with that uncertainty; splitting the program or adding counters needs a
new frozen diagnostic contract, not adaptive edits to expected255.

The original1023/15/3 controls remain unchanged preservation requirements;
their historical baseline/candidate runtime values687/1023,15/15,3/3 and
old physical-helper assertion failures remain recorded. They are not silently
added to this four-case runtime lease. No four-case outcome alone completes
the original ten assertions, twelve MOCK controls or supplemental physical
acceptance, and none is an original Test262 gain.

### Physical guard attribution is a separate experiment

Saved actual native-number evidence supports seed59/type58 producing struct52
for1.5, distinct from AnyValue62; MapEntry133 field1 stores the raw argument,
map_get323 reads that field, and the consumer tests62 before projecting331 or
taking the raw extern bridge. This is useful producer/storage/reader evidence,
but runtime1 still does not prove removal sensitivity or restoration.

Only future isolated branches may alter the NEW3585 guarded block in
property-nullish-read.ts::compileNullishObservedExpression. Before authoring,
check/claim exact3585:nullish-guard-removal-experiment and
3585:nullish-guard-wrong-cast-experiment leaves with the maintained tool and
obtain root review of exact patches and full input manifests. Do not mutate
the frozen implementation/baseline trees or adopt5357/5312/4480 ownership.

Removal substitutes only the existing rawProjection for the guard/if body,
retaining reservation order, one expression evaluation, local lifetime and
externref result. Wrong-guard substitutes drop;i32.const1 for ref.test after
the raw-local load, keeping stack validity; do not substitute a cast or forged
carrier as the test input. The exact inverse restores observer SHA410fc99b.
Use all original sixteen expectations and actual seed exports, with separate
artifact directories for candidate/removal/wrong-guard/restored. Tagged-null
and tagged-undefined are removal witnesses; raw-null and native-number are
negative controls, with native-number exposing a forced wrong cast. The plan
predicts discrimination, not measured outcomes: preserve contrary evidence.

No physical variant may become a workaround for the independent255 trap.
If four-arm artifacts point into shared5357 helpers, hand the exact source,
lane, producer carrier and first trapped instruction to that owner under this
existing issue. Request only the demonstrated helper hunk; no generic equality,
Map-storage, IR, registry, or baseline-ratchet permission follows. Stop after
the finite measurement and report all outcomes before any implementation.

### Matched-255 baseline measured; candidate held (2026-10-05 Berlin)

After separate root GO, the exact frozen baseline launcher ran once under
canonical Node24 with 1024 MiB parent/fork and one serial worker. Handle 84790
actually terminated with exit 1, signal null, chunk `1b235b`, at
`2026-10-04T22:00:22.552Z`. Both independent identities completed: 0 PASS,
2 FAIL, 2 unique, 0 skipped. Default and no-inline each compiled and validated
with zero imports, then threw `RuntimeError: dereferencing a null pointer`
inside `__any_eq` / `equalityComplements`. Default stack offsets are
55132 / 47649; no-inline offsets are 55187 / 47608. Expected 255 remains
unchanged; neither exception is converted into semantic or physical credit.

Full terminal receipt is the baseline worktree's
`.tmp/6234-supplemental255-baseline-run/terminal.json`, SHA-256
`dd37e003c34b1b725ae4afd940a4a7df8e20ae490e07e8ec8fc58b8eac51649e`.
The candidate worktree's independently checked full audit is
`.tmp/6234-supplemental255-baseline-audit.json`, SHA-256
`2e3a0fd312de722d94b95d8703b1f5d608d2a6d14ed5bd79a764e86b07aa0b2f`.
All six actual artifacts in the baseline worktree's
`.tmp/6234-supplemental255-baseline-artifacts/` match the receipt hashes:

- Default `00.json`: `dd4e08ba98d2a847563cd2ae18646411b7b782fd90a9ca79b1e4f9aac7439b50`;
  WAT: `635a5a4e63f7661eb731d7bb84ccb73bed8975e128d0164e214ca199a3393a85`;
  Wasm: `54d051d8271aa25064cd41c4f477bccb442c4bbd766cd7ab444cf3d308d02e19`.
- No-inline `01.json`: `88042ee2dd4b5de11d0420e00623b518126473bf79dc5e801b6fcacbdfb6456b`;
  WAT: `2e57d954989e3238ab1112a6b4e7cc8cd307a59fae61d6795cb34f6fabec2a3d`;
  Wasm: `fa1fc830c61f859126d54842228d80866cd65c047721656d67a623e7dd33eb97`.

Postverification `fa6590` actually terminated 0: before, after and current
7,672 baseline file hashes equal
`8abaded4c15760903dc4141242b64219ef1e4881e016b0a8c930db455ffe09ff`;
the two instrument pins are unchanged and the combined 7,674-input hash is
`f02a2ceb4c10f6a9948691f75834e67fa925c50d7fa08276b70d0b60f1a54b1e`.
Both artifacts resolve physical export 50, named `equalityComplements`, type
44 `(func (result f64))`. Actual helper indices/types are
`__any_from_extern` 87/79, `__any_eq` 316/144,
`__any_strict_eq` 317/144 and `__extern_strict_eq` 324/68.
The exact incoming inline flag was restored per case.

Scoped survivor read `c3bf13` returned empty: child 14709 and the exact
launcher/collector process matches were absent. The heavy lease was explicitly
yielded after these actual terminal and byte checks. No candidate-255 run,
source fix, hook, provider build, removal/wrong-guard variant or publication
was started. These baseline results alone do not establish a preexisting
candidate defect or locate the first failing source comparison. Candidate
measurement still requires separate root review/GO. All historical failures,
required physical proofs and foreign shared-helper holds remain intact.

## 2026-10-05: isolated documentation successor and publication manifest

The one-shot owned-PR audit at this completed diagnostic boundary verified
PR6477 MERGED at2026-10-04T21:57:43Z, exact queued head
ab0ded1bbd1dd38959ad8352ef76f5964e84da82, merge/current-main commit
fd60087e505e964b23c642bc20b3c2d7e3476c4f. Independent contents reads at BOTH
head and merge prove the landed bytes: MD4016 is834 lines/SHA256
4e32b97c7aecbebe6af9120a06bac7a5ac2221ed61d7945dcdd492798ca08114;
MD2929 is2555 lines/SHA256
1ee04474229db2d4348f400df83c984e3abce945db51020b80040da2b797904c.
Only that earlier two-document checkpoint landed. Later private N0/Map/N1
appends were never pushed over its queued head and are not credited to it.

Root authorized a separate isolated successor worktree
`/Users/thomas/Code/js2/.codex-worktrees/2929-3585-observation-checkpoint`,
branch codex/2929-3585-observation-checkpoint at exactfd60087. A pinned-object
fetch and normal worktree creation completed; no config/LFS/lock repair,
install, hook, source edit or runtime ran. All old worktrees remain intact.

Only TWO tracked paths are proposed for the successor documentation PR:
this MD3585 and the existing MD2929. MD4016 is already landed and unchanged.
Each transfer checked the actual main-file bytes before appending:

- MD2929 main prefix2555/1ee04474 remains exact. Copy only own unpublished
  lines2556–3122 from the prior docs worktree:567 lines containing the exact
  334-line N0 donor,35-line transfer manifest and198-line N1 proposal. The
  resulting3122-line file equals the entire owned donor SHA256
  2536366a46504ea62d6f502dc975e3dfae7429e3f86d01c9b5a33d1d8e4c5bde.
- MD3585 main prefix is actually96 lines, SHA256
  75b3b5d6a803ac80435d4a87c6565f76033b5749b191b0ae7891a49d25e9f17c.
  Copy only own lines97–763; resulting763-line prefix equals donor SHA256
  83679777e16ba906468687428c00f14b38447f04d5b92586f3b1a93f20adee2c.
  Then append the separately root-reviewed Sol baseline section872–919 as
  exact48 lines at765–812, separated by one blank line. Those48 lines have
  SHA25697817dbc86758c05b29ffc6cc26562dbe559273059e40df9b726339df03c7923;
  source donor whole SHA256
  c6b05bc35e61a3d9e8088f0a2c53f076e064c6d9f98b833f57f587e52a4749ae.
  No other Sol history, fixture, binary, script or raw artifact is transferred.

The native result remains67/60PASS/7FAIL and eleven4PASS/7FAIL; N1 is an
accepted architecture PROPOSAL with exact instrumentation grants unresolved.
Map's measured candidate25 remains22PASS/3FAIL; matched255 baseline is0PASS/
2FAIL. The baseline's candidate-held statement remains dated history: root
subsequently granted a separate candidate run, but its outcome is not in this
frozen publication manifest. No supplemental expected value, NaN fixture,
physical UNPROVEN result, shared-helper hold or original corpus row is waived.

Seven-PR audit receipt34c2e6a is retained in the prior docs worktree's ignored
shepherd-20261005 directory. Review-thread floors are zero for all seven;
comments/check connections are complete. PR5883 remains held/conflicting;
6206 and6246 draft/conflicting with prior quality reds;6234 draft/behind with
published acceptance reds;6435 draft despite green required checks and its
unwaived native67 gap. PR6436 advanced to001a56f8/base d74d but again fails
actual quality job111540501135: flat src/codegen829→830. Its held6809 owner
is not released. Neither that red nor the prior6246 cache-postvalidation and
5883 merge-group cycle failures authorize policy waivers or foreign repairs.

Publication remains NOT_RUN. Before staging, root must read the exact two-file
diff and this manifest, confirm docs-only leaf ownership on the successor
branch, and grant the normal-hook lease. At that meaningful boundary discover
any other open docs PR before creating a successor; preserve a queued vehicle
if one exists. Use Thomas/Codex attribution and the actual Astra High model,
all ordinary hooks, Description plus unchecked CLA template, upstream target,
and verified fork/PR heads. No epic closure or conformance gain is claimed.

### Matched-255 candidate measured; preexisting failure retained (2026-10-05 Berlin)

Following root's full baseline review and separate candidate-only GO, the same
frozen launcher executed the two candidate identities once. Handle 28602
actually terminated exit 1, signal null, chunk `388274`, at
`2026-10-04T22:04:57.989Z`: 0 PASS, 2 FAIL, 2 unique, 0 skipped. Both compiled,
validated and had actual zero imports. Default and no-inline each threw the
same null-pointer exception in `__any_eq` / `equalityComplements` with the
corresponding baseline offsets 55132 / 47649 and 55187 / 47608. Expected 255
and full source/options remain unchanged; the inline flag was restored.

Candidate terminal `.tmp/6234-supplemental255-candidate-run/terminal.json`
has SHA-256
`019064b7604d7fa1d3c78cef488237e499cd0efea28802b7cf830b52c12a1b4b`.
Bounded independently verified audit
`.tmp/6234-supplemental255-candidate-audit.json` has SHA-256
`66992fa7abcfb4656246e90f63e8c65b5c65b68eb761decc8669addbaf247c8e`.
Both artifact JSONs and all four actual binary/WAT hashes match the terminal.
Candidate `00.json` hashes to
`87a4a0b1e67d577541fb9ecad09ed7d6e5ce6f1b4c9f935ec5171bcdb3f3955a`;
`01.json` hashes to
`038edc6ba555f200544b532386b82e56aa8474e30125070f19e5275b04a71edb`.

Readback `700381` actually terminated 0 and compared full saved bytes, not
V8 URI identifiers: each candidate Wasm and WAT is byte-identical to its
matching baseline lane. Default retains Wasm `54d051d8` / WAT `635a5a4e`;
no-inline retains Wasm `fa1fc830` / WAT `2e57d954`. This establishes that this
unchanged diagnostic failure predates the approved repair in both measured
modes, with no new loss in these two lanes. It does not identify the first
failing source comparison or waive the required 255 result. Full saved
bodies, numeric calls, type maps and phase errors remain in the artifacts.
Mapped physical export 50/type 44 is `equalityComplements`; the four helper
indices/types remain 87/79, 316/144, 317/144 and 324/68. Helper readback
`e099df` terminated 0; earlier source-only readback `fbc7a0` had a syntax
error and did not execute any compiler or runtime. The initial verbose
readback `63bb29` verified bytes but printed truncated metadata; it is not
claimed as a full human metadata review. The final bounded audit was parsed
and checked with `2deb68`, exit 0.

All 7,673 before/after/current candidate input hashes remain
`7cf74a1348c1ff36725ce7239150f1d3a97c0db175ff06ae104790b4e9ef49e8`;
both instrument hashes remain unchanged and combined 7,675 inputs remain
`8cc48eca556185987d2f790881fe22ca73d9e72827b7cebcbe268c7e189d8c0d`.
Scoped survivor read `682b08` was empty: child 16101 and exact launcher/
collector matches were absent. The heavy lease was explicitly yielded after
actual terminal and byte/survivor verification. No source/fixture expectation,
shared helper, IR, provider, variant, hook, commit, push or publication changed.
The original ten green revised-fixture rows, prior eight matched gains and
zero losses remain separate evidence; physical removal/restoration proofs
remain UNPROVEN and PR readiness is not asserted.
