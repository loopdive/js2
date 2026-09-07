# ES2015 generator checkpoint handoff — 2026-09-08

This is an unfinished checkpoint for issue 5199, **ES2015 standalone generators —
r2 residual pass**. The user requested landing current work and a handoff/PR;
scope is frozen. It is not a completed conformance change or merge-ready fix.
No commits or pushes were made by the generator worker.

## Source and ownership

Worktree: `/tmp/js2-es2015-generators`, branch
`codex/5199-generic-yield-star`, immutable source base
`95186a4835a1fe7a024172a61be94781c7995670`.

The root integration worktree contains separately verified super-property work.
Do not overwrite its declarations.ts/class-bodies.ts or TypedArray lane files.
Generator source inventory is `.tmp/5199-owned-files.txt`; final source/test
hashes are `.tmp/checkpoint-source-sha256.txt`. Include the three new generator
modules and new test file; a tracked-only git diff omits these untracked files.

## Implemented checkpoint

- Generic yield-star uses a captured iterator/next record and complete three-mode
  next/return/throw dispatch. Initial next receives undefined with one argument;
  subsequent payloads remain externref. GetMethod distinguishes missing/nullish
  from non-callable values; missing throw closes with zero arguments, validates
  the cleanup result, then throws TypeError. Non-done return remains suspended.
- Resume's internal result uses done=-1/value=raw delegated IteratorResult.
  Public methods unwrap the original object. Internal for-of, vector conversion,
  iterator carriers and iterator higher-order functions unwrap and re-read done
  before value; the second getter can change or throw. Ordinary result reads box
  numeric undefined sentinels correctly.
- Generic frames have a running flag. Direct/intrinsic dispatch validates before
  mutating payloads; resume validates outside its completion-catching wrapper and
  resets the flag on normal return or escaping throw.
- Protocol exceptions route through catch/finally, and caught failures clear the
  iterator record before loop re-entry. `return yield*` routes its completion
  through the existing completion walker. Delegated return inside a finally body
  remains an unsupported planner placement.
- Public native method calls get the method before evaluating the full argument
  list. Intrinsic wrappers use raw dispatcher entry points so an extracted method
  is independent of later property replacement. Numeric carrier conversion is
  delayed until the selected numeric branch; this alone does not solve arbitrary
  numeric-generator payload semantics (below).
- Native state property reads now connect to ordinary property bags/prototype
  views and canonical GeneratorPrototype builtin methods. Factory helpers create
  a distinct own prototype with shared GeneratorPrototype as parent, preserve
  explicit property values, and use the spec fallback only for primitive values.
  Function-value materialization initializes that property; state creation uses
  the function-expression's actual __self value or the declaration's existing
  cached function value. Two static g.prototype singleton folds were replaced.
- A no-capture nested generator admitted after Phase-0 reservation preserves the
  already published externref result ABI, converting its nominal state at the
  factory boundary. Parameter/result ABI assertions remain active.
- `__any_iter_next` keeps a host generator fallback only when a legacy generator
  was actually emitted, rather than retaining a merely pre-registered host import.
  The requested positive legacy/mixed producer regression control is still due.

## Evidence: distinguish final checkpoint from earlier candidates

Final frozen-source checks:

- Configured TS7: PASS, `.tmp/checkpoint-types.log`.
- Compiler bundle: PASS, `.tmp/checkpoint-build.log`.
- Basic standalone smoke: imports=[], result12, `.tmp/checkpoint-smoke.log`.
- Focused Vitest: **27/27 PASS**, one fork, each imports=[], valid Wasm, result1;
  `.tmp/checkpoint-pins.log` and tests/issue-5199-generic-yield-star.test.ts.
- Original native bridge fixtures: **4/9 rows report PASS**, all nine now compile
  and have imports=[]; `.tmp/checkpoint-bridge.log` and
  `.tmp/checkpoint-bridge-results.json`. The immutable baseline reports1/9.
  The invalid-receiver-only passing row is weak: it does not prove the saved
  method succeeds on a valid receiver. A strengthened source exists but is unrun.
- LOC/function gates PASS after exact issue-scoped grants;
  `.tmp/checkpoint-{loc-budget,func-budget}-final.log`.
- Coercion-site and oracle gates PASS;
  `.tmp/checkpoint-{coercion-sites,oracle-ratchet}.log`.
- `git diff --check`: PASS. Check `.tmp/checkpoint-dead-exports.log` for the
  separately queued final dead-export check.

Earlier evidence, **not a validation of the final expanded source**:

- Exact44 protocol/control cohort: immutable8/44 to earlier candidate44/44,
  36 measured pass gains, zero losses/skips. Original20 subset8/20 to20/20.
  Lists/logs: `.tmp/protocol-paths.txt`, `.tmp/protocol-run.log`; immutable logs
  `/tmp/js2-es2015-base-95186a/.tmp/protocol44-baseline.log` and provenance JSON.
- Root11 protocol fixtures and labelled function-expression equivalents22/22
  passed before the later bridge/factory edits; `.tmp/consumer-protocol-results.json`.
- Original bridge9 initially1/9 on both immutable base and first bridge candidate;
  five ABI compile errors and the nested host leak were confirmed baseline issues.
- Earlier original review11 measured5/11, then6/11 after finally routing. Preserve
  `.tmp/review-protocol.log` and `.tmp/review-protocol-r2.log`; don't overwrite
  attribution by treating rewritten diagnostics as Test262 flips.

## Known unfinished behavior

Five original bridge rows still fail on the frozen source:

1. Prototype next override is inherited: result0.
2. Own next override affects direct call and delegation: Wasm exception.
3. Undefined next shadows until deleted: result0.
4. Own return accessor observes generator receiver: Wasm exception.
5. Own null and Symbol.iterator undefined suppress native defaults: result0.

`.tmp/native-generator-prototype-cases.mjs` has11 Node-oracle1 fixtures, including
valid+invalid borrowed-next, own/inherited accessors and null/undefined, alias
bracket/descriptor reads, per-factory identity and primitive fallback. These were
**not run against the frozen compiler**. Cross-family IteratorPrototype identity
is unresolved: the generator iterator parent is separate from the existing
Array/Map/Set/String iterator prototypes. Declaration values use the existing
capture-free module cache; per-activation declaration identity is not newly
established by this checkpoint.

All three numeric-generator payload controls compile/import-free but return0
versus Node1 (`.tmp/numeric-payload-cases.mjs`, numeric-payload-results.json):
suspended return(object), completed return(object), and ignored next(object).
The existing frame/result ABI couples sent/abrupt/result.value to yielded f64.
Follow-on design should separate payloadValType/resultValueType (externref for
standalone/WASI) from optimized elemValType and update all resume bindings,
completion construction and consumers coherently. Do not claim yield inference
permits ToNumber on a caller's return/sent object.

Closed-object strict identity is independently wrong on both immutable base and
candidate without generators. `.tmp/payload-identity-control{,-base}.mjs` returns0
versus Node1. Open-object payload controls isolate generator forwarding and pass;
they do not relabel the original closed-object probes as green. Issues3037/3243
are related context, not established causes; that substrate is separately owned.

## Build/provider and resumption

The final compiler bundle was rebuilt. **QuickJS provider is stale** against the
final expanded source. The earlier verified provider used external artifact
`/workspace/.tmp/es2015-toolchain/artifact`; rebuild it before authoritative
Test262 measurement. Do not use the interpreter-provider builder by accident.

```sh
pnpm run build:compiler-bundle
JS2WASM_QUICKJS_ARTIFACT_DIR=/workspace/.tmp/es2015-toolchain/artifact node scripts/build-quickjs-eval-provider.mjs
COMPILER_POOL_SIZE=1 node --experimental-wasm-stringref --experimental-wasm-custom-descriptors --import tsx scripts/run-test262-paths.mts .tmp/protocol-paths.txt --standalone --isolate
COMPILER_POOL_SIZE=1 VITEST_MAX_FORKS=1 node --experimental-wasm-stringref --experimental-wasm-custom-descriptors node_modules/vitest/vitest.mjs run tests/issue-5199-generic-yield-star.test.ts --maxWorkers=1 --minWorkers=1
GOMAXPROCS=2 node /tmp/js2-es2015-typescript7/package/lib/tsc.js --noEmit -p tsconfig.ts7.json
```

Resume by fixing the five bridge failures and running prototype11, then rebuild
provider and rerun44/pins. Add the legacy-producer fallback control and separate
numeric payload ABI work. Broader regression scope:653 exact-edition paths in
four generator/yield directories (`.tmp/es2015-generator-core-paths.txt`) are only
a bounded directory cohort. Root's exact-feature generator cohort is2486 paths
(`.tmp/root-generator-expanded-paths.txt` in the root lane), within the full11704
ES2015 goal. Coordinate runtime slots: at most two compiler workers globally and
one per cohort/fork. No new large cohorts were launched after the landing request.

PR5063 at d070b558 remains untouched. Its explicit issue1691 handoff informed the
implementation; its old9/13 claims are historical. Exact checkpoint patches are
retained under `.tmp/pr5063/` for review, not adopted as an original-PR merge.
