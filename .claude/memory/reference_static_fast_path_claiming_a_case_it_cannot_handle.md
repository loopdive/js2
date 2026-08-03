---
name: reference_static_fast_path_claiming_a_case_it_cannot_handle
description: "Recurring codegen defect class: a static/compile-time fast path returns 'I handle this' for a shape it cannot actually handle, then degrades to a SILENT WRONG ANSWER instead of refusing. Three confirmed instances in one day."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-01T19:05:29.290Z
---

**Three independent instances found on 2026-08-01, by three different agents, in
the same subsystem.** Treat this as a defect *class* and grep for it, not as
three bugs.

| issue | the fast path | what it claimed | what actually happened |
|---|---|---|---|
| #3983 | standalone strict `[[Set]]` | routed to a helper by name | aliased onto the **sloppy** helper, whose refusals are silent `return`s — every strict write that must throw did nothing |
| #3984 | `compileObjectDefineProperties` | "`Object.defineProperty` validates at runtime" | the loop **never delegates**; `maybeEmitVecLengthDefine` had exactly one call site, so §10.4.2.4 never ran for the plural form |
| #3991 | `isStaticDescWellFormed` | returned `true` for a **non-object-literal** descriptor | every field parser sits inside `if (ts.isObjectLiteralExpression(...))`, so the property was defined with an **undefined value** |

## The shape

> A compile-time predicate answers **"yes, I can handle this"** for an input it
> cannot handle, usually justified by *"the runtime/other path will validate
> it."* That other path is **never reached**, and the result is a silent wrong
> value rather than a refusal.

**Why it is so damaging:** the failure is *quiet*. Nothing downstream can detect
it — no diagnostic, no trap, no refusal. #3984's probe showed
`Object.defineProperties(arr,{length:{value:2}})` returning **3** with no error.
The top signature in the #3991 area is literally
`obj.property Expected SameValue(«undefined», «"Number"»)` — that `undefined`
*is* the defect.

**Note #3984 and #3991 are in the SAME FUNCTION**, and #3991's false reasoning
("defineProperty will handle it") is refuted by a comment #3984 had already
written into that function. A fix does not automatically correct the *belief*
that produced the bug.

## The rule

1. **A fast path must REFUSE loudly, never degrade silently.** If the predicate
   cannot prove it handles the shape, emit a named refusal (the `#1906`
   fail-loud pattern) so the failure is attributable.
2. **"The other path will validate it" is a claim about control flow — verify
   it.** In all three cases the delegation did not exist. Check the call graph,
   don't reason about intent.
3. **When you fix one, grep for the siblings.** Look for `isStatic*`,
   `*WellFormed`, `canHandle*`, `try*Fast`, and any `funcMap.set(<nameA>,
   <idxOfB>)` aliasing.
4. **Verify by VALUE, not by "it compiles" or "it validates"** — see
   [[reference_valid_wasm_is_not_correct_verify_by_value]].

Related: [[reference_silent_empty_is_indistinguishable_from_real]] (same family:
the benign outcome is indistinguishable from the broken one),
[[reference_1927_pipeline_pass_gates_fresh_errors]].
