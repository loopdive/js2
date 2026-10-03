# Persistent AOT Script environment

Required for complete Deno integration, not an alternative acceptance bar.
Sources known at packaging time must execute AOT without an interpreter.

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
