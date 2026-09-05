---
id: 5312
title: "A declared-but-never-initialised class field (`m!: T`) holds a null ref, not `undefined` — `this.m === undefined` does not fold and a guarded call traps"
status: done
completed: 2026-09-04
assignee: ttraenkler/opus-5312
sprint: current
created: 2026-09-04
updated: 2026-09-04
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
goal: core-semantics
related: [5309, 3522]
requested_by: ttraenkler/orchestrator
# 2026-09-04 (#5312). The fix adds one arm to each of three EXISTING guard
# chains — the nullish-comparison ref arm, its externref twin, and the two
# `typeof` fold sites. All emit logic was moved OUT to the new non-god module
# `src/codegen/uninitialised-field-undefined.ts`, which cut the growth from
# +76/+47 LOC and +46/+31/+14 function lines to what is granted below; the
# remainder is the arm itself plus the comment each chain's neighbours carry
# (every sibling case in these chains documents WHY the fold is unsound, and an
# undocumented one would be the odd entry out).
loc-budget-allow:
  - src/codegen/binary-ops.ts
  - src/codegen/typeof-delete.ts
func-budget-allow:
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  - src/codegen/typeof-delete.ts::compileTypeofComparison
---

# A guarded call on an uninitialised declared field traps where node returns 0

Found by the [#5309](5309-legacy-private-name-shadow-resolves-parent-method.md)
implementer (PR #5565) while pinning the `declare` narrowing. It is
**independent of #5309**: the control below has no parent method at all and
traps identically on base and on the #5309 branch.

```ts
class A { p() { return 9; } }
class B extends A {
  m!: () => number;
  f() { return this.m === undefined ? 0 : this.m(); }
}
new B().f();
```

| | result |
| --- | --- |
| node (`useDefineForClassFields`: the field is defined as `undefined`) | `0` |
| js2, gc and standalone | **traps** |

The field-collection loop in `collectClassDeclaration`
(`src/codegen/class-bodies.ts` ~L1186) gives `m!: T` a struct slot like any
other field, and nothing initialises it, so the slot holds a null ref. The
`this.m === undefined` comparison does not fold to true for a null callable
slot, the else arm runs, and the `call_ref` on the null slot traps.

What #5309 changed is only that the *shadowing* variant of this shape
(`class A { m() {…} }` + `class B extends A { m!: () => number }`) stops being
masked by the inherited-method alias — on base it silently returned the
parent's answer, now it reaches the same trap the control already hits. The
`typeof this.m` and non-callable read forms do not move.

## Acceptance criteria

1. The program above returns `0` on gc and standalone, with a test red on
   base for both lanes.
2. State which of the two is the fix and why: (a) an uninitialised
   declared field reads as `undefined` (the null slot is mapped to
   `undefined` at the read site), or (b) `=== undefined` / `== null` /
   `typeof` on a nullable callable slot fold correctly. Measure `typeof this.m`
   (`"undefined"` in node), `this.m == null` (`true`), and `this.m?.()`
   (`undefined`) alongside; all four must agree with node after the fix.
3. A field WITH an initialiser, a field assigned in the constructor, and a
   `declare m: T` field (no property installed, inherited callable stays
   visible) are pinned unchanged.
4. Byte identity on the emit corpus (`scripts/prove-emit-identity.mjs`,
   all targets); any moved row named.

## Out of scope

- `[[Define]]` vs `[[Set]]` semantics for fields with initialisers
  (`useDefineForClassFields` off) — a different shape.
- The #5309 row 14 base-typed receiver dispatch.

## Landed

Branch `claude/issue-5312-uninitialised-field-undefined`, base `origin/main`
`2ca2591652`. Test `tests/issue-5312-uninitialised-field-reads-undefined.test.ts`
(64 rows; **30 red on base**, 0 red on branch).

### The decision: (b), and (a) is not implementable on standalone

The issue offered (a) map the uninitialised slot to `undefined` at the read site
(or initialise it as `undefined` at construction) or (b) make the
comparison/`typeof` folds treat a null callable slot as `undefined`. **The fix
is (b).** The reason is not preference — **(a) cannot be done on the standalone
lane at all**:

- A function-typed class field is carried as **`externref`**, not as a struct
  ref (measured: `ctx.structFields.get("B")` for `class B { m!: () => number }`
  is `[["__tag","i32"],["m","externref"]]` on **both** lanes). An `externref`'s
  only absent inhabitant is `ref.null.extern`; there is no second one to mean
  `undefined`.
- Minting a real `undefined` therefore needs the **`__get_undefined` host
  import** — which standalone must not take. The compiler already says so at
  the site: `binary-ops.ts` carries the comment *"Fallback (standalone):
  ref.is_null (can't distinguish null/undefined)"*.
- So (a) would fix gc and leave standalone exactly where it started, i.e. it
  fails criterion 1 by construction.

(b) is also not "patch three symptoms": the compiler **already has this
mechanism twice**, and the fix supplies the missing third case to the same
family.

- `binary-ops.ts` already knows some carriers use a null ref *as* `undefined` —
  that is what `isNullableNativeString` and the `nonNullUnionHasUndefined`
  union test are.
- `property-nullish-read.ts` already routes **private** names through the typed
  struct read for exactly this reason, with the comment *"Keep their typed
  struct read so an uninitialized optional numeric field's exact f64
  `undefined` sentinel reaches the comparison."*

The decisive evidence that this is the right decomposition: on base,
`class B { #n?: number }` + `this.#n === undefined` is **already `true` on both
lanes** — because there both halves line up (typed read + `undefinedDefault`
sentinel). `#m!: () => number` was red only because the second half is missing
for a reference carrier. So the defect is one fact, not four.

Nothing folds. The emitted test is always a runtime `ref.is_null`, so a field a
**method** assigns later reads `undefined` before the write and the real
callable after it — no flow analysis (pinned: the "runtime:" rows return `10`
and `11`).

### Measured table — base vs branch vs node, both lanes

`gc` = default; `standalone` = `compile(src, { target: "standalone" })`.
Base column = the same probe with the three touched files reverted.

| # | program (field of `class B`) | node | base gc | base sa | branch gc | branch sa |
|---|---|---|---|---|---|---|
| 1 | issue program: `m!: () => number`, `this.m === undefined ? 0 : this.m()` | `0` | **trap** | **trap** | `0` | `0` |
| 2 | same, no base class | `0` | **trap** | **trap** | `0` | `0` |
| 3 | `m?: () => number`, same guard | `0` | **trap** | **trap** | `0` | `0` |
| 4 | private `#m!: () => number`, same guard | `0` | **trap** | **trap** | `0` | `0` |
| 5 | `typeof this.m` (string) | `"undefined"` | `"function"` | n/a¹ | `"undefined"` | n/a¹ |
| 6 | `typeof this.m === "undefined"` | `true` | `false` | `false` | `true` | `true` |
| 7 | `typeof this.m !== "function"` | `true` | `false` | `false` | `true` | `true` |
| 8 | `this.m == null` | `true` | `true` | `true` | `true` | `true` |
| 9 | `this.m !== undefined` | `false` | `true` | `true` | `false` | `false` |
| 10 | `this.m === null` | `false` | `true` | `true` | `false` | `false` |
| 11 | `this.m?.() === undefined` | `true` | `true` | n/a² | `true` | n/a² |
| 12 | write in a method, probe both sides | `10` | `0` | `0` | `10` | `10` |
| 13 | `typeof` across a method write | `11` | `1` | `1` | `11` | `11` |
| 14 | `b.m === undefined` off a plain receiver | `true` | `false` | `false` | `true` | `true` |
| 15 | inherited `m!` read from a subclass method | `true` | `false` | `false` | `true` | `true` |
| 16 | `o!: { a: number }`, `=== undefined` | `true` | `false` | `false` | `true` | `true` |
| 17 | `typeof this.o === "undefined"` | `true` | `false` | `false` | `true` | `true` |
| **controls — unchanged** ||||||
| 18 | field WITH initializer, guarded call | `7` | `7` | `7` | `7` | `7` |
| 19 | field assigned in the constructor | `7` | `7` | `7` | `7` | `7` |
| 20 | `declare m: T` — inherited callable stays visible | `9` | `9` | `9` | `9` | `9` |
| 21 | `m: (() => number) \| null = null`, `=== undefined` | `false` | `false` | `false` | `false` | `false` |
| 22 | same, `== null` | `true` | `true` | `true` | `true` | `true` |
| 23 | same, `typeof === "object"` | `true` | `true` | `true` | `true` | `true` |
| 24 | `if (this.m)` truthiness | falsy | falsy | falsy | falsy | falsy |
| **known divergences — PINNED, not fixed** ||||||
| 25 | `n!: number`, `=== undefined` | `true` | `false` | `false` | `false` | `false` |
| 26 | `typeof this.n` for `n!: number` | `"undefined"` | `"number"` | `"number"` | `"number"` | `"number"` |
| 27 | `const v = this.m; v === undefined` | `true` | `false` | `false` | `false` | `false` |
| 28 | `typeof this.m` for `m?: T` | `"undefined"` | not | not | not | not |
| 29 | `constructor(public m: () => number)`, guarded call | `6` | `0` | `0` | `0` | `0` |
| 30 | `s!: string` compare, `f(): string` annotated | `"u"` | `"d"` | n/a¹ | `"d"` | n/a¹ |
| 31 | `s!: string` compare, `f()` unannotated | `"u"` | `"d"` | n/a¹ | `"u"` | n/a¹ |

¹ A standalone `main` that returns a **string** hands JS a native string array,
which reads back as `undefined` whatever the value is — the row is not
measurable on that lane, so it is pinned gc-only.

² **A separate, pre-existing standalone gap, not this issue.** An optional call
on a boxed class field emits the host imports `__call_function`,
`__get_undefined` and `__js_array_new` *even under* `target: "standalone"`, so
the module will not instantiate without a JS host. Measured 2026-09-04: a
**constructor-assigned** field of the same type emits the identical three
imports, and so does `this.m?.()` with no comparison at all — so this is about
optional-calling a boxed field, not about initialisation. Unchanged by this PR.

### Why rows 25–31 were left

- **25/26 (`n!: number`)** — a numeric slot's construction default is `0`, and
  `FieldDef.undefinedDefault` (the exact f64 `undefined` sentinel) is minted
  only for `?` + f64, never for `!`. Extending it to `!` changes numeric field
  **storage** for every `x!: number` in the codebase; that is a wider change
  than this issue's `## Out of scope` allows, and it would move emit-corpus
  bytes that criterion 4 requires to stay put. **Follow-up candidate.**
- **27 (read bound to a local)** — the local carries the null reference itself,
  detached from the declaration. Answering it needs the read site to MINT a
  real `undefined`, i.e. option (a) — blocked on standalone as above. The same
  boundary shows up as `new B().m` reading back as `null` rather than
  `undefined` when the raw value is exported to a JS host: under (b) every
  **in-program** observation agrees with node; the raw exported reference does
  not.
- **28 (`m?: T` typeof)** — `m?: T`'s declared type already admits `undefined`,
  so `typeof` never folds; it takes the runtime `__typeof` helper, which
  classifies a null reference as `"object"`. That is a different site. It was
  deliberately not widened: `staticTypeof` is set to `null` by a long chain of
  unrelated soundness guards, and firing on all of them would undo those guards.
- **29 (parameter property)** — identical on base, both lanes; a pre-existing
  gap in callable parameter properties, unrelated to initialisation.
- **30/31 (`s!: string`)** — coverage is partial and **context-dependent**: the
  unannotated shape reaches the fixed nullish arm (red → green), the annotated
  `f(): string` twin takes the string-specialised binary path and still answers
  `"d"`. Both halves are pinned so the split is visible.

### Implementation

New: `src/codegen/uninitialised-field-undefined.ts` — one predicate,
`uninitialisedFieldSlot(ctx, expr)`, resolving a property access to the
nullable-reference slot of a declared-but-never-initialised field. It returns a
slot only when the declaration has **no initializer**, is not `static` /
`declare` / `abstract`, its **annotation does not admit `null`**, the class's
**constructor does not assign it** (including parameter properties), the class
name is resolvable, and the slot is a reference carrier (`ref` / `ref_null` /
`externref`).

Three call sites, all in the existing families:

1. `property-nullish-read.ts` — take the **typed struct read** for such a
   field, exactly as private names already do. The boxed host route
   (`__extern_get` + `__extern_is_undefined`) answered `false` for the null
   slot, which is what made the guard fall through into the trapping call.
2. `binary-ops.ts` — two arms. The **struct-ref** arm gains a third
   `nullRepresentsUndefined` case beside `nonNullUnionHasUndefined` and
   `isNullableNativeString`. The **externref** arm (which is where a callable
   field actually lands) gains a matching case: `=== undefined` accepts the
   null slot, and `=== null` stops reporting `true` for it.
3. `typeof-delete.ts` — `emitUninitialisedFieldNullTest` emits the runtime
   `ref.is_null` and both `typeof` entry points consume it: the comparison arm
   reduces it to its boolean, the string arm selects between two string
   constants with an `if (result: <string>)`. Both return `false` **without
   emitting anything** when the shape does not apply, so every historical fold
   is untouched.

The predicate resolves the declaration through **`ctx.oracle.declarationsOf`**,
not `valueDeclarationOf` — the latter gates on `ts.isIdentifier` and so returns
nothing for a **PrivateIdentifier**, which would have left the `#m!` twin
trapping while the public `m!` one was fixed. That is precisely the
public/private split [#5309](5309-legacy-private-name-shadow-resolves-parent-method.md)
was about. No raw-checker call is added.

### Criterion 4 — emit corpus

`node_modules/.bin/tsx scripts/prove-emit-identity.mjs write` on base, then
`… check` on the branch:

```
[prove-emit-identity] IDENTICAL — all 60 (file,target) emits match baseline. ✓
```

**Zero moved rows, all targets** (gc / standalone / wasi / linear). No corpus
file declares an uninitialised class field on a reference carrier that is then
compared to `undefined` or passed to `typeof`, so the predicate never fires
there and the guards leave every other path byte-identical.

### Rest of validation

- **172 class/field suites** (`tests/*class*`, `tests/*field*`, `issue-5309*`,
  `issue-3520-*`, `issue-3522-*`) run base vs branch. Failing-name diff is
  **empty except one row**, and that row is #5309's own pin of *this* defect:
  `tests/issue-5309-child-field-shadows-parent-method.test.ts` asserted that the
  uninitialised-field control still **traps** (it was the control proving
  #5309's trap was pre-existing, not caused by the shadow fix). Flipped to
  node's answer (`0`) rather than deleted, so the boundary argument stays on
  the record. Everything else: 37 failures on base, the same 37 on branch.
- **Equivalence, 8 shards** (`EQUIVALENCE_FORK_HEAP_MB=4096`): every shard
  "No new equivalence regressions"; failing set sums to 5+4+3+0+2+7+2+1 = **24**
  = exactly the known baseline.
- **Ratchet chain** bare and with `LOC_GATE_BASE=$(git rev-parse origin/main)`:
  loc-budget, func-budget, coercion-sites, oracle-ratchet, dead-exports — green,
  with the two grants above recognised as coming from this file. No
  `scripts/*-baseline.json` touched. `check:coercion-sites` needed no new
  allowance: the fix adds no coercion vocabulary, only `ref.is_null` tests.
- Green: `check:ir-dialect`, `check:ir-kind-neutrality`, `check:jstag-seam`,
  `check:ir-layering`, `check:ir-fallbacks`, `check:host-import-policy`,
  `check:ir-only --policy=hybrid`, `check:standalone-ir-cutover-corpus`,
  `check:pushraw`, `check:stack-balance`, `check:codegen-fallbacks`,
  `check:any-box-sites`, `check:speculative-rollback`,
  `check:harness-compile-budget`, `check:ir-adoption`, `check:linear-ir`,
  `typecheck`, `lint`, `prettier --check`.
