---
id: 3333
title: "standalone: whole-pattern param default OBJECT LITERAL never binds — `function f({a,b}: any = {a:5,b:3}); f()` reads garbage/NaN"
horizon: s
status: ready
sprint: current
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: destructuring-params, default-values
goal: standalone-mode
related: [3245, 3244, 2568, 852]
origin: "2026-07-17 fable-s2 — reduced from #3245's obj-rest residual (dflt-obj-ptrn-rest-val-obj.js) after the #3244 re-measure"
---

# #3333 — standalone pattern-param default literal never binds

## Reduced repro (verified 2026-07-17 on current main, `--target standalone`)

```ts
export function test(): number {
  let got = -1;
  const f = function ({ a, b }: any = { a: 5, b: 3 }) {
    got = a === 5 && b === 3 ? 1 : 0;
  };
  f();
  return got; // → 0 (bindings read garbage/NaN); expected 1
}
```

Precise differential (each single-variable):

| variant                                              | result      |
| ---------------------------------------------------- | ----------- |
| standalone + pattern param + default LITERAL         | **0 (bug)** |
| same, host (default) lane                            | 1           |
| standalone, default is a module-level `const D: any` | 1           |
| standalone, identifier param `o: any = {a:5,b:3}`    | 1           |
| standalone, arg passed explicitly (default unused)   | 1           |
| function DECLARATION form                            | **0 (bug)** |
| with `...rest` in the pattern                        | **0 (bug)** |

`rest.x` reads back NaN; even `a === 5` is false — the whole pattern binds
from the wrong value when the default fires. The default CHECK fires
correctly (the module-var default works), so the mismatch is between the
shape the default LITERAL materializes in (`structHintForBindingPattern`,
#2568 — WAT shows `f64.const 5; f64.const 3; struct.new <anon>`) and the
shape `destructureParamObject`'s read path expects on the standalone lane
(its `ref.test` fast path / dynamic fallback misses that struct, reads 0/NaN).
Suspect: the two "mirrored" struct-type derivations diverge for `any`-typed
patterns on standalone, or the destructure's else-branch (`__extern_get`
dynamic read) cannot read the anonymous f64-field struct (the classic
value-rep substrate gap, cf. project_standalone_any_string_value_read
memory).

## test262 anchor

`language/expressions/async-generator/dstr/dflt-obj-ptrn-rest-val-obj.js`
(fails `assert #1: rest.a === undefined`) — and every `dflt-*` dstr template
sibling that routes a whole-pattern default literal on the standalone lane.
The non-dflt twin (`obj-ptrn-rest-val-obj.js`) passes.

## Acceptance

- The reduced repro returns 1 on `--target standalone` (expression AND
  declaration forms, with and without `...rest`).
- `dflt-obj-ptrn-rest-val-obj.js` passes cold standalone.
- Host lane byte-neutral or verified no-regression on the dstr family.
