---
id: 3982
title: "Run react-dom's own unit tests against compiled react-dom"
status: in-progress
sprint: current
created: 2026-08-01
updated: 2026-08-21
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: test
area: dogfood
es_edition: n/a
language_feature: compiler-internals
goal: dogfood
related: [3958, 3977]
loc-budget-allow:
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/call-identifier.ts
  - src/runtime.ts
  - src/codegen/property-access.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/statements/variables.ts
  - src/codegen/index.ts
  - src/codegen/registry/imports.ts
  - src/codegen/closures.ts
  - src/codegen/closures/arrow-phases.ts
  - src/codegen/closures/funcref-as-closure.ts
  - src/codegen/function-declaration-observation.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/stack-balance.ts
  - src/codegen/context/types.ts
  - src/codegen/string-ops.ts
  - src/codegen/binary-ops.ts
  - src/codegen/array-methods.ts
  - src/compiler.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/declarations.ts
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/extern-declarations.ts
oracle-ratchet-allow:
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/statements/nested-declarations.ts::hoistFunctionDeclarations
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclaration
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/runtime.ts::resolveImport
  - src/codegen/function-body.ts::compileFunctionBody
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/runtime.ts::<anonymous>#78
  - src/codegen/index.ts::ensureStructForType
  - src/codegen/expressions/calls-closures.ts::compileCallablePropertyCall
  - src/runtime.ts::_wrapForHost
  - src/codegen/string-ops.ts::compileTaggedTemplateExpression
  - src/import-resolver.ts::preprocessImports
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/runtime.ts::_safeSet
---

# Run react-dom's own unit tests against compiled react-dom

## What was done

`tests/dogfood/react-dom-upstream-suite.mjs`, built on the #3958 React suite
rather than beside it: the test extractor (`react-upstream-extract.mjs`) and the
`expect` shim (`react-upstream-shim.mjs`) are reused verbatim, because
react-dom's tests are the same Jest + JSX + `describe`/`it` shape from the same
repository at the same commit. The suite reuses React's already-verified
checkout, so the two cannot drift onto different revisions of the same repo —
the setup asserts the shared tag and commit and fails loudly otherwise.

Three things genuinely differ, and each is why a separate harness exists:

1. **Two published CJS modules** make up the implementation — the shared entry
   plus the 536 KB client renderer — and each needs its OWN function scope.
   react and react-dom both declare a top-level `noop`, so a bare concatenation
   dies with `Duplicate identifier 'noop'` before a single test runs.
2. `require("react")` / `require("react-dom")` / `require("scheduler")` inside
   those modules are rewired to the in-module values, so what runs is the
   published implementation wired to the published implementation. `scheduler`
   is not in the react-dom tarball and is an empty object; anything that needs
   it fails identically on both sides.
3. The implementation is compiled **alone first** (the #3977 lit lesson).

**166 of 2003 upstream react-dom tests are currently admitted**. These are
original upstream tests whose scaffolding the shared extractor and jsdom-based
host can reproduce without React's private Jest module system.

## Suspended handoff (2026-08-03)

This file is the canonical tracking issue. Draft implementation and the
reproducible suspended state are preserved in PR #4079.

The initial parse blocker is fixed. React 19.2.6 plus the published ReactDOM
shared/client production modules now compile to a valid Wasm module (about
548 KB of source), and the harness can execute original upstream tests against
that module under jsdom.

The first admitted upstream test remains red:

```text
ReactDOM unknown attribute › unknown attributes › removes values null and undefined
native: pass
compiled Wasm: fail (expected "something", observed undefined)
```

### Exact remaining compiler blocker

React reaches `enqueueUpdate` with the HostRoot fiber, an initialized update
queue, and a non-null root. The generated body for `updateContainerImpl`,
however, omits the first side-effecting call in React's comma expression:

```js
null !== element &&
  (scheduleUpdateOnFiber(element, rootFiber, lane),
   entangleTransitions(element, rootFiber, lane));
```

`entangleTransitions` is emitted; `scheduleUpdateOnFiber` is replaced with a
dropped default value. This is not a SequenceExpression evaluator bug. The
callee belongs to a deferred capturing sibling cycle and has no registered
function/capture ABI when the ordinary caller is emitted.

Reserving that cycle before its first caller restores the scheduler call, but
then reveals the deeper ABI problem: `performSyncWorkOnRoot` supplies 108
capture arguments to a `flushPendingEffects` body whose final type requires
117 (`WebAssembly.compile(): not enough arguments on the stack for call`). At
reservation time the callee reports 107 capture parameters; after later
dependencies are emitted its final ABI grows. The next implementation needs a
dependency-aware prepare-before-emit phase that freezes the entire cycle's
capture ABI before any caller body is generated. Merely increasing the existing
32-round cycle loop does not solve the ordering problem.

This work is suspended at the user's request. The branch intentionally retains
the last valid-module state and does not commit the speculative early-cycle
reservation that creates invalid Wasm.

## Current origin/main measurement (2026-08-09)

The current upstream extractor now admits the complete reproducible ReactDOM
slice (1,942 of 2,003 tests), so the older 166-test count above is historical.
The first current run exposed a generic compiler diagnostic bug: the native
JSON codec's instruction clone still used `JSON.stringify`, which crashed on
the `BigInt` operands used by generated `i64.const` instructions. That clone
now uses the existing alias-expanding `deepCloneInstrs` helper, covered by
`tests/json-codec-clone.test.ts`.

After that fix, ReactDOM's implementation-only compile reaches the real next
blocker instead of the serialization crash. Reproduction (with one selected
upstream test to keep the run bounded) is:

```bash
DOGFOOD_REACT_DOM_TEST_LIMIT=1 \
  node --import tsx tests/dogfood/react-dom-upstream-suite.mjs --json
```

The bounded harness still surfaces the BigInt message because
`src/codegen/stack-balance.ts` tries to JSON-serialize the malformed body while
building its diagnostic. A diagnostic-only local probe that renders BigInt
operands without changing the compiler then reveals the underlying invariant:

```text
stack-balance invariant (entry): 'updateForwardRef' references local 202,
but only 39 params + 31 locals are declared
```

That is local 202 in a 70-slot frame, not a JSON/diagnostic formatting issue.
Do not stringify around or quarantine this invariant: it is the next generic
frame/capture compiler blocker. Until it is fixed, the implementation does not
produce a valid module and ReactDOM correctness remains **unverified** (no
scored upstream workload).

### Reproduction

```bash
DOGFOOD_REACT_DOM_ADMIT_ALL=0 \
DOGFOOD_REACT_DOM_TEST_LIMIT=1 \
pnpm run dogfood:react-dom-upstream-suite
```

### Suspension checkpoint (2026-08-09)

The npm-compat branch is suspended with the current full implementation
frontier unchanged: `updateForwardRef` references local 202 in a frame with
only 39 parameters plus 31 locals. No ReactDOM correctness test is scored and
the tiny entry-barrel validation must not be presented as ReactDOM support.
The reporting/harness state is on `codex/npm-compat-handoff`; there is no
separate uncommitted ReactDOM fix to recover.

## Resumed compiler frontier (2026-08-13)

The implementation lane uses React's published production CJS output because
the upstream repository source contains Flow/JSX and is itself built before it
is published. This is still React and ReactDOM executing inside Wasm: the
harness rewires their package-local imports and compiles the complete shared +
client renderer (561,425 source characters), not the tiny `index.js` selector.
jsdom currently supplies the native DOM oracle/host environment; compiling
jsdom itself is the separate [#4299](4299-jsdom-original-api-suite.md) lane.

This continuation clears two generic compiler failures in the unchanged real
renderer:

1. A transitive function-value cycle recursively materialized closures until
   the compiler exhausted Node's stack. Observable cyclic function bindings
   now allocate live cells before closure construction.
2. A returned function expression forwarded `onUnsuspend` using owner-frame
   local 350 from its own 46-slot frame. Lifted capture slots are now frozen
   after their prologue locals exist, and transitive sibling function values
   are retained in the returned closure's capture ABI.

The same bounded implementation-only run now completes code generation and
reaches WebAssembly validation after about 74 seconds. The next exact blocker
is:

```text
WebAssembly.compile(): Compiling function #620:"forceStoreRerender" failed:
call[262] expected type (ref null 49), found local.get of type externref
```

No upstream ReactDOM test executes until that module validates. The harness and
npm-compat report now classify those tests as implementation-blocked (0
executed), not as 294/294 or 1/1 behavioral failures. The package card also
uses the real renderer's compile/validation result instead of the small entry
selector's result.

### Host boundary

The intended end state is not to leave jsdom as one opaque host call. React,
ReactDOM, and jsdom's JavaScript/dependency graph should compile into Wasm.
Only concrete Node capabilities that JavaScript cannot provide itself—such as
filesystem, networking, timers, and process services—remain explicit host
imports. The browser DOM API exposed by compiled jsdom is then the interface
ReactDOM uses inside Wasm.

Resume at the `forceStoreRerender` call ABI: trace the expected `(ref null 49)`
parameter back to the inferred fiber representation and insert the generic
dynamic-to-typed nullable narrowing at the producer/call boundary. Keep Wasm
validation authoritative; coercing the signature or suppressing the error
would only hide an invalid module.

## Current checkpoint (2026-08-14)

The client-only published implementation (React plus the shared and client
react-dom CJS modules) now compiles and validates as Wasm. The bounded run used
the unchanged upstream extractor and admitted 1,261 of 2,003 tests; 681 tests
that reference `ReactDOMServer` are retained in the report with the explicit
`needs-react-dom-server` reason. The server renderer is a separate CJS graph and
still produces an invalid WasmGC type graph when concatenated into this lane,
so those tests are deferred rather than counted as client implementation
failures. The harness also now preserves upstream `const` bindings and reports
the two-module client result without a false setup error.

The bounded client probe now instantiates and executes one original test. It
reaches ReactDOM's client renderer but fails in the constructor bridge with
`[object Object] is not a constructor`; this is a runtime/compiler boundary
finding, not a Wasm validation failure. A full pass-rate claim is not made
until that constructor value is preserved and the server-renderer slice has its
own valid module path.

## Capture-continuation checkpoint (2026-08-15)

The constructor-capture fix is now on the draft follow-up. It preserves
immutable boxed captures across lifted closure frames and lazily materializes
nullable cells from their raw binding before a conditional closure is called.
The client module remains valid Wasm, but the first admitted upstream probe now
reaches a separate null-cell dereference in the generated constructor closure.
The follow-up therefore stays draft until that runtime path is fixed; this
checkpoint intentionally records the remaining failure instead of claiming a
pass-rate improvement.

## Project-module checkpoint (2026-08-15)

Draft PR [#4507](https://github.com/loopdive/js2wasm/pull/4507) now compiles
React, the shared client module, and the scheduler as separate project files
in a killable worker. The adapter gives each published CommonJS export carrier
a unique top-level name; this avoids the multi-file `exports`/`default` name
collision that previously made imported React internals empty. It also installs
the same jsdom globals in the worker and defers module initialization until the
Wasm instance is wired.

The client graph now validates and initializes as Wasm. The first unchanged
upstream probe reaches the renderer and reports the next real runtime finding:
`Cannot create property 'stateNode' on boolean 'false'`. This is recorded as a
behavioral compiler/runtime gap, not a compile or Wasm-validation failure; the
PR remains draft until that path is addressed.

## Host-infrastructure audit (2026-08-20)

The shared React test shim now exposes Node's `global` spelling as an alias of
`globalThis` in both the native oracle and Wasm lane. This covers the original
ReactDOM tests that install `ReadableStream`, `TextEncoder`, scheduler state,
or jsdom globals through `global.*`; it is host setup, not a package behavior
substitute.

The legacy single-module probe was rerun with one admitted test and produced a
valid 2.4 MB Wasm module in 104 s. The test reached the renderer but failed
with `Cannot read properties of null (reading 'createRoot')`, confirming a
remaining project/module export or compiler representation issue rather than
unavailable DOM infrastructure. The default IR project lane remains the path
to fix; do not turn the legacy probe into a pass-rate claim.

## Separate server-renderer lane checkpoint (2026-08-20)

The harness now acquires the published `react-dom-server-legacy.browser.production.js`
bundle and compiles it in a separate module graph. The original server-renderer
tests are admitted to that lane instead of being rejected as
`needs-react-dom-server`; the client graph still contains only the shared and
client renderer modules. This keeps the two WasmGC graphs independent while
using the same pinned React source, jsdom host, expect shim, and native oracle.

The one-client/three-server smoke run compiled and validated the server graph
in 8.0 s as a 938,550-byte module and executed all three original server tests
from the 115-test legacy-renderer subset against it. The tests reached the renderer and failed their assertions
(`expected value to be contained`), so this is an infrastructure milestone,
not a green-pass claim. The client smoke test still fails at `Cannot read
properties of null (reading 'createRoot')`; that remains a compiler/module-
export issue rather than unavailable host infrastructure. The full server lane
is now measurable and its compile, validation, native-oracle, and behavior
counts are persisted under `report.server`.

## Jest adapter infrastructure checkpoint (2026-08-20)

The extractor no longer mistakes ordinary application calls such as
`value.toString()` and `text.toLowerCase()` for Jest matchers. It now walks the
syntax tree and only classifies calls rooted at `expect(...)` (including
`.not`, `.resolves`, and `.rejects`). The shared shim implements the additional
upstream matchers `toMatch`, `toContainEqual`, `toHaveBeenNthCalledWith`,
`toMatchInlineSnapshot`, and `toMatchRenderedOutput`, and the host console
capture is declared as available infrastructure in both suites.

In conservative extraction mode this raises the React slice to 272/273
admitted tests (the one remainder is an upstream skip) and the ReactDOM slice
to 1,770/2,003 admitted tests. The remaining ReactDOM rejections are private
Fizz/test scaffolding and are recorded by reason rather than silently
discarded. This checkpoint changes what reaches
the compiler, not the Wasm behavior score: the client renderer still has the
known module-export/runtime gap and the server smoke still has behavior
failures.

## Browser Fizz lane checkpoint (2026-08-20)

The browser Fizz tests now have their own published implementation graph:
`package/cjs/react-dom-server.browser.production.js`. The harness routes 60
original upstream tests from `ReactDOMFizzServerBrowser-test.js`,
`ReactDOMFizzStaticBrowser-test.js`, and `ReactDOMFizzStaticFloat-test.js` to
that graph, while the 115 legacy browser-server tests remain on their own
`react-dom-server-legacy.browser.production.js` lane. The Fizz graph no longer
concatenates the legacy renderer, so its compile and validation result is
independent rather than an accidental combined-server result.

The host boundary now supplies the standard browser/Node constructors required
by the published browser bundle (`MessageChannel`, `MessagePort`, Web Streams,
`TextEncoder`/`TextDecoder`, `Headers`, and abort signals) through the existing
generic runtime constructor mapping. This is host capability plumbing; the
renderer algorithms remain in the compiled module. Upstream Fizz setup also
uses `serverAct`, and inline string snapshots compare the serialized value used
by Jest's original matcher.

The bounded smoke run admitted one test in each lane. The Fizz module compiled,
validated, and instantiated as a roughly 1.15 MB Wasm module; its native oracle
passed, while the compiled test reached the renderer and failed with
`Cannot access property on null or undefined`. That is a compiler/runtime
behavior gap, not unavailable infrastructure. The full Fizz lane is now
measurable and is persisted separately in the npm-compat report. Node/edge Fizz
files still require their own stream, crypto, and async-hooks host graphs, and
the client/legacy behavioral gaps remain open.

## Node and Edge Fizz lane checkpoint (2026-08-20)

The same harness now acquires the published Node and Edge server bundles:
`react-dom-server.node.production.js` and `react-dom-server.edge.production.js`.
It routes 35 original Node-Fizz tests and 2 original Edge-Fizz tests to those
graphs, with separate compile/validation/test denominators and npm-compat rows.
Both one-test smoke lanes compiled, validated, instantiated, and reached the
upstream test with a passing native oracle. Node stream construction is exposed
through a named host capability for `stream.PassThrough`; the test's dynamic
constructor spelling is lowered only at that host boundary because the generic
dynamic-constructor path cannot preserve a Node stream subclass. The Edge lane
uses the existing Web Streams/TextEncoder/AsyncLocalStorage host surface.

The remaining Node/Edge smoke failures are now compiler/runtime behavior
findings (`writable is not defined` in the Node stream test and a null-property
access in the Edge resource-hint test), not unavailable host setup. This is
important attribution: the published platform graphs and their required host
objects are now actually running, while the remaining work belongs in the
compiled renderer/runtime.

The extractor also now lifts concise upstream arrows (`it('name', () =>
expect(...))`) and async concise arrows as expression statements. The full
ReactDOM corpus therefore reports 2,001/2,003 admitted tests; the only two
rejections are the upstream `.skip` tests. The 172 private Fizz/test-scaffolding
uses that remain in conservative mode are still recorded as unavailable
scaffolding rather than silently promoted.

## Remaining blockers (skipped tests in `tests/issue-3982.test.ts`)

36 of the 39 extracted compiler blockers are green. Three are `it.skip` with the
reason inline at each test — kept in the file, not deleted, so the shapes stay
recorded. Both root causes are in main's implementations, not in a missing
feature of this suite.

**1. A nested `async function` DECLARATION inside an `async` parent loses its
captures.** Guards two tests ("captures an assigned client module in a nested
async helper", "keeps multiple assigned async-helper captures in declaration
order"). Narrowed with probes — only the async-inside-async combination fails:

| parent | nested       | result                                          |
| ------ | ------------ | ----------------------------------------------- |
| sync   | async decl   | works                                           |
| async  | sync decl    | works                                           |
| async  | async _expr_ | works                                           |
| async  | async decl   | reads the pre-capture value, or traps on a null ref cell |

Observed as `TypeError: createRoot is not a function` (capture read as its
pre-assignment value) and, with the binding initialised at its declaration, as
`dereferencing a null pointer`.

**2. `captureSourceSlot` (#4134) resolves a cross-frame capture by NAME.**
Guards "threads a sibling capture past a same-named caller local". When the
lifted caller declares its own local with the same text as the capture, a name
lookup cannot tell the two lexical bindings apart, so the emitted `local.get`
reads the caller's own slot and the module fails validation
(`struct.new[0] expected type f64, found local.get of type externref`). The
restraint in that resolver is deliberate — #1177's blanket "prefer localMap"
lookup regressed 100+ test262 tests — so the fix is not to loosen it but to key
capture slots on the OWNING frame instead of on the name. An earlier revision of
this branch carried exactly such a mechanism (`transitiveCaptureLocals` /
`ownerFctx`); it was dropped when main's more general #4133/#4134 work landed,
because its Phase-0 reservation reached its capture verdict too late — see the
comment in `src/codegen/statements/nested-declarations.ts`. A future fix has to
add binding-aware slots on top of main's design, not restore that one.

## Browser infrastructure checkpoint (2026-08-20)

The shared jsdom host now promotes every browser constructor used directly by
the selected ReactDOM corpus, including `ProgressEvent`. jsdom exposed that
constructor only as `window.ProgressEvent`, while ReactDOM's original event
tests instantiate the global `ProgressEvent`; the missing promotion made those
tests fail in the native oracle before they could provide compiler evidence.
The host surface is covered by
`tests/dogfood/react-upstream-infrastructure.test.ts`. The remaining native
incompatible results are renderer/oracle behavior differences, not skipped
tests caused by an unavailable browser API.

The same audit found one shared-browser gap affecting Lit as well: jsdom
provides `Document` on `window`, but the host had not promoted the constructor
to the global scope. Lit's published `css-tag` module evaluates
`Document.prototype` during initialization, so the omission caused a
pre-test `ReferenceError`. `Document` is now part of the explicit DOM global
allowlist and has a regression assertion; a direct native import of the
published Lit `css-tag` entry now initializes successfully.

The conservative ReactDOM extraction then exposed a second infrastructure gap:
172 Fizz tests imported the private monorepo
`../test-utils/FizzTestUtils` module, whose bindings were previously dropped.
The shim now provides the four original DOM helpers (`insertNodesAndExecuteScripts`,
`mergeOptions`, `stripExternalRuntimeInNodes`, and `getVisibleChildren`) as an
explicit host facade, with a native regression exercise. The Jest shim also
implements the one remaining matcher used by the corpus, `toBeGreaterThan`.
Conservative extraction now admits **2,001/2,003** ReactDOM tests; the only
rejections are the two upstream `.skip` tests. This changes reachability and
host setup, not the renderer's compiled behavior score.

## Project-batching checkpoint (2026-08-21)

The client project lane no longer places the entire selected corpus in one
entry module. `partitionProjectTests` groups tests by their original upstream
file and splits only oversized files at a bounded entry-source size (800,000
characters by default, configurable with
`DOGFOOD_REACT_DOM_PROJECT_BATCH_CHARS`). Each batch is compiled in its own
worker invocation and every test keeps its native result, Wasm result, and
compile/validation error in the report. A timeout or invalid batch therefore
cannot erase the rest of the denominator.

The bounded unchanged-corpus probe with 50 client tests produced two valid
project batches in 88.2 seconds: all 50 compiled and reached the runner, zero
were blocked before Wasm execution, 49 were native-oracle-incompatible, and one
was scored (0/1). A forced five-batch probe with a 1,000-character limit also
validated all five batches with zero skipped tests. The remaining failures are
renderer/compiler behavior, not missing batching or DOM host setup.

## Acceptance criteria

- [x] The corpus is react-dom's own test sources at a verified commit shared
      with the react suite.
- [x] Original upstream tests are extracted and unsupported infrastructure is
      reported separately rather than replaced by invented tests.
- [x] `admitted + rejected == upstreamTestsSeen` is asserted.
- [x] The implementation is compiled alone and reported by name with the
      compiler's own message when it fails.
- [x] react-dom's published client module compiles to a valid Wasm module.
- [x] The client corpus is split into independently validated project batches;
      a worker timeout cannot hide the remaining tests.
- [x] The published browser server module has an independent valid Wasm lane.
- [x] The published browser Fizz module has its own independent valid Wasm lane.
- [x] The native oracle and compiled lane run under the same jsdom host setup.
- [ ] Freeze deferred capture-cycle ABIs before compiling ordinary callers.
- [ ] Capture a nested `async function` declaration inside an `async` parent.
- [ ] Key cross-frame capture slots on the owning frame, not the capture name.
- [ ] Make the admitted upstream ReactDOM tests green against compiled Wasm.
- [x] Tests blocked before a valid implementation exists are reported as not
      executed, never as behavioral divergences.

## Cross-package React host infrastructure checkpoint (2026-08-20)

The shared React upstream host now resolves the published ReactDOM/client/server
and `react-test-renderer` entries under `NODE_ENV=production`, while aliasing
the exact pinned React object into their CommonJS peer lookup. This removes the
dev-renderer/production-React internal queue mismatch (`actQueue.push`) that
previously failed before an upstream assertion ran. It exposes jsdom,
ReactDOM, the JSX runtimes, `create-react-class`, `internal-test-utils`, a
`react-noop-renderer` adapter, a version-only `react-native-renderer` carrier,
and Node stream capability explicitly.

Production test-renderer does not provide `act` or a committed tree, so the
noop adapter uses a jsdom ReactDOM root with `flushSync` and exposes the
test-renderer-shaped children/JSON/ref view. The native oracle leaves host
React values untouched; only the compiled Wasm call path may opt into a
boundary preparation step.

The exact React run now admits and executes **272/273** upstream tests (one
upstream skip), has **0 compile-quarantined** tests, and produces **44 valid
Wasm batches**. Of the 272 executed tests, **178 are natively scoreable and
92 pass** against compiled Wasm; **94** are reported as native-oracle
incompatible. Those 94 are not missing package lookups: the remaining groups
are production warning expectations, renderer semantics, and compiled
component/function closures that still arrive as opaque host objects. ReactDOM
compiled correctness therefore remains a separate follow-up, while this
checkpoint makes the cross-package infrastructure explicit and measurable.

## Permanent test reference

`tests/dogfood/react-dom-upstream-suite.test.ts` — pin/commit assertions run
always; the full run is gated behind `DOGFOOD_REACT_DOM_UPSTREAM=1`.

```bash
pnpm run dogfood:react-dom-upstream-suite
DOGFOOD_REACT_DOM_UPSTREAM=1 pnpm exec vitest run tests/dogfood/react-dom-upstream-suite.test.ts
```
