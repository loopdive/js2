---
id: 5361
title: "Array.prototype.splice inserts a SPREAD argument as one element instead of expanding it"
status: done
sprint: current
created: 2026-09-06
updated: 2026-09-06
completed: 2026-09-06
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# 2026-09-06 (#5361) — `array-methods.ts` grows +73: `splice` and `toSpliced`
# gain a runtime-count insert path next to the static one they keep for
# spread-free calls. It was already over the 1,500-LOC threshold, so the
# growth needs an explicit grant. Everything else moves OUT of the god-files:
# three NEW modules (spread-arg-list.ts, array-push-spread.ts,
# host-method-args.ts), `builtins.ts` SHRINKS 96 lines (Math.min/max's bespoke
# spread loop is replaced by the shared builder) and
# `call-receiver-method.ts` shrinks 10 (its host argument-array loop moved to
# host-method-args.ts, which also keeps `compileReceiverMethodCall` under the
# #3400 per-function ceiling). The call-receiver-method grant is kept as a
# margin in case the merge-preview base shifts. Net across src: +536.
loc-budget-allow:
  - src/codegen/array-methods.ts
  - src/codegen/expressions/call-receiver-method.ts
---

## Problem

`a.splice(start, deleteCount, ...items)` inserts the SPREAD SOURCE as a single
element. `compileArraySplice` (`src/codegen/array-methods.ts`) counts inserted
items syntactically —

```ts
const insertCount = Math.max(0, callExpr.arguments.length - 2);
```

— so a `SpreadElement` counts as one, and the array itself is stored in the
slot. `Array.prototype.push` already has a dedicated runtime-length spread path
(`compileArrayPushDynamicSpread`, gated by `tryCompileArrayPushDynamicSpread`);
`splice` has no equivalent, and neither does the host bridge
`compileArrayMethodExtern` (it `__js_array_push`es one element per argument
node).

The nested array is only visible once something reads the element:

```js
const sections = 'a:b:c'.split(':');
sections.splice(-1, 1, ...'x:y'.split(':'));
sections.length;          // 3   (should be 4)
sections.join(':');       // "a:b:x,y"   (should be "a:b:x:y")
sections[2].padStart(4);  // TypeError: padStart is not a function
```

## Evidence

Found while fixing #5338. It is the whole of the residual hono
`src/utils/ipaddr.test.ts` failure set (3 of 16 after #5338 landed, all
`padStart is not a function`): `expandIPv6('::ffff:127.0.0.1')` takes the
IPv4-mapped branch

```js
sections.splice(-1, 1, ...convertIPv6BinaryToString(...).substring(2).split(':'))
```

and every later `sections[i].padStart(4, '0')` then runs on an array.

Measured on `upstream/main` `efa9e76f07` through the hono dogfood lane, and
identically with #5338's codegen reverted — so this is independent of that fix,
not a consequence of it:

| probe | native | wasm |
| --- | --- | --- |
| `splice(-1, 1, ...'x:y'.split(':'))` then `.length` | 4 | **3** |
| `'1:2:127.0.0.1'` + splice-spread, then `.join(':')` | `1:2:7f00:0001` | **`1:2:7f00,0001`** |
| `splice(1, 1, 'x', 'y')` (no spread, control) | ok | ok |

Two adjacent defects surfaced by the same probes, likely the same root
(spread expansion in an argument list that is built element-per-node):

- `Math.max(...[1, 5, 3])` → `NaN` (spread of an ARRAY LITERAL; a spread of a
  host array from `.split()` works);
- `a.push(...['x','y'])` → appends two empty slots;
- `hostArray.concat(otherHostArray)` → `RuntimeError: illegal cast`.

## Acceptance criteria

1. `splice` with one or more spread arguments inserts every element of the
   spread source, in order, with the correct resulting length — for a host
   (externref) receiver and a native vec receiver.
2. Spread of an ARRAY LITERAL works in the same positions (the `Math.max`
   probe above returns 5).
3. hono `src/utils/ipaddr.test.ts` reaches 16/16.
4. Regression test under `tests/` with untyped `.js` two-file fixtures pinning
   the resulting length AND the joined value (a `join` with the default `,`
   separator hides the defect — the nested array stringifies to the same text;
   use a non-comma separator or assert `length`).
5. A/B at one HEAD over the 17 dogfood suites; nothing regresses.

## Implementation Plan

1. Read `compileArrayPushDynamicSpread` in `src/codegen/array-methods.ts` — it
   is the established runtime-length pattern (materialize the source, read its
   length, grow the backing array, copy).
2. `compileArraySplice`'s insert path already rebuilds the backing array when
   `insertCount > 0`, which is the hard part; what it lacks is a RUNTIME insert
   count. Compute the count into a local (static args contribute 1 each, a
   spread contributes its measured length) and drive the existing rebuild from
   that local instead of the constant.
3. Decide the host-receiver lane deliberately: `compileArrayMethodExtern` would
   also need spread expansion if `splice` routes there. Prefer one shared
   argument-list builder over a second bespoke one — `emitSetExtrasArgv`'s
   spread arm in `src/codegen/statements/nested-declarations.ts` is the
   existing "expand spreads into a runtime-length externref vec" code.
4. `array-methods.ts` is a god-file at its LOC ceiling; put the new builder in
   its own module.

## Resolution

Fixed. hono `src/utils/ipaddr.test.ts` **13/16 → 16/16**; hono overall
**229/324 → 232/324**; every other dogfood suite byte-for-byte unchanged
(A/B at one HEAD, `upstream/main` `cbd2f11dff`, 17 suites, compared per test
file: total delta **+3, no regressions**).

### Root cause

Not one bug — **one idiom, repeated in five lowerings**. A call-site argument
list is a syntactic list of AST nodes, but its VALUE list is a runtime one:
`f(a, ...src, b)` contributes `2 + src.length` values. Every lowering that
sized its destination from `callExpr.arguments.length` and emitted one slot per
node therefore stored the spread SOURCE in a single slot. The nesting is
invisible until something reads the element back — which is exactly how it
surfaced in hono, as `sections[i].padStart is not a function`.

The two lanes `splice` can take were BOTH wrong, for different reasons, and a
fix to either alone leaves half the cases broken:

| receiver | lowering | what it did with `...src` |
| --- | --- | --- |
| native vec (`["a","b","c"]`) | `compileArraySplice` | `insertCount = arguments.length - 2` ⇒ the source vec stored in one element |
| host externref (`text.split(":")` across a module edge) | the generic `__extern_method_call(recv, "splice", args)` bridge in `compileReceiverMethodCall` | one `__js_array_push` per AST node ⇒ the source array handed to the host as one item |

Measured, not assumed: a debug print in `compileArraySplice` showed the
host-receiver case never reaching it at all, and the emitted WAT showed
`__js_array_new` / `__js_array_push` / `__extern_method_call` instead. The
issue text's "`compileArrayMethodExtern` … pushes one element per argument
node" pointed at the right shape but the wrong function — `splice` is not in
`compileArrayMethodExtern`'s method set.

### Mechanism

A shared builder, `src/codegen/spread-arg-list.ts`, replaces the per-site
counting. `buildSpreadArgList` evaluates an argument list ONCE, left to right,
into per-argument slots and sums the element count into an i32 local; the
caller then drives `emitStores` with a SINK (a `pre`/`post` instruction pair
wrapped around each value), so one builder serves destinations with completely
different storage:

- a WasmGC backing array (`array.set` at a running write index) — `splice`,
  `toSpliced`, `push`;
- a host JS array (`__js_array_push`) — the `__extern_method_call` bridge;
- no storage at all, a fold accumulator — `Math.min` / `Math.max`.

Two phases, because `splice` needs the COUNT before it can allocate the new
backing and the VALUES only after. `emitStores` runs no `compileExpression`, so
it is safe to call after an intervening allocation, an `ArraySpeciesCreate`, or
a late-import flush.

Three spread-source representations, each needing its own read — this is what
made the array-literal cases fail where the `.split()` ones "worked":

- a TUPLE struct (`_0`, `_1`, …), which is how an inline `[x, y]` lowers in a
  value context. `getVecInfo` answers null for it, so every vec-shaped reader
  silently treated it as one opaque object;
- a native vec struct — read `length` and index the backing;
- anything else (a host array, a Set, a generator) — materialize through the
  iterator protocol (`__array_from_iter_strict`, or `__array_from_iter_n` in
  standalone) and index it.

Call sites, and why each was safe to change:

1. `compileArraySplice` / `compileArrayToSpliced` — the runtime count drives
   the EXISTING rebuild; the static unrolled path is kept verbatim and still
   taken whenever no spread is present, so a spread-free `splice` emits
   identical code.
2. `compileReceiverMethodCall`'s generic `__extern_method_call` argument array
   — the builder is used only when a spread is present (extracted to
   `src/codegen/host-method-args.ts` so `compileReceiverMethodCall` shrinks
   rather than grows past its #3400 per-function ceiling).
3. `compileArrayPush` — only the shapes the two existing single-spread arms
   decline: mixed lists (`a.push(x, ...src)`) and tuple sources. The measured
   hono `routes.push(...ownRoute)` arm is untouched.
4. `compileMathMinMaxSpread` — replaced its checker-driven pre-resolution
   (`resolveArrayInfo` on `getTypeAtLocation`) with the builder. That
   pre-resolution answered null for an inline `[1, 5, 3]` in an untyped
   module, which dropped `Math.max(...[1,5,3])` into the legacy path where the
   literal constant-folds to `Number([]) === 0`.

Evaluation order moves CLOSER to spec, not away from it: the inserted items are
now evaluated right after `start`/`deleteCount` and before the receiver is
touched, where they used to be compiled midway through the rebuild.

### Probe table (measured, `upstream/main` `cbd2f11dff`)

One standalone probe through `compileAndRunUpstreamModule` (the dogfood lane),
an untyped `.js` two-file project, harness sanity-checked with a deliberately
failing control that fails in BOTH lanes:

| probe | native | wasm before | wasm after |
| --- | --- | --- | --- |
| `splice(-1,1,...tail.split(':'))` host receiver, `.length` | 4 | **3** | 4 |
| … same, `.join(':')` | `a:b:x:y` | **`a:b:x,y`** | `a:b:x:y` |
| … native vec receiver | `a:b:x:y` len 4 | **`a:b:x,y` len 3** | `a:b:x:y` len 4 |
| `splice(-1,1,...['x','y'])` (array literal) | `a:b:x:y` len 4 | **`a:b:[object Object]` len 3** | `a:b:x:y` len 4 |
| `splice(1,1,'x','y')` (no-spread control) | ok | ok | ok |
| `splice(1,1,'p',...tail,'q')` (mixed) | `a:p:m:n:q:c` len 6 | **`a:p:m,n:q:c` len 5** | `a:p:m:n:q:c` len 6 |
| `push(...['x','y'])` | `a:x:y` | **`a::`** (two null slots) | `a:x:y` |
| `Math.max(...[1,5,3])` | 5 | **0** | 5 |
| ipaddr shape + `padStart` | `0001:0002:7f00:0001` | **`0001:0002:7f00,0001`** | `0001:0002:7f00:0001` |
| `hostArray.concat(otherHostArray)` | `a:b:c:d` | `a:b:c:d` (already OK) | `a:b:c:d` |

Two corrections to the issue's own evidence, both measured:

- `Math.max(...[1,5,3])` returns **0**, not `NaN` — the array literal
  constant-folds through `Number([])`, it does not coerce to NaN.
- `hostArray.concat(otherHostArray)` did **not** reproduce `illegal cast` in
  this shape (`"a:b".split(":").concat("c:d".split(":"))` passes on the parent
  and on the fix). Whatever shape produced that error is a different defect;
  it is NOT covered here and needs its own repro.

### Regression test

`tests/issue-5361-splice-spread-argument.test.ts` — untyped `.js` two-file
fixtures, pinning BOTH the resulting `length` and a join with a NON-comma
separator (a default `,` join hides the defect: the nested array stringifies to
the same text). Host receiver, native vec receiver, array-literal spread,
mixed list, `toSpliced`, `push`, `Math.max`, and the hono `padStart` shape.
Exact counts: **on the parent 1 passed / 7 failed** (the one pass is the
no-spread control), **with the fix 8 passed / 0 failed**.

Also checked by hand, outside the dogfood lane: annotated `string[]`/`number[]`
receivers in both string backends (`nativeStrings` false and true) — including
`a.push(...a)` self-spread and an empty spread — and `compile()` validity on
`standalone` / `wasi` / `gc`, which the dogfood lane never exercises.

### Deliberately NOT done

- **`emitSetExtrasArgv` (`statements/nested-declarations.ts`) is not folded
  into the shared builder.** The implementation plan named it as the model,
  and it is — its sink (a runtime-length `array.new_default` + `array.set` at a
  write index) is the same shape. But it is already CORRECT for spreads
  (#2202), and it is the `arguments`-object path for class bodies, tagged
  templates, `new`/`super` and namespace-static calls. Folding it in would be a
  pure refactor of a correct, heavily-used path with no behavioural gain, so it
  is left as a follow-up; the new module's header names it as the sibling.
- **`hostArray.concat(otherHostArray)` → `illegal cast`** — could not be
  reproduced (above).
- Noted in passing, and **not caused by this change**: under `nativeStrings`,
  `arr.join(":") + "|" + arr.length` in return position fails to validate
  (`return_call[1] expected type (ref null 6), found f64.convert_i32_u`) — a
  string + number concat in tail position. Established by construction, not by
  assumption: it reproduces in a module containing NO spread and NO splice, so
  none of the code paths added here can run in it. Worth its own issue.
