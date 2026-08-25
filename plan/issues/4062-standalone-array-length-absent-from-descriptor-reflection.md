---
id: 4062
title: "D3 — named-key presence on an ARRAY receiver disagrees with the read path in standalone (`a.foo === 7` but `a.hasOwnProperty(\"foo\") === false`)"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-08-02
updated: 2026-08-18
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: standalone, codegen
language_feature: arrays, property-descriptors
goal: standalone-mode
related: [4434, 3537, 3251, 4010, 3984, 4227, 4176]
# (#3102 LOC ratchet / #3400 R-FUNC) The substance of this change-set is the NEW
# subsystem module `src/codegen/vec-named-key-presence.ts` — the routing
# predicate and the whole safety argument for it. What lands in the two god-file
# fold sites is the DECISION, and it cannot move out of them: the predicate's
# eligibility input is the fold's own answer (`result` in
# `compilePropertyIntrospection`, `has` in `compileInOperator`), which exists
# only at those two points and is the reason the change can widen a `false`
# without touching a single affirmative answer. `object-ops.ts` was sitting
# EXACTLY at its LOC budget (4847), so any addition at all faults the gate.
loc-budget-allow:
  - src/codegen/object-ops.ts
func-budget-allow:
  - src/codegen/object-ops.ts::compilePropertyIntrospection
  - src/codegen/binary-ops-in.ts::compileInOperator
---

# D3 — named-key presence on an array receiver, standalone

> The original filing (verbatim below, under "Original report") was about
> `length` and descriptor reflection. **That cell was fixed by #3984/#4227 and
> #4434** — verified on this tree before any edit: `arr.hasOwnProperty("length")`
> is `true`, `Object.getOwnPropertyDescriptor(arr,"length")` is a descriptor, and
> `Object.getOwnPropertyNames(arr)` lists it. #4434's residual #2 routed the
> REMAINING cell of the same reflection surface here, and that is what this issue
> now closes: an ordinary **named expando** (`a.foo = 7`) is invisible to
> `hasOwnProperty` / `propertyIsEnumerable` / `in` while the read path answers
> correctly.

## Root cause — a compile-time FOLD, not a runtime gap

The runtime chokepoints were already right. `__hasOwnProperty` / `__object_hasOwn`
carry the vec arm that consults the #3251 overlay and then falls through to the
#3537 expando bag (`vec-bag-seed.ts:fillVecHasOwnHelpers` + `carrier-bag-visibility.ts`),
and `__extern_has` reaches the same bag. Measured on this tree, `--target standalone`,
with a receiver the compiler CANNOT see as an array (`const a: any = []`): every
cell already answered `true`.

The two wrong cells never reached a helper. When the receiver's resolved Wasm
type is a `__vec_<k>` struct **and** the key resolves at compile time, both sites
answer from the static shape:

| site | folds from |
| --- | --- |
| `compilePropertyIntrospection` (`object-ops.ts`) | `structFieldNames ∪ receiverType.getProperties()` |
| `compileInOperator` (`binary-ops-in.ts`) | `structFieldNames ∪ tsTypeHasProperty` |

A vec's field list is `["length", "data"]` and `any[]`'s checker properties are
its prototype methods, so an expando the program wrote one line earlier is in
neither — the fold emits `i32.const 0`. The `--target standalone` harness shape
(`var a = []`) always produces that statically-typed receiver, which is why the
defect looked lane-specific and why an `any`-typed probe could not reproduce it.

This is #4010 S3 one lane further out: there the vec arm `return`ed the overlay
answer unconditionally and never reached the bag; here the query never reaches
the arm.

## The fix

`src/codegen/vec-named-key-presence.ts` (NEW) owns the predicate
`vecNamedKeyNeedsRuntime(ctx, recvWasm, staticKey, foldedAnswer)` — true only
when the receiver is a `__vec_<k>` struct, the module is `--target standalone`,
the key is NOT a canonical array index, **and the fold's own answer would be
`0`**. The two fold sites then route to the runtime predicate they were bypassing
(`__hasOwnProperty` / `__propertyIsEnumerable`, and `__extern_has`).

**Only a folded FALSE is widened. That is the entire safety argument**, and it is
the property #4055 v1 lacked when it widened `hasOwnProperty` over a bag a refused
write had polluted and the merge queue measured **−684**. Affirmative folds
(`"length"`, a checker-named inherited method, `propertyIsEnumerable`'s
non-enumerable `0`) are emitted byte-for-byte as before.

| file | what |
| --- | --- |
| `src/codegen/vec-named-key-presence.ts` (NEW) | the routing predicate, the canonical-index screen, the measured before/after matrix and the widen-only-a-false argument |
| `src/codegen/object-ops.ts` | `compilePropertyIntrospection`: route a folded `0` on a vec receiver to `emitRuntimePropertyIntrospection` |
| `src/codegen/binary-ops-in.ts` | `compileInOperator`: admit a vec receiver to the existing `__extern_has` arm (§13.10.1 key-then-object order unchanged) |

## Measurement

Every figure below was produced on this tree by the agent that wrote it, paired
by file-copy revert (`.tmp/base-object-ops.ts`, `.tmp/base-binary-ops-in.ts`),
same process, same instrument (the real test262 harness via `runTest262File`,
`lane=standalone`). Corpus baseline used only to SELECT the population:
`.test262-cache/test262-standalone-current.jsonl`, generated 2026-08-15 09:41.

### The defect, under the harness (`var a = []; a.foo = 7`)

| query | base | after | Node |
| --- | --- | --- | --- |
| `a.foo` | `7` | `7` | `7` |
| `Object.getOwnPropertyDescriptor(a,"foo").value` | `7` | `7` | `7` |
| `Object.getOwnPropertyNames(a)` / `Object.keys(a)` | includes `"foo"` | unchanged | includes `"foo"` |
| `a.hasOwnProperty("foo")` | **`false`** | `true` | `true` |
| `a.propertyIsEnumerable("foo")` | **`false`** | `true` | `true` |
| `"foo" in a` | **`false`** | `true` | `true` |
| `for (k in a)` | **omits `"foo"`** | **still omits** | includes `"foo"` |

The for-in cell is a different root cause and is left open — residual 1.

### Population

Selected from the corpus baseline by SOURCE shape (a statically-array-bound
receiver + a presence query with a static, non-index, non-`length` key — exactly
the cell the fold answers), then re-verified on the base:

| set | base | after |
| --- | --- | --- |
| the 3 files that gate directly on this cell | 0 / 3 | **2 / 3 (+2, −0)** |
| the wider 22-file array-receiver presence/reflection candidate set | 0 / 22 | **2 / 22 (+2, −0)** |

Flipped: `built-ins/Object/defineProperty/15.2.3.6-4-403.js` (`arrObj.prop = 1002;
arrObj.hasOwnProperty("prop")` with an inherited `Array.prototype.prop`),
`built-ins/Object/defineProperty/15.2.3.6-4-339-3.js` (`defineProperty(arr,"prop",…)`
then `arr.hasOwnProperty("prop")`, plus its two descriptor asserts).

The third, `15.2.3.6-4-579.js`, does NOT flip and its failure moved EARLIER — see
residual 2. It is the honest cost of this widening and is recorded as such rather
than netted out.

### Controls (currently-PASSING standalone tests, run on the fixed tree)

| control | selection | result |
| --- | --- | --- |
| A — 197 files | every passing file where the route can FIRE (4 with a static named-key query on an array) + all 53 with an `Array.prototype` install *and* a named write (the bag-pollution shape) + a 140-file stride sample of the remaining 1,844 array+presence passers | **194 pass / 0 fail / 3 Temporal skips** |
| B — 163 files | deterministic stride sample of the passing `built-ins/Array`, `built-ins/Object`, `language/statements/for-in`, `language/expressions/in` families | **163 / 163** |

Zero failures on the after-run, so no base run can attribute a loss to this
change in either set.

### Byte-neutrality

`compile()` binary sha over 6 fixed sources (array expando + `in` expando +
array index + plain-object hasOwn + a plain indexed loop + for-in over an array):

- **host lane: byte-identical on all 6** — the predicate is gated on `ctx.standalone`.
- standalone: identical on 4; the two expando sources differ, as intended.

### Suites

`tests/issue-4062.test.ts` (NEW) 27/27. `issue-3251`, `issue-3251-s2`,
`issue-3251-s3`, `issue-4159`, `issue-4434-vec-index-domain-sparse-tail`: all
pass. `issue-3537` fails 1 of 11 — `"a computed 'length' key write cannot shadow
the real length via the bag"` — **verified failing identically on the base**
(residual 3).

## Residuals (measured, each with an owner)

1. **`for (k in arr)` on a STATICALLY-TYPED array does not enumerate named
   expandos (standalone).** Not a presence chokepoint at all: `emitArrayForIn`
   (`statements/loops.ts`) builds its own key SOURCE — the integer range
   `0..length-1` — and only the host lane materialises the full key list
   (`__array_forin_keys`, #3323). The dynamic lane is already correct, and the
   route is available: probed here, a receiver the compiler cannot type as a vec
   enumerates `0|1|foo` through `__object_keys_forin` + `__extern_length` /
   `__extern_get_idx` (the same helpers `compileForInStatement` uses for a
   dynamic receiver in standalone), with no method leakage from the prototype.
   **Deliberately not attempted here**: it changes the key source of *every*
   standalone array for-in, and the measured test262 gain is **zero** — the one
   population file that queries it,
   `language/statements/for-in/order-after-define-property.js`, fails first on
   its PLAIN-OBJECT half. Wants its own slice; nearest owner **#4222 / #2001**
   (array-hole + enumeration semantics), or a new `emitArrayForIn` slice.
2. **An inherited `Array.prototype` ACCESSOR does not consume a named write —
   the write lands in the #3537 bag.** `15.2.3.6-4-579.js` installs a
   get/set `prop` on `Array.prototype`, then `arrObj.prop = "myOwnProperty"`
   must run the inherited SETTER (leaving `hasOwnProperty("prop") === false`).
   The write goes to the bag instead, so this fix — correctly reporting what the
   bag holds — turns the file's first failure from `data !== "myOwnProperty"`
   into `hasOwnProperty("prop")` answering `true`. Fail either way, no pass lost,
   but it is the pollution direction #4010 warned about and it will cap this
   family until the write path consults inherited accessors. Nearest owner:
   **#4176** (proto-property companions / `protoIndexRecvGetMissInstrs`) — the
   read side of that store already exists; the SET side does not.
3. **`tests/issue-3537.test.ts` "a computed 'length' key write cannot shadow the
   real length via the bag" fails on current main** (base-verified, unrelated to
   this change): `var k = "length"; g[k] = 55` reaches a lane that does not apply
   `__vec_prop_set`'s `"length"` refusal. Owner: **#3537**.
4. **`arr.hasOwnProperty("data")` answers `true`.** `"data"` is the vec struct's
   second physical field, so the fold reports it as an own property. Pre-existing
   and deliberately untouched: this change widens only a folded `false`, and
   demoting a folded `true` is a different (and riskier) edit. Owner: **#3920 /
   #4225** (the closed-struct presence family, which owns unsound folded
   constants) or a `publicPhysicalFieldNames`-style screen at the vec fold site.
5. **Host lane: an array expando is invisible to `hasOwnProperty` / `in`, and so
   is a PLAIN-OBJECT expando** (`const o: any = {}; o.foo = 7;
   o.hasOwnProperty("foo")` → `false`). Base-verified, unchanged here, and
   asserted in `tests/issue-4062.test.ts` so it stays visible. Owner: **#3116** /
   the host descriptor sidecar.
6. **The STATIC `compileObjectDefineProperty` lane** (#4434 residual 1) and the
   **2^31−1 length ceiling** (#4434 residual 3) still gate the rest of the
   `15.2.3.6-4-*` family. Untouched, owners unchanged (#3251, and a new issue
   respectively).

## Acceptance criteria

- [x] `arr.hasOwnProperty("foo")`, `arr.propertyIsEnumerable("foo")`,
      `Object.hasOwn(arr,"foo")` and `"foo" in arr` agree with the read path for a
      named expando on a statically-typed array receiver (standalone).
- [x] gOPD / gOPN / `Object.keys` answers unchanged (they already agreed).
- [x] No affirmative answer changes: `length`, canonical indices, inherited
      methods and out-of-range indices are byte-identical.
- [x] Host lane byte-identical.
- [x] Zero losses across 360 currently-passing standalone control files.
- [x] `length` arms (#4434) and the static defineProperty lane (#3251) untouched.
- [ ] for-in agreement — **not done**, residual 1, routed with a measured plan.

---

## Original report (2026-08-02, verbatim)

Found by g-arraylen 2026-08-01 alongside D2 (task #49). Standalone-lane only. NOT fixed by #3984.

DEFECT: on standalone, an array's `length` is invisible to descriptor reflection —
`Object.getOwnPropertyDescriptor(arr,"length")` returns undefined and
`Object.getOwnPropertyNames(arr)` omits it — yet `arr.hasOwnProperty("length")` returns
true. The property exists but is not reflected.

DISCRIMINATORS ALREADY RUN (these rule out the broad alternatives — do not redo them):
  - gOPD works correctly on array INDICES        ⇒ not "gOPD broken on arrays"
  - gOPD works correctly on plain-object props   ⇒ not "gOPD broken generally"
  - gOPD works on the key "length" when the RECEIVER is a plain object
                                                  ⇒ not "the key 'length' is special"
  The defect is specifically the (array receiver × "length" key) cell.

WHY IT MATTERS BEYOND ITS OWN FILES: it makes the STANDALONE lane useless as an
instrument for any descriptor question about array length — it is precisely what
confounded the first D2 probe. Fixing D3 restores the ability to measure D2 on the
standalone lane directly.

Together with D2 this gates most of the 69 files #3984's fix did not flip.

⚠ Validate any probe against Node first (all 11 of g-arraylen's did pass on a real
  engine), and keep an in-sweep control — the control is what caught the confound here,
  not the pass count.

Context: /workspace/plan/log/analysis-2026-08-01-descriptor-dedup-map.md, PR #3973.

> **Status of the original cell, re-measured 2026-08-15 on BOTH trees** (base by
> file-copy revert, and with this fix applied — it passes on both, so the closure
> is not this change's): `var a = [1,2]` under the standalone harness —
> `a.hasOwnProperty("length")` `true`, `Object.getOwnPropertyDescriptor(a,"length")`
> a descriptor with `value === 2`, `Object.getOwnPropertyNames(a)` includes
> `"length"`. Closed by #3984 / #4227 / #4434.
