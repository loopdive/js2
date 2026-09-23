# Native string-number source admission checkpoint

Status: High approved production and revision-3 tests, as relayed by the
coordinator. Source is frozen; publication and normal hooks are pending.
This is a bounded part of **#3518 — IR-only default and direct front-end
retirement**, not completion of that epic.

Worktree: `/private/tmp/js2-3518-native-string-source-admission-20260909`.
Branch: `codex/3518-native-string-source-admission-20260909`.
Base: `31e4e232eb16804afc1577055d33d1c6530c0e22`.
Existing verified claim: `3518:native-string-source-admission`, assigned to
`ttraenkler/codex-native-string-source-admission`; no claim was repeated.
P explicitly released additive source/preparation forwarding in this
separate tree; its paused draft, async ABI, signatures and plans are untouched.

## Source and interface

The optional `IrProgramSourceInput.nativeStringValueProjection` accepts only
`"standalone-native"`. Before source planning, the source policy must select
`wasmgc:standalone`; before lowering, `prepareWholeIrProgram` also checks
every requested runtime policy. Existing duplicate/source-policy checks keep
their precedence. Omission does not infer this option from the target.

The request forwards optional `AstToIrOptions.stringNumericCoercion:
"number-boundary"`. Only unary plus/minus with a semantic string operand
uses the existing `coerceIrValueToExternref` and provider-free
`js.number.unbox`. The shared helper's Number-wrapper caller keeps its old
three-argument invocation. All three fresh AST contexts explicitly forward
the option; the other 33 typed context objects spread an existing context.
No new provider, runtime-policy field, transport field or production import
was added. `prepareIrProgramSources` measures 280 physical lines.

Approved production Git blobs, verified unchanged after all tests:

- `src/ir/from-ast.ts`: `e473f9fe60242a4f55ae39c048cbe8a750aa6ad6`;
  SHA256 `63c3518b3a2526b207cf6fe231bca3f6d4dee034bb18aa834dff6e4480a35d30`.
- `src/ir/program-source.ts`: `b764c114903425af35371c0bec4a7877891900f9`;
  SHA256 `79e85a768f868fc356cb0b51758d811c4ffeb2069ab52c4ebfe9bf0070c2e30d`.
- `src/ir/program-preparation.ts`: `3e6e01e4e1a7d030b9566b5a16c085e654fe93ea`;
  SHA256 `0e2ce7ecc74b122a5d89123d54297e285b45acad6e566d77bc1cfa9c24dd8bab`.

Final test: `tests/issue-3518-native-string-number-source-admission.test.ts`;
Git blob `8e274fcbbb314fb5edd68b409faf9bcd3f51ca51`;
SHA256 `ac817c562c010d4763a60ae7ae1b60eefa965b44d6f9630be7e5b2e1a2efbc72`.
Only this test changed after production approval. Publication also adds this
handoff and updates the existing issue; it does not add another source module.

## Measured validation and retained failures

All commands ran in the worker above using existing linked dependencies,
Node `v22.23.2`, no installation, and serialized 2 GiB limits.

- Original r1: 30/30 focused cases, handle `77073`, exit 0; TS7 handle
  `50740`, exit 0, no diagnostics.
- Review r2: 34/36, handle `78890`, exit 1, 13.10 seconds. Both effectful
  call cases stopped at `requireSource`'s diagnostic `JSON.stringify(source)`:
  the successfully prepared global retained a real AST parent cycle.
  The failure reports and exact r2 test remain preserved.
- Final r3: 36/36, handle `36081`, exit 0, 11.60 seconds. The sole repair
  from r2 avoids JSON serialization for successful carriers; failed outcomes
  still supply their full JSON assertion diagnostic. No case or source
  assertion was removed.
- Final TS7: handle `54752`, exit 0, no diagnostics. No TS5 run is claimed.
- Scoped formatter, source syntax and manifest checks pass. The heavy slot
  was explicitly released after TS7; no worker heavy process remains.

The six added review cases retain the original 30 controls and prove:

- Each unary operator evaluates one exact source-unit call to a genuine
  string-returning function whose body writes a global. Its result feeds
  coercion, then unbox; minus feeds that unbox result to `f64.neg`. Original
  parameter cases still forbid any call.
- `Number(c ? "42" : 7)` is certified with the actual source checker and
  `makeIrAmbientBindingPredicate`, not an always-true stub. Enabled/omitted
  complete IR is equal and the string arm keeps its historical conversion.
  A separate source-owned Number call is not certified as ambient and keeps
  its exact unit binding and complete IR.
- An explicit valid standalone numeric request successfully completes whole
  preparation and has the same canonical encoding as omission.
- Real string `parse` with policy `numberBoundary: { box: "unsupported",
  unbox: "native" }` reaches `prepared`. Semantic IR remains provider-free;
  the runtime projection selects `native.js.number.unbox` and the structural
  runtime binding `__unbox_number`. The sole observation phase is `prepared`.

Reproduce the final bounded validation from the repository root:

```sh
NODE_OPTIONS=--max-old-space-size=2048 \
VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 \
pnpm exec vitest run tests/issue-3518-native-string-number-source-admission.test.ts \
  --pool=forks --maxWorkers=1 --no-file-parallelism

NODE_OPTIONS=--max-old-space-size=2048 \
node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
```

Worker-local evidence (not required by the checked-in tests):

- `.tmp/native-string-source-admission-frozen-r1.json` and
  `.tmp/native-string-source-admission-validation-r1.json` retain initial
  source hashes and the original 30-case validation.
- `.tmp/native-string-source-admission-focused-r2.json` retains 34/36;
  SHA256 `54a6e04790caf31cf412eb54367d5b512e3dde592a251d9b0a787d33534d242d`.
- `.tmp/native-string-source-admission-focused-r3.json` retains 36/36;
  SHA256 `d5290e05de3eb9a8d3da8ea5577c26daa7c947a8055e8e2f03c657ccc09c7a90`.
- `.tmp/native-string-source-admission-ts7-r3.log` is empty following exit 0;
  SHA256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `.tmp/native-string-source-admission-frozen-r3.json` binds the full commands,
  handles, logs, manifests and failure history. Exact r1/r2 tests are retained
  separately in the same scratch directory.

## Boundary and publication preflight

Static inspection of `scripts/compiler-boundaries.json` finds exactly one
existing record for each changed production path. All remain `unmigrated`,
layer `mixed-needs-split`, owned by `3518-coordinator`. Their destinations
and remaining separation obligations are unchanged. The inventory scans
`src`, so the new test and handoff add no inventory entry.

AST comparison against the pinned base finds identical production dependency
syntax: 66 references in from-ast, 34 in program-source and 10 in
program-preparation. There is no added runtime/type-only import or dynamic
import. The boundary policy remains byte-exact to base, SHA256
`3c0131a1ddabb1f5bd05c577f71939bb6961f8ff794813177a301593e292058a`.
This static preflight is not a fresh boundary-auditor result. Full boundary,
ratchet, issue-integrity and normal hook checks await the publication slot.
No policy/baseline update, allowance growth or retirement evidence is proposed.

Read-only Git checks resolve the author to
`Thomas Tränkler <git@thomas.traenkler.com>` and hooks to `.husky`.
Signing-related configuration is unset; no settings were changed, signing
was not disabled, and no signed-commit claim is made. Recheck identity and
normal configuration when committing. Attribution must include:

```text
Co-authored-by: Codex <codex@openai.com>
Model: Codex GPT-6 Astra Low
```

Use a specific conventional subject referencing #3518. Publish the retained
work in a non-draft **held** PR against `loopdive/js2` through the coordinator's
approved stack; no direct-main push, merge, enqueue or hold removal. At this
handoff no implementation commit, push or PR creation has been performed.
The existing LFS clean-filter permission anomaly is untouched; no broad
staging, filter override or cleanup was used.

## Remaining acceptance

The test does not accept or physically materialize the string program, emit
Wasm, instantiate an artifact or execute its scanner chain. Consumer-side
string demands, literal/reservation ownership, physical joins and genuine
original/decoded execution remain separate work under the
[native string consumer contract](3518-native-string-consumer-contract-2026-09-09.md).
Public default cutover, complete async-family materialization, host/linear
work, strict closure/direct retirement and ABI30's getter witness are not
established by this checkpoint. The issue stays in progress.
