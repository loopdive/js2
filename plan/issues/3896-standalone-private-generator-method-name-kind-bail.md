---
id: 3896
title: "Standalone: private generator methods (`*#m()`) leak the host generator machinery — a `PrivateIdentifier` fails an `isIdentifier` bail written for computed/string object-literal names"
status: done
completed: 2026-07-31
sprint: 78
created: 2026-07-31
updated: 2026-08-18
priority: high
horizon: m
complexity: S
feasibility: easy
task_type: bugfix
area: codegen
language_feature: generators, class-methods-private
es_edition: multi
goal: standalone-mode
umbrella: 3178
assignee: ttraenkler/dev-es3-editions
related: [3178, 3893, 2571, 2864]
origin: "2026-07-31: #3178 recorded the hypothesis that private methods never REACH the admission gate at class-bodies.ts. Instrumenting the gate falsified it in one step — they reach it and are rejected by isNativeGeneratorCandidate."
---

# #3896 — private generator methods bail on a name-kind check

## The recorded hypothesis was wrong

#3178 carried: _"private methods never reach the admission gate at
`class-bodies.ts:1176`; the likely mechanism is `__priv_` mangling."_
**Falsified by instrumenting the gate.** Compiling a class with one public and
one private generator, standalone lane:

```
[probe] gate reached: name=C_m          noJsHost=true async=false candidate=true
[probe] gate reached: name=C___priv_p   noJsHost=true async=false candidate=false
```

Both reach it. The private one is rejected by **`isNativeGeneratorCandidate`
itself**. And the name is already `C___priv_p`, so the `__priv_` mangling has
**already happened** and the funcMap key is well-formed — the other half of the
hypothesis is dead too.

## Root cause — one condition, `src/codegen/generators-native.ts`

```ts
// (#2571) An object-literal method with a computed/string name
// (`{ [k]*(){} }`, `{ "m"*(){} }`) is out of scope — only an identifier-named
// method threads cleanly through the funcMap key.
if (ts.isMethodDeclaration(decl) && !ts.isIdentifier(decl.name)) return false;
```

**A `PrivateIdentifier` is a distinct AST node kind — `ts.isIdentifier(#p)` is
`false`.** So every private generator method bails on a check written to exclude
**computed/string-named object-literal** methods. Private names were pure
collateral.

### Why admitting them cannot widen the bail's intended scope

**A private name can only occur in a class body.** The shapes the bail exists
for — `{ [k]*(){} }`, `{ "m"*(){} }` — are object-literal members and can never
be `PrivateIdentifier`s. So the fix is safe **by construction**, not merely by
testing; the intended exclusions are unreachable by the new arm. A regression
test pins them anyway.

## Verification — import set + no-import instantiation

**Instrument note (load-bearing):** `runTest262File(..., "standalone")` is
**unusable** for this question — it supplies the host imports, so a leaking
module still scores `pass`. Measured pre/post byte-identical on a sibling slice
(#3893). The valid checks are a bare standalone compile's import set and
instantiating with **no import object**.

| case                                    | pre-fix imports | post-fix                   | value |
| --------------------------------------- | --------------: | -------------------------- | ----: |
| `*#p()`                                 |               5 | **none**                   |   7 ✓ |
| `*#p({x})` binding-pattern param        |               5 | **none**                   |   5 ✓ |
| `static *#p()`                          |               5 | **none**                   |   3 ✓ |
| `*#p(a)`, two yields (resume)           |               5 | **none**                   |  45 ✓ |
| CONTROL public `*m()`                   |            none | none                       |   9 ✓ |
| CONTROL private non-generator `#m()`    |            none | none                       |   2 ✓ |
| CONTROL `{ *"m"(){} }` / `{ *[k](){} }` |           leaks | **still leaks** (intended) |     — |

The 5 leaked imports are `__gen_create_buffer, __gen_push, __create_generator,
__gen_next, __get_caught_exception`.

**Kill-switched**: restore the `!ts.isPrivateIdentifier` arm and all of
`tests/issue-3896.test.ts` fails with
`Import #0 "env": module is not an object or function`.

## This explains the one-token table on #3178

- `*m()` → 0 · `*#m()` → 4 — public passes `isIdentifier`, private does not.
- `*m([a])` → 0 · `*#m([a])` → 8 — pattern params are orthogonal; the name-kind
  bail fires first.
- `#m()`, `#v` → 0 — non-generators never reach this branch.
- **`async *#m()` → 0 was never evidence about the sync path.** Async methods are
  excluded by `!isAsyncMethod` _before_ the candidate call, so they never reach
  the bail at all. Reading them as an "upper bound on what sync is missing" was
  a different route mistaken for a nearby one.

It also matches the independent baseline observation that class rows leak **with
and without** a parameter default: this is a name-kind bail, not a param bail.

## Follow-up recorded for #3178 — the `object/*` 102 rows are a THIRD family

Asked while here: are the 102 leaking `object/*` rows the bail's _intended_
exclusions, or more collateral? **Neither wholly — they are a distinct defect.**
Measured, standalone lane, this branch:

| shape                        | result                     |
| ---------------------------- | -------------------------- |
| `{ *m() {} }`                | native                     |
| `{ *m({x}) {} }`             | native                     |
| **`{ *m({x} = {…}) {} }`**   | **LEAKS**                  |
| **`{ *m(a = 1) {} }`**       | **LEAKS**                  |
| `{ *"m"() {} }`              | leaks — _intended_ (#2571) |
| `{ *[k]() {} }`              | leaks — _intended_ (#2571) |
| `class { *m({x} = {…}) {} }` | **native**                 |

So identifier-named object-literal generators are fine; it is a **parameter
default on an object-literal method** that leaks — while the _identical class
method_ does not. That asymmetry is the unowned defect behind the 102, and it is
neither the #2571 name bail nor #3893 (whose predicate is fn-expr-only).
**Unowned — needs a slice.**
