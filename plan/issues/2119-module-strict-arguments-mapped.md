---
id: 2119
renumbered_from: 1952
title: "module code (always strict) gets a mapped arguments object: parameter writes leak into arguments[i]"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/tld-1921
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: arguments
goal: core-semantics
related: [779, 1511, 833, 849]
origin: "2026-06-10 deep-audit sweep (closures agent): verified miscompile on main"
---

# #2119 — module strictness ignored by `isStrictFunction`: arguments aliasing in strict code

## Problem

ES modules are always strict, and strict functions get an **unmapped**
arguments object ([§10.4.4](https://tc39.es/ecma262/#sec-arguments-exotic-objects)):
parameter writes must NOT be visible through `arguments[i]`. The compiler
installs the mapped (sloppy) arguments for all directive-less functions —
i.e. for every genuine module input.

## Repro (verified on main)

```ts
function f(a: number): string {
  a = 99;
  return "" + arguments[0] + "," + arguments.length;
}
export function test(): string {
  return f(5);
}
```

| probe                                    | wasm      | node (.mjs) |
| ---------------------------------------- | --------- | ----------- |
| above                                    | `"99,1"`  | `"5,1"`     |
| two-param variant                        | `"9,7"`   | `"1,2"`     |
| with `"use strict"` directive inside `f` | `"5,1"` ✓ | `"5,1"`     |

The control shows the unmapping logic exists and works — only module
strictness is ignored.

## Root cause

`src/codegen/helpers/is-strict-function.ts:29-33` — `isStrictFunction`
deliberately does not infer ES-module strictness (comment: the compiler wraps
every program in a synthetic entry point, which would make every test262
sloppy-mode source "a module" and wrongly unmap). So `emitArgumentsObject`
(`src/codegen/statements/nested-declarations.ts:1291-1303`) installs
`mappedArgsInfo` (#849) for all directive-less functions. The tradeoff
optimizes test262 sloppy passes at the cost of wrong semantics for the
product's actual input language (TS/ES modules).

## Fix direction

Distinguish the test262 harness wrapper from real module compilation: a
compiler flag, or detect genuine top-level import/export in the original user
source before wrapping, and pass `unmapped=true` for module-strict functions.
Long-term, gate sloppy behaviors behind the #833 sloppy-mode umbrella.

## Acceptance criteria

- Module-input repro matches Node (`"5,1"`)
- test262 sloppy-mode arguments-mapping tests do not regress (harness path
  keeps mapped behavior)
- `"use strict"`-directive path unchanged

## Dupe check

Grepped `arguments.*strict`, `unmapped`, `mapped`, `module.*strict`:
#779e/#1511 (directive-based split, done), #833 (sloppy umbrella, ready — notes
modules are always strict but doesn't cover this contradiction). Documented
only in a source comment; tracked nowhere.

## Resolution (2026-06-16)

`isStrictFunction` (`src/codegen/helpers/is-strict-function.ts`) now infers
ES-module strictness, so module functions get the **unmapped** arguments
object — but it keys on the **genuine** module signal only, avoiding the
over-unmap the old comment feared:

- A new `isModuleSourceFile(sf)` helper returns true iff the SourceFile carries
  a top-level `import`/`export` (TypeScript's internal
  `externalModuleIndicator`) or an ESM `impliedNodeFormat`. The
  SourceFile-scope branch of `isStrictFunction` now ORs this in alongside the
  existing `"use strict"`-prologue check.
- It deliberately does **NOT** key on `scriptKind`: the test262 harness
  compiles every sloppy `.js` case with `fileName: "test.ts"` (→ `scriptKind:
TS`), so keying on that would wrongly unmap all of them. Verified empirically
  that a sloppy `.js` source compiled as `test.ts` has
  `externalModuleIndicator === undefined` → stays sloppy/mapped, while a source
  with a top-level `export` has it set → unmaps. (This is the distinction the
  Fix-direction note asked for, done via the genuine signal rather than a flag.)

`isStrictFunction` has exactly 4 consumers, all the `emitArgumentsObject`
mapped/unmapped decision (function-body.ts, literals.ts,
nested-declarations.ts ×2), so the change is scoped to the arguments object and
does not alter function-declaration scoping or other strict-mode behaviours.

### Acceptance criteria

- [x] Module-input repro matches Node — the numeric variant (`a = 99;
arguments[0]*10 + arguments.length` with `f(5)`) returns `51` (unmapped, =
      Node), not `991` (mapped). Verified via `assertEquivalent`.
- [x] test262 sloppy-mode arguments-mapping does not regress — a sloppy source
      with no import/export stays mapped (`isStrictFunction` returns false; unit
      test pins this). Broad test262 conformance delta verified by sharded CI.
- [x] `"use strict"`-directive path unchanged (unit test).

### Test Results

- `tests/equivalence/issue-2119-module-strict-arguments.test.ts` — 5/5:
  1- and 2-param module-arguments-unmapped equivalence cases (vs Node), plus
  unit-level `isStrictFunction` checks for sloppy (false) / module (true) /
  `"use strict"` (true).
- No new failures across the arguments / strict / closures / function
  equivalence suites. (One pre-existing failure in
  `arguments-nested-and-loops` — "for-loop with function declaration in body",
  a function-decl-in-block hoisting bug — fails **identically on
  `origin/main`**, unrelated to this change.)
- `npm run typecheck` + `npm run lint` (Biome) clean.
