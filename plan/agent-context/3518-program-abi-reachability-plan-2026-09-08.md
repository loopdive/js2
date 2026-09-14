# ABI reachability: fixed targets, bound members, explicit activation

2026-09-08. Proposal for parent review and the existing Low owner, not a
dispatch or implementation. Only this draft was written. No tests, typecheck,
build, compiler execution, claims, source/config writes or Git mutations.

## Pinned evidence and the blocking finding

Read the entire committed
`plan/agent-context/3518-program-abi-seam-dispatch-2026-09-08.md` at N1
`36ea5ce9f54190c1f2c7af0466cf768afb453394` in
`/private/tmp/js2-3518-native-foundation-checkpoint-20260907`.
Auditor blob independently confirmed:
`0d78cb4cf73d08216b135f04664c88abe2122c60`.
ABI source was read from `/private/tmp/js2-3518-program-abi-seam-20260908`,
based on `d71fab8b9565ad3a2bb567ed82f22e8750e804a4`, with the seven-file
uncommitted draft. Its five source Git-format content hashes were:

- `src/ir/program/abi.ts`: `c9240ad8bc83c36774a7def20db27425252f459a`.
- `src/ir/program/abi-inventory.ts`: `d65caca8c5e4bf9b60b555f68711e3801f30dd9a`.
- `src/ir/core/binding-key-primitives.ts`: `76364db86fb07972f66a78a886d66197e2355f6a`.
- `src/ir/program-abi.ts`: `35e3849eb8ef955e8944e77d15b284137897a2db`.
- `src/ir/abi-bindings.ts`: `ccc36208e534f572379150dc4e9ebf5a79edace4`.

N1's 117/117, six canonical full/cut witnesses, two structured unknowns,
25/25 ratchet, 39+66 controls, and ABI's 59/59/typecheck are parent-reported
results, not rerun here. This sidecar did not compose the two checkouts.
Parent subsequently composed the seven frozen ABI files at
`/private/tmp/js2-3518-program-abi-checkpoint-20260908`, HEAD N1 above.
Read-only byte comparison independently confirmed **7/7 identical** to the
inspected draft. Parent reports two-fixture exact equality against clean d71
and the isolated draft, and dirty D0 policy with 9 clean/1,247 modules,
9,756 resolved edges, four unknowns and zero errors. That policy/behavior
evidence does not settle member reachability; the four D0 unknowns are not
the same population as N1's two rooted import receipts. The future core nodes
and program index remain explicit debt. The serial 101-test cohort and PR
5735 publication remain entirely parent-owned; no policy was copied or edited.

Two concrete auditor limitations were verified:

1. `CanonicalProgramAbiMap<IrUnitInventory>` is an
   `ExpressionWithTypeArguments` for which `ts.isTypeNode` returns **true**.
   The current visitor's type-node return drops this runtime alias initializer.
2. Classes are registered as one non-callable owner; visiting that owner scans
   every method. Ordinary receiver member names are skipped. Thus neither
   importing a class nor reaching its constructor proves its individual methods.

An in-memory TypeScript source-binding projection over 1,244 production `.ts`
inputs separated class/member owners and resolved the specialization. It did
not invoke the auditor, compiler, semantic diagnostics or test runner. With
data properties and parameter declarations excluded as callable edges, it found
**29/30 public full witnesses, 29/30 public dispatch-cut witnesses, and 26/30
internal-driver witnesses**. These are bounded source-reference observations,
not execution, receiver-allocation analysis or an accepted gate result.

The missing public/internal row is the getter `ProgramAbiMap.planningSealed`.
Its sole resolved source read is `src/ir/prepare.ts:122`, in
`PreparedIrCandidateProgramBuilder.constructor`. No production source consumer
of that builder was found; neither public compile nor the internal prepared
driver reaches it in this projection. Keep this local consumer evidence, but
**do not make that constructor a root or certify 30/30 rooted liveness**.
The internal driver also does not reach `get`, `assertPlanSealed`, or
`canonicalId`. Those three do have public source witnesses.

Consequently an all-target public-witness acceptance remains blocked by the
getter. Resolve the scanner gaps without rewriting runtime code. Parent must
review any proposed acceptance distinction for this already-unrooted accessor
before activation; the approved two-hook receipts do not authorize silently
accepting missing ABI roots. This draft grants no getter exemption or reduced
denominator. An unresolved edge and a known unrooted consumer are different
report states, and neither is a successful public witness.

## Exact immutable target manifest: 29 moves plus one extracted source arm

Keep an explicit versioned `PROGRAM_ABI_TARGETS` constant in the mapped auditor,
independent of discovered files/symbols. Emit all **30** rows, including missing
ones. Use structured `kind`, class/member names and qualified source identity;
for display use `file#Class.method`, `file#Class.constructor`, and
`file#Class.get:planningSealed`. Class-value nodes are not constructor targets.

Old `src/ir/program-abi.ts` -> canonical `src/ir/program/abi.ts`:

- **16 map members:** `ProgramAbiMap.constructor`; methods `plan`, `entries`,
  `get`, `sealPlan`, `assertPlanSealed`, `bindFinalIndex`, `finishBinding`,
  `canonicalId`, `resolveFinalIndex`; getter `planningSealed`; private methods
  `registerDerivedUnits`, `validateInventoryMembership`,
  `assertInventorySourceOrder`, `requireEntry`, `canonicalEntry`.
- **1 error constructor:** `ProgramAbiInvariantError.constructor`.
- **8 algorithm helpers:** `indexKey`, `orderKey`, `compareOrder`,
  `validOrderComponent`, `intentSlotSpace`, `callableSignaturesEqual`,
  `freezePlan`, `aliasContractsMatch`.

Old `src/ir/abi-bindings.ts` -> canonical
`src/ir/core/binding-key-primitives.ts`:

- **4 moved functions:** `requireNonEmpty`, `requireBindingId`,
  `requireSourceGlobalCapability`, `keyPart`.
- **1 extracted function:** `irSourceGlobalBindingKey`. Its old provenance is
  the `source` switch arm in `irGlobalBindingKey`, not a fictitious old function
  of this name. Record that source-arm origin separately from callable IDs.

Require all three destination modules, including the type-only
`src/ir/program/abi-inventory.ts`, and the exact callable declaration kinds and
bodies. Do not derive the denominator from exports, existing methods or files.
Reject missing/renamed members, empty overload-only declarations, duplicate
old implementations, and wrong-path/same-spelling substitutes. Old map/error
compatibility bindings must resolve to their unique canonical constructors;
the generic specialization is an alias, not another implementation. Inventory
and ordinary fields are data, not extra callable targets. Preserve old/new
mapping provenance even if every destination disappears; never fall back to
old bodies in required-canonical mode.

## Real consumers to resolve, not fabricate

The sole existing public root stays `src/index.ts#compile`. A verified public
prefix is compile -> `compiler.ts#compileSource` -> `compileSourceSync` ->
`runPipeline` -> `codegen/index.ts#generateModule` ->
`ProgramAbiSession.publish` (`index.ts:6878`). Thereafter:

- `publish` -> `sealPlan` -> `buildSealedAbi`: real `new ProgramAbiMap`
  at session:3196, `plan` at :3203, map `sealPlan` at :3211.
- Session `sealPlan` reads map `entries` at :1907 and calls
  `createSealedProgramAbiPlanView`, whose :758 binds `entries` and `canonicalId`.
  `reconcilePreparedScopes:3179` calls `wholeProgramAbi.get`.
- `publish` -> `bindAndPublish`: map `bindFinalIndex` :1973 and `finishBinding`
  :1974; `new LegacyAbiAdapter(abi)` :1977 reaches that constructor's explicit
  map `assertPlanSealed` and `entries` calls. Map `resolveFinalIndex` also has
  the bound receiver `this.publishedValue!.abi` in session:1810.
- Private/member-helper edges come from their actual bodies: constructor ->
  `registerDerivedUnits`; plan -> `validateInventoryMembership` ->
  `assertInventorySourceOrder`; bind -> `requireEntry`; seal/canonicalId/resolve
  -> `canonicalEntry` -> `requireEntry`. Plan calls `orderKey`,
  `validOrderComponent`, `intentSlotSpace`, `freezePlan`; entries ->
  `compareOrder`; bind -> `indexKey`; seal -> `aliasContractsMatch` ->
  `callableSignaturesEqual`. Error constructors require actual `new` sites.
- The source-key helper has **two distinct required consumer obligations**:
  `abi-bindings.ts#irGlobalBindingKey`'s source arm (:346–347), and canonical
  map `validateInventoryMembership`'s capability-global check (:783).
  Require both bound sites, not merely one remaining path. That helper calls
  `keyPart`, `requireBindingId` -> `requireNonEmpty`, and
  `requireSourceGlobalCapability`. Other retained key/factory branches also
  use the primitives. Keep their resolved call-site census, not import liveness.

Separately report paths **from the existing internal entry**,
`compiler/ir-program-driver.ts#runIrProgramDriver`, through
`prepareWholeIrProgram` -> `assertPreparedIrProgram` (validator:204/207/209),
and through `emitAcceptedIrProgram` (consumer:347–359/426). It has no discovered
public source caller. Never union this diagnostic start into public roots or
the public cut graph. Require these two actual validation/emission legs as
separate integration obligations; a public session path cannot replace them.

The projection resolved three map construction sites and 33 map-member
reference sites across validator, consumer, session, old adapter and prepare.
These counts identify the inspected draft, not a license to mint new roots.
Record source file/hash, AST span, enclosing callable, access kind, receiver
binding, alias chain and final declaration on each witness. Preserve/report
site removals independently of “some other caller still reaches the method.”

For an exact non-launderable consumer map, retain these **33 member-reference
sites plus three construction sites** as fixture-independent obligations,
keyed by resolved enclosing declaration, target, access kind and occurrence
within that owner (not line number alone):

- Validator `assertPreparedIrProgram`: plan, seal (2), plus construction (1).
- Consumer `emitAcceptedIrProgram`: plan, seal, bind (3 occurrences), finish,
  resolve (7), plus construction (1).
- Session: `createSealedProgramAbiPlanView` entries/canonicalId (2);
  `resolveCurrentIndex` resolve (1); `sealPlan` entries (2);
  `bindAndPublish` entries/bind/finish (3); `preparePreparedComponentScope`
  canonicalId/entries/get (3); `reconcilePreparedScopes` entries/get (2);
  `buildSealedAbi` plan/seal (2), plus construction (1).
- Old `LegacyAbiAdapter`: constructor assert/entries (2),
  `resolveUniqueLegacyName` canonicalId (1), `resolveFinalIndex` resolve (1),
  `internalWasmName` get/canonicalId (2).
- `PreparedIrCandidateProgramBuilder`: constructor getter read (1),
  the `this.#abi.entries()` and `this.#abi.get(...)` sites at prepare:219/293
  (2; bind their actual enclosing member declarations when recording rows).

These site receipts preserve source consumers; their public/internal reach
classifications remain separate. In particular they cannot turn the builder's
three local sites into rooted witnesses. Do not admit another occurrence under
a different owner merely to restore the count. The two source-key sites above
are additional mandatory edges, not included in this map-member census.

## Bounded resolution rules inside the existing auditor

Reuse its parsed production program/checker and module-resolution/diagnostic
machinery. Add an isolated ABI member-level graph/report; leave the historical
ratchet and N1 `movedRuntime` graph, six rows, receipts and verdicts unchanged.
Do not solve ABI by expanding N1's class-owner scan or by making a second tool.

1. Register class values, constructors, methods and get/set accessors as
   distinct owners. Class references, exports, annotations and `instanceof`
   do not enter constructor/method bodies. Construction activates only the
   constructor and its instance initializers; class evaluation accounts for
   actual static initializers, not every member. Split supporting carrier
   class owners too, notably `ProgramAbiSession` and `LegacyAbiAdapter`, so
   public prefixes cannot borrow calls from their unreferenced methods.
2. Recognize runtime instantiation expressions **before** the type-node skip;
   unwrap their value expression only, not type arguments or type aliases.
   Follow symbol-bound imports/re-exports and immutable constructor aliases,
   recording the entire chain. A `new` expression must resolve to the actual
   constructor declaration. Reject missing, ambiguous, reassigned or cyclic
   aliases; never resolve by the text “ProgramAbiMap.”
3. Resolve dot/optional member access against declarations, including
   `this.privateMethod`, typed parameters, chained receiver properties,
   private fields, and method-return receivers such as
   `this.buildSealedAbi(...).entries()`. Accessor reads enter only the getter;
   writes are not getter witnesses. A plain data/parameter property such as
   `publication.abi.inventory` must **not** map to its enclosing constructor.
   The initial projection exposed exactly that tempting false edge; it was
   removed before the reported 29/30 count.
4. Preserve the established **reference**, not execution, contract: a bound
   `abi.plan` method reference in a reached body is evidence even when passed
   as a callback; it is not evidence of an invocation or correct `this`.
   Unreached function/method bodies, unused exports, and class declarations
   cannot supply its prefix. Preserve object-property/parameter provenance
   without claiming runtime allocation/points-to analysis. An interface-only
   method declaration is not a body. No name-based cross-class matching.
5. Literal element access may resolve an exact member with provenance;
   nonliteral keys on tracked ABI/carrier receivers, `any`/unsafe assertions,
   ambiguous unions, unknown factories, reflective construction, prototype
   reassignment and unsupported alias flow remain structured unresolved rows.
   Do not fan them out to all methods. Fail relevant required witness integrity;
   do not redefine arbitrary unrelated compiler dynamic dispatch as this
   slice's obligation. No claim of universal source/runtime graph closure.

The projection is not the finished resolver: ambiguity, alias-write guards,
getter read/write classification and unsupported-flow diagnostics need the
implementation controls below. Keep missing-root status for the getter apart
from those unimplemented-resolution unknowns.

## Activation and exact parent write map

The three previously mapped files suffice for graph logic, fixtures and D0
architecture policy, but not an independently mandatory ABI invocation while
leaving existing fixture entry semantics untouched. Propose **one narrow map
amendment**, subject to parent approval: edit `package.json`'s existing
`check:dead-exports` command to append
`--program-abi-reference-contract=canonical-v1`. No new script or JSON manifest.
Do not activate from destination existence or a discovered nonempty class.

Exact proposed writes:

1. `scripts/audit-legacy-reachability.mjs`: fixed 30-row manifest; bounded
   constructor/member resolution; additive `programAbi` report; explicit flag
   parser and verdict conjunction. Preserve existing default/strict/N1 modes.
2. NEW `tests/issue-3518-program-abi-seam-reachability.test.ts`: actual auditor
   subprocess fixtures plus production source/CLI activation obligations.
3. `scripts/compiler-boundaries.json`: only the already-authorized three new
   module classifications/activations (core minimum 1, program minimum 2),
   original/new provenance and retained future nodes/program-index debt.
   Preserve all N1/F0 activations and independent base-policy checks.
4. **Proposed additional file:** `package.json`, that one command only.

Reject duplicate/unknown flag values and use without `--check`. Without the
flag, old 39+66 fixtures still exercise precisely N1's existing contracts;
report ABI as not requested, never certified. With it, require canonical
targets even for empty/deleted directories; emit all failure rows. The new
test must assert the production command requests this contract, so removing
the flag cannot silently drop ABI coverage. D0 counts alone cannot preserve
a constructor/method denominator or authenticate caller paths.

The requested contract reports target integrity, public-full, public-cut,
internal-driver and local-only evidence separately. Current all-target public
coverage must be **FAIL, 29/30**, with the getter row retained. Do not lower
its threshold, join internal/local starts into public counts, or publish an
aggregate green by accepting a class-wide reference. Parent acceptance review
of that finding precedes enabling a mandatory green production check.

When an authorized ABI verdict is joined, use conjunction with the existing
selected N1 verdict and old ratchet, never replacement. N1 strict still fails
on both original structured open imports; preservation still requires its
exact six full/cut witnesses, exact two receipts and unchanged 25/25 ratchet.
ABI unknowns are not additional extension receipts. No extension-manifest,
baseline, CI workflow, ABI implementation, N1 runtime or P/C edits belong here.

## Required controls for the existing Low owner, not tests run here

- **Population/activation:** all 30 canonical rows and three destination files;
  delete each destination/member/helper individually and all together; retain
  old implementations after deleting destinations; rename methods/getters;
  substitute data properties or overload-only signatures. Every case retains
  the denominator and fails integrity. Test missing flag in the package command.
- **Bindings/construction:** specialization through old import and namespace
  re-export; immutable constructor alias chain; direct canonical constructor;
  same-named local/foreign class, alias reassignment/cycle, missing export,
  wrapper/subclass substitution and `instanceof`-only references. Only genuine
  construction/reference kinds receive their own appropriate edges.
- **Member ownership:** constructor-only use cannot keep unrelated methods or
  getter alive. Exercise private `this` calls, getter read versus write, method
  references, chained `publishedValue!.abi`, parameter properties and returned
  receivers. Reading `inventory` alone must not keep the map constructor alive.
  Removing the only private call must fail despite its method body remaining.
- **No laundering:** delete public session publication/its build call, remove
  individual real map consumers, remove either validator or emitter leg, and
  remove either source-key consumer. Retained imports, aliases, class bodies,
  same-spelled methods, new exports and test-only calls cannot replace them.
  Witness-site preservation must catch a removed required caller even if another
  caller still reaches that target. Unbound dynamic local possibilities must
  produce unknowns, never success via a best-name match.
- **Root separation:** an internal-only fixture yields null public paths;
  a real dispatch-only fixture retains separate cut classification. Keep the
  actual getter's known local-only status explicit; deleting its builder read
  loses even that local evidence, not just a test count. A synthetic positive
  fixture may exercise a publicly reached getter but cannot certify production.
- **Regression:** run unchanged N1 39+66 controls, both strict/preservation
  modes, raw unknown IDs/receipt constraints and old-ratchet behavior in the
  parent's slot. Exercise combined N1+ABI fixtures; ABI success cannot mask a
  third dynamic import, deleted N1 consumer or changed old ratchet. Reproduce
  final production evidence only after N1/ABI composition; no passing total
  or complete closure is claimed by this sidecar.

Inspected supporting sources: `src/{index,compiler}.ts`,
`src/compiler/ir-program-driver.ts`, `src/codegen/{index,program-abi-session,
multi-prepared-program}.ts`, `src/ir/{prepare,program-preparation,
program-validation,program-consumer,program-abi,abi-bindings}.ts`, all three new
ABI/core files; final auditor CLI, rooted graph and receipt/verdict integration,
existing 39/66 fixture setup/assertions, package command and D0 policy. Parent
retains ownership reconciliation, publication and the serial validation slot.
