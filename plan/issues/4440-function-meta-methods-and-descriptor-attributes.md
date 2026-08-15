---
id: 4440
title: "Function meta R1/R-attr slice — method name/length + own-property descriptor attributes (writable/enumerable/configurable)"
status: in-progress
sprint: current
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: function-properties
goal: standalone-gap
related: [4437, 4436, 2896]
origin: "2026-08-15 ES5-standalone campaign wave 8 — #4437's R1 residual (class/object METHODS decline the meta) plus the descriptor-attribute family ('Expected obj[length] NOT to be writable' x4, Function/length 6 ES<=5 non-pass)."
---

# #4440 — function meta for METHODS + own-property descriptor attributes

## Problem

Two adjacent residuals #4437 left with owners-unassigned:

1. **R1 — methods decline the meta.** `ensureMethodClosureSingleton` receives
   a name + funcIdx, not a declaration node, so class/object-literal methods
   have no `$fnmeta` and `name`/`length` reflection declines. All 8 remaining
   `*length-dflt.js` files sit here. Method `name` needs the `get `/`set `
   prefix rule and symbol-key handling (§10.2.9 SetFunctionName).
2. **Descriptor attributes.** `length`/`name` are now own DATA properties on
   plain functions (#4437), but their gOPD attributes must be
   `{ writable:false, enumerable:false, configurable:true }` per ES2015+/
   §15.1.5 ES5 (non-configurable in ES5 — test262 tests the MODERN attributes;
   follow what the failing files assert). Fresh-baseline signatures:
   `Expected obj[length] NOT to be writable, but was.` ×4;
   `built-ins/Function/length` 6 non-pass (S15.3.5.1_A2_T*/A3_T* —
   DontDelete/ReadOnly probes via assignment and delete).

## Implementation Plan

1. Base on #4437's modules: `function-instance-meta.ts` (write side),
   `function-instance-meta-arms.ts` (read side), `function-instance-props.ts`.
   Read #4437's issue file first — the nominal-struct discriminator rationale
   and the `$arity` no-repoint constraint both bind here.
2. R1: thread the declaration (or at minimum `{name, prefix-length}`) into
   `ensureMethodClosureSingleton`'s callers so methods intern a meta too.
   Where the declaration is genuinely unavailable, keep the decline.
3. Attributes: the reflection arms (`hasOwnProperty`/gOPD/`__extern_get`)
   answer for `length`/`name`; extend the gOPD synthesis to report the spec
   attribute triple, and make WRITES respect writable:false (sloppy silent
   no-op, strict TypeError — check what `__extern_set_strict` needs) and
   `delete` respect configurable per the asserted edition semantics.
4. Verify: the 8 `*length-dflt.js` files; `built-ins/Function/length/*`
   (6 non-pass; S15.3.5.1_A2_T1-3, A3_T1-3); the `Expected obj[length] NOT
   to be writable` ×4; #4437's 19-test pin + #4436's 23-test pin stay green;
   140-file closure-heavy control from #4437's methodology.

## Acceptance criteria

- ≥6 of the named files flip; zero regressions in the control set; gc/host
  byte-identical; non-flips root-caused here with owners.
