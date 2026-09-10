# Two open imports: preservation acceptance, strict closure still failing

2026-09-08. Final native Astra High N1 gate proposal, superseding the earlier
versions of this draft. Only this plan file was written by the sidecar.

## Authority and outcome

The user explicitly approved: **“Yes—separate preservation from retirement
proof”**, in response to the precise distinction that the two dynamic hooks
prevent whole-compiler static closure, while extraction may use six-real-caller
preservation and strict closure remains failing with retirement blocked.

That approval supersedes the earlier hold on narrowing the extraction check.
It does not approve runtime changes, exemptions from strict unknown reporting,
or a universal closure claim. Parent will read this final plan and authorize
Boyle's additive receipt/contract controls. This document is not a new writer
dispatch. No additional sidecar, session, agent, claim change or test run.

Implement two explicitly separate verdicts in the existing production auditor:

- **Preservation:** six original/canonical moved targets retain resolved
  source-reference paths from the real public root. Exact provenance records
  identify two retained open edges, which cannot supply any missing witness.
- **Strict closure:** both reachable nonliteral imports remain failures.
  Provenance does not resolve them. Retirement/deletion remains blocked.

The extraction's package check may select the approved preservation verdict
explicitly. The default strict invocation and its original tests keep their
current failing behavior on these unknowns. Never silently redefine an existing
strict boolean or label preservation success “full graph closure.”

## Source and measured evidence

Production source inspected read-only in
`/private/tmp/js2-3518-ir-foundation-checkpoint-20260907`, HEAD
`d71fab8b9565ad3a2bb567ed82f22e8750e804a4`:

- `src/optimize.ts` Git blob:
  `13ee034af6c141c44f67ef36744481d1c6e2b1b9`. Same blob at the earlier
  `57aa0d73025526812d06a3863d63552929618288` base.
- `src/runtime/platform-capability-adapter.ts` Git blob:
  `ea5e10a98f23e1cdacb50f190feb9a7011453162`. Inspected working bytes
  match the committed file at the production source HEAD.

Boyle's gate was inspected read-only in
`/private/tmp/js2-3518-moved-runtime-gate-20260907`, HEAD
`57aa0d73025526812d06a3863d63552929618288`, with uncommitted contents:

- `scripts/audit-legacy-reachability.mjs`:
  `6e8b9935819b7a2713dda3b25a101f6dc926cc7f`.
- `tests/issue-3518-moved-runtime-reachability.test.ts`:
  `e8e7972e8ee2c18b4969f5958bdd5178bbabfd5e`.

These are Git blob hashes, not SHA-256 file digests. Parent must pin Boyle's
actual final/composed revision; active work may have advanced after these reads.

Parent subsequently reports **39/39 gate controls**, an actual pre-relocation
strict failure on **two** reachable nonliteral imports, **6/6 full-root and
6/6 dispatch-cut target paths**, and the old ratchet **25/25 unchanged**.
Those measurements were not rerun here or attributed to the earlier dirty
gate hashes. Preserve their exact source/report hashes when parent publishes.

Parent reports PR 5733 green at queue position 1 and will not push the redundant
d71 refresh. The serial slot is released; parent proceeds with independent N1
byte/order acceptance. These are reported status, not fresh queue observations.
This proposal adds no push or pause request.

## The exact two production boundaries

### A. Optional optimizer provider

At `src/optimize.ts:383-384`, `getBinaryenModule` reads
`globalObject.__js2wasmBinaryenModuleSpecifier ?? "binaryen"` and executes
`import(/* @vite-ignore */ specifier)`. Its type assertion imposes no runtime
restriction. The source comment explains why a literal package import causes
approximately 13.5 MB of bundling; that size was not independently measured.

Actual callers include `compiler.ts:compileSource:1413` and
`applyOptimize:724`, after successful compilation. Despite nearby historical
comments, source contains both caller sites, and the optimizer tries native
CLI before the in-process module.

Preserve lazy loading, original importer/base location, nullish fallback,
global override, promise caching including failure/null, browser-like process
masking/restoration, `mod.default ?? mod`, CLI preference, optimizer feature
and level handling, output validation, original-binary fallback and warnings.
`tests/wasm-opt-optimize.test.ts:165` uses a local file URL override to force
module unavailability. It proves the override is not package-only, not that a
successful external runtime closure was inspected.

### B. Platform dynamic-import callback

At `src/runtime/platform-capability-adapter.ts:150-151`,
`resolvePlatformCapabilityImport` handles `intent.type === "dynamic_import"`
by returning:

```ts
(specifier: unknown) => import(/* @vite-ignore */ specifier as string)
```

The real binder `runtime.ts:resolveImport:11046` calls this adapter and uses
its returned capability before consulting compatibility semantics;
`buildImports` participates in that import-binding route.
`index.ts:ImportIntent` includes the discriminant. Existing host codegen in
`codegen/expressions/calls.ts` registers `env.__dynamic_import`.
Its standalone branch retains its eager/async refusal or deferred catchable
throw; this plan adds no standalone loader or host implementation.

This boundary has **no default package**. Preserve native dynamic-import
specifier conversion, Promise/namespace fulfillment and rejection, invocation
timing and importer-relative resolution. Do not add optimizer-style nullable
failure, default-export unwrapping, caching, or global-provider selection.
The returned callback is not a new root. Static visitation of its body does
not prove every compile executes it.

The existing adapters already define these production boundaries. Moving
either import into a new loader file changes no closure fact and risks changing
relative module resolution; no source extraction is needed for this gate fix.

## Why closure remains impossible and witnesses remain meaningful

Either hook can select local files, packages, URLs or loader-defined code.
Loaded modules can import repository code and have arbitrary side effects.
A default spelling, a TypeScript assertion, installed package .d.ts, observed
successful import, or boundary receipt cannot prove universal externality.

Boyle's current gate correctly reports both loads as
`status: "unknown", specifier: null, target: null` and fails strict acceptance.
Keep this behavior. Its external-library/builtin resolution establishes a
resolver/declaration boundary, not external runtime source closure. Arbitrary
method dispatch is also outside its stated top-level source-reference model;
even zero detected unknowns would not establish a universal runtime call graph.

Resolved source witnesses are positive evidence within that model. Additional
unknown edges cannot manufacture a missing source witness or prove absence of
other paths. Actual N1 execution and byte/order tests remain independent.
Six cut paths establish six modeled survivors, not that all supported
executions avoid direct codegen. An absent cut path is “no witnessed cut
path,” not proof of universal legacy-only use.

## Exact implementation map: no source writes, four gate/integration files

After parent authorization, Boyle's existing native Low continuation owns:

1. `scripts/audit-legacy-reachability.mjs`: additive structured diagnostics,
   two-site receipt validation and the preservation verdict. Keep strict
   failure collection/boolean, root discovery, graph edges, all six moved
   mappings and the ordinary dead-export ratchet intact.
2. NEW `scripts/compiler-extension-boundaries.json`: versioned records for
   exactly A and B, with the content/AST provenance below.
3. NEW `tests/issue-3518-open-extension-boundaries.test.ts`: additive tests of
   both verdicts, exact provenance and missing-witness controls, using the same
   production auditor. Do not edit or weaken Boyle's 39 existing controls.

Parent alone owns the fourth file in its isolated composition checkout:

4. `package.json`: append
   `--moved-reference-contract=preservation-v1` to the existing
   `check:dead-exports` command, preserving `--check` and all other checks.
   This explicitly wires the user-approved extraction verdict. Plain
   `node scripts/audit-legacy-reachability.mjs --check` remains strict.

No changes to optimizer/platform/runtime/compiler source, N1/F0/P/C/B files,
dead-export baseline, D0 layer policy, workflows, other configuration or
claims. This map follows Boyle's released slot; it is not permission to edit
its existing checkout. Compose the additive change and validate in the parent
slot before publishing the extraction result. Do not alter queued PR 5733
just to publish the redundant source refresh.

## Exact provenance records: never strict exemptions

Use versioned manifest entries `optional-binaryen-provider-v1` and
`platform-dynamic-import-v1`. Each contains:

- Exact repository-relative source path, reviewed source revision, actual
  content digest and algorithm `git-blob-sha1`. Compute from scanner-read bytes
  with the Git blob header, not from assumed clean HEAD. Use the two source
  blobs recorded above.
- A uniquely resolved AST import site and its lexical owner; source line is
  diagnostic only. A function name alone is never a match.
- `targetClass: "unconstrained"`, `mayEnterRepository: true`,
  `runtimeImplementationInspected: false`, `sideEffects: "unbounded"`,
  original importer/base, and `strictFailureExemption: false`.
- `permittedEvidenceUse: "source-reference-preservation-only"`. No absolute
  developer paths, package-only claim, ignored directory, or auto-refresh.

A's anchor is the import of the exact local `specifier` binding initialized
from the resolved `globalObject` alias of globalThis, the exact override
property and nullish default. Record `loadPolicy: "runtime-configurable"`
and `defaultSpecifier: "binaryen"`, separately from actual unknown target.

B's anchor is the import in the returned arrow of the `dynamic_import`
switch arm on the actual `intent.type` parameter. Its argument must resolve
to that returned callback's `specifier` parameter through the erased type
assertion. Record `loadPolicy: "runtime-callback-argument"` and
`defaultSpecifier: null`.

Require one anchor per record and both records exactly once in this manifest
version. Validate site presence/content against the full scan, separately from
whether a particular root search reaches the site. Missing, stale, duplicate,
swapped or ambiguous records fail preservation. A renamed file/function or
changed initializer/callback requires new parent-reviewed provenance.
Whole-file digest sensitivity is intentional, even for unrelated source edits.

Neither record supplies a target or adds/cuts graph edges. Keep scanning each
complete body, returned callbacks, module initialization and known imports.
Only those two exact unknown-site diagnostics can be identified as recorded
open boundaries for preservation accounting; they ALWAYS remain strict
failures. Every additional unknown/unresolved diagnostic fails preservation
too. No record covers another intent arm, `getNodeRequire()` result call,
dependency-provided callable or future load in the same function. Newly
detected unknowns in those areas remain blockers.

No loaded module, re-export, namespace object, extension callback or record
becomes a production root. Do not run providers or read this auditor process's
global override to invent a production target. Potential dynamic paths do not
count as any of the six required source witnesses.

## Two verdicts, explicit output and unchanged strict controls

Retain `movedRuntime.ok`, its failures and the default strict exit semantics.
Add `preservation` with a separately named result and explicit scope. Report:

- Expected six symbols and the existing original/canonical IDs.
- Concrete full-root and cut paths, nonempty visited counts and witness counts.
- Every raw unknown/unresolved load and external declaration/builtin boundary.
- The validated provenance records joined to exact load-site diagnostic IDs.
- Separate strict and preservation verdicts, plus
  `retirementCertified: false` for the open graph.

Preservation succeeds only if all six moved targets have resolved source paths
from the unchanged `src/index.ts#compile` root, all ordinary integrity and
dead-export checks pass, and the only remaining reachable resolution problems
are the exact two provenance-matched open sites. An approved record alone never
makes a missing target live. A third unknown fails. Missing public export,
unresolved local symbol/module, duplicate implementation, absent target or
empty denominator still fails.

Keep raw strict failures even on preservation success. The explicit flag selects
only the preservation result for this extraction command's exit code; no flag
auto-activation from a manifest and no replacement of the strict boolean.
Unknown/unrecognized flags/contracts fail rather than defaulting to success.

The measured pre-relocation baseline has six cut witnesses too. Report and
compare those during composition: loss of an existing cut witness is a
preservation regression to resolve, not something the unknown imports can
excuse. Full/cut unknown populations remain separately measured; do not
hardcode two reachable sites into every fixture or root search.

Example output for the reported production baseline, using measured counts:

```text
preservation PASS: 6/6 full source witnesses, 6/6 cut witnesses
strict closure FAIL: 2 reachable nonliteral imports (both targets unknown)
retirement/deletion NOT CERTIFIED
```

The default strict invocation still exits nonzero on this same report.
The flagged extraction invocation can exit zero only for approved preservation.
Existing strict fixtures still behave exactly as before. Retain graph-relative
classifications for compatibility, but identify their modeled-source scope;
do not promote “unreferenced” or “legacy-only” to universal absence claims.

Retirement/deletion consumers must check strict evidence and the certificate,
not package exit status or six witnesses. The old broad-root baseline remains
debt telemetry; neither its 25/25 stability nor this separation certifies
deletion. D0 clean-layer unknown/type-edge restrictions remain untouched.

## Additive acceptance controls for Boyle, after parent dispatch

Use the real checker on real fixture trees; no mocked passing graph.
Preserve the 39 existing controls and add these focused cases:

1. Nonempty closed fixture: both verdicts pass. Generic nonliteral
   import/require with six live targets: both fail, including in the explicitly
   selected preservation mode.
2. Two-adapter fixture with two exact records and six witnesses: strict fails
   with two retained unknowns; preservation succeeds. Both target fields remain
   null, local reentry remains possible, and retirement stays false.
   Verify strict and flagged process exits and complete serialized evidence.
3. Remove each source consumer in turn while retaining imports/re-exports and
   both adapters: preservation fails for the additional missing witness.
   Unknown failures cannot mask that assertion. Repeat with all consumers
   removed, only test callers, and only public re-exports.
4. Rename/delete a moved target or its destination, duplicate old/new bodies,
   remove/rename a public root/export: fail with all original six mapping rows.
   No renamed function becomes a root. Preserve dispatch-cut controls and
   before/after witness comparisons.
5. Delete either provenance record, swap hashes/anchors, duplicate A in place
   of B, point both records at one site, or delete/move/change either source:
   preservation fails. Source hashes alone cannot substitute for site joins.
6. Add a third reachable unknown in either adapter, a sibling or a literal-loaded
   initializer: fail, retaining all three unknown rows. Generic errors in the
   same function cannot borrow its approved site's record.
7. Change A's default/global/local binding or B's intent arm/returned parameter,
   shadow a binding, or change the import expression: stale provenance fails.
   Both unchanged hooks retain possible local/file/package targets; B never
   receives a fabricated Binaryen default or optimizer failure convention.
8. A potential or test-invoked dynamic provider calls a moved target after its
   real source consumer is removed: preservation still fails. Six actual
   source witnesses plus possible provider reentry can satisfy preservation
   only; strict closure always remains failing.
9. Literal local modules still resolve/traverse initialization; missing local
   modules/exports fail. Package .d.ts resolution is declaration provenance,
   not executable closure. URL, alias, package or symlink appearances cannot
   be laundered as universally external by either receipt.
10. Missing/malformed manifest in flagged mode, unsupported record fields,
    stale digest, unknown flag, missing scanner output or empty graph: fail.
    Plain strict mode does not auto-enable preservation. Unrelated new dead
    exports still fail both invocations.
11. Downstream retirement control rejects a flagged-success/open-graph report.
    Dropped unknown rows, missing certificate, wrong scope or a substituted
    always-green result fail evidence validation.
12. Keep manifest-site presence separate from reachability: making an adapter
    unreachable changes that search's unknown count, not the existence of its
    source record, target certainty, root set or universal closure claim.

Validate real-source anchors against both reviewed files in addition to fixture
records. Parent re-pins composed source/gate hashes and retains the actual
39/39, 6/6 full/cut and 25/25 evidence with its original provenance.
No runtime source changed, so do not expand host/linear execution work.
Existing optimizer/adapter tests remain intact; parent independently completes
N1 execution, byte/order, boundary and normal CI checks.

## Risks, limits and preserved work

The material risk is treating extraction success as retirement. Separate
verdicts, explicit console/JSON scope, retained unknowns, no dynamic liveness
credit and the retirement negative control are mandatory. Runtime/bundling
behavior stays unchanged. No optimizer or platform callback relocation,
restriction, caching change, namespace conversion or error-policy change.

Universal closure across arbitrary supported hooks would require additional
runtime/build constraints: fixed provider identity/content/resolution plus
adequate dependency/effect coverage or enforced isolation. Those are not
authorized here. A per-run loader trace cannot prove all conditional imports
or future override values. Standalone WasmGC output does not imply that the
compiler's optional JavaScript optimizer or preserved host adapter has a
universally closed runtime dependency graph.

The advisory `lower.ts` ↔ `wasmgc-emitter.ts` cycle remains already-known
future work; it is outside these four files and creates no duplicate dispatch.
The ABI seam remains pending. P/C drafts and generic wire contracts,
host/linear behavior, B's ten unresolved symbols, D's complete corpus, all
eleven issue-3518 retirement criteria and parent shepherding remain intact.

This final update implements only the permitted plan edit. No runtime/gate
code, tests, claims, commits, pushes, configuration, agents or sessions were
changed by the sidecar.
