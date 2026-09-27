# Construction-lease validation receipt — 2026-09-27

## Scope and terminal result

Working directory: `/Users/thomas/Code/js2/.codex-worktrees/codex-5883-protocol-get-20260927`.
Parent explicitly granted isolated validation only. No parent edits, production wiring, activation, commits or push. No parallel compiler process launched by this task.

First and only test invocation: **128/128 passed, 7/7 files, 0 failures**.
First and only TypeScript 7 invocation: **exit 0, no diagnostics**.
No source fixes or reruns were needed; original first results are preserved.
Both processes are terminal. **Compiler slot explicitly returned to parent.**

## Exact commands and logs

Test command:

```sh
npm test -- tests/issue-5883-emission-ownership.test.ts tests/issue-5883-emission-ownership-review.test.ts tests/issue-5883-emission-ownership-authenticated.test.ts tests/issue-5753-native-proto-demand.test.ts tests/issue-5883-staging-foundation.test.ts tests/issue-5883-staging-edit.test.ts tests/issue-5883-construction-lease.test.ts --no-file-parallelism --maxWorkers=1
```

Initial handle `106157`, session `75314`; terminal handle `68d59d`, exit 0.
Full output chunks preserved in `.tmp/construction-lease-tests-first-20260927.log`.

Measured individual counts: ownership21 + review19 + authenticated6 + demand8 + staging21 + editor14 + lease39 = **128**.
Vitest 3.2.4: start 08:10:58; duration 1.49s; transform 112ms, collect 167ms, tests 57ms, environment 1ms, prepare 285ms.
No missing files, skipped tests, or failed suites reported.

Typecheck command (started only after tests terminal):

```sh
node node_modules/typescript7/lib/tsc.js --noEmit -p .tmp/tsconfig-construction-lease-validation-20260927.json
```

Initial handle `3938f0`, session `16448`; intermediate `efa6a5`; terminal `f84705`, exit 0, no diagnostics.
Full output chunks preserved in `.tmp/construction-lease-typecheck-first-20260927.log`.

Temporary config `.tmp/tsconfig-construction-lease-validation-20260927.json` extends `../tsconfig.ts7.json`, sets rootDir to `..` and noEmit, includes ALL `../src/**/*.ts` and each of the seven test files explicitly, overrides exclude to node_modules/dist/website.
The check includes the foundation's three @ts-expect-error assertions and HiddenRecursiveLeaf exclusion assertion. Vitest passing alone is not evidence for these type assertions.

## Exact copied validation dependencies

This isolated tree did not have demand8 or its metadata-only module. Copied byte-for-byte from current parent `/private/tmp/js2-5883-main-688-20260927`:

- `src/codegen/native-proto-demand.ts`
- `tests/issue-5753-native-proto-demand.test.ts`

Both compared equal to parent before execution (handle `b40801`, exit 0). They are validation dependencies only, not additions to the lease implementation patch. No parent bytes were written.

Original fixtures remain as previously frozen. Editor14 keeps its documented pre-claim fault-injection setup adaptation. This isolated foundation test retains its historical if(false) negative type block; the parent's named-function lint correction must be preserved when integrating. No lint run or parent fixture overwrite occurred.

## SHA-256 before = after

All twelve source/test hashes were compared as an exact text list and matched after both processes terminated:

```text
602f4cb5ac0e329c0be88c9fca3ee842dc7d7df8c48f4c488b359e77a7db262a  src/codegen/context/emission-ownership.ts
058cd724f25a2d1cc059ca1db0d4a0ca3912968e2739f28bdda32f3b1e53a3ff  src/codegen/staging-edit.ts
3deaa2901a28cb51874d8435a45e4c8ae73f5241c34db52bf6b8324b7a648176  src/codegen/staging-instr.ts
2b0c36d6a1c7039aead39a535e7bfcf924a29e6ff49438b97f84001a4b5369ed  src/codegen/staging-census.ts
4bffa180f202fa91f7526e5dcd47981f617d16de40f4583ceafcaed1e3bbf678  src/codegen/native-proto-demand.ts
f9f08113c59350fae7e021ebb176b99837f422e5a9cf985dabea67fb2bd058fd  tests/issue-5883-emission-ownership.test.ts
a31e2e88538e7eb47055fbdaed32a036a3c76c8af1cc5246eee2c0df6ae7f498  tests/issue-5883-emission-ownership-review.test.ts
2fbce1377af17376a21c7a29c44a15e2654b02b978c2ec02128bd54d7b97fe64  tests/issue-5883-emission-ownership-authenticated.test.ts
833a3dcf507fdd17de63caae7a34686b8e645d1da612f4fed99bd22aa24e03a5  tests/issue-5753-native-proto-demand.test.ts
70d9dd3d965672595ea514f1068cd08b03367b1f6f4bd101ff849a12d13d0e0d  tests/issue-5883-staging-foundation.test.ts
bcc4b8773c9d31b40c8e7f6a77839cf64b33d98d1e972dec012f4807ba8efb12  tests/issue-5883-staging-edit.test.ts
617c3bd5207c98f479c45cdb2a5074322ea039e5e0dfcd09efc0a1ba443e10cb  tests/issue-5883-construction-lease.test.ts
```

Lease incremental patch remains:
`plan/agent-context/5883-construction-lease-increment-20260927.patch`
SHA-256 `2140fab0b57385f688c8a1e496c6c63f32d0d9af9596820f1449a9c39300b810`.
Reverse applicability checked again after execution: handle `ea400b`, exit 0, no application performed.
Original source-only handoff remains unchanged, including its historical UNRUN status; this later receipt supplies the measured result.

## Acceptance boundary

This measures pure metadata ownership, demand selection, materialized staging/editor behavior and the new construction-lease rejection/lifetime cases in the isolated tree. It is not runtime semantic acceptance, provider readiness, parent-main integration validation, pending-operation coupling, production wiring, compiler retirement or proof of complete adapter closure.

No additional execution without a new slot grant.
