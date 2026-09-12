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
  then #3518's `7c8069cb0770e67014a8df4f42af48bbb7fb5736`, then final current
  main `cbeffc55aaf12cd26a52fcae811d2efa224c4dce` at merge tip
  `67c36ad828fee7af2bd53f4f5617be03b86f46b0`.
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

## Final integrated validation

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
runner wants paths below `test262/test`. The exact final command was:

```sh
COMPILER_POOL_SIZE=1 node --import tsx scripts/run-test262-paths.mts \
  <(sed 's#^test/##' plan/log/2026-09-12-es2015-generator-protocol-current-head-paths.txt) \
  --standalone --isolate
```

This current 36+B8 result replaces neither nor reconstructs the historical
untracked protocol44 list. The historical list remains unverifiable.

The authoritative comparison JSONL is
`/Users/thomas/Code/js2/.test262-cache/test262-standalone-current.jsonl`
(SHA-256 `45ff56e7570bba0a1bff6590d19d35de2525928adb7e3054789ba35aebb29360`,
11,704 rows: 10,230 pass, 1,144 fail, 329 compile_error, 1 timeout).

## Residual outside this bounded bridge

Numeric payload transport is intentionally not claimed complete. The state ABI
currently couples numeric yielded elements to caller-supplied sent/return
payloads. A follow-up needs separate payload/result representations, raw
externref transport through resume/abrupt/completion paths, and numeric
specialization only at a proven numeric consumer. The original three controls
(suspended return(object), completed return(object), ignored next(object))
were rerun from their tracked stale-checkpoint source bodies as diagnostics on
the final head. All three compile with `imports=[]` and valid Wasm but return
`0` instead of Node-oracle `1`: **0/3**. The export shim used solely to invoke
`test` is not an original-source/Test262 gain. These controls remain the
acceptance gate for the separate ABI work.

The historical closed-object identity control was untracked and is unavailable
for a current rerun. Its recorded no-generator failure is a separate
object-carrier dependency, not evidence for or against this PR's bridge; it is
not relabeled as passing.

## Readiness

The bounded protocol bridge is ready for a **non-draft** review PR. All required
final-head source and exact-corpus evidence is green, and the numeric-payload
and closed-identity residuals are explicitly separate mechanisms. This remains
neither a claim of complete generator semantics nor a claim of full ES2015
conformance.
