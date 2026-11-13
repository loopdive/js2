# Standalone lifecycle prerequisite: final validation receipt

## Subject and result

Worktree: `/Users/thomas/Code/js2/.codex-worktrees/codex-5748-instance-lifecycle-20260927`.
Branch: `codex/5748-instance-lifecycle-20260927`.
Base: `50f57285922a5084007ba6feadc76838dffda84e`.

Final unchanged source SHA256:

- `src/runtime/instance-lifecycle-adapter.ts`: `a7e6d4b4a661e44781a5414c72204bef0de3d823ef6296b926a20ca97efa0d05`.
- `tests/issue-5748-instance-lifecycle-enrollment.test.ts`: `cba4d915373fbad818d82de305435892e9e57dfa57b72fa5529c371d624f417d`.

46 distinct tests passed, zero failures/skips: final 25 adapter controls and 21
existing neighbors. The earlier 25-control run is additional execution, not
another 25 distinct fixtures. Canonical source TS7, supplemental source/test TS7
(including negative type assertions), and focused formatting all passed on the
final source. All handles terminal; exclusive compiler slot released with this
receipt. No extra reruns, source edits, staging, commit, or push after validation.

## Sequential executions and terminal handles

All commands below ran from the worktree above. Each pipeline used `set -o
pipefail` and retained its first output with `tee`; no process killed/restarted.

1. Initial Prettier write: terminal `c1b8d1`, exit 0.
2. Initial adapter controls: terminal `62d631`, exit 0, 25/25.
3. First canonical TS7: session `71456`, terminal `aabae3`, exit 1 (preserved).
4. Canonical TS7 after narrow literal fix: session `72575`, terminal `c1c3a0`, exit 0.
5. Supplemental TS7: session `43974`, terminal `cda7f5`, exit 0.
6. Existing neighbors: session `65470`, terminal `39077b`, exit 0, 21/21.
7. Final adapter controls: terminal `b79921`, exit 0, 25/25.
8. Final Prettier check: terminal `99f002`, exit 0.

Exact non-test commands:

```sh
set -o pipefail; pnpm exec prettier --write src/runtime/instance-lifecycle-adapter.ts tests/issue-5748-instance-lifecycle-enrollment.test.ts 2>&1 | tee .tmp/5748-lifecycle-format-first.log
set -o pipefail; pnpm run typecheck 2>&1 | tee .tmp/5748-lifecycle-source-ts7-first.log
set -o pipefail; pnpm run typecheck 2>&1 | tee .tmp/5748-lifecycle-source-ts7-literal-fix.log
set -o pipefail; node node_modules/typescript7/lib/tsc.js --noEmit -p .tmp/5748-lifecycle-tsconfig.json 2>&1 | tee .tmp/5748-lifecycle-test-ts7-first.log
set -o pipefail; pnpm exec prettier --check src/runtime/instance-lifecycle-adapter.ts tests/issue-5748-instance-lifecycle-enrollment.test.ts 2>&1 | tee .tmp/5748-lifecycle-format-final.log
```

`pnpm run typecheck` expands to `node node_modules/typescript7/lib/tsc.js
--noEmit -p tsconfig.ts7.json`. Supplemental config extends that config with
`rootDir: ".."`, includes `../src/**/*.ts` and
`../tests/issue-5748-instance-lifecycle-enrollment.test.ts`, and overrides
`exclude: []`.

Exact test commands:

```sh
set -o pipefail; VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node node_modules/vitest/vitest.mjs run tests/issue-5748-instance-lifecycle-enrollment.test.ts --no-file-parallelism --maxWorkers=1 --maxConcurrency=1 --reporter=default --reporter=json --outputFile=.tmp/5748-lifecycle-controls-first.json 2>&1 | tee .tmp/5748-lifecycle-controls-first.log
set -o pipefail; VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node node_modules/vitest/vitest.mjs run tests/issue-3520-branded-instance-api.test.ts tests/issue-5738-linked-unlinked-lifecycle.test.ts tests/issue-6475-linked-provider-realm.test.ts tests/issue-6477-linked-descriptor-reads.test.ts --no-file-parallelism --maxWorkers=1 --maxConcurrency=1 --reporter=default --reporter=json --outputFile=.tmp/5748-lifecycle-neighbors-first.json 2>&1 | tee .tmp/5748-lifecycle-neighbors-first.log
set -o pipefail; VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node node_modules/vitest/vitest.mjs run tests/issue-5748-instance-lifecycle-enrollment.test.ts --no-file-parallelism --maxWorkers=1 --maxConcurrency=1 --reporter=default --reporter=json --outputFile=.tmp/5748-lifecycle-controls-final.json 2>&1 | tee .tmp/5748-lifecycle-controls-final.log
```

Neighbor counts: branded API 4, linked/unlinked lifecycle 6, linked provider realm
6, linked descriptor reads/init 5. Dependencies linked to the existing root
node_modules. Existing Test262 harness/test directories linked only after matching
the checkout gitlink `b363f29d3c43c626dc852744ad64a0b48a003693` to the existing
fixture repository. No install/download or original fixture changes.

## Preserved first failure and exact correction

Initial formatted test already had the final hash. Initial adapter hash was
`0b28a3ab11f4128a4db7b55fa37a419a2bea8395e5e661ba38a48d3482bf67ef`.
First TS7 failed at adapter line 97:

```text
error TS2322: Type 'Readonly<{ [enrollmentBrand]: boolean; }>' is not assignable to type 'InstanceLifecycleEnrollment'.
  Types of property '[enrollmentBrand]' are incompatible.
    Type 'boolean' is not assignable to type 'true'.
```

Only correction: `Object.freeze({ [enrollmentBrand]: true })` became
`Object.freeze({ [enrollmentBrand]: true as const })`. This retains the literal
type instead of widening to boolean; no runtime value/control-flow change,
unsafe type assertion, fixture edit, or expectation weakening. Initial 25/25 was
not treated as typecheck success; final 25/25 was rerun after this correction.

Evidence SHA256 (all under `.tmp/`):

- `5748-lifecycle-source-ts7-first.log`: `e815e41473fac6eb421302d93fc9891ec1f75b51f6c0c8b267307c7cafecc712`.
- `5748-lifecycle-source-ts7-literal-fix.log`: `323234345697efc616e3d272f6de065c616de365c4cd13965e92e47ba84f2ef2`.
- `5748-lifecycle-test-ts7-first.log`: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty successful output).
- `5748-lifecycle-controls-first.json`: `5a69bce234f12cd464d69957e064c8bc6faa527ba3bc67b476feea1b14bb454d`.
- `5748-lifecycle-controls-final.json`: `7e9f580bd8f60e2a69261d9f66dce16d3a0b323823825df1097314a5a2603390`.
- `5748-lifecycle-neighbors-first.json`: `4fb3da7a64bef33e0736c570075e3b80034e84214f5e82aaeaaac3fdadf43c9a`.

## Publication boundary

Hume approved this standalone prerequisite subject to final validation. It
unblocks the lifecycle portion of held5748, not full IR equivalence or the four
array blockers. Enrollment authenticates instance brand and adapter ownership
only, not module provenance. Existing activation/preparation side effects remain
at installation. No DomainV1, graph wiring, native driver, guard exemptions, new
host imports, gate/baseline changes, or compiler retirement.

Parent owns review, staging, commit, and publication. Local publication drafts
are retained under `.tmp/`; the reviewed source and this receipt are the
versioned checkpoint.
