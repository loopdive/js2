---
id: 3566
title: "standalone: arr.entries() for-of — pair.length reads NaN (value-rep carrier regression, #1320 guard silently red)"
status: ready
sprint: current
created: 2026-07-24
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: iterator, array-entries, standalone
es_edition: es2015
goal: standalone-gap
related: [1320, 2773, 3008]
origin: "2026-07-24 bounded standalone-test audit (dev-opus / #3565 lane): tests/issue-1320-standalone.test.ts silently red on main — outside required checks (#3008), like #680/#3562/#2047."
loc-budget-allow:
  - src/codegen/property-access-dispatch.ts
func-budget-allow:
  - src/codegen/property-access-dispatch.ts::tryLengthAndNameReads
---

# #3566 — standalone `arr.entries()` for-of yields NaN `pair.length`

## Problem

`tests/issue-1320-standalone.test.ts` (the Slice-1 standalone iterator bridge)
is **silently red on current main** — not PR-touched, not in the required guard
suite (#3552), so the #3008 gap hid it. **2 of 10 subtests fail**; both drive an
`arr.entries()` iterator through a native for-of and read `pair.length` on each
`[index, value]` pair.

## Measured evidence (current main, `--target standalone` and `--target wasi`)

```ts
export function f(): number {
  const it = [10, 20, 30].entries();
  let n = 0;
  for (const pair of it) {
    n = n + pair.length;
  } // each pair is [i, v], length 2
  return n; // expect 6; GOT NaN
}
```

- "drives a stored arr.entries() through native for-of" → **expected NaN to be 6**.
- "compiles arr.entries() under --target wasi with no host imports" → **expected NaN to be 4**.
- The two SPREAD subtests (`[...it].length`) still pass — so the iterator drive
  itself works; the regression is specifically **`.length` on the yielded pair
  reading NaN** (the pair carrier's length field is not populated / mis-read).

Verified red on clean `origin/main` (not introduced by any in-flight branch).

## 2026-08-27 clean-upstream implementation checkpoint

This checkpoint starts from `upstream/main` at `fcded6410` and owns only the
entries-pair carrier defect. It must not broaden into general iterator or Array
species work.

1. Reproduce the two existing red assertions in
   `tests/issue-1320-standalone.test.ts` in standalone and WASI, alongside the
   passing spread controls, and inspect the generated pair representation.
2. Trace pair construction and `.length` lookup to the first representation
   boundary that loses the fixed length. Correct that shared boundary rather
   than special-casing the expected numeric result.
3. Add or refine a focused regression that distinguishes pair contents,
   iteration count, and pair length, retaining zero-host-import checks.
4. Run the exact focused tests plus the maintained official-scope Test262
   standalone slice for the affected `Array.prototype.entries` rows. Record
   exact run IDs and counts; empty filtered shards are not rows.
5. Run the repository pre-push gates and commit a clean checkpoint. It is a
   completed fix only if every owned assertion and exact standalone row passes
   with zero failure, compile error, timeout, or skip; otherwise document the
   remaining root and hand off as a draft PR.

## 2026-08-27 clean-upstream handoff (unfinished)

The assigned clean tree is `upstream/main` `fcded6410`. The requested two
assertions are already green in this tree: the focused
`tests/issue-1320-standalone.test.ts` run reports **10/10 passed** (including
the stored-pair `.length` checks for standalone and WASI, plus the spread
controls). The maintained standalone Test262 slice also passed:

```text
run id: 20260827-050926
filter: test/language/statements/for-of/Array.prototype.entries.js
target: standalone, official scope, COMPILER_POOL_SIZE=2
result: 1 pass / 1 total; 0 fail, compile_error, timeout, or skip
```

The required `pnpm run test:262 --official-scope-only` wrapper could not start
in this no-network/no-TTY environment because its pnpm module-status check
attempted an install (`ERR_PNPM_META_FETCH_FAIL` followed by
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). The same maintained
`scripts/run-test262-vitest.sh --official-scope-only` runner, with the pinned
QuickJS artifact and the required LLVM prefix, produced the run above.

An additional representation-sensitive probe remains red in both targets and
prevents marking this issue complete:

```ts
function add(p: [number, number]): number { return p.length; }
const it = [10, 20, 30].entries();
let n = 0;
for (const pair of it) n += add(pair);
return n; // standalone/WASI: NaN, expected 6
```

The producer is not losing the fixed length: `compileNativeArrayIterator`
constructs each yielded pair as `$ObjVec` and calls `__objvec_push` twice
(`src/codegen/array-methods.ts`), while native `__extern_length` already has a
`$ObjVec` field-0 arm (`src/codegen/object-runtime-enumeration.ts`). The
failing tuple-typed helper instead takes the static tuple `.length` path in
`tryLengthAndNameReads` and falls through to generic `__extern_get("length")`
plus numeric unboxing (`src/codegen/property-access-dispatch.ts`); that reader
does not recognize the `$ObjVec` carrier and yields NaN. The next fix should
route that static tuple-length boundary through the same guarded native
`__extern_length`/`$ObjVec` path, with a focused regression for a tuple-typed
helper in both standalone and WASI. No source implementation was changed in
this checkpoint; the issue remains **unfinished** and should be opened as a
draft handoff.

## Root cause (pointer, not yet fixed)

The yielded `[index, value]` pair's `.length` read returns NaN in standalone —
a **value-rep / carrier substrate** issue (the entries()-pair array carrier).
This sits in the Fable-gated value-rep substrate program (#2773); it is **not**
a contained fix and is out of scope for the guard-audit lane. Filed for tracking
so it is no longer invisible.

## Guard status

`tests/issue-1320-standalone.test.ts` already exists and detects this
post-merge (issue-tests.yml) but is NOT enforced. It **cannot** be folded into
the required guard suite (#3552) while red — a red entry blocks every PR. Fold
it once the substrate fix greens it.

## 2026-08-27 resumed implementation plan

1. Add the tuple-typed helper probe as a permanent standalone and WASI
   regression before changing dispatch.
2. Route only tuple/array `.length` values whose runtime carrier may be
   `$ObjVec` through the existing native length reader; preserve statically
   known string/function length paths and evaluate the receiver once.
3. Verify pair contents and length through both direct loop use and a
   tuple-typed function boundary, with zero host imports in standalone/WASI.
4. Rerun `tests/issue-1320-standalone.test.ts` and the exact maintained
   `Array.prototype.entries` Test262 row. Mark draft PR #5026 ready only when
   every owned regression passes and the exact row remains 1/1 with zero
   non-passes.

## 2026-08-27 resumed implementation checkpoint (complete)

The narrow tuple dispatch seam and permanent coverage are implemented and the
owned acceptance is **complete**. The exact maintained official Test262 row
was rerun after the source change and is green.

- `src/codegen/property-access-dispatch.ts` now recognizes fixed tuple
  receivers in standalone/WASI before the generic array/property fallback.
  The receiver is compiled exactly once; fixed tuple arity comes from the
  existing TypeScript tuple target metadata (`minLength`/`fixedLength`), and a
  value-producing receiver is dropped before the scalar result. If an
  externref reaches this narrow arm, it delegates to the existing native
  `$ObjVec`/vec `__extern_length` reader. Optional/rest tuples are left on the
  prior path because their runtime length is variable. String/function length
  paths are untouched.
- `tests/issue-1320-standalone.test.ts` adds standalone and WASI tuple-helper
  regressions checking both pair contents and fixed length, while retaining
  direct stored-iterator length checks and zero iterator-host-import checks.
- Focused maintained Vitest command, max two fork workers:

  ```text
  node node_modules/vitest/vitest.mjs run tests/issue-1320-standalone.test.ts \
    --pool=forks --poolOptions.forks.maxForks=2 --no-file-parallelism --reporter=verbose
  ```

  Result: **12 passed / 12 total**, including tuple-helper values **69** in
  standalone and **35** in WASI; zero test failures or compile/instantiate
  errors.
- Exact maintained official standalone acceptance after the source change:
  run id `20260827-054015`, filter
  `test/language/statements/for-of/Array.prototype.entries.js`, **1 pass / 1
  total**, zero failures/compile errors/timeouts/skips. Target was standalone,
  `COMPILER_POOL_SIZE=2`, and the pinned QuickJS artifact was used.
- The required `pnpm run test:262 --official-scope-only` wrapper had already
  been blocked in this environment by pnpm's no-network/no-TTY module-status
  install attempt (`ERR_PNPM_META_FETCH_FAIL`, then
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). The maintained wrapper later
  ran successfully with the pinned pnpm PATH and produced the exact row above.
- Read-only pre-push gates after the fix all passed: TypeScript 7 typecheck,
  Biome lint, full Prettier `format:check`, oracle ratchet, coercion-site
  ratchet, issue integrity, and numeric-local parity (**18/18**).

The timestamped Test262 report JSONL/JSON and standalone report symlinks from
run `20260827-054015` were removed after recording evidence; committed report
mirrors remain unchanged. PR #5026 can be marked ready from this checkpoint.
