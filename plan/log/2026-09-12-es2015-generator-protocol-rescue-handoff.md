# ES2015 standalone generator protocol rescue handoff — 2026-09-12

This handoff records the final integrated state for issue #5199. It is a
bounded generator-protocol implementation, not a full ES2015 conformance
claim. Pre-integration evidence remains labelled as such below and is not
substituted for final-head validation.

## Provenance and branch discipline

- Worktree: `/Users/thomas/Code/js2/.codex-worktrees/codex-5199-generator-rescue-20260912`
- Branch: `codex/5199-generator-protocol-rescue-20260912`
- Local base: `d4108568d43f14c361ecc3a58c82633027eaae39`
- Integrated normally, without rebase: `c645a7627e099173b0b3e0c5daa1d7b5a110a9d5`,
  then #3518's `7c8069cb0770e67014a8df4f42af48bbb7fb5736`, then
  `cbeffc55aaf12cd26a52fcae811d2efa224c4dce`. After publication, #5849 landed
  at `d03c2248002723c01c412ec48c3b585851e38bd0`; the required fresh fetch
  advanced further to current main `ffb338c45b9ce26c0b430a7345f498c403d35441`.
  The normal post-d03 merge tip was `66c44d6470fb6b73624ab9f5fc06915dd00f241e`.
  The merge queue then advanced main to `b433de9ffe4e0c165fe65ff9d4a20bc91854cc1d`
  (#5756), auto-merged it into the fork branch at
  `95b55dbe2387915d54b93228c2bd8d949ce4bf4a`, and the local branch reconciled
  it normally at `22181e55b23e807256c59bc146beafa55c5e973e`.
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
- A native-string generator's legacy f64 abrupt carrier cannot populate its
  string IteratorResult field. Immediate `.return()` result construction now
  mirrors the existing resume-path default fallback, keeping public wrapper
  installation valid without claiming raw arbitrary payload transport.

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

The current pre-integration compiler bundle is
`33dba5253a70deebe42a5f35ef04bfbb2244bbc2b8b6f484725416588188ac9a`.
Its QuickJS evaluation provider used artifact `073742801ba76347` and
canary-verified adapter `d9d66a61210e4856`. Original bridge9 is 9/9 under that
bundle; every row compiled successfully with `imports=[]`, valid Wasm, and
result `1`. The unchanged original prototype11 and generic27 runs are 11/11
and 27/27; the separate bridge suite is 4/4, including a named host-lane
legacy-producer positive control. This is still pre-integration evidence.

The old `44/44` protocol/control output belongs to the stale source/provider.
Its `.tmp/protocol-paths.txt` and legacy-control script were untracked and are
gone, so that exact matrix is unverifiable and must never be reconstructed or
claimed as a current result.

## Initial integrated validation — `cbeffc55`

This was the first publication evidence. It is retained for audit provenance;
the post-d03 validation below is the evidence for the current PR head.

The final compiler bundle is
`b48135496043b1493824ddd47ca8ca309f1bfb77e96ce710a98de902a24e8bf0`.
The QuickJS **evaluation** provider (not the interpreter provider) reused
artifact `073742801ba76347` and built/canary-verified adapter
`a39c62fac5d89739`.

- Original prototype11: **11/11 pass** with every unchanged fixture retaining
  success, `imports=[]`, valid Wasm, and result `1`.
- Original generic-yield-star pins: **27/27 pass** with the same fixture
  assertions.
- Original bridge9: **9/9 pass**, each successful with `imports=[]`, valid
  Wasm, and result `1`.
- Permanent bridge suite: **5/5 pass**, including the named legacy
  rest-parameter host-buffer producer positive control.
- Exact **2026-09-12 protocol36+B8**: **44/44 pass** on the maintained isolated
  runner: A owned protocol rows **36/36**, B authoritative-passing controls
  **8/8**, with no B loss.

The manifest stores canonical JSONL paths beginning `test/`; the maintained
runner wants paths below `test262/test`. The initial exact command was:

```sh
COMPILER_POOL_SIZE=1 JS2WASM_EVAL_ENGINE=quickjs node --import tsx scripts/run-test262-paths.mts \
  <(sed 's#^test/##' plan/log/2026-09-12-es2015-generator-protocol-current-head-paths.txt) \
  --standalone --isolate
```

This current 36+B8 result replaces neither nor reconstructs the historical
untracked protocol44 list. The historical list remains unverifiable.

The authoritative comparison JSONL is
`/Users/thomas/Code/js2/.test262-cache/test262-standalone-current.jsonl`
(SHA-256 `45ff56e7570bba0a1bff6590d19d35de2525928adb7e3054789ba35aebb29360`,
11,704 rows: 10,230 pass, 1,144 fail, 329 compile_error, 1 timeout).

## Post-d03 intermediate integrated validation — `ffb338c45b`

#5849 at `d03c2248` changes compiler/runtime inputs but had no direct source
conflict with this generator patch. The later `d03..ffb338` range contains only
#5341 documentation and npm-compat artifacts. The merge was nevertheless
followed by a compiler and QuickJS evaluation-provider rebuild. #5756 then
entered through the merge queue, so this is retained as intermediate provenance
rather than the current PR evidence:

- Intermediate merge head: `66c44d6470fb6b73624ab9f5fc06915dd00f241e`.
- Compiler bundle SHA-256:
  `31bd3f5b3afcaeda6222bc1017be10a7cdd4f878d7e8801df7e2aa5f8aa09dd2`.
- QuickJS artifact: cache key `2e2d7736713beeda`, SHA-256
  `073742801ba76347`; evaluation adapter cache key `5fc4ed2567c14c45`,
  1,826,684 bytes, built and canary-verified.

All cohorts used `COMPILER_POOL_SIZE=1`; the exact-corpus run explicitly used
`JS2WASM_EVAL_ENGINE=quickjs`.

- Original unchanged prototype11 + generic27 + permanent bridge/legacy suite:
  **43/43 pass**. Every standalone fixture still asserts successful compile,
  `imports=[]`, valid Wasm, and runtime result `1`.
- Original bridge9: **9/9 pass**, each with successful standalone compile,
  `imports=[]`, valid Wasm, and result `1`. Its retained source bodies use only
  the normal entry export wrapper (`function test()` to `export function
  test()`); no diagnostic cast or behavior rewrite is a claimed gain.
- Exact **2026-09-12 protocol36+B8**: **44/44 pass** on the maintained isolated
  runner: A owned protocol rows **36/36**, B authoritative-passing controls
  **8/8**, with no B loss. This remains distinct from the lost historical
  protocol44 list.
- `pnpm run typecheck`, `pnpm run lint`, Prettier, LOC budget, and function
  budget all passed.

## Current merge-queue validation — `b433de9f`

The merge-queue bot created
`95b55dbe2387915d54b93228c2bd8d949ce4bf4a` by merging current main
`b433de9ffe4e0c165fe65ff9d4a20bc91854cc1d` (#5756) into the published fork
branch. The local normal reconciliation tip is
`22181e55b23e807256c59bc146beafa55c5e973e`. #5756 changes IR planning but
does not directly conflict with the generator implementation; the compiler and
QuickJS evaluation provider were nevertheless rebuilt before every final row:

- Compiler bundle SHA-256:
  `461ad8ef1ae4a7ddd958b02ebf4345a5994ff5048b23c9a1ffd99512105b6e0d`.
- QuickJS artifact SHA-256 `073742801ba76347`; evaluation adapter cache key
  `6054229e6f1cf236`, 1,826,684 bytes, built and canary-verified.
- Original unchanged prototype11 + generic27 + permanent bridge/legacy suite:
  **43/43 pass**, retaining standalone compile, `imports=[]`, valid Wasm, and
  result `1` assertions for each standalone fixture.
- Original bridge9: **9/9 pass**, with only its normal test-entry export wrapper
  and no diagnostic cast or behavior rewrite. Every row has successful
  standalone compile, `imports=[]`, valid Wasm, and result `1`.
- Exact **2026-09-12 protocol36+B8**: **44/44 pass** on the maintained isolated
  QuickJS runner: A owned protocol rows **36/36**, B authoritative controls
  **8/8**, and zero B loss. It remains distinct from the lost historical
  protocol44 list.
- `pnpm run typecheck`, `pnpm run lint`, Prettier, LOC budget, and function
  budget all passed.

All corpus commands used `COMPILER_POOL_SIZE=1` and
`JS2WASM_EVAL_ENGINE=quickjs`.

## Residual outside this bounded bridge

Numeric payload transport is intentionally not claimed complete. The state ABI
currently couples numeric yielded elements to caller-supplied sent/return
payloads. A follow-up needs separate payload/result representations, raw
externref transport through resume/abrupt/completion paths, and numeric
specialization only at a proven numeric consumer. The original three controls
(suspended return(object), completed return(object), ignored next(object))
were rerun from their tracked stale-checkpoint source bodies as diagnostics on
the current merge-queue head. All three compile with `imports=[]` and valid
Wasm but return `0` instead of Node-oracle `1`: **0/3**. The export shim used
solely to invoke `test` is not an original-source/Test262 gain. These controls
remain the acceptance gate for the separate ABI work.

The historical closed-object identity control was untracked and is unavailable
for a current rerun. Its recorded no-generator failure is a separate
object-carrier dependency, not evidence for or against this PR's bridge; it is
not relabeled as passing.

## Readiness

The bounded protocol bridge remains ready for a **non-draft** review PR. All
required current-merge-queue source and exact-corpus evidence is green, and the
numeric-payload and closed-identity residuals are explicitly separate
mechanisms. This remains neither a claim of complete generator semantics nor a
claim of full ES2015 conformance.
