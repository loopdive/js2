---
id: 2111
renumbered_from: 1952
title: "module code (always strict) gets a mapped arguments object: parameter writes leak into arguments[i]"
status: wont-fix
sprint: 61
created: 2026-06-10
updated: 2026-06-12
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

# #2111 — module strictness ignored by `isStrictFunction`: arguments aliasing in strict code

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
export function test(): string { return f(5); }
```

| probe | wasm | node (.mjs) |
|-------|------|------|
| above | `"99,1"` | `"5,1"` |
| two-param variant | `"9,7"` | `"1,2"` |
| with `"use strict"` directive inside `f` | `"5,1"` ✓ | `"5,1"` |

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

## Closed as duplicate (2026-06-12)

Duplicate of #2119 — the same audit batch was filed twice (#2110–#2117 ≡ #2118–#2125). The high series is canonical: merged/open PRs reference #2120–#2125. No work was lost; see #2119.
