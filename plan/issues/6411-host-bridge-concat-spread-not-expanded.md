---
id: 6411
title: "The host Array bridges hand a SPREAD argument to the host as one item"
status: done
sprint: current
created: 2026-09-12
updated: 2026-09-12
completed: 2026-09-12
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

The same idiom #5361 removed from `splice` / `push` / `Math.min`-`max` / the
generic `__extern_method_call` bridge survives in the two HOST-ARRAY argument
builders in `src/codegen/array-method-host.ts`:

- `compileArrayConcatExternHost` — the `__array_concat_any(recv, args)` bridge;
- `compileArrayMethodExtern` — `__extern_method_call` for a real host-owned
  Array receiver.

Both build the argument array with `__js_array_new` + one `__js_array_push` per
AST node, which is exact only while each argument is ONE value. A spread
contributes its RUNTIME element count, so the source array was handed to the
host as a single argument and `Array.prototype.concat` then flattened one level
too few:

```js
[].concat(...[[], [1], [2, 3]]);   // [[], [1], [2, 3]]  — should be [1, 2, 3]
```

## Evidence

Found as a REAL merged-baseline test262 regression, not by inspection.
`test/built-ins/Iterator/concat/many-arguments.js` compares

```js
let iterator = Iterator.concat(...iterables);
let array = [].concat(...iterables);
```

element by element. **Both sides were wrong in the same direction**, so the file
passed by coincidence: `Iterator.concat(iterables)` yielded the sub-arrays, and
`[].concat(iterables)` flattened to the same sub-arrays, and `sameValue`
compared identical objects. #5361 fixed the `Iterator.concat` side; the
coincidence broke and the file flipped **pass → fail**
(`Expected SameValue(«1», «») to be true` — `array[0]` was still `[]`).

That is the whole of the `net_per_test -1` that parked PR #5819 in the merge
queue (run 34680468369, 0 improvements − 1 regression). The `[].concat(...)`
half is INDEPENDENT of #5361 and predates it — measured with #5361's codegen
reverted, the same probe produces the same wrong answer.

## Acceptance criteria

1. `[].concat(...arrays)` flattens every spread element, for inline array
   literals and for host (externref) arrays, with the correct length.
2. A spread interleaved with positional arguments keeps argument order.
3. A spread-free call emits byte-identical code (the unrolled loop is kept).
4. `built-ins/Iterator/concat/many-arguments` passes again.
5. Regression test pinning length AND a non-comma-joined value.

## Resolution

Fixed. `tryEmitSpreadHostArgs` (`src/codegen/host-method-args.ts`) is the
shared entry both bridges now call before their own unrolled loop: with a
spread present it drives #5361's `buildSpreadArgList` with a
`__js_array_push` sink; with no spread it returns `false` without emitting
anything and each caller keeps its existing loop verbatim.
`emitHostMethodCallArgs` (the #5361 caller) is re-expressed on top of it, so
there is ONE place where the syntactic-vs-runtime argument count is repaired
rather than a sixth copy of the loop.

### Measured

Scoped test262 slice — every file under `built-ins/Array/prototype/concat`,
`built-ins/Array/prototype/push`, `built-ins/Array/prototype/splice` and
`built-ins/Iterator/concat`, **206 files, `--isolate`, both ways at one HEAD**
(`upstream/main` `ef6e34479b`):

| | pass | fail |
| --- | --- | --- |
| base | 108 | 98 |
| fix | **109** | **97** |

Set difference over the non-pass rows: exactly one file flips,
`built-ins/Iterator/concat/many-arguments.js` (fail → pass), and **no file
regresses**.

Probe through `compileAndRunUpstreamModule` (untyped `.js` two-file project),
harness sanity-checked with a control that fails in both lanes:

| probe | native | wasm before | wasm after |
| --- | --- | --- | --- |
| `[].concat(...[[], [1], [2,3], [4,5,6]])` | `1|2|3|4|5|6` len 6 | **`|1|2,3|4,5,6` len 4** | `1|2|3|4|5|6` len 6 |
| `[].concat(...[a.split(':'), b.split(':')])` | `a|b|c|d` len 4 | **`a,b|c,d` len 2** | `a|b|c|d` len 4 |
| `[].concat([1], [2,3])` (no-spread control) | `1|2|3` len 3 | `1|2|3` len 3 | `1|2|3` len 3 |
| `[].concat([1,2])` (single arg control) | `1|2` len 2 | `1|2` len 2 | `1|2` len 2 |

Dogfood A/B at one HEAD (`upstream/main` `ef6e34479b`), 17 suites, compared
per test file: **total delta 0, no regressions** — expected, since none of the
suites uses `[].concat(...spread)`; it is run as the no-regression control for
a change on the host-bridge argument path.

### Regression test

`tests/issue-6411-host-bridge-concat-spread.test.ts` — untyped `.js` two-file
fixtures pinning BOTH the resulting length and a join with a NON-comma
separator. Counts both ways at this HEAD: **base 1 passed / 4 failed** (the
pass is the no-spread control), **fix 5 passed / 0 failed**.

### Deliberately NOT done

- The native-first (`semanticProviders === "native-first"`) concat lane
  (`compileArrayConcatNativeSpec` / `compileArrayConcatNativeDynamic`) is not
  touched. The host lane is where the measured regression lives; the
  native-first twin needs its own measurement before anyone changes it.
