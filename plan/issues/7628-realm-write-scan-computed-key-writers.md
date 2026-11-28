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

The naive rule is `RULE=naive` of `plan/samples/7628/candidates.patch`.

## Implementation Plan (2026-11-28, revised after PRV-7628)

Measured on PR #7549's head `b7cfc6257f` (#7350 slice 1 + #7354 O2). `origin/main` was `234cf4402a` (#7556 merged
03:26Z). It does not yet contain slice 1: `realm-member-writes.ts` and the slice 1 test exist only on the PR branch.
#7556 makes a literal `Function(...)` text a program source (`<function:N>.js`); `bindingFacts` walks every program
source, so those texts need no new handling. After main is merged, re-run the acceptance below on that head.

Every number below is reproducible from `plan/samples/7628/` (patches, row probe, equivalence scan, commands).

### Measured candidates (first round, `18be7b93d4`)

Each candidate is the same arm: a read by a key that is no literal (an element access that is no store target, or a
destructuring pattern's computed key). They differ in when that arm writes nothing.
`plan/samples/7628/candidates.patch` switches them by `RULE`. Census `--harness real` on carriers / o411, base
`b7cfc6257f` = 230 / 84.

| rule | the arm writes nothing when … | carriers | o411 |
| --- | --- | ---: | ---: |
| naive | never | 216 | 41 |
| (1) use | its value goes only into `===`, `typeof`, `!`, `void`, a statement or a test | 216 | 41 |
| (2) receiver | its receiver is a fresh value or a fresh name | 216 | 41 |
| (3) const key | its key's values are strings that name no key writer | 216 | 41 |
| (3n) key values | as (3), plus numbers (`i++` is a number) | **230** | **84** |

- (1), (2) and (3) lose the same 14 + 43 rows. The cause is `assert.js` line 171, `assert._isSameValue(b[i], a[i])`:
  the reads are call arguments (defeats 1), `a` and `b` are parameters (defeats 2), and `i` is assigned by `i++`
  (defeats 3). Only a rule that knows `i` is a number keeps the harness folding.
- (2) is also unsound: every object inherits `__defineGetter__`, and the writer writes on the `this` of the later call,
  not on the object it was read from (`var g = ({})["__define" + "Getter__"]; g.call((1).constructor, …)`).
- Destructuring reads its value from the outermost initializer only for a top-level pattern (not
  `var [{[k]: d}] = [Object]`, a for-of head, a parameter default). A key-only rule needs no left-hand walk at all.

### Chosen rule: a computed read writes nothing when its key's values are known and name no writer

**Statement.** A read by a key that is no literal counts as a mention of every writer name the key may evaluate to.
As before for `o["assign"]`, a mention is a write of every key on any object. The writer names are the `KEY_WRITERS`
names and `Reflect` (`WRITER_NAMES`).

**`Reflect` (blocker 1).** Today only an identifier reference `Reflect` counts. `globalThis.Reflect`, `this["Reflect"]`
and `globalThis["Ref" + "lect"]` reach it without one. The fix counts every spelling of `Reflect` (identifier in any
position, string literal), as `KEY_WRITERS` names already are, and makes `Reflect` a writer name in the key domain.

**The key domain** (`src/ir/key-values.ts`, below). A key's values are a set, or unknown (`undefined`). An element is
an exact string, an exact number, `SOME_NUMBER` (any Number or BigInt) or `LONG_STRING` (any string longer than 25).

| expression | values |
| --- | --- |
| string or no-substitution template literal | its cooked `.text` (`"\x64efine"` is `define`) |
| numeric literal | the exact number |
| identifier | the caller's `nameValues` (default: unknown) |
| template with substitutions | head, then each substitution and literal concatenated |
| `a + b`, `x += b` | pairwise: string + string, number + number exact; `SOME_NUMBER` + number = `SOME_NUMBER`; a string or `LONG_STRING` with `SOME_NUMBER` = unknown; `LONG_STRING` with a string or exact number = `LONG_STRING` |
| `-` `*` `/` `%` `**`, shifts, bitwise, their compound forms | exact for two exact numbers (`/ 0` and `% 0` give `SOME_NUMBER`), else `SOME_NUMBER` |
| unary `-` / `+` | exact for an exact number, else `SOME_NUMBER` |
| `~`, `++` / `--` | `SOME_NUMBER` |
| anything else (`?:`, `,`, `=`, `!`, a call, a tagged template, an object) | unknown |

- A compound assignment evaluates only when its left side is an identifier (`1 += 1` is an early error, not 2).
- `?:` and `,` are unknown on purpose: the accessor caller below must not drop a side effect of the key
  (`[f(), "a"]`). The census needs neither (measured below).
- Domain edges (item 8): `"k" + n` and `` `k${n}` `` with `n` a `SOME_NUMBER` are unknown; with an exact number they
  are exact. Mixed sets are allowed (`{"a", SOME_NUMBER}`); only `+` with a string and `SOME_NUMBER` is unknown.

**Bounds (blocker 3).**

- The cap is 64 elements, checked as the pairwise product grows: the first insertion past 64 makes it unknown. So one
  `+` combines at most 64 × 64 = 4,096 pairs.
- Name values are widened when a name stores them: an exact number becomes `SOME_NUMBER`, a string longer than 25
  becomes `LONG_STRING`. `getOwnPropertyDescriptors` is 25 characters, the longest writer name; concatenation only
  grows a string, so `LONG_STRING` is never a writer.
- So a name's value is a set of at most 64 elements from strings of at most 25 characters, `LONG_STRING` and
  `SOME_NUMBER`. Its chain from the empty set is at most 64 insertions, then unknown: height 65 (66 levels).
- The least fixed point over N names takes at most 65·N changing rounds plus one that changes nothing, ≤ 66·N.
- Correction to the review's figure: a `+` of two name values concatenates strings of at most 25 characters; a literal
  operand inside one key expression is exact and as long as its source text, so a `+` there concatenates strings no
  longer than that expression's literal text plus 25 per name it reads. `LONG_STRING` is never materialised.
- Without the cap, `s = s + "x"; s = s + "y"` overflows a `Set` (measured: `RangeError: Set maximum size exceeded`).
  Without the length token, `s = s + "x"` in a loop goes past 64 and stops the fold; with it, it settles at 27
  elements and folds.

**Names (blocker 2).** `bindingFacts` records every binding and assignment of a name, by text (`NameBinding`, below).
A name is known only when it has at least one record and every record is an initializer or an assignment. It is
unknown when:

- it has no record: an undeclared or host global (`Object["define" + suffix]`);
- some record is `any`: a parameter, a pattern element, a for-in / for-of head, a `catch` variable, a `var` without
  initializer, an import (`ImportClause`, `ImportSpecifier`, namespace import, `import x =`), the implicit `arguments`
  of every function that is no arrow function, a destructuring / `delete` / for-in target, a global alias's member
  (`this.p = …`);
- some record is `fresh`: a function or class name (declaration, named function or class expression);
- or a write that reaches a realm object names it as a key (`realmWrittenKeys`' settled `keys`): the global-object
  rebinding route (`globalThis["p"] = …`, `Object.defineProperty(this, "i", …)`, `Object.assign(this, {i: …})`).

The value a record stores: `x = e` stores `e`, through a chain (`x = y = e` stores `e` for both); `x op= e` stores
`x op e`; `x ||= e`, `&&=`, `??=` store `e` (or `x`'s old value, already in the set); `++` / `--` store a number.

**Hoisted values (item 7).** A `var` read before its initializer holds `undefined`, or, for a name the realm already
has as a global property, that property (§16.1.7). The domain leaves this value out. That is sound: such a value
stringifies to text containing `undefined`, `function`, `class` or `[object`, or is a number, no writer name contains
any of these, and no operator of the domain removes text. The same holds for a class-expression name's class inside
its body. Assumption: before the program runs, the global object has only the realm's own properties (standalone). A
JavaScript environment's host globals (`window.name`) are not modelled, as `pristine` already trusts the lib.

**Why it is sound.** A writer's value sits only under its own name on a realm object (`Reflect`'s members behind a
`Reflect` mention). Anywhere else it was put there by a route already counted as a write of every key: a spelled
mention, a reader (`values`, `entries`, `getOwnPropertyDescriptor(s)`), or this arm with a writer-named or unknown
key. A number key is never a writer name. Getters and Proxy traps that run during a read are program code, scanned on
their own. `ToPropertyKey` of an object calls its `toString`: an object is unknown in the domain, and `arguments` is
always `any`.

**Not counted (item 7).** Built-ins that write index keys, `length` or `lastIndex` on an object
(`Array.prototype.push.call(X, v)`, `RegExp.prototype[Symbol.match].call(X, s)`): no folded member has such a name,
and a constructor's `length` is not writable. Code the runtime-eval provider or a non-literal `Function` runs is not
seen (#7503); a literal eval or `Function` text is a program source and is seen.

### Target structure

**New `src/ir/key-values.ts` (blocker 4, the shared evaluator; about 110 lines).**

- Exports `KeyValue`, `KeyValues`, `SOME_NUMBER`, `LONG_STRING`, `keyValues(expression, nameValues?)`,
  `exactKey(values)` (the one exact value as a key string, or `undefined`) and `widen(values)`.
- One `switch`-shaped walk, reusing `skipOuterExpressions`. One pairwise `product` helper with the cap; `+` and the
  arithmetic operators are its two combine functions.
- Compiler boundaries: a new entry, `unmigrated`, `mixed-needs-split`, destination `frontend-ts`, owner
  `7354-prepared-path`, next boundary "moves with `realm-member-writes.ts` under frontend/ts". It reads TypeScript AST
  only and imports `ts-api` and `shared/binding-writes` (`skipOuterExpressions`), like its two callers. No active
  layer can hold it while `binding-writes.ts` is `mixed-needs-split`.

**`src/ir/class-accessor-safety.ts`: the single-value caller.**

- `literalOnlyComputedKeyValue` and `LiteralComputedKeyValue` are deleted (about 55 lines).
- `exactPreparedAccessorExpressionKey(expression)` becomes `exactKey(keyValues(expression))`: no name resolver, so
  names are unknown, and `exactKey` takes only a one-element set of an exact string or number.
- The exact sub-grammar is exactly the old function's: literals, templates, unary `+` / `-`, and `+ - * / % **` over
  exact operands, `/ 0` and `% 0` refused. Every other form is `SOME_NUMBER` or unknown, and both are refused.
- Measured: the old and new function agree on all 4,756,986 expressions of the 53,869 test262 files
  (`plan/samples/7628/accessor-equiv.mts`), 1,213,753 of them defined. The first draft disagreed on 5 (`1 += 1` and
  its siblings in `compound-assignment/*-non-simple.js`); the identifier rule for compound assignments fixed them.

**`src/ir/realm-member-writes.ts`.**

- `MemberWrite` gains one variant, `{ readonly computedKey: ts.Expression }`, beside `{ receiver, key }`.
- `memberWrites` gains one arm, first in its chain: an element access that is no store target
  (`occurrenceIsWriteTarget`) with no `literalKey`, or a `ComputedPropertyName` of a binding element or an assignment
  pattern's property (`isPatternKey`). `super[…]` and `o?.[…]` are element accesses and are covered.
- The `Reflect` clause becomes "an identifier or string literal whose text is `Reflect`", which drops the
  `isNonReferenceName` import.
- `WRITER_NAMES`: `KEY_WRITERS`' names and `Reflect`, one predicate for the mention arm and the key check.
- `NameBinding`, kind-tagged, with a named "any value" variant (item 9):

  ```ts
  export type NameBinding =
    | { readonly kind: "fresh" }                                 // function / class name
    | { readonly kind: "initializer"; readonly value: ts.Expression }
    | { readonly kind: "assigned"; readonly value: ts.Expression } // the stored value, see "Names"
    | { readonly kind: "any" };
  ```

- **Freshness has one owner (item 9): `realmWrittenKeys`.** It derives the fresh names from `bindings` (a name is
  fresh when every record is `fresh` or an initializer with a `freshnessOf`). `freshNames` leaves `bindingFacts`'
  result.
- `nameKeyValues(bindings, rebound)`: the least fixed point, about 25 lines.
- `realmWrittenKeys(writes, bindings, createIsBuiltin)` keeps its loop. Once `keys` settles, each computed read's key
  is evaluated with `nameKeyValues(bindings, keys)`; unknown or a writer name answers `undefined`. Computed reads add
  no keys (all or nothing), so the loop is not re-run.
- Docs: the module header gains one sentence; `KEY_WRITERS`' doc says names from `getOwnPropertyNames` / `keys` reach
  a value through a computed read, now counted (its key is unknown).

**`src/ir/builtin-global-binding.ts`, `bindingFacts`.**

- The visit records `bindings: Map<string, NameBinding[]>` once. It replaces `declared`, `assigned`, `mayHoldAny` and
  `created`. `taken` is the set of recorded names.
- `taken` grows by import names, class-expression names and `arguments`; freshness loses a name that is also imported
  or `arguments`, and gains a class-expression name that has no other binding (the rule named function expressions
  already follow; `taken` guards the global of that name the same way). All are conservative except the last.
  The byte-identity gate inputs have 5 imports (`h`, `twice` ×3, `missing`), no class expression and one `arguments`,
  none a realm global's name (`plan/samples/7628/README.md`), so the gates are expected to stay identical.
- `foldsBuiltinMember`'s doc: "Not yet seen" loses the computed-key routes; the list gains "a read by a key that is no
  literal, unless its key's values are known and name no writer"; eval / `Function` (#7503) stays.

**Not touched:** `src/shared/binding-writes.ts`, the consumers of `foldsBuiltinMember`, and the stores' exact `key`
(constant-folding a computed store key widens folds; separate, only with a measured yield).

**Size.** `key-values.ts` about 110 lines; `realm-member-writes.ts` from 213 to about 300; `class-accessor-safety.ts`
−55; `bindingFacts` about its size. No function near the budget; no grant expected.

### The other two evaluators (blocker 4)

| evaluator | where | grammar | names | fold into `keyValues`? |
| --- | --- | --- | --- | --- |
| `literalOnlyComputedKeyValue` | `src/ir/class-accessor-safety.ts` | exact literals, templates, arithmetic | none | **yes, in #7628** (measured identical) |
| `foldConstantString` | `src/codegen/class-static-metadata.ts` | string literals and `+` | none | follow-up |
| `staticConstStringValues` | `src/codegen/analysis/static-string-values.ts` | literals, `const` names by checker symbol, `const` array elements, `.split` | checker symbols | follow-up |

- Both follow-ups are legacy codegen (`backend-wasmgc` destination), outside `src/ir/`, and must keep gc bytes
  identical.
  - `foldConstantString` is the string-only subset: `exactKey` restricted to a string answers it, but `"a" + 1` would
    change from unknown to `"a1"`, a behaviour change to measure.
  - `staticConstStringValues` resolves names by checker symbol and reads array elements and `.split`, which the key
    domain has no use for.
- Record as one follow-up issue, "fold the codegen constant-string evaluators into `key-values.ts`"; its id must come
  from the lead (`claim-issue.mjs --allocate`).

### Test changes (`tests/issue-7350-slice1-expando-escape.test.ts`)

**Now** (lead note a): the six `it.fails.each` rows become an ordinary `it.each`, `"#7628 (open): %s still folds"`,
asserting today's `{pristine: true, fold: true}`, so a crash fails the row. It ships in the implementation PR's
first commit, or in #7549 if the lead prefers.

**When the rule lands**, the rows below, all measured in `plan/samples/7628/rows2.mts` (46 rows). On the base
`b7cfc6257f` all 37 stop rows fold; on the v2 patch all 46 rows match.

- Stop rows (fold false; ≈ is `(1).constructor, "isNaN", {value: 1}`). No row spells a writer name as a literal,
  which would stop it by the mention arm instead of the rule:
  - the six #7628 rows;
  - `Reflect`: `globalThis.Reflect.set(…)`, `this["Reflect"].set(…)`, `globalThis["Ref" + "lect"].set(…)`;
  - names: `import { q as p } from "./m.js"; Object["define" + p](≈)`; the same with `var p = "Xyz"` in `m.js`
    (a by-text collision); `Object["define" + suffix](≈)` with `suffix` undeclared; a top-level
    `var arguments = "Xyz"` beside a function whose `arguments.toString` returns `"define" + "Property"`;
  - holes: a fresh receiver's inherited writer; a nested pattern key; a for-of head pattern key; a parameter default's
    pattern key; `this.p = …`, `globalThis["p"] = …`, `Object.defineProperty(this, "i", …)`,
    `Object.assign(this, {i: …})`; `t += "define"; t += "Property"`; `i = "define" + "Property"` after `var i = 0`;
  - item 10: `super["define" + "Property"]` in `class C extends Object`; `Object?.["define" + "Property"]`; a for-in
    head that is no declaration; `catch (p)`; `a = b = "define" + "Property"`; `(c ? "define" : "get") + "Property"`;
  - item 8: `p ||= "define" + "Property"`; `"\x64efine" + "Property"` (cooked text);
  - cost rows, stopping on purpose: `s = s + "x"; s = s + "y"` (past the cap); `p + p + p` over nine values of `p`
    (cap during the product); `({})[c ? "a" : "b"]` (`?:` unknown); `"k" + n` and `` `k${n}` `` after `n++`
    (string with `SOME_NUMBER`); compareArray's shape plus `function g(i) {}` anywhere (item 6).
- Keep rows (fold true): compareArray's exact shape; `a[i]` and `[1][i + 1]` with `var i = 0`; `s += arr[j]` in a
  `j++` loop; `({})["is" + "Finite"]`; `a = b = "is" + "Finite"`; `s = s + "x"` a hundred times (`LONG_STRING`); a
  200-term literal concatenation; `({})["define" + p]; var p = "X";` (hoisted); and the real prelude, `assert.js` +
  `sta.js` + `Number.isNaN(1)`.
- **Mutation checks**, each measured on the v2 patch with the rows it fails:

  | mutation | rows that fail |
  | --- | --- |
  | drop the computed-read arm | every stop row but `globalThis.Reflect` and `this["Reflect"]` (35 of 37) |
  | record no import or `arguments` binding | import + by-text var, `arguments` |
  | a name with no record holds no value | undeclared global |
  | both of the last two | the import row too |
  | drop the rebound names | `globalThis["p"]`, `defineProperty(this)`, `assign(this)` (`this.p` stops by its `any` record) |
  | `++` / `--` is no number | compareArray, `s += arr[j]`, the real prelude |
  | `Reflect` counted only as a reference | `globalThis.Reflect`, `this["Reflect"]` |
  | `Reflect` no writer name in the key domain | `"Ref" + "lect"` |
  | no `LONG_STRING` | the long chain |
  | no cap | the two-letter growth (`RangeError`), the product row |

### Acceptance

- `check:prepared-bytes` 804 / 804 and `prove-emit-identity` 60 / 60 identical, each against a `git archive` copy of
  the base.
- The ordinary-pipeline sample (slice 1's 180 files, `assert.js` + `sta.js`, default and standalone) 360 / 360
  identical.
- Census (`--harness real`) against the base: carriers ≥ 230, o411 ≥ 84, 0 lost, 0 new crashes, every changed row
  named. The v2 scratch: carriers 230 / 230, o411 84 / 84, 0 changed rows of 1,977 and of 411, 0 lost, 0 new crashes (2026-11-28, about 12 min for both lists on 4 cores; the same as the first round's (3n), so dropping `?:` and `,` costs nothing).
- The equivalence scan reads 0 mismatches.
- The rows and mutation checks above hold.
- **Quality.**
  - One evaluator for key values (`key-values.ts`); `literalOnlyComputedKeyValue` is gone; no second literal reader.
  - One new arm in `memberWrites`, in its chain; one source walk (`bindingFacts`), whose record replaces its four sets.
  - Freshness is derived in one place (`realmWrittenKeys`).
  - No use-of-result or receiver predicate; no `?:` / `,` arm (no measured user).
  - No `func-budget-allow` / `loc-budget-allow` grant.
  - An adversarial review (fresh context, diff + this plan) finds no duplication between `keyValues`, `literalKey` and
    `freshnessOf`, and no narrating comments.
- **Compiler boundaries.** One new entry (`key-values.ts`); the others keep theirs. `check-compiler-boundaries`
  passes with `--base HEAD^1` and `--base origin/main`.
- The gates exit 0: loc, func (also with `LOC_GATE_BASE=<main tip>`), coercion sites, oracle ratchet, dead exports,
  typecheck and import cycles.

### Could not measure

- The census skips negative tests, so these are census passes, not runner verdicts.
- **Whole program by text (item 6).** A name's values are the union over every binding of that text in every source,
  so `function g(i) {}` anywhere makes `i` unknown, and compareArray's `b[i]` then writes every key: no writable
  member folds in that program. Pinned by the keep / stop pair above. On the two census lists it costs nothing (0
  lost); beyond them it is not measured.
- The byte gates were not run on the scratch patch; the binding-record change to `taken` is predicted neutral from
  their inputs (see Target structure).
- Found, not in scope: `pristine` does not see the global binding of a realm name rebound through the global object.
  On the base, `Object.defineProperty(this, "Number", {value: {isNaN: f}})` and
  `Object.assign(globalThis, {Number: …})` leave `Number` pristine and `Number.isNaN` folding
  (`this["Num" + "ber"] = …` stops only because a computed store key writes every key). The fix is the rebound rule
  above applied to `pristine`: a realm name some reaching write names as a key is not pristine. It changes `pristine`
  for every consumer, so it is its own issue (id from the lead), and must close before B3b-1 like this one.

## Changelog after PRV-7628

| item | resolution |
| --- | --- |
| 1 Reflect spellings | Every spelling of `Reflect` counts (identifier anywhere, string literal), and `Reflect` is a writer name in the key domain. 3 stop rows; 2 mutations, each failing its rows. |
| 2 name with no record | No record ⇒ unknown. Imports, `import x =` and every non-arrow function's `arguments` are recorded `any`; class-expression names `fresh`. 4 stop rows (import, import + by-text var, undeclared, `arguments`); mutations fail them as listed. |
| 3 string length | Name values widen strings over 25 characters (`getOwnPropertyDescriptors`, verified 25) to `LONG_STRING`, numbers to `SOME_NUMBER`; the cap of 64 is checked during the product. Height 65 (66 levels) per name, ≤ 66·N rounds, ≤ 4,096 pairs per `+`. Corrected: only name-held strings are ≤ 25 characters; a literal operand is as long as its source. Keep rows: a 100-step chain and a 200-term literal; mutations show the cap (`RangeError`) and the token are load-bearing. |
| 4 duplication | One evaluator, new `src/ir/key-values.ts`. `class-accessor-safety.ts` uses it with no names and `exactKey`; its own evaluator is deleted, measured identical on 4.76 M expressions. `?:` and `,` stay out (they would let the accessor drop a key's side effect). `foldConstantString` and `staticConstStringValues` are legacy codegen: one follow-up, id from the lead. |
| 5 reproducibility | `plan/samples/7628/`: both patches, the row probe, the equivalence scan, the README with the census commands. |
| 6 by-text fragility | Keep / stop pair (compareArray, and the same with `function g(i) {}`); listed under "Could not measure". |
| 7 stated cases | Hoisted `var` (`undefined` or the realm's property; left out soundly; a keep row); index / `length` / `lastIndex` writers; eval / `Function` (#7503). |
| 8 domain edges | Mixed `+` and a template with `SOME_NUMBER` are unknown (exact numbers stay exact); `x = y = e` stores `e`; `||=` / `&&=` / `??=` store `e`; cooked `.text`. Rows for each. |
| 9 one owner | Freshness is derived in `realmWrittenKeys` from `bindings`; `NameBinding` is kind-tagged with `{ kind: "any" }`. |
| 10 rows | `super[…]`, `Object?.[…]`, a for-in head that is no declaration, `catch (p)`, a chained assignment (stop and keep), a ternary split (stop, and a cost row). |
| re-measure | Census on the v2 patch: carriers 230, o411 84, 0 changed rows on either list, 0 crashes. |
