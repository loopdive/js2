---
id: 3301
title: "eval-inlined regex literal: dynamic property read of .flags returns undefined"
status: done
assignee: ttraenkler/dev-conform
created: 2026-07-16
updated: 2026-07-17
completed: 2026-07-17
priority: medium
feasibility: medium
task_type: bug
language_feature: eval
goal: runtime-eval
sprint: current
es_edition: ES5
# (#3102) The externClasses "RegExp" guard in compileRegExpLiteral (the correct
# home for regex-literal lowering) grows typeof-delete.ts a few LOC; net across
# the change-set is a reduction (removed the containsRegexLiteral guard/helper).
loc-budget-allow:
  - src/codegen/typeof-delete.ts
---

# #3301 — eval-inlined regex literal: dynamic `.flags` read returns undefined

## Problem

Found while widening the Tier-0 constant frontier for #1102. On current
`main` (pre-existing, host mode):

```ts
export function getFlag(): any {
  const r: any = eval("/abc/i"); // constant string → Tier-0 splice (#1163)
  return r.flags; // undefined  ← BUG (expected "i")
}
```

The spliced regex IS a real host RegExp — `instanceof RegExp` is true,
`String(r) === "/abc/i"`, `r.test("xABCx") === true`, `r.source === "abc"` —
but the **dynamic property read** `r.flags` (through an `any`-typed local)
returns `undefined`. The identical dynamic read on a **non-eval** regex
literal in the same function returns `"i"` correctly:

```ts
const r: any = /abc/i;
return r.flags; // "i" ← works
```

So the compiler has two regex-literal lowering arms (checker-typed real node
vs. foreign eval-body node, and/or the dual regex backend #682), and the
foreign-node arm produces a value the dynamic property reader serves
incompletely (`flags` missing; `source`/`test` fine). This violates ladder
invariant L1 (no silent wrong values —
`docs/architecture/runtime-eval-interpreter.md` §12).

## Repro

`.tmp`-style probe (host mode, `buildImports` + `setExports`):

- `eval("/abc/i").flags` → `undefined` (expected `"i"`)
- `eval("/" + "abc" + "/" + "i").flags` → `undefined` (concat literal, same)
- non-eval `/abc/i` `.flags` via `any` → `"i"` (correct)

## Containment (already landed with #1102)

`tryStaticEvalInline` / `synthesizeStaticNewFunction` hold **widened**
constants (const-binding / template-substitution resolved, i.e. shapes that
were dynamic before #1102) to a stricter bar: a parsed body containing a
`RegularExpressionLiteral` bails to the dynamic path (`containsRegexLiteral`
guard in `src/codegen/expressions/eval-inline.ts`). Literal shapes keep the
pre-existing behavior (they already inlined, defect and all), so nothing
regressed — but the literal-shape defect itself remains and is THIS issue.

## Acceptance criteria

- [ ] `eval("/abc/i").flags === "i"` (host mode, dynamic read through `any`)
- [ ] Root cause documented: which lowering arm the foreign regex node takes
      and why the dynamic reader misses `flags` (property table? boxed
      wrapper? host-reflection gap?)
- [ ] Remove the `containsRegexLiteral` widened-bail in `eval-inline.ts`
      once the underlying arm is fixed (grep `#3301`), so widened constants
      inline regex bodies too
- [ ] No regression in `tests/issue-1229.test.ts` (peephole shapes) and
      `tests/issue-1102.test.ts`

## Related

- #1102 (const-binding constant-frontier widening — filed this)
- #1163 (constant-string eval splice)
- #682 (dual RegExp backend)
- #1229 (eval/RegExp peephole)

## Resolution

Root cause (WAT + host-import trace confirmed): the eval-spliced regex and a
non-eval regex literal emit byte-identical code — `RegExp_new(pattern, flags)`
then `__extern_get(r, "flags")` — but their `RegExp_new` import DESCRIPTORS
differ:

- non-eval `/abc/i`: `intent: {type: "extern_class", className: "RegExp", action: "new"}`
- eval `eval("/abc/i")`: `intent: {type: "builtin", name: "RegExp_new"}`

`compileRegExpLiteral` (`src/codegen/typeof-delete.ts`) registers `RegExp_new`
on-demand but relied on the pre-codegen scan (`registry/imports.ts`, which walks
a `RegularExpressionLiteral` in the REAL source AST) to seed
`ctx.externClasses["RegExp"]`. An eval-spliced regex is a FOREIGN node the scan
never walks, so `externClasses` lacked "RegExp" → the manifest resolver routed
`RegExp_new` to the **"builtin" no-op that returns `undefined`** → `RegExp_new`
returned `undefined` at runtime, so every dynamic property read (`.flags`,
`.source`, …) read `undefined`. (`instanceof`/`String()` happened to still work.)

Fix:

- `src/codegen/typeof-delete.ts` — `compileRegExpLiteral` now registers the
  minimal `externClasses` "RegExp" entry before the import, so the resolver
  routes to the real RegExp constructor. Mirrors the eval-concat peephole in
  `expressions/calls.ts` (which already did this for `eval("/" + X + "/")`).
- `src/codegen/expressions/eval-inline.ts` — removed the two
  `containsRegexLiteral` widened-constant bails (and the now-unused helper): the
  underlying arm is fixed, so widened-constant eval bodies containing a regex
  literal inline correctly.

## Test Results

`tests/issue-3301.test.ts` — 8/8 pass: `eval("/abc/i").flags === "i"`, `.source`,
multi-flag `.flags`, `.multiline`, real `.test()`/`.match()`, `instanceof`/
`String()` guards, parity with the non-eval literal's `.flags`, and a
widened-constant regex body inlining correctly (guard-removal coverage).

Acceptance regression guards green: `issue-1102`, `issue-1229`,
`issue-2923-eval-const-broaden` (46 tests), plus `regexp`, `issue-1055`,
`issue-2671-regexp`. `npx tsc --noEmit` clean; prettier clean; oracle-ratchet
clean (checker usage +0). (The 4 pre-existing `issue-682` standalone "refuses …"
failures fail identically on clean `origin/main` — stale refusal assertions,
orthogonal to this change.)
