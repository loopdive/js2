---
id: 6834
title: "Test262: route entry-only default and named self-imports through the module graph"
status: in-review
created: 2026-10-02
updated: 2026-10-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: test262-runner
goal: standalone-mode
assignee: ttraenkler/module_self_import_sol
related: [6651, 3491, 2930, 2900, 4759, 2961, 2864, 5157]
files:
  - scripts/test262-fixture-graph.mjs
  - tests/test262-shared.ts
  - scripts/test262-fyi-reader.mjs
  - scripts/run-test262-fyi.mjs
  - scripts/compiler-pool.ts
  - scripts/test262-worker.mjs
  - tests/issue-6834-module-self-import-graph.test.ts
---

# #6834 — Test262 entry-only value self-import graphs

## Status and ownership

Implementation plan prepared by Astra against verified upstream commit
`56680e7feb87a090ee8846c8ecb7718933cd3781`. No compiler or execution test was
run while preparing this plan. Root approved the plan and Astra stopped
writing before handing sole issue/source/test ownership to Sol 6.1 with
**high** reasoning effort. The owned checkout is
`/Users/thomas/Code/js2/.codex-worktrees/6834-module-self-import`, branch
`codex/6834-module-self-import`. Main is a dirty, read-only orchestration
checkout. The issue number and assignment were allocated by root; do not
create a GitHub issue or modify another lane's registry metadata.

Only the six production transport/discovery files and new regression file
listed above are implementation scope. This plan is the planner's only write.
Preserve other changes and shared dependencies. Do not install dependencies,
change shared Git configuration, delete worktrees, or stop running tests.
The concurrent #6833 lane holds the initial heavy-test lease; build/compile/
execution validation starts only after root transfers that lease.

## Problem and evidence

Three originals in the prior complete ES2015 measurement failed with the
correct standalone refusal for the unresolved host import `env::g`:

- `language/module-code/eval-export-dflt-expr-gen-named.js`
- `language/module-code/instn-named-bndng-dflt-gen-named.js`
- `language/module-code/instn-named-bndng-dflt-gen-anon.js`

Their original source statically imports its own default export as `g`.
The fixture collector discovers only `_FIXTURE.js` dependencies. A fresh,
read-only Node inspection at the commit above reproduced **3/3** records with
the correct canonical entry path, empty `fixtureFiles`, empty
`dynamicFixtureFiles`, and a false namespace-self-import predicate. The new
source has not been compiled or executed; the three old compile errors are
historical evidence, not a fresh-main verdict.

The maintained runner in `tests/test262-shared.ts` selects its existing
in-process literal graph route for nonempty fixture maps or namespace-tree
self-imports. FYI independently attaches `selfModuleGraph` only through
`hasPinnedNamespaceSelfModuleImport`; its worker repeats that check. Neither
admits these default self-imports. Single-source preprocessing in
`src/import-resolver.ts::preprocessImports` substitutes an unresolved import
stub. Multi-source compilation resolves a real module graph and existing
`registerImportBindingAliases` in `src/codegen/index.ts` registers default,
renamed, and anonymous-default aliases before bodies. That is a plausible
existing resolution path, not proof of generator execution correctness.

The old complete 11,778-original result (11,443 pass / 311 fail / 24 compile
errors at `cd123eca318c12a8480e8a69383ddfd50d6e4db4`) must not be presented as
the baseline for this new commit without fresh matched measurements.

## Semantic contract

The graph must resolve the import to the **same entry module and binding**.
It must not copy the entry into a fixture or initialize a second entry.
Current [Source Text Module InitializeEnvironment](https://tc39.es/ecma262/multipage/ecmascript-language-scripts-and-modules.html#sec-source-text-module-record-initialize-environment)
resolves named imports through the imported module's export record and creates
import bindings. [ResolveExport](https://tc39.es/ecma262/multipage/ecmascript-language-scripts-and-modules.html#sec-resolveexport)
can resolve to the defining module itself; unresolved circular re-exports are
a different case. The originals also require generator declaration hoisting,
default-expression initialization, and function naming. Those remain real
runtime assertions, with no source rewrite or harness substitution.

## Implementation Plan

### 1. Add a strict, independent admission predicate

In `scripts/test262-fixture-graph.mjs`, add a shared predicate such as
`hasPinnedEntryValueSelfImport(entryFile, source)`, then expose
`requiresEntrySelfImportGraph: true` from `discoverFixtureGraph` only when
the predicate passes and the static fixture map is empty. Omit the optional
flag otherwise; consumers require `=== true`. Keep the old three fields and
the namespace predicate unchanged.

Choose the smallest scope: entry-only graphs in
`language/module-code/`, excluding its `namespace/` subtree. Every static
module edge in this new admission must be a supported value self-import.
Graphs containing real fixtures already have a route and need no new flag.
This stronger boundary satisfies the requirement that no unrepresented
non-fixture edge be admitted without widening fixture behavior.

Admission requirements:

- Entry is a canonical `./language/module-code/...js` virtual key, with no
  empty, dot, parent, backslash, absolute, query, or fragment component and no
  `_FIXTURE` identity. Validate before path normalization can erase evidence.
- Source parses successfully. Inspect actual top-level import declarations,
  requiring at least one default import or nonempty named value import,
  including `import { default as g }`. Reject type-only clauses/specifiers,
  namespace clauses, side-effect imports, empty named import clauses, and
  import attributes/phases outside this ES2015 contract.
- Reject nested static import declarations and TypeScript ImportEquals nodes
  anywhere in the syntax tree; parsing a node is not proof it is valid Module
  syntax. Reject all-type named specifier lists as well as whole-clause type
  imports. Inspect template interpolations for real nested dynamic imports.
- Every static import has a relative literal `.js` specifier whose normalized
  target is exactly the canonical entry. No extension probing, package/bare
  specifiers, URLs, missing nonself siblings, or root escapes. Relative
  `./sub/../entry.js` may resolve to the entry, but the **entry key itself**
  must stay canonical. Do not use filesystem realpath to rename virtual keys.
- Reject all export-from declarations for this new route. Local
  `export { f as default }`, default declarations, and default expressions are
  permitted. Reject dynamic imports, including nested ones, for this initial
  slice; they are not static graph edges. Preserve existing dynamic routing
  when the new predicate declines.
- Comments, quoted strings, regular expressions, templates and their nested
  syntax cannot create an import match. Malformed/unrecognized syntax must
  decline admission, not assert that no other edge exists.

Use an existing parser, not a new text regex or handwritten JavaScript lexer.
The existing `typescript` dependency can parse a JS SourceFile and enumerate
top-level statements without creating a compiler program or invoking codegen.
Load it lazily with the existing Node module mechanism so ordinary fixture
discovery stays cheap; a cheap textual prefilter may reject obvious
noncandidates but must never authorize a graph. Parse with ScriptKind.JS and
decline on parse diagnostics and unsupported import syntax. Keep this helper
in the existing `.mjs` module: no new dependency, compiler API, IR node,
frontend migration, or production `src/` change. If the current migration
contract prohibits this parser-only use, report that concrete restriction to
root before substituting a broad scanner or editing a compiler seam.

### 2. Thread discovery through every owned consumer

- `tests/test262-shared.ts`: extend the current graph selection with the
  explicit discovery flag. Reuse its literal `compileSource`, original entry
  key, existing `compileMulti` options, standalone import check, runtime wiring,
  and deferred initialization. This is an **in-process** graph path; adding a
  worker flag alone would not change the maintained run. Preserve the current
  namespace decision separately. Reject entry-map collision before building
  the virtual map; do not silently overwrite an entry supplied as a fixture.
- `scripts/test262-fyi-reader.mjs::attachFixtureGraphs`: attach discovery's
  empty graph when the new flag is true, as well as the old fixture/dynamic/
  namespace cases. Preserve literal `contents`, flags, negatives, and strict
  reruns. Re-export the predicate only if tests or consumers need it.
- `scripts/run-test262-fyi.mjs::FyiSourceExecutor`: send the boolean only when
  true along with the original `entryFile` and empty object `fixtureFiles`.
  Never infer graph validity from the entry path or map truthiness alone.
- `scripts/compiler-pool.ts::runTest`: add an optional typed boolean and an
  explicit allow-list forwarding member. An omitted field remains undefined;
  false never activates the route. `runTest` through `new CompilerPool(1,
  "unified")` must exercise the same contract as FYI. The compile-only worker
  remains out of scope; do not add an unrelated graph API to `compile()`.
- `scripts/test262-worker.mjs`: document the protocol field and add an
  independent validator requiring explicit true, original-harness mode, a
  record-shaped **empty** fixture map, canonical entry, and the same source
  predicate. A supplied boolean is never proof. Compute graph selection as
  existing nonempty fixture graph OR existing namespace graph OR validated
  entry-value-self graph. Invalid new requests stay on the existing route.
  Preserve `doCompile`'s entry-collision check for every graph, its original
  negative options, `allowJs`, and actual `...deferOpt`. The nearby comment
  saying graphs omit deferral is stale; do not follow it instead of code.

The worker revalidates assembled literal source; discovery usually sees the
raw original. Assert that harness assembly does not change admission. Do not
pass native/linked-harness body fragments as a literal graph entry.

Reader inventory: `discoverFixtureGraph` is also consumed by the legacy
monolithic runner and older unit tests; adding an optional property must not
activate those routes implicitly. `tests/test262-runner.ts` has its own
namespace-only helper route and is not the authoritative instrument for this
repair. Leave it and `tests/test262-vitest.test.ts` unchanged in this slice;
record the deliberate scope if a local helper still differs.

Module format inventory: the pool selects `test262-worker.mjs` for unified
jobs and uses `import.meta.dirname ?? __dirname`; FYI resolves a sibling
`test262-worker.mjs` in the repo or bundled `test262-worker.js` in dist.
Both must retain the same flag contract. Use module-compatible lazy parser
loading (no unguarded CommonJS `require` in ESM); do not hand-edit generated
bundles or create a third CJS worker implementation. A pool forwarding test
must cover its explicit allow-list, which otherwise silently drops new fields.
The implementer's existing generated CJS test-worker control dynamically
imports the fixture-graph helper beside the worker; verify that path and the
new export before relying on it. Exercise the same payload through that
control and the ESM worker without changing production module resolution.

### 3. Verify transport before claiming original-test gains

Add `tests/issue-6834-module-self-import-graph.test.ts`; split pure discovery
and compile/execution groups so only the former can run without the lease.
Keep existing tests intact and use their controls.

Pure controls must include all three original source bytes; default/named/
renamed/default-as-named synthetic imports; import spelling across lines;
multiple self imports; and empty fixture maps with no duplicated entry.
Reject namespace-only, default-plus-namespace, side-effect-only, export-from,
dynamic-only, self plus nested dynamic import, self plus nonself/bare/URL
import, comments/strings/regex/templates containing import-looking text,
noncanonical entry keys, malformed source, and type-only imports. A self plus
real fixture source retains normal fixture graph behavior with no new flag.

Execution controls must cover a simple default function and named binding,
identity equality through two aliases, a named live binding updated after
initialization, and entry side effects occurring exactly once. Run those
through FYI and the unified pool. Include missing/false/forged flag cases,
missing or array fixture maps, originalHarness false, and the existing
entry-collision rejection. A valid non-generator value-self control must
prove the transport independently of generator support. An external-import
negative control must retain its refusal/failure; never turn a missing module
into an expected SyntaxError or a pass. Match negative behavior against base.

For the original trio, retain untouched original bodies and harness. Prove
the flag-off control reproduces the old `env::g` leak in the authoritative
worker and the flag-on path removes it. Inspect actual Wasm module imports
as well as the verdict; an empty compiler import report alone is insufficient.
Then measure runtime assertions, including generator value, name, hoisting,
same-module identity, and one initialization. A compile success or CE-to-fail
transition is **zero pass gain**.

## Validation commands and evidence

Create worktree-local manifests and logs with normal file tools. Never alter
the donor corpus. Record exact base/candidate SHA (or dirty patch hash),
Test262 donor `b363f29d3c43c626dc852744ad64a0b48a003693`, selected-original
blob verification, runtime, harness/oracle version, target and provider mode.
The before and after arms must use identical manifest bytes and settings.

After root grants the heavy-test lease, use the existing bundle scripts:

```sh
pnpm run build:compiler-bundle
pnpm run build:runtime-bundle
pnpm exec vitest run tests/issue-6834-module-self-import-graph.test.ts tests/issue-3491-test262-fyi-module-fixtures.test.ts tests/issue-2930.test.ts tests/issue-2900.test.ts tests/issue-4759-fyi-self-namespace-routing.test.ts --maxWorkers=1
```

Capture the base original-run evidence before production edits. Light parser
experiments may proceed after plan approval without modifying the base source.
The FYI CLI enforces its own Node runtime contract; use the maintained Vitest
wrapper for the pinned local runtime baseline rather than disabling that CLI
guard. Keep runtime and CJS/ESM harness choices matched between A/B arms.

The historical control issues are #3491, "Test262 FYI original-harness lane
must link static _FIXTURE module graphs"; #2930, "codegen: import binding
whose local name differs from the target declaration name resolves to null";
#2900, "module indirect default-export binding update returns wrong value";
and #4759, "ES2015 module namespace Test262 residuals". Their checks cover
literal source, fixture cycles, default/anonymous aliases, and deferred init.

Freeze a manifest with `test/`-prefixed original paths: the three targets,
`language/module-code/instn-iee-bndng-let.js`,
`language/module-code/instn-star-props-circular.js`,
`language/module-code/namespace/Symbol.iterator.js`,
`language/module-code/ambiguous-export-bindings/error-import-named.js`, and a
verified currently passing ordinary single-source control. Add all originals
newly admitted by the predicate in the frozen ES2015 scope after a read-only
admission census; do not assume the trigger population is exactly three.
Validate existence and donor bytes before freezing. The positive control's
baseline PASS is required; the negative control need not be a baseline PASS.

Use the maintained sharded original-harness runner for fresh A/B, in the
appropriate isolated checkout for each arm:

```sh
TEST262_TARGET=standalone TEST262_SEMANTIC_PROVIDERS=auto \
JS2WASM_EVAL_ENGINE=quickjs TEST262_ORACLE_MODE=honest \
COMPILER_POOL_SIZE=1 NODE_OPTIONS=--max-old-space-size=4096 \
TEST262_EXACT_MANIFEST_FILE="$PWD/.tmp/6834-exact.txt" \
bash scripts/run-test262-vitest.sh --maxWorkers=1
```

The wrapper chooses its checkout from dirty state: verify the logged actual
checkout and source hash before interpreting results. Retain its timestamped
JSONL, exact manifest snapshot, every v2 completion receipt, and run log in
lane-local evidence; no source edits while either measurement is live. Do not
use a one-shard override unless its expected identity set is proved complete.
Run the maintained validator with the real result and all receipt paths:

```sh
node scripts/validate-test262-completeness.mjs \
  --input <timestamped-results.jsonl> \
  --manifest <shard-1.complete.json> --manifest <each-other-receipt> \
  --expected-shards 16 --expected-paths-file .tmp/6834-exact.txt
```

Angle-bracket arguments above are evidence filenames to substitute, not
literal shell arguments. Require exact identity equality, no duplicates,
missing or unexpected rows, no exclusions/skips, and complete callbacks.
FYI API tests establish worker transport; the maintained runner with receipts
establishes scored original outcomes. Do not call a non-authoritative FYI
smoke or `runTest262File` result equivalent to that evidence. Report targeted
denominators and per-original transitions. Root owns the later whole-scope
verification; this slice cannot claim 100% ES2015 from a targeted pass.

## Acceptance and stopping conditions

- [x] New admission is parser-backed, conservative, independent of namespace
  routing, and validated on both raw original and literal harness assembly.
- [x] The optional flag reaches maintained selection, FYI IPC and unified pool
  IPC without silent drops. Omitted/false flags preserve previous behavior.
- [x] Exactly one entry is linked; its fixture map remains empty and collision
  protection survives. No original or harness source is rewritten.
- [x] New non-generator controls execute correctly with no host import and one
  initializer. Existing namespace, fixture/cycle, aliases and init controls
  retain base behavior in relevant host and standalone paths.
- [x] Fresh matched complete-receipt A/B records all admitted originals and
  the three historical targets. Every claimed gain is a runtime PASS with
  no forbidden host imports in the actual Wasm import list; existing compiled
  runtime-eval provider imports are listed explicitly below. Any remaining
  failure is stated.
- [x] No guard weakening, scoring/oracle change, skip, test rewrite, import
  suppression, baseline edit, new IR surface, or production `src/` change.

The generator layer is owned elsewhere: #2864, "Standalone: no Wasm-native
generator carrier — sync generators leak __create_generator/__gen_* host
imports", is in progress under `ttraenkler/fable-es2015`; #5157, "ES2015
standalone: modules-eval-with conformance wave 1", is in review and names
generator module-binding cases. Do not edit generator lowering, alias
registration, compiler resolution, prepared program/IR, or migration routing.
If graph activation exposes a generator brand/name/hoisting/initialization
failure, record the exact original, import list, fresh runtime signature and
base/candidate identity, then hand it to root for coordination. The transport
fix may be reviewable with zero conformance gain, but must not be reported as
three solved tests. If even the non-generator graph controls require compiler
changes, stop at that measured blocker rather than forcing this plan's premise.

Planner verification: only source reads, specification reads, and the 3-record
discovery probe were performed. Initial Git status hit a sandboxed LFS clean
filter write. Root's normal escalated status confirmed only this issue file
was untracked; the filter-disabled apparent `acorn.wasm` modification was not
a tracked change. No LFS asset or shared configuration was repaired.

## Fresh baseline receipt (2026-10-02)

Before production edits, an ignored prospective AST census checked the frozen
11,778-original manifest (canonical SHA256
`632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360`).
It found **five** newly admitted originals, not only the historical three:

- `test/language/module-code/eval-export-dflt-expr-gen-anon.js`
- `test/language/module-code/eval-export-dflt-expr-gen-named.js`
- `test/language/module-code/instn-named-bndng-dflt-gen-anon.js`
- `test/language/module-code/instn-named-bndng-dflt-gen-named.js`
- `test/language/module-code/instn-named-bndng-gen.js`

The 10-path frozen measurement manifest also contains five controls. Namespace
`Symbol.iterator.js` and Array `isArray/not-a-constructor.js` belong to the
frozen goal. The fixture-binding `instn-iee-bndng-let.js`, fixture cycle
`instn-star-props-circular.js`, and resolution-negative
`ambiguous-export-bindings/error-import-named.js` are separate controls outside
the frozen goal; they never count as goal gains. Every selected file's Git blob
was checked against donor `b363f29d3c43c626dc852744ad64a0b48a003693` using a
nontruncated recursive tree plus the blob header/hash of actual file bytes.
Selection receipt: `.tmp/6834/selection.json`; manifest:
`.tmp/6834/exact.txt`, SHA256
`e3d5d7dd5d8c683fed3fe384aed1df1f71aa57c3840195cd7885334bb4ff7bc4`.

The maintained wrapper ran the pristine production base
`56680e7feb87a090ee8846c8ecb7718933cd3781`, in this assigned checkout, under
Node 24, standalone target, automatic semantic providers, QuickJS, and the
honest oracle version 14. An ignored one-shard entry imports the unmodified
`runTest262Chunk(0, 1)` rather than selecting one of 16 partial shards. The
wrapper used `.tmp/6834/originals.test.ts` and its ignored Vitest config, with
the exact manifest as both selection and expected identity set. The real v2
completion receipt and an independent validator both confirmed **10 verdicts,
10 registered, 10 callbacks started/settled, no exclusions**, proving that this
single shard covered the full selected set. No production mutation occurred
while measurement was live.

Run timestamp `20261002-222142`, process handle `98700`, terminal wrapper exit
0, log `.tmp/6834/base-run.log`. Exit 0 certifies completed reporting, not
passing conformance. Result: **3 pass / 1 fail / 6 compile errors / 0 skips**.
All five newly admitted goal originals are compile errors: four retain
`env::g`, while `instn-named-bndng-gen.js` retains `env::g2`, rejected by the
unchanged standalone host-import guard. Namespace, fixture cycle, and ordinary
Array controls all pass (**3/3**). The fixture-binding control fails with
`[object WebAssembly.Exception]`; the resolution-negative control has a compile
error `Invalid value used in weak set`. These are measured baseline failures,
not expectations to weaken or recategorize.

Artifacts are under `benchmarks/results/` with the above timestamp: JSONL,
report, exact-manifest snapshot, and
`test262-standalone-results-20261002-222142.shard-1-of-1.complete.json`.
The immutable supplied QuickJS artifact was verified (SHA256 prefix
`073742801ba76347`) and its adapter built/canary-verified from this checkout's
own compiler bundle hash `56132f37b8114fd5`; adapter key
`023b3c67949877c5`, binary size 587,319 bytes. No dirty donor bundles were used.
The heavy lease was released immediately after terminal completion.

## Implementation progress

The six approved production seams are patched, with conservative lazy parser
admission, empty-graph metadata, worker revalidation, explicit pool forwarding,
and the maintained in-process route. Entry maps remain empty and collision
guards are retained. No `src/` code, generator implementation, corpus, oracle,
baseline, or skip policy changed.

Initial light discovery run: **61 parser/discovery cases pass**, one
infrastructure failure because `test262-fyi/data/runner/read.js` is absent in
both the assigned checkout and main donor. This is the pinned optional reader,
not a semantic assertion failure. FYI assembly and the required historical FYI
controls await provisioning; no tests were skipped to hide that prerequisite.

Root provisioned the reader without network or shared writes, linking only
`test262-fyi/data/runner` from the clean donor checkout
`/Users/thomas/Code/js2/.codex-worktrees/codex-4444-full-census-ae0-20260920/test262-fyi/data`.
Its verified HEAD `beeff8b3d70e65dcdd00270fdb31ab12f041b049` equals this
checkout's FYI gitlink. The rerun passed **62/62 discovery cases**, including
all five raw originals and their unchanged literal FYI assemblies. Execution
cases were deliberately unselected during this pure check, not hidden skips.

## Candidate validation and measured outcome

Owned compiler/runtime bundles were rebuilt before the five-file scoped suite,
process `93680`, terminal exit 1, log `.tmp/6834/scoped-tests.log`:
**98 pass / 100 tests**. All **70/70 new issue tests** pass. Existing #3491,
#2930, and #4759 files pass. Two #2900 checks fail: the target graph loses its
exact fixture module-init terminal (`multi-prepared-module-init-census:terminal-join`),
and the single-export check consequently cannot compile. A separate fresh
Vitest process `6292` with the fixture helper restored byte-for-byte from
base HEAD reproduced the same **1 pass / 3 cases**, same two errors, in
`.tmp/6834/2900-baseline.log`. The candidate helper was then restored from
its exact captured bytes. No existing assertion or expected verdict changed.

The new execution controls verify default/named aliases, identity through three
aliases, a live named binding, and one initialization, through FYI and unified
pool IPC in both host (`gc`) and standalone targets. Omitted/false flags,
missing/array maps, false original-harness mode, noncanonical keys, unrelated
imports, and an entry-map collision retain refusal. A generated CommonJS
bootstrap dynamically loads the maintained ESM worker and passes the same
contract. The bare standalone value-self module's actual
`WebAssembly.Module.imports` is empty, not merely its compiler report.

Production predicate census exactly matches the five prospective original
identities; no newly admitted frozen-goal row was omitted. The six production
files' SHA256 fingerprint is
`3dc61d91843fd7dd2c929b9820b0103da0942a445d0b4e5439726702eaba5653`,
recorded in `.tmp/6834/candidate-source.json` and checked unchanged after the
authoritative candidate. Same base commit, Node 24, standalone/auto/QuickJS/
honest-14 settings, exact manifest bytes, and maintained single-shard wrapper.

Candidate run timestamp `20261002-223307`, process `94465`, terminal wrapper
exit 0, log `.tmp/6834/candidate-run.log`. Both wrapper and independent v2
validator confirmed **10/10 identities and callbacks, zero exclusions**.
Result: **5 pass / 4 fail / 1 compile error / 0 skips**, compared with the
base **3 pass / 1 fail / 6 compile errors / 0 skips**. **Two of five affected
goal originals become runtime PASS; three move CE to runtime fail (zero gain).
Zero pass-to-nonpass regressions across the 10-path set.** All five controls,
including both existing failure signatures, are unchanged.

The actual goal gains are:

- `eval-export-dflt-expr-gen-named.js`: compile error → runtime pass.
- `instn-named-bndng-dflt-gen-anon.js`: compile error → runtime pass.

The authoritative JSONL retains `[object WebAssembly.Exception]` and
`reached_test: false` for the three remaining in-process failures. A separate
FYI diagnostic pass (process `96836`, exit 0) renders their assertions below;
its richer `reachedTest: true` is diagnostic, not a replacement canonical
receipt or a scoring change:

- `eval-export-dflt-expr-gen-anon.js`: function name is `g`, expected
  `default` (`correct name is assigned`).
- `instn-named-bndng-dflt-gen-named.js`: function name is `default`, expected
  `gName` (`correct name is assigned`).
- `instn-named-bndng-gen.js`: assignment to the imported binding does not throw
  the required TypeError (`binding rejects assignment`).

These exact generator-name and import-assignment assertions are handed to root
for the existing #2864/#5157 owners; no compiler, generator, binding semantics,
or exception-rendering fix was attempted. Their bodies remain donor-identical.
The FYI flag-off removal control reproduces `env::g` or `env::g2` compile
refusal in all five originals; flag-on gives the same two passes/three failures.

Actual compiled original binaries are **not import-free**. Reflection over the
Wasm modules for every one of the five originals reports only these existing
compiled-provider functions, all from `js2wasm:runtime-eval`:
`__runtime_apply_interpreted`, `__runtime_indirect_eval`,
`__runtime_script_eval`, and `__runtime_direct_eval`. **Zero `env` or other
forbidden host imports** remain. The pinned, canary-verified QuickJS provider
resolves that approved core-Wasm seam; the unchanged host-import policy still
rejects the flag-off originals. Complete per-original import lists, binary
SHA256s, flag-on diagnostics, and flag-off refusals are recorded in
`.tmp/6834/original-import-receipts.json` and
`.tmp/6834/original-import-inspection.log`. The candidate wrapper verifies the
same cached adapter/library pair with the baseline bundle hash; provider
policy and oracle stay unchanged.

This targeted repair does not establish the whole 11,778-original goal. Root
owns subsequent upstream publication and a fresh complete aggregate measurement.

## Source gates and prepared-head handoff

Before staging, normal escalated Git status shows exactly the six production
edits plus the new issue and regression test; no unrelated change or generated
artifact is staged. The author identity is verified as
`Thomas Tränkler <git@thomas.traenkler.com>`, and `.husky` remains configured.

Passed pure checks: scoped Prettier/Biome, diff whitespace, workspace duplicate
issue IDs (4,738 issue files), TS7 typecheck, LOC/function budgets against the
matched base (zero changed `src/` files, net zero source growth), coercion-site
gate, and checker-usage oracle ratchet. These outside-`src/` runner/tooling edits
do not need source-budget grants or compiler inventory entries; no baseline or
policy file was modified. The working-tree oracle evaluator explicitly reads
the actual candidate diff and reports `triggered: true`, zero verdict-signal
lines, no override, and PASS with oracle 14 unchanged. The CLI's commit-only
base-to-HEAD check is also rerun after preparing the commit, so an empty
precommit comparison cannot serve as evidence.

The configured dead-export preservation-v1 gate exits 0 with **6/6** full and
cut witnesses; core-node **12/12** observed callers and core-type **10/10**
references pass. Its preexisting whole-graph architecture closure remains OPEN
on nonliteral imports in `src/optimize.ts#getBinaryenModule` and
`src/runtime/platform-capability-adapter.ts#resolvePlatformCapabilityImport`.
This is preservation-contract evidence, not certification of complete compiler
retirement. No such source or inventory was edited by this issue.

Root reviewed the production diffs and canonical before/after rows. Normal
hooks and the issue/model attribution trailers are required for the unpushed
prepared commit. Root owns the later upstream PR, attachment, and publication;
no GitHub issue, push, merge, queue, or generator-owner mutation is performed
from this checkout.
