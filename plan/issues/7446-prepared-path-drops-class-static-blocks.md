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

- **Module:** `src/ir/program-source.ts`, `prepareIrProgramSources`, right after `buildIrUnitInventory` /
  `buildIrPlanningIdentityContext` and before anything that can throw (startup plans, signatures, globals): the first
  terminal unit with a `directFailure` is the program's refusal, with that failure's code, stage (`select`) and
  detail. Placing it first keeps the refusal code independent of whichever later step would fail first.
- **Which failures it honours:** every `directFailure` the inventory records, not a filtered code. Today there are
  two:
  - `static-class-initialization` on `<module-init>` (a top-level class's static block or static initializer): the
    fix.
  - `anonymous-class` on the members of an anonymous class (`export default class { m() {} }`): these programs were
    already refused ("no body producer for class-instance-method"); only the reported code changes. Census of the 19
    test262 files with `export default class {…}`: refused before and after, verdict unchanged.
  - Both details are reworded path-neutral in `src/ir/identity.ts` (they named the legacy direct-codegen path, which
    is false here). No test or baseline holds either string; tests and baselines key on the code.
- **Reuses:** the inventory's existing select-stage failures (the same records the ordinary pipeline's outcome
  report reads, `ir-overlay-outcomes.ts`); no new predicate.
- **Removes duplicates:** `locatedFailure` (owner lookup + failure shaping) moves from
  `src/ir/program/runtime-manifest.ts` to `src/ir/program/owner.ts`, next to `preparedIrProgramOwner`, with a neutral
  message ("prepared producer cannot locate …"; `tests/issue-3518-runtime-projection-owner.test.ts` updated to it).
  `runtime-manifest.ts` keeps re-exporting it for its compatibility surface. It replaces three hand-rolled copies: the
  source producer's catch arm and the two in `src/ir/program/runtime-abi.ts`.
- Never claims and withdraws: the refusal happens before any unit is lowered.
- Ordinary pipeline: `prepareIrProgramSources` is reachable only through `prepareWholeIrProgram` →
  `ir-program-driver` → `ir-program-presentation`, so ordinary output is unchanged by construction (also checked on a
  sample, and `check:ir-fallbacks` is unchanged).

### Acceptance

- Correctness: every probe with a top-level static block / static initializer is refused by name
  (`static-class-initialization`) under both `unlowerableBodies` policies, including an exported class, an anonymous
  default-exported class, a `static accessor` field and a block calling a static private method; an anonymous class
  with a method is refused as `anonymous-class`; inert classes (`class C {}`, `static x;`) still compile and run. Pin
  tests: `tests/issue-7446-prepared-class-static-init.test.ts` (fail on main).
- Code quality: one helper in `owner.ts` owns failure shaping (three hand-rolled copies removed); the new rule is
  three lines in the producer; no new predicate, no filter by failure code, no branch for a case that cannot occur;
  `program-source.ts` stays within its LOC budget.

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
  code is inert" predicate, which is the speculative special case the IR rule forbids. The lead accepted the loss
  (2026-11-26); the plan reviewer found no cheap sound route (exempting empty blocks in the inventory would change the
  ordinary pipeline's module-init selection).
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

Follow-up: [#7488](plan/issues/7488-prepared-path-drops-class-heritage-and-computed-keys.md). It cannot be folded in
cheaply: the `<module-init>` `directFailure` also feeds the ordinary pipeline's selection, so widening it changes
ordinary bytes, and a Prepared-only definition-evaluation predicate is new work. Wrong values are confirmed on main and
after this change (`class C extends (n=7, Object) {}`, `extends (n=7, null)`, `static [f()];`, `[f()];`). "No wrong
value on test262" holds only because those files hit unrelated refusals first (e.g. `extends f()` refuses with
"callable annotation … requires one non-constructing call signature").
