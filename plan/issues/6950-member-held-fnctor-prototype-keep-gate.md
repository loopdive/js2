---
id: 6950
title: "A top-level `o.F.prototype.m = …` statement (constructor held in a member, `T.Node = function…`) is dropped by the module-init keep gate on both lanes — `new T.Node().m()` throws `called value is not a function` (Octane splay teardown; #6943 follow-up)"
status: ready
sprint: current
created: 2026-10-10
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: constructor-functions, prototype-chain
goal: correctness
related: [874, 6943, 6947, 4618, 2660, 3666, 4394]
---

# top-level `o.F.prototype.m = …` is never compiled (module-init keep gate)

Follow-up recorded in #6943 "Remaining". Standalone first failure of Octane
`splay.js` (function trace): `octane_teardown` → `SplayTearDown` →
`SplayTree.prototype.exportKeys` (driver line 695) → `this.root_.traverse_(function (node) {…})`
→ `TypeError: called value is not a function`. The run phase passes (`run -> 1`):
`insert`/`find`/`remove` never touch `traverse_`. No closure-map entry exists for
`SplayTree.Node.prototype.traverse_` — the statement at driver line 807 was never compiled.

Minimized (`.tmp/sp1.js`, node `0.5`, standalone throws, 15 lines):

```js
function SplayTree() { this.root_ = null; }
SplayTree.Node = function (key, value) { this.key = key; this.value = value; };
SplayTree.Node.prototype.left = null;
SplayTree.Node.prototype.right = null;
/** @param {function(SplayTree.Node)} f Visitor function. */
SplayTree.Node.prototype.traverse_ = function (f) {
  var current = this;
  while (current) { var left = current.left; if (left) left.traverse_(f); f(current); current = current.right; }
};
SplayTree.prototype.insert = function (key, value) { this.root_ = new SplayTree.Node(key, value); };
SplayTree.prototype.exportKeys = function () {
  var result = [];
  if (this.root_) this.root_.traverse_(function (node) { result.push(node.key); });
  return result;
};
export function main() { var t = new SplayTree(); t.insert(0.5, {}); return t.exportKeys().join("+"); }
```

Moving the three `SplayTree.Node.prototype.*` statements into a function called
from `main` (`.tmp/sp2.js`; `.tmp/sp3.js` = same without the JSDoc) passes on
standalone — the write arm, `new SplayTree.Node()` (#6943's `__native_construct`),
the callback classification and the `f(current)` ladder all work; ONLY the
top-level collection is wrong. Whole benchmark: wrapping lines 791-815 of the
splay driver in an IIFE (`.tmp/patch-splay-iife.mjs`) makes
`splay.js` pass end to end on standalone (`octane_run(1) -> 1`, teardown ok).
So on standalone this is the single remaining splay blocker; #6947's standalone
remainder is NOT needed for the benchmark.

## Root cause

`collectDeclarations` (`src/codegen/declarations.ts`), top-level assignment arms:

- `isFnctorPrototypeAssignTarget` (`:4427`) → `resolveUserFnctorName` →
  `resolveFnctorSymbol`, which only matches an IDENTIFIER receiver; `SplayTree.Node`
  is a property access → false.
- standalone #3666 arm (`:4518`): `isTopLevelFunctionPropertyReceiver(ctx, expr.left.expression)`
  — the receiver is `SplayTree.Node.prototype`, whose `signatureOf` is undefined → false.
- host #4618 arm (`:4575-4598`): requires `ts.isIdentifier(protoRecv)` → false; and the
  whole block is `!ctx.standalone` (`:4563`).
- host #4394 arm (`:4607-4616`): `isTopLevelFunctionPropertyReceiver(receiver)` on
  `SplayTree.Node.prototype` → false (no signature).

The generic "assignment to a module global" check then drops the statement.

## Implementation Plan

1. **`src/codegen/declarations.ts`**, next to the #4618 arm (`:4575`): add a
   LANE-NEUTRAL arm (outside the `!ctx.standalone` block, or hoist this one case
   above it) for `expr.left` = `<recv>.prototype.<m>` or `<recv>.prototype` where
   `<recv>` (unwrapped through parens/`as`/`!`) is a property/element chain rooted
   at a top-level function AND callable: reuse
   `isTopLevelFunctionPropertyReceiver(ctx, protoRecv)` (`:2568` — root in
   `ctx.topLevelFunctionNames` + `ctx.oracle.signatureOf(protoRecv) !== undefined`).
   Keep `STANDALONE_FN_STATIC_KEEP_EXCLUDED` and the private-identifier exclusion.
   Push `stmt` to `ctx.moduleInitStatements` and `continue`.
   Order constraint: the statements must keep source order relative to the
   `SplayTree.Node = function …` static write (`:4518` keeps that one) — they are
   appended in the same loop, so order is preserved by construction.
2. The kept statement compiles through the ordinary dynamic path (`SplayTree`
   closure → `__extern_get("Node")` → closure bag → `__extern_get("prototype")`
   → bag-vivified prototype → `__extern_set_strict(m)`), which is exactly what the
   inside-a-function form already does (sp2 passes). No codegen change.
3. Host lane: the same arm fixes the gc `traverse_ is not a function` noted in
   #6943/#6947 (verify, not in this issue's acceptance for standalone).

### Edge cases
- `o.F.prototype[expr] = …` (element access on prototype): not matched, stays dropped
  (same scope as the existing arms).
- Receiver rooted at a `var` (not a function): untouched — the generic module-global
  arm already keeps it.
- Do NOT widen `resolveFnctorSymbol`/`resolveUserFnctorName`: a member-held function
  expression has no `__fn_closure_<name>` singleton or `__fnctor_<Name>` struct, so
  the per-name proto global would be a split brain against `__native_construct`'s
  bag-based prototype.

### Acceptance criteria
1. `tests/issue-<id>-member-held-fnctor-proto-keep.test.ts` (both lanes vs node):
   `.tmp/sp1.js` → `0.5`; `.tmp/neg12.js` (from #6943: `typeof o.F.prototype.get`
   top-level vs `f.prototype`) → `function,function,true,true`; an object receiver
   `var o = {}; o.F = function…; o.F.prototype.m = …` top-level; control: the
   same writes inside a function are byte-identical before/after.
2. `pnpm run -s benchmark:octane -- --only splay --lanes standalone --timeout 300` → `pass`.
3. Ratchet gates green (`declarations.ts` is over budget — a dated
   `loc-budget-allow` entry in this file).

## Ownership note

`src/codegen/declarations.ts` (`collectDeclarations` top-level assignment arms) is
Session A's area; needs A's release. ~15 lines.
