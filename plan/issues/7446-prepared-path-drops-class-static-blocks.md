---
id: 7446
title: "Prepared path silently drops class static blocks: wrong value instead of a refusal"
status: done
sprint: current
created: 2026-11-21
updated: 2026-11-26
completed: 2026-11-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
goal: backend-agnostic-ir
related: [7354, 7364]
---

# Prepared path silently drops class static blocks

## Problem

On the Prepared whole-program path (`wholeProgram: {kind: "prepared-program-required", version: 1}`,
`src/test262/test262-prepared-entry.ts`) the code of a class static block is not compiled and not refused. The
program compiles, validates and runs with the block missing, so it returns a wrong answer.

```js
var n = 2;
class C { static { n = 7; } }
if (n !== 2) throw 0;   // node throws 0; the Prepared path returns normally
```

The path's rule is: JavaScript's answer or a named refusal, never a wrong value. Found by the review of PR 7370
(slice S of #7354) on 2026-11-21; it reproduces on main at b8a0553f80, so that PR did not cause it. 7 of 13 probe
programs with a static block gave a wrong answer (6 a wrong value, 1 ran where node throws).

A consequence: a call the path refuses by name elsewhere (`Object.defineProperty(o, …)`) is not refused inside a
static block, because from-ast never meets it.

## Acceptance criteria

- A class static block on the Prepared path is either lowered with JavaScript's semantics (runs once at class
  definition evaluation, in order with static field initializers, `this` = the class) or refused by name at compile
  time. No program with a static block compiles to a module that skips the block.
- Probes against node: assignment to an outer `var`, a throw inside the block, several blocks in order, a block
  beside static fields, a block that reads `this`, a nested class with its own block, a class expression.
- The ordinary pipeline's output is unchanged.

## Notes

- Not an ES5 construct: no ES5 test262 row depends on it. It is filed because it breaks the path's soundness rule.
- Where to look first: how the Prepared resolver (`src/ir/program-source.ts`) collects a class's members into units;
  a `ClassStaticBlockDeclaration` is probably not a unit and nothing refuses the class for having one.

## Implementation Plan

Written 2026-11-26 against main `c3b7be66` (Merge PR #7347).

### Where the code is lost (measured)

- `buildIrUnitInventory` (`src/ir/identity.ts`) records a top-level class's static block and static field
  initializers as **support** units (`class-static-block`, `class-static-field-initializer`) owned by `<module-init>`,
  and gives `<module-init>` a select-stage `directFailure`
  `{ kind: "unsupported", code: "static-class-initialization" }` whenever such a member exists.
- The Prepared producer (`prepareIrProgramSources`, `src/ir/program-source.ts`) lowers and refuses **terminal** units
  only, and never reads `directFailure`. `<module-init>` is lowered from `collectModuleInitPopulation`, which excludes
  class declarations; the support units have no producer. So the static code is neither run nor refused.
- A class *inside a function* is not affected: from-ast refuses the `ClassDeclaration` statement, and the function
  gets an abort body (a trap, not a wrong value). A class *expression* is refused by from-ast.

### Decision: refuse at select, by the rule that already exists

Lowering the block is not cheap: the Prepared path has no class binding at all (`t = this` / `t !== C` refuses with
`identifier "C" is not in scope`), so a static block would need class objects, `this` = the class, and ordering with
static fields first. Refuse instead.

- **Module:** `src/ir/program-source.ts`, `prepareIrProgramSources`, before any body is lowered: the first terminal
  unit with a `directFailure` is the program's refusal, with that failure's code, stage (`select`) and detail.
- **Reuses:** the inventory's existing `static-class-initialization` failure (the same rule the ordinary pipeline's
  outcome report reads, `ir-overlay-outcomes.ts`); no new predicate.
- **Removes a duplicate:** the producer's catch arm hand-rolled the owner lookup + failure shaping that
  `locatedFailure` (`src/ir/program/runtime-manifest.ts`) already does for the runtime producer. Both the catch and the
  new refusal call `locatedFailure`; its `input` type narrows to what it reads (`inventory`, `derivedUnits`).
- The failure's detail is reworded path-neutral (`src/ir/identity.ts`; was "still emitted by the direct module-init
  path", which is false on this path). No test or baseline holds the string; ordinary bytes do not carry it.
- Never claims and withdraws: the refusal happens before any unit is lowered.
- Ordinary pipeline: `prepareIrProgramSources` is reachable only from `runPreparedIrPipelinePresentation`, so ordinary
  output is unchanged by construction (also checked on a sample).

### Acceptance

- Correctness: every probe with a top-level static block / static initializer is refused by name
  (`static-class-initialization`) under both `unlowerableBodies` policies; inert classes (`class C {}`,
  `static x;`) still compile and run. Pin tests: `tests/issue-7446-prepared-class-static-init.test.ts` (fail on main).
- Code quality: one helper owns failure shaping (one duplicate removed); the new rule is three lines in the producer;
  no new predicate, no branch for a failure kind that cannot occur; `program-source.ts` stays within its LOC budget.

### Yield (measured)

Census of the 1,103 test262 files with a top-level class whose definition runs code (786 heritage, 172 computed key,
90 static initializer, 58 static block), `scripts/ir-census/prepared-census.mts --harness real` (standalone, the CI
worker's options); before = clean main `c3b7be66` (`--tree`), after = this change on it, 2026-11-26.

| Prepared verdict | before | after |
| --- | ---: | ---: |
| pass | 8 | 1 |
| fail (wrong value or abort trap) | 19 | 6 |
| compile_error (named refusal) | 995 | 1,015 |
| skip (negative / async) | 81 | 81 |

- fail → refusal: 13 files, each a wrong value on main (e.g. `static-init-scope-var-close.js`,
  `static-init-expr-new-target.js`, `class-name-static-initializer-decl.js`).
- **pass → refusal: 7 files.** Each passed only because the dropped static code had no observable effect:
  `static-init-statement-list-optional.js` (`static {}`), six `static-init-await-binding*` /
  `ident-name-prop-name-literal-await-static-init.js` (`static { (function await(await) {}); }`). Losing them is the
  price of the soundness rule; none is ES5, none is in a completed edition. Keeping them would need a "this static
  code is inert" predicate, which is the speculative special case the IR rule forbids.
- The 6 remaining fails are heritage-only files whose class body has an abort-body trap, not a wrong value; the 1
  remaining pass is `symbol-valid-as-extends-value.js` (heritage evaluated without effect, see below).
- Ordinary pipeline: 100 of these files × (default, standalone), base vs branch: byte-identical (171 binaries, same
  errors elsewhere).

### Other class elements (probed against node, main `c3b7be66`)

| Element (top-level class, class otherwise unreferenced) | Prepared path on main |
| --- | --- |
| static block | **wrong value** (fixed here) |
| static field initializer with a side effect | **wrong value** (fixed here) |
| `extends <expr>` (heritage evaluated / throws) | **wrong value** — new finding, not fixed here |
| computed key on a field (`static [f()];`, `[f()];`) | **wrong value** — new finding, not fixed here |
| computed key on a method | refused (`no body producer for class-instance-method`) |
| private / static private methods | refused (no body producer) |
| `accessor` fields, instance field initializers | refused (`class-implicit-constructor`) |
| class inside a function | abort body (trap) |
| class expression | refused by from-ast |

The heritage / computed-key case needs a definition-evaluation predicate the inventory does not record today; it is
left to a follow-up issue so this change stays the reuse of an existing rule. On test262 it causes no wrong value
today (6 abort traps, 1 accidental pass), so it is soundness debt, not a measured yield. (Follow-up id: to be
allocated by the lead; `claim-issue --allocate` was not permitted in this session.)
