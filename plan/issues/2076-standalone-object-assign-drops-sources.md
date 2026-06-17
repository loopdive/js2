---
id: 2076
title: "standalone: Object.assign drops later sources entirely — native __object_assign never iterates the sources vec"
status: done
assignee: ttraenkler/dv1
completed: 2026-06-16
sprint: 62
created: 2026-06-11
updated: 2026-06-16
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: objects
goal: host-independence
related: [2046, 2009]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2076 — only the target survives assign

## Problem

```ts
const t: any = Object.assign({a:1}, {b:2, a:3});
t.a + "," + t.b
// standalone: "1,0" (second source never applied; missing prop reads 0)
// node: "3,2"
```

## Root cause

`src/codegen/object-runtime.ts:2972-3130` — a native `__object_assign`
exists but the sources `$ObjVec` isn't populated or iterated; only the
target survives.

## Fix direction

Populate the sources vec at the call site and iterate it in
`__object_assign` (own enumerable props, later sources override, spec
§20.1.2.1). Distinct from the host-mode field-name collision (#2009).

## Acceptance criteria

- Repro returns "3,2" standalone; multi-source order honored
- Host mode unchanged

## Dupe check

#1905 (Reflect/Object subset), #2046 (standalone Reflect gaps) — neither
claims assign merge. New.

## Investigation (2026-06-11, dev-spec-b2) — entangled with struct-field writeback (#2009 in flight)

The `Object.assign` CALL SITE is correct: `calls.ts:4845` builds the sources
`$ObjVec` via `__objvec_new`/`__objvec_push` in standalone and calls
`__object_assign`. So sources ARE populated. The bug is that
`__object_assign`'s per-prop `__extern_set` writes **never land on the target
$Object/struct** in standalone — confirmed by probe:

| call | result | want |
|---|---|---|
| `Object.assign({a:1}, {a:3}).a` | 1 | 3 (override existing field fails) |
| `Object.assign({a:1,b:9}, {b:2}).b` | 9 | 2 (override existing field fails) |
| `Object.assign({a:1}, {b:2}).b` | 1/0 | 2 (new field fails) |

Even overriding an EXISTING target field fails, so this is NOT a struct-grow
issue — it's that `__extern_set` (or `__object_assign`'s iteration of source
own-props) doesn't write back into the standalone struct field. That is the
same standalone struct-field-writeback machinery (`__sset_*` / the open-$Object
shape) that **senior-dev's #2009 instance-shape rework (#22/#25, in flight)**
touches. **Recommend holding #2076 until #2009 PR-1 lands**, then re-evaluating
whether `__object_assign`'s writeback works against the new $shape.

(The paired #2077 `.name` half also intersects #2072 boxing per the task note.)

## Resolution (2026-06-16, dv1)

The earlier "writeback never lands" diagnosis was a misread — `__extern_set`
and `__object_assign` are both correct. The real fault is upstream, at the
`Object.assign` CALL SITE (`src/codegen/expressions/calls.ts`): the target and
source object-literal ARGUMENTS were compiled with an `externref` contextual
type, which routes them through `compileObjectLiteral`'s **closed-struct** path
(their TS contextual type, inferred from `Object.assign`'s generic lib
signature, is a concrete object type — not `any` — so the open-`$Object`
diversion at `literals.ts:864` never fires). `__object_assign` then reads each
operand via `ref.test $Object` + a `$PropEntry` walk, which a closed struct
fails — so the sources are skipped entirely AND the target's own keys are
invisible to `Object.keys` (`__obj_ordered` sizes its output by `$Object.count`,
which a closed struct doesn't have).

This is why a probe like `Object.assign({a:1}, {a:3}).a` returned 1 (the read
`.a` hit a struct field) while `Object.keys` returned 0 (no `$Object` to
enumerate) — two facets of the same closed-struct routing, NOT a writeback bug.

**Fix**: a `compileObjectAssignArg` helper (calls.ts) that, in standalone mode,
builds a plain data-property / spread object-literal argument directly as a
native `$Object` via the now-exported `compileObjectLiteralAsExternref`, so
`__object_assign` recognises both target and sources. Identifiers, calls and
accessor-bearing literals keep the ordinary `compileExpression` path. Host / gc
/ wasi modes are untouched (the `__object_assign` JS import owns those).

Independent of #2009 — no struct-shape change was needed.

## Test Results (2026-06-16, standalone, host-import-free)

`tests/issue-2076.test.ts` — 8/8 pass:

| case | before | after |
|---|---|---|
| `Object.assign({a:1},{b:2,a:3})` → `a*10+b` | 10 | 32 |
| `Object.keys(Object.assign({a:1},{b:2})).length` | 0 | 2 |
| 3 sources, last wins (`{a:1},{a:2},{a:3}`) | 1 | 3 |
| target mutated in place (`src.b`) | 0 | 2 |
| non-literal source variable | (skipped) | 32 |
| spread inside source literal | (skipped) | 32 |
| empty source `{}` keeps target keys | 0 | 1 |
| no source returns target | 2 | 2 |

No regressions in `issue-2127.test.ts` / `issue-1901.test.ts` (13/13).
