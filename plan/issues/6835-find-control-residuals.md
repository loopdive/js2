---
id: 6835
title: "Standalone find controls: borrowed length, undefined values, and view entry validation"
status: ready
sprint: current
created: 2026-10-02
updated: 2026-10-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
model: gpt-6.1-sol
task_type: investigation
area: codegen
language_feature: typed-array
goal: standalone-mode
parent: 6651
assignee: "ttraenkler/find_refined_plan_astra"
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

No production slice is unconditionally ready. Another machine owns the IR
migration. This Markdown grants no source ownership and authorizes no edits
to `src/ir/`, shared registry/configuration, or published PR branches.
Astra files the plan; GPT-6.1 Sol executes only a specifically cleared slice,
in its own assigned worktree, with the coordinator's build/test lease.

The diagnostic/planning task is complete. Root released the completed 6835
diagnostic claim and verified the release through the authoritative upstream
registry. There is no live 6835 production claim; the frontmatter assignee is
planner provenance only. All repair acceptance below remains open, and root
must establish a new explicit assignment after source ownership is cleared.

The earlier pending human question covered `ta-dyn-mop.ts`,
`ta-dyn-method-call.ts`, `array/vec-elem-fidelity.ts`, and
`boxVecElementToExternref` in `object-runtime.ts`. No answer is recorded.
Root has separately asked about the newly implicated
`array-like-hof-arms.ts` find initializer; that answer is also outstanding.
Neither pending question clears `type-coercion.ts`, the array-like exotic
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
   The last whole census remains
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
