---
id: 4205
title: "Script-goal global object: top-level `this.x = v` creates no readable global binding in standalone — 137 ES5 files, and it MASKS 96 of the 118 `with` tests"
status: in-progress
assignee: ttraenkler/sendev-w25
sprint: current
created: 2026-08-07
updated: 2026-08-07
loc-budget-allow:
  - src/codegen/expressions/unary-updates.ts
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: global-object, script-goal-this
goal: es5
related: [2727, 4202, 4206, 1472, 3365]
origin: "2026-08-07 W23 census of the ES5 standalone failing residue (published standalone baseline 20260807, oracle v13). Ranked #1 by file count among unfiled levers, and #1 by unmasking value."
---

# #4205 — the script-goal global object

## The lever

**137 of the 1,365 failing ES5 standalone files** contain a script top-level
`this.<name> = …`, a top-level `var x = this;`, or a `fnGlobalObject()` call.
178 ES5 files with the same shape already pass, so the shape is not
automatically fatal — the failures are the ones that then **read the binding
back as a bare identifier**.

| | files |
| --- | --- |
| ES5 standalone failures using script top-level `this.x=` / `fnGlobalObject()` | **137** |
| …of which are also `with` tests (see #4206) | **96** |
| …not `with` (`Object/getOwnPropertyDescriptor` 8, `annexB/global-code` 8, misc 25) | **41** |
| ES5 files with the same shape that PASS (two-sided control) | 178 |

## Symptom

```js
this.p1 = 1;            // script goal, sloppy: creates a global binding "p1"
// …
if (!(p1 === 1)) { … }  // standalone: p1 reads `null`
```

`test/language/statements/with/S12.10_A1.1_T1.js` fails on **line 61** with
`p1 === 1. Actual: p1 ===null`. Its `with` block is on line 42. The `with`
semantics under test are never reached.

## Root cause

Standalone has no realm global object, and the one place that acknowledges
script-goal `this` is explicitly gated OFF for it. `src/codegen/expressions/call-builtin-static.ts:2315`:

```ts
const isScriptGlobalThisReceiver =
  arg0.kind === ts.SyntaxKind.ThisKeyword &&
  fctx.name === "__module_init" &&
  !ts.isExternalModule(arg0.getSourceFile()) &&
  !ctx.standalone &&
  !ctx.wasi;
```

The comment there is explicit that this is deliberately gOPD-local and that
"general Script `this` lowering belongs to the source-goal implementation".
Nothing else in the standalone lane turns a top-level `this.x = v` into a
binding that bare-identifier resolution can find, so the write lands nowhere
and the read answers `null`.

## Why this is the FIRST thing to fix in the ES5 push

It is the **masking head** of the `with` cluster. 96 of the 118 `with`-using ES5
standalone failures carry a top-level `this.x=`, and in the ones inspected the
global-`this` assertion fires *before* any `with` assertion. Landing #4206
(`with`) without this one moves far fewer files than its headline count
suggests; landing this one first converts those 96 from "fails for two reasons"
into "fails for one reason you can then measure".

Corollary from `[[reference_error_signature_is_not_a_bucket_boundary]]`: do
**not** count the 96 toward either issue's expected yield. They belong to
neither until both land.

## Acceptance criteria

- [ ] In script goal (non-module) standalone/WASI, a top-level `this.<name> = v`
      creates a binding readable as the bare identifier `<name>`, and
      `delete this.<name>` / `this.<name>` read-back agree with it.
- [ ] `typeof this === "object"` at script top level (this subsumes the narrower
      #2727 — close it as superseded or re-scope it to the `typeof` slice).
- [ ] A/B over the 137-file set with a pass-side control drawn from the 178
      currently-passing same-shape files; report both numbers.
- [ ] State the residual on the 96 `with`-overlap files separately from the 41
      non-`with` files — they are the two independent halves of the yield.

## Measurement provenance

Population: `classifyEdition() === 5` over the **standalone** baseline
(`ensureStandaloneBaselineJsonl`, 48,619 rows, oracle v13, 2026-08-07) —
8,931 files, 7,566 pass. Not a local run, so the provider-tier trap in
`[[reference_standalone_eval_instrument_reports_unmeasured_failures]]` does not
apply to these counts; anyone re-measuring locally must delete the provider
cache first (byte-size comparison is NOT a sufficient control — the cache key
tracks neither input nor output).
