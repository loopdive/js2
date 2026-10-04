---
id: 6835
title: "Standalone find controls: borrowed length, undefined values, and view entry validation"
status: in-progress
sprint: current
created: 2026-10-02
updated: 2026-10-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
model: gpt-6.1-sol
task_type: conformance
area: codegen
language_feature: typed-array
goal: standalone-mode
parent: 6651
assignee: "ttraenkler/es2015_borrowed_find_miss_sol"
related: [6833, 6832, 6771]
---

# #6835 — standalone find control residuals

## Scope and evidence

These are existing failures exposed by the correct-expectation controls for
#6833 "ES2015 standalone: direct TypedArray find/findIndex use internal length".
They remain unchanged after that issue's two-name internal-length extension.
This issue records open work, not a completed fix, and does not replace the
parent 11,778-original ES2015 standalone goal.

Evidence was read from the implementation worktree
`/Users/thomas/Code/js2/.codex-worktrees/6833-typedarray-find-internal-length`.
All paths below are relative to that retained worktree. The inspected base is
`56680e7feb87a090ee8846c8ecb7718933cd3781`; candidate uses that same base plus
the #6833 source patch, SHA-256
`d80196564f9a4f11e05fc2d9b1a448254f307d8b3df1e16569ee5a44d38df5ac`.

- Canonical receipts: `.tmp/6833/baseline-receipt.json` and
  `candidate-receipt.json`, runs `20261002-221457` and `20261002-222335`.
  Maintained standalone Test262, QuickJS, oracle 14/honest, providers auto:
  **41 pass / 2 fail → 43 pass / 0 fail**, each with 43 registered/recorded/
  settled identities, one completion receipt, and no exclusions. Population
  is 40 frozen owned originals plus 3 separately attributed instrument controls.
  The two getter originals are #6833 gains, not gains of this follow-up.
- Original/candidate compiler SHA-256:
  `f4e72b29ff30cafcd43455cf8d50f532c385b8ba79fa3be4722a0c3138f109a6` /
  `7d6dc9f0d85588ea25d0ce11e2e0f98d5ea515e4592cf771b95029dd9338698d`.
- Canonical JSONLs are `benchmarks/results/test262-standalone-results-<run>.jsonl`;
  hashes respectively
  `8513a571fe5b5471a3a958004bc8b4b03e3de658049fa6b1ce19122d1b54e429` /
  `dd2f54490ebf7f7fd03b48279a8b15d92283fe0f220c189f2ec6aca24c783978`.
  Matching `.shard-1-of-1.complete.json` paths are recorded in the receipts.
- The unchanged 32-test correct-expectation fixture measured **23 pass / 9 fail
  → 27 pass / 5 fail**. Sources are preserved in
  `.tmp/6833/correct-expectations-original.test.ts`, SHA-256
  `b05241161a452f74daf9f8e7dea3715d6b1d34c5bdfcc5d9abc43f9064c270fb`.
  Logs: `.tmp/6833/fixtures-baseline.log` (SHA-256
  `4f926c8934dc40e7e4c77990c08eac04daedd311cc1727e039da7b92fafe4a76`)
  and `fixtures-candidate-full.log` (SHA-256
  `0708a39ecfaa3b52f60ccd2a6235ccaf57b333d452ae72cc7b603c23db85daf7`).
- Diagnostic sources are `.tmp/6833/control-diagnostics.mjs` (SHA-256
  `483c76447a8ed12dc7db289e59c5af2f9dabcd1031fc0883e38b0e8172b5daa1`)
  and `residuals.mjs` (SHA-256
  `5d34624d39e9b7ab9fb150c127f0917f0da97798f16a82e134e6f0a7ca6b7944`).
  Each compiles standalone and checks zero Wasm imports; the baseline scripts
  reject a compiler hash different from the original receipt. Their
  `<stem>-{baseline,candidate}.log` files print the matched compiler hashes.
  The two `control-diagnostics-*.json` files are byte-identical, SHA-256
  `a90e7a5331853748fd57ed640bfd869e8a9ad2f7a8ca2d74a216d477d15fadcb`;
  the two `residuals-*.json` files are byte-identical, SHA-256
  `b7c33f22d3391c28dcf397635d2e600bfb4b0aafdc30c637ecac96c516b0be51`.

## Reproduction and correct expectations

The archived fixture's three borrowed-call failures have stable labels:
`borrowed Array find observes a length once`, `borrowed Array find observes
TA.prototype length once`, and `borrowed Array findIndex observes TA.prototype
length once`. Reproduce with a constructor parameter to retain the dynamic path:

```js
function run(TA) {
  const a = new TA([1, 2, 3]);
  let hits = 0, calls = 0;
  Object.defineProperty(a, "length", {
    configurable: true, get: function () { hits++; return 1; }
  });
  const result = Array.prototype.find.call(a, function (value) {
    calls++; return value === 3;
  });
  return hits * 100 + calls * 10 + (result === undefined ? 1 : 0);
}
export function probe() { return run(Float64Array); }
```

Correct result is **111**, observed **110**: the own getter and one callback
occur, but the result comparison fails. Replacing the target `a` with
`TA.prototype` yields **30**, also wrong: zero getter calls and three callbacks.
For `findIndex`, compare result to `-1`; own target returns correct **111**,
prototype target wrong **30**. Do not infer the exact erroneous value merely
from the failed `=== undefined` comparison.

The two remaining fixture failures are `generic Array find visits holes` and
`generic Array findIndex visits holes`. Diagnostic body (run separately with
`[1, undefined, 3]` and `[1, , 3]`):

```js
function run(a) {
  let calls = 0, undef = 0;
  const result = a.find(function (value, index, receiver) {
    calls++; if (value === undefined) undef++;
    return index === 1 && value === undefined && receiver === a;
  });
  return calls * 100 + undef * 10 + (result === undefined ? 1 : 0);
}
export function probe() { return run([1, undefined, 3]); }
```

Correct result is **211**; both plain forms return **301**. For `findIndex`,
compare result to `1`; both plain forms return **300**, expected **211**.
Adding `Object.prototype[7] = 99` before the call makes all four forms return
**211**. This is a diagnostic control, not an acceptable workaround. Both find
methods visit absent indices; they must not acquire a HasProperty skip gate.

Entry-validation diagnostic (run both `find` and `findIndex`):

```js
function run(TA) {
  const a = new TA([1, 2, 3]);
  a.marker = 7;
  const buffer = a.buffer;
  buffer.__detached__ = true;
  let calls = 0;
  try { a.find(function () { calls++; return false; }); return calls; }
  catch (error) { return error instanceof TypeError ? -10 : -20; }
}
export function probe() { return run(Int8Array); }
```

Correct result is **-10**; both methods return **0** on both compilers. The
`__detached__` spelling is the existing test harness's detach marker. The
separate later-edition resizable-buffer probe substitutes this setup:

```js
const buffer = new ArrayBuffer(4, { maxByteLength: 8 });
const a = new TA(buffer, 1, 2);
buffer.resize(1);
```

Both methods again return **0**, expected **-10**. Detachment is an ES2015
semantic obligation; the resizable-buffer entry check is later-edition
coverage and must not enlarge the frozen ES2015 denominator. Normal detached
entry without an expando, callback detachment, and the fixture's in-bounds
resizable offset/element-width controls pass on both compilers.

## Refined evidence at the implementation planning base

The diagnostic source base is
`b8c9a12a32f6e565a65d53117ee25e703a7f8fe2`. This Markdown-only publication is
based on `7cd84317ac9f5ad1b48a138e33113b98c8392b8e`, which includes the landed
#6833 repair in PR #6457. Diagnostics were not rerun at that publication base.
Source was inspected read-only in
`/Users/thomas/Code/js2/.codex-worktrees/6835-refined-plan-astra`.
Sol ran the fresh diagnostics in
`/Users/thomas/Code/js2/.codex-worktrees/6835-find-residual-plan/.tmp/6835/`;
all artifact names in this section refer to that directory. This is a new
diagnostic baseline, not an implementation A/B or a Test262 gain measurement.

- Source SHA-256:
  `ed0132f3eb836f67558f32c57eab87a3543fd81ca0d734f17ae3ca2cdaf338fd`.
  Compiler SHA-256:
  `759ec73419ca5b8eafa970f67d721e92b7e66c114891bf674f1dee66a15a72f2`.
  Runtime SHA-256:
  `0ee7397f13b35448ee3e97263922303ac1ccecff6c5ddf863a4694f1b0be9092`.
- `receipt.json`, SHA-256
  `554a07088ce6dad936425a6a9424f6ec8696ac944a5ca9dfc31a40919229a9d8`,
  indexes the individual JS, Wasm, WAT, runner and log hashes. This planner
  read its rows, relevant WAT and source, and verified the receipt/report
  hashes; it did not rerun the compilers.
- `reproduction.json`, SHA-256
  `e16f7083bfcbe7f23d1ac622f2d1953ff881df66e04a06325a293bfda90ccc3a`:
  **20 probes, 9 correct / 11 incorrect / 0 compile errors**. Configuration:
  normal standalone compiler, allowJs, skipSemanticDiagnostics, Node v24.19.0.
  Each actual module has zero Wasm imports. Canaries return the expected 37
  and 1221 (undefined/null/legitimate-NaN distinction). The five archived
  fixture residuals and detached/OOB diagnostics reproduce at this base.
- `boundaries.json`, SHA-256
  `f6cf025774f8441285e2534cc5e2d66b42e265ebc1ee3550ecea2222471f83b3`:
  **22 normal classifier probes, 14 correct / 8 incorrect / 0 compile
  errors**, zero imports. Masks are undefined=1, null=2, number=4, NaN=8.
  Normal own-borrowed find returns **112** (null), expected **111**;
  first-class borrowed find returns **111**, correct. These are different
  encodings from the archived 110/111 probe, not changing expectations.
- `carriers.json`, SHA-256
  `715c0badfe0f5e4a8e0b6ed21ee01490d2b337122f7992059e3b59a84c2706bb`:
  **10 non-scoring boundary inspections, 8 correct / 2 incorrect**.
  Export-section-only changes preserve all type/code/data sections, whose
  hashes are included. Undefined/hole reads are recognized before conversion,
  not afterward on the plain inferred-f64 path; dirty-prototype counterparts
  remain recognized. All three legitimate-NaN controls remain non-undefined.
  A direct exact-undefined-marker control is recognized.
- Five `inspection.json` cases use `JS2WASM_IR_INLINE=0` solely to reveal function
  boundaries. They are explicitly non-scoring. Normal WAT and normal runtime
  receipts establish the failures; do not use altered compiler settings,
  export-only instruments or classifier counts as conformance gains.
  Earlier instrument failures and arithmetic-expectation corrections remain
  archived under the receipt; the final reports above are the usable runs.

### Corrected source attribution

1. **Own borrowed find miss is a distinct, confirmed initializer defect.**
   The former attribution to `array-object-proto.ts`/`__hof_find` did not
   describe the ordinary source spelling. Its actual route is
   `expressions/calls.ts` → `compileArrayPrototypeCall` →
   `compileArrayLikePrototypeCall` → `emitArrayLikeHofArm("find")`.
   `src/codegen/array-like-hof-arms.ts:191` initializes the externref
   `__ali_fd_res` with `ref.null.extern` and returns that local on a miss.
   In normal `repro-02.wat`, the initializer near line 1257 and the result
   local's undefined comparison near line 1353 retain this externref: there
   is no intervening numeric result conversion. `boundary-00` identifies
   null, rather than merely failing an undefined comparison.
   First-class `boundary-01` is the positive control for the separate
   prototype-closure/`__hof_find` route and returns canonical undefined.
   Do not edit that working helper or a comparison to fix this initializer.

2. **Plain Array callback corruption first occurs before the HOF.**
   `repro-04.js` hash
   `36999b56370344e8f6662b1e98452917b022b12db92e1f27b04c1704b1642cf6`
   and `repro-05.js` hash
   `4fd1049ee7bc7015cb1a6418d9a7203fc556d04820bb06705b2fa6b92b14f99f`
   retain the original unannotated shapes. In `repro-04.wat`, `run`
   receives a vec<f64> near line 1127; `probe` constructs a vec<externref>
   with canonical undefined near line 1362, reads it near line 1432, coerces
   through ToPrimitive/number unboxing, stores f64 near line 1499 and calls
   `run` near line 1512. The hole case starts with the Hole carrier.
   The first semantic loss is `emitSafeStructConversion` →
   `emitVecToVecBody` → its generic `coerceType` fallback in
   `src/codegen/type-coercion.ts:2207`. The predicate receives numeric NaN:
   mask 12; the dirty-prototype control preserves the original externref
   carrier and passes mask 1. This rules out a generic HOF/callback-boxing
   change as the first repair site for these probes.

   Existing `vecF64ElemFromExternInstrs` is called by
   `buildVecFromExternref`, not by this vec-to-vec projection. Its private
   `storesUndefElems` WeakSet has one writer (that helper) and one reader
   (`fillVecElemGetIdxArms`); the two compiler-finalization paths install the
   reader before ordinary vec arms and behind overlays. This is a possible
   preservation mechanism, not proof that simply reusing it fixes the whole
   contract: it represents a present undefined, not an absent property.
   Boundary cases 16/17/19 also expose static typeof/self-comparison
   inconsistencies (masks 5/13). Those remain recorded unresolved; a correct
   `=== undefined` alone does not establish complete value fidelity.

3. **Inherited length still bypasses ordinary lookup.**
   `ta-dyn-mop.ts:1097` uses `taDynViewOwnLengthArm` from
   `array/array-like-exotic-arms.ts:230`, then returns internal in-bounds
   length. It never consults the concrete prototype on an own-length miss.
   Its named `"length"` property arm also returns internal length ahead of
   inherited lookup, so calling `__extern_get(view, "length")` alone does not
   repair it. `protoGetWithReceiver`/`constructorLookup` demonstrate
   receiver-preserving machinery; default intrinsic accessor fallback and
   recursion still require validation. This is source-attributed, not an
   implemented or measured repair.

4. **Entry validation still depends on absence of every expando.**
   `taDynDetachedGuardInstrs` in `ta-dyn-method-call.ts:223` skips a view
   with any expando so that it does not preempt an overridden method. Its
   helper-availability gate also requires an already reserved TypeError
   constructor. It detects a detached backing store, not a previously
   out-of-bounds live view. `pushTaDynViewInBoundsLen` deliberately returns
   zero for OOB and cannot distinguish it from a valid empty view. Removing
   the expando condition globally is not a valid repair of the override
   contract. The resolved intrinsic branch remains the candidate seam.

## Specification checked before proposing changes

Fetched the primary algorithms on 2026-10-02. The tc39 ES2015 single-page URL
was unavailable; the official Ecma 6th-edition mirror supplied the historical
algorithms. Current tc39 multipage text supplied later-edition bounds rules.

- [ES2015 Array find, §22.1.3.8](https://262.ecma-international.org/6.0/#sec-array.prototype.find)
  and [findIndex, §22.1.3.9](https://262.ecma-international.org/6.0/#sec-array.prototype.findindex):
  step 3 reads length and applies ToLength; step 8 reads every visited index
  and invokes the predicate with value, index and receiver. There is no
  HasProperty skip. Step 9 returns undefined or -1 respectively.
- [ES2015 TypedArray find, §22.2.3.10](https://262.ecma-international.org/6.0/#sec-%typedarray%.prototype.find)
  and [findIndex, §22.2.3.11](https://262.ecma-international.org/6.0/#sec-%typedarray%.prototype.findindex):
  intrinsic methods use internal array length and validate the receiver
  before the Array algorithm. [ValidateTypedArray, §22.2.3.5.1](https://262.ecma-international.org/6.0/#sec-validatetypedarray)
  rejects detached backing storage.
- [ToNumber, current §7.1.4](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-tonumber):
  undefined converts to NaN when numeric conversion is required. A compiler's
  internal Array carrier projection must not introduce that observable
  conversion while passing the same JavaScript Array as an argument.
- [Current ValidateTypedArray](https://tc39.es/ecma262/multipage/indexed-collections.html#sec-validatetypedarray)
  delegates to [ValidateTypedArrayBounds](https://tc39.es/ecma262/multipage/indexed-collections.html#sec-validatetypedarraybounds),
  which throws on an out-of-bounds witness. This later-edition coverage stays
  separate from the frozen ES2015 goal.

## Bounded implementation plan and exact ownership holds

The 2026-10-02 ownership checkpoint below is historical. The dated Slice A
handoff at the end records the subsequent direct human confirmation for the
find initializer file only. Another machine
owns the IR migration. This Markdown alone grants no source ownership or edits
to `src/ir/`, shared registry/configuration, or published PR branches.
Astra files the plan; GPT-6.1 Sol executes only a specifically cleared slice,
in its own assigned worktree, with the coordinator's build/test lease.

The initial diagnostic/planning task was completed. Root released the completed 6835
diagnostic claim and verified the release through the authoritative upstream
registry. The dated handoff records the temporary Slice A assignment and release,
then the fresh implementation assignment after direct human confirmation.
The assignee denotes the bounded Slice A implementation actor. All acceptance
remains open.

The earlier pending human question covered `ta-dyn-mop.ts`,
`ta-dyn-method-call.ts`, `array/vec-elem-fidelity.ts`, and
`boxVecElementToExternref` in `object-runtime.ts`. No answer is recorded.
The human has now directly confirmed clearance for `array-like-hof-arms.ts`;
the exact initializer/import scope is recorded below. That confirmation does not clear
`type-coercion.ts`, the array-like exotic
arm, any inference seam, or a dispatch leaf.

### A. Borrowed find miss initializer — first recommended slice

**Minimum production clearance:** only
`src/codegen/array-like-hof-arms.ts`, the semantic no-match initializer in
`emitArrayLikeHofArm`'s `find` arm and its necessary helper import.
Regression fixture ownership must be assigned separately; the read-only
diagnostic archives stay unchanged. Recommend GPT-6.1 Sol **high** effort.

After clearance, replace the null miss with the existing semantic undefined
producer. Evaluate `canonicalUndefinedExternInstrs`:
`undefinedExternInstrs` is flag-gated and can leave the same null fallback
when the singleton flag is off. Read the current helper implementation before
wiring it; use its existing lane contract without editing the helper.
Host fallback uses an already registered `__get_undefined`; do not register a
late import after capturing function indices or change host behavior
incidentally. If the host control cannot be satisfied within this file and
scope, stop that expansion and request exact additional ownership.

Reader/consumer boundary is small: `emitArrayLikeHofArm` has one production
caller, `compileArrayLikePrototypeCall` in `array-prototype-borrow.ts:803`.
Its find result is initialized here, overwritten only on a successful
predicate, then returned as externref. Entry comes through
`compileArrayPrototypeCall` for dynamic/non-Array receivers, including
supported `Array.prototype.find.call` and empty-literal borrowing spellings.
Therefore controls cover ordinary objects/classes as well as TypedArrays.
Other method arms, the vec path, first-class prototype closure, HOF helper,
length lookup and shared comparison remain outside this change.

Acceptance for this slice:

- Original own-getter probe changes 110 → **111**, and normal classifier
  `boundary-00` changes 112 → **111**, with the getter once and one callback.
  First-class borrowed find stays 111; borrowed findIndex stays correct.
- Empty length and nonempty no-match produce undefined; a successful match
  preserves actual null, undefined, number/NaN and object identity.
  Check callback argument identity/order, early return and thrown predicate.
- Test standalone with singleton flag on and off, plus matched host controls;
  inspect normal emitted initializer and assert zero standalone imports.
  Do not weaken another guard to make these probes reach the arm.
- Preserve direct TypedArray internal-length behavior and all other residual
  observations until separately fixed. Matched original Test262 acceptance
  below is required even if this slice only fixes a regression control.

### B. Generic inherited TypedArray length — independent slice

**Required clearance:** `src/codegen/ta-dyn-mop.ts` length/named-property
lookup and `src/codegen/array/array-like-exotic-arms.ts` dynamic-view length
arm. The latter is newly explicit and is not covered by the pending four-area
question. Recommend GPT-6.1 Sol **xhigh** effort.

Resolve own and concrete-prototype length with the actual view as getter
receiver, then apply ToLength once. Preserve the intrinsic accessor's default
internal-length result and direct TypedArray methods' existing internal-length
path. Determine the nonrecursive default-accessor fallback before editing;
do not route a length helper recursively into itself.

The exported own-length arm has one caller, but the returned value feeds the
shared `__extern_length` contract. Before changing it enumerate every actual
registration/call in `rg -n '__extern_length' src`, distinguishing comments
from calls. Consumers include borrowed loops, generic HOFs, Array.from,
concat/slice/flat/copyWithin, iterator/spread/destructuring, apply argument
materialization, property reads, proxy own-key validation, JSON/array-like
materialization and TypedArray construction/copy helpers. A narrow find-only
test cannot license this shared change. The named-property arm also feeds
ordinary get/reflect operations.

Acceptance: both original prototype-getter encodings become **111**, own
getters remain once, getter `this` is the view, inherited data and accessor
lengths work, throwing getters propagate before predicates, and deletion
restores the default accessor. Include zero/fractional/negative lengths,
a prototype changed between calls, normal and detached borrowed receivers,
and direct intrinsic length isolation. A passing no-match find control
depends on slice A; use findIndex or a successful predicate to measure this
slice independently.

### C. Plain Array value/presence preservation — held broader slice

**New minimum implicated production area:** the standalone
externref-element → f64-element branch of
`src/codegen/type-coercion.ts::emitVecToVecBody`, including preparation
before any function-index capture, plus the exact
`array/vec-elem-fidelity.ts` registration/reader API if required by the
selected preservation design. Prior approval of a dynamic reader alone would
not clear the newly proven producer. Recommend GPT-6.1 Sol **xhigh** effort
for this bounded repair, after the following design/ownership gate.

First choose and document one representation-preserving design from the
actual argument/callee types. If retaining the original externref vec is
necessary for value, property-presence or identity fidelity, identify the
exact inference guard before requesting clearance. The existing withdrawal
logic in `declarations/param-return-inference.ts::inferParamTypeFromCallSites`
explains why dirty-overlay code can keep the original carrier; that file is
an investigation candidate, **not a proven required edit or an approved one**.
No blanket inference widening or call ABI change is in this plan.

A projection-based repair must distinguish actual undefined, Hole and
ordinary values before generic ToNumber. Preserve Hole as absence, including
inherited indexed lookup; do not materialize it as a present undefined.
Use exact provenance/payload rules and register the reader before finalization.
Do not map all NaNs to undefined or change `__unbox_number`,
`__box_number`, global coercion, or callback classification to conceal loss.
If the f64 carrier cannot preserve the measured contract, return to the
specific carrier/inference proposal rather than expanding the repair silently.

Readers and mutators to account for:

- `emitVecToVecBody` has three call sites inside
  `emitSafeStructConversion`: differing element kinds, differing referenced
  element types, and vec-shaped inputs such as RegExp match vectors.
  Keep those unrelated conversions unchanged; all generated consumers of a
  changed resulting vec can observe the elements, presence and identity.
- `prepareVecF64UndefElem` and `vecF64ElemFromExternInstrs` currently serve
  `buildVecFromExternref` alone; the private WeakSet is per CodegenContext,
  with that one writer and `fillVecElemGetIdxArms` as sole reader.
  `index.ts` installs that reader in both finalize paths. Adding a producer
  changes which f64 vec reads in the module receive the extra arm.
- `boxVecElementToExternref` has production callers in
  `object-runtime.ts::fillExternGetIdxVecArms` and
  `iterator-native.ts`'s vec entry iteration. It is downstream of the proven
  first loss and is not a justified repair site on the current evidence.
- If an inference edit is selected, its readers include
  `inferImplicitAnyParamType`, the omitted-parameter query in the same file,
  `index.ts` parameter setup and `fnctor-ctor-param-types.ts`. Re-enumerate
  these before introducing a new fact or withdrawing a narrowing.

Acceptance: original plain undefined and sparse find/findIndex encodings all
become **211**; dirty controls remain 211; normal classifiers distinguish
undefined from null and numeric NaN; legitimate NaN remains numeric.
Include `typeof`, self-equality, return value, getter/predicate order, `in`
and own-property presence, inherited-index values, callbacks that delete or
write indices, caller/callee array identity and mutations through aliases.
Preserve existing Array.from stored-undefined controls, numeric dense arrays,
typed numeric buffers, RegExp unmatched captures and overlay precedence.
The masks 5/13 are explicit open obligations, not passing value-fidelity
evidence. This slice is not ready for implementation until the design and
exact-file clearance are recorded.

### D. Intrinsic detached entry; separate later-edition bounds proposal

**Required clearance:** `src/codegen/ta-dyn-method-call.ts` and the exact
resolved-intrinsic dispatch/call leaf demonstrated necessary by fresh
lowering. Likely readers are `closed-method-dispatch.ts` and
`expressions/call-receiver-method.ts`; neither is implicitly cleared.
Recommend GPT-6.1 Sol **xhigh** effort.

Validate at entry to the resolved intrinsic so unrelated expandos do not
suppress validation, while own/inherited method overrides remain callable.
Do not remove the current expando gate indiscriminately. Verify TypeError
dependency reservation at the correct earlier stage; helper absence cannot
be silently interpreted as permission to skip mandatory validation.

All direct guard consumers at this base are the fixed and vararg dispatchers
in `closed-method-dispatch.ts`, plus `taDynDetachedGuardPrologue` callers
in `expressions/call-receiver-method.ts`, `array-methods.ts`,
`to-locale-string-element.ts` and `ta-to-string.ts`.
A shared guard change requires those adjacent method controls.

Acceptance: both expando-detached original encodings become **-10**, normal
detached controls remain -10, own and inherited overrides still execute,
and missing/non-callable predicates, getter effects, valid empty views,
offset/element-width cases and callback detachment retain correct order.
Keep resizable-buffer OOB entry as a separately approved later-edition
proposal. It needs an exact validity/bounds predicate, not a zero-length
test, and any required `dataview-native.ts`/view-layout edit needs new
clearance. Fixed-length and tracking views at/beyond the buffer end, shrink
and regrow, detached entry and empty in-bounds views form its acceptance.

## Matched-original acceptance and publication boundary

Retain the archived 32-test fixture with its original expectations and all
fresh diagnostic sources. Promote repaired controls to ordinary regression
fixtures; keep uncorrected rows visible as deferred acceptance. The published
#6833 plan already crosslinks this issue and explicitly defers borrowed,
plain-Array, expando-detached and later-edition OOB requirements. This
refinement supersedes the earlier normal-borrowed-call attribution; root
integrates it without modifying an active published branch behind its owner.

For each cleared implementation slice:

1. Pin baseline and candidate commits/source hashes/compiler bundles, lane,
   runner and configuration. Rerun the unchanged relevant probes on both in
   the normal configuration, with positive canaries and zero actual standalone
   Wasm imports. Identify the single changed mechanism in emitted WAT.
2. Run the maintained standalone Test262 runner on the unchanged scoped
   original identities, intersected with the frozen ES2015 population. Start
   from the retained #6833 forty-original manifest plus its three separately
   attributed controls; inspect identities before adding any existing frozen
   originals relevant to the selected borrowed-find or Array reader scope.
   No new original identity, exclusion, oracle change or guard weakening.
3. Require equal registered/recorded/settled identity counts, a completion
   receipt, exact per-row baseline/candidate status and raw compiler/JSONL
   hashes. Keep controls separate from original gains. Preserve every
   originally passing scoped original and identify any adjacent regressions.
   Run repository-required gates and matched broader checks proportional to
   the actual reader list; a shared conversion/length change requires broader
   evidence than the tiny initializer.
4. Report only measured scoped gains. Landed PR #6457 measured two scoped
   original gains in its own receipts. This documentation publication reports
   no additional gains and does not establish a new full-corpus total.
   At the earlier documentation checkpoint, the last whole census was
   **11,443 pass / 311 fail / 24 compile errors = 11,778 frozen originals**.
   No projected gain or classifier result changes that census.

- [ ] Root records each exact-file ownership clearance and Sol assignment.
- [ ] Slice A returns canonical undefined with flag-on/off and host controls.
- [ ] Borrowed prototype-length controls pass with receiver/order fidelity.
- [ ] Plain Array values, holes, property presence and identity remain intact.
- [ ] Expando-detached intrinsic entry throws without breaking overrides.
- [ ] Later-edition OOB entry is resolved and reported separately.
- [ ] All repaired original controls are retained with correct expectations.
- [ ] Matched scoped-original receipts and proportional regression gates pass.
- [ ] #6833 crosslink remains explicit; frozen goal denominator is unchanged.

## 2026-10-03 — Slice A ownership confirmed; awaiting root implementation GO

### Authority, base, and assignment

An earlier request to verify ownership was initially relayed as clearance,
corrected before implementation, and the temporary claim released. The human
has **now directly confirmed** that `src/codegen/array-like-hof-arms.ts` is clear
of the other-machine IR migration. This new confirmation, not the absence of
local edits or mentions in older handoffs, is the source of authority.
The cleared scope is only `emitArrayLikeHofArm`'s `find` no-match initializer
and its necessary helper import. It does not clear any helper implementation,
caller, length lookup, inference, carrier conversion, IR, runtime, registry,
runner, provider, or oracle change. Slices B/C/D and the later-edition bounds
proposal retain their existing ownership holds and unfinished acceptance.
If a line-budget allowance is required by repository gates, it must remain
limited to this exact file and initializer/import delta; no broader source
scope follows from an allowance.

Planning base: `912f672f318a49ee54eb968fcbdc5a1f0f38a28d`, verified locally.
Root rechecked upstream main directly before this resumption and reported the
same commit; this planner did not fetch or advance any source branch.
Planner worktree:
`/Users/thomas/Code/js2/.codex-worktrees/6835-borrowed-find-miss-plan-astra`,
branch `codex/6835-borrowed-find-miss-plan-astra`, created once from that base
with `--no-track`. No source, fixture, dependency, compiler, or runtime edit
was made during planning. Prior diagnostic and census worktrees remain immutable.

The maintained authoritative whole-issue check first found no active claim.
A successful `--list --json` read at registry tip
`030e6555985c6f4702113bb9615cfce79a2fae46` also found no held whole or slice
record for 6835 (1,022 held records were visible, so this was not a silent-empty
instrument). Then the maintained claim operation assigned 6835 to
`ttraenkler/es2015_borrowed_find_miss_sol`, verified on
`upstream/issue-assignments`, terminal session 36936 exit 0. Main was untouched
and no CI was triggered. No force override was used.

The temporary bare issue lock was solely for **Slice A**, not permission to
implement or close the whole issue. The claim tool retained historical branch
metadata `codex/6835-find-residual-plan`; that did not authorize entering that
frozen worktree. Root subsequently identified the separate implementation
branch as `codex/6835-borrowed-find-miss`. When implementation stood
down for external clearance, the maintained tool released the temporary claim,
verified on upstream in session 16472, terminal exit 0. Main remained untouched
and no CI was triggered. The raw released record was verified at registry tip
`460674a509ae4741ea31e113774973aa8d44bda0`, holder matching Sol,
`released_at: 2026-10-03T12:35:18Z`, `write_id: 40393-5gwbltwc`.
After the new direct confirmation, fresh whole/slice checks again found no live
6835 claim at that same authoritative tip (1,022 other active claims visible).
Astra remains the plan author; the frontmatter now names the new bounded
implementation actor, not the historical planner or a whole-issue completion.

The new maintained claim completed in session 40871, exit 0. A fresh raw-record
read in session 30470, exit 0, verified `6835.json` at authoritative fetched tip
`3cf6ede6c584ee9e8b651297d9887d423928b74c`:

- `status: in-progress`
- `assignee: ttraenkler/es2015_borrowed_find_miss_sol`
- `branch: codex/6835-borrowed-find-miss`
- `claimed_at: 2026-10-03T18:02:48Z`
- `write_id: 55913-s5el5wz5`

Holder and branch exactly matched the requested actor and implementation branch;
the live registry listed exactly one held 6835 record and no competing slice
claim. The bare lock remains semantically restricted to **Slice A**. No force,
main update, or CI trigger occurred. Root supplies the separate implementation
worktree and explicit GO; this planner does not edit its source or tests.

Root has separately assigned the new fixture
`tests/issue-6835-borrowed-find-miss.test.ts` to the same Sol actor in its own
implementation worktree. Its absence was reverified in the planning checkout;
recheck in the implementation checkout before writing. Do not
edit `tests/issue-6833-typedarray-find-internal-length.test.ts` or the archived
32-test correct-expectation fixture. This planner owns only this Markdown and
its ignored notes. Root integrates this plan into the implementation worktree;
the completed source, fixture, and plan belong in one completed-fix PR, not a
separate preliminary documentation PR. No commit or push is part of planning.

### Re-grounded first loss and helper contract

Static comparison from diagnostic base
`b8c9a12a32f6e565a65d53117ee25e703a7f8fe2` to the new planning base is empty
for `array-like-hof-arms.ts`, `array-prototype-borrow.ts`, and `any-helpers.ts`.
Their SHA-256 hashes at the planning base are respectively:

- `19c0abb353da141ea0cf3dd70a6b7bd56ee05ac0b12dc0a2fe830eb0e98c0e1c`
- `4429fc0ccac04013ed5c56f44cc057d6cd328879aed042ccb28338a65b613e10`
- `dd43edcb6121a0949fca3a8023de370fad52ef301b1e1444ed7836cd20211ee5`

Thus the prior normal-WAT/runtime attribution remains source-applicable:
the `find` arm at line 191 initializes `__ali_fd_res` to `ref.null.extern`,
overwrites it only with the visited `elemTmp` after a truthy predicate, and
returns it as externref. The current-base runtime itself was not rerun by
the planner: Sol must reproduce the unchanged control before editing.

Proposed entire production delta: import `canonicalUndefinedExternInstrs`
from `./any-helpers.js`, then initialize the find result with
`fctx.body.push(...canonicalUndefinedExternInstrs(ctx))`. Keep the successful
match store, all callback instructions, loop order, result type, and every
other method arm unchanged. Do not use flag-gated `undefinedExternInstrs`.

`canonicalUndefinedExternInstrs` at `any-helpers.ts:151` is independent of
the singleton regime flag. Standalone/native-strings emits the existing
undefined global plus `extern.convert_any`; `ensureAnyValueType` reserves
the immutable tag-1 global if needed, without adding a function import.
No helper edit or change to null/undefined consumers is authorized. Relevant
observers are the returned externref's undefined/null/type/equality checks,
the caller's result flow, and storage/return of that result. The success arm
must still return the original element unchanged, including actual null.

The sole production caller remains `array-prototype-borrow.ts:803`. Before
that call it captures helper indices and builds detached `loadElem`,
`callClosure`, truthiness, and this-binding instruction templates. Neither
those templates nor any shared context map is moved or given a new meaning.
The new producer is local to this result slot; there is no reason to change
`__hof_find`, first-class prototype closure dispatch, comparisons, or coercion.

**Host boundary/stop condition:** the helper only reads `funcMap` for
`__get_undefined` in the host lane, otherwise falling back to null. The caller
does not unconditionally register this dependency. `ensureCanonicalUndefinedExtern`
in `undefined-extern-import.ts` can register and flush earlier, but calling it
after these detached templates are captured is not licensed by this plan.
Do not insert a late registration here, edit the caller/helper, or force an
unrelated undefined expression into a test to make an import appear. A host
probe that requires another production site triggers an exact additional
clearance request; do not silently enlarge or declare full acceptance.

The primary algorithms were fetched again on 2026-10-03:
[ES2015 §22.1.3.8](https://262.ecma-international.org/6.0/#sec-array.prototype.find)
step 9 returns undefined on exhaustion; step 8 returns the visited value on
success, propagates abrupt completions, and does not skip absent properties.
[Current Array.prototype.find](https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array.prototype.find)
retains the same miss value through FindViaPredicate. The unavailable tc39
ES2015 single-page URL was not treated as a fetched source; the official Ecma
mirror supplied the historical text.

### Direct GPT-6.1 Sol High task and acceptance

After root transfers this finalized plan and issues explicit implementation GO, use
**GPT-6.1 Sol, high reasoning effort**. This is a bounded initializer repair,
not a general HOF or value-representation redesign. You are not alone in the
repository: use only your root-assigned implementation worktree, preserve peer
edits, and stop on overlapping source changes. Re-read this handoff and the
actual helper, reproduce first, then make only the proposed two-site source
delta. Any new production file requires root's exact-file clearance.

Wait for root's build/test lease before compiler/runtime work. Preserve the
frozen census, instrument, corpus blobs, oracle 14/honest, QuickJS engine,
providers-auto configuration, and executable provider canaries. Do not repair
dependencies/configuration or reuse a stale compiler merely to start sooner.

Required focused fixture and instrumentation:

1. Retain the exact unannotated dynamic-constructor own-getter spelling above:
   getter once, one callback, normal scalar result 110 → 111; retain classifier
   control 112 → 111 and its undefined/null/number/NaN distinction. Record the
   current-base answer first. First-class borrowed find and borrowed findIndex
   remain positive controls, not alternative reproduction spellings.
2. Cover empty and nonempty no-match borrowing on TypedArrays and ordinary
   array-like objects/classes; successful null, undefined, numeric NaN, finite
   value and object identity; callback value/index/receiver/thisArg, observable
   argument and getter order, mutation effects, early stop, and predicate throws.
   Keep each result's null/undefined identity explicit, not merely falsy.
3. Run standalone with `undefinedSingleton: true` and `false`, explicitly
   recording the option. Current default is on (`create-context.ts:453`, env
   `JS2WASM_UNDEF_SINGLETON`); some historical helper comments say default-off
   and are stale. These compatibility controls do not replace the authoritative
   normal-configuration original run. Verify both declared imports and actual
   `WebAssembly.Module.imports` are empty for each standalone fixture.
4. Inspect normal emitted IR/WAT to confirm this result initializer reads the
   canonical undefined global in both standalone configurations and that the
   successful-match store still loads `elemTmp`. Inspect actual host imports
   and initializer too; host imports are permitted and must be recorded, not
   forced to zero. Include a host exported no-match return whose compiled source
   does **not** mention `undefined`; inspect the returned value outside compiled
   code so the test cannot accidentally seed `__get_undefined`. Pair it with an
   explicit-undefined host control. Use the maintained Test262 host assembly and
   positive `Object.keys({a:1,b:2}).length === 2` instrument control where host
   semantics are measured; bare `compile()+buildImports` is not sufficient
   evidence for that lane. A structural unit can also exercise the existing
   host funcMap-present/missing helper contract, but is not runtime acceptance.
5. Keep the existing #6833 fixture unchanged as the direct TypedArray
   internal-length blast guard, including own/prototype poison getters,
   callbacks, offsets/widths and detached controls. Run the existing #5120
   find/findIndex argument-order/Symbol-length tests proportionately. Report
   unrelated historical failures honestly; do not weaken expectations, rename
   the reproduction into a passing path, or repair B/C/D while here.

Matched unchanged-original gate, counted from the frozen manifest at this base:
`scripts/test262-es2015-11778-manifest.txt`, SHA-256
`632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360`.
Select its exact intersection with `test/built-ins/{Array,TypedArray}/prototype/`
`{find,findIndex}/`: **48 originals = 4 Array find + 4 Array findIndex +
20 TypedArray find + 20 TypedArray findIndex**. This includes the existing
forty-original #6833 blast population, not a whole-directory edition expansion.
The Array additions are `not-a-constructor`,
`return-abrupt-from-this-length-as-symbol`, success-value/index, and
false-predicate undefined/minus-one originals for each method.

Add the existing three separately attributed instrument controls:
`test/built-ins/Math/sign/length.js`,
`test/intl402/DisplayNames/ctor-custom-get-prototype-poison-throws.js`, and
`test/intl402/Segmenter/ctor-custom-get-prototype-poison-throws.js`.
Require **51 identical registered/recorded/started/settled identities per side**,
completion receipts, no skips/exclusions, and matched source/blob/compiler/
runtime/provider/runner/oracle fingerprints. Use base 912f672f and the candidate
source fingerprint (then commit when available), not an old whole-census result
as the A/B baseline. Attribute only measured original row flips; fixture fixes
and instrument controls are not original gains. No gain estimate is made here.

Planning is complete for root handoff. The source clearance and separate fixture
assignment are now recorded, but **root must transfer the plan and issue explicit
implementation GO**. No independent GO follows from this document. Production
acceptance, the host
dependency gate, runtime measurements and publication remain open. A host-only
pre-existing gap must be reported distinctly from any candidate regression and
must not be silently checked off. Successful Slice A work does not close 6835
or change the frozen 11,778-original goal.

## 2026-10-03 — Slice A early runtime gate; host dependency stop

Root accepted the finalized Astra plan and issued explicit implementation GO,
with the exclusive build/test lease, in
`/Users/thomas/Code/js2/.codex-worktrees/6835-borrowed-find-miss-sol`, branch
`codex/6835-borrowed-find-miss`, source base
`912f672f318a49ee54eb968fcbdc5a1f0f38a28d`. The retained candidate is uncommitted:
only the approved helper import and find initializer were changed in production.
The source-file SHA-256 changed from
`19c0abb353da141ea0cf3dd70a6b7bd56ee05ac0b12dc0a2fe830eb0e98c0e1c` to
`82ad42f9a4650f473f860a51f019dcc00b089c980539e6fd765049495455410f`;
the exact `git diff -- src/codegen/array-like-hof-arms.ts` patch SHA-256 is
`4b74225b5209ed43d9650af88536f2bcfb9a4721772187aa6f59a1012993c96f`.
Caller and helper hashes remain the planning hashes above. No other production
file, original test body, runner, oracle, provider or configuration was edited.

Existing primary `node_modules` and corpus contents were symlinked using the
maintained layout, keeping `test262` a directory and excluding its `.git` entry.
No install or shared hook/configuration setup ran. Read-only preflight verified
corpus HEAD `b363f29d3c43c626dc852744ad64a0b48a003693`; all proposed 48 originals
and three controls are distinct frozen-manifest members, and all 51 current
bodies match their canonical Git blobs with zero mismatches. Selection/body
integrity is not execution evidence.

Early baseline session **7197** and leaf-candidate session **64145** both
terminated with exit 0 under Node **v24.19.0**, `node --import tsx`, normal
compiler settings, JS input, `allowJs` and `skipSemanticDiagnostics`.
An initial tsx CLI invocation terminated before loading the compiler because
its IPC socket creation was denied; the existing Node loader avoided that
instrument problem without an install. Logs and generated artifacts are
retained under this worktree's `.tmp/6835/`.

The exact dynamic-constructor own-getter standalone source reproduced **110**
on base and returned the correct **111** with the leaf patch. Both modules
have zero declared and actual Wasm imports. Their binary SHA-256 hashes are
`f643bfb081695a0c135439ba50ef9d0f5f2e135e3fcec6cc434ae37303e7a850` and
`81e19ed1ca5c47b210c7223efdf59713ef1168e5df1fa94ac7ac6b5246c486c9`.
This is one repaired diagnostic probe, **not an original Test262 gain**.

The host probes remain incorrect and byte-identical across the two sides:

- An exported borrowed-find miss whose compiled source never mentions
  `undefined` returns actual **null**, observed outside compiled code as
  `typeof === "object"`. Its final module has 21 imports, including the
  `env::__get_undefined` function; binary SHA-256 on both sides is
  `bdccefabaf6ae5561ce2c5199f810194e1e4413e94fcf9f097bd3c77aad2ca59`.
  Final dependency presence therefore does not prove it was available when
  the leaf's canonical helper performed its lookup.
- The paired explicit-undefined result comparison returns **0**, not 1.
  Its final module has 21 imports but no `__get_undefined`; binary SHA-256
  on both sides is
  `006ca2e655ef1aa874b9d8e40f7f80134d810b12d2b7c03743f118d03cf9e182`.
- The positive `Object.keys({a:1,b:2}).length === 2` control passes through
  the maintained literal Test262 harness assembly on both sides, with
  identical `wasm_sha: eb5654dc914e`. Direct compile/host instantiation above
  is bounded initializer/dependency attribution, not whole host-lane
  acceptance or authoritative CI classification.

Baseline receipt `.tmp/6835/early-host-receipt.json` SHA-256:
`d10b5a05e45d2c1fde9dc00325f31d906d83a2fb4bdc0ddebff0ef00cf1f4306`.
Candidate receipt `.tmp/6835/early-host-candidate-receipt.json` SHA-256:
`32ef6a794fce5076ef7334d7339d51a669b9bb0aa80a09d587171a074dc31b2c`.
Baseline `.tmp/6835/early-host-probe-loader.log` SHA-256:
`c64b066f45d21c4a0d28ec140f5df2e47ac7eab758efd164951a5600b81deebc`;
candidate `.tmp/6835/early-host-candidate.log` SHA-256:
`8a25a07b2686004bb3e8158ff1972b1caeb2e25bdf00be5d3337be3f53cbdfac`.

**The planned host stop condition is reached.** Implementation stopped before
creating the dedicated fixture, running the singleton-on/off semantic matrix,
the unchanged 51-row authoritative A/B, wider regressions, gates or hooks.
No original rows were measured here and no original gain is claimed. No commit
or implementation-branch push occurred. Retain the narrow patch and receipts;
do not publish this unfinished repair as a completed fix or close 6835.

The exact additional requested ownership is
`src/codegen/array-prototype-borrow.ts::compileArrayLikePrototypeCall`, solely
its **early undefined-dependency preparation before helper indices and detached
instruction templates are captured**, using existing helper contracts.
This is a request, not clearance. No caller or helper edits were made. Helper
implementations, other source files and slices B/C/D remain held. Root takes
the clearance question to the human; all acceptance beyond the early probe
remains open, and every heavy session is terminal.
The byte-identical wrong host binaries alone do not distinguish a non-admitted
host route from dependency availability at leaf emission. Route/timing proof
is still required before implementing the proposed preparation change; this
handoff does not prove that site sufficient to repair either host probe.

Root explicitly requested release of Sol's own claim on stand-down. The
maintained release operation, session **43871**, terminated exit 0 and verified
its effect on `upstream/issue-assignments`; main was untouched and no CI
triggered. A separate remote-tip read and raw cache-object read confirmed tip
`943431246ffc6feb3bdc33a4245a96a52e72b62a`, whose `6835.json` records
`status: released`, the exact Sol holder/branch above,
`write_id: 56923-dyxc8l5r` and `released_at: 2026-10-03T18:10:18Z`.
The earlier local remote-tracking ref was stale and was not used as release
proof. Release log `.tmp/6835/release-claim.log` SHA-256:
`d02a841bac9f5231a93f5402a6cb4788a99b1202ca165f8b21a29e355b75275c`.
This releases ownership while the issue remains unfinished; it is not a
completion transition. A new explicit claim/clearance/GO is needed to resume.

## 2026-10-03 — standalone Slice A may proceed; host repair remains deferred

Root has clarified the acceptance boundary against the human's frozen
**11,778-original ES2015 standalone** objective. The early host stop above
correctly prevented an unauthorized caller/helper repair. It does not require
that a demonstrably unchanged, pre-existing host defect be repaired before
validating the cleared standalone initializer fix. This clarification supersedes
only the requirement to pause standalone validation for that host defect; it
does not grant another production file or declare any acceptance complete.

Astra read Sol's complete added evidence at handoff Markdown SHA-256
`bc8b8021332f5c46fb1ee9362a02a99f0815958b94b15d5b8b78dc24d1754dbf`,
and verified the baseline/candidate receipt hashes recorded above against the
actual JSON files. On base `912f672f318a49ee54eb968fcbdc5a1f0f38a28d` versus
the recorded two-site leaf patch, the standalone diagnostic changes 110 → 111
with zero declared/actual imports. Both recorded host diagnostic binaries,
source hashes and returned values are identical across the two sides; the
maintained host instrument control passes on both. This supports **no regression
in those measured host controls**, not host correctness, universal host parity,
or any original Test262 gain. Host route/dependency timing remains unproved.

Continue only the cleared `array-like-hof-arms.ts` initializer/import delta,
the assigned new fixture, and this issue's evidence, under root's renewed
claim/GO and measurement lease. Do not repair `array-prototype-borrow.ts`,
the canonical helper, host dispatch, or import registration. In particular,
do not register a late import after detached instruction templates capture
indices. The proposed earlier host preparation site remains an unapproved
investigation candidate, not an established sufficient fix.

The standalone acceptance bar is unchanged: singleton flag on/off semantic
controls, emitted initializer and zero-import checks, successful null/undefined/
NaN/object-identity fidelity, callback effects/order/throws/early stop, and the
unchanged #6833 internal-length and #5120 argument-order blast guards. Require
the matched **48 frozen originals + 3 separately attributed instrument controls
= 51 identities per side**, all registration/settlement/completion receipts,
no exclusions, unchanged original blobs/oracle/providers, and per-row A/B
comparison. No host row is being removed from that already-standalone population.
No gain may be inferred from the one repaired diagnostic.

Host semantic repair stays tracked **within 6835**, with its correct undefined
expectation and failing receipts retained, not rewritten as a passing-null test
or split into an unrelated GitHub issue. A changed host binary or value in the
final candidate requires renewed attribution; existing byte parity does not
license a later regression. The earlier combined acceptance checkbox requiring
both standalone and host correctness must remain unchecked; report standalone
completion separately if its full evidence later passes.

- [ ] Standalone Slice A semantic, emitted-code, matched-original and regression
      acceptance completes with measured receipts.
- [ ] Deferred host borrowed-find miss returns genuine undefined on both
      recorded spellings after separately cleared route/dependency repair.

A completed standalone-only fix may be reported as such after its gates pass,
while this host requirement, slices B/C/D, and whole-issue 6835 remain open.
This appendix records a scope decision and read-only evidence review; Astra ran
no compiler/tests/builds, changed no production source, and made no claim or
publication operation in preparing it.

### Sol resumed claim and matched flag boundary

Root renewed standalone-only GO and the exclusive lease. Fresh maintained
whole/slice checks, session 92490 exit 0, read authoritative tip
`943431246ffc6feb3bdc33a4245a96a52e72b62a`: no live 6835 claim or slice,
with 1,022 other active records visible. Reclaim session 64696 exited 0;
separate remote-tip/raw-object verification confirms
`a772c1c3782ecc05d7c50868432a908aac71ca74`, `status: in-progress`, exact
Sol actor/implementation branch, `write_id: 57778-tf9kxcn3`. No force.

The unconditional canonical proposal has an actual alternate-regime regression:
with explicit `undefinedSingleton: false`, the exact own-getter probe returns
**111 on base → 110 on the first candidate**. Default-on remains 110 → 111.
Base flag session 31974 and candidate flag sessions 37357/7623 are terminal.
The first-class borrowed-find positive control returns 31 in both flags on
both measured sides. Base `typeof undefined`, `undefined === null`, unpassed
argument and successful-null controls return their correct expected 1/0/1/1
in both flags. All actual standalone imports are empty. Preserve the failed
candidate expectation; no helper/consumer repair or flag waiver is authorized.

Normal candidate WAT `.tmp/6835/flag-false.wat` shows the result initializer
`global.get 47; extern.convert_any; local.set 25`; normal matched base WAT
`.tmp/6835/flag-false-baseline.wat` shows `ref.null extern; local.set 25`.
Both successful stores remain `local.get 23; local.set 25`. This is the actual
instruction sequence, not the local declaration. Candidate/base WAT SHA-256:
`3f92eef59e9014bd9235b8194cc07f6c38cb5789c60a43f2ac8a3991ec738325` /
`29f17858026eb72e3512ae03c841b53ff3acbc91c617c339f2e489009958190c`.
These labels remain immutable; they do not describe a later regime-aware fix.
Root rejected the unconditional proposal and commissioned Astra's bounded
regime-aware leaf refinement. No revised production candidate is authorized
until that plan is reviewed and root gives GO.

- Active task: exact **51-row default-on baseline**, source restored to the
  pristine `912f672f` leaf hash `19c0abb3...`, session **2745**, wrapper PID
  **58391**, run ID **20261003-202134**. Durable log:
  `.tmp/6835/originals-baseline.log`. One maintained dynamic shard, index 0 /
  total 1, with exact manifest SHA-256
  `17f2882578f7f9ccc3edf29dcc13e1e76c85500fafeaca9f1e4e2bd5e9f58827`.
  Registered 51; final verdict/completeness audit pending. Source is frozen
  while live; only this owned Markdown may receive progress evidence.
- Fresh owned compiler/runtime bundles were built by the maintained wrapper.
  Baseline source fingerprint over 7,596 tracked source/test/script/config/hook
  files is `d3a938784629ec195ff8a1ea6978f150801bc4aeff05d85d47fced17d900b9b6`,
  recorded in `.tmp/6835/baseline-fingerprint.json`. Compiler/runtime SHA-256:
  `06c6e1a6bac71c2d6ed1ae3e96599bfe02de3e78ca8316c988ab6eabc95e17b1` /
  `73305c6d22c1b2b7b47ff21efebef7394114b408eef94426269889588c519268`.
  Pinned QuickJS library SHA-256
  `073742801ba76347371be277f6d275488badce1df6bfb480741548ec2a279d45`;
  fresh adapter **55e216980fde39bc** was built and executable-canary verified.
  Lane standalone, oracle 14/honest, providers auto, QuickJS, pool 1, Node
  v24.19.0, 4 GiB fork heap; scoped history publishing disabled.

## 2026-10-03 — measured flag-off regression revises the Slice A producer

The unconditional `canonicalUndefinedExternInstrs` proposal is withdrawn for
this leaf. Sol's matched exact own-getter probe measures default/flag-on
110 → 111, but flag-off 111 → 110: the latter is a new regression, not an
acceptable pre-existing limitation. No consumer or oracle change is justified.

Astra read the actual logs and all four initializer/success-store WAT excerpts.
`flag-controls-baseline.log` SHA-256 is
`113c989af21933130bbfe83441807df6a7b4c4ca7c21fa8129f642614004b931`;
`flag-control-probe.log` SHA-256 is
`fbb7f41fc20ad63e7a88368d542a7541d85fdb2f26f4e00d36c4cb36d23ed50a`.
Paths are relative to Sol's `.tmp/6835/`. Both baseline initializers use
`ref.null extern; local.set 25`. The failed candidate uses `global.get 13`
(flag on) or `global.get 47` (flag off), then `extern.convert_any; local.set 25`.
All four retain `local.get 23; local.set 25` for the successful match.
All recorded modules have zero imports. First-class control is 31 in both
flags on both sides. The four baseline positive controls return expected
typeof-undefined=1, undefined-equals-null=0, omitted-argument=1 and
successful-null=1 in each flag mode; repeat them on the revised candidate.
These controls do not prove every legacy dynamic consumer uses the singleton.

### Revised leaf-only patch, pending root approval

Use existing **`undefinedExternInstrs`**, not an ad hoc flag condition and not
the unconditional canonical helper. In `array-like-hof-arms.ts` replace the
candidate's helper import and initializer as follows; no other production edit:

```diff
-import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
+import { undefinedExternInstrs } from "./any-helpers.js";
@@ case "find":
-      fctx.body.push(...canonicalUndefinedExternInstrs(ctx));
+      fctx.body.push(...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" } satisfies Instr]));
```

The current helper at `any-helpers.ts:122` already implements the exact predicate
`ctx.undefinedSingleton === true && (ctx.standalone || ctx.nativeStrings)` via
`undefinedSingletonActive`. Active mode produces the reserved singleton global
and extern conversion; inactive mode returns no instruction sequence, preserving
this leaf's legacy null initialization through the fallback. Reservation adds
only the existing type/global, not a late function import. `hof-native.ts:180`
already follows this regime-aware producer contract for find misses. That
parallel implementation is corroboration, not a substitute for the fresh A/B.

The consumer at `object-runtime.ts:5214` asks `buildIsUndefinedExternBody` for
the same active regime. Its inactive fallback recognizes null (and the existing
numeric sentinel), not an arbitrary tag-1 singleton. The equality dispatch at
`binary-ops-typed-dispatch.ts:711` also consults the same regime. This explains
why changing only this inactive producer broke the measured dynamic result
despite the passing baseline controls. Do not alter these shared readers,
the helper, successful-match store, callback, return type or caller templates.

Pure JS-host contexts (`standalone=false`, `nativeStrings=false`) keep the
pre-patch null initializer regardless of flag or `__get_undefined` availability;
the known host defect remains deferred, not fixed. A host-target context with
`nativeStrings=true` is different: it participates in the existing native
singleton regime and must not be excluded by a hand-written standalone-only
guard. The existing helper preserves that contract. Cover the predicate's
standalone/nativeStrings/flag combinations structurally; do not invent or
change target profiles, dependencies or host imports to manufacture a pass.

### Acceptance remains strict and unchanged in population

Root must approve this revised two-site proposal before Sol changes the candidate.
Require the exact own-getter probe to return 111 in **both** flags, with normal
emitted initializer evidence: singleton in active mode, original null sequence
in inactive mode, unchanged success store. Repeat all positive controls,
null/undefined/NaN/object-identity and callback effects/order/throws/early-stop
tests, the #6833 internal-length and #5120 order blast guards, and actual
zero-import checks. Compare flag-off generated output to its baseline to detect
unintended nonlocal changes. Keep the measured host controls non-regressing and
their semantic defect open; preserve the separate host-scope rationale.

The authoritative normal-default gate remains **48 frozen ES2015 originals +
3 separately attributed instrument controls = 51 identical identities per side**,
with original blobs, oracle, provider configuration, counts and completion
receipts unchanged. Neither a flag-specific run nor a diagnostic result changes
the frozen 11,778 denominator or constitutes an original gain. No acceptance is
checked here. Whole issue 6835 and slices B/C/D remain open. This appendix alone
supersedes the earlier instruction to avoid the flag-gated helper and to demand
a singleton initializer with the flag off; it grants no new file ownership.

Astra performed read-only source/evidence inspection and wrote only this ignored
planning appendix: no source edits, compiler/test/build runs, claims or publication.

## 2026-10-03 — approved regime-aware Slice A validation (checkpoint)

Root approved the existing `undefinedExternInstrs` producer plus legacy null
fallback, restricted to the import and find-result initializer in
`array-like-hof-arms.ts`. The current leaf SHA-256 is
`7f1561ead085b5b2c309958f2b14de21e1407d886713b77f42a61a50ab6f154c`.
The unconditional canonical proposal above is historical, rejected evidence.

The final dedicated fixture SHA-256 is
`711d7aabb1255a59c2cb94ebc6d83950e266a4915c5962bad932156d43425883`.
It now includes ordinary dynamic-length objects with absent index 1, visit
order/count/value/receiver identity, successful undefined at that absent index,
and borrowed findIndex. These are not explicit-undefined or vector substitutes.
Normal WAT is restricted to the exact `$run` function's next top-level function
boundary, with start/end ordering and its one-externref-parameter signature
asserted before converting the named local suffix to the local index.
Eight helper-context tests prove only the existing predicate; they do not
claim nativeStrings runtime coverage.

Matched final fixture candidate session **6536** terminated exit 0:
**54/54 pass**. Final base kill-switch session **55312** terminated exit 1:
**48 pass / 6 fail out of 54**, all six failures in singleton-on miss/WAT
checks, with singleton-off and successful absent-index controls passing.
The base leaf was restored to SHA-256
`19c0abb353da141ea0cf3dd70a6b7bd56ee05ac0b12dc0a2fe830eb0e98c0e1c`;
the identical final fixture was used without expectation changes.
Logs in `.tmp/6835/`: `fixtures-final-candidate.log` SHA-256
`60a8328d2986c52b686c00063258d0fa048c90da76c6586cd43ba9d75cf30624`;
`fixtures-final-baseline.log` SHA-256
`5d07c797ae24569127cd8684af79c4d39fefdbf7cec7258344fcc16c741d76c5`.

The maintained exact-51 baseline run **20261003-202134**, session **2745**,
terminated exit 0 with all 48 originals and three separately labeled controls
passing. Independent completeness audit session **44686** also terminated 0:
one v2 receipt, 51 exact unique identities, no exclusions, honest oracle 14 and
automatic providers. Its canonical JSONL SHA-256 is
`ed2467b2dd0d9fbc6dd165e4a75e4342dfbb5f7e2035bd20440750df2c14f3f6`;
v2 receipt SHA-256
`1b41caf11acf85b3f3249f47f09d5bb74d33944f7a91605946dd2b8b3039aa5a`.
The revised candidate exact-51 run **20261003-203802** is active in session
**17593**, log `.tmp/6835/originals-candidate.log`. HEAD remains
`912f672f318a49ee54eb968fcbdc5a1f0f38a28d`; corpus, manifest, oracle and
configuration are unchanged. No original gain is claimed from an all-pass
baseline or from this active candidate. Host acceptance remains unchecked and
deferred; whole issue 6835 and slices B/C/D remain open.

## 2026-10-03 — standalone Slice A terminal implementation handoff

Only the existing-helper import and borrowed find miss initializer change in
production. The final patch SHA-256 is
`9b5e20fe2f7a9cc7f8f068cf0bc1f6de6a944e2b0be41625847d8e18e9dcc224`;
leaf SHA-256 remains
`7f1561ead085b5b2c309958f2b14de21e1407d886713b77f42a61a50ab6f154c`.
No caller/helper/consumer, successful store, loop, oracle, provider, corpus,
configuration or baseline edits are included. The active renewed whole-issue
claim is `ttraenkler/es2015_borrowed_find_miss_sol`, branch
`codex/6835-borrowed-find-miss`, raw tip
`a772c1c3782ecc05d7c50868432a908aac71ca74`, write
`57778-tf9kxcn3`. Publication awaits root review and commit GO.

### Final exact fixture and removal proof

Lint required three two-space regex literals to use equivalent ` {2}`
quantifiers. No compiled JavaScript input or expected value changed. The superseding fixture
SHA-256 is `603ffd7c01cb5d401de724ba91a05013e4f7b8a255dbc710d0a9ebf15eda0044`.
The final identical fixture passed **54/54** on the approved candidate in
session **99607** (exit 0), and measured **48 pass / 6 fail** with the base
initializer in session **46833** (exit 1). Candidate source was restored only
after that baseline session terminated. The six failures are **five runtime
miss controls plus one WAT-test runtime assertion**, not six original gains.
All singleton-off controls, successful missing-index find/findIndex cases,
null/explicit-undefined/NaN/identity cases and eight structural predicate checks
pass on both sides. No nativeStrings runtime coverage is claimed.

Final fixture logs, relative to this worktree's `.tmp/6835/`:

- `fixtures-lint-final-candidate.log`:
  `2e5e217bdf8c22f37c22004220a114ab26ada2ff7efbfed7cc843f654d20d782`.
- `fixtures-lint-final-baseline.log`:
  `bd48fc11139d0dab8d06383530cbbdd3c8970ac1140f042d90ea1645a34bb482`.

The exact own-getter returns **111 in both flags**; first-class control remains
31 and the four observer positives remain 1/0/1/1. The normal singleton-on WAT
initializes through `global.get; extern.convert_any; local.set 25`; flag-off
uses `ref.null extern; local.set 25`. The success store remains
`local.get 23; local.set 25`. Final flag-off WAT is byte-identical to base,
SHA-256 `29f17858026eb72e3512ae03c841b53ff3acbc91c617c339f2e489009958190c`.
Flag-probe session **68395** terminated exit 0; `flag-controls-revised.log`
SHA-256 `a46a6d46427e85bcf390402c088707c4898888e80b03ba84405ac4fa3aa323d4`.
All 46 compiled standalone fixture cases assert empty declared and actual
WebAssembly imports; the remaining eight are structural helper tests.

### Matched unchanged-original gate and provenance

Candidate session **17593** terminated exit 0, run **20261003-203802**.
The maintained runner and independent completeness validator prove **51/51
PASS**, exactly **48 target originals + 3 separately labeled controls**, matching
baseline run **20261003-202134**. Every row uses oracle 14/honest/providers auto.
One v2 receipt records 51 registered/canonical/physical/unique verdicts, all
callbacks settled, zero exclusions/missing/unexpected/duplicate identities.
The exact A/B join has **zero status or error transitions and zero original
gains**. All selected identities are within the frozen 11,778 population.
This bounded gate is not a new whole-census total or proof of full conformance.

Candidate canonical artifacts in `benchmarks/results/`:

- `test262-standalone-results-20261003-203802.jsonl` SHA-256
  `3d95c4b9d3ca50c12c25dfea8915e41127c89e83b6ca668d54f9cb5517fbc22c`.
- `test262-standalone-results-20261003-203802.shard-1-of-1.complete.json`
  SHA-256 `b25a348a33e9a174eb1f38758e8234e9af753794bee183c7e944639135941359`.
- Durable `.tmp/6835/originals-candidate.log` SHA-256
  `a1255bf6b5213f3a52ca2fbcf7e81ba75121639a92235f69bd48c76f9c8c1d17`.

The terminal independent audit is `.tmp/6835/final-audit.json`, SHA-256
`b77d8315576bd0b2a8ff4b00342f6c660215d1678fdad48f1c4dfc4ec7a1569e`.
Its final rehash verifies only the approved leaf changed among **7,596 tracked
production/test/script/config/hook files**; the new fixture is separately
hashed above. All 51 original body hashes and all three pinned provider files
are unchanged. HEAD stays `912f672f318a49ee54eb968fcbdc5a1f0f38a28d`,
canonical corpus stays `b363f29d3c43c626dc852744ad64a0b48a003693`, and exact
manifest SHA-256 stays
`17f2882578f7f9ccc3edf29dcc13e1e76c85500fafeaca9f1e4e2bd5e9f58827`.
Candidate source fingerprint is
`451cc9e2e92042f87874a8c3b2eb0189e67b839f6529fa7fe4a4b75d1586617c`;
`.tmp/6835/candidate-fingerprint.json` SHA-256 is
`b63af6d8454807213450cd5289133f5e521a537b216abea125a5083857be3b54`.

Each side built fresh compiler/runtime bundles in this owned worktree. Candidate
compiler/runtime SHA-256 differ from the recorded baseline bundles:
`a2391a4e1332eab171d355132c25a5425277ebd172d61be3a217b07b29d66276` /
`b7b07da5b1c3882f978af401fe6d54639250389cca1258936371e50b49df2bcb`.
Both sides use the same verified library artifact SHA-256
`073742801ba76347371be277f6d275488badce1df6bfb480741548ec2a279d45`.
The candidate adapter was a fresh cache miss, key `0af1b0cf8dfe4635`, built
and executable-canary-verified in 2,083 ms. Its physical bytes are identical
to the baseline adapter despite the changed source/bundle cache key: SHA-256
`fa105724f9d2379e2ffe420e3bf3df925f3108a422039a94a67db2a407ee4c54`.
No borrowed primary bundle, install or shared configuration repair occurred.

### Deferred host and proportional source checks

Revised host probe session **27362** terminated exit 0. Its two host binaries
remain byte-identical to baseline: no-explicit-undefined
`bdccefabaf6ae5561ce2c5199f810194e1e4413e94fcf9f097bd3c77aad2ca59`
returns raw null (incorrect); explicit-undefined
`006ca2e655ef1aa874b9d8e40f7f80134d810b12d2b7c03743f118d03cf9e182`
returns 0 instead of 1 (incorrect). Expected undefined is not weakened. The
maintained host Object.keys control remains PASS with wasm_sha `eb5654dc914e`.
This establishes measured non-regression, **not a host repair or sufficient
caller-import attribution**. Host acceptance remains unchecked and held.
`.tmp/6835/early-host-revised-receipt.json` SHA-256 is
`cd9bf4ac9284ae4c021e00912587c1d1e4acd8e19cd2b607c6cb51a5462f674a`.

Unchanged neighboring tests passed **74/74** in terminal session **95099**:
30 direct TypedArray internal-length checks (#6833) and 44 Symbol-length and
argument-order checks (#5120). `blast-guards.log` SHA-256 is
`861b0a68929b866b9aef8d999ea03a8ec4e1be096b72063ca026cf7880b3d882`.
Final terminal gate session **99607** passed typecheck, lint, changed-test/source
Prettier, LOC budget (net +1), function budget and oracle ratchet (net +0).
Session **25801** terminated exit 0 with coercion-sites net +0 and the required
dead-exports **preservation-v1** contract passing (6/6 full and cut witnesses,
core nodes 12/12, core types 10/10). The same tool explicitly leaves the graph
OPEN and strict modeled closure FAIL for existing nonliteral dynamic imports
at `optimize.ts:394` and `platform-capability-adapter.ts:151`; it does **not**
certify retirement/deletion. No unrelated source repair or baseline allowance
was made. Normal unskipped commit/push hooks remain required after root GO.

- [x] Standalone-only Slice A: regime-aware miss values, both flags, successful
  values, missing-index visitation, effects/order/throws and zero-import checks.
- [x] Exact 51-row matched gate (48 target originals + 3 controls) and 74 unchanged neighboring checks pass.
- [x] Proportional source, type, lint, format and preservation gates recorded.
- [ ] Pure-host miss returns actual undefined (unchanged defect, deferred).
- [ ] Borrowed prototype length / plain Array carrier / detached-entry slices.
- [ ] Whole issue 6835 complete; frozen 11,778-original full goal achieved.
