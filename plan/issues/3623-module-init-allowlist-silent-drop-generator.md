---
id: 3623
title: "The `collectDeclarations` allow-list is a vacuity generator: make the silent fall-through loud, and enumerate what it still drops"
status: in-progress
sprint: current
priority: high
horizon: l
feasibility: hard
goal: core-semantics
assignee: ttraenkler/senior-dev-harness
created: 2026-07-25
# +10 lines on the CodegenContext interface (2986 -> 2996): ONE optional field,
# `droppedModuleInitShapes`, plus its doc comment. A field on the context type
# cannot live in a subsystem module — the interface IS the shared surface — and
# the new LOGIC deliberately went to its own file
# (src/codegen/module-init-collection.ts, 178 lines) rather than into either
# god-file. 8 of the 10 lines are the comment recording the six historical
# silent drops, which is the point of the change.
loc-budget-allow:
  - src/codegen/context/types.ts
---

## Problem

`collectDeclarations` (`src/codegen/declarations.ts`) decides which top-level
`ExpressionStatement`s reach `__module_init` using an **allow-list**. Anything
the list does not name falls off the end of the block and is **dropped with no
diagnostic**.

A dropped statement does not fail. It simply never happens. So the program
produces a **silent wrong answer**, and any test covering it becomes a
**vacuous pass** — which is the #3613 charter exactly: _a mechanism that
generates vacuous passes by construction._

This has now happened **at least six times**, each fixed by adding one more arm:

| #         | shape silently dropped                  | consequence                               |
| --------- | --------------------------------------- | ----------------------------------------- |
| #1268     | `d["x"] ??= 42` (logical assignment)    | LHS uninitialised, reads returned NaN     |
| #2671     | `F.prop = …` on a top-level function    | the static silently never existed         |
| #2992     | `delete o.k`                            | property survived; `"k" in o` stayed true |
| #3366     | destructuring assignment `[a, b] = c`   | whole statement dropped                   |
| #3468     | `assert.sameValue = function(){…}` (SA) | **EVERY harness assertion vacuous**       |
| #3592 RC1 | top-level `throw`                       | program exited 0 instead of throwing      |
| #3615     | bare `o.p;` property read               | the accessor never ran                    |

**Adding a seventh arm does not stop the eighth.**

The sharpest instance is #3592 RC1: the dropped top-level `throw` **broke the
throw-probe technique used to DETECT vacuous passes**. The mechanism disabled
its own detector — and an audit run on that base reported a spurious
"43/43 vacuous", which was only caught by a known-FAIL control.

## What landed here (part 1 — the fall-through is now loud)

`src/codegen/module-init-collection.ts` — a **total** classifier. Every
top-level `ExpressionStatement` gets exactly one of three dispositions, and the
**default is never "drop quietly"**:

- **`keep`** — observable; collected (the existing allow-list shapes).
- **`inert`** — an **explicit deny-list** of shapes that provably run no user
  code and cannot throw. Every entry carries its reason, because an inert claim
  is a correctness claim.
- **`unhandled`** — everything else. Not provably inert, not collected: recorded
  into `ctx.droppedModuleInitShapes` (shape → count) instead of vanishing.

The point is the **default**. A shape nobody has thought about now lands in
`unhandled` and announces itself rather than becoming the eighth silent wrong
answer.

**This step is byte-neutral**: nothing new is collected, so no verdict can move.
It converts an invisible drop into a recorded one. Verified: a program mixing
kept, inert and unhandled shapes compiles and instantiates unchanged
(`.tmp/probe-neutral.mts`).

Notably, `inert` deliberately **excludes** several shapes that look harmless:
`Identifier` (`x;` throws ReferenceError when undeclared, and a TDZ
ReferenceError before initialisation), `ObjectLiteralExpression` /
`ArrayLiteralExpression` (computed keys, spreads and elements run user code),
`ClassExpression` (a `static { … }` block runs at definition time),
`TypeOfExpression` (throws on a TDZ binding), `TaggedTemplateExpression` (calls
the tag function).

`tests/issue-3623-module-init-collection.test.ts` — 46 cases: all six
historical drops must classify `keep`; the inert deny-list; the loud default;
totality; and that the unwrap (`(…)`, `void`) matches the collector's.

## The enumeration — WHAT ELSE IS DROPPED TODAY

**This list is the deliverable, even where a shape is a genuine no-op.**
Exhaustive parse-only scan of all 53,003 `test262/test/**` files
(`.tmp/enumerate-dropped.mts`), modelling the allow-list exactly. Counts are
top-level statements / distinct files.

### Observable — a dropped statement here IS a silent wrong answer

| shape                          |     stmts | files | why it is observable                                         |
| ------------------------------ | --------: | ----: | ------------------------------------------------------------ |
| `Identifier` (`x;`)            | **9,317** |   120 | ReferenceError if undeclared; TDZ ReferenceError before init |
| `BinaryExpression(Comma)`      |       147 |   146 | operands are routinely calls/assignments                     |
| `ArrowFunction` _(see note)_   |       101 |   101 | inert as a value — listed for completeness                   |
| `ObjectLiteralExpression`      |        92 |    73 | computed keys, spreads invoke getters                        |
| `TaggedTemplateExpression`     |        85 |    43 | **calls the tag function**                                   |
| `AwaitExpression`              |        31 |    25 | top-level await                                              |
| `BinaryExpression(In)`         |        28 |    28 | invokes a Proxy `has` trap                                   |
| `TypeOfExpression`             |        27 |    22 | throws on a TDZ binding                                      |
| `BinaryExpression(instanceof)` |         8 |     8 | invokes `Symbol.hasInstance`                                 |
| `ClassExpression`              |         8 |     8 | **`static { … }` runs at definition time**                   |
| `ArrayLiteralExpression`       |        10 |    10 | elements run user code                                       |
| `ConditionalExpression`        |         4 |     4 | evaluates a branch                                           |
| `MetaProperty` (`new.target;`) |         6 |     6 | early-error surface                                          |
| `TemplateExpression`           |         2 |     2 | substitutions evaluate                                       |
| `YieldExpression`              |         1 |     1 | observable                                                   |
| other `BinaryExpression(<op>)` |      ~130 |  ~110 | operands can be calls; ToPrimitive can throw                 |

### Provably inert — dropping is correct, now declared rather than accidental

`NumericLiteral` 300 · `RegularExpressionLiteral` 488 · `StringLiteral` 70 ·
`BigIntLiteral` 22 · `NullKeyword` 10 · `FalseKeyword` 6 · `TrueKeyword` 5 ·
`ThisKeyword` 4 · `FunctionExpression` 88 · `ArrowFunction` 101 ·
`NoSubstitutionTemplateLiteral` 15.

> The `PrivateIdentifier` bucket (8,935 statements in 6 files) is a **parse
> artifact** of deliberately-malformed early-error tests (a bare `#`), not a
> real shape. Recorded so the next reader does not chase it.

## Remaining work (part 2 — flip the default to "compile")

The semantically correct end state is that `unhandled` shapes are **compiled**,
not recorded. That is a real behaviour change across roughly **10,000
statements in ~500 files**, dominated by the `Identifier` bucket, and it needs
its own measured landing on the #3592 RC2 recipe:

1. Exhaustive A/B over the affected population (now enumerated, so it starts
   from numbers rather than guesses), both lanes, CI-equivalent path.
2. Classify every pass→fail as unmasked-pre-existing vs introduced, using the
   fix-disabled control on a path the change does not touch (the discriminator
   that settled both of #3615's regressions).
3. Declare the de-inflation through the named machine-checked allowance —
   `standalone-devacuification-allow` / `trap-growth-allow` as applicable —
   never absorbed.
4. Expect it to be **negative** on the headline and correct.

Doing that flip in the same window as the enumeration would be exactly the
"absorb it" failure this issue exists to end, so it is deliberately split.

## Acceptance criteria

- [x] The fall-through is no longer silent — a total classifier with a loud default
- [x] `inert` is an explicit deny-list, each entry carrying its justification
- [x] All six historical silent drops are pinned as `keep` by tests
- [x] The step is byte-neutral (records only; nothing new collected)
- [x] What else is dropped today is **enumerated**, observable vs inert
- [ ] Part 2: flip `unhandled` to compiled, with the measured/declared landing
