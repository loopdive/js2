# Numeric-i64 first pair: instrument failures, no confirmed numeric witness

2026-09-27. Both first runs terminal; compiler slot returned after integration terminal09e2d1. No live process, repair, rerun, coercion edit, merge, commit, push or hold change. First file/reports remain frozen. Parent's newer main45626 was NOT incorporated into either pinned subject.

## Actual chronological order and subjects

**Baseline FIRST**, despite the candidate report being seen first by the parent:

1. Fresh detached baseline `/private/tmp/js2-5748-main7443-numeric-i64-control-20260927`, HEAD `7443ab4826fde65b72f875e0af12337a35520932`. Worktree creation with normal git/no hook overrides: session65678, terminal2d4b18 exit0. The existing wide-carrier baseline tree was untouched. Only the additive file was copied using apply_patch, plus existing node_modules symlink; no install. Tracked compiler/tests/config diff against HEAD verified empty before and after.
2. Baseline test start **11:02:11**, session **12741**, terminal **23661c**, **exit1**, **0pass/2failed**. Process fully terminal before candidate started.
3. Candidate test start **11:02:44**, session **16270**, terminal **09e2d1**, **exit1**, **0pass/2failed**. Candidate remains `/Users/thomas/Code/js2/.codex-worktrees/codex-5748-main7443-integration-20260927`, HEAD `60fb42a20c0c71e1f273527571170e38da9e5d1e`, uncommitted MERGE_HEAD7443, with prior reviewed resolution/formatting and approved five-line deletion. No source changes during either run.

Node v22.23.2, Vitest3.2.4, shared existing dependencies. Same test bytes before/after both runs: `tests/issue-5748-numeric-i64-string-pair.test.ts`, SHA256 **`705bc72f648b977aed9aac6c3702710c2400701df34297cbb717352805d69184`**. No additive TS7 run was performed; optional typechecking was not claimed.

Exact command in each subject, with BASENAME `5748-numeric-baseline-first` / `5748-numeric-integration-first` respectively:

```sh
set -o pipefail; VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node node_modules/vitest/vitest.mjs run tests/issue-5748-numeric-i64-string-pair.test.ts --no-file-parallelism --maxWorkers=1 --maxConcurrency=1 --reporter=default --reporter=json --outputFile=.tmp/BASENAME.json 2>&1 | tee .tmp/BASENAME.log
```

No parallel test cases, no filters, no interrupted/restarted processes. Full stdout logs include complete JSON receipt lines despite tool-output truncation.

## First observations, without reclassifying failures as passes

### Numeric source — witness invalid for intended ABI on BOTH subjects

Case `compares constructor and call strings for numeric-i64`.

Native vm, numeric `2 ** 60`: constructor and direct String both **`1152921504606847000`**, equality1. Compile succeeds, binary instantiates with zero imports. But calling ctorLength with raw Wasm-JS BigInt1152921504606846976n throws **`TypeError: Cannot convert a BigInt value to a number`**, before any actual string is collected. No numeric runtime output or equality observation exists.

Captured actual WAT type declaration: `(type $probe_type (func (param f64) (result f64)))`; unit helper type has `(param f64 f64)`. Named probe/ctorLength/callLength use type63 in both subjects. Named roots' direct call lists show `number_toString` for both numeric paths, not the hypothesized numeric-i64 constructor formatter. The intended unbranded i64 ABI is therefore **not established**; passing a host BigInt cannot manufacture it.

Source explanation: `src/codegen/native-type-annotations.ts` explicitly omits i64 from its syntactic NATIVE_TYPE_MAP (“needs BigInt integration”). The older index.ts map also omits i64; its aliasSymbol-based resolver is documented inert for primitive aliases. The inspected `tests/linear-numeric-type-alias.test.ts` uses the separate linear backend and calls viaI64 with Number41; it is not evidence of a raw-i64 standalone ABI. **No supported unbranded numeric-i64 standalone source form has been identified.** Do not silently change this test to a bigint parameter, fabricate a ValType, edit the native-type map, or run it with a Number and claim it covers the requested i64 boundary.

### Branded source — strings captured, but instrument assertion still fails

Case `compares constructor and call strings for branded-bigint`.

Native vm BigInt1152921504606846976n: both strings **`1152921504606846976`**, equality1. Captured `$probe_type` is `(param i64) (result f64)`; unit helper is `(param i64 f64)`. Raw ABI call succeeds.

- Baseline captured constructor **`1152921504606847000`**, direct **`1152921504606846976`**, equality0.
- Candidate captured constructor **`1152921504606846976`**, direct **`1152921504606846976`**, equality1.
- Both fail afterward at line115 with **`AssertionError: missing emitted observation root: expected null not to be null`**. These are formally failed tests, not baseline0/candidate1 accepted passes.

Named function edge records show baseline constructor/probe calls number_toString(index61), whereas candidate constructor/probe calls bigint_toString(index63). Direct String observation functions on both use \_\_extern_toString(index182), with boolean-dispatch helpers. These are captured named-function edges, **not yet authenticated from the actual binary export roots** because the root mapping instrument failed. They support further inspection but do not independently establish the engine route claim requested by parent. No compiler repair inferred from these partially instrumented observations.

## Why v1 root mapping is insufficient; proposed v2 prerequisite only

All five parsed export roots are null in both cases/subjects. Source inspection exposes a concrete mismatch: `src/emit/wat.ts:228` prints export `exp.desc.index` directly, while call/return_call use resolveFuncIdx and `src/emit/binary.ts:952` resolves function exports with fIdx. Function exports may carry stable handles (base1<<21), not positions in the ordered function list. V1 assumes a WAT export integer is a physical function index; that assumption is unjustified. The test did not persist the WAT export lines themselves, so their actual integers cannot be recovered from the v1 receipts; do not present inferred integers as measured evidence.

Before any v2 execution: use the emitted **binary export section** to authenticate export name → physical function index, and binary function/type information or an existing binary inspection API to establish actual parameter signatures. Match those physical definitions to emitted WAT bodies; preserve complete export lines, signatures, conversion instructions and formatter targets. Do not subtract a guessed stable-handle base, silently match only function names, modify production WAT emission for the test, or weaken string/value expectations. A supported numeric-i64 source route still needs agreement; if none exists on this standalone backend, explicitly report that gap rather than replace the experiment with another carrier. No v2 edits or runs performed here.

## Evidence files and hashes

Baseline root `/private/tmp/js2-5748-main7443-numeric-i64-control-20260927`:

- `.tmp/5748-numeric-baseline-first.json`: `e435e6485f664a3531b3a475b58f309ae3f63bcc287c095111639f7fa620e1ec`.
- `.tmp/5748-numeric-baseline-first.log`: `11968c75ec31e08ab56b10c4b6f8790a9659b8ffb573daf59e9ae6f72bda5faf`.

Candidate root above:

- `.tmp/5748-numeric-integration-first.json`: `89491249ab750f311ead086d8ba68ab6ecb676f808af16662a3e24b68843823d`.
- `.tmp/5748-numeric-integration-first.log`: `a32b108ebb3af0b445a34ee0882de8b2f6c531508095fe146991310b7ee236e2`.
- `.tmp/5748-numeric-first-inspection.jsonl` extracts native/actual values, failure text and named-function direct edges from the full logs; it does not repair the null-root evidence.

Both first JSON reports retain original failure stacks with their different absolute checkout paths. No normalization overwrote those records. No original fixtures changed. Coercion-engine working diff remains empty relative to its pre-run index; proposed brand gate remains unapplied. Slot returned; next compiler work needs a new grant. This pair does not establish a numeric-i64 engine regression, a safe repair, or PR acceptance.
