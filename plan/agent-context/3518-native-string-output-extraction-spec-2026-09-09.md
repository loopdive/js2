# Native string-output executable-owner extraction

This is Lane E's first dependency checkpoint, not completed native output admission.
The full five-owner async consumer and real resource/publication integration remain
required by the native-async implementation specification. No acceptance refusal
is removed by this extraction.

## Source and exclusive scope

Base: 721cd33a828c89cfc04c851b011f910b76a4d2c5, published in #5794.
Work in a newly claimed isolated worktree. Preserve all other worker drafts.

Production writes:

- New `src/runtime/wasmgc/values/string-concat-bodies.ts`.
- New `src/runtime/wasmgc/values/stdout-bodies.ts`.
- `src/codegen/native-batched-concat.ts`: emitted helper bodies/locals only.
- `src/codegen/native-strings-basics.ts`: the first `__str_concat` registration
  inside `emitStrConcatHelpers` only. This explicit scope amendment supplies the
  binary concat donor actually called by batched concat and stdout.
- `src/codegen/native-strings.ts`: emitted bodies/locals in
  `ensureStandaloneStdoutSink` and `emitStdoutSinkExports` only.

Tests: new `tests/issue-3518-native-string-output-bodies.test.ts`, plus an owned
source-preservation test if needed. Issue #3518 append and owned handoff allowed.
No existing test edits without identifying the exact preservation requirement.
No consumer, physical plan, ledger, ABI, boundary policy, closure exports, global
runtime catalog or P/C schema edits. Parent owns later resource integration.

## Executable owner contract

Extract complete instruction construction and local definitions into pure runtime
builders. Import canonical Wasm model types directly; no AST, checker, codegen,
environment access, allocator, module mutation, helper-name lookup or callback.
Use explicit typed dependency records containing already resolved layout indices,
function handles/global indices in their correct spaces, arity and option values.
These low-level builder records are not resource-admission credentials.

Binary concat preserves all six locals, optional empty-left/right identity arms,
unsigned combined-length threshold 64, rope field order, flat copy offsets,
defaultable reference locals and every original construction refinement.
Resolve `JS2WASM_STR_CONCAT_EMPTY_IDENTITY !== "0"` in the existing compatibility
wrapper at its existing evaluation point and pass a boolean to the builder.
Do not move/alter buffer growth, owned-concat or comparison/slicing helpers.

Batched concat preserves provider-derived minimum/maximum arity, original helper
signature, operand order, three locals, null-carrier conversion to the literal
`undefined`, flatten test per operand, short-path single allocation and copy,
and left-associated binary concat for length >=64. Keep TypeScript operand
collection and all registration/cache/failure behavior in its old wrapper.
The wrapper must invoke nativeStringLiteralInstrs once per original guard in the
same place relative to registration; pass each resulting detached instruction
sequence explicitly, not a callback or one shared mutable sequence. Validate
its population matches arity. Runtime builder must not mint a literal itself.

Stdout builders cover all three real functions: append, prepare and char.
Append retains nullable input no-op, null accumulator first assignment, nonnull
refinements and actual binary concat. Prepare retains empty length zero and
flattened-buffer update. Char retains null-buffer zero, signed negative/length
bounds, offset addition and unsigned u16 load. Preserve empty locals for append
and prepare, and exactly the nullable flat-buffer local for char.
Retain accumulator/readout global descriptors and null initializers, function
type names, mint/cache/push/export order and all legacy availability checks in
the wrappers. Do not modify emitStandaloneStdoutAppendValue or console coercion.

Builders return fresh bodies/locals on every call. No shared mutable instruction
trees may cause remapping in one function to mutate another emitted function.
Retain donor comments/receipts, including registration-local order that is not
part of the extracted body. Do not reseed historical hashes.

## Required evidence

Before edits capture exact source donor scopes and hashes. Prove complete inverse
reconstruction or old/new actual emission equality, not just export identity.
Include positive-first mutations of concat threshold, operand/copy order, local
nullability/refinement, empty-identity option, undefined literal guard, stdout
null branch, global target, bounds check, offset and unsigned read.

Execute real Wasm using genuine string layouts and canonical flatten, concat and
literal resources. Cover both empty-identity options; empty/short/63/64/65-code-unit
results; flat/rope and UTF16/UTF8 operands; nonzero flat offsets and Unicode code
units; supported batched arities and legacy out-of-range refusal; null-carrier
conversion where the real donor signature permits it. If that signature makes a
null injection invalid, record the constraint rather than forge a passing test.
Use actual stdout prepare/char exports to read multiple appends, empty output,
null append, negative/out-of-range reads and four newline joins. Test fresh and
repeated instances and distinct independent builder invocations.

Keep existing genuine compiler callers live and preserve no-demand behavior.
Do not call this full prepared-consumer or source-free replay proof. The next
Lane E resource checkpoint must still predeclare/reserve/authenticate/fill/publish
these functions with issued string packs, one ABI, and the complete consumer.
Report any missing canonical resource API as a concrete integration dependency;
do not substitute dummy flatten/concat or JavaScript string execution.

No heavy tests, formatter/hooks, commit or push until the parent grants the
serialized slot. Before each mutating git operation verify cwd and branch;
normal attribution and hooks apply. Review before publishing a non-draft PR.
