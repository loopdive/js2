---
id: 7628
title: "Computed-key and reflective member writers are unseen by the realm write scan"
status: done
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
completed: 2026-11-28
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

## Implementation Plan (2026-11-28, revised after PRV-7628 rounds 1 and 2)

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

**Names (blocker 2; PRV-7628 round 2, N1 and N2).** `bindingFacts` records every binding and assignment of a name,
by text (`NameBinding`, below). A name is known only when it has at least one record and every record is an
initializer or an assignment. It is unknown when:

- it has no record: an undeclared or host global (`Object["define" + suffix]`);
- some record is `any`;
- some record is `fresh`: a function or class name (declaration, named function or class expression);
- or a write that reaches a realm object names it as a key (`realmWrittenKeys`' settled `keys`): the global-object
  rebinding route (`globalThis["p"] = …`, `Object.defineProperty(this, "i", …)`, `Object.assign(this, {i: …})`).

**The declaration rule is inverted (N2): `any` is the default.** Every identifier that is the `name` of its parent
records one binding, unless the parent is a kind whose name binds no value. So a declaration kind the record does not
model is `any` without being listed, and "every binding is recorded" holds by construction:

| the name of … | records |
| --- | --- |
| a function or class (declaration or expression) | `fresh` |
| a `var` / `let` / `const` with an initializer, outside a for-in / for-of head | `initializer` |
| a member key or a type (`BINDS_NO_VALUE`: property assignment, shorthand, property / method / accessor declaration, property / method signature, enum member, interface, type alias, type parameter, property access name, export specifier, `export * as`, meta property, JSX attribute, import attribute) | nothing |
| **anything else**: a parameter, a pattern element, a `catch` variable, a variable without initializer, **any variable of a for-in / for-of head (N1)**, an import (`import x`, `{ x }`, `* as x`, `import x =`), **an enum, a namespace / module, `export as namespace`**, and every kind not named here | `any` |

- Beside the declarations: the implicit `arguments` of every function that is no arrow function (`any`); an
  assignment or `++` / `--` of an identifier (`assigned`, its stored value); any other target of an assignment,
  `delete` or a for-in / for-of head that is no declaration (`any` for every name `targetNames` finds, a global
  alias's member `this.p = …` included).
- **N1, the Annex B for-in initializer.** `for (var p = "Xyz" in {Property: 0})` assigns every enumerated key to `p`
  after the initializer. A variable of a for-in or for-of head is `any`, with or without an initializer.
- **N2, TS declarations.** `namespace p {…}` and `enum q {…}` bind an object whose `toString` the program can define
  (`namespace p { export function toString() {…} }`, `(q as any).toString = …`), so `"define" + p` is any text. They
  are `any` by the default. `export =` binds no name in its module: its value reaches another module only through an
  import, which is `any`.
- The `BINDS_NO_VALUE` list only ever loses precision when it misses a kind (that name becomes `any`), never
  soundness. Omitting a value-binding kind from it is the only unsound edit, and the CTL mutation below shows the list
  is what keeps a type name from blocking a fold.
- `taken` is the set of recorded names. Besides the imports, class-expression names and `arguments` already planned,
  it gains enum, namespace and `export as namespace` names, all conservative. The byte-identity gate inputs have none
  of them and no loop-head initializer (one `ExportAssignment`, `export default u`, which binds no name;
  `plan/samples/7628/scan-fixture.mts`).
- Freshness follows: on the base `for (var o = {} in X)` made `o` a fresh name; it is now `any`. Conservative only:
  for-in assigns strings, whose stores reach no object.

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
- Compiler boundaries: a new entry. It reads TypeScript AST only and imports `ts-api` and `shared/binding-writes`
  (`skipOuterExpressions`), like its two callers. No active layer can hold it while `binding-writes.ts` is
  `mixed-needs-split`.
- **Boundary debt (Q1).** `class-accessor-safety.ts` has destination `ir-core`, and `ir-core` may not import
  `frontend-ts`. Its new import of `key-values.ts` is allowed today only because both files are
  `mixed-needs-split`. The debt is written into both entries' `nextBoundary`, so whoever moves either file sees it.
  The planned `scripts/compiler-boundaries.json` entries:

  ```json
  {
    "path": "src/ir/key-values.ts",
    "state": "unmigrated",
    "layer": "mixed-needs-split",
    "destination": "frontend-ts",
    "owner": "7354-prepared-path",
    "nextBoundary": "One evaluator of a key expression's values (#7628); moves with realm-member-writes.ts under frontend/ts. Debt: class-accessor-safety.ts (destination ir-core) imports it for exactPreparedAccessorExpressionKey; ir-core may not import frontend-ts, so that caller's key reading moves to the frontend with it."
  },
  {
    "path": "src/ir/class-accessor-safety.ts",
    "state": "unmigrated",
    "layer": "mixed-needs-split",
    "destination": "ir-core",
    "owner": "3518-coordinator",
    "nextBoundary": "Separate pure IR contracts from frontend inventory and physical/backend dependencies. Debt (#7628): exactPreparedAccessorExpressionKey imports key-values.ts (destination frontend-ts); it leaves ir-core with the frontend half, and ir-core receives the exact key as a string."
  }
  ```

  The `class-accessor-safety.ts` entry changes only its `nextBoundary`; its owner, layer and destination stay.

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
- `nameKeyValues(bindings, rebound)`: the least fixed point, by a dependency-indexed worklist (item 5, the lead's
  choice; about 35 lines, measured in `v3.patch`):
  - **Candidates.** A name not in `rebound` whose every record is an `initializer` or `assigned` record; its stored
    values are collected once, narrowed on `kind`. Every other name answers unknown. Each candidate starts at ∅.
  - **Queue.** An insertion-ordered set, initially every candidate. A name in the queue is not added again.
  - **Evaluating `n`.** The union of `widen(keyValues(v, lookup))` over `n`'s stored values, with the cap; the first
    unknown or the 65th element makes `n` unknown and stops the loop over its values. `lookup(m)` answers `m`'s
    current set and adds `n` to `readers(m)`.
  - **On growth.** When `n`'s set changes (it gains an element or becomes unknown), every name in `readers(n)` is
    queued again: exactly the candidates one of whose stored values consults `n`. Names that never read `n` are not
    re-evaluated. A self-reader (`s = s + "x"`, `i++`) re-queues itself.
  - **Why dynamic readers.** `readers` is filled by the evaluation itself, so no second walk duplicates
    `keyValues`' traversal. An evaluation consults every identifier it needs; it skips one only where the answer does
    not depend on it (`~x` is a number, a non-arithmetic operator is unknown before its operands), or after `n` has
    become unknown, which is final.
  - **Bound.** A set only grows (the evaluation is monotone in the environment), so each name changes at most 65
    times. Each change queues at most `|readers(n)|` names. Evaluations ≤ N + 65·E, where N is the number of
    candidates and E the number of (reader, read name) pairs, at most the identifier occurrences in stored values.
    Each evaluation costs at most 4,096 pairs per `+` it performs. The round-robin of `v2.patch` was ≤ 66·N rounds of N
    evaluations each (66·N²).
  - **Mutation.** Not re-queueing readers fails the two self-dependent rows (two-letter growth, `t += …`).
- `realmWrittenKeys(writes, bindings, createIsBuiltin)` keeps its loop. Once `keys` settles, each computed read's key
  is evaluated with `nameKeyValues(bindings, keys)`; unknown or a writer name answers `undefined`. Computed reads add
  no keys (all or nothing), so the loop is not re-run.
- Docs: the module header gains one sentence; `KEY_WRITERS`' doc says names from `getOwnPropertyNames` / `keys` reach
  a value through a computed read, now counted (its key is unknown).

**`src/ir/builtin-global-binding.ts`, `bindingFacts`.**

- The visit records `bindings: Map<string, NameBinding[]>` once. It replaces `declared`, `assigned`, `mayHoldAny`,
  `created` and `freshNames`; `bindingFacts` returns `{ bindings, escaped, writes, createCallees }`, and `pristine`
  reads `bindings.has` (`taken` is the set of recorded names). `boundNames` goes: pattern names are found as the
  `name` of their binding element.
- Helpers beside it, one concern each (`v3.patch`):
  - `declaredBinding(name)`: the table under "Names" (`BINDS_NO_VALUE`, `FRESH`, `ANY`);
  - `isLoopHeadVariable(declaration)`: N1;
  - `assignedValue(assignment)`: the stored value of `=` (through a chain), `||=` / `&&=` / `??=`, and the other
    compound forms.
- The escape check (`escaped`) is unchanged and independent of the binding record: a declared name that
  `isNonReferenceName` does not cover (an import, an enum) counts as escaping exactly as on the base.
- `taken` grows by import names, class-expression names, `arguments`, and (round 2) enum, namespace and
  `export as namespace` names; freshness loses a name that is also imported, `arguments` or a loop-head variable, and
  gains a class-expression name that has no other binding (the rule named function expressions already follow;
  `taken` guards the global of that name the same way). All are conservative except the last (item 7, accepted).
  The byte-identity gate inputs have 5 imports (`h`, `twice` ×3, `missing`), no class expression, one `arguments`, no
  enum or namespace and no loop-head initializer, none a realm global's name (`plan/samples/7628/README.md`), so the
  gates are expected to stay identical.
- `foldsBuiltinMember`'s doc: "Not yet seen" loses the computed-key routes; the list gains "a read by a key that is no
  literal, unless its key's values are known and name no writer"; eval / `Function` (#7503) stays.

**Not touched:** `src/shared/binding-writes.ts`, the consumers of `foldsBuiltinMember`, and the stores' exact `key`
(constant-folding a computed store key widens folds; separate, only with a measured yield).

**Size** (measured on `v3.patch`, scratch formatting). `key-values.ts` 152 lines; `realm-member-writes.ts` from 213 to
302; `builtin-global-binding.ts` from 244 to 306 (the `declaredBinding` table and its two helpers, about 70 lines;
`bindingFacts` shrinks to about 45); `class-accessor-safety.ts` −55. Every file stays far under 1,500 lines and every
function under 300; no grant expected.

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

**When the rule lands**, the rows below, all measured in `plan/samples/7628/rows3.mts` (56 rows: 43 stop, 13 keep).
On the base `b7cfc6257f` all 43 stop rows fold; on `v2.patch` 4 rows differ (the two N1 and the two N2 rows below);
on `v3.patch` all 56 rows match.

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
    (string with `SOME_NUMBER`); compareArray's shape plus `function g(i) {}` anywhere (item 6);
  - round 2, N1: `for (var p = "Xyz" in {Property: 0}) Object["define" + p](≈)`; the computed-key variant
    `for (var k = "Xyz" in {["define" + "Property"]: 0}) Object[k](≈)`; `for (var k of ["define" + "Property"])`
    (stopped on v2 already, kept as the for-of guard);
  - round 2, N2 (sources `.ts`): `namespace p { export function toString() { return "Property"; } }` with
    `(Object as any)["define" + p](≈)` and `var p = "Xyz"`; `enum q { A }` with
    `(q as any).toString = function () { return "Property"; }`, `(Object as any)["define" + q](≈)` and `var q = "Xyz"`;
    `import p = require("./m")` with `export = { toString() { return "Property"; } }; var p = "Xyz";` in `m.ts`.
- Keep rows (fold true): compareArray's exact shape; `a[i]` and `[1][i + 1]` with `var i = 0`; `s += arr[j]` in a
  `j++` loop; `({})["is" + "Finite"]`; `a = b = "is" + "Finite"`; `s = s + "x"` a hundred times (`LONG_STRING`); a
  200-term literal concatenation; `({})["define" + p]; var p = "X";` (hoisted); and the real prelude, `assert.js` +
  `sta.js` + `Number.isNaN(1)`.
- CTL rows (keep; round 2), so the N1 / N2 stops are the declaration's doing and not the program's:
  `for (var p = "Xyz"; false; ) Object["define" + p](≈)` (an initializer outside a loop head still stores);
  `var p = "Xyz"; (Object as any)["define" + p](≈)` in a `.ts` source; `interface p {…}` and `type q = …` beside
  `var p = "Xyz", q = "Abc"` (type names record nothing); `enum E { A }` beside `var p = "Xyz"` (an enum blocks only
  its own name).
- **Mutation checks**, measured on `v2.patch` (round 1) and re-run on `v3.patch` where `v3` changed the code under
  them; `plan/samples/7628/mutate3.py` applies each to a v3 tree and lists the rows it fails:

  | mutation | rows that fail |
  | --- | --- |
  | drop the computed-read arm (`RULE=base`, v3) | every stop row but `globalThis.Reflect` and `this["Reflect"]` (41 of 43) |
  | N1: a loop-head variable stores its initializer (v3) | the two N1 for-in rows |
  | N2: `EnumDeclaration` in `BINDS_NO_VALUE` (v3) | the enum row |
  | N2: `ModuleDeclaration` in `BINDS_NO_VALUE` (v3) | the namespace row |
  | N2: `ImportEqualsDeclaration` in `BINDS_NO_VALUE` (v3) | the `import p = require` row |
  | CTL: interface and type alias names record `any` (v3) | the interface + type CTL row |
  | worklist: a change re-queues no reader (v3) | two-letter growth, `t += …` |
  | every import kind in `BINDS_NO_VALUE` (v3) | import + by-text var, `import =` + by-text var |
  | no implicit `arguments` (v3) | `arguments` |
  | a name with no record holds no value (v3) | undeclared global |
  | both of the last two (v3: imports and no record) | the two import rows, `import =` + by-text var, undeclared global |
  | drop the rebound names (v3) | `globalThis["p"]`, `defineProperty(this)`, `assign(this)` (`this.p` stops by its `any` record) |
  | postfix `++` / `--` is no number (v3) | compareArray, `s += arr[j]`, the real prelude |
  | `Reflect` counted only as a reference (v2) | `globalThis.Reflect`, `this["Reflect"]` |
  | `Reflect` no writer name in the key domain (v2) | `"Ref" + "lect"` |
  | no `LONG_STRING` (v2) | the long chain |
  | no cap (v2) | the two-letter growth (`RangeError`), the product row |

  The four rows marked v2 test `key-values.ts` and the `memberWrites` arm, which `v3.patch` leaves as `v2.patch` had
  them.

### Acceptance

- `check:prepared-bytes` 804 / 804 and `prove-emit-identity` 60 / 60 identical, each against a `git archive` copy of
  the base.
- The ordinary-pipeline sample (slice 1's 180 files, `assert.js` + `sta.js`, default and standalone) 360 / 360
  identical.
- Census (`--harness real`) against the base: carriers ≥ 230, o411 ≥ 84, 0 lost, 0 new crashes, every changed row
  named. The v2 scratch: carriers 230 / 230, o411 84 / 84, 0 changed rows of 1,977 and of 411, 0 lost, 0 new crashes (2026-11-28, about 12 min for both lists on 4 cores; the same as the first round's (3n), so dropping `?:` and `,` costs nothing). The v3 scratch (round 2: `any` by default, loop-head variables `any`, `taken` from the record): the same, carriers 230 / 230, o411 84 / 84, 0 changed rows, 0 lost, 0 new crashes (2026-11-28).
- The equivalence scan reads 0 mismatches.
- The rows and mutation checks above hold.
- **Quality.**
  - One evaluator for key values (`key-values.ts`); `literalOnlyComputedKeyValue` is gone; no second literal reader.
  - One new arm in `memberWrites`, in its chain; one source walk (`bindingFacts`), whose record replaces its four sets.
  - The binding record is total by construction: one `declaredBinding` decides every declared name, `any` by
    default; there is no positive list of declaration kinds that record `any`.
  - Freshness is derived in one place (`realmWrittenKeys`).
  - `nameKeyValues` is the dependency-indexed worklist above, not a round-robin over every name.
  - No use-of-result or receiver predicate; no `?:` / `,` arm (no measured user).
  - No `func-budget-allow` / `loc-budget-allow` grant.
  - An adversarial review (fresh context, diff + this plan) finds no duplication between `keyValues`, `literalKey` and
    `freshnessOf`, and no narrating comments.
  - **Scratch that must not ship** (item 6; all present in `v2.patch` / `v3.patch`, none in the PR):
    - the `process.env.RULE` switch in `realmWrittenKeys`;
    - every "SCRATCH v2" / "SCRATCH v3" comment;
    - the `(b as { value: ts.Expression })` cast (`v2.patch`); narrow on `kind` instead, as `v3.patch` does;
    - `declared`, `assigned`, `mayHoldAny`, `created` and `freshNames` beside `bindings` (`v2.patch` kept them;
      `v3.patch` drops them).
- **Compiler boundaries.** One new entry (`key-values.ts`) and one changed `nextBoundary`
  (`class-accessor-safety.ts`), both as written under "Target structure", recording the ir-core → frontend-ts debt.
  The others keep theirs. `check-compiler-boundaries` passes with `--base HEAD^1` and `--base origin/main`.
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

## Changelog after PRV-7628 round 2

Review of `e7ff362d7f`. Measured on `plan/samples/7628/v3.patch` (base `b7cfc6257f`), rows in `rows3.mts`, mutations
in `mutate3.py`.

| item | resolution |
| --- | --- |
| N1 Annex B for-in initializer | A variable of a for-in / for-of head is `any`, with or without an initializer (`isLoopHeadVariable`). 2 stop rows (`for (var p = "Xyz" in {Property: 0})`, the computed-key variant) fold on base and v2 and stop on v3; a for-of guard row; a CTL row (`for (var p = "Xyz"; …;)` keeps). The mutation "a loop-head variable stores its initializer" fails exactly the 2 rows. |
| N2 TS declarations | The rule is inverted: every declared name records `any` unless it is a function or class (`fresh`), a variable with an initializer outside a loop head, or a kind whose name binds no value (`BINDS_NO_VALUE`: member keys, types, export names). Enum, namespace / module, `export as namespace` and any unmodelled kind are `any` without being listed; `export =` binds no name and reaches a module only through an import (`any`). Stop rows: namespace, enum, `import p = require` with a by-text `var p`; the namespace and enum rows fold on base and v2. One mutation per kind (`EnumDeclaration` / `ModuleDeclaration` / `ImportEqualsDeclaration` added to `BINDS_NO_VALUE`), each failing its row. CTL rows: a `.ts` source with only `var p`, `interface p` + `type q`, an enum of another name; the mutation "types record `any`" fails the interface + type row, so the exclusion list is load-bearing for precision. |
| Q1 boundaries | Debt recorded: `class-accessor-safety.ts` (destination `ir-core`) imports `key-values.ts` (destination `frontend-ts`). Both planned `compiler-boundaries.json` entries are written out, each naming the debt in its `nextBoundary`. |
| Q2 accessor behaviour | Unchanged: `key-values.ts` and `class-accessor-safety.ts` are byte-identical between `v2.patch` and `v3.patch` (only the scratch tag in one comment differs), so the 4,756,986-expression equivalence stands. |
| 5 `nameKeyValues` | Dependency-indexed worklist: readers are recorded by the lookup during evaluation; a change of `n` re-queues exactly `readers(n)`. Evaluations ≤ N + 65·E (E = reader / read-name pairs), against 66·N² for the round-robin. The mutation "re-queue no reader" fails the two self-dependent rows. |
| 6 must not ship | Listed under Acceptance → Quality: the `RULE` switch, the SCRATCH comments, the `(b as {value})` cast (v3 narrows on `kind`), and the old sets beside `bindings` (v3 drops `declared`, `assigned`, `mayHoldAny`, `created`, `freshNames` and `boundNames`). |
| 7 class-expression freshness | Kept as planned: a class-expression name is `fresh` (accepted widening). |
| re-measure | Rows: base 43 / 56 differ, v2 4 / 56, v3 0 / 56. Census on v3: carriers 230, o411 84, 0 changed rows, 0 lost, 0 new crashes, so the broader `any` rule costs no yield on either list. Gate inputs hold no enum, namespace or loop-head initializer (`scan-fixture.mts`). |

## Implementation result (2026-11-28)

Implemented on `claude/7628-realm-write-scan`, base `8af55d2f4d` (the approved plan merged with `origin/main`
`e17578f79b`, which holds #7350 slice 1). `v3.patch` applied cleanly (the four files were unchanged since
`b7cfc6257f`); the shipped code is `v3.patch` with the scratch removed and these structural changes:

- `src/ir/key-values.ts` (169 lines): the evaluator is split into `keyValues`, `unaryValues` and `binaryValues`;
  `SOME_NUMBER`, `LONG_STRING`, the cap and the writer-name length are module-private; a capped `union` is exported
  so `nameKeyValues` does not see the cap. Exports: `KeyValue`, `KeyValues`, `keyValues`, `exactKey`, `widen`, `union`.
- `src/ir/realm-member-writes.ts`: `MemberWrite = MemberStore | { computedKey }`; the arm is `computedReadKey`
  (with `isPatternKey`), first in `memberWrites`' chain; `isWriterName` (`KEY_WRITERS` and `Reflect`) is the one
  predicate of the mention arm and of the key check; `nameKeyValues` is the dependency-indexed worklist over
  `StoredName` candidates (no non-null assertion); `computedReadsNameNoWriter` is the final check; `freshNames`
  derives freshness from `bindings`. `Freshness` / `freshnessOf` are no longer exported (no outside user).
- `src/ir/builtin-global-binding.ts`: `bindings` is the single record (`declared`, `assigned`, `mayHoldAny`,
  `created`, `freshNames`, `boundNames` gone; `pristine` reads `bindings.has`). The casts are gone:
  `"name" in declaration && declaration.name === name` and `"body" in node && node.body`. `BINDS_NO_VALUE`'s doc
  states the soundness invariant and names the rows that guard it.
- `src/ir/class-accessor-safety.ts`: `literalOnlyComputedKeyValue` / `LiteralComputedKeyValue` deleted;
  `exactPreparedAccessorExpressionKey` is `exactKey(keyValues(expression))`.
- `scripts/compiler-boundaries.json`: the new `key-values.ts` entry and the `class-accessor-safety.ts` `nextBoundary`,
  as written under "Target structure".

Deviation from the domain table: shifts and bitwise operators give `SOME_NUMBER` even for two exact numbers (as in
`v3.patch`, the measured code). Making them exact would change the accessor key (`[1 << 2]`), which the equivalence
below pins to the old reader.

**Measured** (base `8af55d2f4d`, a `git archive` copy in `.tmp/`, vs head):

- `prepared-byte-identity.mts`: 804 / 804, diff empty (744 bytes, 59 refused, 1 threw on both).
- `prove-emit-identity`: 60 / 60 identical.
- Ordinary pipeline, slice 1's 180 files × default and standalone, `assert.js` + `sta.js`: 360 / 360 identical
  (339 bytes, 21 CE on both).
- Census `--harness real`: carriers 819 → 819 of 1,977, o411 118 → 118 of 411; 0 gained, 0 lost, 0 new crashes,
  0 changed rows on either list. (The pass counts are above the plan's 230 / 84 because main moved since
  `b7cfc6257f`.)
- Accessor equivalence (`accessor-equiv.mts`, base reader vs shipped `exactKey(keyValues(e))`): 53,869 files,
  4,756,986 expressions, 1,213,753 defined, 0 mismatches.
- Rows: `rows3.mts` 0 / 56 differ on head, 43 / 56 on base. In the test, 56 #7628 rows (the six former `it.fails`
  rows, 37 stop rows, 12 keep / CTL rows, the real-prelude row).
- Mutations (each applied to the shipped code, the #7628 rows run, then restored):

  | mutation | rows that fail |
  | --- | --- |
  | drop the computed-read check | 41 of 43 stop rows (all but `globalThis.Reflect`, `this["Reflect"]`) |
  | N1: a loop-head variable stores its initializer | the two for-in initializer rows |
  | N2: `EnumDeclaration` / `ModuleDeclaration` / `ImportEqualsDeclaration` in `BINDS_NO_VALUE` | the enum / namespace / `import =` row, one each |
  | CTL: interface and type alias record `any` | the interface + type alias CTL row |
  | worklist: a change re-queues no reader | past the cap (two-letter growth), the compound assignment |
  | every import kind in `BINDS_NO_VALUE` | import + by-text var, `import =` + by-text var |
  | no implicit `arguments` | `arguments` |
  | a name with no record holds no value | undeclared name |
  | both of the last two | the two import rows, `import =` + by-text var, undeclared name |
  | drop the rebound names | `globalThis["p"]`, `defineProperty(this)`, `assign(this)` |
  | postfix `++` / `--` is no number | compareArray, the loop sum, the real prelude |
  | `Reflect` counted only as a reference | `globalThis.Reflect`, `this["Reflect"]` |
  | `Reflect` no writer name in the key domain | `"Ref" + "lect"` |
  | no `LONG_STRING` | the long chain |
  | no cap | the product row; the two-letter growth row runs the worker out of memory |

- Tests: 38 files (slice 1, B3a, B3b-0, the 7 B3a pin files, O1 ×2, O2 ×2, O2b, 3518 closure signatures, 3783, G1 ×4,
  7564, 7118, #7363 ×6, #7609 ×3, and the `class-accessor-safety` users' tests: 3522 ×3, 3520 ×2, 5318 r4, 3529):
  1,367 pass, 16 fail. The same 16 fail on the base copy (3520 unit identity 5, 5318 r4 4, 7354 T 4, Str2 1,
  7363 A4 1, 3518 native realm 1): pre-existing on main, not this change.
- Gates exit 0: loc, func (also with `LOC_GATE_BASE=origin/main`), coercion sites, oracle ratchet, dead exports,
  typecheck, import cycles, compiler boundaries inventory (`--base HEAD^1` and `--base origin/main`). No budget grant.
- Not done here: the adversarial review (CLAUDE.md, before the hold is released) and the follow-up issues named in
  the plan (codegen constant-string evaluators; `pristine` and global-object rebinding), whose ids come from the lead.
