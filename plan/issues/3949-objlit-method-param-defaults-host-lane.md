---
id: 3949
title: "Host lane: object-literal method parameter defaults are silently ignored — `{ m(a = 5) }.m()` evaluates to 0 in the DEFAULT target, no generator involved"
status: in-progress
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: s
complexity: S
feasibility: medium
task_type: bugfix
area: codegen
language_feature: default-parameters, object-literals, optional-parameters
es_edition: es6
goal: spec-completeness
related: [3948, 2581, 1451, 1053]
origin: "2026-08-01, found while root-causing #3948: the object-literal optional-param registration gap is not generator-specific and not standalone-specific. Filed separately so a host-lane default-parameter bug is not buried inside a standalone-generator issue, where nobody would look for it."
---

# #3949 — object-literal method parameter defaults ignored in the host lane

## Problem

An object-literal method with a parameter default silently ignores it. This is
ordinary JavaScript, in the **default** (JS-host) target, with no generator, no
destructuring and no standalone mode involved.

Measured on `origin/main` @ `d3854438366f`, instantiated with
`result.importObject`:

| source                                              |  JS | host lane | standalone |
| --------------------------------------------------- | --: | --------: | ---------: |
| `{ m(a = 5) { return a } }.m()`                     |   5 |     **0** |      **0** |
| `{ m(a, b = 5) { return a + b } }.m(1)`             |   6 |     **1** |      **1** |
| `{ m(a?) { return a === undefined ? 42 : a } }.m()` |  42 |     **0** |      **0** |
| `{ m(a = 5) { return a } }.m(7)`                    |   7 |         7 |          7 |

The supplied-argument case is correct, so the wrongness is confined to the
missing-argument branch — the default itself never fires.

The **class** equivalent (`class C { m(a = 5) {…} }; new C().m()`) and the free
function (`function f(a = 5) {…}; f()`) both return 5. Object literals are the
outlier.

## Root cause

Shared with #3948, which carries the full instrumented trace.
`maybeSetArgcForKnownCall` is gated on
`ctx.funcUsesArguments.has(n) || ctx.funcOptionalParams.has(n)`. Class bodies and
free functions populate `funcOptionalParams`; **object-literal methods never
did**. So the `o.m()` call site emitted no `global.set $__argc`, the global kept
its `-1` "unknown host/module-init caller" init value, and the callee's
`emitParamDefaultArgMissingCheck` (`argc != -1 && argc <= argIndex`) read that as
"no argument is missing".

Instrumented at the decision point:

```
[argc] maybeSet name=__anon_0_m paramCount=1 usesArgs=false optional=false keys=[]
[argc] maybeSet name=C_m        paramCount=1 usesArgs=false optional=true  keys=[C_m]
```

## Status — rows 1 and 2 fixed by #3948; row 3 (`?`) remains

**#3948 lands the registration in `literals.ts`**, and because the gap is one
place, that fixes the _default-initializer_ rows in **both** lanes as a side
effect. `tests/issue-3948.test.ts` carries the host-lane assertions
(`applies the default when the argument is omitted — host lane`, `applies a later
param's default — host lane`).

**What is still open here** is the `?`-optional row. With the registration in
place, `{ m(a?: number) { return a === undefined ? 42 : a } }.m()` still returns
0: `a?: number` lowers to a bare `f64`, which has no `undefined` inhabitant, so
the missing-argument branch has nothing to bind. That is a
value-representation gap, not a call-site-metadata one, and it is why #3948
deliberately keeps `param.questionToken` bailing in the native-generator
admission gate — admitting it there would trade a host-import leak for a wrong
value.

## Remaining acceptance

- [ ] `{ m(a?: number) { return a === undefined ? 42 : a } }.m()` → 42 in both
      lanes (needs an `undefined`-carrying representation for the optional param,
      or an argc-driven branch that selects an `undefined` sentinel the body's
      `=== undefined` comparison recognises).
- [ ] Once that lands, revisit the `questionToken` bail in
      `isNativeGeneratorCandidate` (`generators-native.ts`) — it is pinned by a
      test in `tests/issue-2581-objlit-method-generators.test.ts` so lifting it
      is a visible decision, not a silent drift.
- [ ] Also still open, and orthogonal: **method extraction** (`const f = o.m`
      then `f()`) sets no argc at all — the trampoline path has no call-site
      arity to record. Wrong before and after #3948 in both lanes.

## Notes

- Do **not** confuse this with #1451 (done), which covered method parameter
  _destructuring_ with non-trivial defaults. This is the plain identifier /
  optional parameter, and its mechanism is the call-site `__argc` metadata.
