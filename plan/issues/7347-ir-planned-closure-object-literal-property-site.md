---
id: 7347
title: "IR: a function expression as an object-literal property value becomes a planned closure"
status: ready
sprint: current
created: 2026-11-15
updated: 2026-11-15
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7106, 7195, 7198, 7338, 7339]
---

# #7347 — IR: function values in object literals

## Problem

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only").

An unannotated function expression is an IR value only at the four sites the
planned-closure module knows
(`src/codegen/function-member-closure-planning.ts`): `F.m = function…`, an
argument of a same-source function's member call, an argument of a
same-source top-level function, and a script `var f = function…` that is
never called. Anywhere else the selector refuses it as `closure-return-type`.

The most frequent "anywhere else" in ES5 test262 is a property value of an
object literal:

```js
Object.defineProperty(o, "p", { get: function () { return 1; } });
var obj = { toString: function () { return "x"; } };
String(obj);
```

## Measured

All numbers are standalone, from the 2026-11-14 census rows or from runs on
`ab380a0f8b` (the #7234 head) on 2026-11-15. None is a compile result of the
change itself.

| measure | files | source |
| --- | --- | --- |
| descriptor is the only refusal and it holds a real function value, no `this`, no captures | 40 | re-run of the 1,719 Object-statics files |
| same, function reads captured variables only | 2 | same |
| same, function writes captured variables | 15 | same |
| same, function uses `this` | 15 | same |
| object-literal method anywhere in a file that carries a function-value refusal | 292 | static count, 2026-11-13 research |
| module-level `var o = { … }` whose literal holds a function | 221 bindings | census rows; 67 `toString`, 63 `valueOf`, 42 both, 49 other |

The last row is also blocked by the binding's storage (the literal's module
slot is a closed struct today), so this issue does not free those files
alone.

Ten probe programs on `ab380a0f8b`: every getter, setter or function-valued
descriptor is refused as `expr-object-static-descriptor`, and behind it the
function value itself is refused (`closure-return-type`). Legacy answers all
ten correctly.

## Implementation Plan

### Target structure

- **One new site in the existing site table.** `planMemberClosure` picks a
  site from `memberAssignmentSite ?? argumentPositionSite ?? callArgumentSite
  ?? scriptVarSite`. Add `literalPropertySite` beside them, in the same file
  and shape (kind, ownerUnitId, `requiresVoid`, `identifierCalls`,
  `isCurrent`). No new planning module, no second admission function.
- **What the site proves.** The function expression is the initializer of a
  plain `name: function…` property (no computed key, no shorthand, no
  getter/setter syntax, no spread sibling) of an object literal that the IR
  lowers onto the dynamic carrier in the owner unit. "Lowers onto the
  dynamic carrier" is asked of the code that already decides it for the
  literal (the Object statics descriptor rule after #7338's next slice, and
  the open-object literal rule); the site does not restate it.
- **What it reuses.** The whole admission of `planMemberClosure`: single
  source, standalone native-first, no name, no annotations, parameter rules,
  `openBodyKey` / `closedScalarBodyKey`, the canonical closure-wrapper
  signature. The plan's value is legacy's closure object, so the runtime's
  getter, setter and method calls see what they see today.
- **What duplicate it removes.** None; it prevents one (a descriptor-only
  function path inside the Object statics table).

### Step 0: three facts to measure before any code (stop if one fails)

1. **The runtime accepts a planned closure.** Build one program by hand
   through an existing site (`F.m = function () { return true; }`), read `F.m`
   into a descriptor (`{ get: F.m }` is a function *identifier*, which
   already reaches the helper as a dynamic value), and check that
   `Object.defineProperty` plus a read calls it and answers as node does. If
   the helper does not call a planned closure, report what it expects; do not
   add a runtime mechanism.
2. **Return kinds.** For the 40 + 2 files and for the 221 literal methods,
   tally the oracle return kind of each function: boolean, void, string,
   number, other. `planMemberClosure` admits boolean, void and string only.
3. **Body blockers.** Run the body proofs on the same functions and tally
   why a body is refused. The 2026-11-13 research found that binding work
   alone gained 0 files because a body blocker sat behind it.

Report the three tallies. The slices below are then cut by yield.

### Slices

- **S1: the site, with today's admission.** Functions with no `this` and no
  captures whose return kind is already admitted, as a descriptor field and
  as a method of a literal lowered to the carrier. Ceiling: the part of the
  40 files that Step 0 leaves.
- **S2: a number result.** `planMemberClosure` refuses a number return
  (`oracleSignature.returns.kind` check). Admit `number` where the physical
  result is `f64`, with a body proof for it. It applies to every site, so
  measure all sites, not only the new one.
- **S3: `this` in a getter, setter or method.** The plans bind `this` once
  through `dyn.current_this`; that is refused today unless the result is void
  or string. Needs the receiver the runtime passes to an accessor to be the
  one `dyn.current_this` reads; prove it with a probe before coding.
- **S4: captures.** Reading a script `var` is already a module-global read
  inside an open body (`site.moduleGlobals`). Writing one, or capturing a
  function-local variable, is a separate design; out of scope here.

### Constraints

- Standalone only; no new host imports; JS-environment output
  byte-identical.
- No unit that main lowers on IR may be lost; no new post-claim error; refuse
  at select, never claim and then withdraw. The selector asks the plan, as it
  does for the other sites; it gets no copy of the site's rules.
- `function-member-closure-planning.ts` is 844 lines. If the new site and the
  number result push it past its budget, split the site functions into their
  own module in the same PR instead of taking a grant.

## Acceptance criteria

Correctness:

1. Census on the 1,719 Object-statics files, the files holding a literal
   method, and 300 IR-only control files: report files gained, files lost 0,
   units newly legacy 0, new compile errors 0, post-claim errors not
   increased.
2. Verdicts of every routing-changed file unchanged.
3. A probe matrix of at least 40 programs (getter, setter, both, data
   property holding a function, method call, `toString` / `valueOf` reached
   by `String(o)`, `o + ""`, `o < 1`; with and without parameters; throwing
   bodies; a function that reads `this`; one that captures) answers as node
   does or stays refused at select.
4. JS-environment output byte-identical on the routing-changed files and on
   200 others.

Code quality:

5. One site function beside its four siblings, same shape; one admission
   path.
6. No function-value handling inside `src/ir/object-statics.ts` beyond
   asking whether the field's value is a planned closure.
7. A fresh-context adversarial review records its verdict in the PR body.
