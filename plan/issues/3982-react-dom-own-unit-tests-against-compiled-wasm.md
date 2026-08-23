---
id: 3982
title: "Run react-dom's own unit tests against compiled react-dom"
status: in-progress
sprint: current
created: 2026-08-01
updated: 2026-08-22
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
  - src/import-resolver.ts
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
  - src/codegen/expressions/calls-closures.ts::tryExternClassMethodOnAny
  - src/codegen/declarations.ts::collectDeclarations
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
- [x] Legacy server and Fizz batches use independently timed project workers;
      their synchronous parent-process compile path is retired.
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

## ReactDOM native-oracle singleton checkpoint (2026-08-22)

The ReactDOM harness previously built its native oracle with the full compiled
implementation source initialized, while `internal-test-utils` and the native
package imports came from a separate host React/ReactDOM instance. That split
made `createRoot` tests appear harness-incompatible (`container.firstChild`
was empty) before the Wasm result could be compared. The native runner now
keeps the compiled carriers uninitialized and routes React, ReactDOM,
ReactDOM/client, server renderers, test-renderer, and noop renderer imports to
the exact pinned host infrastructure. ReactDOM `act` can also prefer the
host `flushSync` boundary, and the compile worker receives the same setting.

A one-test-per-lane probe now scores the client and all server/Fizz lanes with
zero native-oracle infrastructure failures. The remaining failures are real
compiled-lane findings (for example the client `stateNode` carrier error and
Fizz null dereferences), not an oracle mismatch. The full 1,923-test admitted
corpus remains bounded by the existing project batches and is not claimed
green.

## Server/Fizz worker-isolation checkpoint (2026-08-22)

The legacy server and Fizz lanes now use the same isolated project worker as
the client lane. Previously those lanes called the synchronous compiler in the
parent process; a pathological renderer batch could therefore block the event
loop and make the npm-compat refresh appear hung even though its Promise-based
timeout was armed. Each server/Fizz batch now keeps React, shared renderer,
scheduler, and the selected published server graph in separate project files,
passes the jsdom (or Node Fizz) host setup to the worker, and records compile,
validation, Wasm status, and per-test errors without concatenating the renderer
again in the parent. Invalid batches still subdivide, so a timeout cannot erase
the rest of the upstream denominator.

The focused builder/partition tests and typecheck pass. A full corpus result is
intentionally not claimed until the worker-backed run completes; the existing
heavy test remains the authority for that measurement.

A one-test-per-lane worker probe confirms the new accounting: the client,
legacy server, node Fizz, and edge Fizz batches all emitted valid Wasm and
reported their compiled result (0/1, 0/1, trapped during module init, and 0/1
respectively). The browser Fizz batch hit the 300-second worker deadline and was
reported as one implementation-invalid/skipped test rather than wedging the
parent process. These are compiler/runtime findings, not missing host setup;
the probe is deliberately too small to be a corpus pass-rate claim.

## Harness-seam checkpoint (2026-08-22)

The next infrastructure slice is prepared in [PR #4775](https://github.com/loopdive/js2wasm/pull/4775). The generated ReactDOM
setup now recognizes upstream `async function act(...)` declarations before
injecting its fallback, so the native oracle no longer fails with duplicate
`act` declarations. It also places setup after test-owned `document` bindings
and guards the initial body cleanup, which lets Fizz/JSDOM tests initialize
their own document instead of failing in the temporal dead-zone.

The shared Jest shim now supplies `unmock`, `setTimeout`, `spyOnDev`, and the
`expect.objectContaining`/`expect.arrayContaining` asymmetric matchers. These
are test-runner capabilities, not production React behavior; both the native
oracle and compiled lane use the same shim. Focused ReactDOM and React
infrastructure tests, typecheck, issue-ID validation, formatting, and diff
checks pass. The full upstream corpus has not been rerun, so no new pass-rate
claim is made here; rerun it after the PR lands and keep renderer/compiler
failures separate from unavailable-infrastructure counts.

The native setup is also now explicit about its package carriers: when the
oracle skips compiled initialization, `React`, `ReactDOM`, the client/server
entries, and `act` bind to the installed pinned host singletons. The compiled
lane continues to bind those names to its Wasm carriers. This closes the
previous `flushSync`/undefined native-oracle failure mode without changing the
implementation under test.

The private upstream `./utils/ReactDOMServerIntegrationTestUtils` dependency is
now available through the same explicit shim. Its rendering helpers receive
the test's `initModules()` result, so server/client calls stay on the selected
Wasm module set; only the JSDOM document and PassThrough stream sink are host
capabilities. A focused regression renders through the selected helper module.
This removes a module-lookup failure without claiming that the nested helper
registration cases are a separate denominator; the extractor still reports
the original direct upstream test records.

The facade also has a compiled-Wasm smoke test: the generated module imports
the helper factory, instantiates successfully, and exposes its server-render
method. The full ReactDOM corpus remains unrerun because the pinned upstream
checkout is unavailable offline in this worktree.

The upstream test-side `scheduler` import now resolves to the installed
`scheduler/unstable_mock` capability, matching React's Jest preset and
providing `log`/flush methods without changing the renderer's internal
scheduler. The infrastructure test verifies both exports.

The matcher shim also now covers the upstream `resolves.not.toThrow()` and
`resolves.not.toThrowError()` forms. These are promise assertions over the
test callback result, not a blanket exception suppressor; the focused test
exercises both a fulfilled non-function and a fulfilled non-throwing function.

The compile worker now builds the web-lane import object from the same explicit
JSDOM globals used by the parent harness instead of falling back to the
compiler's hermetic empty import object. This makes the worker's `document`,
`window`, and DOM constructor receivers observable and keeps the node and web
lanes on an explicit host boundary. Simple document receiver controls pass
through the worker. The remaining upstream CSS/edge failures still receive an
empty object at the compiled renderer boundary, so they remain compiler/runtime
findings rather than being hidden by a fake document; no renderer pass-rate
claim is made.

## Node Fizz module-initialization checkpoint (2026-08-22)

The Node Fizz graph exposed one more genuine host seam. Its published CommonJS
module is evaluated before the lifted test entry, so top-level
`require("util")`, `require("async_hooks")`, `require("crypto")`, and
`require("stream")` could reach the entry's not-yet-initialized Jest resolver.
The project-module resolver now uses the worker's explicit infrastructure
capability, and the worker exposes the real host records plus a per-worker
`TextEncoder` and `AsyncLocalStorage`. `queueMicrotask`, `setImmediate`,
`Buffer`, `URL`, and the encoder globals are declared in the implementation
module scope as well. This is host setup only; React and the Fizz renderer
remain the compiled package graph.

The controls are measurable: an implementation-only Node Fizz project now
validates and instantiates, a no-op test and a type/export probe each pass, and
the real upstream `ReactDOMFizzServer › should call renderToPipeableStream`
test now reaches the renderer. It then fails with a compiled renderer null
pointer in `createRequest`, rather than a module-init or unavailable-infra
error. The bounded one-test-per-lane smoke therefore still has zero native-host
errors; this slice does not claim a renderer pass or a full-corpus pass rate.

## Permanent test reference

`tests/dogfood/react-dom-upstream-suite.test.ts` — pin/commit assertions run
always; the full run is gated behind `DOGFOOD_REACT_DOM_UPSTREAM=1`.

```bash
pnpm run dogfood:react-dom-upstream-suite
DOGFOOD_REACT_DOM_UPSTREAM=1 pnpm exec vitest run tests/dogfood/react-dom-upstream-suite.test.ts
```

## Narrow compiler-fix checkpoint (2026-08-22)

The next bounded probe found two compiler issues in the ReactDOM path rather
than missing jsdom infrastructure:

* An `any` receiver for `createElement` was being bound to the first ambient
  `Document.createElement` extern method. That discarded the React namespace at
  the host boundary. Unknown receivers now stay on the generic dynamic method
  dispatcher; typed `Document` receivers retain the exact DOM extern path.
* A mutable parameter inferred as an anonymous WasmGC object shape could be
  reassigned to a different object shape. The generated guarded cast then
  produced null on the next property read. Directly reassigned anonymous
  object/reference parameters now use the universal `externref` carrier;
  named/native carriers remain specialized.

The fixes have focused coverage in
`tests/issue-4373-js-property-call-arguments.test.ts` and
`tests/issue-3982-react-dom-reassigned-ref-param.test.ts`. Both legacy and IR
compiler modes pass (8/8 tests), typecheck and formatting pass, and the exact
one-test legacy-server worker probe now compiles and validates a 1,230,619-byte
module and reports 1/1 compiled tests passing (12.3 seconds). This is a bounded
smoke result, not a claim that the 1,923-test admitted corpus is green.

The browser Fizz timeout and Node Fizz module-init null remain separate
follow-up findings; the full ReactDOM corpus still needs to be rerun after the
compiler fix. No host API was silently marked unavailable.

Implementation: [PR #4769](https://github.com/loopdive/js2wasm/pull/4769).

## Host-graph compiler boundary checkpoint (2026-08-22)

The follow-up compiler probe found two additional generic boundary problems in
the multi-file ReactDOM graph:

* Multi-source host files now receive the callback-aware timer shim without
  rewriting their module imports. This keeps `setTimeout` and the scheduler's
  stored `queueMicrotask` value callable from compiled Wasm while preserving
  the standalone/WASI no-host-import policy.
* Ambient callable globals are collected as host function values only when they
  are referenced and not shadowed by a user module binding. An implicit-`any`
  parameter used as an ordinary or computed property receiver stays an
  `externref` carrier, preventing ReactDOM's scheduler root from being
  specialized to a boolean or nominal object shape.

Regression coverage is now **30/30** across the timer-shim and mutable-parameter
 suites (both legacy and IR modes), with typecheck, formatting, and the IR
 fallback gate passing. The exact ReactDOM upstream corpus is still not claimed
 green: the remaining failure is scheduler work/`act` flush synchronization in
 the compiled project graph, not a missing host API. The next owner should
 resume from the worker-backed scheduler queue and Promise/microtask ordering;
 no test-harness workaround or generated diagnostic source was shipped.

Implementation remains in [PR #4769](https://github.com/loopdive/js2wasm/pull/4769).

## Primitive callback ABI regression checkpoint (2026-08-22)

The real-wasmtime native-messaging smoke caught a regression in the generic
property-receiver rule: the untyped `onData(chunk)` callback in the Node
process adapter uses `chunk.length` and `chunk.charCodeAt`, and was being
widened from the compiler's proven native-string carrier to `externref`. The
resulting callback ABI did not match the host and produced zero output even
for a 1 MiB frame. Ordinary property access still widens nominal/dynamic
object receivers, but proven numeric and native-string carriers remain
specialized. The complete real-wasmtime matrix (1/64/128/256 MiB across
node_process, deno, wasi_p1, and node_fs) now passes. This is a compiler ABI
fix, not a skipped or unavailable test.

## Bounded project compilation checkpoint (2026-08-22)

The client project lane was still compiling its 110 independent test batches
serially. That made the worker deadline effective per batch but left the
overall ReactDOM refresh vulnerable to the 350-minute GitHub Actions ceiling.
The lane now uses a bounded two-worker compile pool (configurable with
`DOGFOOD_REACT_DOM_PROJECT_CONCURRENCY`) and consumes the native oracle in the
original source order. Compilation is pipelined with that oracle: while the
shared host consumes one completed batch, the workers continue compiling later
batches. Each batch still has its own isolated compiler deadline and remains
visible in the report; only independent compilation is concurrent. The
npm-compat workflow pins the pool to two workers to limit runner memory
pressure. This addresses the remaining refresh-timeout path without reducing
the upstream denominator or relabeling compiler failures as unavailable host
infrastructure.

The bounded pool and its fallback-to-two behavior have focused unit coverage;
the 50-test probe observed both client batches dispatched to the two-worker
pool, and the upstream suite harness tests remain green.

Implementation: [PR #4771](https://github.com/loopdive/js2/pull/4771), stacked
on the compiler boundary work in [PR #4769](https://github.com/loopdive/js2/pull/4769).

## Where the 300s implementation-compile timeout actually goes (2026-08-23)

`compileImplementationOnly` times out at 300s and the card reports
`tests.status: "blocked"` with 0 of 1,261 admitted tests executed in Wasm. The
obvious reading — "a 536 KB module is simply too big" — is wrong, and the
measurement says so:

| what                                                   | compile | emitted   |
| ------------------------------------------------------ | ------- | --------- |
| `react-dom-client.production.js`, TOP LEVEL             | 35.4 s  | 1.36 MB   |
| the SAME bytes wrapped in `function __mod() { … }`      | 84.4 s  | 1.77 MB   |

**2.4× the time and 30% more code for identical source, purely from being
inside a function body.** That is the multiplier, not a pathological pass: the
top-level compile of the whole published file finishes in half a minute.

It matters here because `buildImplementationSource` wraps FOUR modules that way
— `__reactModule`, `__schedulerModule`, `__reactDomSharedModule`,
`__reactDomClientModule` — to emulate CJS scoping. The client module alone is
84 s under that shape; with the other three plus `wireRequires` the assembly
reaches the 300 s ceiling.

Scaling for reference (top level, production build): 214 KB → 10.5 s,
536 KB → 35.4 s. Mildly superlinear, nothing like the wrapping penalty.

Two independent directions, either of which unblocks the card:

1. **Harness.** Stop emulating CJS with a function wrapper for the
   implementation-only compile. The harness ALREADY has the better shape —
   `buildProjectFiles` emits real `react.ts` / `shared.ts` / `scheduler.ts` /
   `client.ts` modules for the per-batch test lane. Routing
   `compileImplementationOnly` through `compileProject` the same way should
   drop it to roughly the top-level cost.
2. **Compiler.** Find why a function body costs 2.4× and emits 30% more than
   the same statements at top level. That is worth knowing regardless of
   react-dom — every CJS package in the corpus is compiled through a wrapper.

**Direction 1 is now implemented.** `compileImplementationOnly` builds the
project files (`buildProjectFiles(…, { tests: [] })`) and goes through
`compileProjectInWorker`, the same path the per-batch lane uses.

Measured end to end on the pinned sources (react 17 KB, shared 6.6 KB, client
536 KB):

| probe shape                                    | result                                   |
| ---------------------------------------------- | ---------------------------------------- |
| `buildImplementationSource` (4 function wrappers) | 300 s TIMEOUT, no module, card `blocked` |
| `buildProjectFiles` (real modules)              | **96.8 s, success, `validates: true`, 2.25 MB** |

So the implementation is not "too big to compile" and never was — it compiles
and validates in under two minutes once it is not wrapped. The card's
`tests.status: "blocked"` / 0-of-1,261 line was an artifact of the probe's
shape, not a statement about react-dom.

Direction 2 (why a function body costs 2.4× and emits 30% more than the same
statements at top level) is still open, and still worth doing: every CJS
package in the corpus is compiled through a wrapper somewhere.

The wrapping measurement is reproducible with `.tmp/rd-wrap.mjs` (top-level vs
wrapped, same bytes); the probe comparison with `.tmp/rd-probe-time.mjs`.

## Lever 2: the project lane recompiles the implementation once PER BATCH (2026-08-23)

SPECIFIED, NOT IMPLEMENTED. Recording the measurement and the design so the
next attempt starts from evidence rather than from the same guess.

`partitionProjectTests` partitions BY UPSTREAM FILE first and only then splits
anything oversized (`maxChars = 800_000`). There are 115 test files, so there
are at least 115 batches, and the 800 KB cap is almost never the binding
constraint. Every batch compiles the whole project — `react.ts`, `scheduler.ts`,
`shared.ts` and the 525 KB `client.ts` — plus its own entry.

Measured cost of a batch carrying ZERO tests: **102 s** (success, validates,
2.25 MB). That is the floor each batch pays before a single test body is
compiled. At 115 batches over the pinned 2-worker pool that is roughly
**98 minutes of pure implementation recompilation**, which is most of the row's
3-4 hour wall clock.

The clean fix is separate compilation: compile the implementation once and link
each file's test module against it. The compiler has no module-linking story
today, so that is a large piece of work, not a harness tweak.

The cheap approximation is to **pack by size instead of by file**: fill each
batch to `maxChars` across several upstream files rather than starting a new
batch per file. Ten files per batch turns ~115 batches into ~12 and should cut
the row by roughly the same factor, since the per-batch cost is dominated by a
constant.

Two things that fix does NOT get for free, and which is why it is not landed
here:

1. **Lifecycle isolation.** The current partition keeps each file's Jest-style
   `beforeEach`/`afterEach` together deliberately. Co-locating several files in
   one module has to keep each file's lifecycle scoped to its own tests or
   results silently change.
2. **Blast radius.** One invalid function currently poisons one file's binary.
   At ten files per batch it poisons ten. The halving-retry recovers, but the
   retry is exactly the cost being optimised away, so a batch that fails
   validation could end up slower than today.

Neither can be judged from a unit test: it needs a full react-dom row (3-4 h)
before and after, comparing wall clock AND the admitted/passed denominators.
Do not land it on a green harness test alone.
