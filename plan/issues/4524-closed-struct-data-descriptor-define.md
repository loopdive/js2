---
id: 4524
title: "standalone: Object.defineProperty with a DATA descriptor is silently dropped on a closed-struct object literal"
status: done
created: 2026-08-16
updated: 2026-08-18
completed: 2026-08-16
pr: 4635
priority: high
feasibility: medium
task_type: fix
area: codegen
language_feature: objects, property descriptors, object shape
goal: es5-standalone
sprint: 78
horizon: m
assignee: ttraenkler/opus-es5-b
related: [1888, 1901, 3076, 4208, 4479, 3475, 2668, 739]
loc-budget-allow:
  # Both new predicates belong beside the markers they extend
  # (markStandaloneAccessorDefineTargets, isObjectMopCallArg): the whole point
  # is that the data-define marker and the accessor marker stay a matched pair,
  # and that the consumer-safety guard's two "not a struct consumer" tests sit
  # together. Splitting them out would separate code whose correctness is
  # defined by agreeing with its neighbour. The growth is comment-dominated.
  - src/codegen/declarations/object-shape-widening.ts
func-budget-allow:
  # +4 lines: two call sites (one marker, one guard clause) that must live
  # inside this loop — the marker runs per-statement alongside its accessor and
  # delete siblings, and the guard clause is one disjunct of an existing
  # condition. Neither can be extracted without moving the loop itself.
  - src/codegen/declarations/object-shape-widening.ts::collectGrowableObjectLiterals
---

# #4524 — `Object.defineProperty(o, k, {value})` is silently dropped on a closed-struct object literal

## The defect

Under `--target standalone`, an object literal with a statically-inferred shape
compiles to a **closed WasmGC struct**. `Object.defineProperty` with a **data**
descriptor on such an object **silently drops the property** — no error, no
warning, and the property is simply not there afterwards.

Measured on current main (`a9b20d4ca`), five cases, standalone lane, each a
separate compile-and-run:

| case | new property visible afterwards? |
| --- | --- |
| `Object.defineProperty(o,"b",{value:42})`, `o` unannotated → closed struct | **NO** |
| same, `o: any` → open `$Object` (control) | yes |
| `Object.defineProperty(o,"b",{get(){…}})`, closed struct | yes |
| `Object.defineProperty(o,"a",{get(){…}})` (existing key), closed struct | yes |
| plain `(o as any).b = 42`, closed struct | yes |

So the shape-escape analysis already covers plain dynamic writes **and**
accessor defines. It misses exactly one case: the data-descriptor define.

## Why it is worth fixing

Real test262 code is plain JavaScript with no type annotations, so
`var obj = { length: 2 }` **always** takes the closed-struct path. The
annotated form that works is one only a TypeScript author would write.

Downstream, this is what makes `Array.prototype.filter.call(obj, cb)` return an
empty array across the ES5 `built-ins/Array/prototype/filter/15.4.4.20-9-b-*`
family: the indices those tests install with `Object.defineProperty(obj, "0",
…)` never land on the closed struct, so the per-index `HasProperty` check
correctly finds nothing and every index is skipped.

**Population is a CEILING, not a claim.** The 2026-08-16 ES5 standalone census
puts 86 files in the `defineProperty-family` cluster and 11 in
`array-prototype`'s filter group, with 8 more in the `every`/`forEach`
"expected a TypeError, none thrown" group. The mechanism above is confirmed on
**one** shape. Attribution is per-file **after** the fix; do not forecast from
the cluster size.

## There are TWO defects, and the second hid the first

Defect 1 is the dropped data define above. **Defect 2 was found only because the
regression matrix pinned more than defect 1's fix needed**: with defect 1 fixed,

```js
var o = { a: 1 };
Object.defineProperty(o, "b", { value: 42, enumerable: true, configurable: true });
var unused = Object.prototype.hasOwnProperty.call(o, "a");   // ← this line
o.b   //  42 without it,  undefined WITH it
```

A call that only **reads** `o` changed `o`'s representation. The consumer-safety
guard asks "does this identifier flow into a concrete-struct-typed position?",
and `isObjectMopCallArg` recognises only the direct `Object.<mop>(o, …)` form —
the borrowed idiom's callee is `Object.prototype.hasOwnProperty.call`, a
property access whose base is another property access rather than the `Object`
identifier, so it read as an ordinary struct consumer and **un-poisoned** the
receiver, restoring the exact defect the poison exists to prevent.

This matters well beyond this issue: `Object.prototype.hasOwnProperty.call(…)`
is one of the most common idioms in test262 (`propertyHelper.js` uses it
pervasively), so the un-poisoning was silently suppressing open-object escapes
across the corpus — and it is why measuring defect 1's fix *alone* through a
harness-linked compile showed **zero** movement. That arm was measuring the fix
disabled, and is discarded, exactly like the load-timeout arm below.

Fixed by `isBorrowedMethodThisArg`: the `thisArg` of any
`X.prototype.m.call/apply(o, …)` is never a concrete-struct consumer, because
`Function.prototype.call` declares `thisArg: any`. Keyed on that **type fact**
rather than a builtin allow-list, so it holds for every borrowed method. A plain
`f.call(o)` on a **user** function is deliberately NOT matched — that first
parameter genuinely can be struct-typed, and admitting it would widen the escape
past what the type justifies.

## Root cause

`compileObjectLiteral` (`src/codegen/literals.ts`) decides closed struct vs open
`$Object`:

- **Empty literal** (`properties.length === 0`): diverts to `__new_plain_object`
  when the contextual type is any/unknown/`object`, when it is a pure
  string-index signature, **or when `isDefinePropertyReceiverLiteral` says the
  literal is a defineProperty receiver** (#3076).
- **Non-empty literal**: `objectLiteralTakesStandaloneAnyObjectPath` requires an
  **EXPLICIT** any/unknown/`object` contextual type. An **absent** contextual
  type deliberately keeps the closed struct — widening that is what caused the
  116-regression, −45-standalone-gate episode recorded in #1897, so it must NOT
  be widened again.

`isDefinePropertyReceiverLiteral` (`src/codegen/struct-accessor-closure.ts`)
matches only a literal written **inline as the first argument**:
`Object.defineProperty({}, …)`. It does not match the dominant shape

```js
var obj = { length: 2 };            // ← literal here
Object.defineProperty(obj, "0", …); // ← receiver is an identifier
```

so a non-empty literal bound to a variable and later used as a define receiver
gets no escape at all.

## Fix — pin the receiver literal, do not widen the contextual-type rule

Narrowest site. A pre-pass collects the object-literal **initializer nodes** of
bindings that are later passed as the receiver of `Object.defineProperty` /
`Object.defineProperties` / `Reflect.defineProperty`, and pins exactly those
nodes to the open-`$Object` path.

Precedent to copy, deliberately: `ctx.ordinaryToPrimitiveObjectLiterals` (#4208)
— "the pre-pass pins only the exact initializer nodes, so unrelated locals
retain their existing representation." Same discipline here: a per-node pin,
never a module-global flag and never a relaxation of the contextual-type test.
An object that is a define receiver is already being mutated dynamically, so a
closed struct is the wrong representation for it specifically; every other
literal keeps the #1472-R2 struct fast path byte-identical.

## Scope boundary — state it, honour it

This issue is **"the define lands"**, not "descriptor semantics are right".

- Descriptor **attribute fidelity** (writable / enumerable / configurable
  behaviour, redefinition rules) — **#4479** (live lane), #2668, #739. Out.
- **Write-persistence on dynamic shapes** — **#3475**. Out.
- Open-any **method dispatch** — #1888. Out.

## Measured result (2026-08-16, real runner, standalone lane)

Scoped set: **38 files** — the 13 ES5 `built-ins/Array/prototype/filter` cluster
files plus a 25-file `built-ins/Object` sample from the census's
defineProperty-family cluster.

| | count |
| --- | ---: |
| flips to `pass` | **6** |
| regressions | **0** |
| unmeasurable (load-induced compile timeout) | 13 |
| measured denominator | **25 of 38** |

All 6 flips are in the ES5 filter cluster and all 6 classify **edition 5** under
`classifyEdition` — so the ES5-bucket subset of the flip set is **6/6**, and the
575 moves by 6.

The 13 unmeasurable rows are `compilation timeout` at 31–87 s on a box at load
~25; they are **not** regressions (their baseline status is `fail`, and a
timeout is an absence of measurement, not a result). They must be re-measured in
CI, where the shard machines are not contended.

Flipped files:

```
built-ins/Array/prototype/filter/15.4.4.20-9-9.js
built-ins/Array/prototype/filter/15.4.4.20-9-b-3.js
built-ins/Array/prototype/filter/15.4.4.20-9-b-4.js
built-ins/Array/prototype/filter/15.4.4.20-9-b-6.js
built-ins/Array/prototype/filter/15.4.4.20-9-b-8.js
built-ins/Array/prototype/filter/15.4.4.20-9-b-12.js
```

**86 was and remains a ceiling.** The `built-ins/Object` sample produced zero
flips in this run, though 10 of its 25 rows timed out and are unmeasured. No
claim is made about the rest of that cluster.

## Acceptance

- [x] `Object.defineProperty(o, k, {value})` on a closed-struct literal makes
      the property visible, matching the accessor-define and dynamic-write cases.
      Verified as a real OWN property (`in`, `hasOwnProperty`, `Object.keys`),
      not merely readable.
- [x] The five-case matrix above is pinned as a regression test — including the
      three rows that ALREADY pass, since the escape transition is exactly what
      could break them. `tests/issue-4524-closed-struct-data-define.test.ts`,
      10 cases, in the required guard suite.
- [x] The ES5 filter files + the defineProperty sample re-measured with the
      **real runner** in the standalone lane: **6 flips, 0 regressions**,
      denominator **25 of 38** measured (13 rows lost to load-induced compile
      timeouts), and the edition-5 subset of the flip set is **6/6**.
- [x] No regression in the shapes that currently work — the #1897 class is
      covered by two of the pinned cases (an in-shape define, and an unrelated
      literal in the same module, both keeping the struct path); the scoped run
      showed 0 regressions.

Closed by PR #4635 (merged 2026-08-16). **Not closed by this issue**, and
tracked elsewhere: the `built-ins/Object` defineProperty-family cluster still
needs its own root-cause pass — the 25-file sample here produced zero flips with
10 rows unmeasured, so #4524 must not be read as having addressed it. The ES5
`every`/`forEach` group (8 files) was not re-measured after this landed and may
have moved; re-measure before planning it.

## Instrument notes (read before measuring this issue)

Two traps cost real time finding this and will cost it again:

1. **An `: any` annotation on a probe receiver selects a different object
   lowering.** Three probes written as `var o: any = {…}` reported "spec
   correct" against tests that genuinely fail, because the annotation routed
   them onto the open-`$Object` path the real test never takes. A probe that
   annotates the receiver to make it compile is not testing the program under
   test.
2. **The QuickJS eval provider cannot be built in this container** (no
   clang-18/cmake, no prebuilt artifact). The runner fails loudly with an
   explicit "provider is not built" message, so eval-shaped rows are
   identifiable and must be excluded, never counted as failures.

Also, on a loaded box (19–26 on 8 cores here) vitest hits its 35 s per-test
timeout and reports timeouts that look like assertion failures. Re-verify any
apparent failure solo before believing it.
