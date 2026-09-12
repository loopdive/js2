# ES2015 standalone generator protocol rescue handoff — 2026-09-12

This is a local checkpoint for issue #5199. It is a bounded generator-protocol
implementation, not a full ES2015 conformance claim. It is intentionally
recorded before merging current upstream so pre-integration and integrated-head
evidence cannot be conflated.

## Provenance and branch discipline

- Worktree: `/Users/thomas/Code/js2/.codex-worktrees/codex-5199-generator-rescue-20260912`
- Branch: `codex/5199-generator-protocol-rescue-20260912`
- Local base: `d4108568d43f14c361ecc3a58c82633027eaae39`
- Required next integration: normal merge of `upstream/main`
  `06f4cfa4aca3cfa20f1e5c03738956407ec2fedb`; never rebase this work.
- Port source: generator-only hunks manually reviewed from the second commit of
  stale mixed PR #5736, `b3a21dfcd1fc28c13a9f2ef168a8114deee347b0`, relative to
  `357b05f68c8c76b8c4888690941edf9d247243ab`. Do not cherry-pick that commit.

The port excludes its super and TypedArray-specific hunks. In particular, do
not take or overwrite the TypedArray lane's `ta-dyn-mop.ts`, `native-proto.ts`,
or `proto-index-store.ts`. `context/types.ts` and
`statements/nested-declarations.ts` will overlap #5683 during the upstream
merge: preserve its eager-capture behavior as well as this generator wiring.

## Mechanism now present

- Generator function values acquire a distinct own `prototype` object with
  `%GeneratorPrototype%` as parent. Instance allocation captures the current
  factory property; primitive factory properties remain public but select the
  intrinsic fallback for a new instance.
- Generator states expose a canonical ordinary-object prototype view through
  the closure-bag infrastructure without pretending that the state itself is a
  Function. Explicit null and factory-provided links therefore survive repeated
  view lookup and integrity operations.
- Public `next`, `return`, and `throw` calls resolve the observable method
  before arguments, use ordinary Get with the original generator as receiver,
  honour own/inherited nullish shadows with a catchable TypeError, and otherwise
  dispatch the intrinsic method.
- IteratorResult reads distinguish a genuine native result struct from an
  arbitrary object returned by a mutable method override. The former keeps the
  native field path; the latter performs ordinary property Get, preserving raw
  value and accessor behavior.
- Generic `yield*` delegation uses the existing ported iterator record and
  result unwrap/re-read machinery.

## Exact local evidence (not integrated-head evidence)

All commands below ran with one compiler worker and one Vitest fork.

```sh
COMPILER_POOL_SIZE=1 node node_modules/vitest/dist/cli.js run \
  tests/issue-5199-native-generator-prototype.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot
# 11/11 pass; every unchanged source asserts compile success, imports=[],
# WebAssembly.validate, and runtime result 1.

COMPILER_POOL_SIZE=1 node node_modules/vitest/dist/cli.js run \
  tests/issue-5199-generic-yield-star.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot
# 27/27 pass; each fixture asserts the same standalone/import/validation conditions.
```

The original inherited-getter fixture initially failed because an `IteratorResult`
static narrowing treated an arbitrary override result as the native result
struct. An `any` cast proved the runtime method/receiver path but was only a
diagnostic. The unchanged original source is now among the 11/11 passes and
must be reported that way; do not count the diagnostic separately.

No rebuilt compiler bundle or QuickJS provider exists for this exact local
source after the latest changes. Earlier provider and `44/44` protocol results
are stale evidence and must not be used for acceptance.

## Required continuation order

1. Commit this local checkpoint, then merge `upstream/main` at `06f4cfa4` in the
   worktree normally. Resolve the two #5683 overlap files by preserving both
   intents.
2. Rebuild the compiler bundle and the QuickJS evaluation provider (not the
   interpreter provider) against the integrated head. Capture provider/artifact
   provenance before running exact Test262 paths.
3. Rerun, with `COMPILER_POOL_SIZE=1`: original prototype11, 27 generic pins,
   original bridge9, exact44 protocol/control cohort, legacy-producer positive
   control, and 27 focused Vitest pins. All source fixtures must remain
   `imports=[]` and valid Wasm. Claims about Test262 use only its exact corpus
   paths.
4. Compare Test262 runs only to
   `/Users/thomas/Code/js2/.test262-cache/test262-standalone-current.jsonl`
   (SHA-256 `45ff56e7570bba0a1bff6590d19d35de2525928adb7e3054789ba35aebb29360`,
   11,704 rows: 10,230 pass, 1,144 fail, 329 compile_error, 1 timeout).

## Residual outside this bounded bridge

Numeric payload transport is intentionally not claimed complete. The state ABI
currently couples numeric yielded elements to caller-supplied sent/return
payloads. A follow-up needs separate payload/result representations, raw
externref transport through resume/abrupt/completion paths, and numeric
specialization only at a proven numeric consumer. The original three controls
(suspended return(object), completed return(object), ignored next(object)) are
the acceptance gate for that mechanism.

Closed-object identity also fails in a no-generator control. That is a separate
object-carrier dependency, not evidence for or against this PR's bridge. Leave
it unmodified here; preserve the control and coordinate with its owner before
changing representation.

## Readiness

At this checkpoint the source-level prototype11 and generic 27 cohorts are
green, but the branch is not yet integrated, rebuilt, or exact-corpus re-run.
It is therefore a useful checkpoint, not a merge-readiness claim. A PR is draft
only if the integrated validation remains genuinely incomplete or blocked; a
green bounded bridge can be non-draft while the separately documented numeric
payload mechanism remains tracked.
