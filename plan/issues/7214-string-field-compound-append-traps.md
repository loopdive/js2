---
id: 7214
title: "`this.field += s` on a string class field traps"
status: done
sprint: Backlog
created: 2026-10-31
updated: 2026-11-01
completed: 2026-11-01
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7199]
loc-budget-allow:
  # 2026-11-01 (#7214): +9 / +1 lines. operator-assignment.ts gets the two call
  # sites (the field one goes through tryCompileExternrefStructFieldPlusEquals,
  # which both struct paths already call) and the import. string-ops.ts gets an
  # `onStack` parameter on compileNativeConcatOperand. The append itself is in
  # string-field-append.ts.
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/string-ops.ts
func-budget-allow:
  # 2026-11-01 (#7214): +1 line, the `target` argument passed to the shared
  # struct-field `+=` helper.
  - src/codegen/expressions/operator-assignment.ts::compilePropertyCompoundAssignmentExternref
import-cycles-allow:
  - largestSccSize: 730 # 2026-11-01 (#7214): new helper expressions/string-field-append.ts, called by operator-assignment.ts and using string-ops.ts's compileNativeConcatOperand
---

# #7214 — compound string append on a class field traps

Found by the PR #7017 (#7199) review. Reproduces on main (9e82d60c42) on gc,
standalone and wasi:

```js
class Acc { total = ''; add(s) { this.total += s; return this; } }
console.log(new Acc().add('a').add('b').total);
// node: ab — we: trap ("dereferencing a null pointer"; with a non-empty
// initial value and chained calls: "illegal cast")
```

`this.total = this.total + s` works, so the bug is in the compound-assignment
lowering for a string-typed class field (`src/codegen/expressions/operator-assignment.ts`).

## Plan

1. Compare the lowering of `this.f += s` and `this.f = this.f + s` for a
   string field; find where the read or the store gets the wrong type or a
   null receiver.
2. Fix it, and cover `+=` on string fields of `this`, of another instance,
   of a static field, and with a number right operand.
3. Tests on 3 lanes against node.

## Resolution (2026-11-01)

**Cause.** Every native-string struct field (class instance, `this`, private
`#f`, object literal, interface) and every static string field went through the
f64 property compound lowering in `compilePropertyCompoundAssignment`
(`src/codegen/expressions/operator-assignment.ts`). The only string arm there,
`tryCompileExternrefStructFieldPlusEquals`, fires on EXTERNREF fields; since
native strings are the default on every lane, a string field is
`ref null $AnyString`. So `this.total += s` ToNumber-ed both sides,
`f64.add`-ed them, and the f64 → native-string writeback has no arm, so it
stored `ref.null`. The next read trapped ("dereferencing a null pointer", or
"illegal cast" once the null reached a cast). The IR path does not claim
these methods.

**Fix.** New `src/codegen/expressions/string-field-append.ts`. When the op is
`+=` and the slot's ValType is a native string (`$AnyString` or flat
`$NativeString`), it coerces the value already read from the slot, and the RHS,
with the same native `+` operand cascade `recv.f + rhs` uses. To reuse it,
`compileNativeConcatOperand` (string-ops.ts) gains an optional `onStack` type;
it is unset everywhere else, so those call sites emit the same bytes. The
result goes through `__str_concat` (and `__str_flatten` for a flat slot) and
is stored back once, with the receiver evaluated once. A `T | undefined` slot
that holds null stringifies as `undefined`, matching the plain read.

Call sites: `tryCompileExternrefStructFieldPlusEquals`, which both struct
paths already call (`tryEmitNativeStringFieldAppend`), and the static-global
path (`tryEmitNativeStringGlobalAppend`).

Test: `tests/equivalence/issue-7214-string-field-compound-append.test.ts`
(gc / standalone / wasi against node).

**Still open, not changed here (they fail the same way on base):** `-=` / `*=`
on a string field trap with an illegal cast; `+=` on a `number | string` union
field gives NaN or traps; `&&=` on a `string | undefined` field gives `null`;
`+=` / `-=` on a boolean field gives the wrong value; `+=` on an `any` static
field fails validation.
