# Persistent AOT Script environment

Required for complete Deno integration, not an alternative acceptance bar.
Sources known at packaging time must execute AOT without an interpreter.

## Continuation: typed primitive constants and global callables, 2026-10-04

Top-level inferred number/boolean `const` bindings now retain typed scalar
slots and box/unbox only at the Context lexical operation. Provider reads still
check TDZ first. Mutable typed bindings remain refused. Reference-typed consts
also remain refused: a broad experiment passed array identity but returned the
wrong answer after a later Script changed an element from number to string.
Const protects the binding, not element/field type proofs. Do not re-admit these
without sound shared representation and mutation handling.

Shared Script function writes through globalThis or top-level this now select
the existing native AOT callable carrier. This fixes a foreign function-property
call that previously returned without running its body. Selection is based on
direct callable producer syntax/name in shared mode, not just an inferred
signature; existing carrier aliases pass through. No broad runtime-eval flag,
interpreter or source rewrite is introduced.

Focused result: 86/86 reported, comprising 84 ordinary successes and the two
existing expected failures. Seven new ordinary controls cover numeric and
boolean constants, TDZ, unsafe array refusal, retained/foreign callable reads,
top-level-this installation, aliases and thrown identity. The five-file total
is 163: 158 ordinary successes, two expected failures and the same three
recorded ordinary TDZ failures (55 versus 63 and two call-count mismatches).
TypeScript 7, lint, formatting, coercion and oracle checks pass; budgets passed
before the small global-callable selection addition and will run at commit.

The native fixture now consists of one Context and eight independent Scripts.
Final raw controls and all nine packaging invocations pass. Compiler-free replay
passes 1/1 (36 filtered, 0.07 seconds), including inferred numeric const rejection
and a boolean-constant reader called through a foreign global alias. Runtime
compilation and runtime-eval provider instantiation counts remain zero. Local
fixtures: `/private/tmp/deno-script-scalars.6Tj5CN`. These are local trusted test
artifacts, not a rebuilt full Deno Context or unchanged Deno conformance proof.

Next: mutable and reference-typed binding planning, public Script completion
and artifact lookup, then a full Context rebuild and unchanged Deno tests.
Full integration, shared-library factoring and fresh comparative performance
measurements remain open. Both PRs stay draft; preserve user dirt.

## Wrap-up: native Context wiring, 2026-10-04

Compiler implementation remains at `cafc1769ccb45074064c5ca88f0262aae1388aa4`.
Draft compiler PR: https://github.com/loopdive/js2/pull/6468, targeting the
existing callback-construction branch, not main. Adapter changes are published
on `codex/4376-deno-realm-bootstrap` in draft PR
https://github.com/loopdive/v8x/pull/2. Do not open duplicate PRs.

The native linker now accepts `__v8x_context_lexical`. Runtime and namespace
Context builders export the existing compiler lexical provider, and the
production source graph records that provider in provenance. The runtime
compiler pin advances to `cafc1769ccb4`; the historical POC pin is unchanged.

One Context and six independent Script artifacts pass raw Node controls and
all seven Wasmtime packaging invocations. A separately built compiler-free
native test passes 1/1 (36 other tests filtered out, 0.07 seconds). It verifies
persistent lexical reads/writes, cross-Script object conversion, exact wide
BigInt postfix values, declaration preflight before effects, const-write
rejection, and isolation between two Contexts. The native test asserts zero
runtime compilations and zero runtime-eval provider instantiations. The fixture
contains `any` annotations and does not prove unchanged Deno Script semantics.
Adapter tool tests pass 9/9; both packaging and deployment Cargo profiles build.
Documentation rendering is unverified: Typst is absent at the configured path.

Adapter handoff and reproduction commands:
`tools/js2wasm/SCRIPT-ENVIRONMENT-HANDOFF.md`. Local native fixtures:
`/private/tmp/deno-script-native.X4IpnK`, with sources/hashes in `test-inputs.json`.
Adapter checkout: `/private/tmp/v8x-deno-resume-20260930.o0sxeO/repo`.
The packaging test is not ignored; `--ignored` accidentally selects zero tests.
Only the fixture-dependent deployment test needs `--ignored`.

Resume with independent artifacts on the public Script path and actual
completion values, then typed lexical bindings and foreign accessors/callable
transport. Rebuild the full Deno Context on the new compiler pin and rerun
unchanged Deno tests. No new full-core artifact, conformance gain, shared-library
factoring, or fresh performance measurement is credited by this checkpoint.
Integration remains incomplete and both PRs remain draft. Preserve all user dirt.

## Latest continuation: native foreign conversion, 2026-10-04

Follow-up to published handoff `25f8fb58922` on the same branch and draft PR
https://github.com/loopdive/js2/pull/6468. The prior ordinary object/valueOf
failure is now fixed; the wrap-up section below describes its historical state.

Three independent causes were measured and repaired:

1. Open-object callable properties in shared Script mode were not wrapped in
   the existing canonical native AOT carrier. Wrapping is now enabled narrowly
   at object construction, without enabling the broad runtime-eval flag.
2. A closure-free consuming Script emitted `__call_accessor_get` as a constant
   undefined fallback because no local closure arity dispatcher existed. Its
   getter/conversion path now dispatches the foreign carrier directly, with the
   original receiver. Setter drivers remain on their existing void-result path;
   general foreign setter transport still needs separate verification.
3. A BigInt closure return was narrowed to i64, and the call-result envelope
   also decoded it through an i64 payload. Shared-Script closure signature/body
   planning now preserves the native reference carrier; wide values use the
   envelope's reference slot. Narrow values retain the scalar envelope path.

Intermediate native controls separated the failures: foreign property lookup
reported a callable and an explicit method call incremented score once, while
conversion did not. Adding the carrier dispatch made score equal one but the
exact-value assertion still failed. After the return/envelope fixes, the exact
original probe reports `scoreControl: 41, objectControl: 1, score: 1, exact: 1`.
Clean `fbe1958bd79`, with the same native owner/independent-Script harness and
source, reports `41, 1, 0, 0`. No JS semantic mock or object copy is involved.

The five-file regression reports 156 tests: 151 ordinary successes, two existing
expected failures and the same three ordinary TDZ baseline failures. The focused
file reports 79/79, including the two expected failures. New ordinary controls
exercise numeric function/method/arrow conversion, wide positive/negative and
narrow BigInt returns, receiver identity, and thrown-value identity with zero
lexical writes. TypeScript 7 and main-relative LOC/function budgets pass.
Final focused rerun after restricting the value-returning guard to getter
drivers again reports 79/79. Oracle and coercion checks pass. Dead-export exits
zero but its graph remains OPEN and runtime retirement/deletion is NOT CERTIFIED
because the two previously recorded nonliteral dynamic imports remain unknown.

Next: native Context provider packaging and adapter imports, then a clean
artifact rebuild and unchanged Deno conformance. General Script semantics,
foreign accessors/callable aliases and arbitrary arithmetic still require work.
The shared callable helper is reused within a module, not yet factored into an
external shared library. No new native deno_core artifact or full integration
completion is credited by this compiler-only change. Preserve all user dirt.

## Earlier wrap-up handoff: 2026-10-04

Published implementation: `921471e79e3e8d898650cf9aceacbb356bf5325a` on
`codex/4376-deno-lexical-checkpoint-20261004`. Existing checkpoint PR:
https://github.com/loopdive/js2/pull/6468, targeting
`codex/4376-deno-callback-construction-20260930`, not main. It remains draft
because the ordinary conversion control fails and native packaging is unwired.
Do not open a duplicate PR or claim full Deno integration is complete.

Last measured five-file regression: 147 tests, 141 ordinary successes, two
expected failures and four ordinary failures. The focused persistent Script
file has 70 tests: 67 ordinary successes, two expected failures and one ordinary
failure. These are recorded results from the implementation checkpoint, not a
fresh wrap-up rerun. TypeScript 7 and the recorded formatting, budget, coercion
and oracle checks passed. No newer native deno_core artifact was built.

Resume with the foreign object conversion failure: a prior independently
compiled Script stores an object whose `valueOf` increments `globalThis.score`
and returns `18446744073709551616n`; the next Script performs `retained++`.
The method is not called. A native owner/Script probe gives
`scoreControl: 41, objectControl: 1, score: 0, exact: 0` both on clean
`fbe1958bd79` and implementation `921471e79e3`, so this predates the exact
BigInt update helper. Keep the ordinary failing test visible.

Inspect `objectLiteralHasCallableProperty` in `src/codegen/literals.ts` and
the canonical AOT callable bridge in `src/codegen/runtime-eval-callable.ts`.
Callable-bearing object promotion currently depends on
`runtimeEvalCallableBoundaryEnabled`; foreign nominal object types are not
known to the consumer's local conversion dispatch. This is a working causal
hypothesis, not a proven fix. Audit all readers before changing that shared
flag. Separate method visibility from wide function-return representation with
numeric and wide-return probes, while retaining the original failing control.
Preserve object/callable identity and receiver behavior; do not copy the
object into a new carrier or substitute an interpreter for known AOT source.

After conversion is fixed, wire the lexical provider into the native Context
artifact builder and adapter imports, rebuild clean artifacts, and rerun
unchanged Deno tests. General Script semantics and conformance remain open as
detailed below. Preserve unrelated tracked edits and untracked files. This
wrap-up adds documentation only, with no new compiler or adapter changes.

## Measured boundary

At compiler `83442252a6d`, a provider exports its realm, allocation-owner
predicate, Reflect.get and exception tag. Independently compiled untouched
Scripts use `scriptGoal: true` and import that provider. Explicit
`globalThis.published=42` is observed as 42 by the provider. A fresh provider
after `var published=41; published=42` instead observes no value 42. This
rules out missing realm linkage as the var failure's explanation. The live
var value is still held in a private Wasm global. Lexical declarations also
do not persist into later independently compiled Scripts.

At that initial checkpoint, the persistent-environment regression file had
one positive property-write control and two explicitly expected failures.
It now has 12 ordinary controls and those two expected failures. Remove
`.fails` only when each real requirement is implemented.

## Resume checkpoint: 2026-10-01

Compiler branch: `codex/4376-deno-callback-construction-20260930`.
Open, non-draft PR: https://github.com/loopdive/js2/pull/6341.
Implementation tip: `96c4d6f833a2473317a7b7b6fb8b86fccb98aec6`.
The signed merge `ec1375e79d8` includes main
`e303c5c7946e92d66d89b0a18e2632905b1a0dde`.

The current turn inspected lexical implementation sites but made no lexical
implementation changes. No provider ABI has been selected or wired. The next
work must implement canonical cells and declaration preflight, not widen the
existing runtime-eval map into a substitute for persistent Script semantics.

Relevant inspected seams:

- `declarations.ts`: declaration preflight must precede private var seeds,
  function seeds and `emitScriptGlobalVarBindings`, before user code runs.
- `statements/variables.ts` and `statements/tdz.ts`: initialization must be
  distinct from assignment. Rewriting every global.set as initialization, or
  inferring initialization from a private flag, permits illegal TDZ writes.
- `expressions/identifiers.ts`: local and captured shadows precede global
  lookup. A later Script's unresolved name must consult the declarative record
  without exposing let/const as object properties.
- `expressions/unresolvable-assign.ts`: resolve the target before evaluating
  the RHS; writes must retain that Reference. Include increments, compound
  assignment, destructuring and IR stores, not only simple assignment.
- `global-environment.ts`: its runtime-eval lexical map lacks the required
  shared declaration/TDZ/const protocol and must not be credited as that record.

Preflight must validate the entire declaration manifest before creating any
new cells. Checking and creating one declaration at a time leaves partial
bindings behind if a later declaration conflicts. Preserve module separation,
typed computation specialization, shared thrown-value identity and AOT-only
deployment for known sources.

Latest compiler verification: TypeScript 7 passed; eight regression files
reported 73 tests, comprising 71 ordinary passes and two expected failures.
The 20 direct iterator controls all pass. Pre-push checks also passed 18/18
numeric-local tests, lint, formatting and issue integrity. Size checks were
additionally run against the merged main SHA, with allowances for existing
branch changes documented in the issue. Dead-export command exits zero but
still explicitly refuses complete runtime-retirement certification because
two dynamic-import targets remain open; do not report that certification.

Last verified native Deno artifact is older than the current compiler:
`/private/tmp/deno-reflective-iterator-build.zaaiw7`, compiler
`b37d12382a9a2632130c8b9b2088a1f14470a0fa`, adapter
`2a1ca8426b59596df4d3ad8111aa08b5273c8260`. Compiler-free adapter replay was
31/31 runnable tests, six ignored. Unchanged WebIDL was 13/17, with four
unknown classic Scripts refused before assertions. Do not credit these
artifacts with the latest var or keys/entries changes; rebuild clean artifacts
and rerun unchanged Deno tests after the persistent Script path is wired.

Adapter checkout: `/private/tmp/v8x-deno-resume-20260930.o0sxeO/repo`, branch
`codex/4376-deno-realm-bootstrap`, PR https://github.com/loopdive/v8x/pull/2.
That PR remains draft because general integration is incomplete.
The previously hung conformance run is not completed evidence. Revalidate its
process before acting; do not kill or restart it without user approval.

Preserved unrelated user changes: `src/ir/backend/lower-contracts.ts`,
`website/public/acorn/acorn.wasm` and all existing untracked files/worktrees.
No cleanup, pruning or Deno source/test edits were performed.

Focused test invocation:

```sh
VITEST_MAX_FORKS=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 \
node node_modules/vitest/vitest.mjs run \
  tests/issue-4376-persistent-script-environment.test.ts \
  tests/issue-4376-live-array-iterator.test.ts \
  --poolOptions.forks.execArgv=--experimental-wasm-exnref \
  --poolOptions.forks.execArgv=--max-old-space-size=4096
node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
```

## 2026-10-01 implementation checkpoint

`standaloneScriptVarBindings` adds experimental single-source Script var
transport for dynamic externref bindings. Native getter/setter helpers use
the shared Context object record. The finalizer rewrites all emitted loads
and stores of those exact GlobalDef objects, including callback/IR bodies.
It resolves object identity after late string-global shifts and before DCE.
This uses the existing ownership-aware property reader and canonical realm,
not a Rust interpreter or end-of-script value copy.

Both private undefined-seeding paths must decline for these bindings, so a
later initializer-free var declaration preserves the prior value. Private
dead-top-level-binding elision is disabled for this explicit mode: another
Script can observe declarations that this source never reads. Default-mode
binary output remains unchanged in the control.

Private typed slots and flattened module graphs are explicitly refused.
Their existing type proofs and once-only graph initialization do not establish
Script semantics. This is not a full Script backend, is not enabled by the
Deno artifact builder, and does not close the normal inferred-number var or
lexical expected failures. Typed-boundary planning, persistent declarative
bindings, global declaration validation and completion values remain required.

The 2026-10-01 follow-up closes the separate reflective keys/entries snapshot
gap: all three Array.prototype factories now retain their live receiver.
Iterator next, rest draining and prototype dispatch recognize the two new
iteration kinds. Direct controls pass 20/20; eight regression files report
71 ordinary successes and two expected Script failures. No new native Deno
artifact was built for that change. It does not alter the lexical plan below.

## 2026-10-04 lexical checkpoint and resume instructions

Publish this slice on `codex/4376-deno-lexical-checkpoint-20261004`, based on
local `9c9586301f5`. The previous remote branch advanced to `60f99e83450`
with a main merge (270 commits ahead), so do not force-push over it. The follow-up
PR targets that existing integration branch and must absorb its newer main
before landing. Baseline comparisons below deliberately use the local base.

This checkpoint adds an experimental `standaloneScriptLexicalImport` option,
requiring shared Script var mode. A Context-owned, AOT-native provider is in
`examples/v8x-js2wasm-spike/script-lexical-provider.ts`. Its private cells retain
value, initialization state and const mutability without exposing properties.
The operation ABI is `(externref, f64, externref) -> externref`, with operation
numbers documented in `src/codegen/shared-script-lexical-access.ts`.

Script entry checks the complete declaration manifest before creating cells
or executing initializers. Exact own lexical global loads/stores use native
read/write/initialize helpers. Declaration initialization is explicit metadata
through AST-to-IR lowering and Wasm emission, not guessed from TDZ flags.
Symbol-less reads in a later independently compiled Script consult the Context
record before falling back to global lookup. The option remains off by default.

Verification on the uncommitted checkpoint: TypeScript 7 exited successfully;
the persistent Script environment file reports 20/20 tests, comprising 18
ordinary successes and two existing expected failures for the default API.
These focused controls cover cross-Script reads, Context isolation, declaration
conflicts before effects, abrupt initialization and const retention. The const
catch assertion and abrupt-initializer attribution still need stronger native
error/side-effect controls; do not infer complete exception conformance.

The five-file regression run reports 99/102 successes, including those two
expected failures, with three failures in the existing module lexical assignment
TDZ file. A clean archive of committed baseline `9c9586301f5`, using the same
Vitest fork/exnref harness, reproduces exactly those three failures (43/46).
They are not newly introduced by this checkpoint. TypeScript 7, formatting,
source/function budgets against merged main `e303c5c7946`, coercion and oracle
ratchets pass. The dead-export command exits zero but explicitly reports an open
graph and incomplete dynamic-import evidence: retirement is NOT certified.

This is NOT full persistent Script semantics or completed Deno integration.
Later-Script lexical writes, ambient builtin shadowing, module consumers,
function descriptor/identity rules, classes, lexical destructuring, typed-slot
planning, re-execution and completion values remain unfinished. Unsupported
classes/destructuring/typed lexical storage are refused explicitly. The native
provider has not been wired into the Deno artifact builder or adapter, and no
fresh deno_core binary/population was built for this checkpoint.

Resume with later-Script assignment/reference semantics and stronger controls,
then wire the native Context provider into artifact packaging. Re-run unchanged
WebIDL and the full deno_core population only after general Script execution is
available. Keep the full integration goal open and preserve unrelated worktree
changes; do not stage `lower-contracts.ts`, Acorn binaries or user scratch files.

## Representation and ownership

### 2026-10-04 continuation: exact native BigInt updates

The former wide/overflow TypeError refusals are replaced with native +/-1
arithmetic over canonical BigInt carriers. The builder lives in
`src/runtime/wasmgc/values/bigint-carrier-update.ts`; the codegen registrar
reuses one `__bigint_carrier_update(externref, i32) -> externref` per module.
Only the internal deltas +1 and -1 are admitted by the caller. Narrow overflow
promotes; wide carry/borrow uses copied limbs, trims the result and demotes
back to the narrow carrier when it fits. Postfix returns the primitive old
carrier, never a mutated magnitude or the original pre-conversion object.
No interpreter, compiler-at-runtime or Deno source modification is added.

Same-Script top-level lexical updates now use the Context cell too, selected
by exact source declaration identity instead of its name. Block and function
shadows keep their private storage. The own-Script control failed before that
routing change; it and the shadow control now pass. TDZ still throws before
writing; const PutValue retains the old value after exact computation.

The two replacement ordinary tests both threw before implementation and now
verify actual wide/postfix and signed-boundary/prefix results. A 24-case
runtime matrix passes for zero/sign changes, both signed-i64 boundaries and
positive/negative 192-bit carry/borrow. Later independently compiled Scripts
inspect both String results and native strict equality, including retained old
values and canonical wide-to-narrow transitions. The intermediate focused run
was 66/66 (64 ordinary successes plus two retained expected failures).

Final five-file regression run: 143/147 reported successes, comprising 141
ordinary successes and two existing expected failures. The persistent Script
file is 69/70 (67 ordinary, two expected). Its one ordinary failure is the new
cross-Script object/valueOf conversion control: the method isn't called.
The other three failures are the previously documented module-assignment TDZ
baseline failures. Selected files: persistent-script-environment, script-result,
module-lexical-assignment-tdz, realm-structural-carrier and live-array-iterator.
Do not claim a green final suite or mark the new conversion control expected.

Native owner/independent-Script A/B, same tsx/exnref harness and exact source:
clean `fbe1958bd79` archive and candidate both report `scoreControl: 41,
objectControl: 1, score: 0, exact: 0`. The positive controls prove the shared
property and object are present; the failing valueOf conversion predates this
update implementation. Runtime ToPrimitive's foreign method visibility and
callable carrier need investigation, as does wide return-value storage. Do not
copy a nominal object into another object as a substitute for preserving identity,
or enable the broad runtime-eval boundary flag without auditing its consumers.

TypeScript 7, formatting, main-relative LOC/function budgets (base
`60f99e83450`), coercion and oracle ratchets pass. The dead-export command exits
zero but still reports open dynamic-import evidence, not certified retirement.
No new native Deno artifact or full unchanged deno_core run is credited.
Remaining goal includes foreign conversion/callable transport, other exact
wide arithmetic, destructuring/with/eval/class/function/Script completion
semantics, native lexical-provider packaging and full Deno verification.

### 2026-10-04 continuation: exact first wide initializer

After checkpoint `32708a6a99c`, the wide initializer defect is fixed at
`bigint-wide.ts::tryFoldBigIntConstant`. The linked Script's first BigInt
constant reached this routine before the native union carrier types existed.
`ensureLateImport(__box_bigint)` alone is insufficient: that helper is outside
the late-import union name set and may already have a pending import. Use the
existing idempotent `addUnionImports` and flush index shifts before emitting the
exact reference carrier. No IR demotion, interpreter or Deno source edit is added.

Same native owner/Script probe: baseline `b17fdc53504` gives `exact: 0, zero: 1`;
candidate gives `exact: 1, zero: 0`. Focused tests now report 41/41, comprising
39 ordinary successes and the two existing expected failures. Five added
ordinary controls cover signed-i64 boundaries, positive/negative 2^64 and a
folded expression, with values inspected by a later independent Script.
The original wide refusal test now reaches and verifies its guard, but that
guard still rejects valid updates rather than implementing exact arithmetic.

The three-file BigInt regression run before the five extra controls reported
61/62, including two expected failures. The one failure is
`issue-6656-bigint-wide-carrier.test.ts::narrowedString`. A separate native
host-free compileMulti probe using that file's exact source reports
`controls: 1, narrowedString: 0, dynamicString: 1` on both clean baseline
`b17fdc53504` and candidate. This is a distinct existing narrow String route
defect, not a new failure or a passing suite. No fresh five-file/Deno artifact
run is credited. Exact wide arithmetic and native packaging still remain.

### 2026-10-04 handoff: captured read-modify-write references

Checkpoint adds cross-Script compound and logical assignments and prefix/postfix
updates through one captured Context Reference. GetValue precedes RHS effects;
the RHS runs once; logical assignments retain short-circuit behavior; const
writes throw after required RHS effects. Numeric strings are converted for
updates, while small BigInts retain their brand and prefix/postfix results.
`persistent-script-rmw.ts` contains the new routes. Synthetic compound RHS
identifiers retain the original node so the existing emitter sees BigInt types;
strict comparison narrowly recognizes potentially BigInt Script updates.

TypeScript 7 passes. Focused tests report 35/36: 33 ordinary successes, two
retained expected failures, and one ordinary wide-BigInt initialization failure.
The five-file run reports 114/118 successes (112 ordinary, two expected), with
that failure plus the same three previously documented baseline failures.
Do not relabel the new wide control as expected or claim these files are green.

A native standalone probe compiled the same lexical owner and independent
Script on clean archive `b17fdc53504` and the current candidate, using the same
tsx/exnref harness. Both report `exact: 0, zero: 1` for initialization with
18446744073709551616n before any update. This establishes an existing literal
representation defect, not correct wide update behavior. Update emission
explicitly refuses wide carriers and narrow overflow with TypeError until
exact native arithmetic exists. The wide test fails before reaching its guard.

Main-relative LOC/function budgets (base `60f99e83450`), coercion and oracle
ratchets pass. Dead-export exits zero but reports open dynamic-import evidence;
runtime retirement is not certified. No native Deno artifact was rebuilt.

Resume by fixing wide initializer representation at its IR/boxing seam, then
implement exact wide update/arithmetic and test consumers of BigInt update
results beyond strict equality. Also still required: destructuring writes,
with/eval activation precedence, classes and typed lexical planning, function
declaration/re-execution/completion semantics, provider wiring into native
Deno packaging and unchanged full deno_core verification. PR #6468 remains a
draft checkpoint targeting the existing integration branch, not main. Preserve
unrelated lower-contracts and Acorn binary edits and other user dirt.

### 2026-10-04 continuation: merged main and cross-Script assignment

Merge `ae009e6597a` incorporates the target integration branch at `60f99e83450`
without conflicts or changes to unrelated user dirt. TypeScript 7 passes after
the merge. Later-Script simple assignment now captures the lexical hit before
the RHS and writes the existing native cell after evaluating the RHS once.
The global miss captures its object-record Reference before the RHS and keeps
strict ReferenceError versus sloppy property-write behavior.

Two other seams had to change together: opt-in unresolved reads must not take
the earlier sloppy-implicit-global shortcut, and top-level strict identifier
assignments must be collected even without private module storage. Before
these changes the new controls either retained 41 or wrote 42 and then threw
on a wrongly object-routed read. Both now produce 42 without leaking a property.
The focused file reports 24/24, comprising 22 ordinary successes and the two
existing expected failures. Additional controls verify const TypeError after
RHS effects and strict/sloppy global misses, using native error-name inspection.

The five-file follow-up reports 103/106 successes, including the two expected
failures, with the same three baseline failures documented above. Main-relative
LOC/function budgets (base `60f99e83450`), coercion and oracle checks pass; the
dead-export command still does not certify retirement. No native Deno artifact
is credited by this compiler-only run.

The new helper is `src/codegen/expressions/persistent-script-lexical-assign.ts`.
Compound/increment/destructuring writes and eval activation precedence still
need explicit controls and implementation. Do not infer them from simple `=`.
Next packaging seam: the adapter's sidecar source and classic-Script dispatch
remain the source allowlist described above; the graph compiler is a Module
driver and must not be substituted for independent Script evaluation.

Each Context needs one GlobalEnvironmentRecord with an object record and a
persistent declarative record. Keep Module environment records separate and
do not expose lexical declarations as globalThis properties.

Use canonical mutable lexical cells with binding kind, initialization/TDZ
state and mutability. Object-record var/function bindings must use the actual
property value and attributes. Private Wasm globals cannot remain a second
source of truth. End-of-script mirroring is insufficient: callbacks and
getters can observe writes before the next statement or abrupt completion.

Each compiled Script needs a declaration manifest and execution entrypoint.
Validate all declarations against the Context before any initializer or user
statement. Re-executing source means Script evaluation again, not Module's
once-only initialization. Reject lexical conflicts before effects. A var
redeclaration preserves the existing value until its initializer executes.
Validate restricted global properties and extensibility from actual state.

## Readers and writers that must change together

- `codegen/index.ts` recordSourceGlobalEnvironment currently records names
  for one source/graph. Plan exact declaration identity and distinguish
  persistent Script bindings from module, local and captured bindings.
- `global-var-bindings.ts` seeds undefined while deliberately keeping the
  live value in a private Wasm global. Seeding alone cannot fix persistence.
- `global-function-bindings.ts` can seed a different closure from identifier
  reads. Initialize the same canonical function value for both routes.
- `expressions/identifiers.ts` module/capture routes precede global lookup.
  Select canonical Context cells/properties using exact declaration identity.
- `statements/variables.ts`, `expressions/assignment.ts`, increment,
  destructuring and IR global loads/stores must all use the same binding.
  Extending the narrow toString/valueOf writeback misses other writes.
- `global-environment.ts`, `property-access.ts` and assignment's realm-object
  interception must agree with reflection on values and descriptor semantics.

Publish the shared binding route in source/Program ABI planning before sealing
IR/body ABI. Adding new closures/types in a post-seal seed is not safe. Retain
TypeScript information for computation specialization while shared bindings
preserve arbitrary JS values, callable identity and foreign realm values.

## Completion and exceptions

Keep source unwrapped. Function wrappers change declarations, top-level this,
return grammar and scope. Indirect eval's lexical lifetime is not persistent
Script scope. Neither scriptGoal nor entryScriptGoal provides this feature.

Reuse statement completion rules with an explicit normal result and a separate
exception path carrying the original realm value. Preserve UpdateEmpty,
loop/if/try resets and normal-finally restoration. Do not derive the result
from source text. Pure expression collection and IR discarded expressions must
retain values when completion is observable. Chunked init must thread the
completion across helpers rather than lose it in helper-local registers.

## Verification and packaging

Test independent Scripts in one Context, two Contexts and source executed
twice. Cover var/function/let/const, closures reading/writing between Scripts,
globalThis reflection, initializer-free var redeclaration, lexical conflicts
before effects, TDZ after abrupt initialization, const writes, restricted and
non-extensible properties, descriptors/deletion, strict/sloppy unresolved
references, thrown identity and statement completion/finally. Module controls
must retain private bindings and once-only initialization.

Package known sources AOT with declaration metadata, source hashes, Script
goal and ABI/config identity. Deploy without compiler/interpreter features.
Then rerun unchanged WebIDL (13/17 currently; four scripts rejected before
assertions) and the full unchanged deno_core population. These boundary tests
alone do not prove full integration.
