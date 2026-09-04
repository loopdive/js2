---
id: 5309
title: "Legacy class-body route: a child's callable FIELD is shadowed by the parent's same-named METHOD at call sites (`this.#m()` and `this.m()` alike) — returns 1 where node returns 2"
status: done
completed: 2026-09-04
sprint: current
created: 2026-09-03
updated: 2026-09-04
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
goal: core-semantics
related: [3522, 3518]
requested_by: ttraenkler/orchestrator
# 2026-09-04 (S1): a wrong-answer miscompile with TWO independent sources, so the
# fix needs a registration-side exclusion AND a call-site guard that share one
# fact. +26 in class-bodies.ts (the `ownInstanceFieldNames` collection loop and
# the two `classFieldShadowedInheritedCallables` records, plus the comment that
# names all three consumers of the false alias), +9 in call-receiver-method.ts
# (the ancestor-walk guard), +12 in context/types.ts (the doc comment on the new
# set — the whole point of the field is that two distant sites agree, which the
# declaration has to say), +1 in create-context.ts (the initializer). No
# behaviour is added: the 60-row emit-identity corpus is byte-IDENTICAL.
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/context/create-context.ts::createCodegenContext
---

# A wrong-answer miscompile on the direct route, found while measuring #3522 W1-B

Found by the [#3522](3522-ir-r3-classes-closures-compile-once.md) W1-B
implementer (PR #5552) while pinning the private-name shadow family, and
recorded in that issue's W1-B checkpoint. It is **not** caused or changed by
W1-A/W1-B: the row is `class-member-unsupported`, legacy-owned, on base and on
the branch, and reverting each W1-B site leaves the answer unchanged.

```ts
class A { #m() { return 1; } }
class B extends A {
  #m = () => 2;
  f() { return this.#m(); }
}
new B().f();
```

| | result |
| --- | --- |
| node | `2` |
| js2 (direct route, gc and standalone) | **`1`** |

Private names are per-class: `B.#m` and `A.#m` are two different members. Both
mangle to `__priv_m`, and the direct route's member-name resolution
(`src/codegen/class-bodies.ts`, `resolveClassMemberName` and the inherited
member lookup it feeds) resolves the call against the parent's **method**
`__priv_m` instead of the child's **field** `__priv_m`, so the parent's body
runs.

The IR side is not affected today only because the shape is refused before
selection (`class-member-unsupported` — a field-typed private member has no
method descriptor). W1-B's S3 change (`classElementProjectionName`) makes the
selector prefer the child's own private member for that reason; the direct
route has no equivalent rule.

## Acceptance criteria

1. The program above returns `2` on gc and standalone through the direct
   route, with a test that pins both lanes and the current wrong answer red on
   base.
2. The public twin (`class B extends A { m = () => 2; f() { return this.m(); } }`)
   is measured alongside: if it already returns 2, name the branch of the
   member-name resolution that treats private names differently; if it also
   returns 1, the defect is the inherited-callable lookup order, not the
   mangling, and the issue title is corrected in the PR.
3. State whether the same collision exists for a child **method** `#m()`
   shadowing a parent method `#m()` (W1-B measured that case IR-owned and
   correct after S3; the direct route is unmeasured).
4. Byte identity on the 34-case corpus, gc + standalone: any moved row named.

## Out of scope

The `#m` vs public `__priv_m` mangling collision (inherited, listed in the
#3522 W1-B plan) — a different program shape.

## Implementation Plan (Fable lane, 2026-09-04)

Measured on main `56c7dca166` with `.tmp/probe-5309*.mts` (compile via
`src/index.js` `compile()`, gc = default options, standalone =
`{ target: "standalone" }`). Every row below is identical on gc and standalone.

| shape | node | js2 direct route |
| --- | --- | --- |
| **the issue program** (child `#m = () => 2`, parent `#m()`) | 2 | **1** |
| public twin (child `m = () => 2`, parent `m()`) | 2 | **1** |
| child `#m()` shadowing parent `#m()` (criterion 3) | 2 | 2 |
| child `#m = () => 2`, no parent / parent without `#m` | 2 | 2 |
| grandparent declares `m()`, child field `m` | 2 | **1** |
| child field read then called (`const h = this.#m; return h()`) | 2 | 2 |
| child `#m = 5`, parent `#m()`, `return this.#m` | 5 | 5 |
| child `#m = () => 2` plus `this.#m = v` in a child method | 3 | **traps** (TypeError arm: "write to private method") |
| public twin of the row above | 3 | **1** |
| `static m = () => 2` shadowing `static m()` | 2 | 2 |
| child field `m` shadowing parent `get m()` | 2 | 2 |
| `Object.getPrototypeOf(new B()).hasOwnProperty("m")` | false | false |
| `b.m()` outside the class, `b: B` | 2 | **1** |
| `a.m()` with `a: A` holding a `B` | 2 | **1** (see Out of scope) |

**Criterion 2 verdict: the public twin also returns 1, so the defect is the
inherited-callable lookup, not the `__priv_` mangling.** The title above is
corrected accordingly; the file name (slug) stays.

### Root cause — one site, three symptoms

`collectClassDeclaration` (`src/codegen/class-bodies.ts`), inherited-member
registration, ~L1828-1836:

```ts
const childFullName = `${className}_${suffix}`;
const childKey = classMemberFuncKey(ctx, childFullName); // (#1983)
if (!ownMethodNames.has(suffix) && !ctx.funcMap.has(childKey)) {
  setProgramAbiInheritedClassCallableAlias(ctx, decl, childKey, funcIdx);
  ctx.classMethodSet.add(childFullName);
}
```

`ownMethodNames` (L1501-1518) holds the child's own **methods** only. A child
that declares the name as an instance **field** is not in the set, so the loop
aliases `B_m` → `A_m` and adds `B_m` to `ctx.classMethodSet` — the child is now
recorded as *having the method*. Three consumers then agree on the wrong
answer:

1. **Call site** — `call-receiver-method.ts` ~L1778-1783:
   `hasReceiverMember = ctx.classMethodSet.has("B_m")` is true, `funcIdx`
   resolves to `A_m`, and the callable-field arm (~L1909, "If no method found,
   check if the property is a callable struct field") is never reached. The
   emitted `B_f` is `ref.cast null (ref null <A struct>)` + `return_call A_m`
   (verified in WAT for both twins). Private names never enter the ancestor
   walk at L1819 — they do not need to; the alias already answered.
2. **`classifyPrivateMember`** (`expressions/helpers.ts` L448-476) probes
   `classMethodSet` before `structFields`, so `B.#m` classifies as `"method"`
   — that is the trapping `this.#m = v` row (assignment.ts L4388 emits the
   §13.15.2 "write to a private method" TypeError).
3. **`resolveReceiverMethodClassName`** (helpers.ts L537) trusts the same
   classification.

The field read path (`this.#m` as a value) consults `structFields` first,
which is why the read-then-call row and the `#m = 5` row are already right.

### S1 — do not alias a parent method over the child's own field (the fix)

In `collectClassDeclaration`, next to `ownAccessorNames` (L1770-1776), build
`ownInstanceFieldNames`: every `ts.isPropertyDeclaration(member)` **without**
`static`, keyed by `resolveClassMemberName(ctx, member.name)` (so `#m` →
`__priv_m`, matching the alias suffix). Then at L1832:

```ts
if (!ownMethodNames.has(suffix) && !ownInstanceFieldNames.has(suffix) && !ctx.funcMap.has(childKey)) {
```

Apply the same exclusion to the accessor branch just above (L1815-1826,
`childFullName` for `get_`/`set_` and the `classAccessorSet` inheritance): a
child field shadowing a parent accessor is a semantic no-op today (row 11 is
already 2) but the alias is equally false; keep the two branches consistent
and let byte identity say whether anything moves.

Why this site and not the call site: the alias is the *shared* lie. Fixing
`call-receiver-method.ts` alone leaves symptom 2 (the trapping write) in
place; fixing the registration removes all three at once and the callable-field
arm at ~L1909 already does the right thing (rows 4 and 6 prove it).

What must NOT change: `ownMethodNames` semantics for own methods; static
members (`ownInstanceFieldNames` is instance-only — row 10 is already correct
through `staticMethodSet`, and a static field must not start shadowing an
instance method of the same spelling).

### S1-alt — measured, not shipped

Private names cannot be inherited at all (`#m` in `B` never means `A.#m`), so
the `__priv_*` aliases are arguably never needed: the lexical walk in
`classifyPrivateMember` resolves a private call inside `A` with a `B`-typed
receiver to `A___priv_m` without them. Measure "skip the alias when `suffix`
starts with `__priv_`" as a separate A/B: if the 34-case corpus is
byte-identical and `tests/issue-3522-*` / private-name suites stay green,
report it in the PR as a follow-up candidate; do **not** ship it here. S1 is
the minimal fix for the measured rows.

### Tests — `tests/issue-5309-child-field-shadows-parent-method.test.ts`

Both lanes (`compile(src)` and `compile(src, { target: "standalone" })`),
using the exact programs from the table:

- rows 1, 2, 5 (private, public, grandparent): expect `2` — **red on base**.
- row 8 (`this.#m = v` then call): expect `3` — **red on base** (trap).
- row 9 (public write twin): expect `3` — **red on base**.
- rows 3, 4, 6, 7, 10, 11: unchanged expectations, pinned so S1 cannot
  regress them.
- `b.m()` outside the class with `b: B` (row 13): expect `2` — red on base;
  same alias, same fix.

Run the new file on base first and record which rows are red (the plan says
5 + row 13); a test that is green on base pins nothing.

### Validation, in order

1. `npx tsx .tmp/probe-5309.mts` on base → capture the table above (one `cp`
   of `src/codegen/class-bodies.ts` to `.tmp/base-class-bodies.ts` **before**
   editing).
2. S1, then the new test file red→green.
3. `tests/issue-3522-*.test.ts`, `tests/issue-3520-*.test.ts`,
   `tests/class*.test.ts`, `tests/private*.test.ts` (whatever matches
   `ls tests | grep -i 'private\|class'`), with
   `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`.
4. Byte identity on the 34-case corpus, gc + standalone: sha256 of each binary
   before/after. **Expected: identical** — no corpus program has a child field
   shadowing a parent method (verify by grepping the corpus for `extends`
   classes; name any moved row and its diff).
5. `pnpm run check:ir-fallbacks`, the five ratchet gates chained, and again
   with `LOC_GATE_BASE=$(git rev-parse origin/main)`.
6. `check:codegen-fallbacks`, `check:stack-balance`, `check:pushraw`.

### Acceptance (supersedes the criteria list above where they differ)

1. Table rows 1, 2, 5, 8, 9, 13 match node on gc and standalone; the test file
   is red on base for exactly those rows.
2. Rows 3, 4, 6, 7, 10, 11, 12 unchanged.
3. Corpus byte-identical, or every moved row named with its cause.
4. The PR body states the S1-alt measurement (byte identity + suites) without
   shipping it.
5. Issue file: `status: done`, and this section's table re-run on the branch.

### Out of scope (recorded, not fixed here)

- **Parent instance field vs child method** (`class A { m = () => 1 }`,
  `class B extends A { m() { return 2 } }`): node 1, js2 2. Different
  mechanism — the instance field installed by `A`'s constructor shadows
  `B.prototype.m` at runtime, and the direct route dispatches statically to
  the child's method. Needs field-before-method precedence in the call
  resolver, not the alias; file separately if a corpus program depends on it.
- **Base-typed receiver holding a subclass with a shadowing field**
  (`function g(a: A) { return a.m() }` with a `B`): node 2, js2 1. `A_m` is a
  real method on the static receiver type; the fix is virtual dispatch over
  instance fields, which the direct route does not do for fields. Same
  file-separately rule.
- The `#m` vs public `__priv_m` mangling collision (already listed).

### S1 — landed

Implemented 2026-09-04 on `claude/issue-5309-child-field-shadow`, base
`origin/main` `5a55f7f55f` (re-verified against `be9de98af4` at merge time).
All 14 rows re-run on the branch with `.tmp/probe-5309.mts`
(`compile()` from `src/index.js`; gc = default options, standalone =
`{ target: "standalone" }`). Node column re-derived independently with
`.tmp/probe-5309-node.mjs` rather than copied from the plan.

| # | shape | node | base (gc / sa) | S1 (gc / sa) |
| --- | --- | --- | --- | --- |
| 1 | the issue program (child `#m = () => 2`, parent `#m()`) | 2 | **1 / 1** | 2 / 2 |
| 2 | public twin (child `m = () => 2`, parent `m()`) | 2 | **1 / 1** | 2 / 2 |
| 3 | child `#m()` shadowing parent `#m()` | 2 | 2 / 2 | 2 / 2 |
| 4 | child `#m = () => 2`, parent without `#m` | 2 | 2 / 2 | 2 / 2 |
| 5 | grandparent declares `m()`, child field `m` | 2 | **1 / 1** | 2 / 2 |
| 6 | child field read then called | 2 | 2 / 2 | 2 / 2 |
| 7 | child `#m = 5`, parent `#m()`, `return this.#m` | 5 | 5 / 5 | 5 / 5 |
| 8 | child `#m = () => 2` plus `this.#m = v` | 3 | **traps / traps** | 3 / 3 |
| 9 | public twin of row 8 | 3 | **1 / 1** | 3 / 3 |
| 10 | `static m = () => 2` shadowing `static m()` | 2 | 2 / 2 | 2 / 2 |
| 11 | child field `m` shadowing parent `get m()` | 2 | **1 / 1** ⚠ | 2 / 2 |
| 12 | `getPrototypeOf(new B()).hasOwnProperty("m")` | false | false / false | false / false |
| 13 | `b.m()` outside the class, `b: B` | 2 | **1 / 1** | 2 / 2 |
| 14 | `a.m()` with `a: A` holding a `B` (out of scope) | 2 | 1 / 1 | 1 / 1 |

Every in-scope row (1–13) now matches node on both lanes. Row 14 is unchanged
by design — see "Out of scope".

#### Two deviations from the plan, both forced by measurement

**(a) Row 11 was NOT already correct.** The plan's table recorded it as `2`
and called a child field shadowing a parent accessor "a semantic no-op today".
Re-measured on `5a55f7f55f` it is `1` on both lanes (node: `2`, confirmed
directly). So the accessor branch of the inherited registration carries the
same false alias as the method branch, and the plan's instruction to apply the
exclusion there for *consistency* turns out to fix a real wrong answer. Row 11
is red on base in the test file.

**(b) S1 as specified is NOT sufficient — the defect has TWO independent
sources.** With only the `ownInstanceFieldNames` exclusion in
`collectClassDeclaration`, rows 1, 8 and 11 (the private and accessor shapes)
went green and rows **2, 5, 9 and 13 — every public-name shape — stayed red**.

The plan's root-cause section is right that private names never reach the
ancestor walk at `call-receiver-method.ts` L1819 "because the alias already
answered". The inference it draws — that removing the alias therefore fixes
every row — does not hold for public names: that walk is guarded by
`!ts.isPrivateIdentifier(propAccess.name)`, so for a **public** `m` it runs,
reads `Parent_m` straight out of `ctx.classMethodSet`, and reproduces the exact
same wrong answer with no alias involved. Dropping the alias removes one of two
sources; the other is untouched.

The fix therefore records the shadowing fact once and consults it at both
sites:

- `ctx.classFieldShadowedInheritedCallables` (`src/codegen/context/types.ts`,
  initialised in `create-context.ts`) — `"Class_member"` for every class with an
  own instance field whose name is a callable up its chain, populated in the
  same loop that computes the exclusion.
- `collectClassDeclaration` refuses the inherited alias (the plan's S1).
- `compileReceiverMethodCall` refuses the ancestor walk for such a receiver,
  leaving `funcIdx` undefined so the callable-struct-field arm answers — which
  rows 4 and 6 already proved correct.

This is the only change outside the plan's named site, and it is the minimum
that makes the public rows pass.

#### One narrowing the plan did not specify: `declare`

`ownInstanceFieldNames` skips `hasDeclareModifier` members as well as
`static` ones. `declare m: () => number` is a pure type re-annotation that
installs no property, so the inherited callable is still the right answer for
it — but the field-collection loop at L1186 has no `declare` filter, so such a
member *does* get a struct field, and treating it as a shadow would route the
call to a never-initialised slot. Measured: with the guard the row stays at
node's `1`; it is pinned in the test file.

#### Byte identity

`npx tsx scripts/prove-emit-identity.mjs` (default corpus:
`website/playground/examples` + `scripts/emit-identity-corpus`), base snapshot
captured on `5a55f7f55f` before the edit: **IDENTICAL — all 60 (file,target)
emits match**, no row moved.

Note the corpus is **60 rows, not the 34 the plan cites**: 15 `.ts` files ×
4 targets (`gc`, `standalone`, `wasi`, **`linear`** — the plan named only the
first three). Byte identity is expected here for a structural reason worth
recording: exactly one corpus file declares an `extends` class
(`website/playground/examples/js/classes.ts`), and its `Dog` shadows nothing —
`#breed` is a field the parent does not declare, `speak()`/`kingdom()` are
method/static *overrides*, and `Animal`'s `get name`/`get age` never collide
with a `Dog` field. The corpus cannot exercise this defect, so identity here is
a no-drift check, not evidence of correctness; the test file carries that load.

#### Suites

`tests/issue-3522-*`, `tests/issue-3520-*`, `tests/issue-5309*` and every
`tests/*class*` / `tests/*private*` file — **167 files**, run on base and on
the branch with `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`
(`pool: "forks"`, `singleFork: false`, so vitest already gives each file its
own fork process — the sweep was batched rather than one invocation per file,
which is the same isolation at a fraction of the wall time).

- base: 68 failing test names · branch: 48.
- **New failures on the branch: none.** The 48 are byte-identical to 48 of the
  base 68 — all pre-existing on `origin/main`, none in a file this PR touches.
- The 20-name difference is exactly this PR's own new test file going red→green.

New file `tests/issue-5309-child-field-shadows-parent-method.test.ts`: **20 of
43 red on base, 43/43 green on the branch.** Red on base were rows 1, 2, 5, 8,
9, 11 and 13 (the plan predicted all but 11) plus three shapes added here —
constructor-assigned field, per-class-private isolation, and a child field
beating an intermediate class's override.

#### Ratchet gates

`check-loc-budget`, `check-func-budget` (both also with
`LOC_GATE_BASE=origin/main`), `check-coercion-sites`, `check:oracle-ratchet`,
`check:dead-exports`, `check:ir-fallbacks`, `check:ir-dialect`,
`check:ir-kind-neutrality`, `check:jstag-seam`, `check:ir-layering`,
`check:host-import-policy`, `check:ir-only --policy=hybrid` (verdict READY),
`check:standalone-ir-cutover-corpus`, `check:pushraw`, `check:stack-balance`,
`check:codegen-fallbacks`, `check:any-box-sites`, `check:speculative-rollback`,
`check:harness-compile-budget`, `check:ir-adoption`, `typecheck`, `lint`,
`prettier --check` — all green. LOC/func growth is granted in this file's
frontmatter with the dated rationale; no `scripts/*-baseline.json` was touched.

Against CI's base the LOC gate additionally reported
`src/codegen/statements/loops.ts +1`, which this PR does not touch — main's own
drift, cleared by merging `origin/main` in.

### S1-alt — measured, not shipped

"Skip the inherited alias entirely when the suffix starts with `__priv_`", on
top of S1, on the grounds that private names can never be inherited.

- 60-row emit corpus: **IDENTICAL**.
- All 14 probe rows: identical to S1 (rows 1–13 correct, 14 unchanged).
- 167-file suite sweep: **48 failing names, byte-identical to S1's 48** — no
  new failure, none fixed.

So the `__priv_*` aliases are indeed dead weight on everything measured here,
and the narrowing is safe as far as this evidence goes. It is **not shipped**:
it removes a mechanism rather than correcting one, its whole value is
simplification, and nothing in the measured set distinguishes it from S1. It
belongs in its own change where that removal is the point and can be justified
against test262 rather than as a rider on a wrong-answer fix.

### Additionally found — pre-existing, NOT fixed here

**A declared-but-never-initialised field is not `undefined`.** For
`class B { m!: () => number }`, `this.m === undefined` does not fold and
`typeof this.m` does not answer `"undefined"`; the slot holds a null ref, so a
guarded call traps where node returns the guard's value.

This is independent of #5309 — the control has **no parent method at all** and
traps identically on base:

```ts
class A { p() { return 9; } }
class B extends A { m!: () => number; f() { return this.m === undefined ? 0 : this.m(); } }
new B().f();   // node 0 · js2 traps, on base AND on the branch
```

What S1 changes is only that the shadowing variant of this shape stops being
*masked*: on base it silently called the parent's method and returned `1`,
which is a wrong answer; now it reaches the same pre-existing trap the control
already hits. The `typeof` and non-callable read forms (`7` on both sides) do
not move at all. Pinned as a control in the test file so the family is visible;
worth its own issue.
