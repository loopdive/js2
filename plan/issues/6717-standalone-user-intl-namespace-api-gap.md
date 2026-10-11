---
id: 6717
title: "Standalone user-visible Intl namespace/API gap: proof-first host-free semantics"
status: in-progress
assignee: ttraenkler/codex-6717-intl-locale-data-foundation
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
updated: 2026-10-02
es_edition: es2015
---

# #6717 — Standalone user-visible `Intl` namespace/API gap

## Status and boundary

This remains a proof-first plan for the user-visible runtime route: no
namespace/provider/IR implementation route is selected or owned yet, and this
issue does not claim that one defect explains every frozen Intl non-pass. The
bounded, host-free data-foundation slice below is deliberately selected and
owned; it is not a runtime implementation route.

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

## Active bounded data-foundation claim (2026-10-02)

`codex/6717-intl-locale-data-foundation` is implementing only a reproducible,
host-free **data foundation**. The branch owns exactly:

- `scripts/generate-intl-locale-data.mjs`;
- new `assets/intl/**` pinned input, provenance, license, and generated-table
  files;
- `tests/issue-6717-intl-locale-data.test.ts`; and
- this issue record.

It does **not** claim a user-visible `%Intl%` namespace, a constructor,
formatter, provider ABI, runtime/IR change, or a Test262 outcome. In
particular, `Intl.getCanonicalLocales` remains the first complete public API
for a later, separately cleared implementation slice; this branch supplies
data and deterministic generation only. The frozen 74 Intl originals and the
11,778-path ES2015 acceptance bar are unchanged.

### Data-foundation implementation plan

1. Pin the stable Unicode CLDR JSON `48.2.0` release by its verified immutable
   tag commit, not a rolling branch. Admit only the small public JSON inputs
   needed for generic language-tag canonicalization, Unicode-extension alias
   metadata, and an available-locales inventory, plus the upstream Unicode
   license/notice. Record every source URL, tag/commit, byte count, and
   SHA-256 in checked-in provenance before generation.
2. Add a Node built-in-only generator. It must fail closed on an unexpected
   release/schema/version, missing or extra required source fields, duplicate
   normalized keys, malformed aliases, hash/size mismatch, or generated-output
   drift. It must use stable Unicode code-point ordering, omit timestamps and
   host-dependent paths, and produce the same bytes on repeated generation.
3. Emit a generic, data-derived table set rather than a test-locale whitelist:
   language/script/region/variant aliases, Unicode extension key/type aliases,
   likely-subtag records when provided by the admitted source, and a sorted
   available-locales inventory. The generator must never ask host `Intl`,
   QuickJS, or ICU at generation or runtime for semantic fallback.
4. Add focused integrity tests for reproducibility, source/provenance hash
   enforcement, duplicate-provenance rejection, pinned release/version
   rejection, a known alias control, generic non-test-locale coverage, and a
   tampered-input negative. Failed fixture generation must leave the copied
   generated table unchanged. These are data-generation tests, not claims that
   a compiler namespace or formatter now exists.

The selected data source is CLDR JSON, not a direct ICU4X runtime dependency.
ICU4X remains a potential future offline-reference/datagen integration subject
to its own ownership and ABI proof; no cross-language integration is asserted
here.

### Pin and retained inputs

The public Unicode CLDR JSON `48.2.0` tag resolved to
`bb334e8d6250c9363e957e131bf7e6d08ec72f91`. Every raw URL is therefore
pinned to that commit rather than the movable tag spelling. The retained
Unicode-3.0 notice is the upstream `LICENSE` verbatim. The admitted source
set is intentionally small (485,618 bytes including the notice): supplemental
aliases, likely subtags, available locales, and the eight `u`-extension
metadata files (`calendar`, `collation`, `currency`, `measure`, `number`,
`segmentation`, `timezone`, and `variant`). It excludes CLDR archives,
formatter pattern data, installed packages, and any host-derived output.

`assets/intl/provenance/cldr-json-48.2.0.json` records each local path,
upstream path and commit URL, SHA-256, and byte count. The generator embeds
the same pin independently and rejects a changed provenance record, missing or
extra pinned input, malformed JSON (including duplicate keys), source
schema/version drift, or hash/size mismatch. Generated output will be
`assets/intl/generated/locale-data.json`; it contains no generation time,
absolute path, host-Intl lookup, or runtime fallback.

The raw inputs and generator-owned output are intentionally excluded by the
two narrow `assets/intl/...` entries in `.prettierignore`. This is not a broad
formatting suppression: lint-staged would otherwise rewrite `*.json`, changing
the upstream byte hashes or generator `--check` bytes. The provenance record
remains formatter-managed; the generator remains the sole serializer for the
two immutable data directories.

This data-only step still does not expose `Intl.getCanonicalLocales` or any
other public API. That later API must separately implement the ECMA-402
observable coercion, validation, and duplicate-elision semantics over this
data. The 74-row Intl diagnostic and full 11,778-path acceptance denominator
remain unchanged.

### Next public-API boundary (not owned by this data slice)

The frozen manifest currently contains exactly four
`test/intl402/Intl/getCanonicalLocales/` originals: `error-cases.js`,
`has-property.js`, `locales-is-not-a-string.js`, and
`overriden-arg-length.js`. They are a future acceptance design boundary, not
credit for this branch. A separately cleared `Intl.getCanonicalLocales` slice
must implement the full ECMA-402 grammar, observable coercion/property access,
validation, duplicate elimination, and generic alias handling over this data;
it may not specialize those four identities. Any namespace integration must
coordinate ownership of the currently dirty `identifiers.ts` route and may not
borrow the Temporal lexical shim.

### Data-foundation generation and validation evidence (2026-10-02)

The final generated `assets/intl/generated/locale-data.json` is 510,335 bytes
and has SHA-256
`e006613548e176f9bf836067be4de5afac68441acfd8142e4ed4612934c73632`.
Its checked provenance record has SHA-256
`7581c25f1407a1f5d7665b224b316ad23e6dd085ec9873928c31204a7f06ca30`.
The 11 retained JSON inputs total 483,585 bytes; together with the 2,033-byte
Unicode notice they match the admitted 485,618-byte source set. The final
generator `--check` receipt `f57e01` revalidated every pinned input hash/size,
the exact input file set, output reproducibility, and these counts: 766
available locales, 7,788 likely subtags, and 29 Unicode-extension keys.

Two initial fail-closed generation attempts are retained as schema-discovery
evidence, not validation failures or Test262 results. Receipt `a2c2cc` first
rejected CLDR's `islamicc` collision; inspection established that its alias is
the literal canonical `islamic-civil` and its `_preferred` is exactly that same
canonical spelling. The correction is generic: a collision is admitted only
when the alias's metadata `_preferred` equals the already-canonical literal;
the canonical lookup wins, and any other collision still throws. Receipt
`0d4c46` then exposed uppercase source placeholders such as `REORDER_CODE`.
The generator now derives placeholders generically instead of treating them as
literal BCP-47 types. Neither rule names `islamicc` or a tested locale.

The final focused suite receipt `84f35e` is 1 file / 7 pass / 0 fail (3.42 s)
on Node 24 through the linked local Vitest route. It covers reproducibility,
full provenance pin data, generic aliases/non-sample inventory, the legitimate
preferred/canonical collision and an ambiguous negative collision,
duplicate-provenance rejection, un-hashed release mismatch rejection,
byte-identical copied regeneration, and a hash-tampered input. Each failed
fixture generation asserts that its preexisting copied output remains
unchanged. An earlier 5/5 receipt `b55bdc` predates the two added provenance
negatives. Receipt `fa1e93` is a zero-executed setup error (this fresh
worktree had no `node_modules` link); it is not a test verdict. A subsequent
package-script invocation forwarded a literal `--`, started an unrelated
`issue-5383` suite, and was stopped at exit 130 before any #6717 verdict; it
is likewise a non-result. The corrected direct local route produced `b55bdc`
and `84f35e` only after that session had terminated.

Normal gates passed: TypeScript typecheck receipt `18b3d1`; Prettier
format-check wrapper `196` / nested process `99249`; LOC and function budgets
receipt `4e69ae`; and post-gate generator/hash/diff check `f57e01`. The two
narrow `.prettierignore` entries for `assets/intl/pinned-input/**` and
`assets/intl/generated/**` protect upstream/generator bytes from lint-staged's
`*.json` rewrite; the generator remains their deterministic serializer and
provenance JSON remains formatter-managed. This data-only evidence changes no
Test262 verdict, does not expose `Intl.getCanonicalLocales`, and does not
complete #6717.

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

## 2026-10-02 current-main asset and ownership handoff

A read-only audit at upstream `e473d92460af75ced29e9666e7e97cdde8df12ca`
found no installed host-free Intl provider or locale-data foundation to reuse.
Package declarations, lock/module metadata, `node_modules/.pnpm`, and package
resolution checks found no FormatJS Intl, CLDR, full-icu, or ICU4X dependency.
The repository asset scan found no CLDR/ICU, likely-subtag, alias, or locale-data
payload. This is evidence about this checkout, not proof that those projects
cannot provide a suitable future dependency.

Current source boundaries remain separate:

- `standalone-global-object-carriers.ts` seeds Array/Object/JSON/Math/Proxy/Reflect,
  not Intl; `builtin-static-globals.ts` has no Intl namespace identity.
- `extern-declarations.ts` still declares NumberFormat using the host
  `Intl_NumberFormat` route. Its paired import collection, construction, and
  method lowering must be changed together for a native route; merely exposing
  a namespace would leave the two forbidden-import originals unresolved.
- `runtime.ts` supplies NumberFormat through host Intl, and `identifiers.ts`
  intentionally materializes ambient Intl only off standalone/WASI. Preserve
  the completed host-only #5206 behavior.
- `number-format-native` supplies decimal Number.prototype behavior, not
  locale matching, locale formatting, formatter state, or formatToParts.
- #6442's lexical Temporal-provider shim remains restricted to en/en-US and
  UTC/fixed Etc-GMT zones. It is not a user-global Intl implementation.

No issue 6740 or separate production implementation claim was found in the
checked worktrees. This existing issue is the applicable unassigned plan;
the historical 74-row result is still not a current-main measurement. No
Intl test run, dependency installation, production edit, or completion claim
was made during this audit.

Next implementation-plan step: select and pin a standards data foundation
using primary-source provenance/license/version evidence; specify deterministic
packaging and artifact/cache limits; prove a host-free canonicalization and
locale-match core. Then claim a coordinated realm-namespace and NumberFormat
slice with a bounded file list and fresh overlap clearance. Candidate seams
include identifiers/global carriers/static globals and the paired extern
registration/import/new/method routes, plus a dedicated formatter/data owner.
Do not modify the existing host bridge, the Temporal lexical shim, or held IR
migration areas. All 74 Intl identities and the full 11,778-file goal stay in
scope; selecting only the tested locales or replacing missing semantics with
a throwing shell is not an implementation strategy.

### Selected planning direction: offline generated locale tables

Use pinned CLDR JSON as offline source input to a deterministic repository
generator, rather than assume host Intl or an installed ICU provider exists.
The [CLDR release index](https://cldr.unicode.org/index/downloads) lists the
stable 48.2 release and corresponding cldr-json 48.2.0 tag. Before ingesting
data, record the exact tag/commit, input-file hashes, the pinned release's
license/notice, generator version, generated-table hash, measured byte sizes,
and artifact/cache-key effects. No download, new dependency, or runtime
implementation has happened yet. No project-specific size estimate is claimed.

First complete public API: `Intl.getCanonicalLocales`, with a general locale
parser/canonicalizer, Unicode alias data, duplicate suppression, and the
observable access/conversion/error ordering required by
[CanonicalizeLocaleList](https://tc39.es/ecma402/#sec-canonicalizelocalelist).
Do not implement only the locales mentioned by current tests. Prepare an
internal standards-defined lookup matcher over generated available-locale
data; do not expose a formatter's supportedLocalesOf before its data and
semantics actually exist. Best-fit matching needs an explicit data-backed
policy, not an unlabelled prefix-lookup substitute.

ICU4X is a possible alternative data/runtime architecture, not inherently
incompatible merely because it is written in Rust. Selecting it would require
separate reproducible toolchain, Wasm linking/ABI, import-policy, and data-size
proof. The current recommendation favors generated tables because the repo
has none of that integration today. Keep this choice revisitable from measured
evidence; full Intl semantics and all frozen originals remain the target.

### 2026-10-02 foundation publication and full first-API integration handoff

The bounded data foundation is now published as ready upstream
[PR 6427](https://github.com/loopdive/js2/pull/6427), head
`a7bace6c7d227b9ca612b3d6dc0453b5c9c9de14`. Root verified its immutable
plan link, non-draft/mergeable state, and corrected Description/Validation/CLA
body. Seven focused checks and normal commit/pre-push gates passed; the
generated 510,335-byte table and pinned source bytes survived hooks. The
earlier statement that no data had been ingested is superseded by this bounded
publication. It remains a data-only prerequisite, not an Intl namespace/API
or a Test262 improvement. Do not mutate that completed PR into the next slice.

The existing owner's subsequent read-only architecture audit finds four
integration dependencies for a complete `Intl.getCanonicalLocales`, rather
than a useful-looking but unreachable new parser module:

1. **One public ordinary-object identity.** Register the supported static
   namespace in `builtin-static-globals.ts`; prove the existing early generic
   namespace branch in `expressions/identifiers.ts` works before touching that
   held file. Coordinate `standalone-global-object-carriers.ts` and the
   `array-object-proto.ts` namespace guard so bare `Intl` and `globalThis.Intl`
   are the same object. Preserve its noncallable ordinary-object shape and
   `Symbol.toStringTag` descriptor rather than treating Intl as a constructor.
2. **One real callable closure.** Coordinate `builtin-value-read.ts`,
   `builtin-fn-meta.ts`, and `property-access-dispatch.ts` so direct, extracted,
   computed, and global-object reads reach the same cached method closure with
   correct name/length/descriptors. The proposed ABI is
   `(self, locales: externref) -> externref`. Do not add a duplicate direct-call
   fast path in held `calls.ts`; first prove the existing static/namespace
   delegation. The method must implement semantics, not an unknown-method
   TypeError placeholder.
3. **Observable generic list semantics.** Implement the actual ECMA-402
   `CanonicalizeLocaleList` algorithm, including undefined/string handling,
   native ToObject, one length Get and ToLength, each index HasProperty before
   Get, type checking/ToString, structural validation, canonicalization, and
   post-canonicalization deduplication. Use normal string-key property helpers;
   intrinsic length/index shortcuts would miss Proxy and inherited-property
   observations. `src/runtime/wasmgc/values/to-object-body.ts` contains a
   semantic builder but is not wired into the generic standalone path;
   `expressions/calls-guards.ts` still retains the no-host identity fallback.
   Primitive-wrapper/prototype factories and object-runtime ownership need
   explicit coordination. Prove the returned carrier has real Array behavior,
   not merely private list layout.
4. **Compiler-consumable data and generic grammar.** Wasm cannot load the
   checked-in assets from the filesystem. An approved generator extension
   must emit deterministic compiler-consumable static source or a formal
   source resource, retaining pin/hash/schema/notice checks. Implement generic
   Unicode BCP47 locale identifier grammar and alias/extension canonicalization,
   not a whitelist of current test locales. Available-locale inventory is not
   a validity filter. The absent native InitializedLocale discriminator must
   be explicitly handled or proved unrepresentable until Intl.Locale exists;
   do not silently replace its required behavior with ordinary ToString.

The standards references are
[CanonicalizeLocaleList](https://tc39.es/ecma402/#sec-canonicalizelocalelist),
[IsStructurallyValidLanguageTag](https://tc39.es/ecma402/#sec-isstructurallyvalidlanguagetag),
and [Unicode locale identifiers](https://unicode.org/reports/tr35/tr35.html#Unicode_locale_identifier).
These are implementation dependencies, not claims that any runtime boundary
has been cleared or implemented. A new source module alone is not an
acceptable Node-only substitute for a runnable standalone API.

Before implementation in a separate branch/worktree, coordinate the exact
namespace/object-runtime hunks with existing owners and the other-machine IR
migration. Then verify all four frozen originals (`error-cases.js`,
`has-property.js`, `locales-is-not-a-string.js`, `overriden-arg-length.js`)
with maintained manifest completeness, plus standalone generic controls for:
public identity and descriptors; Proxy Has/Get and abrupt-completion order;
holes and inherited Number-prototype properties; observable length conversion;
generic valid/invalid tags and aliases outside fixture examples; deduplication;
and true Array results. No host Intl, private Temporal shim, hidden fallback,
or denominator reduction is permitted. The full 74-row Intl diagnostic and
11,778-row goal remain outstanding.
