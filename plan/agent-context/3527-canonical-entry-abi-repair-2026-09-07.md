# Blocking prerequisite: canonical async entry and call-site ABI

The generic callable/fulfillment distinction remains applicable under the
[standalone WasmGC folder plan](ir-standalone-wasmgc-layering-plan-2026-09-07.md).
Its implementation priority supersedes the host-focused composed acceptance
sequence below. Preserve P's current generic edits; new host/linear work is
deferred and resumption requires the coordinator's explicit dispatch.

Issue #3527: **IR-only R7: AST-free async suspension plans and canonical
Promise ABI**. High decision for the measured CPB composition failure,
2026-09-07. Read-only specification; the coordinator authorizes the ownership
expansion and P implements. C's strict entry-signature guard stays intact.

## Evidence and root cause

Read `/private/tmp/js2-3527-cpb-validation-20260907/.tmp/async-entry-1.json`.
For `async same(seed: number): Promise<number>`, the real producer has:

- `fn.resultTypes = [f64]`, which correctly describes fulfillment/body values.
- The source entry's ABI intent signature and callable contract also return
  f64, which incorrectly describes what a caller receives.
- The same contract separately carries canonical Promise ABI v1,
  promise-only consumption, f64 fulfillment and always-async settlement.

`program-source.ts` builds one signature map by unwrapping Promise return
annotations. It supplies that map both as the body's `returnTypeOverride`
and as ordinary/imported/startup direct-call signatures. The prepared await
site correctly expects an externref operand for a Promise expression, so an
imported async call lowered as f64 fails the operand-type invariant before
the async plan is built.

`program-abi-contracts.ts` independently repeats the conflation by assigning
`fn.resultTypes` to both the source intent's result signature and
`contract.results`. `program-validation.ts` currently requires that equality,
so fixing declaration alone would still reject the corrected program.

These are two uses of one incorrect assumption: body fulfillment results are
also the externally callable results. They must be separated explicitly.
Do not mutate the fulfillment type to externref or weaken an await/body check.

## Decision: distinct body results and canonical callable results

Keep `IrFunction.resultTypes` as the typed source body's fulfillment results.
Keep `asyncPlan.abi.fulfillmentType` equal to the semantic fulfilled value
type (or null for void), and keep the same canonical Promise semantics,
runtime provider selection and suspension edges.

For a complete-program async callable, the declared call result is exactly
one opaque Promise carrier, currently `irVal("externref")`. Use that same
result at every direct call and at the single authoritative source ABI entry,
including a call under await. The await's successor value separately has the
fulfilled type. The entry must return a Promise even when its body fulfills
with void or has no suspension. No scalar result may depend on call context.

This is the existing shared carrier convention for host and native WasmGC,
not a request to allocate a JS-host Promise on every target. B's native entry
constructs its native Promise and applies `extern.convert_any` before return;
the host entry returns its host capability's externref. The source callable
contract remains annotated with canonical Promise ABI, which preserves the
semantic distinction from an arbitrary externref.

Linear async has no accepted physical resource/continuation contract today.
Keep its located unsupported result before emission. Do not make linear use
host imports, reinterpret a pointer as externref, or silently substitute a
different target. A future linear continuation proposal must explicitly
declare its physical callable/carrier mapping and validate it against the
canonical Promise semantic contract. This repair neither chooses that future
representation nor declares linear async supported.

The immediate repair does not add a new general IrType discriminant or a
second ABI entry for the original async function. Its one source binding ID
retains the caller-visible Promise ABI; resume/step helpers remain separate
physical support declarations under the existing P/C contract.

## Exact P implementation scope

Expand P's ownership by **`src/ir/program-source.ts` only among existing
source files**. P already owns `src/ir/program-abi-contracts.ts` and
`src/ir/program-validation.ts`; use those for declaration and validation.
Add a small pure shared leaf
`src/ir/program-callable-contract.ts` and focused
`tests/issue-3527-canonical-async-callable-abi.test.ts` if needed to avoid
duplicating the canonical result rule. P may also extend its currently owned
resource/codec fixtures. No new scheduler, C, B, generic AST lowerer or generic
verifier ownership is granted by this specification.

The shared helper's concrete contract is
`preparedIrProgramCallableResults({ funcKind, resultTypes }): readonly IrType[]`:
async returns the canonical single externref result; ordinary functions keep
their declared body result vector. This helper is scoped to complete-program
production and validation. It must work before `asyncPlan` exists, since the
initial ABI draft is built before async preparation. Do not condition the
rule only on an attachment that arrives later.

1. In `program-source.ts`, retain body/fulfillment results separately from
   callable signature results, keyed by exact unit identity. Determine async
   status from the owned declaration, not its name or whether a call is
   awaited. Use the caller result for every `directCalls` row, including the
   imported/aliased call graph and startup resolver path. Pass the body result
   to `lowerFunctionAstToIr` as before. Parameters remain the same in both.
2. Unwrap Promise annotations only where deriving an async body's fulfillment
   contract. A synchronous function explicitly returning a Promise must not
   be assigned a fulfilled scalar signature merely because the annotation
   mentions Promise. Preserve its supported opaque return contract, or give
   the existing located type-resolution refusal if that body family cannot
   yet be represented. Do not pretend such a function is async.
3. In `program-abi-contracts.ts`, compute canonical callable results once and
   use them for both `intent.signature.results` and `contract.results`.
   Continue attaching the semantic Promise contract after async preparation.
   Initial, transformed and final ABI drafts must agree on the result carrier.
4. In `program-validation.ts`, compare the source entry with the canonical
   callable result rule, while verifying body returns against the unchanged
   `fn.resultTypes` and async resolution against the semantic fulfillment
   type. Keep exact parameter, source-owner, Promise-contract and signature
   checks. Populate declared call signatures from the corrected ABI entries;
   wrong f64 call results must be rejected, not skipped for async functions.
5. Keep the existing `emitPreparedAsyncAwait` operand-equality check. Its
   input now comes from a call producing the declared Promise carrier. The
   await continuation still receives/unboxes the canonical fulfillment value.

No schema-version change is required merely to correct existing fields of the
in-progress v2 producer. Codec validation must reject a contradictory saved
v2 snapshot carrying the old f64 entry/call signature. Do not silently migrate
malformed records or alter the already agreed rejection of v1 persisted data.

## C/B integration remains strict

C reserves the source entry from its corrected declared callable signature.
Its host guard still requires exactly one externref result and canonical
Promise semantics. It must not bind an externref-returning body beneath an
f64 intent or infer the physical signature from a helper's output after
acceptance. B receives the same frame resources and emits the same entry,
resume and step signatures; its semantic value types remain unchanged.

Generic `declared-types.ts` contains a legacy context-dependent async result
exception. Do not remove that global compatibility rule in this repair.
Complete-program validation already supplies authoritative declared
signatures, so the new path can enforce exact results without changing the
legacy pipeline. Likewise do not rewrite the generic return verifier to
compare a fulfilled scalar body with its Promise entry result.

Middle-end follow-up is conditional on evidence: run the imported-call fixture
through the actual final preparation/optimization path and inspect its call
results. If a pass rewrites them back from `fn.resultTypes`, locate that exact
mutation and obtain ownership for the narrow fix. Do not preemptively expand
into generic inlining/monomorphization files or disable optimization wholesale.

## Required acceptance tests

Use actual producer-created programs, with no manual retagging of function or
call result types in the successful fixtures:

1. The measured exported async `same(seed: number)` fixture: body and Promise
   fulfillment remain f64; source intent/contract results are externref;
   C accepts, bytes instantiate, and the actual exported wrapper returns a
   Promise resolving to the expected number.
2. Same-module and imported/aliased async calls under await: the call result
   is externref, await operand is that exact value, resumed result is f64,
   and both complete preparation/codec replay and composed execution succeed.
3. An unawaited async call, including the startup call-plan path, still returns
   the Promise carrier; it must not acquire a scalar shortcut. If startup's
   use of that value needs another unsupported storage family, inspect the
   correct source call row and preserve that unrelated located refusal.
4. Async void and an async body with no await: each still declares one Promise
   result. If the unconditional frame capability closure is not yet selected,
   C must refuse during acceptance, not emit under a void/scalar signature.
5. Synchronous scalar calls remain scalar; synchronous Promise-returning
   declarations are not unwrapped as async fulfillment. Include colliding
   display names from different source units to check binding ownership.
6. Tamper controls: f64 entry intent, f64 callable contract, scalar async call
   result, wrong Promise fulfillment type, donor binding and missing Promise
   contract each fail the corresponding validation before materialization.
7. Host and standalone-native WasmGC preparation retain identical canonical
   Promise/fulfillment semantics with their separately selected providers.
   Native and linear resource gaps remain located unsupported until their
   providers exist; no host imports may appear merely to make them accepted.

Run P's affected producer/codec tests and the existing composed C fixtures,
then the coordinator's serial focused CPB set and typecheck. Report exact
counts and any residual refusal separately. Earlier B/codec passes are useful
controls, not evidence that this new entry/call repair has executed correctly.
