---
id: 5159
title: "Error/AggregateError options.cause never installed on the host lane, and the Error lowering drops (never evaluates) arguments after the message"
status: done
sprint: current
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
goal: core-semantics
related: [1339, 1634, 3481]
# 2026-08-28 (#5159) — installing `cause` needs three things the budgets see:
# the options bag captured into a local instead of dropped, plus the companion
# `__error_install_cause` call, at the Error-family site in
# `tryCompileBuiltinGlobalNew` (+52 lines, mostly the comments recording why
# the ctor import was NOT widened); the runtime handler beside the
# AggregateError/SuppressedError ones in `resolveImport` (+18); and the
# manifest arm that routes the new import to it (+6). Splitting any of the
# three would separate the new code from the sibling arms it must stay
# consistent with. The host-import-policy line ceilings are ratcheted to the
# exact measured values (18707 / 7642) in the same change.
loc-budget-allow:
  - src/codegen/expressions/new-builtin-globals.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/runtime.ts::resolveImport
  - src/compiler/import-manifest.ts::classifyImport
---

# Two Error-family defects, measured during #3481 cause-2 (PR #5161)

Both were measured **identical with and without** that PR's change (file-copy
A/B on `origin/main` 2026-08-28), so they are pre-existing and independent of
the message-ToString fix.

## Defect 1 — `options.cause` does not work at all (host lane)

| expression | measured | spec (§20.5.1.1 step 4 / InstallErrorCause) |
| --- | --- | --- |
| `new Error("m", {cause: 1}).cause` | absent / `NaN` | `1` |
| `new AggregateError([], "m", {cause: 1}).cause` | absent / `NaN` | `1` |

#1339/#1634 ("AggregateError + SuppressedError errors-iterable + cause
coercion", both `done` 2026-06) addressed a cause-coercion slice, yet the
plain `Error` + `AggregateError` host-lane behavior above is broken today —
either those fixes covered a different lane/builtin subset or this regressed
since. The dispatched fix must first bisect which, and cite the answer here.

## Defect 2 — arguments after the message are compiled and DROPPED

The Error lowering compiles argument expressions past the message and then
discards them, so a side effect in the options position never runs:

```js
let hit = 0;
new Error("m", (hit++, {cause: 1}));
// hit is 0 — the expression never executes
```

Per spec every argument is evaluated. This is the same silent-collapse family
as #5095's swallowed diagnostic — the module is "successfully" compiled with
observably missing evaluation.

## Notes for the implementer

- The #5161 fix added a single-index message coercion at the host boundary
  (`_errorMessageToString` in `src/runtime.ts`, plus the `resolveImport`
  extern-class bridge); the `options` bag deliberately crosses uncoerced.
  Installing `cause` likely belongs beside that boundary — read the #3481
  issue file's cause-2 record first.
- `SuppressedError` is unimplemented in this host entirely (its whole test262
  directory fails); do not widen into implementing it here.
- Check the codex lane's claim ledger before dispatch: their es2015 residual
  lanes are active (#4785–#4789, #5122–#5137 at time of filing; none touched
  Error `options.cause`).

## Acceptance criteria

- `new Error("m", {cause: v}).cause === v` and the AggregateError twin, host
  lane; standalone behavior measured and either fixed or recorded.
- Argument expressions after the message evaluate exactly once, in order
  (side-effect probe pinned).
- test262 `built-ins/Error/cause*` / `AggregateError/cause*` rows measured
  before/after with the count stated plainly.
- Byte-identity for Error constructions without options; equivalence shards
  clean by name.

---

# Resolution (2026-08-28)

## The bisect: two different answers, one per constructor

The issue filed both constructors as one symptom. They are not the same
defect, and the required bisect is what separated them.

**`AggregateError` — a regression, and it is in the TEST, not the compiler.**
`git bisect` over `tests/issue-1634.test.ts -t "installs cause"` (good
`5f1e2af44d`, the #1634 landing commit; bad `f727d529ab`, main) names:

```
708ebbd56d is the first bad commit
    feat(codegen): authenticate data-struct host bridges   (2026-07-30)
```

That commit made the runtime hand out `__struct_field_names` — the export
`_installErrorCause` needs in order to see a `cause` field on an opaque WasmGC
options struct — only to a host that has BRANDED the instance via
`__setInstance`. `tests/issue-1634.test.ts` calls `setExports` alone, so its
export view had that helper projected away and its two `cause` assertions had
been silently red ever since. **In a correctly wired host AggregateError
`cause` works today and worked before this change**, measured directly:

| harness | `new AggregateError([], "m", {cause: c}).cause === c` |
| --- | --- |
| `setExports` only | `MISS` (undefined) |
| `setInstance` + `setExports` | `SAME` |

`tests/test262-runner.ts` brands (line 4311 / 4803), so conformance was never
affected. The fix is one line in the test harness, and the two assertions are
green again.

**Plain `Error` — never worked, in any host.** #1339/#1634 gave
`AggregateError` and `SuppressedError` dedicated multi-argument imports and
left the seven plain Error constructors on the message-only lowering they have
had since 2026-03-27. So this is a *different lane*, not a regression.

## Defect 2 as filed is a mis-measurement; the real defect is one line below it

The issue says the options expression "never executes". It does. Measured on
`origin/main`, every shape ran the side effect exactly once — sequence
expression, `hit++`, function call, function scope and module scope alike.

What the lowering actually did (`new-builtin-globals.ts`) was evaluate each
argument past the message and drop its **value**:

```ts
for (let i = 1; i < args.length; i++) {
  const argType = compileExpression(ctx, fctx, args[i]!);
  if (argType !== null) fctx.body.push({ op: "drop" });   // ← the whole bug
}
```

So defect 1 and defect 2 are one root cause, not two: the options bag was
evaluated and then discarded, and `__new_Error` was called with `argc=1`
(confirmed by intercepting the host import). Nothing downstream could install
`cause` because nothing downstream ever received the bag.

## The fix

1. **`src/codegen/expressions/new-builtin-globals.ts`** — argument 1 is now
   captured into a local instead of dropped, and passed to a companion import
   after construction. Surplus arguments (2+) keep the drop, so
   ArgumentListEvaluation order is unchanged.
2. **`src/runtime.ts`** — `__error_install_cause(err, options)` applies the
   shared `_installErrorCause` helper (the same one AggregateError and
   SuppressedError use, so the three cannot drift on
   HasProperty-not-truthiness or on reference identity) and returns the error.
3. **`src/compiler/import-manifest.ts`** — routes that name to the builtin.

**Why a companion import and not a second parameter on `__new_<Name>`:**
widening the constructor signature would re-emit every option-less
`new Error(msg)` in every module. As built, a module that passes no options
gains neither the import nor the call — which is how the byte-identity
criterion is met, and it is asserted directly in the test suite rather than
claimed (`an option-less module does not import __error_install_cause`).

## Measurements

**test262 `cause` rows** — the 4 files matching `cause` under the Error family
(`Error/cause_property.js`, `Error/cause_abrupt.js`,
`AggregateError/cause-property.js`,
`NativeErrors/cause_property_native_error.js`), file-copy A/B on the same
worktree:

| | pass / total |
| --- | --- |
| base (`origin/main` f727d529ab) | **1 / 4** |
| with this change | **3 / 4** |

Net **+2**. The three base failures were `cause should be an own property`,
`HasProperty Expected a Test262Error ... no exception was thrown`, and the
NativeErrors row; the first two are now green.

**Residual, deliberately not fixed here:**
`built-ins/NativeErrors/cause_property_native_error.js` still fails with
`Cannot convert undefined or null to object [in verifyProperty()]`. That is a
`verifyProperty` harness-interop failure on the native-error subclass loop, not
a `cause` install failure — a separate defect that would widen this change.

**Standalone / WASI lane — measured, NOT fixed.** `--target wasi`:
`new Error("m", {cause: 7}).cause === 7` returns `0` before and after. The
standalone lowering builds an `$Error_struct`
(`src/codegen/registry/error-types.ts`) whose five fields are
`tag / message / name / stack / userClassId / props` — there is no `cause`
slot, so installing one means either a sixth struct field or a write into the
`$props` sidecar, in both cases moving bytes for every standalone Error module.
That is a larger change than this issue's horizon and is left as a known gap;
the host-import-policy gate confirms the standalone surface is untouched
(`nativeFirstTotals.imports` 394, unchanged).

**`SuppressedError` — out of scope, as instructed.** Node 22.22 in this
container has `typeof SuppressedError === "undefined"`, so 8 pre-existing
assertions across `tests/issue-1339.test.ts` and `tests/issue-1634.test.ts`
fail with `SuppressedError is not supported by the host`. Untouched, and
unrelated to this change — they fail identically on base.

**#5161's pin held**: all 37 tests in
`tests/issue-3481-cause2-error-message-tostring.test.ts` stay green.

**Non-vacuity**: the new suite is 21-failed / 9-passed on base and 30/30 with
the change.
