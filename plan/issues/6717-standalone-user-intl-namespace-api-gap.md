---
id: 6717
title: "Standalone user-visible Intl namespace/API gap: proof-first host-free semantics"
status: ready
assignee: null
requested_by: ttraenkler/codex-es2015-manifest
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime, providers
language_feature: intl
goal: standalone-gap
parent: 4444
related: [4444, 6712, 5206, 5355, 6442, 2961]
created: 2026-09-28
updated: 2026-09-28
---

# #6717 — Standalone user-visible `Intl` namespace/API gap

## Status and boundary

This is a proof-first implementation plan only. No implementation route is
selected, no production file is owned yet, and this issue does not claim that
one defect explains every frozen Intl non-pass.

The target is the user-visible `Intl` namespace/API in `--target standalone`.
It must eventually supply normal JavaScript semantics without host imports,
test-specific branches, or deliberately throwing placeholder APIs. The frozen
11,778-path ES2015 completion bar remains the acceptance boundary; the 74-row
Intl subset is a measured diagnostic slice, not a substitute denominator.

This is explicitly distinct from two completed, narrower routes:

- [#5206](./5206-intl-global-missing.md) materializes the host ICU-backed
  `Intl` global only when neither standalone nor WASI is selected. It leaves
  standalone/WASI on the null default by design.
- [#6442](./6442-standalone-intl-datetimeformat-fixed-offset.md) prepends a
  lexical, provider-local `const Intl` only to the Temporal provider. Its
  table-free `DateTimeFormat` is not a user global and intentionally covers
  only UTC aliases and fixed `Etc/GMT±N` zones for that provider's call shape.

Neither route may be widened implicitly, reused as a user-global shortcut, or
treated as evidence that the standalone user surface works.

## Measured starting evidence

The exact-manifest discovery work in [#6712](./6712-test262-exact-manifest-discovery.md)
restored the frozen 11,778-path selection without changing policy exclusions.
Its post-publication census ran exactly the 74 `test/intl402/...` identities
from that frozen manifest. The newline-terminated input and wrapper snapshot
both hash to
`f1c370eed335e514cb60340e9d105545719599017fd20acfdfb0be2d9883d2a3`.

Run `20260928-015700`, at source commit
`db5fe17e84365f93f90c9134636f989f94a453dc`, used the maintained standalone
dynamic chunk 0/1 with one worker, a 4096 MiB fork heap, history disabled, and
the verified QuickJS linked pair. It completed all accounting: 74 registered
identities, verdicts, callbacks started, and callbacks settled; zero proposal
or official exclusions. The retained result is **2 pass / 70 fail / 2 compile
errors / 0 skip**. Wrapper exit 0 proves complete accounting, not conformance.

The two preserved passes are:

- `test/intl402/DisplayNames/ctor-custom-get-prototype-poison-throws.js`
- `test/intl402/Segmenter/ctor-custom-get-prototype-poison-throws.js`

They are provisional regression controls for abrupt custom-`newTarget`
behavior, pending target-evaluation and invalid-target ordering proof; they
are not proof of broad DisplayNames or Segmenter support. The two preserved
compile errors
are both standalone host-import leaks:

- `test/intl402/NumberFormat/prototype/format/value-tonumber.js` emits
  `env::Intl_NumberFormat_new` and `env::Intl_NumberFormat_format`.
- `test/intl402/NumberFormat/prototype/formatToParts/value-tonumber.js` emits
  `env::Intl_NumberFormat_new` and `env::Intl_NumberFormat_formatToParts`.

The JSONL, completion receipt, and report SHA256 values are respectively
`62150442b185548dd9a95c18a162984d0cd491aaf7ff746ac79bc64101ebac07`,
`3deed2815b81bfe32bfd28d075cd4d879cb55ec6ac7ecf97e11fe02b662c16bf`, and
`2c9c8ec92598fc66f5e18ac44d346f5e6745bf6d645aa756c5f3572fc2036411`.
The report groups all 72 non-passes, but those buckets are triage aggregation
only, not causal proof or permission to generalize one observed cause.

## Working hypotheses, not conclusions

Source inspection supports several separate hypotheses that must be tested:

1. `compileIdentifierCore` materializes ambient `Intl` through the real host
   global only under `!standalone && !wasi`; its standalone path retains the
   null default. This plausibly explains direct user-global null/property
   failures such as
   `test/intl402/Collator/proto-from-ctor-realm.js`, but does not prove an
   emitter trace for every failure.
2. `Intl.getCanonicalLocales` controls, including
   `test/intl402/Intl/getCanonicalLocales/has-property.js`, expose observable
   proxy/error-order requirements. Supplying a namespace alone cannot satisfy
   them.
3. The two NumberFormat rows demonstrate an import-policy/ABI problem in
   addition to any missing namespace. They must remain counted until a
   host-free implementation compiles and runs them without the forbidden
   imports.
4. Locale canonicalization, negotiation, formatting, constructor/prototype
   behavior, realm behavior, and data availability may be independent
   residuals. The 72 non-passes must not be labelled one root cause before
   representative reductions establish it.

## Source audit: the two `NumberFormat` host-import routes

This read-only audit is pinned to compiler revision
`5bfc069422c7cece3e7f19f84e7ce3e51be2269c` and Test262 corpus revision
`b363f29d3c43c626dc852744ad64a0b48a003693`. It isolates only the two
measured `NumberFormat` compile errors; it is not emitted-Wasm or runtime
proof for those rows, and it does not attribute the other 70 non-passes to
this mechanism.

The untouched upstream sources are:

- `test/intl402/NumberFormat/prototype/format/value-tonumber.js`, SHA-256
  `ecf84de483d81e5ccef5145c4065ceb2d183fc72d54d1781910c52de5b86c78f`;
- `test/intl402/NumberFormat/prototype/formatToParts/value-tonumber.js`,
  SHA-256
  `ec2d2f5eb7d46b32eeb69ce2ea8eaf22a6e71545bd80b33dbd8fff6af8b428fe`.

Both construct the default formatter and require real `ToNumber` behavior for
`undefined`, null, booleans, and numeric/non-numeric strings; the `format`
original additionally covers both infinities. An own `Symbol.toPrimitive`
observes exactly one `"number"` hint, and a Symbol input throws `TypeError` in
both originals. The `formatToParts` original additionally compares the length
and every `type` and `value` of the returned part records. A string-only
fallback, a host facade, or a direct-call-only special case cannot meet that
contract.

### Current source route

- `src/codegen/extern-declarations.ts` registers `NumberFormat` unconditionally
  as the `Intl_NumberFormat` extern class, with `format`, `formatToParts`, and
  `resolvedOptions` members.
- `src/codegen/registry/imports.ts`'s `collectUsedExternImports` registers
  `Intl_NumberFormat_new` for the typed new-expression and registers
  `Intl_NumberFormat_format` or `Intl_NumberFormat_formatToParts` for the
  property-call before expression lowering. This is the import-policy source
  of both compile errors.
- `src/codegen/expressions/new-super.ts`'s generic extern-constructor arm then
  calls `<importPrefix>_new`; `src/codegen/expressions/extern.ts`'s
  `compileExternMethodCall` generic fallback calls
  `<importPrefix>_<method>`. Changing only either final emitter would leave
  collection and lowering out of agreement.
- `src/codegen/expressions/identifiers.ts` materializes the ambient `Intl`
  namespace from `globalThis` only on the JS-host lane. Standalone leaves its
  user-global path at the null default. The typed constructor route and the
  user-global route are therefore separate obligations.
- `src/runtime.ts` maps the same constructor to the host's
  `Intl.NumberFormat` in its host constructor table. That is a host bridge,
  not an available standalone provider. Adding `NumberFormat` to
  `new-intl-host-bridge.ts` would merely turn the current compile error into a
  deliberate throw, which is not an implementation of this issue.

### Actual reusable substrate, and what is absent

The repository does have host-free mechanisms that a later design may use:

- `src/codegen/standalone-global-object-carriers.ts` and
  `src/codegen/array-object-proto.ts` seed and read the one native
  `globalThis` object; `src/codegen/builtin-static-globals.ts` and the object
  runtime can construct identity-stable namespace objects and descriptor-backed
  properties. They do not currently model an `Intl` namespace or a
  constructor-valued `Intl.NumberFormat` property.
- Native Map/RegExp paths demonstrate the required paired pattern: suppress an
  extern import only when a corresponding native constructor and member
  lowering claims the same expression. They are routing examples, not an Intl
  implementation.
- `src/codegen/coercion-engine.ts`'s `emitToNumber` and
  `src/codegen/tonumber-fast-paths.ts`'s `emitStandaloneObjectToNumber` are
  existing standalone coercion seams. A later formatter path must prove that
  its receiver/value representations actually take the correct one; it must
  not duplicate a partial conversion.
- `src/codegen/number-format-native.ts` supplies decimal formatting for
  `Number.prototype` methods. It has no ECMA-402 locale negotiation,
  numbering-system data, `Intl.NumberFormat` object model, or parts builder,
  so it can at most be a low-level decimal dependency.

No `Intl` semantic capability, CLDR/ICU/locale-data package, or
`Intl.NumberFormat` provider was found in the runtime-contract and IR-provider
paths. The QuickJS evaluation provider and the provider-local Temporal
DateTimeFormat shim remain evaluator/provider mechanisms, not compiled
user-visible `Intl` support.

## Proof gate before architecture selection

### Source-only audit of the two passing poison-prototype rows

A read-only audit against compiler revision
`359c2d63b6753e0c540b8761d13647b00e24a9a4` (compiler sources unchanged by
the runner-only census revision) identifies a possible masked-pass route.
This is source-supported inference, not an emitted-Wasm or runtime trace:

- Both originals assert only the `Test262Error` from the custom new target's
  Proxy `get` trap for `"prototype"`.
- `call-namespace-static.ts`'s standalone `Reflect.construct` arm admits the
  custom new target, then synthesizes a new-expression for `Intl.DisplayNames`
  or `Intl.Segmenter`. Its new-target check does not validate the target.
- `new-super.ts` documents missing checker identity for synthetic Reflect
  new nodes. The non-identifier property-access callee can miss the dynamic
  member route, become `__new___unknown`, and reach the absent-import null
  fallback without evaluating the Intl target.
- The outer Reflect arm nevertheless performs `Get(custom, "prototype")`;
  the Proxy getter can then throw the expected error. That throw alone does
  not demonstrate target evaluation, constructor availability, or correct
  construction ordering.

Relevant seams are `call-namespace-static.ts` lines 2315–2527,
`reflect-construct-newtarget.ts`'s classification and prototype-get helper,
`new-super.ts` lines 7287–7302 and 7621–8134, and
`declarations/import-collector.ts` lines 1470–1488. These pointers describe the
pinned revision, not stable line numbers across future rebases.

Before relying on these two passes as regression controls, capture the actual
emitted target route and pair them with observable target-evaluation and
invalid-target controls. Until that ordering proof exists, they remain
provisional. Keep the original expected exceptions unchanged; never
manufacture a constructor or suppress the getter to match this hypothesis.
This audit neither changes the measured 2/74 pass count nor attributes the
other 70 non-passes to this route.

No production change begins until the following evidence is captured against
the current pinned candidate and a declared baseline. Each reduction uses the
original Test262 source and harness unchanged; any added focused test merely
makes the same observable contract explicit.

1. Reproduce `test/intl402/Collator/proto-from-ctor-realm.js` in maintained
   standalone mode. Record whether the failure happens when resolving `Intl`,
   retrieving `Intl.Collator`, constructing it, or applying the cross-realm/
   new-target prototype logic.
2. Reproduce `test/intl402/Intl/getCanonicalLocales/has-property.js` and a
   minimal direct `Intl.getCanonicalLocales` control. Record the proxy `has`
   trap and exact exception ordering, so a null-property throw cannot be
   mistaken for a correct canonicalization implementation.
3. Reproduce both
   `test/intl402/NumberFormat/prototype/format/value-tonumber.js` and
   `test/intl402/NumberFormat/prototype/formatToParts/value-tonumber.js`.
   Capture the import list and the codegen route separately from runtime
   behavior; no compile error may be converted into an exclusion or hidden
   warning.
4. Retain both currently passing custom-get-prototype-poison originals as
   provisional regression controls, pending the target-evaluation and
   invalid-target ordering proof. Their abrupt `Proxy` behavior must continue
   to pass after a real namespace/API is introduced.
5. Add only after the four originals are characterized: a small standalone
   user-source control for `typeof Intl`, global identity through
   `globalThis.Intl`, ordinary member lookup, and user shadowing. It must
   distinguish a real ordinary object/function surface from a null, host
   externref, or provider-local lexical binding.

Every proof run must use an independently derived exact expected set and
preserve registered, started, settled, and canonical-verdict completeness. A
passing focused reduction is necessary evidence, not a reason to omit the
full 74-row rerun or the final 11,778-row completion run.

### Exact original-source `NumberFormat` proof gate

Before a production route is selected, run the two source hashes above as the
only paths in the maintained dynamic Test262 chunk with the standalone target.
The verdict-bearing path must keep the literal original harness assembly and
untouched upstream body; `wrapTest()` is a transformed diagnostic helper and
must not replace that verdict. Record the physical corpus revision, original
source hashes, harness assembly identity, command, compiler/provider artifact
identities, JSONL, completion receipt, and terminal exit.

Pair that maintained outcome with a diagnostic compilation of the same
`assembleOriginalHarness(...).primary.source` and the runner's compile options,
recording `result.imports` and, when a binary is available,
`WebAssembly.Module.imports`. The diagnostic is for attribution only; it does
not replace the maintained verdict. The baseline is expected to retain the
named `env::Intl_NumberFormat_*` imports and compile-error classification, not
to pass. A candidate must retain the exact source/harness/configuration,
remove every prohibited `Intl`/global import, and then demonstrate the original
runtime contract. The two existing poison-prototype rows remain separate,
provisional regression controls pending their ordering proof; no NumberFormat
result licenses a claim about them.

## Architecture decision requirements

Only after the proof gate, compare candidates for a host-free standalone
surface. The selected architecture must make user source observe real
namespace, constructor, prototype, property-descriptor, realm, brand, proxy,
and exception semantics for the supported API. It may not:

- delegate user-visible semantics to the JavaScript host or evaluator;
- use throwing stubs, test-name branches, hard-coded expected results, or
  changed Test262 metadata;
- repurpose #6442's provider-local lexical binding as a global implementation;
- retain `env::Intl_*`, `__get_globalThis`, or another forbidden host import
  in a standalone artifact; or
- silently narrow the 74-path or 11,778-path expected set.

The candidate design must explain both dynamic member access and typed/new
expression lowering. A fix that makes `Intl` an object but leaves constructors
or instance methods on a separate host-import route is incomplete. Conversely,
an implementation for one table-free DateTimeFormat scenario must not claim
general Intl coverage without its specified data and semantic surface.

## Proposed implementation stages, pending architecture and ownership clearance

These are source-grounded boundaries for a future implementation issue, not a
selected design or a production-file claim.

1. **Data and semantic architecture.** Select, version, license, package, and
   budget the actual locale and numbering data needed by the user-visible
   surface. There is no existing native Intl provider to wire in. The complete
   goal remains normal user-visible ECMA-402 semantics; a narrowly proven
   interim behavior can be recorded as evidence for named inputs, but cannot
   redefine issue completion, remove rows from the expected set, or be an
   all-throw placeholder API.
2. **One realm-owned namespace.** A shared-intrinsics owner would need a
   dedicated `Intl` namespace builder and coordinated changes around
   `compileIdentifierCore`, `emitBuiltinNamespaceObject`, and
   `appendStandaloneGlobalNamespaceSeeds`. The direct identifier and
   `globalThis.Intl` must expose the same native object with ordinary property
   descriptors and shadowing behavior; a second look-alike object would break
   identity.
3. **One paired native NumberFormat routing boundary.** The owner of
   `extern-declarations.ts`, `collectUsedExternImports`,
   `compileNewExpression`, and `compileExternMethodCall` must use one
   capability predicate. It may skip `Intl_NumberFormat_*` collection only
   after the native constructor and every claimed member route exist. The
   JS-host extern route remains intact, and an unclaimed shape must not quietly
   fall through after its import was suppressed.
4. **Branded formatter semantics.** A dedicated native formatter module/runtime
   would own instance state, constructor and prototype identity, `format`'s
   observable callable/property behavior, `formatToParts` arrays of actual
   `{ type, value }` records, `resolvedOptions`, data-driven formatting, brand
   checks, and canonical `ToNumber`/Symbol errors. Existing object and numeric
   helpers are substrate only; they do not supply these semantics.
5. **Proof and rollout.** First run the exact two-row proof gate, then retain
   the poison-prototype rows as provisional regression controls pending their
   target-evaluation and invalid-target ordering proof, and characterize
   additional original rows. A successful slice remains partial evidence until
   the frozen 74-row manifest and the unchanged 11,778-path bar are rerun with
   complete accounting.

## Data, provider, and ABI constraints

Intl behavior requires an explicit data plan, not an assumption that a QuickJS
evaluation provider supplies ICU semantics to compiled standalone code. Before
implementation, document:

- the locale, likely-subtag, alias/canonicalization, numbering-system,
  collation, segmentation, plural, calendar, and time-zone data each selected
  API needs;
- data provenance, license, versioning, deterministic packaging, artifact-size
  budget, cache-key/ABI impact, and the policy for unsupported data;
- how any interim, exactly characterized behavior is kept explicitly partial:
  it may not shrink the expected set, stand in for the full ECMA-402 goal, or
  replace missing semantics with a broad success claim; and
- how intrinsic-like objects are allocated, branded, attached to the user
  global, and isolated across realms without leaking host references.

The ABI proposal must show a standalone import scan and preserve the no-host-
import policy. QuickJS is the evaluator for these runs, not an authorization to
call its ambient `Intl`; any compiler bundle, provider, data payload, or
runtime-intrinsic change must identify its artifact key and verify that the
consumer uses the current linked pair.

## Ownership and overlap clearance

This plan owns no production files. Likely touch points include the ambient
identifier route, typed Intl constructor lowering/extern registrations,
standalone runtime intrinsics, data packaging, and possibly provider ABI; each
is cross-cutting and must receive a fresh overlap/assignment clearance before
an implementation issue claims it. In particular, do not modify the #6712
runner/completeness flow, #5206's host-only behavior, or #6442's provider-local
Temporal shim as part of this work.

The implementation owner must publish a bounded file list, use the current
frozen manifest rather than a mutable category index, and coordinate any
compiler/test slot before executing reductions or census runs.

## Acceptance for a later implementation slice

- [ ] Baseline and candidate evidence covers the four original non-pass
      controls and the two existing passing poison-prototype rows as
      provisional regression controls, with target-evaluation and
      invalid-target ordering proof plus source hashes, commands, imports, and
      exact outcomes retained.
- [ ] The selected surface gives normal observable semantics for the proven
      API contract, including user-global identity/shadowing, constructor and
      prototype behavior, proxy/error order, and realm-sensitive behavior
      where the originals exercise it.
- [ ] Standalone artifacts contain no prohibited host `Intl`/global imports;
      both prior NumberFormat compile-error rows become executable only through
      a host-free route, not an exclusion or a suppressed policy warning.
- [ ] The exact frozen 74-row manifest reruns with complete independent
      expected/registered/started/settled/verdict accounting and retains every
      non-pass for follow-up.
- [ ] A final candidate is measured against the unchanged 11,778-path frozen
      manifest. Discovery restoration and any subset improvement alone do not
      satisfy the ES2015 closeout goal.
- [ ] No intermediate `NumberFormat` or other Intl slice is represented as
      completion of this issue. Full user-visible ECMA-402 semantics and its
      required data remain the completion target.

## Coordination receipt

Issue number 6717 was reserved on 2026-09-28 after the repository assignment
and overlap checks reported no matching implementation claim. It is a local
Markdown planning record requested by `ttraenkler/codex-es2015-manifest`; no
GitHub issue or implementation claim was created by this plan.
