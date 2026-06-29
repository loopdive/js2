---
id: 2818
title: "Bug C (class-method half): block-scoped let captured by a class method reads null (captured-globals promotion ordering)"
parent: 2669
related: [2820, 2811, 1672, 2854]
status: done
completed: 2026-06-30
assignee: sendev-ecmaver
created: 2026-06-29
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 2015
language_feature: closures
goal: spec-completeness
sprint: current
horizon: m
architect_spec: needed
---

# #2818 — Bug C (class-method half): block-scoped `let` captured by a class method reads null

Carved from #2820 (the function-declaration half of Bug C, fixed there) and
#2811 / parent #2669. This is the **class-method context** of the
`ary-ptrn-rest-obj-prop-id` cluster — the `meth-…` / `gen-meth-…` /
`private-meth-…` (and their `-dflt` / `-static`) members, which dominate the
remaining cluster fails. It is a **distinct** bug from #2820's duplicate-local
desync.

## Reproduction (host/gc lane, single file)

```ts
export function test(): string {
  { let s = "outer"; class C { m(): string { return s; } } return new C().m(); }
}
// => null   (should be "outer")
```

Also fails for an **arrow inside the method** (`m(){ const g = () => s; return g(); }`)
— so the method's capture channel never fires at all, the inner closure can't
reach `s` either.

Controls that PASS:
- `let s` at **function scope** (not in a block) → "outer" (promotion fires;
  `$C_m` reads `global.get __captured_s`).
- the same with a hoisted **function declaration** instead of a class → "outer"
  (fixed by #2820).

## Root cause (verified)

Class methods do NOT take lifted leading capture params (a method has a fixed
`[instance, ...userParams]` signature). Instead, an outer local referenced by a
method body is **promoted to a global** `__captured_<name>` by
`promoteAccessorCapturesToGlobals` (`src/codegen/closures.ts:345`), invoked from
`compileNestedClassDeclaration` (`src/codegen/statements/nested-declarations.ts:125`).
The enclosing function emits `local.get <slot>; global.set <captured>` to sync
the value, and the method body reads `global.get <captured>`.

For a **block-nested** class, that promotion never runs:
`compileNestedClassDeclaration` early-returns when the class is already collected
(`structMap.has(className) && !isDeferred`, `nested-declarations.ts:99-106`) —
**before** reaching the promotion loop and `compileClassBodies`. The class body
gets collected/compiled at a point where the block-let is not yet a promotable
local (it is shadow-removed on block entry, and `let s` has not run), so:

1. the method body resolves `s` to the `ref.null.extern` graceful fallback in
   `identifiers.ts` → `$C_m` compiles to `ref.null extern; return` (returns
   null), and
2. no `local.get; global.set __captured_s` sync is emitted in `$test`.

WAT confirms: in the failing case `$C_m` has no `global.get`, and `$test` has no
`global.set` for `s`; in the passing (fn-scope) case both appear plus a
`(global $__captured_s …)`.

This is a **class-collection-ordering + captured-globals** interaction, in the
delicate promotion subsystem (#1672 stale-global-sync hazards), NOT the
duplicate-local desync. #2820's producer-side slot reuse correctly collapses the
duplicate local but does not help here because the method never attempts the
capture.

## Direction (for the architect)

Make the captured-globals promotion fire for block-nested class methods that
reference an outer block-scoped local, with the value-sync emitted **after** the
block-let initialises (mirroring the fn-scope case). Candidate approaches to
spec/evaluate:

- Defer the block-nested class body compile (and its `promoteAccessorCaptures…`)
  to the class's textual position inside the block (after the block-let runs),
  instead of the early collected-compile — i.e. treat block-nested classes like
  `deferredClassBodies` so the promotion + sync land in-scope. Guard against the
  `#1672` stale-sync: the `local.get; global.set` must run after the block-let's
  store, and re-sync on later mutation if the method observes writes.
- Ensure `promoteAccessorCapturesToGlobals` runs even on the
  `structMap.has(className)` early-return path when the class is block-nested and
  has unpromoted outer-local references.

Edge cases to cover: `-dflt` (param-default initializers referencing the outer
local — already scanned via `extraNodes`), `-static` methods, generator /
async-generator methods, private methods, and the TDZ flag promotion
(`__tdz_<name>` global) for a `let`/`const` read before init.

## Acceptance criteria

- `{ let s="outer"; class C { m(){ return s; } } new C().m(); }` returns "outer"
  (string + numeric), and the arrow-inside-method variant too.
- The `meth-…` / `gen-meth-…` / `private-meth-…` cluster members return 1 (pass).
- No regression in fn-scope class-method capture (#1672 / accessor-captures),
  the #2820 function-declaration fix, or TDZ throws.
- `tests/issue-2818.test.ts` with the repros + a class-method cluster slice +
  fn-scope-capture regression controls.

---

## Resolution (sendev-ecmaver, 2026-06-30)

**Root cause (refined from the issue's "early-return skips promotion" framing):**
the bug was upstream of the `compileNestedClassDeclaration` early-return — in the
**eager class-body compile pass** `compileClassesFromStatements`
(`declarations.ts`). It only propagated its `insideFunction` flag when recursing
into a **function body** (`stmt.body.statements, true`); it **dropped the flag**
when recursing into `block` / `if` / `for|while|do` / `switch` / `try` /
`labeled` statements. So a class nested in such a statement *inside a function*
was treated as `insideFunction === false` and compiled **eagerly** via
`compileClassBodies` (line ~4412) instead of being added to `deferredClassBodies`.
Eager compilation happens before the enclosing function runs, so the block-`let`
is not yet a promotable local → `promoteAccessorCapturesToGlobals` never fires →
`$C_m` resolves `s` to the `ref.null.extern` fallback (the early-return at
`nested-declarations.ts:99` is then a *symptom*: `structMap.has` is true and the
class is **not** in `deferredClassBodies`, so it bails before promotion).

**Fix:** propagate `insideFunction` through every control-flow recursion in
`compileClassesFromStatements`. A function-nested class is now **deferred** and
compiled in-scope by `compileNestedClassDeclaration` (after the block-`let`
stores), where promotion + the `local.get; global.set __captured_<name>` sync
land correctly. Module-level blocks keep `insideFunction === false` (eager,
unchanged). ~9 call sites, +`insideFunction` arg each.

**Verify-first (host/gc, `buildImports`):** before → `methodCapture: null`,
`arrowInMethod: null`, `numeric: 0`, `fnScopeControl: "outer"` (control passes);
after → all return the captured value. `tests/issue-2818.test.ts` (11 cases:
string/numeric, arrow-in-method, generator/private/static methods, param-default,
mutation-observed, if-block, for-block, fn-scope control) green.

**Adjacent pre-existing bug found & filed as #2854 (NOT fixed here):** a
**doubly-nested** (if-in-for) **numeric** block-`let` *captured* by a closure
(arrow OR class method) fails Wasm validation with `ref.is_null[0] expected
reference type, found local.get of type f64` — a TDZ-flag-on-numeric-capture
bug. It reproduces on `main` with a plain arrow (no class) and is independent of
this deferral fix (broken identically before & after). Out of scope; see #2854.
