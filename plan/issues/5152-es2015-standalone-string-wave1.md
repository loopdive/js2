---
id: 5152
title: "ES2015 standalone: string conformance wave 1"
status: in-progress
sprint: current
created: 2026-08-28
updated: 2026-09-20
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
  - src/codegen/string-search-value.ts
  - src/codegen/string-ops.ts
  - src/codegen/regexp-standalone.ts
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-enumeration.ts
  - src/codegen/object-ops.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/iterator-native.ts
  - src/codegen/case-convert-native.ts
  - src/codegen/case-tables.ts
  - src/codegen/string-raw.ts
  - src/codegen/literals.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/symbol-native.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/string-isregexp-guard.ts
  - src/codegen/string-proto-tostring.ts
coercion-sites-allow:
  # (#5152) §7.2.8 IsRegExp step 3 is literally `ToBoolean(matcher)`, and this
  # site performs it by CALLING the shared native `__is_truthy` helper — the
  # same one `new Boolean(x)` and the object-ops truthiness path use. No
  # ToString/ToNumber/ToPrimitive matrix is hand-rolled here; the ToString half
  # of the same lane deliberately delegates to `emitStringProtoToStringFlat`.
  - src/codegen/string-isregexp-guard.ts
  # (#5152) The standalone array-like reader turns its f64 index into the
  # canonical property key with the existing native `number_toString` helper
  # before delegating to ordinary `__extern_get` / `__extern_has`. This is not
  # a new coercion matrix: it shares the runtime's established numeric-string
  # implementation so bag descriptors at keys such as `"0"` retain ordinary
  # Get/Has behavior.
  - src/codegen/object-runtime.ts
func-budget-allow:
  - src/codegen/case-convert-native.ts::emitNativeCaseConversion
  - src/codegen/case-convert-native.ts::makeStr
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
  - src/codegen/array-object-proto.ts::emitStringProtoMemberBody
  - src/codegen/object-ops.ts::compileObjectDefineProperty
  - src/codegen/object-runtime.ts::fillExternArrayLikeStructArms
  - src/codegen/object-runtime.ts::fillClosedStructExternGetArms
---

# ES2015 standalone: string conformance wave 1

## 2026-09-20 anonymous-expando deletion follow-up constraints

The reader checkpoint is published separately as upstream PR 5991. Its frozen
30-path result is 29 pass, one failure; deletion/reassignment remains a distinct
follow-up in `codex/5152-anon-expando-delete-20260920`.

IR coordination reports no competing claim for the consumer-only bag-deletion
direction. The writer must prove exact receiver/shape admission, complete
physical-field inventory, and reservation/fill reachability in an
anonymous-expando-only module before adding the arm. Existing identity-keyed
bag presence authenticates a stored descriptor, not those other facts. Keep
closure/generator/vec/Error and retained-marker class routes first; no new
layout marker, late helper minting, or producer mutation is authorized.

Additional review finding: the dynamic reader's existing exposed-field loop
uses a truthiness check that omits an empty-string field name. The deletion
collision inventory must not copy that condition: distinguish `undefined`
from `""` and test an empty-name physical override alongside legal `$` and
`__` user keys. Otherwise deleting a bag override could resurrect a physical
value. Missing proof must decline rather than claim successful deletion.

Source qualification: `struct-field-exports.ts` assigns shape IDs only to
colliding anonymous groups with nonempty exposed-name inventories, not every
anonymous object. Its collector skips empty names; `coldOwnFieldsFor` also
filters empty and `$`/`__` names. Neither output alone proves a complete
physical collision inventory. An exact-stamp admission rule must demonstrate
that the original failing String.raw receiver is actually admitted; if not,
the writer needs a sound alternative using existing metadata rather than a
new marker or a silently inactive fix. Cold/split or canonical/subtype shapes
without complete proof must remain unhandled.

Exact-diff review identified two additional inventory hazards. The fnctor
field-name helper maps `$constructor` to `constructor` unconditionally, so an
anonymous user-recorded `$constructor` must retain its raw collision name.
Also, `literals.ts::_hasRuntimeComputedKey` admits well-known Symbol keys into
static layouts and `resolveComputedKeyExpression` spells them `@@name`.
Thus not every Symbol bag entry is necessarily a true expando: deleting an
overlay of a physical Symbol property can resurrect that property. Until
symbol-aware physical collision proof exists, decline anonymous candidates
with reserved `@@` physical names. Add separate physical Symbol.iterator and
string `"@@iterator"` controls; do not change literal producers to force them
through the new arm.

## 2026-09-19 original-row candidate checkpoint

The safe closed-struct reader candidate, with the unsound unconditional static
accessor fallback removed, was run on the three original String.raw failures
using Node 24 and the maintained standalone path runner with `--isolate`.
The writer worktree is `codex-5152-string-raw-audit-20260919`, based on
`4a6cbdf1ee80b5d1618a7c87b014bc792f0fddc7`, with uncommitted source changes.
The measured result is **1 pass / 2 failures**, not completion of this issue:

- `built-ins/String/raw/nextkey-is-symbol-throws.js`: pass.
- `built-ins/String/raw/template-length-throws.js`: expected exception absent.
- `built-ins/String/raw/returns-abrupt-from-next-key.js`: strict rerun fails
  with a read-only-property assignment TypeError.

Evidence: `/private/tmp/js2-5152-raw-three-standalone-candidate-20260919.log`.
The corresponding import audit in
`/private/tmp/js2-5152-raw-three-imports-20260919.log` reports `success: true`
and `imports: []` for all four primary/required-strict artifacts. Each audit
entry also reports `errors: 1`; severity must be inspected before describing
diagnostics as clean. The path runner's terminal exit status alone does not
establish a passing suite; the row counts above are authoritative for this run.

The pinned census used an older compiler (`a3943f63...`), so this checkpoint
does **not yet claim a same-base original-row gain**. The writer retains the
compiler lease briefly to check the original Symbol row on untouched
`4a6cbdf1...` with identical runner settings, then hands the lease to the
RegExp writer. The remaining static accessor cases need a successful,
per-instance definition record; compile-time accessor metadata is not proof
that an accessor was installed on a particular runtime object. The independent
peer is specifying that lifecycle before widening implementation ownership.

### 2026-09-20 admitted accessor-definition repair

Same-base follow-up: the original Symbol row fails on untouched compiler
`4a6cbdf1ee80b5d1618a7c87b014bc792f0fddc7` with the expected-TypeError-absent
assertion. Evidence is
`/private/tmp/js2-5152-raw-symbol-baseline-4a6-20260920.log`, produced by the
adjacent `.mts` script calling authoritative `runTest262File` in a fresh
single-row process. The script imports the coordinator worktree compiler and
remaps missing worktree corpus reads to the shared pinned Test262 checkout;
this is an explicit harness-path adaptation, not a literal invocation of the
maintained `--isolate` command. Together with the candidate pass above it
supports one original-row fail-to-pass transition, subject to completion of
the remaining regression gates. Its separate compile audit succeeds with no
imports and one **warning** (`$DONOTEVALUATE` IR fallback/type-index parity),
not an error-free diagnostic list. The candidate severity audit in
`/private/tmp/js2-5152-raw-symbol-candidate-errors-20260920.log` reports the
same warning with successful compilation and no imports. Both follow-up
processes exited zero; the writer explicitly released the compiler/test lease
to the RegExp writer and continues accessor-definition source work only.

The independent peer identified an existing identity-keyed carrier bag that
can hold the missing descriptor; no closure or carrier allocation ABI change
is needed. The writer is now authorized to extend only the standalone
anonymous-struct static inline accessor arm in `object-ops.ts`:

1. Preflight runtime helper availability and late import shifts before receiver
   emission. Keep the existing saved receiver; do not reevaluate its AST.
2. Build each getter/setter closure exactly once into fresh externref locals.
   Use those same closure objects for the bag and existing static globals.
3. Call existing `__defineProperty_accessor` with the saved receiver, key,
   closures, and descriptor flags. Check rejection, drop its retained result,
   and publish the globals only after successful definition.
4. Keep dynamic readers on the bag-first route with the original receiver.
   Do not reuse `emitExternDefinePropertyNoValue`, which would replay receiver,
   key, and closure evaluation in this arm.
5. Verify the original accessor rows, physical-field overrides, undefined
   accessor results, getter receiver identity, pre-definition/untaken-branch/
   same-shape isolation through String.raw, and rejected redefinitions. Keep
   zero-import validation and same-base regression comparisons.

The existing direct typed-property dispatch still consults per-shape globals
and compile-time accessor metadata. Its lifecycle defect is a separate
residual, not solved by this dynamic-reader repair; preserve tests/evidence
and do not advertise general Object.defineProperty conformance. Host lowering
and IR-owned closure/carrier allocation remain unchanged. Coordinate exact
`object-ops.ts` hunks with the concurrent RegExp intrinsic descriptor route.

Coordinator source review of the initial mirror found a required correction:
if `buildAccessorClosure` fails, installing null with the getter/setter-present
bit silently changes a supplied accessor into an absent function. Do not use
that fallback. Preflight support before emission or report a hard compilation
failure after emission; do not produce successful wrong semantics. Likewise,
the preflighted descriptor helper must not have a silent missing-target arm
that leaves its five arguments on the stack. These review findings were sent
to the writer before candidate testing; this mirror has no passing claim yet.

Corrected-mirror follow-up: fresh standalone `--isolate` execution of the
three original rows now reports **2 pass / 1 fail** in
`/private/tmp/js2-5152-raw-three-mirror-20260920.log`. Both
`template-length-throws.js` and `nextkey-is-symbol-throws.js` pass;
`returns-abrupt-from-next-key.js` still fails its strict rerun with a read-only
assignment TypeError. The template-length row previously failed on the safe
reader-only candidate, so this records an additional measured transition in
that same-base candidate sequence, not a full-suite gain claim. The writer
corrected the silent closure/helper failure paths; the frozen 30-original
manifest is the next validation. Full regression/typecheck/publication gates
remain.

The frozen 30-original candidate run subsequently reported **29 pass / 1
fail**, with no skip/compile-error entries, in
`/private/tmp/js2-5152-string-raw-30-standalone-mirror-20260920.log`.
The run was independently confirmed live (runner PID 64055 with an isolated
child) before its buffered summary appeared; no duplicate was launched.
Compare against fresh same-base evidence before calling this a population
delta from the older pinned census. The one failing original defines a
configurable getter at raw index `0`, deletes that property, then assigns
`"a"`; the strict rerun reports generic read-only assignment refusal. The
next bounded diagnosis should observe the delete result and own descriptor
after deletion. Its presence in the older host census is not a completion
exemption. Broader reader/descriptor regression gates and publication remain.

Exact lifecycle diagnostic follow-up
(`/private/tmp/js2-5152-delete-lifecycle-exact-20260920.log`) compiles
successfully with `errors: []` and `imports: []`. Its result mask is **43**
in standalone versus **51** in direct Node: both catch the initial getter
throw (32), return true from delete (1), and report undefined from the
post-delete own-descriptor read (2). Standalone then catches assignment (8),
whereas direct Node completes it (16). These are assertion bits, not row
counts. This narrows the remaining defect to inconsistent post-delete
assignment behavior. Do not infer that bag storage was physically removed
solely from a descriptor API result; the emitted setter/refusal path still
needs identification before changing shared deletion/setter code. No such
source expansion has been authorized for this lane yet.

Emitted helper follow-up resolves assignment through `__extern_set_strict`
(151), `__reflect_set` (150), then `__extern_set` (149). The generated
`__carrier_bag_delete` (152) lacks an anonymous-instance lookup, while the
instance setter still consults its identity bag and refuses its getter-only
descriptor. Evidence:
`/private/tmp/js2-5152-delete-lifecycle-helper-map-v2-20260920.log`.
This supersedes the earlier suggestion of a purely static direct-setter defect;
the post-delete descriptor read alone did not prove that the bag was removed.

IR coordination identified a real shared-file owner: #5753 at
`cddba56b768f30eb5d9af29d2954dd69e2b534b5` adds class-only deletion with
retained suppression markers and locals 3/4/5. Preserve that entire protocol;
do not widen its class predicate or simply delete anonymous physical-field
overrides, which could resurrect physical data. No known anonymous-expando
implementation is owned there. A separate narrow true-expando plan must prove
identity lookup, receiver/key admission, physical-field collision handling,
and reservation/fill ordering before any deletion source release.

Follow-up deletion implementation plan (2026-09-20, source-reviewed only):

1. Finish and publish the frozen reader/mirror repair independently. Then
   claim a separate true-expando deletion slice; do not mutate the frozen
   candidate while its publication gates run.
2. At FINALIZE enumerate concrete allocated `__anon_` shapes. Match both Wasm
   type and logical collision stamp using the existing `buildShapeGuardedArm`
   contract; a type-only match is insufficient for canonicalized shapes.
3. Look up, never ensure, the receiver's existing closure bag. Retain the
   current -1/0/1 not-handled/refused/deleted protocol and ordinary `$Object`
   bag/type/own-entry checks. Delegate successful admission to the existing
   `__delete_property`, rather than duplicating configurable/count logic.
4. Screen physical-field collisions before delegation. Reuse
   `exposedClosedStructFieldName` for public field names, and compare the
   normalized stored own-entry key, avoiding another user-observable key
   conversion. A physical collision must remain unhandled in this slice:
   deleting its overlay alone can resurrect physical data. Uncertain shape
   metadata also remains unhandled, not claimed-success.
5. Append any required scratch locals after the actual existing local list;
   do not reserve fixed indices used by IR's class route. Preserve class
   predicates, arm order, retained-marker authentication/count repair, builtin
   function metadata precedence, and generator/vec/Error routes. No late
   helper/type/import minting or shared instruction-tree aliases.
6. Required controls: the exact original strict String.raw delete/reassign
   test; accessor/data true expandos; non-configurable sloppy false and strict
   TypeError; repeat deletion; missing bag; independent same-shaped objects;
   physical-field override non-resurrection; class retained-marker regression;
   function name/length and generator deletion controls. Compare candidate and
   untouched base using the same runner, then rerun all 30 String.raw originals.

The verified IR task confirms no active anonymous-expando writer or pending
fix to await. It requests fresh head comparison and narrow proposed hunks
before shared fill/local changes. This plan is not implementation approval or
runtime evidence; class and physical-field deletion semantics remain intact.

Fresh integration check: `git ls-remote` on the retained IR fork branch again
returned `cddba56b768f30eb5d9af29d2954dd69e2b534b5`. Inspection confirms its
`classArm` replaces `fn.locals` with bag plus class locals 3/4/5. Therefore
anonymous scratch allocation must occur **after** that replacement; simply
appending at the start of the fill would lose those locals during composition.
The narrow insertion/ordering plan has been sent to the verified IR task for
review. No shared source has been changed by this check.

IR composition review found no ownership conflict, with an additional
admission requirement: authenticate actual anonymous-literal provenance, not
the `__anon_` naming heuristic or structural type alone. The earlier plan's
shape enumeration is only a candidate list, not sufficient proof. Inspect
existing allocation/provenance records before choosing the guard; do not add
a context/literal recording field without coordinating those owned seams.
`isInternalStructFieldName` documents that literal insertion-order metadata
preserves legal `$`/`__`-prefixed user keys, so a collision filter must not
silently classify those as hidden fields. Validate the no-class/no-closure/
no-vec/no-Error demand case to prove helper reservation actually occurs.
Add accessor non-invocation and Symbol-versus-string key controls. This is
composition clearance, not approval of an unreviewed implementation.

Reservation/fill source audit: the current single-source pipeline stamps
shapes at `codegen/index.ts` before `fillObjVecReflectionHelpers`; the
multi-source pipeline has the same ordering. That reflection fill calls
`fillCarrierBagDelete`, so final logical shape stamps are available there.
`reserveCarrierBagDelete` is called while building object deletion, but its
carrier-demand predicate still needs the anonymous-only runtime control.
The existing `object-literal-carrier.ts` records AST-to-carrier provenance in a
private WeakMap, not an enumerable finalizer registry. The strict-method
allocation recorder deliberately excludes property-only literals, and the
insertion-order map is absent for empty literals. None can be silently
substituted for complete literal provenance. Any registry/API extension must
be explicitly scoped and coordinated; do not broaden a heuristic to hide a
missing proof.

IR review held the subsequent proposed marker-field/type-mutation design:
patching shared canonical layouts/all constructors would be a separate
representation and lifecycle change, not covered by deletion ownership.
No such implementation is released. The writer is instead auditing whether
existing per-instance descriptor/bag identity plus own-entry proof and
physical-key collision decline can safely support true-expando deletion
without literal-origin proof. Preserve all earlier class and carrier routes;
do not broaden global carrier predicates. This is an engineering review hold
on that design, not a goal-wide blocker or request for user permission.

Focused reader fixture follow-up reports **3/5 pass / 2 fail** in
`/private/tmp/js2-5152-raw-readers-vitest-20260920.log`. Standalone full-mask,
direct Node, and the explicitly documented host deletion-refusal control pass.
The larger host accessor matrix and simple native-first positive fail. These
must be compared with untouched `4a6cbdf1...` under the same fixture/harness
before labeling them pre-existing or changing the tests. They are unresolved
validation findings, not successful host parity. This fixture result does not
alter the original 29/30 standalone row count.

Untouched-base fixture A/B completed at `4a6cbdf1...`, terminal exit 0,
recorded in `/private/tmp/js2-5152-reader-fixture-base-20260920.log`.
The host deletion-excluded matrix is 66528 on both base and candidate; its
earlier positive expectation was overbroad. Native-first is different:
base returns `"aXb"`, candidate returns `""` on the same simple positive,
which is a real regression. The standalone mask moves from 129478 on base
to 131071 on candidate; these remain assertion masks, not test counts.

The source mismatch is identified: `fillClosedStructExternGetArms` runs only
under `ctx.standalone`, but the new ordinary-reader redirect in
`fillExternArrayLikeStructArms` checked helper presence alone. Native-first
therefore redirected physical-field reads into a getter without matching
closed-field arms. Align the redirect's admission with its producer's
standalone condition, preserving the existing native-first physical reader.
The writer is authorized to make that narrow correction and rerun the gates;
do not count it fixed until the positive passes again.

After that correction, the exact fixture reports **4/5 pass**: native-first
again returns `"aXb"`; standalone, direct Node, and documented host deletion
refusal also pass. The only failure is the verified pre-existing host mask
expectation (66528 versus 131067), which has not yet been changed. Evidence:
`/private/tmp/js2-5152-raw-readers-vitest-after-nativefirst-gate-20260920.log`.
TS7 also passed (the sibling
`js2-5152-typecheck-ts7-after-nativefirst-gate-20260920.log`). The test lease
was explicitly handed back to RegExp. The host assertion may be renamed and
documented as a known-base deficit regression snapshot at 66528, not described
as complete host parity. Full correct Node/standalone masks and the native-first
positive remain required; the original strict-rerun deletion failure stays open.

LOC-growth allowance rationale (2026-08-28): the clusters below add a runtime
@@protocol dispatch lane, a reflective `String.prototype[Symbol.iterator]`
member, normalize validation + normalization tables, astral case-mapping
tables, and Symbol-rejection arms to the runtime coercion walkers — all in the
files listed in `loc-budget-allow`. Measured growth is expected and granted
for this change-set. `src/codegen/case-tables.ts` is GENERATED
(`scripts/gen-case-tables.mjs`) and grows by the new astral run tables.

Additional allowance rationale (2026-09-20): the bounded standalone
`String.raw` repair adds ordinary closed-struct reader arms in
`object-runtime.ts`, extracts their common `ToLength` tail into
`object-runtime-enumeration.ts`, and mirrors a successfully installed anonymous
accessor into the already-existing identity bag in `object-ops.ts`. The three
files are already over the source-size threshold; the allowance is limited to
these measured, reviewed additions.

Function-growth allowance rationale (2026-09-20): the function gate measured
only the three owning functions beyond their current thresholds:
`compileObjectDefineProperty` (1581/1475),
`fillExternArrayLikeStructArms` (530/425), and
`fillClosedStructExternGetArms` (534/470). Their added code is respectively
the one-evaluation successful-accessor bag mirror, the standalone ordinary
array-like-reader routing, and the descriptor-first closed-struct reader plus
Symbol boxing. The allowance is restricted to those three measured functions;
it does not update the shared function baseline or grant unrelated growth.

## Problem

### Latest frozen reader checkpoint (2026-09-20)

The reader/mirror source checkpoint is committed locally as
`acbab40d50` (`fix(codegen): preserve closed-struct raw accessors`), with
Thomas as author and the Codex/Terra Max attribution trailers. Normal
pre-commit gates passed. Inspection of the commit object found no embedded
signature, despite an initial writer report calling it signed; signing config
queries on this host are unset. No signing bypass was observed. Correct the
report rather than asserting a signature that is absent. The verified 30-path
manifest is now committed in follow-up `e34ebcbb8e`; its committed bytes match
SHA-256 `d7d2c223fb766dcc9ed460d3c2ddad520195dfc007db6d3c4f575575ba3e3827`.
The branch diff contains exactly the three source files, focused test, issue,
and acceptance manifest. Published upstream as
https://github.com/loopdive/js2/pull/5991, open and non-draft, at verified
fork head `e34ebcbb8e1283eddf9f2cc0b91a55eccbbfd97e` on
`ttraenkler:codex/5152-string-raw-audit-20260919`, base `loopdive/js2:main`.
Normal push gates passed. The remote accepted the branch despite a later
local tracking update hitting an existing shared config lock; the lock was
preserved and the remote SHA verified. Published source stays frozen while
the follow-up deletion work gets a separate worktree. The independent
RegExp reviewer also owns initial PR shepherding; a BLOCKED merge-state
summary is not itself a diagnosed conflict or a claim of merge readiness.
The independent one-shot PR read confirms `mergeable: MERGEABLE`, checked CLA
and successful completed checks; smoke, quality, issue/linear tests and
equivalence shards were still running. No failed check or blocking review was
found. Keep the completed scoped fix non-draft; do not poll or manually enqueue.

Final focused reader fixture: **5/5 pass**, verified from
`/private/tmp/js2-5152-raw-readers-vitest-final-20260920.log` (11.81s).
The host descriptor case is explicitly a known-base deficit snapshot, not a
claim of complete host conformance. The native-first positive control is green
after matching the ordinary-reader admission to the standalone getter producer.
The frozen original 30-path isolated standalone run remains **29 pass / 1 fail**,
verified from `/private/tmp/js2-5152-string-raw-30-final-20260920.log`.
The sole failure remains `built-ins/String/raw/returns-abrupt-from-next-key.js`,
whose strict rerun refuses assignment after anonymous bag deletion. That
unreleased carrier-deletion seam remains open and is not part of this reader
checkpoint. These are uncommitted candidate results, not landed census gains.

The writer retains the single compiler/hook lease for remaining validation and
normal publication gates. RegExp may edit its own isolated native flags getter
insertion, preserving this lane's user-declared bag prefix; it may not run
compiler jobs concurrently. No PR or completed-issue claim is implied here.

53 ES2015-bucket test262 tests under `built-ins/String/**` fail on the
standalone target (re-verified 2026-08-28 on head, branch
`claude/es2015-test262-standalone-9vij99`: all 53 from the day-old baseline
still fail — 52 FAIL + 1 COMPILE_ERROR, 0 already fixed). Eleven root causes
cover all 53; the top six cover 79%, the top seven 85%. The dominant gap — the
§21.1.3 @@match/@@search/@@split/@@replace runtime protocol (15 tests) — is
also what stands between the standalone string methods and any user code that
passes non-RegExp search values, so it feeds the broader 100%-ES2015
standalone goal beyond this file list.

**Target list**: `.tmp/es2015/wp-string-current-fails.txt` (53 paths,
regenerated 2026-08-28). Per-cluster lists:
`.tmp/es2015/str-cl-{A-search-value-protocol,B-normalize,C-symbol-iterator,D-indexof-toprimitive,E-astral-case,F-string-raw,G-isregexp-guard,H-codepointat,K-pad-symbol-fill,I-fromcodepoint-symbol,J-realm-deferred}.txt`
(verified: their union is exactly the 53-path target list).
Probe: `cd /home/user/js2 && npx tsx .tmp/run-standalone.mts --list <file>`.
Minimal repros from this analysis: `.tmp/probes5152/*.js` — run one via
`npx tsx .tmp/probe-one.mts /home/user/js2/.tmp/probes5152/<name>.js`.

## Current failure clusters

| # | cluster | count | root cause (file:function) | sample tests |
|---|---------|-------|----------------------------|--------------|
| A | @@match/@@search/@@split/@@replace runtime dispatch + split coercion order | 15 | `src/codegen/string-search-value.ts:isPlainToStringSearchValue` (L117) decides statically via `ctx.oracle.wellKnownSymbolMemberOf`; when the value MAY carry the protocol symbol there is no runtime `GetMethod` lane — `match`/`search` fall into the dynamic-RegExp lane (runtime `TypeError: Unsupported dynamic regular expression pattern`) or the #1474 refusal in `src/codegen/string-ops.ts` L3652-3674 (the `replace/cstm-replace-get-err.js` COMPILE_ERROR). Also `string-ops.ts` split arm (~L3400-3456) coerces separator before limit — spec wants `ToUint32(limit)` before `ToString(separator)` | `match/cstm-matcher-invocation.js`, `split/cstm-split-invocation.js`, `split/limit-touint32-error.js` |
| B | normalize: identity stub, no validation, no normalization | 10 | `src/codegen/string-ops.ts` L3563-3598: `normalize` is identity; form validated only when a static string literal; no runtime `ToString(form)` (Symbol must TypeError), no runtime RangeError, no reflective RequireObjectCoercible arm in `src/codegen/array-object-proto.ts`, and no actual NFC/NFD/NFKC/NFKD | `normalize/form-is-not-valid-throws.js`, `normalize/this-is-undefined-throws.js`, `normalize/return-normalized-string.js` |
| C | `String.prototype[Symbol.iterator]` missing | 5 | `src/codegen/array-object-proto.ts:STRING_PROTO_METHODS` (L237) has no `"@@1"` symbol member (Array's glue has `"@@1"` at L111; RegExp's has `@@7`-`@@10`, `regexp-standalone.ts` L5149). Reflective read returns `undefined`; probe `q5-iter-indirect.js` shows the element-access read even emits invalid Wasm ("expected i32, got externref" in `__module_init`) | `Symbol.iterator/prop-desc.js`, `Symbol.iterator/name.js`, `Symbol.iterator/not-a-constructor.js` |
| D | indexOf arg ToPrimitive sub-steps | 5 | Two defects: (1) an object LITERAL with computed `[Symbol.toPrimitive]` key is compiled as a closed struct the runtime walkers never probe — assignment-installed `obj[Symbol.toPrimitive]=…` works (probe p3 passes), literal form fails (probe q1: `-1`); `src/codegen/literals.ts` literal lowering vs the #5102 `Symbol.toPrimitive` probe in `src/codegen/object-runtime.ts` L4793-5012. (2) unboxing `Object(Symbol())` yields a `$Symbol` carrier that the ToNumber/ToString walkers accept silently instead of throwing TypeError (probe q4) | `indexOf/searchstring-tostring-wrapped-values.js`, `indexOf/position-tointeger-errors.js` |
| E | astral (supplementary-plane) case mapping | 4 | `scripts/gen-case-tables.mjs:simplePairs` scans only `cp <= 0xffff`; `src/codegen/case-convert-native.ts` maps per i16 code UNIT, so surrogate pairs pass through unmapped (Deseret U+10400↔U+10428 etc.) | `toLowerCase/supplementary_plane.js`, `toUpperCase/supplementary_plane.js` |
| F | String.raw descriptor loss + Symbol segment | 3 | Template object reaches `__str_raw` through `materializeStructAsDynamicObject` (`src/codegen/expressions/call-builtin-static.ts` L805-825), which snapshots values — accessors installed via `Object.defineProperty` on the (nested) template are not consulted (probes q6/r2 fail while the DIRECT read r1 passes, isolating the materialization). Symbol-valued segment needs the same walker TypeError arm as D | `raw/template-length-throws.js`, `raw/returns-abrupt-from-next-key.js`, `raw/nextkey-is-symbol-throws.js` |
| G | IsRegExp runtime check in includes/startsWith/endsWith | 3 | `src/codegen/string-ops.ts` L3037-3080 arms do only the STATIC #2598 check (`L421`); §7.2.8 `Get(arg, @@match)` never runs, so a poisoned `Symbol.match` getter cannot throw | all three `*/return-abrupt-from-searchstring-regexp-test.js` |
| H | codePointAt OOB → NaN not undefined | 2 | `src/codegen/string-ops.ts` L3462-3560 returns plain f64 with NaN sentinel for out-of-range; the js-host fix was #2004, standalone still unpatched (probe q7: `NaN`) | both `codePointAt/returns-undefined-on-position-*.js` |
| K | padStart/padEnd Symbol fill → invalid Wasm | 2 | `src/codegen/string-ops.ts` L3215-3217 / L3250-3252 compile the fill arg with bare `compileExpression + emitFlatten()`; a `Symbol()` arg is a bare i32 id, producing `call[0] expected (ref null 6), found global.get of type i32`. The existing `emitArgAsNativeString` (L463) already carries the §7.1.17 Symbol TypeError guard and is simply not used here | both `pad{Start,End}/exception-fill-string-symbol.js` |
| I | fromCodePoint(Symbol) no TypeError | 1 | `compileFromCharCodeFamily` via `src/codegen/expressions/call-builtin-static.ts` L750-777 coerces the arg to number without the Symbol rejection (probe q8) | `fromCodePoint/argument-is-Symbol.js` |
| J | cross-realm (deferred — #4274) | 3 | `$262.createRealm` pseudo-realm lacks per-realm `String`/`TypeError` identity; owned by #4274 (status ready) + #4634 — do NOT implement here | `proto-from-ctor-realm.js`, `valueOf/non-generic-realm.js`, `toString/non-generic-realm.js` |

## Implementation Plan

Order is by count descending; each step is independently landable, so partial
completion maximizes yield. All work is standalone-lane (`noJsHost(ctx)` /
`ctx.standalone` gates); js-host mode is untouched. Constraints throughout:
**no new host imports** (a host import is acceptable only as a js-host-mode
fast path with a Wasm-native standalone fallback — none is needed here); all
type queries through `ctx.oracle` (`src/checker/oracle.ts`), never
`ctx.checker.getTypeAtLocation` (oracle-ratchet gate; `wellKnownSymbolMemberOf`
already exists on the oracle); **never** edit `tests/test262-runner.ts`, any
skip list, or `scripts/*baseline*.json`.

### Step A — runtime @@protocol dispatch for match/search/split/replace (15 tests)

1. In `src/codegen/string-search-value.ts`, add an `emitSearchValueProtocolDispatch`
   builder that emits, for a search value held in an externref temp `sv`:

   ```
   if (!nullish(sv)) {                                  // §21.1.3.x step 2/3
     m = __extern_get(sv, __box_symbol(<id>))           // getter RUNS; abrupt propagates
     if (!nullish(m)) {                                 // GetMethod: null/undefined ⇒ skip
       if (!IsCallable(m)) throw TypeError              // GetMethod step 3
       result = __call_fn_method_1(sv, m, S)            // match/search: Call(m, sv, «O»)
       // split/replace: __call_fn_method_2(sv, m, S, limit/replaceValue)
       return result (externref)
     }
   }
   // fall through to the existing ToString / RegExpCreate lanes
   ```

   Follow the exact GetMethod-read shape of
   `compileNativeDisposableStackUse` in `src/codegen/disposable-runtime.ts`
   (~L1160-1245): `ensureObjectRuntime` + `ensureLateImport("__box_symbol",…)`
   + `flushLateImportShifts` + the regime-independent `nullishOf` combinator.
   Well-known ids: match=7, replace=8, search=9, split=10
   (`src/codegen/literals.ts` L2508). Callable test: the same
   `__typeof_function`-style probe `ordinary-to-primitive-probe.ts` uses.
2. Wire it into the lanes that currently lose these tests:
   - `tryCompileStandaloneStringMatch` / `...Search` (regexp-standalone.ts)
     and `tryCompileCoercedStringMatch`/`...Search`
     (string-search-value.ts L244/L277): before falling into
     `RegExpCreate(ToString(v))`, emit the dispatch. This turns the runtime
     `REGEX_UNSUPPORTED_DYNAMIC_PATTERN` TypeError into a correct `Call`.
   - the `split` arm (`string-ops.ts` ~L3400) and
     `tryCompileStandaloneSplitSeparator` (string-search-value.ts L318):
     dispatch BEFORE `ToString(this)` — `split/this-value-tostring-error.js`
     observes that the receiver is NOT coerced when the separator has @@split.
   - `replace`: same, before the ToString lane; this also deletes the
     `replace/cstm-replace-get-err.js` refusal path (the L3652-3674 refusal in
     string-ops.ts no longer fires for symbol-protocol arg forms once the
     dispatch lane exists — narrow the `symbolProtocolArgForm` refusal
     accordingly rather than deleting the whole diagnostic).
3. Evaluation/coercion order fix in the split string lane (same functions):
   evaluate both argument EXPRESSIONS in source order into temps, then coerce
   `lim = ToUint32(limit)` BEFORE `R = ToString(separator)`
   (`split/limit-touint32-error.js`). `compileStringIntegerArg`
   (string-ops.ts L2356) is the ToInteger engine to reuse for the temp.
4. `invoke-builtin-match/search*`: these read
   `RegExp.prototype[Symbol.match/search]` reflectively — today that read
   returns `undefined` even though the RegExp glue declares `@@7`-`@@10`
   (`regexp-standalone.ts` L5149). Fix the `<Builtin>.prototype[Symbol.X]`
   element-access READ path (`src/codegen/property-access-dispatch.ts`, the
   `Symbol.*` key arm) to resolve through the registered native-proto member
   closures — the same fix Step C needs, do it once there. With the runtime
   dispatch of A.1 in place, `''.match(/./)` after
   `RegExp.prototype[Symbol.match] = fn` must call `fn`; keep the static
   fast path for modules that never install such a member by reusing the
   module-scan gate pattern of `moduleInstallsCallableHasInstance`
   (`src/codegen/native-ordinary-instanceof.ts` L156).
5. Edge cases: `cstm-*-is-null.js` fall through to
   `RegExpCreate(ToString(obj))` = pattern `"[object Object]"` — verify
   `__regex_compile_dynamic_simple` accepts a `[...]` character class; if it
   refuses, the two `is-null` tests keep failing — check first, and if so
   handle that pattern class in `ensureDynamicStandaloneRegExpCompiler`
   (regexp-standalone.ts). The dispatch must evaluate `sv` EXACTLY ONCE
   (`cstm-matcher-invocation.js` counts calls).

### Step B — normalize (10 tests; 7 without Unicode tables)

Current-main revalidation (2026-09-19): the pinned oracle-14 ES2015 selection
contains exactly **14 normalize rows: 11 pass / 3 fail**. The three failures
remain `return-normalized-string.js`,
`return-normalized-string-from-coerced-form.js`, and
`return-normalized-string-using-default-parameter.js`. At `4a6cbdf1ee80`,
`string-ops.ts` explicitly still returns the receiver unchanged after form
validation; no native normalization helper or generator exists in the checked
source. Thus Step B.3 remains real unimplemented normalization, not the
String.raw descriptor issue. Related #1541's proposed opt-in ICU provider is
historical design, not implemented support or sufficient acceptance for the
default standalone goal. No normalization implementation claim or test run
has been started in this continuation.

#### 2026-09-20 read-only triage — complete normalization wave (base `upstream` `200f7e2c8bc00dfb9a9c50dcc4b6570413f8a567`)

This is a source/standards audit only. It preserves the frozen oracle-14
receipt above (11 pass / 3 fail) and deliberately did not run a compiler,
Test262, or a data generator. The queued next receipt is the exact three
remaining originals plus the eleven passing normalize controls, after the
separate lanes explicitly release the serial compiler/test lease.

The retained controls are `form-is-not-valid-throws.js`, `length.js`,
`name.js`, `normalize.js`, `not-a-constructor.js`,
`return-abrupt-from-form-as-symbol.js`, `return-abrupt-from-form.js`,
`return-abrupt-from-this-as-symbol.js`, `return-abrupt-from-this.js`,
`this-is-null-throws.js`, and `this-is-undefined-throws.js`. They are
preservation controls, not evidence that the three transform rows are solved.

**Verified current root cause.** `compileNativeStringMethodCall` in
`src/codegen/string-ops.ts` has a dedicated `method === "normalize"` arm. It
does receiver/form handling, but after validation leaves `recvLocal` on the
stack unchanged (or directly returns `emitReceiver()` for no argument). There
is no `__str_normalize` helper, no normalization-table module, and no
normalization data generator. This exactly explains all three remaining
return-value rows:

- `return-normalized-string.js` requires canonical decomposition, canonical
  ordering, NFC composition, and compatibility behavior across all four forms;
- `return-normalized-string-from-coerced-form.js` reaches the same transform
  after `['NFC']`/object-form coercion; and
- `return-normalized-string-using-default-parameter.js` requires the omitted
  and explicit-`undefined` default of NFC.

The older Step-B wording is now partly historical: current
`src/codegen/string-proto-tostring.ts` includes `normalize` in
`NO_ARG_STRING_MEMBER_HELPER`, mapped to `__str_flatten`, so the reflective
path has the receiver preamble but still returns the identity and has no slot
to read its optional form. `STRING_PROTO_METHOD_PARAM_SLOTS` in
`src/codegen/array-object-proto.ts` likewise has no `normalize` entry. A real
implementation must replace that no-argument shortcut rather than reuse it.
Also, the direct static-invalid-form shortcut currently throws before
`emitReceiver()`. The replacement must materialize/evaluate the receiver
first for every form spelling, then decide the form, preserving #1823 rather
than retaining that shortcut.

**Ownership and boundary.** This is a native-string/codegen task, not an IR
or carrier-layout task. A targeted implementation owns
`src/codegen/string-ops.ts`; a new lazy
`src/codegen/normalize-native.ts`; generated
`src/codegen/normalize-tables.ts`; and a new
`scripts/gen-normalize-tables.mjs`. The reflective optional-form glue needs a
narrow `array-object-proto.ts` dispatch/slot change and either a dedicated
`string-proto-normalize.ts` body or an equivalently isolated helper; it must
remove only the `normalize: "__str_flatten"` no-argument mapping from
`string-proto-tostring.ts`. No `src/ir/**` normalization opcode, frontend
lowering, object runtime, carrier bag, provenance, or layout change was found
or is needed. The native builder must use the existing append-only
`mintDefinedFunc`/`pushDefinedFunc`, late-import settlement, and
`nativeStrHelpers` index-shift discipline; it must add no host import.

**Pinned data contract, not sampled host ICU.** Follow the repository's
existing Unicode-17 contract in
`scripts/generate-regexp-string-properties.mjs`; do not silently move to
Unicode 18. The normalization generator should use versioned Unicode 17.0.0
UCD URLs, record a SHA-256 for every consumed source in both the generator's
expected-input manifest and the generated header, and reject a version/hash
mismatch. Required inputs are:

1. `UnicodeData.txt` for decomposition mappings and Canonical_Combining_Class;
2. `DerivedNormalizationProps.txt` for
   `Full_Composition_Exclusion=Yes`; and
3. `NormalizationTest.txt` as the pinned conformance corpus.

`CompositionExclusions.txt` alone is not enough: UAX #15 identifies
singletons and non-starter decompositions as exclusions too, while the full
derived property is the complete machine-readable set. The generator must
parse a tagged decomposition as compatibility-only and an untagged mapping as
canonical, recursively pre-expand canonical and compatibility mappings into
separate compact tables, omit surrogate code points, compress nonzero CCC
values, safely validate/expand `First`/`Last` UCD ranges rather than silently
discarding a range record, and build a sorted pairwise composition index from
canonical pairs only when the composite is not
`Full_Composition_Exclusion`. Algorithmic Hangul must remain code, not an
incomplete table. This is the
[UAX #15](https://www.unicode.org/reports/tr15/) model: full decomposition,
canonical ordering, then canonical composition for C forms; its conformance
clause requires `NormalizationTest.txt`.

**Native helper design.** `ensureStrNormalize(ctx)` should be demand-driven
from the direct and reflective call sites, after `ensureNativeStringHelpers`,
so modules that merely use another string method do not retain the Unicode
tables. It should install `__str_normalize(s, formMode) -> ref $AnyString` and
immutable generated-table globals via `array.new_fixed`, as the case-mapping
helper does. A correct first implementation is intentionally table-driven,
without an unsafe quick-check fast path:

1. Flatten the WTF-16 `NativeString`, decode valid surrogate pairs to scalar
   values, and preserve each unpaired surrogate unchanged as a CCC-0 barrier.
2. Append the selected pre-expanded canonical (NFD/NFC) or compatibility
   (NFKD/NFKC) decomposition to a growable mutable i32 scalar buffer. Handle
   Hangul syllable decomposition algorithmically.
3. Perform stable canonical ordering within each starter-delimited run using
   the CCC table. The buffer must grow geometrically with `array.new_default`
   plus `array.copy`, following the existing string/vec builders; no fixed
   maximum expansion or bounded combining-mark stack is sound.
4. For NFC/NFKC, run UAX #15 canonical composition with its blocking rule,
   the generated pair index and algorithmic Hangul L/V/T composition. NFD and
   NFKD stop after ordering.
5. Compute the exact UTF-16 output length, allocate the native i16 backing
   array once, encode scalars (including preserved unpaired units), and return
   a new flat native string. The output must not be an alias/identity shortcut
   merely because the input happens to contain non-ASCII text.

The shared call-site form routine should produce a small mode enum only after
the receiver is evaluated. It must default only absent or `undefined` form to
NFC (including the standalone undefined singleton), coerce every other form
once with the existing ToString/Symbol path, reject `null` as the string
`"null"`, and throw the existing RangeError for values outside the four exact
names. The reflective body needs one physical optional argument slot while
leaving `.length === 0`; it must use the same routine and helper after
RequireObjectCoercible/ToString(this), rather than make a separate identity
path.

**Validation required before a future implementation claim.** In addition to
the frozen 14 Test262 rows (all 11 current passes retained and all three
original failures green), add a focused native test that checks all four forms,
default/explicit undefined, coercion and Symbol/RangeError/evaluation-order
semantics, canonical ordering and blocking, composition exclusions (including
U+0344/U+0958/U+2126), compatibility mappings, Hangul, astral pairs, and
unpaired-surrogate preservation. It must assert a standalone module has no
imports. Vendor or generate a hash-pinned Unicode-17
`NormalizationTest.txt` fixture and execute every official row through the
compiled native helper in bounded chunks; this is a positive conformance gate,
not a host-ICU comparison or a three-example fixture. Keep js-host behavior
unchanged and record any size/ratchet budget for generated data explicitly.

This plan rejects both a three-character patch and an unpinned
`String.prototype.normalize()`-as-generator oracle. The separate #1541
ICU4X/opt-in side-module idea remains an alternative product decision, not a
substitute for the default standalone Unicode-17 conformance implementation
described here.

1. Rewrite the `normalize` arm in `src/codegen/string-ops.ts` L3563-3598:
   receiver first (keep the #1823 ordering), then if a form arg is present and
   not a statically-valid literal: coerce via `emitArgAsNativeString`
   (string-ops.ts L463 — its Symbol guard covers
   `return-abrupt-from-form-as-symbol.js`, its walker propagates the abrupt
   `toString` of `return-abrupt-from-form.js`), then a runtime 4-way string
   compare (NFC/NFD/NFKC/NFKD) → `RangeError` via the same
   `buildThrowJsErrorInstrs` used elsewhere (`form-is-not-valid-throws.js`;
   note `['NFC']` coerces to `"NFC"` and is VALID —
   `return-normalized-string-from-coerced-form.js`).
2. Reflective arm: add a `normalize` member body in
   `src/codegen/array-object-proto.ts` (the String glue dispatcher, ~L1000-1100)
   that runs `emitStringRequireObjectCoercible` (L937) + `ToString(this)`
   (Symbol receiver → TypeError — `return-abrupt-from-this-as-symbol.js`) +
   the same form validation. Mimic `emitStringSearchNumericMemberBody`
   (L1270+) for the closure ABI. Covers the four `this-*`/`return-abrupt-from-this*` tests.
3. Actual normalization (3 `return-normalized-string*` tests) — the largest
   sub-step, land LAST and defer to a wave 2 if it does not fit. The 2026-09-20
   audit above supersedes this item's earlier Node-ICU/probe sketch: use pinned
   Unicode-17 UCD data, full decomposition/CCC/composition-exclusion semantics,
   Hangul code, and the official `NormalizationTest.txt` corpus rather than
   sampled host normalization. Implement it through
   `scripts/gen-normalize-tables.mjs`, generated `normalize-tables.ts`, and
   `__str_normalize` in `src/codegen/normalize-native.ts`, with immutable
   module globals via `array.new_fixed`.

### Step C — `String.prototype[Symbol.iterator]` (5 tests, unblocks A.4)

1. Add `"@@1"` to the String glue member CSV in
   `src/codegen/array-object-proto.ts` (Array's glue already carries `"@@1"`
   at L111 as a `values` alias — same sentinel format; RegExp's `@@7`-`@@10`
   at regexp-standalone.ts L5149 show the multi-symbol form). Member kind:
   method, `length` 0, name `"[Symbol.iterator]"`, non-constructor (the
   native-proto closure factory's default — `not-a-constructor.js`),
   prop-desc writable+configurable, non-enumerable.
2. Member body: `RequireObjectCoercible` + `ToString(this)` (abrupt for a
   poisoned-toString receiver — `this-val-to-str-err.js`), then return the
   string iterator. Reuse the #3146 string-subject normalization
   (`ensureStrToCharVecHelper` + the per-code-point iteration
   `src/codegen/iterator-native.ts` L1392 already uses for dynamic
   GetIterator over strings) so `[Symbol.iterator]().next()` agrees with
   for-of.
3. Fix the reflective read: probe `q5-iter-indirect.js` currently produces
   INVALID WASM ("expected i32, got externref" in `__module_init`) when
   `String.prototype[Symbol.iterator]` is stored to a variable — the
   `<Builtin>.prototype[Symbol.X]` element-access read in
   `src/codegen/property-access-dispatch.ts` must route through the glue's
   member-closure factory (i32 well-known-symbol id vs externref key
   confusion). This same fix makes `RegExp.prototype[Symbol.search]` readable
   (Step A.4). Regression-check `Array.prototype[Symbol.iterator]` reads.

### Step D — ToPrimitive sub-steps in string-method arg coercion (5 tests)

1. Literal `[Symbol.toPrimitive]`: make an object literal carrying a computed
   well-known-symbol key compile to the OPEN `$Object` representation (or
   teach the closed-struct coercion path to probe the `@@toPrimitive` field)
   so the #5102 probe in `src/codegen/object-runtime.ts` (L4793-5012, keyed
   `__box_symbol(3)`) finds it. Literal lowering: `src/codegen/literals.ts`.
   Verify with probes `q1-wrapped-literal-toprim.js` (ToString hint) — the
   number-hint twin is the first assertion of
   `indexOf/position-tointeger-toprimitive.js`.
2. Symbol rejection in the runtime walkers: add a `$Symbol`-carrier arm that
   throws TypeError to (a) the ToNumber walk used by
   `coerceType(…, f64, "number")` for externref operands, and (b) a
   throw-on-Symbol variant of `__extern_toString` for METHOD-ARG coercion
   (`ensureObjectRuntime`, object-runtime.ts; carrier type from
   `ensureSymbolCarrier`, `src/codegen/symbol-native.ts` L66). Do NOT change
   `String(sym)` — §22.1.1.1 allows it; only the implicit §7.1.17 ToString and
   §7.1.3 ToNumber paths throw. This also covers the `Object(Symbol())`
   wrapper unbox (the `WRAPPER_PRIMITIVE_KEY` read in `__to_primitive`
   returns the carrier; the walker must then reject it — probe
   `q4-boxed-symbol-throws.js`) and feeds Steps F and I.

### Step E — astral case mapping (4 tests)

1. `scripts/gen-case-tables.mjs`: extend `simplePairs` to scan
   `0x10000..0x10FFFF` into separate `ASTRAL_UPPER_CASE_RUNS`/
   `ASTRAL_LOWER_CASE_RUNS` (all astral mappings are simple 1:1 and stay
   astral, so UTF-16 length never changes — assert that in the generator).
   Regenerate `src/codegen/case-tables.ts` and commit.
2. `src/codegen/case-convert-native.ts`: in the full (non-ASCII) path, on a
   high surrogate followed by a low surrogate, decode the code point, look up
   the astral runs via the existing `__case_simple` binary search, re-encode
   the mapped pair. Pass-1 length counting is unaffected (pairs contribute 2
   before and after). `toLocale{Lower,Upper}Case` route to the same helpers
   (string-ops.ts L3273) so all 4 tests move together.

### 2026-09-19 Step F read-only revalidation plan

The pinned oracle-14 standalone baseline at baselines commit
`6c51eb29ef12208ac8f53ae99eea900b53f51a76` still fails all three Step F
originals: `template-length-throws`, `returns-abrupt-from-next-key`, and
`nextkey-is-symbol-throws`. Current source is upstream
`4a6cbdf1ee80b5d1618a7c87b014bc792f0fddc7`.

Before implementation, audit the current template handoff to `__str_raw` and
identify the narrowest identity-preserving representation already supported
by ordinary reads. Do not repeat the historical diagnosis as current proof.
Read exact originals and trace descriptor lookup, segment coercion, and their
error order. Produce a bounded source-level correction plan with required
before/after controls, or identify an exact shared-owner dependency.

The parent issue is reserved without a live owner. Open #5748 changes Boolean
result annotations in `call-builtin-static.ts`; #5736 removes its old generator
prototype special case. Their inspected hunks do not change `String.raw`,
but both must be preserved. Generic literals, closure/class representation,
and runtime lifetime/layout owners remain reserved by the IR task. This
assignment is read-only: no production edits, test execution, claim takeover,
or publication until source ownership and the implementation plan are agreed.

### 2026-09-19 Step F audit outcome and corrected implementation boundary

Read-only Terra audit at `4a6cbdf1ee80` revises the historical diagnosis below:
the outer template materialization preserves the original nested `raw` struct
reference. Do not patch that materializer or introduce a raw-copy workaround.
`string-raw.ts` already performs raw/length/index reads in the right order and
contains a Symbol TypeError guard. The shared dynamic readers lose the values
before that guard can act.

The runtime `Object.defineProperty` path stores closed-struct descriptors in an
identity-keyed carrier bag (`user-declared-structs.ts`, `carrier-bag-define.ts`).
The later emitted-code audit below found that the statically typed accessor
path bypasses this runtime storage; the initial audit did not distinguish it.
In `object-runtime.ts`, `fillExternArrayLikeStructArms` instead reads physical
length/numeric fields: missing physical length returns zero without consulting
the bag; accessor-only numeric entries are missed. Both its index boxer and
`fillClosedStructExternGetArms` number-box non-boolean i32 fields, including
symbol-branded fields. The named reader also puts physical field arms before
the bag arm, so switching callers to it alone leaves descriptor precedence
wrong. These are source-level findings, not a new compiler run; confirm the
original Symbol field's emitted brand in permitted IR evidence before repair.

Revised implementation plan, pending shared-owner agreement:

1. In `fillClosedStructExternGetArms`, make present carrier-bag descriptors
   override physical closed fields and box symbol-branded i32 through the
   existing `__box_symbol` path. Preserve boolean/number distinctions.
2. In `fillExternArrayLikeStructArms`, route closed-struct length and index
   reads through ordinary property semantics before ToLength/coercion,
   preserving getter exceptions and Symbol identity. Reuse the existing
   Get/ToLength construction in `object-runtime-enumeration.ts` as appropriate;
   coordinate that file if edits prove necessary. Audit `__extern_has_idx`
   consistency rather than accidentally making descriptor visibility differ.
3. Prove the three exact originals plus the existing `tests/issue-3147.test.ts`
   and `issue-4397-native-semantic-js-host.test.ts` controls in both lanes.
   Add a getter redefining an existing physical `length`/`"0"` field so a
   bag-only fix cannot hide incorrect precedence. Retain abrupt ordering,
   deletion/reassignment/redefinition, nullish/empty-length, substitution, and
   zero-host-import controls.

No production edits, compiler runs, claims, or commits were made by the audit.
The coordinator has requested the exact reader/enumeration ownership from the
IR task before dispatch. The historical Step F materialization remedy below
is superseded for these three originals by this audit, not silently adopted.

Dispatch release: the IR owner explicitly cleared the two reader functions
and `object-runtime-enumeration.ts`, including checks against retained and
unpublished IR trees. Preserve adjacent #5753 tuple-reader import/splice and
unpublished wrapper-allocation ownership. Complete open-PR hunk locations also
show #5784 changes wrapper/enumeration-sort/vector/hole/for-in functions and
#5397 changes Reflect.set/set-vector functions, not these two reader owners.
The atomic upstream claim `5152:closed-struct-raw-readers` is verified for
`ttraenkler/codex-5152-raw-readers`, branch
`codex/5152-string-raw-audit-20260919`. The Terra auditor now implements in its
own existing worktree. Compiler/test execution waits for the RegExp lane's
lease handoff; preserve an untouched-base red run before candidate green.
Independent peer review and full scoped gates remain required before a PR.

The fixed acceptance manifest is
`plan/agent-context/5152-string-raw-es2015-paths-20260919.txt`: exactly 30
unique ES2015 String.raw paths in the pinned oracle-14 baseline, all verified
present in corpus `b363f29d3c43c626dc852744ad64a0b48a003693`. Baseline statuses
are **27 pass / 3 fail**. SHA-256:
`d7d2c223fb766dcc9ed460d3c2ddad520195dfc007db6d3c4f575575ba3e3827`.
Paths are relative to `test262/test` (no `test/` prefix), as required by
`run-test262-paths.mts`. The initial baseline-style prefix was corrected
before execution, without changing the selected tests.
Use this unchanged in fresh isolated standalone and host acceptance runs after
the focused controls; original successes must not regress. Corpus preparation
does not constitute a test execution or candidate pass claim.
The helper's terminal exit code alone is insufficient: inspect all 30 row
verdicts and require no skipped/missing/error rows, because it reports counts
without setting a failing exit code for non-pass rows. Use `--isolate` in both
lanes to prevent shared-intrinsic contamination.

Portable fixture peer review confirmed the zero-import assertion and physical
field/accessor collision shapes. Before the first red run, replace catch-any
success counters with exact per-getter Error sentinel identity; retain the
length-order marker and require replacement-key coercion before the second
index getter (`"01"`) in the delete/reassign/redefine case. Add full compiled-host
matrix parity, not just the native-first positive smoke. A Symbol error
must be a TypeError, but its message must not be standardized by the test.
RegExp explicitly released the compiler lease with no live process; this lane
now has permission for the focused untouched-base red run and initial repair
checkpoint. No result from that run is claimed yet.

Subsequent writer-reported untouched-source result: standalone returns
**454 / expected 2047** in the tightened portable matrix. Present bits are
2, 4, 64, 128, and 256; missing bits cover descriptor-only length, physical
field overrides, getter receiver identity, present-undefined precedence, and
Symbol rejection. Production diff was empty for this run. The full compiled-host
matrix instead hits the delete/reassignment sidecar error before its
final assertions. Preserve that failing sequence; separately named portable
host subsets must not be presented as full-matrix parity.

Independent coordinator reconciliation of the same 30 originals against the
host JSONL at pinned baseline `6c51eb29ef12208ac8f53ae99eea900b53f51a76`
finds **28 pass / 2 fail**, oracle 14, `linked-harness`, 30 unique rows.
`template-length-throws.js` reports no expected exception;
`returns-abrupt-from-next-key.js` reports the strict-rerun getter-only
reassignment failure seen in the portable control. The Symbol original
passes host. These are existing host nonpasses, not candidate regressions or
authorization to edit the host sidecar in this bounded reader repair.

First candidate checkpoint is still red: writer reports standalone mask
**998 / expected 2047**, versus untouched-base 454. The added passing bits
are Symbol rejection (32) and original getter receiver (512), not a Test262
pass-rate claim. Descriptor-only length, physical-field descriptor precedence,
and present-undefined controls still fail. The writer is inspecting emitted
dispatch/type admission before further changes, within the same reader scope;
no broad run or original-row gain is claimed. Exact terminal/log metadata is
requested for the durable implementation record.

Review guard for the next candidate: its proposed `classAccessorSet` /
`staticAccessorByField` fallback must not treat compile-time registration as
runtime descriptor presence. Before accepting it, prove reads before a
definition, untaken definition branches, and another same-shape instance retain
their actual properties. Shape stamps are sufficient only if emitted runtime
transitions prove that distinction. The writer is holding that fallback while
the independent peer checks the exact registration/storage seam; if a missing
per-instance definition route is the cause, coordinate that source owner
rather than broadening static metadata into descriptor truth. This is an
open review concern, not a verified passing implementation.

The subsequent independent audit confirms that concern. In
`compileObjectDefineProperty`, the static accessor path adds
`ctx.classAccessorSet` while generating code, synthesizes accessor functions,
then returns the receiver without invoking the runtime define helper or writing
a per-instance descriptor presence record. S5C's optional closure global is
per shape/key, not per receiver, and later definitions overwrite it. `$shape`
is an immutable layout-collision discriminator, not a runtime mutation stamp.
Neither can safely prove descriptor presence before definition, in an untaken
branch, or on another same-shape object. The writer removed the unproven
fallback entirely, leaving the bag/ordinary-reader and Symbol changes.

This revises the initial reader-only diagnosis for the remaining accessor
controls: they require an identity-keyed runtime definition record at the
successful define site, then ordinary reads of that record. Coordinate the
exact `object-ops.ts` static-accessor seam before any expansion; the RegExp
writer owns a separate intrinsic-specific route in that file, and closure/
carrier allocation remains reserved by IR. Temporal/per-instance controls
and the exact three original standalone rows are the next bounded evidence;
no widening or new original gain is claimed before those results.

Expanded safe-candidate portable run (Node 24), inspected coordinator log
`/private/tmp/js2-5152-raw-readers-standalone-candidate-20260919.log`:
one selected standalone test failed; two host controls were unselected by the
filter (reported skipped), not run. Writer reports terminal exit 1. The mask
is **130022 / expected 131071**, missing exactly bits 1, 8, 16, and 1024:
descriptor-only length, the two physical-field overrides, and present
undefined. New temporal/per-instance controls pass, but emitted routing may
select already bag-backed cases; this does not refute the confirmed static
definition-site gap or justify reinstating static metadata dispatch.
### Published reader checkpoint evidence retained from PR #5991

The following publication record is retained alongside the earlier diagnostic
history above. PR #5991 is now merged into upstream `main` at `d5e58586d1`;
the remaining deletion follow-up is not part of that landed reader fix.

Use this unchanged in fresh isolated standalone and host acceptance runs after
the focused controls; original successes must not regress. Corpus preparation
does not constitute a test execution or candidate pass claim.

### 2026-09-19 closed-struct raw-reader implementation evidence and remaining owner seam

The reader slice now makes the ordinary-read boundary explicit, but it is not
yet a complete fix for every statically lowered `Object.defineProperty`
accessor. The implemented reader-side changes are deliberately bounded to the
cleared ownership:

1. `fillClosedStructExternGetArms` checks a user-instance carrier bag by
   *presence* before any physical field arm, then uses
   `__reflect_get_receiver(bag, key, originalReceiver)`. This preserves
   descriptor precedence, makes a present `undefined` distinguishable from a
   miss, and gives a getter its original raw object as `this`.
2. `fillExternArrayLikeStructArms` sends user-declared closed structs through
   ordinary `__extern_get` / `number_toString` / `__extern_has` for length,
   indexed Get, and indexed Has. Its common `ToLength` tail lives in
   `object-runtime-enumeration.ts`, so the old `$Object` arm and the new closed
   receiver arm share coercion and clamping exactly.
3. Closed i32 values branded as Symbol are boxed through `__box_symbol`, not
   `__box_number`, before `String.raw` performs its existing ToString guard.

The focused fixture `tests/issue-5152-raw-readers.test.ts` adds exact-sentinel
controls for getter abrupt completion and order, physical-field overrides,
receiver identity, present-`undefined`, and static-metadata safety:
pre-definition, untaken/taken branch, and two same-shape instances. On the
safe bag-backed candidate the latter six temporal/per-instance controls pass;
the complete standalone result is `130022 / 131071`, with exactly bits
`1 + 8 + 16 + 1024` still absent. This is useful negative evidence: the reader
correctly handles descriptors that reach the bag, but does not fabricate a
descriptor from static metadata.

The exact remaining source dependency is the static accessor branch in
`src/codegen/object-ops.ts` (current lines 1760-2096). It executes
`ctx.classAccessorSet.add(accessorKey)` at lines 1777-1778, where `accessorKey`
is the compile-time `${structName}_${propName}` name,
synthesizes a bare `${structName}_get/set_${propName}` function, and returns
the receiver without an identity-keyed descriptor/bag write. `classAccessorSet`
is a compile-time `Set` created in `src/codegen/context/create-context.ts`, and
the optional S5C globals are keyed only by `(structName, propName)`; neither is
runtime proof that this object was defined, that a branch was taken, or that a
same-shape peer object owns the descriptor. `$shape` is immutable layout
identity, not a definition epoch. A reader fallback based on any of those
metadata carriers is therefore unsound and was intentionally removed.

The required shared-owner repair is narrow: on a *successful runtime*
definition through that static accessor branch, populate the existing
per-receiver descriptor/bag substrate observed by `__carrier_bag_has` /
`__carrier_bag_of`; do not copy the raw object or turn struct/key metadata into
descriptor truth. The existing runtime accessor applier path in
`emitExternDefinePropertyNoValue` (`object-ops.ts` from line 3019) and
`carrier-bag-define.ts` is the relevant established mechanism. Its owner must
preserve one-time receiver/key/descriptor evaluation, descriptor transition
validation, and direct static-access behavior while making the successful
definition observable to dynamic reads. This plan slice does not edit
`object-ops.ts`, runtime sidecars, or storage machinery.

### 2026-09-20 authorized static-accessor mirror plan

The reader-only boundary above is now extended by a single coordinated source
slice in `src/codegen/object-ops.ts`, limited to the standalone `__anon_*`
static-inline accessor branch (the branch that currently starts near line
1760). Before emitting the receiver body, call `ensureObjectRuntime`, reserve
the existing `__defineProperty_accessor` target, and flush late-import shifts.
Retain the already evaluated `objLocal`; materialize the literal key and each
getter/setter closure exactly once into externref locals. Call the existing
accessor applier with that saved receiver, key, closures, and the established
accessor flag encoding (including Get/Set-present bits 8/9); on its successful
result, drop the applier result and then publish those *same* closure locals to
the legacy per-struct globals.

This preserves receiver/key/closure single evaluation and lets the existing
carrier-bag define arm establish per-instance runtime presence. It must not
call `emitExternDefinePropertyNoValue`, because that helper recompiles those
operands. It does not add a carrier, sidecar, closure ABI, `String.raw`, or
reader fallback. The mirror's runtime branch is explicitly standalone-only;
the measured JS-host descriptor snapshot remains 66528, but no byte-for-byte
host-output comparison is claimed. Direct typed
property reads still rely on pre-existing compile-time
`classAccessorSet`/per-shape globals and are explicitly out of this slice's
lifecycle guarantee; only dynamic reads such as `String.raw` are claimed.

Fresh Node 24, standalone, isolated original-row evidence on the safe reader
candidate (all artifacts have an empty Wasm import list):

- `built-ins/String/raw/nextkey-is-symbol-throws.js` — **pass**.
- `built-ins/String/raw/template-length-throws.js` — **fail**: expected the
  Test262Error accessor throw, but no exception occurred.
- `built-ins/String/raw/returns-abrupt-from-next-key.js` — **fail** on the
  strict rerun: `TypeError: Cannot assign to read only property`.

The isolated runner output is retained at
`/private/tmp/js2-5152-raw-three-standalone-candidate-20260919.log`; the
primary/strict compiler import audit is retained at
`/private/tmp/js2-5152-raw-three-imports-20260919.log` and reports `imports: []`
for all four emitted variants. This is a real Symbol original-row gain only,
not a three-row or 30-path pass-rate claim. The known compiled-host baseline
remains 28 pass / 2 non-pass across the 30-path manifest; it was not rewritten
or represented as parity by this reader slice.

Same-base safeguard: a fresh Node 24 one-row `runTest262File` execution using
the untouched `4a6cbdf1` coordinator compiler source returns **fail** for
`nextkey-is-symbol-throws.js` (the expected TypeError is not thrown), with
`success: true`, `imports: []`, and one diagnostic. The coordinator worktree
has no populated corpus checkout, so the temporary audit launcher remapped only
its `test262/` *readFileSync* corpus reads to the pinned shared corpus; compiler
and test-runner modules themselves remained the untouched coordinator source.
This is a fresh authoritative one-row runner invocation, not a claim that a
literal maintained `--isolate` command was run from that unpopulated checkout.
The exact diagnostic is a **warning**:
`IR path failed for $DONOTEVALUATE: function typeIdx parity mismatch: IR=132,
legacy=50 — keeping legacy body [IR-FALLBACK]`. The current candidate's exact
Symbol assembly likewise reports `success: true`, `imports: []`, and the same
single warning. Therefore the evidence establishes a same-base Symbol verdict
delta but makes no diagnostics-clean claim. Durable logs are
`/private/tmp/js2-5152-raw-symbol-baseline-4a6-20260920.log` and
`/private/tmp/js2-5152-raw-symbol-candidate-errors-20260920.log`.

### 2026-09-20 frozen reader/mirror checkpoint, validation boundary, and residual

The source candidate is now deliberately frozen outside gate-fixes. It has four
cooperating, standalone-only pieces:

1. `fillClosedStructExternGetArms` consults a live carrier-bag descriptor by
   presence before a physical field, calls `__reflect_get_receiver` with the
   original receiver, and boxes a symbol-branded i32 with `__box_symbol`.
2. `fillExternArrayLikeStructArms` routes admitted user shapes' length/index/
   has-index operations through ordinary `__extern_get`, `number_toString`, and
   `__extern_has`; `buildArrayLikeToLengthFromExternref` is the common ToLength
   tail shared with the `$Object` arm.
3. The static inline accessor path mirrors only a successful standalone
   `__anon_*` definition into the existing identity bag. It evaluates receiver,
   key, and closures once; rejects an unliftable supplied getter/setter rather
   than storing null; applies `__defineProperty_accessor`; and only then
   publishes the legacy globals. No raw-object copy, static metadata fallback,
   carrier allocation, or JS-host change is involved.
4. The ordinary array-like routing is gated by `ctx.standalone`. This restores
   native-first's pre-existing physical-reader boundary: an initial ungated
   candidate returned `""` for the native-first `String.raw({raw:{length:2,
   0:"a",1:"b"}}, "X")` control; the corrected route returns `"aXb"`.

Measured candidate evidence (Node 24, fresh isolated standalone runs) is:

- exact three originals: **2 pass / 1 fail** — `template-length-throws` and
  `nextkey-is-symbol-throws` pass; only the delete/reassignment half of
  `returns-abrupt-from-next-key` fails;
  `/private/tmp/js2-5152-raw-three-final-20260920.log`.
- immutable 30-path manifest: **29 pass / 1 fail / 0 skip**, with that same
  one original remaining;
  `/private/tmp/js2-5152-string-raw-30-final-20260920.log`.
- the standalone fixture's complete ordinary-reader mask is **131071**, and
  all generated artifacts in this lane have `imports: []`.
- the direct Node oracle also returns **131071**. The untouched-`4a6` A/B
  launcher records the historical standalone mask **129478**, direct Node
  **131071**, host full-source strict-setter throw, host delete-excluded mask
  **66528**, and native-first `"aXb"` at
  `/private/tmp/js2-5152-reader-fixture-base-20260920.log`.

The fixture's JS-host case is intentionally a **baseline snapshot**, not a
positive compatibility or parity claim. For the source with the known
delete/reassignment sequence excluded, untouched `4a6` produces **66528**;
the asserted missing descriptor bits are
`1/2/8/16/1024/2048/4096/8192/16384/32768`. The full host source still throws
the pre-existing strict setter error. The focused run after the native-first
gate was 4/5 solely because this case still expected the standalone mask;
`tests/issue-5152-raw-readers.test.ts` now asserts the documented 66528
baseline. Its final direct run is **5/5** at
`/private/tmp/js2-5152-raw-readers-vitest-after-coercion-local-20260920.log`.
It must never be reported as full host parity.

The final direct TS7 invocation against the shared installed dependencies
passed: `/private/tmp/js2-5152-typecheck-ts7-final-20260920.log`.
The package script itself cannot resolve this isolated worktree's absent local
`node_modules`; that is a worktree provisioning limitation, not a TS result.

#### Remaining original: anonymous bag deletion, not a reader regression

The last standalone original is a shared delete/set residual. A targeted
diagnostic gives compiled standalone **43** versus direct Node **51**:
the first accessor throw and `delete` result are observed, but the subsequent
assignment is refused. The durable helper map is
`/private/tmp/js2-5152-delete-lifecycle-helper-map-v2-20260920.log`.

Source/WAT attribution is exact:

- `typeof-delete.ts` sends `delete obj.raw["0"]` to `__delete_property`.
- `__carrier_bag_delete` is reached, but its finalizer currently has closure,
  generator, vec, and Error lookup arms only. It has no anonymous-instance
  arm, returns `-1`, and `__delete_property` takes its historical non-object
  `return 1` fallback without removing the bag accessor.
- The later strict assignment follows `assignment.ts` →
  `__extern_set_strict` → `__reflect_set` → `__extern_set`; the still-live
  getter-only bag entry produces the shared refusal result and the observed
  TypeError. `object-runtime-strict-set.ts` is only the correct consumer of
  that refusal and is not an edit target.

No deletion code is included in this reader/mirror checkpoint. A separately
owned true-expando follow-up may need `carrier-bag-delete.ts` **and an
explicitly coordinated provenance-registry/API seam**; neither file set nor
implementation is authorized by this checkpoint. Its source-reviewed plan is:

1. Publish this frozen reader/mirror repair first. Then authenticate actual
   anonymous-*literal* provenance; neither the `__anon_` naming convention nor
   a structural type/shape match is proof that a receiver is eligible. The
   existing `object-literal-carrier.ts` AST-to-carrier private `WeakMap`,
   strict-method allocation recorder, and insertion-order map are not a
   complete enumerable finalizer registry (the latter two omit property-only
   or empty literals). They must not be silently substituted for that proof or
   widened without coordinated ownership.
2. Only after an authenticated registry design exists, enumerate its concrete
   allocated candidates at FINALIZE and match both Wasm type and logical
   collision stamp through `buildShapeGuardedArm`; type-only matching is
   insufficient for canonicalized shapes. The existing pipeline stamps shapes
   before `fillCarrierBagDelete`, but a candidate list alone remains
   insufficient admission evidence.
3. Look up, never ensure, the receiver's existing closure bag. Retain the
   current `-1/0/1` not-handled/refused/deleted protocol and delegate a
   successful admission to existing `__delete_property`, rather than copying
   configurable/count logic or widening `IS_INSTANCE_EXPANDO_CARRIER`.
4. Before delegation, compare the normalized stored own-entry key after
   `__obj_find` against the receiver's exposed physical fields using
   `exposedClosedStructFieldName`; do not re-coerce a user-observable key or
   use value-undefined as absence. `isInternalStructFieldName` metadata must
   preserve legal `$`/`__` user keys. A physical collision deliberately remains
   unhandled: deleting its overlay could resurrect stale physical data.
5. Preserve #5753's class arm, arm order, retained-marker authentication/count
   repair, builtin function metadata precedence, and generator/vec/Error
   routes. That arm replaces `fn.locals` with its own bag plus locals 3/4/5,
   so any anonymous scratch locals must be appended after that actual
   replacement. Do not mint late helpers/types/imports or share instruction
   trees across arms; prove the no-class/no-closure/no-vec/no-Error demand case
   still reserves the helper when an authenticated anonymous candidate exists.
6. Required follow-up controls include the exact configurable-accessor
   delete/reassign original; accessor and data true expandos; non-configurable
   sloppy false and strict TypeError; repeat delete; missing bag; independent
   same-shaped objects; physical-override non-resurrection; class retained
   marker; function name/length and generator routes; accessor non-invocation;
   and Symbol-versus-string keys. Compare against untouched base with the same
   runner, then rerun all 30 String.raw originals.

The verified IR task confirms no active anonymous-expando writer or pending
fix to await. This is a handoff specification, not runtime proof or deletion
implementation approval; `object-runtime.ts`, `typeof-delete.ts`,
`object-runtime-strict-set.ts`, class tombstones, and the generic instance
classifier remain out of the follow-up until an authenticated registry design
is independently owned and reviewed.

#### Required gates before publishing this reader/mirror checkpoint

When the compiler/test lease is next granted, run (and retain terminal logs
for) the following against this frozen source before any commit or PR:

1. `git diff --check`; the five-case focused fixture (including direct Node,
   standalone no-import, host baseline snapshot, and native-first control);
   then the exact isolated three rows and frozen 30-path standalone manifest.
2. Existing narrow reader regressions `tests/issue-3147.test.ts` and
   `tests/issue-4397-native-semantic-js-host.test.ts`, plus a fresh TS7
   invocation resolved from this worktree's canonical dependency source.
3. Normal quality gates: format check, lint, LOC/function budgets (adding only
   a gate-proven function allowance if required), coercion-site/oracle/dead-
   export ratchets, and the normal hooks. Do not bypass hooks or modify shared
   baseline files.
4. Independent peer review after the final diff and before publication. The PR
   describes **two original improvements and 29/30 standalone manifest rows**,
   not whole-#5152 completion; it remains draft if any required gate or
   mergeability condition is unresolved.

#### Terminal reader/mirror gate record (2026-09-20)

All commands below used the worktree's direct installed Node 24/tool binaries
where applicable; the normal commit/push hooks remain to be run without a
bypass after the temporary RegExp lease handback.

- Full Git-LFS-aware `git diff --check` passed. The focused fixture passed
  **5/5** both directly and through the normal changed-root runner (one changed
  root file). The final focused log is
  `/private/tmp/js2-5152-raw-readers-vitest-after-coercion-local-20260920.log`.
- The isolated three-original runner settled **2 pass / 1 fail** and the frozen
  manifest settled **29 pass / 1 fail / 0 skip**, both with only the documented
  delete/reassign residual. Logs are
  `/private/tmp/js2-5152-raw-three-final-20260920.log` and
  `/private/tmp/js2-5152-string-raw-30-final-20260920.log`.
- The narrow #3147 regression file passed. #4397's URI escape assertion fails
  identically on candidate and untouched `4a6`, so it is preserved as a
  baseline failure, not attributed to this change; logs are
  `/private/tmp/js2-5152-native-reader-regressions-20260920.log` and
  `/private/tmp/js2-5152-issue-4397-base-4a6-20260920.log`.
- TS7, Prettier, and Biome pass at
  `/private/tmp/js2-5152-typecheck-ts7-final-20260920.log` and
  `/private/tmp/js2-5152-format-lint-final-20260920.log`. LOC and function
  ratchets pass using only the measured allowances recorded in this issue;
  oracle and coercion ratchets pass, with `object-runtime.ts`'s one shared
  `number_toString` property-key call explicitly allowed.
- Dead-export preservation, codegen-fallback, stack-balance, host-import, and
  numeric-local checks pass. The dead-export tool retains its pre-existing
  strict modeled-closure unknowns for two nonliteral dynamic imports while its
  preservation contract passes; it is not claimed as retirement certification.

This is a **reader/mirror checkpoint**, not #5152 closure or full JS-host
parity. No deletion code, shared baseline update, skip-list change, or host
import is included.

### 2026-09-20 Array HOF subclass regression containment

The fresh full-corpus receipt found five non-ES2015 pass-to-fail rows after the
reader/mirror checkpoint. They are intentionally tracked here as a regression
follow-up, not folded into the prior String.raw gain claim. The frozen reduced
manifest is
`plan/agent-context/5152-array-subclass-regression-paths-20260920.txt`
(five unique pinned-corpus paths, SHA-256
`ab15801cdd5330ca442019ac142583e98fd22a46e56d537dd11cc4100397c0db`):

- `built-ins/Array/prototype/some/15.4.4.17-8-10.js`
- `built-ins/Array/prototype/forEach/15.4.4.18-8-10.js`
- `built-ins/Array/prototype/map/15.4.4.19-9-3.js`
- `built-ins/Array/prototype/filter/15.4.4.20-10-3.js`
- `built-ins/Array/prototype/every/15.4.4.16-8-10.js`

Fresh Node 24 isolated standalone runs through the runner's own
`runTest262File` establish the boundary before this follow-up makes a source
change: untouched `4a6cbdf1ee80b5d1618a7c87b014bc792f0fddc7` is **5 pass**
(`/private/tmp/js2-5152-array-hof-five-base-4a6-20260920.log`), while the
landed reader checkpoint at
`35e040c08ed10f793faf26bb0f0eac55be662627` is **5 fail**
(` /private/tmp/js2-5152-array-hof-five-candidate-35e-20260920.log`). Every
candidate failure is `illegal cast in __extern_has` through
`__extern_has_idx ← __hof_*`. The source range from the old baseline compiler
to the landed reader commit contains only the #5991 reader files and fixture,
which makes this a strong attribution; the explicit A/B above is the
authoritative proof.

The affected programs construct a raw function-constructor instance after
making its live `F.prototype` array-like. #5991 admitted every allocated
user-declared struct to the new ordinary array-like Get/Has route, then marked
that type seen before the legacy candidate collector reached
`fnctorArray.fnctorPrototypeGlobalForStruct`. As a result, the raw fnctor
entered `__extern_has` rather than its established own-index plus recursive
prototype route, where the generic helper attempts a `$Object` cast.

The narrow correction preserves the legacy candidate lane only when the
existing `fnctorPrototypeGlobalForStruct(ctx, structName)` provider returns a
live prototype global. It does not blacklist all `__fnctor_*` values or user
classes: descriptor-backed ordinary readers retain their #5991 admission for
all other eligible types. Required validation is the same frozen five-path
isolated command after the edit, followed by the frozen 30-path standalone
String.raw manifest to prove that the two landed original gains remain intact.
No anonymous-expando deletion source belongs in this follow-up.

Terminal follow-up evidence, again using Node 24 and the runner's isolated
mode, is **5 pass / 0 non-pass** after the guard at
`/private/tmp/js2-5152-array-hof-five-after-fnctor-proto-guard-20260920.log`.
The frozen standalone String.raw manifest then remains **29 pass / 1 fail** at
`/private/tmp/js2-5152-string-raw-30-after-fnctor-proto-guard-20260920.log`;
its sole non-pass is the pre-existing
`built-ins/String/raw/returns-abrupt-from-next-key.js` strict setter/delete
residual. This follow-up therefore restores the five unrelated Array rows
without trading away either landed String.raw improvement.

### Step F — String.raw fidelity (3 tests)

1. Descriptor loss: the template arg in
   `src/codegen/expressions/call-builtin-static.ts` L805-825 goes through
   `materializeStructAsDynamicObject`, which snapshots values — accessors
   later installed by `Object.defineProperty` on the (nested) `raw` object are
   invisible to the helper's `__extern_get` even though a DIRECT property
   read runs them (probes r1 pass / r2+q6 fail isolate this). Fix by keeping
   identity: when the template's value flows from a variable (not a fresh
   literal), pass the live representation the direct-read path consults
   instead of a copy (or materialize the literal ONCE at creation). Verify
   `__extern_length`'s array-like arm then propagates the throwing `length`
   getter (string-raw.ts header notes it is designed to).
2. `nextkey-is-symbol-throws.js` (Symbol-valued segment → TypeError) falls out
   of Step D.2's throwing `__extern_toString` variant — `__str_raw` already
   coerces segments through `__extern_toString` (string-raw.ts L26).

### Step G — runtime IsRegExp in includes/startsWith/endsWith (3 tests)

In the three arms (`src/codegen/string-ops.ts` L3037-3080), for a search arg
not statically proven string-like, emit before ToString: if the arg is an
object → `__extern_get(arg, __box_symbol(7))` (getter runs, abrupt
propagates); if the result is not undefined → ToBoolean → TypeError (reuse the
existing #2598 message); if undefined → `ref.test $NativeRegExp` → TypeError.
Same GetMethod-read shape as Step A.1.

### Step H — codePointAt undefined (2 tests)

`src/codegen/string-ops.ts` L3462-3560: replace the plain-NaN OOB result with
the dedicated undefined f64 sentinel (`undefSentinel: true` ValType +
`emitIsUndefF64`, the same machinery `compileStringIntegerArg` reads at
L2404/L2423-2431) so `=== undefined` / `??` observe undefined; js-host got
this in #2004 — mirror its result-kind decision for the standalone lowering.

### Step K — padStart/padEnd Symbol fill (2 tests)

`src/codegen/string-ops.ts` L3215-3217 and L3250-3252: replace the bare
`compileExpression + emitFlatten()` of the fill arg with
`emitArgAsNativeString` (L463) + flatten — its `tryThrowOnSymbolStringCoercion`
guard turns today's INVALID WASM (i32 symbol id pushed where
`(ref null $AnyString)` is expected) into the spec TypeError.

### Step I — fromCodePoint(Symbol) (1 test)

`compileFromCharCodeFamily` callers in
`src/codegen/expressions/call-builtin-static.ts` L750-777: reject
Symbol-typed args statically (the `tryThrowOnBigIntOrSymbolArg` pattern,
string-ops.ts L2330) and let Step D.2's runtime ToNumber Symbol arm cover the
dynamic case.

### Deferred — cluster J (3 tests)

`proto-from-ctor-realm.js`, `valueOf/non-generic-realm.js`,
`toString/non-generic-realm.js` need per-realm builtin identity; that is
#4274 (ready) + #4634. Do not attempt here; do not count them against this
issue's acceptance.

### What NOT to do

- No new host imports; every mechanism above is pure-Wasm
  (`__extern_get`/`__box_symbol`/`__call_fn_method_N` are in-module defined
  functions in standalone).
- Never edit `tests/test262-runner.ts`, HANGING_TESTS/skip lists, or
  `scripts/*-baseline.json` / `scripts/ir-fallback-baseline.json`.
- Do not "fix" `String(sym)` to throw (only implicit ToString throws).
- Do not delete the #1474 refusal diagnostic wholesale — narrow it to the
  forms Step A still cannot dispatch.
- Do not enqueue/re-enqueue PRs; run the ratchet gates before every commit
  (chained, unpiped — see CLAUDE.md "Hooks and ratchet gates").

## Acceptance criteria

- All 50 non-deferred tests in `.tmp/es2015/wp-string-current-fails.txt` pass
  via `npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-string-current-fails.txt`
  (the 3 cluster-J paths in `.tmp/es2015/str-cl-J-realm-deferred.txt` are
  accepted as still-failing; everything else must pass). Full success = only
  those 3 remain.
- Every test in `.tmp/es2015/wp-string-passing-spotcheck.txt` (40 paths)
  still passes via the same probe.
- Source-ratchet gates pass: `node scripts/check-loc-budget.mjs && node
  scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs &&
  npm run -s check:oracle-ratchet && npm run -s check:dead-exports`.
- Equivalence tests pass: `npm test -- tests/equivalence.test.ts`.

## References

- #1369 — js-host @@split/@@replace/@@match protocol (done; standalone lane was out of scope there)
- #1474 / #1539 / #4016 / #2161 — the standalone search-value/RegExp lane this wave extends (`string-search-value.ts`, `regexp-standalone.ts`)
- #4439 — reflective match/search closure bodies (`string-proto-match-search.ts`), sibling pattern for Step A
- #2175 — standalone builtin-prototype readers / native-proto glue (Steps A.4, B.2, C)
- #1445 — js-host String.raw + arg coercion (done); #3147 — standalone String.raw (done; Step F fixes its materialization residue)
- #2004 — codePointAt NaN→undefined in js-host (done; Step H is its standalone twin)
- #5102 — Symbol.toPrimitive probe in object-runtime (Step D builds on it)
- #4484 — GetMethod(@@hasInstance) module-scan gate pattern (Step A.4)
- #3231 — GetMethod(@@dispose) runtime read shape (`disposable-runtime.ts`, the template for Steps A/G)
- #40 / #3900 — case-convert-native + generated tables (Step E)
- #4274 / #4634 — realm identity (cluster J owner)
- #2860 — standalone vs js-host test262 gap umbrella

## Results (wave 1 implementation, 2026-08-29)

Target list `.tmp/es2015/wp-string-current-fails.txt` re-verified on the branch
base before any edit: **53 failing** (52 FAIL + 1 COMPILE_ERROR) — the plan's
count reproduced exactly, nothing already fixed.

After this change-set: **29 failing, 24 fixed.** The 40-path
`wp-string-passing-spotcheck.txt` regression guard stayed 40/40 PASS throughout.

| cluster | planned | fixed | note |
|---|---|---|---|
| K padStart/padEnd Symbol fill | 2 | **2** | `emitArgAsNativeString` for the fill arg — the §7.1.17 guard turns invalid Wasm into the spec TypeError |
| I fromCodePoint(Symbol) | 1 | **1** | static Symbol/BigInt rejection in `compileFromCharCodeFamily`'s per-arg ToNumber |
| H codePointAt OOB | 2 | **2** | `UNDEF_F64_BITS` sentinel + `undefSentinel: true` result type (standalone only) |
| E astral case mapping | 4 | **4** | new `ASTRAL_{UPPER,LOWER}_CASE_RUNS` tables + surrogate-pair decode/re-encode in pass 2 |
| B normalize | 10 | **7** | validation + preamble; the 3 `return-normalized-string*` tests need real NFC/NFD tables (wave 2) |
| C `String.prototype[Symbol.iterator]` | 5 | **5** | `@@1` glue member with ROC + ToString + the code-point vec |
| G runtime IsRegExp | 3 | **3** | new `src/codegen/string-isregexp-guard.ts` — `Get(arg, @@match)` runs, abrupt propagates |
| A @@protocol dispatch | 15 | 0 | **not attempted** — see below |
| D indexOf ToPrimitive | 5 | 0 | **blocked** — see below |
| F String.raw fidelity | 3 | 0 | **not attempted** — see below |
| J cross-realm | 3 | 0 | deferred by the plan (#4274/#4634) |

### Deliberately left for wave 2

- **Cluster A (15)** — the runtime `@@match/@@search/@@split/@@replace` GetMethod
  lane. Calling an arbitrary user method needs the `__call_fn_method_N` arity
  dispatcher, which is filled at FINALIZE time and carries its own declared-arity
  ladder (`objlit-to-primitive.ts`); wiring it into six string-method arms plus
  the `<Builtin>.prototype[Symbol.X]` reflective READ fix is a change of its own
  size and risk. `split/limit-touint32-error.js` is in this cluster but is purely
  a coercion-ORDER fix; it still needs holding an un-coerced separator across the
  limit coercion, which `stageCoercedOperands` cannot express today.
- **Cluster D (5)** — MEASURED root cause, narrower than the plan's: the runtime
  ToPrimitive walker does find `@@toPrimitive` installed by ASSIGNMENT and does
  unbox `Object(Symbol())`/`Object("foo")` correctly (verified through the
  reflective `String.prototype.indexOf.call` lane, which already routes through
  `emitStringProtoToStringFlat`). What it cannot see is a `@@toPrimitive` written
  as a COMPUTED KEY IN AN OBJECT LITERAL — that literal compiles to a closed
  struct. Every one of the five files contains at least one such literal, so
  none of them flips until the literal lowering is fixed; routing indexOf's arg
  through the reflective ToString lane alone buys zero tests.
- **Cluster F (3)** — `materializeStructAsDynamicObject` snapshots the template,
  losing accessors installed later on the nested `raw` object.

Equivalence gate (`npm run -s test:equivalence:gate`): 1718 passing, 24 failing,
all 24 in the committed baseline — no new regressions. Source-ratchet gates all
green with the allowances granted in this file's frontmatter.

### Files touched

`src/codegen/string-ops.ts`, `src/codegen/case-convert-native.ts`,
`src/codegen/case-tables.ts` (generated), `scripts/gen-case-tables.mjs`,
`src/codegen/array-object-proto.ts`, `src/codegen/string-proto-tostring.ts`,
`src/codegen/expressions/calls.ts`, and the new
`src/codegen/string-isregexp-guard.ts`.

`scripts/gen-case-tables.mjs` grew an `astralPairs` scan; the astral tables were
SPLICED into `src/codegen/case-tables.ts` rather than regenerating the whole
file, because this container runs Node v22 while the committed BMP tables were
generated on Node v24 — a blind re-run would have silently downgraded the BMP
Unicode data (one Latin-Extended run differs).
