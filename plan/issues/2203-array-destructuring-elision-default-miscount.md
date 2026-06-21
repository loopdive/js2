---
id: 2203
title: "Array destructuring with elisions + defaults binds wrong elements (host) / emits invalid funcidx (standalone) (~54 standalone CE + host fails)"
status: done
completed: 2026-06-21
sprint: 64
created: 2026-06-19
updated: 2026-06-21
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, destructuring
language_feature: destructuring
goal: spec-completeness
related: [2039, 2566, 680]
test262_bucket: dstr-elision-default
test262_count: 54
es_edition: es2015
origin: "2026-06-19 sprint-64 standalone failure mining: language/.../dstr/*ary-ptrn*elision* fail. Host: wrong bindings (off-by-one over holes). Standalone: same mis-codegen additionally trips `Binary emit error: function index out of range`. Distinct from #2039 (standalone-only invalid-Wasm umbrella) — this is host-agnostic, the elision sub-case of destructuring."
---

## Resolution (2026-06-21)

**Mis-scoped as an elision miscount — the actual bug was in the GENERATOR
lowering.** Reproduction showed plain array-literal elision+default already
lowers correctly (`[, , x] = [10,20,30]` → 30, `[, z = 99] = [1]` → 99,
elision+rest). The `~54` standalone failures were all generator-RHS cases (the
test262 generator scaffolding `function* g(){first+=1;yield;second+=1}`).

Two distinct root causes:

1. **Standalone `function index out of range` crash (the ~54 CE) — FIXED here.**
   A nested generator that **captures** an outer-scope binding cannot use the
   Wasm-native generator factory (its state struct has no capture slot; native
   registration is gated on `captures.length === 0`), so it falls to the
   eager-buffer host path. But `sourceNeedsGeneratorHostImports` mis-classified
   it as native (`isNativeGeneratorCandidate` does not model captures), so the
   `__gen_*` host imports were never registered in a no-JS-host target →
   `ctx.funcMap.get("__gen_create_buffer")!` baked `funcIdx: undefined` →
   invalid Wasm. **Fix** (`src/codegen/generators-native.ts`): a precise
   checker-based capture detector (`generatorCapturesOuterScope`) now flags
   capturing nested generators, so `sourceNeedsGeneratorHostImports` registers
   the host imports → valid funcidx → the binary instantiates. Result on the
   standalone elision cluster: the invalid-Wasm crash is eliminated, pass
   74 → 86 (+12), **zero regressions** (broad 600-file generator+dstr sweep:
   0 pass→non-pass); hard-error gate OK.

2. **Host/standalone VALUE bug (`second === 1`, should be `0`) — split to #2566.**
   The eager-buffer model runs the generator body to completion at call time, so
   a trailing elision over-consumes. Fixing this needs lazy *capturing*
   generators (a #680-class feature), tracked in **#2566**. The ~29 ex-crash
   cases now compile to valid Wasm and `fail` only on the runtime side-effect
   assertion.

Tests: `tests/issue-2203.test.ts` (host value cases + standalone-validates
capturing-generator elision cases). The original repro (A) `second === 0` is
NOT met here — it is #2566's acceptance.

# #2203 — Array destructuring with elisions + defaults

## Problem

Array binding/assignment patterns that contain **elisions** (holes, e.g.
`[, , x]` or a nested `[,]`) combined with a default initializer mis-bind. The
elision must advance the iterator/index by one *without* binding, then the
following element (or default) binds to the next value. The compiler's
destructuring lowering miscounts across the hole, producing:

- **JS-host mode:** wrong runtime values — an off-by-one where the element after
  the hole binds the hole's value (or a default fires when it should not). E.g.
  `var [[,] = g()] = [];` must invoke the default `g()` exactly once
  (`first === 1`) and never resume it (`second === 0`); the compiler resumes /
  miscounts.
- **Standalone mode (`--target standalone`):** the *same* mis-lowering
  additionally emits a `Binary emit error: Codegen error: function index out of
  range` at instantiate — a funcidx-shift hazard (cf. CLAUDE.md `addUnionImports`
  / type-index shift notes) triggered by the elision codepath emitting a stale
  function index.

This is **host-agnostic** (the binding bug exists in JS-host too) and is the
**elision sub-case** of destructuring — it is NOT #2039 (which is the
standalone-only invalid-Wasm umbrella, blocked) and NOT the broad generic
`dstr` value-rep bucket.

## Spec

- §8.5.2 / §13.3.3 IteratorBindingInitialization — `Elision` advances the
  iterator without binding:
  https://tc39.es/ecma262/#sec-runtime-semantics-iteratorbindinginitialization
- §13.15.5 DestructuringAssignmentEvaluation (the assignment-target form).

The elision rule (paraphrased): for each `,` in an `Elision`, call IteratorStep
once and discard the value (do **not** bind, do **not** apply a default), then
continue with the next `BindingElement`.

## Minimal repro

```js
// (A) nested elision + default — host binds wrong / standalone CEs.
var first = 0, second = 0;
function* g() { first += 1; yield; second += 1; }
var [[,] = g()] = [];      // outer elem is `[,] = g()`; rhs [] is empty
// the outer iterator is empty ⇒ default g() runs once, is NOT resumed:
// assert first === 1 && second === 0

// (B) leading elisions skip values, then bind.
var [, , x] = [10, 20, 30];
// assert x === 30   (two holes skip 10 and 20)

// (C) elision + rest.
var [, ...rest] = [1, 2, 3];
// assert rest is [2, 3]
```

## Failing test262 cluster

`test/language/**/dstr/*ary-ptrn*elision*` and `*dflt-ary-ptrn-*elision*` —
**~54** standalone compile-errors (`function index out of range`), with the
matching JS-host runs failing on wrong values. Representative files:

- `language/statements/variable/dstr/ary-ptrn-elem-ary-elision-init.js`
- `language/statements/function/dstr/dflt-ary-ptrn-elision.js`
- `language/statements/function/dstr/ary-ptrn-elem-ary-elision-init.js`
- `language/statements/for/dstr/var-ary-ptrn-elem-ary-elision-init.js`
- `language/expressions/arrow-function/dstr/dflt-ary-ptrn-rest-ary-elision.js`
- `language/expressions/function/dstr/dflt-ary-ptrn-elision.js`
- `language/expressions/object/dstr/meth-dflt-ary-ptrn-elision.js`

## Approach (sketch — dev to confirm against codegen)

In the array-destructuring lowering (binding + assignment forms), audit how an
`Elision` advances the iterator/index relative to where the *next* element and
its default bind. The bug is an index/iterator-step miscount over holes. Fixing
the count should make both the host value-bug and the standalone funcidx emit
crash disappear (the crash is downstream of the same wrong index). Confirm the
standalone `function index out of range` is gone (no stale funcidx emitted on
the elision path) after the count fix.

Keep scope to the **elision** case — do not refactor the broader destructuring
lowering or step into the value-rep `dstr` bucket.

## Acceptance criteria

- [ ] Repro (A): `first === 1`, `second === 0` (default runs once, not resumed),
      in JS-host.
- [ ] Repro (B): `x === 30`; Repro (C): `rest` deep-equals `[2, 3]`.
- [ ] Standalone: the `~54` `*ary-ptrn*elision*` tests no longer emit
      `function index out of range`; `>= 40` flip to pass on the standalone shard.
- [ ] No regression in non-elision destructuring (`dstr` tests without holes) in
      host or standalone.
- [ ] A focused `tests/issue-2203-*.test.ts` covering binding-form and
      assignment-form elision with leading holes, nested holes, holes+default,
      and holes+rest.
