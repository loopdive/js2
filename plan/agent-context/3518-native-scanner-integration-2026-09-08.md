# Native scanner integration

Base: a6cc59a2cdfad5141d75faadf1530a9de63bebd7 (PR #5774).
Parent owns string-literal authentication and subsequent scanner/native-value
joins. Hilbert owns flattening, Maxwell owns StringToNumber, Euclid owns the
disjoint ObjVec slice. No full scanner implementation is present here yet.

Added explicit encoding lookup through the existing literal interning keys,
preserving the old text-only API. UTF16 empty lookup must request `wtf16`;
UTF8 test demands use the actual `utf8-guaranteed` contract. Completion
requires an issued owner, exact ledger, successful fill and current physical
ledger validation of all owned types, globals and literal functions.

Initial test setup failed on a nonexistent createEmptyModule export; corrected
to its actual existing ir/types owner. Next run passed4/5 and exposed invalid
test encoding `utf8`; corrected to the real StringEncoding vocabulary. Final
focused5/5 passed. Composed session96731 exited0: TS7 and34/34 tests
(5 completion controls plus29 unchanged string/error cases),10.10s.
No failures were interpreted as implementation success.

High confirmed separate flatten reservation-phase and completion accessors.
Before freeze, authenticate issued owner/transaction/string pack/exact empty
binding without physicalIndex or fill requirements. After freeze, require
canonical fills and current ledger validation. Shared private ownership checks
must prevent the two accessors drifting. No new global completion ledger.

Parent authentication diff still requires independent review. Scanner,
flattening, prepared replay and full-family execution are not certified by
these34 tests. Existing cutover/retirement obligations remain unchanged.

High independently approved source blob eae06050f2c2f31afc90819bb44836180cb3b2b0
and test blob c158bf5bd8e6616630fabbe8c4e03cb42b40a0ff with no concrete findings.
Approval covers string authentication only. Publication awaits the serialized
normal-hook slot; no scanner/full-family completion is inferred.

Published authentication checkpoint: PR #5775, bfe31c8bd96d748e867562e3e9b78343b72d1877.
Normal push checks passed, including18 numeric-local controls; changed-root
gate skipped69 roots (>20), not a passing test result.

Next native-values join must replace raw anyString/toNumber tokens with the
issued scanner pack and explicit expected string pack. Reservation admission
must also compare the scanner owner's exact NativeValueResourcePlan identity
against the consumer's requirements, not merely validate the scanner's own
plan. Two valid plans in one ledger are not the same source selection. Parent
requested this expected-plan parameter from the scanner owner; interface
review is pending. Fill additionally requires completed scanner and flatten
resources. Old name/signature/nonempty-body tests cannot certify this join.

Parent now implemented the consumer side of that contract: native-string
dependencies contain explicit stringPack and issued scanner pack. Reservation
checks the scanner against the exact value plan and string pack; filling
rechecks identities and requires completed scanner/flatten/string producers.
Removed raw function-name/signature/nonempty-body admission heuristics.
This new join is untested and depends on worker modules not yet integrated;
the earlier34-test receipt does not cover it. Full chain tests remain next.

Parent authored seven chain test cases (not executed): four positive-first
reservation identity negatives, one incomplete-scanner fill/recovery control,
and two complete literal/flatten/scanner/unbox execution cases for UTF8 off/on.
The identity controls distinguish another genuinely issued equal plan, a
cloned plan, another string pack, and a cloned scanner pack. Rejection must
leave allocation populations unchanged. The completion control checks no
partial value fill before the canonical scanner fill and then seals and
instantiates the recovered module. Runtime cases cover signed zero, NaN,
infinity, whitespace, radix and exponent syntax using two fresh instances.
Formatting and scoped diff whitespace checks passed; this is not a test receipt.

Scanner worker now exposes the expected four-argument reservation and
completion accessors (transaction, scanner pack, exact plan, exact string pack).
Its source is still worker-owned and not yet copied into this integration.
Argument-vector launcher handle95682 is missing, but Euclid confirmed launcher
83837 and worker83841 remain live. No termination or replacement test run was
performed; user permission to stop the malformed invocation remains pending.

High independently approved the parent join without blocking findings:
native-values SHA256 d96506ee201991a2f5a4794448af3f9b546c9565efa753a1a9b445e2afc63a74,
chain tests SHA256 2dd90718f6929313222631b99d9389efbd0e91dd09290ee8a10bff6111384112.
Parent verified these hashes against current files. This approval is static;
the seven tests remain unrun and worker modules are not yet composed here.
Malformed-exponent failures, if observed, must remain visible. These tests
prove resource-chain behavior only, not public-source cutover or retirement.

Parent composed all13 frozen scanner/flatten files. Source and destination
SHA256s matched13/13 manifests. Initial composed TS7 session75613 exited1:
flatten worklist ArrayTypeDef lacked required name. Parent followed actual
getOrRegisterArrayType registry naming and added __arr_ref_<anyStrTypeIdx>;
this one parent repair changes the integrated flatten-owner hash, not workers.

First combined execution27299 exited1:101/119 passed,18 failed,20.73s.
Failures are retained, not interpreted as parity success:
- Both parent UTF modes encounter numeric1 where malformed exponent expectsNaN.
- Scanner whitespace semantic row fails its independent Number expectation.
- Fresh-process flatten execution exposes real forbidden codegen/walk-instructions
  loading. Hilbert investigates exact import chain; guard remains unchanged.
- Scanner donor positive receipt fails lazy-table/order check; dynamic donor
  instrument also injects POW10_TABLE_MAX alongside a local declaration.
  Those failures mask dependent negatives. Maxwell owns instrument repairs.
- Three loader negatives mismatch Node's literal [eval1] parent URL against
  percent-encoded expectation; exact denial remains required.
- Scanner fresh-process positive also failed; inspect its retained report
  before assigning cause. No unsupported run is counted as passed.

High review now includes these observed failures. Semantic fixes must preserve
historical baseline evidence and be explicit; no expectation weakening or
guard relaxation. Composed TS7 needs rerun after the descriptor repair.

Composed TS7 rerun79020 exited0 after the descriptor-name repair.
Parent inspected retained individual rows (not aggregate failure labels):
both fresh instances return1 for actual "1e" and "1e+", where Number requires
NaN. By contrast the whitespace fixture at donor line204 contains literal
backslashes (double-escaped t/u sequences), not whitespace code points. NaN
is correct for that actual fixture; Maxwell will repair the input to genuine
whitespace while preserving expected42. This is not evidence of a scanner
whitespace implementation defect. The independent fresh-process report also
confirms its failure is the same forbidden codegen/walk-instructions load.
Raw evidence remains in .tmp/native-scanner-semantics-iWvvzx/receipt.json and
.tmp/native-scanner-admission-Tjd7T0/report.json; avoid dumping encoded modules
when inspecting rows. No semantic failures have been suppressed.

Hilbert traced the forbidden runtime edge: binary.ts imports wat.ts, which
imports codegen/walk-instructions.ts. Parent moved the four generic walker
bodies and their documentation unchanged to wasm/model/instruction-walk.ts,
with only the Instr type import redirected to model/instructions. The private
walkInstructionArrays remains private; three public functions are compatibility
reexports. allocatedStructTypeIndices stays in codegen, unchanged and using
the canonical DAG walker. WAT now directly imports the canonical walker.
No dynamic imports or guard relaxation. High review remains pending; Hilbert
owns an independent exact-donor preservation test in a disjoint new test file.

Composed run30941 exited0:40/40 passed (10 existing walker tests and30 flatten
controls),2.44s. In particular the formerly failing fresh-process UTF8 flatten
control now passes with the legacy/frontend import guard unchanged. This is
not a whole-compiler closure proof; scanner semantic and receipt failures
remain open. Parent focused scanner fresh-process run is next.

Focused scanner fresh-process75617 exited0:1/1 selected passed,81 skipped
of82 collected,11.64s. Both previously observed forbidden-walker positive
controls now run without relaxing either guard. This fresh-process receipt
does not erase the separately failing semantic rows or donor instruments.

High approved the three-file walker movement. Parent verified current hashes:
canonical9305edbbf114214b1f9cea087d10af4ebfc901f9c7819711e2db4b2706c8666b,
legacy23e275b2272f71207ec00b36b1d594bc094c7900a0ee9991f56957582302c36b,
WATdbd49392a6340423f693536900107ea7d39e4b2918d3c857ed1acfd121d35587.
Hilbert's independent inverse proof is being expanded to cover all High
requirements; this source approval does not replace that test evidence.

Boundary policy activates eight new owners (five runtime, two backend, one
model walker). All previous activation history and allowed edges were compared
against HEAD and are unchanged. Exact measured graph:94 modules,337 edges,
217 type-only and120 runtime. Full mutation suite11610 exited0:237/237 passed,
148.79s. This bounded canonical graph does not prove whole compiler closure.

Parent integrated scanner R2 test/fixture only, verifying source R2 hashes and
destination R1 hashes before replacement. Production five-file population is
unchanged. Test c5e756856064060df168084359d689103bf2671b702cffc8ce0b201a3e117429;
fixture07fc38615bd2114549b61d461b1767c02b5e361d8cd8b2ab16fdf29477aca00c.
Historical donor payload unchanged. This repairs the donor instrument and
whitespace input, not malformed-exponent behavior; runtime validation is next.

Scanner R2 suite93021 exited0:85/85 passed,21.08s. Its semantic-debt recording
cases preserve wrong malformed-exponent observations; this does NOT prove
those inputs correct. Parent chain tests still independently require NaN for
"1e"/"1e+" and remain failing until the explicit semantic repair is validated.

Integrated Hilbert walker proof R2 exact SHA256
0194bc8458bef60bc8a26fd8e4dbf2887e49b9d31ec73eccfb0e9f06d8851d89.
32 new controls plus10 existing walker tests passed42/42,0.700s. Full donor
hash remains d88b931eaa7f0451217cb85db0f713dd33447bfe393d37752a0e25eb4ee44e14;
includes extra statements, exact imports, private/public exports, shared-root
and sibling traversal, visitor mutation timing, and thrown sentinel identity.

Parent located semantic cause: emitExponent consumes marker and optional sign
then permits zero digit iterations; full-match i==end therefore accepts1e/1e+.
This helper is also used by parseFloat in the legacy adapter, whose longest
numeric-prefix semantics must remain intact. High's immediate task is the
bounded StringToNumber-specific repair and explicit semantic-delta receipt;
do not globally replace shared-helper behavior or reseed historical hashes.

High approved a StringToNumber-only last-consumed-character check. Parent
implemented it immediately after emitExponent and before the unchanged
full-match check: load data[L_I-1] into L_C, reject e/E/+/- with NaN. Existing
L_C cannot be trusted because it can hold unconsumed lookahead. Mantissa
no-digit rejection guarantees a valid index; radix and Infinity already
return before this span. Keep all19 locals and power/resource acquisition
order unchanged. Only C_LC_E/C_UC_E imports and this exact span are added.

Shared grammar SHA256 remains
d6f136c3c0894870cfbbf468e6e1e5b66a75abb7999df876e49079b8393b1693;
legacy parse adapter remains
b3c02a23af9ccdb6aaf8635d47dddfe6af35ee4a4f2fb8ecf31f1ee8d046a4ab.
Both real legacy StringToNumber and native resources consume the repaired
canonical prelude; parseFloat's shared helper/caller remains byte-unchanged.

Parent chain96765 exited0:7/7 passed,12.03s. Execution now covers24 cases per
UTF mode, each in two fresh instances, including malformed lower/uppercase
and signed exponents, trimmed malformed input, valid trailing dot, signed-zero
exponents and hex ending in e. Original NaN expectations were not changed.

This is an intentional semantic correction, not byte-preserving extraction.
Maxwell owns R3 proof: validate the whole exact added span once at its exact
site, remove only that validated span and exact added imports, then perform
the original donor reconstruction/hash checks unchanged. Keep old reports of
wrong1 results; require corrected candidateNaN. Add mutation controls and
nonzero-offset malformed input plus parseFloat prefix checks. Until that proof
and paired-source validation pass, publication remains pending.

High approved actual repaired production SHA256
ce232ad6182bf57b9e690f48bbd2605fde3f46b9600a85804834364895b98f52,
confirming only the two imports and exact instruction span changed. Candidate
public source regression run89414 exited0:43/43 passed across issue3570,
issue2654 and issue1184,28.02s. This is candidate-only execution, not the
pending explicit-root paired bytes/WAT/resource-order proof.

Clean detached baseline /private/tmp/js2-3518-scanner-baseline-20260908 was
created and HEAD verified a6cc59a2cdfad5141d75faadf1530a9de63bebd7. Baseline
run32971 exited0:43/43 same three source suites passed,28.23s. Candidate
root is this integration checkout with the documented semantic delta; both
arms used the same single-fork standalone test commands. This provides two
explicit-root regression results, not yet the paired artifact/order comparison
being authored by Hilbert. Baseline sources remain untouched.

2026-09-09: integrated only Maxwell's R3 test and fixture after validating
both destination R2 and source R3 hashes. New test SHA256:
d3acfb86b6b5f4e577188bbd87554ca01916027ba40d1dc44871a59d7e4949fb;
fixture7693361d7335a8a84cca743f10ab02c9cb0fa8e4b5739f8d38990f00977cfe9d.
Parent semantic production remains unchanged. High statically approved the
exact22-instruction delta authentication/projection, fixed13-function and
34-constant donor reconstruction, all156 execution recipes and positive-first
mutation controls. This is not yet execution evidence: composed scanner,
flatten, value-chain and walker run97437 is in progress. Public three-arm
pairing remains separate and pending.

Composed R3 run97437 exited1:139 passed,46 failed of185,272.87s. Shared
execution fails in __str_utf8_to_flat on whitespace__utf8-guaranteed__offset
with array element access out of bounds; each dependent test rebuilt the
throwing fixture, amplifying the one root failure. The canonical UTF8 layout
names field2 `off`, but the extracted decoder initializes byte cursor0 and
reads data without that offset. High is checking the contract before a
production repair. All156 recipes and semantic expectations stay intact;
do not replace genuine nonzero-offset coverage to make this pass.

Hilbert public three-arm R2 test copied at SHA256
11cd7a7598b881bf9ec0d60cbd65110e51127a90e3b517812eb2d2cd92fec7b4.
Its22 lightweight projection/admission guards pass (1 full-run test filtered,
not counted as passing). Full public pairing is unrun and its current
projection only accounts for the scanner exponent repair, not any prospective
UTF8 decoder repair. Publication remains blocked on actual corrections and
updated preservation evidence, not static approval alone.

High confirmed valid UTF8 window semantics: field2 is byte offset and field1
is byte-window length. Hilbert owns the approved one-site correction:
replace b=0 initialization with local.get0; struct.get field2; local.tee5;
local.get2; i32.add; local.set2. This makes cursor=off and end=off+byteLen,
keeping all locals, branches, continuation reads and output unchanged.
The implementation and second exact preservation delta are dispatched;
they are not yet integrated or tested. Add complete mixed-width/astral and
multibyte-prefix decoder observations; preserve all156 scanner recipes.
The existing source producers use offset0, so resource-view coverage must
not be mislabeled as source-produced offset provenance.

Current pre-repair composed TS7 session38544 exited0, including the new
three-arm proof file. No claim of runtime correctness follows from it.

Integrated frozen decoder SHA256
119976d2b5c593dc05b22ed82df454537d3b0bed9395e9ae47ef7dbac64bb748:
the exact approved start/end correction and adjacent comments only.
Integrated scanner R4 test4161b1f8b0229442c0cbca6cfc12bc5a8c2d7124703826aa9587b0526991f71f;
fixture7693361d... remains unchanged. Failure caching rethrows the original
error rather than rebuilding the same failed fixture for every assertion.
Targeted run52609 exited0:5 passed,115 filtered; the formerly crashing
156-recipe fixture now instantiates and executes twice, and4 cache controls
pass. Full scanner/value-chain/walker run8790 is underway. Decoder donor
delta proof, direct mixed-width decoder tests and public pairing remain.

Full run8790 exited0:159/159 passed across scanner resources, owned native
value-chain execution and canonical walker proof,43.36s. This includes all
120 scanner controls, all156 UTF/view recipes, replay and the fresh-process
admission test. The original46 failures are fixed without recipe removal.
The flatten donor suite is intentionally not claimed by this run: its
second semantic-delta accounting and additional decoder observations are
still being authored. Full public pairing and final composed TS7 remain.

Post-repair composed TS7 session40746 exited0. To keep writer scopes disjoint,
Maxwell now owns a new direct UTF8-window decoder test file; Hilbert owns
the existing flatten donor inverse and public three-arm projection updates.
Both must validate the frozen119976d... production, without weakening any
of the156 scanner recipes already passing. Final typecheck must be refreshed
after those additional proof files arrive.

Post-repair compiler-boundary run56329 exited0:237/237 passed,145.48s.
This revalidates the bounded module population and import constraints on
the current decoder/scanner source. It is not strict whole-compiler closure
or direct retirement evidence. Additional donor/runtime/public proofs remain.

Integrated Hilbert R3 flatten proof52629ad4ffd8989bb40116d31d92dbd1338b56998e460932b3f074aed7ecdbf6
and public proof1ba66a71c56abda48bc75af741db65ee7ce3dfa263a603c7ae6ca87dd80e8f23.
Run82126 exited0:71/71 passed,58.81s. Each of the baseline, untouched
candidate and preservation-projection children exited0 with66 executed rows
and132 calls. Baseline/projection bytes, WAT, serialized declaration order
and outcomes match with zero differences. Candidate malformed1e/1e+ yields
NaN while baseline/projection retain the original1 results. Projection
transformed exactly the two authenticated targets, once each; actual
candidate transformed nothing. Full artifacts:
.tmp/native-scanner-source-pair-qMOuHB/{baseline,candidate,projection}.json
and comparison.json. This is preservation plus explicit semantic correction,
not baseline-versus-actual-candidate byte parity.

Integrated Maxwell direct decoder proof638cbf41328b09d2ffc54b319122ac284214c009050f08bdc30468158692571f.
All27 tests passed,0.674s:18 UTF8 windows including multibyte-prefix byte
offsets, exact UTF16 units/length/output offset, a genuine clone control and
seven independently executed semantic mutants. Original issued module is
unchanged; compile/instantiation failures cannot count as mutant detection.
Final composed TS7 session24937 and independent final review are pending.
All six repaired/pinned production and proof files checked by Prettier pass.

High approved the direct decoder proof but withheld complete R3 approval:
ordinary Vitest tests depend on external checkout environment variables;
ESBUILD_BINARY_PATH is inherited without authentication; import inverse
accepts arbitrary /values/string-* routes; builder inverse omits complete
header, statement-order and return obligations. Passing71/71 does not close
these proof gaps. Hilbert owns repair with original donor/observations kept;
the full explicit-root verifier must not make ordinary test runs depend on
an unrelated checkout, nor silently skip its own acceptance obligations.
Publication remains held until repaired proof and review complete.

High approved a three-file proof-only repair plan: retain the two unit test
files and add scripts/verify-native-scanner-source-preservation.mjs as shared
import-safe helpers plus an explicit-root CLI. Unit guards resolve their own
checkout, while all66 three-arm scenarios remain mandatory CLI acceptance.
The child environment removes inherited ESBUILD_BINARY_PATH and pins its
effective tsconfig/cache/Node settings. Parent and child authenticate real
tsx/esbuild/native executable paths and hashes before/after each arm.
Exact import routes and complete builder headers/statement/return order
are checked before historical donor reconstruction. No production or
historical baseline changes are authorized by this repair.

Integrated frozen script6489cc22727f65ab57549d95cf9a7f75fd8fa81238eab94c66b6b5dcc10a5577,
source unitfbf2d925883d239c16060006f9d0b12c462f3264adeaaf13ceedd4f123941cd5,
flatten unit2ce932fdd890d4f941e57c69190770570994cf201929e3b9b893ccd7bb71fd00.
Run71997 exited0:100/100 unit tests passed,5.30s, with both external-root
environment variables explicitly absent. This is not the full CLI result;
the mandatory66-row/three-arm rerun and final review remain pending.

High independently approved the four-gap repair at the three hashes above.
Exact import authentication plus the full inverse closes route substitution;
the preceding substring selection is not an acceptance loophole and needs
no further functional change. Decoder production and original donor hashes
remain unchanged. Mandatory CLI run70458 is now executing with explicit
baseline/candidate roots; artifacts .tmp/native-scanner-source-pair-m0lTs7.
Its result is not yet claimed. Final composed typecheck remains afterward.

CLI70458 exited0. All three children exited0 without signals, each executing
66 rows/132 calls. Comparison differences are empty. Parent/child native
executable identity is authenticated in each arm:
@esbuild/darwin-arm64@0.28.1,
SHA256e2dc9a52440a2a34f09434a2f4843cb1e30f84e40dcf238976ec61ef8cd7f36a.
Untouched candidate had0 transformations; projection had exactly2. Existing
baseline wrong-result receipts are retained separately from actual repaired
semantics. This closes mandatory CLI execution for the reviewed three-file
repair; final composed TS7 session3434 is running before publication.

Final composed TS7 session3434 exited0. Pre-publication formatting left all
production, policy and proof files unchanged except the flatten donor's
TypeScript string-literal transport formatting. AST-decoded donor equality
against the frozen worker is checked separately; no donor value was refreshed.
Final combined286-control unit run19934 is underway on the formatted files
with both external-root variables absent. Publication follows terminal
validation and normal hooks, not a weakened or skipped proof gate.

Final combined run19934 exited0:286/286 passed across all six focused unit
suites,45.59s. The formatted flatten fixture's decoded donor remains exact
SHA256e695b22c961f85570a5b574264b399f8bfab6fd67bfd4721325c53e9afecb407;
its transport changed from f9a4a262... to
7840a468fc0b919978c8ee33f5a878d67e2950119c1f6ffb9ea5c37c33e62c36.
All source/proof pins pass after formatting. High review,286 unit controls,
237 boundary controls, the mandatory198-row CLI and final TS7 are current.
Proceed with normal publication hooks; full consumer wiring/cutover and
direct-codegen retirement remain open as documented in the census.

First commit hook4850 rejected one test-helper useConst lint finding before
commit creation. Parent changed only `let cons` to `const cons`; affected
unit rerun40982 exited0:100/100 passed,4.10s. Final flatten proof SHA256 is
290b8a71f73a32d97cf9179c7787988d4554a964f99f597e8c48253809f554e6.
Production, donor and explicit CLI logic are unchanged. Retry normal hooks.
