---
id: 7628
title: "Computed-key and reflective member writers are unseen by the realm write scan"
status: ready
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7350, 7503, 7363]
---

# #7628 — Computed-key and reflective member writers are unseen by the realm write scan

## Problem

#7350 slice 1 (PR #7549) folds a writable member `X.k` of a realm constructor (an `Object` static's call form,
`Number.isNaN`, a `Math` method, …) only when nothing in the program writes the key `k` on a realm object. The
member-write scan, `src/ir/realm-member-writes.ts`, counts every store target and every call of a key writer
(`defineProperty`, `defineProperties`, `assign`, `__defineGetter__`, `__defineSetter__`, and the readers that hand a
writer out: `getOwnPropertyDescriptor(s)`, `values`, `entries`) by key.

It does not see a key writer that is reached by a key the source does not spell. In each of these, `fold` stays true
for `Number.isNaN` although the program redefines it (review RV-PR7549, round 2):

1. `Object["define" + "Property"]((1).constructor, "isNaN", {value: 1});`, a computed read of a key writer;
2. `var p = "Property"; Object[`define${p}`]((1).constructor, "isNaN", {value: 1});`, a template key with a
   substitution;
3. `(1).constructor["__define" + "Getter__"]("isNaN", function () {});`, a computed read off a constructor;
4. `var {["define" + "Property"]: d} = Object; d((1).constructor, "isNaN", {value: 1});`, a computed binding-element
   key;
5. `var d; ({["define" + "Property"]: d} = Object); d((1).constructor, "isNaN", {value: 1});`, a computed key of an
   assignment pattern;
6. `Object.getOwnPropertyNames(Object).forEach(function (n) { Object[n]((1).constructor, "isNaN", {}); });`, own
   names read back by key.

None of these is observable today: on the Prepared path a folded member and the native are the same algorithm until
B3b-1 holds the realm's prototypes and statics. **#7350 B3b-1 (#7561, PR #7535) depends on this**: once members are
held objects, a fold that the program has redefined answers wrongly.

They are pinned as `it.fails` rows (fold = false) in `tests/issue-7350-slice1-expando-escape.test.ts`. They flip when
the rule closes. The `foldsBuiltinMember` doc lists them under "Not yet seen".

## Why the naive rule is not taken

The naive rule is: any element access, or computed binding-element key, whose key is not a literal writes every key.
Measured on `e104f5a5a0` (2026-11-28, real harness, `plan/samples/7350-b3bc/README.md`):

| list | base pass | with the naive rule | lost |
| --- | ---: | ---: | ---: |
| carriers (`plan/samples/7350-b3bc/carriers.txt`) | 229 | 215 | 14 |
| o411 (`plan/samples/7354-o411.txt`) | 83 | 40 | 43 |

The cause is the harness itself. `compareArray` in `assert.js` reads `a[i]` and `b[i]`, so every test262 program
"writes every key" and no writable member folds. The `assert.js` + `sta.js` prelude alone stops `Math.abs` from
folding. Lost rows:

- carriers: `getOwnPropertyDescriptor/15.2.3.3-4-191`, `-194`, `-196` … `-201`, and `defineProperty/15.2.3.6-3-5`,
  `-6`, `-7`, `-10`, `-11`, `-12`;
- o411: its `Object.create` / `defineProperty` / `defineProperties` / `getOwnPropertyDescriptor` / `Math` rows.

The patch and its 6 rows are kept in the slice 1 worktree's scratch (`.tmp/r2/rule-a.patch`), not in the repo.

## Implementation Plan (2026-11-28)

Measured on PR #7549's head `b7cfc6257f` (#7350 slice 1 + #7354 O2). `origin/main` is `234cf4402a` (#7556 merged
03:26Z). It does not yet contain slice 1: `realm-member-writes.ts` and the slice 1 test exist only on the PR branch, and
main changes neither `builtin-global-binding.ts` nor `shared/binding-writes.ts` relative to the branch's merge base.
#7556 makes a literal `Function(...)` text a program source (`<function:N>.js`, `src/ir/literal-dynamic-code.ts`).
`bindingFacts` walks every program source, so those texts are scanned like any file and need no new handling.
After main is merged, re-run the acceptance below on that head.

### Measured candidates

Every candidate is the same scratch arm: an element access that is no store target with a non-literal key, or a
destructuring pattern's computed key (`var {[k]: d} = o`, `({[k]: d} = o)`). The candidates differ only in when that
arm "writes every key on any object". All of them are in one patch, switched by `RULE`
(`.tmp/7628/candidates.patch` in the #7628 worktree). The census is `prepared-census.mts --harness real --jobs 2`.
The base is `b7cfc6257f` measured here: carriers 230, o411 84. (`e104f5a5a0` read 229 / 83; `b7cfc6257f` adds O2.)

| rule | the arm writes nothing when … | carriers | o411 | lost | rows closed |
| --- | --- | ---: | ---: | --- | ---: |
| base | (no arm) | 230 | 84 | — | 0 / 6 |
| naive | never | 216 | 41 | 14 + 43 | 6 / 6 |
| (1) use | its value goes only into `===` / `!==`, `typeof`, `!`, `void`, a statement or a test | 216 | 41 | 14 + 43 | 6 / 6 |
| (2) receiver | its receiver is a fresh value or fresh name (the fixed point) | 216 | 41 | 14 + 43 | 6 / 6 |
| (3) const key | its key's values (literals, `+`, templates, names bound once to such and never assigned) name no key writer | 216 | 41 | 14 + 43 | 6 / 6 |
| (3n) key values | as (3), plus numbers: a numeric literal, arithmetic, `++` / `--`, and names assigned only such | **230** | **84** | **0** | 6 / 6 |
| (4) (3n) or (1) | either | 230 | 84 | 0 | 6 / 6 |

- Under (3n) no census row changes at all, on either list (changed rows 0 of 1,977 and 0 of 411).
- Rules (1), (2) and (3) each lose exactly the naive rule's 14 carriers and 43 o411 rows: the lost sets are
  identical (`getOwnPropertyDescriptor/15.2.3.3-4-191`, `-194`, `-196` … `-201`, `defineProperty/15.2.3.6-3-5`, `-6`,
  `-7`, `-10`, `-11`, `-12`), and each changes the same 192 carrier rows and 79 o411 rows.
- The cause is `assert.js` line 171: `if (!assert._isSameValue(b[i], a[i]))`.
  - The two reads are call **arguments**, not comparisons, so (1) cannot pass them: the value reaches a call.
  - `a` and `b` are parameters, so (2) cannot pass them.
  - `i` is assigned by `i++`, so (3) cannot pass it.
  - Only a rule that knows `i` is a number keeps the harness folding.
- Fact rows (`foldsBuiltinMember`, scratch probe `.tmp/7628/rows.mts` with `extra.json` / `extra2.json`; stop = fold false):

  | program | (1) | (2) | (3) | (3n) | (4) |
  | --- | --- | --- | --- | --- | --- |
  | the six #7628 rows | stop | stop | stop | stop | stop |
  | compareArray's shape (`same(b[i], a[i])` in an `i++` loop) | stop | stop | stop | **keep** | **keep** |
  | `var x = a[i]` with `var i = 0` | stop | keep | keep | keep | keep |
  | `s += arr[j]` in a `j++` loop | stop | keep | stop | keep | keep |
  | `for (var k in o) if (o[k] !== 1) …` | keep | stop | stop | stop | keep |
  | `var g = ({})["__define" + "Getter__"]; g.call((1).constructor, "isNaN", f)` | stop | **keep (unsound)** | stop | stop | stop |
  | `var p = "Xyz"; this.p = "Property"; Object["define" + p](…)` (also `globalThis["p"] = …`, `defineProperty(this, "i", …)`, `Object.assign(this, {i: …})`) | stop | stop | stop | stop | stop |
  | `p += "erty"`, `t += "define"; t += "Property"` | stop | stop | stop | stop | stop |

### The left-hand walk hole (rows 2–4)

The review note is not written down anywhere in the repo. This is the reading I measured.

A receiver-based rule decides what a computed read hands out from its left-hand side. For an element access that is
the receiver chain; for a pattern key it is the destructured source. That walk has a hole in each of rows 2–4.

- **Row 3: a computed read off a constructor.**
  - The receiver does not decide what the read hands out. Every object, fresh or not, inherits
    `Object.prototype.__defineGetter__` / `__defineSetter__` (Annex B.2.2.2-3).
  - The target of those writers is the `this` of the later call, not the object the writer was read from. So
    `var g = ({})["__define" + "Getter__"]; g.call((1).constructor, "isNaN", f)` writes `isNaN` on `Number`, although
    the receiver `({})` is fresh. Rule (2) keeps folding there: measured, it is unsound.
- **Row 4: a computed binding-element key** (row 5, an assignment pattern, is the same).
  - The destructured value is the declaration's initializer only for a top-level pattern.
  - In a nested element (`var [{[k]: d}] = [Object]`), a for-in / for-of head (`for (var {[k]: d} of [Object])`) or a
    parameter default (`function f({[k]: d} = {}) {} f(Object)`), the outermost source is a fresh literal, yet the
    value actually read is `Object`.
  - A walk that takes the outermost initializer as the receiver calls those fresh. The scratch walk took only a
    top-level declaration's initializer and gave up otherwise, so its rows stop. It is still the walk any receiver
    rule must get right.
- **Row 2: a template key with a substitution.**
  - The key's walk resolves `p` by its bindings. A top-level `var p` is a property of the global object.
  - So `this.p = …`, `globalThis["p"] = …`, `Object.defineProperty(this, "p", …)` and `Object.assign(this, {p: …})`
    rebind it without assigning the name `p`. A key walk that reads only `p`'s declarations and assignments misses
    them.

**Why this must close before B3b-1.** B3b-1 makes `(1).constructor`, `X.prototype.constructor` and `({}).constructor`
reachable. Until then these programs refuse or abort, so the hole is not observable.

**How the chosen rule closes it.**

- It needs no left-hand walk: a computed read is judged by its key alone. That covers rows 3–4.
- For row 2, it drops a name from the key analysis when a reaching write names it as a key. This is the rule the
  fresh-name fixed point already applies to its own names (the "rebound through the global object" stop row).
- The hole programs above become stop rows, so a later receiver refinement cannot reopen the hole without a red test.

### Chosen rule: (3n), a computed key writes nothing when its values are known and name no key writer

**Statement.** A read by a key that is no literal (an element access that is no store target, or a destructuring
pattern's computed key) counts as a mention of every key writer the key may evaluate to. As before for `o["assign"]`,
a mention is a write of every key on any object.

The key's values are a set of strings plus a "number" flag, or unknown. They come from:

- a string or no-substitution template literal;
- a numeric literal (number);
- `+` (concatenation of two string sets; number + number is number; otherwise unknown);
- a template expression with string substitutions;
- the other arithmetic, bitwise and shift operators, unary `-` / `+` / `~`, `++` / `--` (number);
- `?:` (union) and `,` (right side);
- a name (the union over every binding and assignment of that name, by text, as a least fixed point).

Anything else is unknown. The set is capped at 64 strings, beyond which it is unknown. A name is unknown when:

- some binding of it is a parameter, a pattern element, a for-in / for-of head, a catch variable, a function or class
  name, a `var` without initializer, or another assignment target;
- or a write that reaches a realm object names it as a key (`realmWrittenKeys`' `keys`), which is the global-object
  rebinding route.

The arm "writes nothing" when the values are known and contain no `KEY_WRITERS` name. Otherwise it writes every key.

**Why it is sound.** A key writer's value sits only under its own name on a realm object (`Reflect`'s are counted by
`Reflect`'s mention). Anywhere else, it is put there by a route the scan already counts as a write of every key:

- a spelled mention (`[Object.defineProperty]`, `{d: Object.defineProperty}`);
- a reader (`values`, `entries`, `getOwnPropertyDescriptor(s)`);
- or this arm itself with a writer-named or unknown key.

So a read by a key whose values name no writer hands out no writer that a counted write did not already make every
key. Its index or string value may hold one, but only after such a write. A number key is never a writer name.
Getters and Proxy traps that run during the read are program code, which is scanned on its own.

**Why not the others.**

- (1), (2) and (3) each lose the 14 + 43 rows, because the harness itself defeats them.
- (2) is also unsound (inherited `__defineGetter__`).
- (4) closes the same rows as (3n) and measures the same, since a key-value rule already costs nothing. Its use rule
  only helps a `for (k in o) o[k] !== v` shape that no census row needs.
- Per "measure before planning", add the use rule later only when a run shows its yield. It would be a second
  predicate with no measured user.

### Target structure

**`src/ir/realm-member-writes.ts`** (no new src file; it stays in its current compiler-boundaries entry,
`mixed-needs-split` → `frontend-ts`).

- `MemberWrite` gains one variant, a computed read:
  `{ readonly computedKey: ts.Expression }`, beside `{ receiver, key }`.
  - `memberWrites` reports it from one new arm: an element access that is no store target
    (`occurrenceIsWriteTarget`) whose key has no `literalKey`, or a `ComputedPropertyName` of a binding element or an
    assignment pattern's property (`isPatternKey`, taken from `rule-a.patch`; it reuses `occurrenceIsWriteTarget`).
  - The arm sits before the identifier / string arm, in the same `if / else` chain.
- The key domain, private to the module, about 80 lines:
  - `KeyValues` (strings + number, or `undefined` for unknown);
  - `keyValues(expression, names)`, one `switch` on the node kind, reusing `skipOuterExpressions` and `literalKey`
    for the literal case;
  - `nameKeyValues(bindings, rebound)`, the least fixed point over names.
  - No second set of literal predicates: `literalKey` stays the single literal reader.
- `realmWrittenKeys(writes, bindings, createIsBuiltin)` keeps its loop.
  - Once it settles on `keys`, each computed read either names no writer (with `rebound = keys`) or the answer is
    `undefined`.
  - Computed reads add no keys (all or nothing), so the existing fixed point is unchanged and is not re-run.
- Docs to update:
  - `KEY_WRITERS`' doc: names from `getOwnPropertyNames` / `keys` reach a value through a computed read, which is now
    counted (its key is unknown).
  - The module header gains one sentence for the computed read.

**`src/ir/builtin-global-binding.ts`, `bindingFacts`.** One walk, and the duplicate it avoids.

- The key analysis needs each name's bindings and assignments, which `bindingFacts`' visit already enumerates.
- Instead of a second walk, the visit records them once, as `bindings: Map<string, NameBinding[]>`:

  ```ts
  type NameBinding =
    | { readonly fresh: Freshness }           // function / class declaration, named function expression
    | { readonly initializer: ts.Expression }  // var / let / const x = e
    | { readonly assigned: ts.Expression }     // x = e, x op= e, x++ / x-- (the expression whose value x then holds)
    | undefined;                               // any value
  ```

  The last case covers a parameter, a pattern element, a for-in / for-of head, catch, a `var` without initializer,
  a `targetNames` target, and a global alias's member.
- `freshNames` and `taken` are derived from it. A name is fresh when every binding is `fresh`, or an `initializer`
  with a `freshnessOf`. This replaces `declared`, `mayHoldAny`, `created` and `assigned`: the "leave it better" fold.
- `realmWrittenKeys` derives the key values from the same map.
- Semantics of `taken` / `freshNames` are unchanged. The byte-identity gates below hold that.
- `keyValues` evaluates an `assigned` expression as it reads: `x = e` is `e`; `x op= e` is `x op e`; `++` / `--` is a
  number. So the record needs no operator field.
- `foldsBuiltinMember`'s doc:
  - "Not yet seen" loses the computed-key routes.
  - The bullet list gains "a read by a key that is no literal, unless its key's values name no key writer".
  - Code that the runtime-eval provider or a non-literal `Function` runs stays listed (#7503).

**Not touched:** `src/shared/binding-writes.ts` (`isNonReferenceName`, `occurrenceIsWriteTarget` and
`skipOuterExpressions` are reused as they are), the consumers of `foldsBuiltinMember`, and the stores' exact `key`.
Constant-folding a computed **store** key would widen folds and could change bytes; it is a separate change, taken
only when a run shows its yield.

**Size.** `realm-member-writes.ts` grows from 213 to about 300 lines. No function goes near the 300-line function
budget: `keyValues` is about 30 lines and `nameKeyValues` about 25. `bindingFacts` stays about its size: records
replace sets. No budget grant is expected.

### Test changes (`tests/issue-7350-slice1-expando-escape.test.ts`)

**Now** (lead note a): the six `it.fails.each` rows become an ordinary `it.each`:
`"#7628 (open): %s still folds"` asserting today's facts `{pristine: true, fold: true}`. A crash then fails the row
instead of passing it. This ships with the plan's implementation PR's first commit, or in #7549 if the lead prefers.

**When the rule lands:**

- The six rows move into the "stops the fold" table, asserting `{pristine: true, fold: false}`. Their comment block
  states the rule in one sentence.
- New stop rows, the holes above:
  - a fresh receiver's inherited writer (`({})["__define" + "Getter__"]` held, then `.call`);
  - a nested pattern key (`var [{[k]: d}] = [Object]`);
  - a for-of head pattern key;
  - a parameter default's pattern key;
  - a key name rebound through the global object (`this.p = …`, `globalThis["p"] = …`,
    `Object.defineProperty(this, "i", …)`, `Object.assign(this, {i: …})`);
  - a key built by `+=` (`t += "define"; t += "Property"`);
  - a name assigned a writer-name string by concatenation after a numeric init.
- New keep rows, the twins:
  - compareArray's exact shape (`function cmp(a, b) { for (var i = 0; i < a.length; i++) if (!same(b[i], a[i]))
    return false; return true; }`);
  - `var x = a[i]` and `[1][i + 1]` with `var i = 0`;
  - `s += arr[j]` in a `j++` loop;
  - a concatenated key that names no writer (`o["is" + "Finite"]` read, `Number.isNaN` still folds);
  - and one row with the real prelude: `assert.js` + `sta.js` + `Number.isNaN(1)` folds. This pins the harness cost
    directly.
- **Mutation checks.** Each check must fail the rows listed with it:
  - dropping the arm: the six rows and the hole rows;
  - dropping the `rebound` names: the global-object rows;
  - dropping the number arm: compareArray's twin and the prelude row.

### Acceptance

- `check:prepared-bytes` 804 / 804 identical and `prove-emit-identity` 60 / 60 identical. Run each against a `git
  archive` copy of the base.
- The ordinary-pipeline sample (slice 1's 180 files, `assert.js` + `sta.js`, default and standalone) is 360 / 360
  identical.
- Census (`--harness real`) against the base: carriers ≥ 230 and o411 ≥ 84. There must be 0 lost and 0 new crashes,
  and every changed row must be named. The scratch rule changed none.
- The six rows assert fold = false; the twins keep fold = true; the mutation checks fail as listed.
- **Quality.**
  - There is one new arm in `memberWrites`, in its chain.
  - The key domain is module-private, with no second literal reader and no second source walk. `bindingFacts`'
    bindings record replaces its four sets.
  - There is no use-of-result or receiver predicate (no measured user).
  - No `func-budget-allow` / `loc-budget-allow` grant.
  - An adversarial review (fresh context, diff + this plan) finds no duplication between `keyValues` and
    `literalKey` / `freshnessOf` and no narrating comments.
- **Compiler boundaries.** No new src file. `realm-member-writes.ts` and `builtin-global-binding.ts` keep their
  entries. `check-compiler-boundaries` passes with `--base HEAD^1` and `--base origin/main`.
- The gates exit 0: loc, func (also with `LOC_GATE_BASE=<main tip>`), coercion sites, oracle ratchet, dead exports,
  typecheck and import cycles.

### Could not measure

- The census skips negative tests, so these are census passes, not runner verdicts.
- Rule (4)'s carriers run was resumed after an interruption (the census resumes per file); it reads 0 changed rows like (3n).
