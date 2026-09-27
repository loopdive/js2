# Class retained-entry deletion: blocked candidate, not a landing patch

## State and scope

Worktree: `/private/tmp/js2-5753-class-provenance-20260915`.
Branch: `codex/5753-class-provenance-20260915`.
HEAD remains `83832ab0340975e86f79fc4faab356244afc692a`.
The candidate is uncommitted. No push, parent-tree edit, runtime presence,
define-applier edit, inventory change, or consumer activation occurred.

The only production change is `src/codegen/carrier-bag-delete.ts`.
The additive correctness test is
`tests/issue-5753-class-retained-delete.test.ts`; this handoff is the third file.
Do not cherry-pick/publish the candidate: the authorized stop condition fired.

## Implemented protocol

The existing class predicate from `instance-tombstones.ts`, whose population is
the current context's `classDeclarationMap`, admits the new lookup-only arm.
Existing closure/generator/vector/Error arms keep precedence and their old tail.
The class tail retains the actual `__obj_find` entry, recognizes the canonical
bag-self marker and returns success without touching it. A real entry delegates
to actual `__delete_property(bag,key)`; rejection returns zero unchanged.

On success, immediate stores restore the retained entry as a deletion marker:
value1=bag(anyref), flags2=exported `FLAG_DEFAULT`, getter4/setter5=null none(-18).
Count2 is incremented and tombstones3 decremented, reversing actual deletion.
No call/allocation occurs between delete and these stores. Key0, sequence3,
bag props/prototype/integrity flags/nextSeq remain untouched. ABI is unchanged;
three locals are appended only when the class arm is available.

Actual `$PropEntry` layout was verified in `object-runtime.ts:1112` and actual
delete stores in its `__delete_property` body around 4270. The latter does not
reallocate or compact; its comment is not substituted for its instructions.

## Stop-condition reproducer

The final-own assertion passes on the immutable predecessor and fails on the
candidate. The parameter-key function selects the real runtime applier:

```js
function own(o, k) {
  const f = Object.prototype.hasOwnProperty;
  return f.call(o, k) ? 1 : 0;
}
function remove(o, k) {
  try {
    return delete o[k] ? 1 : 0;
  } catch (_) {
    return 0;
  }
}
function defineAgain(o, k) {
  Object.defineProperty(o, k, {});
}
class C {
  x = 11;
}
const o = new C();
Object.defineProperty(o, "x", { value: 23, writable: false, configurable: true });
const deleted = remove(o, "x");
const afterDelete = own(o, "x");
defineAgain(o, "x");
const afterDefine = own(o, "x");
```

- `afterDefine`: JavaScript 1; predecessor 1; candidate 0 (new wrong answer).
- Separate staged control `deleted + 2*afterDelete + 4*afterDefine`:
  JavaScript 5; predecessor 7; candidate 1.
- Thus the predecessor already wrongly reports successful deletion while leaving
  the nonwritable property present. That earlier defect is NOT hidden or called
  conformant. The candidate repairs deletion but introduces final-own absence
  after a definition which must create an own undefined-valued property.

Final-own source SHA256:
`945199f550a6fdda732bddd2d1aaebe1a6f3f2c5138640c8e7ec00da8eeb6dca`.
Predecessor binary SHA256:
`046988a4a2dca0aa2e8969304784fc06494fa6579fa2035ebf66fcb2899a0243`.
Candidate binary SHA256:
`e44ec415b7df2d73764ba6940bbefd3c98fd10001c423b796409bfb5a6bac40c`.

## Selected owner and required amendment (not implemented)

In `.tmp/class-delete-candidate-v5/24.wat`, `defineAgain` starts at line55396
and calls `__defineProperty_value`; its actual emitted body starts at35725.
`__carrier_bag_delete` starts at19475; actual delete at19728; main at6744.
All measured modules have zero imports, so native helper selection is not a
host fallback. The class predicate and retained-entry stores are present in
the emitted carrier helper, not merely in unused source.

`object-runtime-descriptors.ts:343` resolves a live self-marker through
`__obj_find` as a nonnull existing entry. Data preflight therefore bypasses
the absent-property extensibility check. The existing-entry merge at574
preserves unspecified flags/value; an empty descriptor preserves bag-self
and the property remains invisible. The accessor owner at986 similarly merges
a nonnull entry before its absent-property check at1165. Class admission into
these actual bag appliers is owned by `carrier-bag-define.ts`.

Required reviewed extension: recognize a canonical marker as semantic ABSENT
in the data AND accessor descriptor appliers, authenticated to the actual class
receiver/bag, without changing nonclass behavior. Validation must complete before
removing/replacing suppression. Nonextensible failure must preserve absence and
the marker. A successful define must apply NEW-property defaults (including own
undefined for `{}`), proper value/accessor state, and correct new insertion order
and accounting. Do not simply delete the marker before preflight, feed its flags
to an existing-property merge, or weaken the controls. No implementation of that
extension is authorized by the current deletion-only release.

## Paired measurement receipts

Lane: standalone, zero imports, local Vitest3.2.4, Node22.23.2, direct
`compileSourceSync`, module init then exported main. This is not the CI Node25
harness or a rerun of the original three fixtures or the 124-row population.
Baseline is a `git archive` of exact83832 into `.tmp/delete-baseline`, never the
mutable parent composition. All corresponding source hashes match.

- v3: 24/24 pairs, predecessor9 pass/15 fail; candidate16 pass/8 fail;
  seven gains, no pass-to-fail changes in THAT set.
  Six configurable true/false/undefined × writable controls pass on candidate;
  seal/freeze refusals also become correct. Double deletion, descriptor override,
  preventExtensions+failed assignment, accessor counters, ctor, real Object,
  array/function expando, and proxy-as-value counter controls are retained.
- v3 growth test completes 80 successful delete calls and sees 40 new own keys
  after 40 old/40 new definitions. `Object.keys` returns zero on BOTH sides:
  4080 vs JavaScript404080. This is not a full passing enumeration or internal
  count/rehash proof. Ordinary struct-literal dynamic deletion is also unchanged
  wrong (3 vs1). No proxy-receiver trap-equivalence claim is made from a proxy
  VALUE control.
- v3 literal-key define cases fail identically. Emitted main for `{}` has no
  second applier call, only descriptor construction/drop. Those results do not
  prove runtime preflight. Original probes/WAT remain retained.
- v4: six parameter-key define pairs, 0/6 pass on BOTH sides. Empty descriptor
  returns9 (expected5 extensible/11 nonextensible); value/accessor return13
  (expected5/11). Emitted `defineAgain` in `19.wat:55424` calls actual data
  applier206. This proves retained-marker preflight/merge risk, not a new flip.
- v5: two nonwritable empty-define pairs above, predecessor1/2 pass, candidate0/2;
  one explicit new final-own failure. Production work stopped here.

Raw logs: `.tmp/class-delete-{baseline,candidate}-v3.log`, `-v4.log`, `-v5.log`.
Source and complete emitted WAT: corresponding directories without `.log`;
numeric case indices24/25 are the v5 reproducers. Each JSON result includes
source and binary hashes. v1 logs retain the initial strict-delete rejection
test mistake; v2 logs retain the corrected refusal probe. Neither is substituted
for the final source. The final 26-case file was measured in scoped batches;
there is no claimed single all-green 26-case run.

## Checks and handoff

Typecheck, LOC budget (+96 counted LOC), function budget, IR layering and scoped
Biome lint passed after correcting the local type to `ref_null`. Formatting and
diff whitespace checks passed. The first typecheck error is retained separately.
Final typecheck/lint receipts are `.tmp/class-delete-final-{typecheck,lint}.log`.
Normal commit hooks were not invoked because correctness failed; no bypass and
no commit occurred. Parent and Nash received the exact stop-condition evidence.
Further production work requires the reviewed descriptor-owner amendment.

## Subsequent High-approved release: marker-as-ABSENT amendment

The parent subsequently released the following exact protocol, superseding the
stop for these named owners only. Historical failure receipts above remain valid
for the deletion-only candidate; they are not rewritten as passes.

Own `carrier-bag-define.ts` builders and `object-runtime-descriptors.ts`
DATA/ACCESSOR integration with appended locals, composing the stopped delete
candidate, plus the existing additive test/handoff. No other owners, presence,
static state, or general predicate changes. After actual `__obj_find`, authenticate
ALL of: original receiver0 passes `IS_CLASS_INSTANCE_CARRIER`; lookup-only
`__closure_bag_lookup(receiver)` identity equals the actual substituted bag;
found entry is nonnull; canonical `buildBagMarkerTestInstrs` recognizes bag-self
value. Save the physical entry in a new local and set only semantic current
entry (DATA11/ACCESSOR12) null. No storage mutation at authentication.

DATA runs ordinary absent extensibility validation. ACCESSOR marker plus
nonextensible directly throws the existing refusal, bypassing the physical-field
ownership exception in `accNonExtensibleArm`. Preserve validation/evaluation and
throws. After all validation, before grow/insert, commit directly to the retained
entry: key0 unchanged; sequence3 gets bag.nextSeq, then increment nextSeq exactly
once; DATA gets new canonical value and flags, with getter4/setter5 null;
ACCESSOR gets null value1, new flags and getter/setter inputs. Dynamic `{}` creates
own canonical undefined with all attributes false; no retained attributes.
Count/tombstones stay unchanged because the marker is physically live. Return
the original receiver. No allocation, grow, public Set, delete/reinsert, second
key coercion, or user code in the commit. Refusal preserves fields/sequence/counts.

Hard gates are O0/O2 final-own1/stage-mask5, empty/data/accessor/defaults,
null-versus-undefined, new insertion sequence, integrity/invalid/throw refusals,
repeated delete/redefine, actual growth counts, constructor/instance and nonclass
preservation. Known public `Object.keys` failure is NOT sequence/count proof.
Retain original failures/baseline, stop before another owner, no push, normal
checks and commit only after correctness validation.

### Implementation within the release

`classMarkerDefineState` emits the four-part authentication, semantic-current
clear, appended locals, and retained commit. `classMarkerDataCommit` uses the
existing `canonicalUndefinedExternInstrs`, not a null fallback for omitted value.
Both appliers keep their actual find and ordinary validation order. The existing
carrier-specific accessor nonextensible builder was moved, with its comments and
logic, into `carrier-bag-define.ts`; this is actual carrier-owner factoring, not
an allowance, comment removal, or generic predicate change. It keeps the
descriptor driver within its normal LOC/function budgets. A transient missing
return-expression error during factoring was caught by typecheck/tests, repaired,
and its failed logs retained (`class-marker-storage-first.log`, typecheck2).

The first amended behavioral run is **24 correct + 2 retained baseline failures**,
not 26 conformance passes. The first seven direct-storage O0 controls passed.
An expanded 90-test execution finished its assertions but reported an RPC task
update timeout; a parallel old-control run hit a worker heap OOM/IPC teardown.
These are failed process receipts, not clean gates. Their logs are retained.
Subsequent runs are serialized, and the additive test yields to the event loop
and permits the already-enabled test-worker GC between cases, without raising
the configured memory limit or skipping hooks.

### Runnable original failures, never a diagnostic-green waiver

The original case source and `expect(actual).toBe(expected)` remain executable
in the additive test. The test-only `CLASS_DELETE_ASSERT_ORIGINAL_JS=1` runs that
exact expected-JavaScript assertion for the two known failures, bypassing the
separately labeled diagnostic comparison. It is not a compiler/public flag.
The expected value is computed by executing the SAME source in JavaScript.

Reproduce both original failures at O0 and O2, with zero import assertions:

```sh
CLASS_DELETE_ASSERT_ORIGINAL_JS=1 \
CLASS_DELETE_COMPILER_ROOT=/private/tmp/js2-5753-class-provenance-20260915/.tmp/delete-baseline \
pnpm exec vitest run tests/issue-5753-class-retained-delete.test.ts \
  -t 'ordinary object unaffected|keys and rehash after repeated deletion'

CLASS_DELETE_ASSERT_ORIGINAL_JS=1 \
pnpm exec vitest run tests/issue-5753-class-retained-delete.test.ts \
  -t 'ordinary object unaffected|keys and rehash after repeated deletion'
```

Exact before/after raw receipts live in
`.tmp/class-marker-original-failures-{baseline,candidate}.log`. The predecessor
remains immutable83832, not mutable integration. Original v3 source hashes:
ordinary literal and growth cases are recorded in their retained JSON rows;
the executable bodies are still present in `cases` in the test, not prose-only.
The literal's required answer is1, recorded wrong answer3; growth's required
answer is404080, recorded wrong answer4080. Those obligations remain OPEN.
Acceptance requires matching before/after source/result/status receipts, not
counting the default diagnostic comparisons as conformance. No claim of repaired
general class ownness or the 124-loss population is made.

Actual storage tests append test-only exports to a generated module and inspect
the real `$Object`/`$PropEntry`: count, tombstones, nextSeq, entry sequence, flags,
nullness of value/getter/setter, key identity, and retained entry identity.
They test both unoptimized and actually optimized binaries (optimizer success
is asserted), default descriptors, null/undefined, 40-entry growth, and refusal
preservation. These are separate evidence from the still-broken public key API.

### Final review corrections and validation accounting

Parent's no-marker-path review was applied: DATA and ACCESSOR emit the original
`local.tee 11` / `local.tee 12` exactly when marker state is undefined, rather
than a set/get pair. `fnIntrinsicSeedInstrs` is back in the import group. No
blanket host/no-demand byte-identity claim is inferred from behavior tests.

The clean serialized `.tmp/class-marker-clean.log` execution completed96 tests
without process errors: **60 behavioral correctness checks + 32 direct-storage
checks + 4 labeled baseline diagnostic comparisons** (each stratum includes O0
and O2). Do not call that96 conformance passes. At the original26-case scope it
remains24 correct plus2 known baseline failures per mode. Subsequent final
no-marker emission and canonical-undefined identity assertions are additionally
subject to the normal changed-root commit hook, not waived by that earlier run.

Exact original-failure receipts now use
`.tmp/class-marker-original-failures-baseline-v2.log` and
`.tmp/class-marker-original-failures-candidate-v2.log`: each exits1 with4 expected
assertion failures and no unhandled process errors. The first baseline attempt
loaded both compiler graphs and exhausted the normal512MB worker; that log is
retained, not counted. Storage-only imports are now lazy, so a baseline-only
run loads only its own compiler graph. No memory limit was raised.

The original executable source hashes, identical before/after at BOTH levels:

- Literal dynamic delete:
  `c42a6e11fab79bccd747b4836e44fa27a455537b5bfb0616dea75e2d1cf050e7`;
  base3, candidate3, required1.
- Class growth/public keys:
  `48a16714eef915c6c2443f28d7292eca21b41b704a5c7c2cfc79f68c8dfe65a7`;
  base4080, candidate4080, required404080.

Retained existing-owner checks, run serially with normal worker limits:
Error8/8 (`class-marker-error-controls.log`), closure define9/9
(`class-marker-closure-controls.log`), and18 existing accessor/carrier probes
in three6-case batches (`class-marker-r6-controls-{a,b,c}.log`). The latter
includes its pre-existing explicitly labeled Reflect residual; these receipts
are preservation checks, not a declaration of full MOP conformance. The8
Test262 rows collected by that older test file were not rerun in these bounded
batches; the original OOM attempt is not their validation. Neither the original
three class-own regressions nor the124-loss population is claimed repaired.

The storage probe additionally compares the actual entry value by `ref.eq` with
the module's canonical `__undefined` global, rather than merely testing nonnull.
It checks actual retained entry identity, key identity, sequence and bookkeeping;
failed define preflight must preserve the same entry and full recorded state.

### Actual no-marker emission parity receipt

Parent's `local.tee` finding is closed by explicit conditional emission AND a
paired measurement against immutable83832, not by assuming normalization.
Script `.tmp/class-marker-no-demand.mts`, run through `node --import tsx`,
produced `.tmp/class-marker-no-demand-{baseline,candidate}-v5.log` (exit0).

Two real GC/native-string generated-module samples (standalone false) have
identical complete raw WAT and binary files by `cmp`, both Wasm-valid:

- `Object.keys` sample:23431 bytes,4 imports/7 exports;
  binary SHA256 `2fc59a732d27d5774a736c2278aefafd4fd461a6d5c7ac8519fb4b9e5730fe9a`.
- Parameter-key data define plus keys:25277 bytes,8 imports/22 exports;
  binary SHA256 `c5a360e8d338b0334abf5b553eec3d490ca54ce542e7aebe32a531ba190b9a38`.

Those two modules correctly have zero native descriptor helpers; they are NOT
the evidence for the tee inside an applier. A separate direct emission through
the actual `ensureObjectRuntime` in a GC codegen context asserts the class
predicate is absent and both descriptor helpers exist. Their full raw function
records (including locals and instruction bodies) compare identically by `cmp`:
SHA256 `c15b84c0e5b0a01c8e757584dea14509ada2e32844a69a90cc67b5cca71fd408`.
Using the actual context-owned `__obj_find` handle, the probe observes
DATA `call find; local.tee11` and both ACCESSOR find/tee12 sites on BOTH sides.
Files: `.tmp/class-marker-no-demand-{baseline,candidate}/2.helpers.json`.

The direct-emission record is raw IR evidence, not a completed runtime-module
execution: an earlier attempt to emit that minimally prepared context as full
WAT encountered an unresolved upstream call target on both sides. That failed
attempt is retained separately. The initial CLI IPC-denial and an incorrect
absolute-index probe are likewise retained, never counted as passing evidence.
No blanket all-host or nonclass byte-neutrality claim follows from these bounded
measurements. Nonclass behavior is separately covered by the retained tests.
