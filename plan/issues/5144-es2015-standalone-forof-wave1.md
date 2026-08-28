---
id: 5144
title: "ES2015 standalone: forof conformance wave 1"
status: in-review
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/statements/for-of-destructuring.ts
  - src/codegen/statements/destructuring.ts
  - src/codegen/statements/loops.ts
  - src/codegen/iterator-native.ts
  - src/codegen/array-methods.ts
  - src/codegen/function-instance-meta.ts
  - src/codegen/class-static-metadata.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/statements/tdz.ts
  - src/codegen/map-runtime.ts
  - src/codegen/expressions/assignment.ts
oracle-ratchet-allow:
  # The @@iterator read-drive must pick a Wasm ValType for a for-of head
  # `let`/`const` binding that has no slot yet — a lowering question that is
  # deliberately above what `ctx.oracle` can answer (it needs the raw
  # `ts.Type` for `resolveBindingElementType`/`resolveWasmType`).
  - src/codegen/statements/destructuring.ts
coercion-sites-allow:
  # §7.4.9 step 9 "Type(innerResult) is not Object": `typeof null` is
  # "object", and truthiness is what separates `null` from a real object.
  # This is a spec type TEST, not a value conversion, so it has no home in
  # the coercion engine.
  - src/codegen/iterator-native.ts
func-budget-allow:
  - src/codegen/statements/for-of-destructuring.ts::compileForOfAssignDestructuring
  - src/codegen/statements/for-of-destructuring.ts::compileForOfDestructuring
  - src/codegen/statements/for-of-destructuring.ts::compileForOfIteratorAssignDestructuring
  - src/codegen/iterator-native.ts::fillNativeIteratorLateArms
  - src/codegen/statements/loops.ts::compileForOfNativeMapEntries
  - src/codegen/expressions/assignment.ts::emitAssignToTarget
---

# #5144 — ES2015 standalone: forof conformance wave 1

## Problem

All 129 ES2015-bucket "forof" work-package tests still fail on the standalone
target (re-verified per-test on head `86739f05`, 2026-08-28: 116 FAIL + 13
COMPILE_ERROR, 0 already fixed). The bulk is `language/statements/for-of/dstr/`
(108 tests): the destructuring head lowering eagerly materializes iterators
(breaking the §13.15.5.5 per-element next/close ordering), drops `undefined`
to wasm-null or NaN on absent elements, and skips PutValue/TDZ/coercibility
guards on assignment targets. 32 of the 129 are generator-coupled and land via
sibling issue #5141, not here. for-of is the consumer surface of the whole
iteration protocol, so this package gates the 100% ES2015 standalone goal.

The `loc-budget-allow` grant above is deliberate growth allowance for this
change-set (per-element iterator drive, close-result validation, PutValue
guards, name-descriptor install), rationale dated 2026-08-28 (this issue).

Target list: `.tmp/es2015/wp-forof-current-fails.txt` (129 paths, regenerated
2026-08-28 on head). Probe:
`cd /home/user/js2 && npx tsx .tmp/run-standalone.mts --list <file>` (split
lists >150 lines; Bash timeout 600000). Minimal repros used below live in
`.tmp/es2015/probe5144/` (run via `npx tsx .tmp/probe-one.mts <abs-path>`).

## Current failure clusters

Counts sum to 129. Ordered by count descending.

| # | Cluster | Count | Root cause (file:function) | Sample tests (`language/statements/for-of/`…) |
|---|---------|-------|----------------------------|--------------------------------|
| G | generator-coupled — **#5141's scope, not this issue's** | 32 | (G1, 9) top-level yield tests trap `unreachable in __gen_resume_*` — the #5060 result-typed `try_table` regression, root-caused in #5141 cluster B (`src/codegen/generators-native.ts:4419` area); after that fix these need #5141's `yield*` delegation work. (G2, 12) `dstr/*-rtrn-close*` CE "sequential numeric yields (#680)" — native-generator admission (`generators-native.ts` `isNativeGeneratorCandidate`/`buildNativeGeneratorPlan`) rejects `yield` as dstr target/init inside `function*` (#5141 clusters A1–A3). (G3, 11) `dstr/*yield-expr*` FAIL `«null»` vs `«undefined»` — resume/sent value loses `undefined` through the generator carrier (#5141 + cluster U's canonical-undefined). | `yield.js`, `yield-star.js`, `dstr/array-elem-iter-rtrn-close.js`, `dstr/array-elem-init-yield-expr.js` |
| C | iterator-close protocol / per-element drive | 24 | `src/codegen/statements/for-of-destructuring.ts:2055` `compileForOfAssignDestructuringExternref` **eagerly materializes** the pattern source via `__array_from_iter_n(elem, stepCount)` (line ~2066) then indexes the vec. Spec §13.15.5.5 requires: evaluate each element's target reference (lref) BEFORE its `next()` (test `[ {}[thrower()] ]` expects nextCount 0, returnCount 1 — we do next first and never close); IteratorClose on abrupt completion from target/init evaluation; close-result "not an Object ⇒ TypeError" (`iterator-native.ts:1594` says this §7.4.9 refinement is *deferred* — the `close-null` subtests); empty pattern `[]`/`[,]` must GetIterator then immediately close (`emitEmptyForOfArrayPatternRequirement` line 209 gets but never closes; `assignPatternIsNonEmpty` line 883 routes elision-only patterns around the guard). Top-level loop driver gaps (6 tests): next-throw must NOT close (`iterator-next-error` — we call return), next result non-object ⇒ TypeError (§7.4.4 refinement deferred in `__iterator_next`, `iterator-native.ts:516`), `next` method got once at prologue (`iterator-next-reference`), close-method non-callable / close-result non-object ⇒ TypeError on `break`. | `dstr/array-elem-iter-thrw-close.js`, `dstr/array-empty-iter-close.js`, `dstr/array-elem-iter-nrml-close-null.js`, `iterator-next-error.js` |
| S | PutValue / TDZ semantics on assignment targets | 13 | Three defects. (a) `emitForOfAssignmentTargetGuard` (`for-of-destructuring.ts:81`) is wired into the ARRAY assign path but not the OBJECT pattern arms (`compileForOfAssignDestructuring`:915 / `compileForOfIteratorAssignDestructuring`:2381): verified `for ([c] of …)` with `const c` throws TypeError, `for ({c} of …)` does not (probe p1/p2). (b) sloppy unresolvable target must CREATE a global (`{ x: unresolvable }` — we throw ReferenceError); strict must throw a ReferenceError OBJECT (`emitForOfUnresolvableWrite`:104 covers only part of the arms). (c) TDZ ReferenceError is thrown as a NON-OBJECT ("Thrown value was not an object!") — NOT for-of-specific: plain `let`-TDZ access throws non-object too (probe t2); fix in `src/codegen/expressions/identifiers.ts` `emitStaticTdzThrow` / `statements/tdz.ts` `emitTdzCheck` — construct a real ReferenceError instance (model: `nonIterableThrowInstrs`, `iterator-native.ts:1442`, #3388). Plus 1 parse bug: `dstr/array-elem-init-in.js` (`[ x = 'x' in {} ]` in a for-of head) fails with `',' expected.` — no-in restriction misapplied to the for-of head reparse. | `dstr/obj-id-put-const.js`, `dstr/obj-prop-put-unresolvable-no-strict.js`, `dstr/array-elem-init-let.js`, `dstr/array-elem-init-in.js` |
| U | absent element ⇒ wasm-null instead of canonical `undefined` | 12 | Exhausted-iterator / out-of-range element reads surface JS `null` (or feed "Cannot destructure 'null'" for nested patterns with defaults, since the default check `__extern_is_undefined` correctly refuses null). `emitBoundsCheckedArrayGet` (`src/codegen/array-methods.ts:809`) HAS a `useUndefinedSentinel` flag (#1396) — the for-of dstr vec fast path doesn't pass it; the `__extern_get_idx` OOB arm returns `ref.null.extern`; `__array_from_iter_n` unfilled slots likewise. Verified: `for (var [_, x] of [[]])` binds x=null (probe d1); `[[] = dflt()]` from `[]` throws "Cannot destructure" instead of firing the default (probe n1). One canonical-undefined fix (use `canonicalUndefinedExternInstrs`, `any-helpers.ts:167` / `ensureGetUndefined`) lands all 12 + unblocks part of G3 and R. | `dstr/var-ary-ptrn-elem-id-iter-done.js`, `dstr/const-ary-ptrn-elem-id-iter-complete.js`, `dstr/var-ary-ptrn-elem-ary-empty-init.js`, `dstr/let-ary-ptrn-elem-ary-elision-init.js` |
| F | fn-name: `name` not an OWN property with spec attributes | 8 | Anonymous class/fn NamedEvaluation VALUE inference already works (probe f1 passes) — what fails is the `name` own-property install: `verifyProperty(cls,'name',…)` reports "name should be an own property" (probe f3). Classes/functions created in dstr-default position lack an own `name` data property `{writable:false, enumerable:false, configurable:true}`; named `class x {}` must keep `'x'`; a static `name` member suppresses install. Fix where function/class object metadata is stamped: `src/codegen/function-instance-meta.ts` / `class-static-metadata.ts`. Prior art: #1450/#1049/#1119 (done — value inference), this wave is the descriptor/own-ness residue. | `dstr/obj-id-init-fn-name-class.js`, `dstr/obj-id-init-fn-name-fn.js`, `dstr/array-elem-init-fn-name-cover.js` |
| R | rest-slice nested obj/array patterns | 8 | `[...{ 1: x, length }]` — object pattern over the materialized rest `$Vec`: numeric-key reads (`{1: x}`) and `length` reads on the rest slice bind undefined; nested values also hit the U null-vs-undefined class. `emitForOfRestAssignment` (`for-of-destructuring.ts:1765`) / `emitVecRestAssignment` (:1902) hand the slice to the object-pattern arm which misses vec index/length arms (the #4447 numeric-key note at :2402 covers only the `__extern_get` iterator path). | `dstr/array-rest-nested-obj.js`, `dstr/array-rest-nested-obj-null.js`, `dstr/array-rest-nested-array-undefined.js` |
| T | RequireObjectCoercible / GetIterator TypeError on primitive/null/hole element | 7 | Destructuring a non-iterable primitive (`for ([,] of [true])`), null/undefined (`for ({} of [null])`), or a hole-produced undefined into a nested pattern must throw TypeError — all silently succeed (probes e1/e2). Elision-only and empty `{}` patterns skip the guard entirely (`assignPatternIsNonEmpty`:883 + `emitEmptyForOfArrayPatternRequirement`:209 emit no RequireObjectCoercible/GetIterator failure path); `__array_from_iter_n` on a non-iterable must throw the §7.4.1 TypeError (`nonIterableThrowInstrs` exists — wire it). | `dstr/array-elision-val-bool.js`, `dstr/obj-empty-null.js`, `dstr/array-elem-nested-obj-undefined-hole.js` |
| M | computed member-expression targets silently dropped | 6 | `for ([ x[key] ] of [[33]])` writes nothing (probe y1 fails; `x.prop` target passes, probe y2) — the element-access (computed-key) target arm in `compileForOfAssignDestructuring`/`compileForOfIteratorAssignDestructuring` never routes through the #2664 member-set dispatcher. NOT yield-specific — the 6 `*yield-ident-valid*` tests just use `yield` as a sloppy-mode var name. | `dstr/array-elem-target-yield-valid.js`, `dstr/obj-prop-elem-target-yield-ident-valid.js`, `dstr/array-rest-yield-ident-valid.js` |
| P | nested obj-pattern bindings ride f64 lane ⇒ NaN | 6 | `for (const { w: {x,y,z} = {x:4,y:5,z:6} } of [{w:{x:undefined,z:7}}])` — when the pattern reads a key absent from the actual value (`y`), TS types the bindings `number`, the head path allocates f64 locals, and absent/undefined reads coerce to NaN (probe o4: reading `y` flips `x` from undefined to NaN; without `y` it passes). Fix: apply undef-widening (`isUndefWidenedBindingElement`, `src/checker/type-mapper.ts` — already consumed by generators-native.ts) when choosing the binding lane in `compileForOfDestructuring` (`for-of-destructuring.ts:228`) so possibly-absent properties ride externref. | `dstr/const-obj-ptrn-prop-obj.js`, `dstr/var-obj-ptrn-prop-ary.js`, `dstr/let-obj-ptrn-prop-obj.js` |
| A | `Array.prototype[Symbol.iterator]` override/delete ignored by head destructuring | 6 | `for (var [x,y,z] of [[1,2,3]])` destructures the vec by index, never consulting the override global: a user generator replacing `@@iterator` must drive the bindings, and `delete Array.prototype[Symbol.iterator]` must TypeError. Machinery exists — `arrayIteratorOverrideGlobalIdx` (`expressions/proto-override.ts`) and `tryEmitArrayProtoIteratorReadDrive` (`statements/destructuring.ts`) already guard OTHER paths (#1052 fixed plain decls) — wire the same override check into the for-of head binding path. | `dstr/var-ary-ptrn-elem-id-iter-val-array-prototype.js`, `dstr/const-ary-init-iter-get-err-array-prototype.js` |
| Map | for-of over Map with single-ident binding | 5 | `for (var x of map)` + `x[0]` reads: 4 tests emit INVALID WASM (`i32.ge_s expected i32, found struct.get (ref null N)` in `__module_init`) and `map.js` reads wrong values. `compileForOfNativeCollection` (`src/codegen/statements/loops.ts:1060`) routes `[k,v]` bindings to `compileForOfNativeMapEntries` (:1257) but a single-identifier binding over entries falls to the eager `emitCollectionIteratorVec` snapshot whose entry-pair element access mis-types. Also semantic: `map-expand.js` mutates the Map DURING iteration and expects live entries — a snapshot vec can never pass; the walk must be live (the Set values path `compileForOfNativeSetValues` :1108 is the in-repo model). NOTE: this function reads `ctx.checker.getTypeAtLocation` (pre-oracle legacy) — NEW code must go through `ctx.oracle` (#1930/#3273). | `map.js`, `map-expand.js`, `map-contract.js` |
| X | misc error propagation | 2 | Abrupt completion from computed property-name evaluation (`obj-prop-name-evaluation-error.js`) and from an array-element getter during iteration (`array-key-get-error.js`) is swallowed — will largely fall out of cluster C's per-element ordering; re-check after C. | `dstr/obj-prop-name-evaluation-error.js`, `array-key-get-error.js` |

## Implementation Plan

Written 2026-08-28 against head `86739f05`. Steps ordered by yield (count
descending), except step 0/1 which are sequencing constraints. Each step ends
with: re-run `npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-forof-current-fails.txt`
and the spotcheck list; error text shifts as clusters land, so re-cluster —
do not trust this table's error strings after step 2.

**Step 0 — do NOT implement cluster G here.** The 32 generator-coupled tests
(G1/G2/G3 above) are #5141's scope (its Step 1 fixes the #5060 resume-trap
regression that also breaks this package's spotcheck test `break-label.js` —
spotcheck is currently 39/40 because of it). If #5141 has not landed when you
start, proceed with steps 1-9 anyway; none of them touch
`generators-native*.ts`. After #5141 lands, re-run the full list and fold the
survivors of G into the re-cluster.

**Step 1 — Cluster U (12, + unblocks R/G3): canonical undefined for absent elements.**
- `src/codegen/statements/for-of-destructuring.ts`: every element read that can
  go past the iterator/vec end must produce the canonical undefined externref,
  never `ref.null.extern`. Three sites: (a) the vec fast path — pass
  `useUndefinedSentinel=true` (+`ctx`) to `emitBoundsCheckedArrayGet`
  (`array-methods.ts:809`, flag exists since #1396, model caller: the plain
  assignment dstr path in `expressions/assignment.ts`); (b) the
  `__extern_get_idx` OOB arm for the `$Vec` carrier (object-runtime family) —
  return `__get_undefined()` instead of null ref; (c) `__array_from_iter_n`
  (`iterator-native.ts:602`) — slots not filled because the iterator finished
  early must read back as canonical undefined (either store the sentinel on
  drain exhaustion or have the consumer treat missing-index as undefined).
- Nested-pattern defaults then fire correctly through the existing
  `emitDefaultValueCheck` (`statements/destructuring.ts:565`) — do not change
  its null-vs-undefined logic; it is correct (default fires on undefined only).
- Watch open backlog issue #1430: its cluster (obj literal storing `undefined`
  as wasm-null so `{w: undefined}` defaults misfire) is the SAME value-fidelity
  class from the producer side; if your fix normalizes at the store site,
  smoke `for (const {w = 99} of [{w: undefined}])` and close #1430 with it.
- Accept: probes d1/n1 pass; `dstr/*-iter-complete/done*`, `*-elision-init*`,
  `*-empty-init*` (12) pass.

**Step 2 — Cluster C (24): per-element iterator drive + IteratorClose.**
The big one. Replace the eager `__array_from_iter_n` materialization in
`compileForOfAssignDestructuringExternref` (`for-of-destructuring.ts:2055`)
with a per-element drive holding a live iterator record:
- GetIterator once (`__iterator`, `iterator-native.ts` — throws §7.4.1
  TypeError on non-iterable, #3388), capture the `next` method ONCE (fixes
  `iterator-next-reference`), keep a `done` flag local (the IteratorRecord
  `[[done]]`).
- Per AssignmentElement, in spec order (§13.15.5.5): (1) evaluate the target
  reference (lref) if the target is not a nested pattern — inside the
  close-on-abrupt region; (2) if not done, call next — a THROW from next sets
  done=true and propagates WITHOUT close (fixes `iterator-next-error`); next
  result must be an Object else TypeError (fill the deferred §7.4.4 refinement
  in `__iterator_next`'s USER/OBJ arms — `iterator-native.ts:516`); (3) read
  `done`/`value` (ToBoolean on done); (4) default + PutValue/nested-pattern
  destructure — any abrupt completion here, when done=false, runs IteratorClose
  with the throw completion (return()'s own result/errors swallowed).
- After the last element (no rest): if done=false, IteratorClose with normal
  completion — and validate: `return` absent/undefined ⇒ no-op; non-callable ⇒
  TypeError; call result not an Object ⇒ TypeError (fill the deferred §7.4.9
  refinement in `buildIteratorReturnBody`, `iterator-native.ts:1589` — it
  currently discards the result; only the NORMAL-completion close validates).
- Empty/elision-only patterns: `[]` and `[,]` still GetIterator (+ step the
  elision count) then close (fixes `array-empty-iter-close*`,
  `array-elision-iter-nrml-close-null`); route them through the same drive
  instead of `emitEmptyForOfArrayPatternRequirement`'s get-only stub.
- The OUTER for-of loop driver (loops.ts) needs the same three refinements
  (next-result-type TypeError, no close after next-throw, close-result
  validation on `break`) — they come for free if the refinements land inside
  `__iterator_next`/`__iterator_return` rather than at call sites. Prefer that.
- Keep the vec fast path for statically-typed array sources with no override
  (byte-stability for the common case); the live drive is the externref/user
  -iterable lane.
- Prior art to mimic: the plain (non-for-of) assignment destructuring
  per-element path in `expressions/assignment.ts` (#1454/#1592/#3100 S4) and
  the #2169 destructure drain in `generators-native-consumer.ts`. Prior
  issues: #1347, #1016, #1158, #1219 (all done — same protocol, other paths).
- Accept: all `dstr/*close*` non-generator tests + `iterator-next-*`,
  `iterator-close-*` (24) pass; `rest-lref.js`/`rest-lref-err.js` (lref-before-
  iteration ordering) pass.

**Step 3 — Cluster S (13): PutValue/TDZ guards on every target arm.**
- Wire `emitForOfAssignmentTargetGuard` (TDZ-then-const, `for-of-destructuring.ts:81`)
  into the OBJECT-pattern identifier-target arms of
  `compileForOfAssignDestructuring` (:915) and
  `compileForOfIteratorAssignDestructuring` (:2381) — shorthand (`{c}`),
  renamed (`{k: c}`), and with-default arms. Array path already has it.
- Unresolvable targets: extend `emitForOfUnresolvableWrite` (:104) to the same
  object arms — sloppy: create the global binding via the
  `global-environment.ts` write helpers (test expects the loop to COMPLETE);
  strict: throw a ReferenceError OBJECT (`emitStrictUnresolvableGlobalWrite`).
- TDZ/ReferenceError object-ness: `emitStaticTdzThrow`
  (`expressions/identifiers.ts`) and `emitTdzCheck` (`statements/tdz.ts`)
  currently throw a non-object payload. Construct a real ReferenceError
  instance (model: `nonIterableThrowInstrs` `iterator-native.ts:1442` builds a
  real TypeError; the js-errors.ts ctors are registered). This is
  cross-package (plain TDZ has the same bug — probe t2) but the fix is one
  throw-site change; coordinate with the lang-semantics lane if it claims it
  first.
- `array-elem-init-in.js` (1 test): the for-of head reparse applies the no-in
  restriction inside an array-literal initializer. Find where the head
  expression is parsed/reparsed (ambient-parse or the dstr reparse); `in` is
  legal there (the no-in restriction is only the C-style `for(init;;)` head).
  If it is TS's own parser refusing, document as parser-limitation and move
  the test to a follow-up — do not patch tests/test262-runner.ts.

**Step 4 — Cluster F (8): own `name` property install.**
- `src/codegen/function-instance-meta.ts` / `class-static-metadata.ts`: ensure
  NamedEvaluation installs `name` as an OWN data property
  `{writable:false, enumerable:false, configurable:true}` on function/class
  objects (propertyHelper's `verifyProperty` checks own-ness via gOPD +
  delete-restore, so a synthesized/inherited read is not enough).
  Suppress for named classes (`class x {}` keeps `'x'`) and when the class has
  a static `name` member. Prior value-inference work: #1450/#1049/#1119.

**Step 5 — Cluster R (8): object/array patterns over the rest slice.**
- `emitForOfRestAssignment` (:1765) / `emitVecRestAssignment` (:1902): when the
  rest TARGET is an object pattern, numeric keys (`{1: x}`) and `length` must
  read the materialized `$Vec` slice (index read + logical length), mirroring
  the #4447 numeric-key handling at :2402; nested array patterns re-enter the
  step-2 drive. Step 1's canonical-undefined covers the value fidelity.

**Step 6 — Cluster T (7): coercibility/iterability throws.**
- Make elision-only (`[,]`) and empty (`{}`, `[]`) patterns run
  RequireObjectCoercible/GetIterator on the element even though they bind
  nothing (step 2's drive gives array patterns this for free; add the
  object-pattern RequireObjectCoercible via `emitExternrefDestructureGuard`,
  `destructuring-params.ts`). Primitive non-iterables reach
  `__iterator`'s §7.4.1 TypeError (#3388) — ensure typed lanes (bool/f64
  elements) don't bypass the guard via the vec fast path.

**Step 7 — Cluster M (6): computed member-expression targets.**
- Add the element-access target arm (`x[key]`) to both assign-destructuring
  paths, routing through the #2664 member-set dispatcher
  (`member-set-dispatch.ts`) with the key evaluated per spec order (during
  lref evaluation, step 2). The property-access arm (`x.prop`) works — mirror
  its emit (`__forof_itermemtgt_*` temp pattern at :2478).

**Step 8 — Cluster P (6): undef-widened binding lanes.**
- In `compileForOfDestructuring` (:228), when a nested object-pattern binding's
  source property may be absent/undefined (use
  `isUndefWidenedBindingElement`/`resolveBindingElementType` from
  `src/checker/type-mapper.ts` — do NOT call `ctx.checker` directly; go through
  `ctx.oracle` for any new type query, #1930/#3273), allocate the binding as
  externref and let reads keep undefined; only provably-present number props
  keep the f64 lane. Repro: probe o4 (reading the absent `y` must not turn `x`
  into NaN).

**Step 9 — Cluster A (6): honor `@@iterator` override in the head path.**
- Wire the `arrayIteratorOverrideGlobalIdx` check (+ deleted ⇒ TypeError) into
  the for-of head array-destructuring fast path, falling back to the step-2
  live drive when overridden — exactly what #1052 did for plain declaration
  destructuring (`tryEmitArrayProtoIteratorReadDrive`,
  `statements/destructuring.ts` — reuse, don't fork).

**Step 10 — Cluster Map (5): single-ident binding over Map entries.**
- `compileForOfNativeCollection` (`loops.ts:1060`): give the single-identifier
  binding over a Map a LIVE walk binding the `[k,v]` pair per entry (extend
  `compileForOfNativeMapEntries` to materialize the pair as a real 2-vec per
  iteration), instead of falling into the snapshot `emitCollectionIteratorVec`
  lane that (a) emits invalid wasm for heterogeneous entries and (b) can never
  satisfy mutation-during-iteration (`map-expand.js` adds entries mid-loop and
  expects to see them; `compileForOfNativeSetValues` :1108 is the live-cursor
  model — high-water mark, tombstone skip). Run the equivalence tests for
  Map/Set (#2162 landed the collections; don't regress its rows).

**What NOT to do**
- No new host imports without a standalone fallback (the runner FAILS any
  standalone module that emits `env::*` imports — `standaloneHostImportError`).
- Never edit `tests/test262-runner.ts` skip lists, `scripts/*baseline*.json`,
  or the harness. The fix is in codegen/runtime only.
- No `ctx.checker.getTypeAtLocation` in new code — `ctx.oracle` only
  (oracle-ratchet gate; the existing raw call in
  `compileForOfNativeCollection` is grandfathered, don't add more).
- Don't touch `generators-native*.ts` (that's #5141's file set — merge-conflict
  magnet while its wave is in flight).
- Don't "fix" `emitDefaultValueCheck`'s null-vs-undefined semantics — they are
  spec-correct; fix the VALUES reaching it (step 1).
- Run every source-ratchet gate before committing (see CLAUDE.md "Hooks and
  ratchet gates"); growth is covered by this issue's `loc-budget-allow`.

## Acceptance criteria

- All tests in `.tmp/es2015/wp-forof-current-fails.txt` pass via
  `npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-forof-current-fails.txt`
  — with the carve-out that the 32 cluster-G paths (the `yield*`/`*rtrn-close*`
  /`*yield-expr*` families listed above) are gated on #5141; if #5141 has not
  merged, wave-1 is complete when the remaining 97 pass and cluster G's
  failures are unchanged-or-better.
- Every test in `.tmp/es2015/wp-forof-passing-spotcheck.txt` still passes
  (baseline today: 39/40 — `break-label.js` is #5060/#5141-regressed, expect
  40/40 once #5141 step 1 lands; do not regress the other 39).
- Ratchet gates pass (`check-loc-budget`, `check-func-budget`,
  `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`, run
  chained, plus the CI-base simulation per CLAUDE.md).
- Equivalence tests pass (`npm test -- tests/equivalence.test.ts`).

## References

- **#5141** — sibling generators wave 1 (same session): owns cluster G — the
  #5060 resume-trap regression, `yield*` delegation, generator admission gates.
- **#1430** (open, Backlog) — `{w: undefined}` default misfire: same
  undefined-fidelity class as cluster U from the producer side; step 1 likely
  closes it — verify and update its status if so.
- **#5060 / #4768** — the close-on-abrupt generator wrapper whose result-typed
  `try_table` traps on Node 22 (diagnosed in #5141).
- Done prior art, same subsystems: #1347 (for-of close on body throw), #1052
  (@@iterator override in plain destructuring), #1016 (closed-iterator null
  crashes), #1158/#1219 (eager-drain violations), #1396 (OOB undefined
  sentinel), #2904/#3100 (`__array_from_iter_n` native + close-at-bound),
  #4447 (assign-pattern arms: defaults/numeric keys/member targets), #2038
  (native iterator runtime), #3388 (native TypeError on non-iterable), #1450/
  #1049/#1119 (NamedEvaluation value inference), #2162 (native Map/Set), #680/
  #2079/#3164 (native generator lowering phases), #2664 (member-set dispatch).

## Results

Measured on the target list `.tmp/es2015/wp-forof-current-fails.txt` (129 paths)
with `npx tsx .tmp/run-standalone.mts --list …`, standalone target, worktree
`wf_701edb96-376-23` off head `7e2d98bd`.

| | before | after |
|---|---|---|
| pass | 0 | **65** |
| fail | 116 | 51 |
| compile-error | 13 | 13 |

Spotcheck (`wp-forof-passing-spotcheck.txt`) held at 39/40 throughout — the one
failure is `break-label.js`, the known #5060/#5141 generator-resume regression
that predates this change-set.

Equivalence: the full `tests/equivalence` directory OOMs in this container, so
it was run in slices. Every for-of / destructuring / iterator / Map-Set /
function-name slice passes (76 + 85 tests). `tests/equivalence/tdz-reference-error.test.ts`
fails 6 of 9 — verified pre-existing by A/B-ing `identifiers.ts` back to
`HEAD~1` (identical 6 failures); they are compile-time "before initialization"
diagnostics, and this change-set touches no checker pass.

### Clusters fixed

- **U — absent element ⇒ canonical `undefined`.** The OOB/exhausted element read
  now produces JS `undefined` instead of wasm-null for every externref element
  type, not only when a default initializer is present, and the nested
  call-expression default (`for (const [[] = f()] of [[]])`) is applied on the
  sync path.
- **R — object/array patterns over a rest slice.** New
  `emitAssignObjectPatternFromVec` gives `for ([...{ 0: x, length }] of …)` the
  array-like `length` / numeric-key reads the generic struct-by-name arm cannot
  answer.
- **S — PutValue / TDZ on every target arm.** The TDZ-then-const guard and the
  unresolvable-target write (sloppy creates the global, strict throws a
  ReferenceError OBJECT) now run in the object-pattern arms too, absent
  properties included; the legacy aggregate guard that threw a bare
  `ref.null.extern` is gone. TDZ reads throw a real ReferenceError instance on
  the host-free lane, and the top-level TDZ-flag elision no longer loses a
  shorthand assignment target to the property symbol.
- **T — coercibility / iterability throws.** `for ({} of [null])` runs
  RequireObjectCoercible; a numeric/boolean element under an elision-only array
  pattern throws the §13.15.5.2 GetIterator TypeError.
- **P — undef-widened binding lanes.** Nested object/array head bindings whose
  source property may be absent ride externref instead of the f64 lane, so
  `undefined` no longer degrades to NaN.
- **M — computed member-expression targets.** `x[key]` as a destructuring
  target on a non-vec receiver routes through `__extern_set_strict` instead of
  being dropped.
- **A — `Array.prototype[@@iterator]` override in the head path.** The
  read-drive materializes the binding slot for a for-of head (module global or
  a `let`/`const` with no slot yet); it previously skipped every element.
- **F — NamedEvaluation for a shorthand assignment default.**
  `for ({ fn = function () {} } of [{}])` now names the function `fn`.
- **C (partial) — §7.4.9 close-result validation.** An `IteratorClose` whose
  `return()` answers a non-Object throws TypeError, and the empty pattern
  `for ([] of …)` performs GetIterator **and** IteratorClose.
- **Map (partial).** `for (var x of map)` binds a live `[key, value]` pair per
  entry instead of falling into the eager snapshot, which emitted invalid Wasm
  (`i32.ge_s expected i32, found struct.get`) in `__module_init`.

### Skipped / follow-ups

- **Cluster G (32, out of scope by design).** Generator-coupled — #5141 owns the
  #5060 resume trap, `yield*` delegation, and the `yield`-as-dstr-target
  admission gate. Unchanged-or-better here.
- **Cluster C residue (~14).** The per-element iterator drive (lref before
  `next()`, close on abrupt from target/init, next-throw must NOT close, `next`
  read once) still needs the plan's Step 2 rewrite of
  `compileForOfAssignDestructuringExternref`; the eager
  `__array_from_iter_n` materialization stays for now.
- **§7.4.4 next-result-type (1).** Adding the "result is not an Object ⇒
  TypeError" refinement inside `__iterator_next` collides with its existing
  falsy-result degrade (`next` missing/uncallable ⇒ done=1); separating the two
  needs its own measurement.
- **Cluster A delete arm (3).** `delete Array.prototype[Symbol.iterator]` must
  make head destructuring throw. `sourceOverridesArrayIterator` only scans
  assignment / `Object.defineProperty`, and there is no override global to read,
  so this needs deletion modelling.
- **Map residue (3).** `x[0] === first[0]` compares two boxed numbers that reach
  `===` under different carriers and answers false. A value-representation
  issue, not a for-of one.
- **Cluster F residue (3).** A class needs `name` as an OWN data property, and
  `xCover.name` folds statically to the binding text when the variable's
  DECLARATION has no initializer (the value came from an assignment-pattern
  default).
- **`array-elem-init-in.js` (1).** `[ x = 'x' in {} ]` in a for-of head is
  rejected by the parser (`',' expected.`) — a parser-limitation, left alone
  per the plan's instruction not to patch the runner.
