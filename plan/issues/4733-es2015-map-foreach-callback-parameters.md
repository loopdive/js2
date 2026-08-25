---
id: 4733
title: "ES2015 Map.prototype.forEach forwards callback parameters in standalone"
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
loc-budget-allow:
  - src/codegen/map-runtime.ts
oracle-ratchet-allow:
  - src/codegen/map-runtime.ts
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: map-foreach
es_edition: es2015
goal: spec-completeness
sprint: 77
---
# #4733 — ES2015 Map.prototype.forEach forwards callback parameters in standalone

## Live baseline

The canonical honest Test262 baselines were fetched on 2026-08-25 from
`loopdive/js2wasm-baselines` (oracle version 13). The exact host and
standalone rows are:

```text
test/built-ins/Map/prototype/forEach/callback-parameters.js
  host:       pass (reached_test=true; 19:41:49)
  standalone: fail — TypeError: Cannot access property on null or undefined at 338:18
              (reached_test=true; 19:45:01)
```

The failure is the callback-parameter residual, not the adjacent
`second-parameter-as-callback-context.js` residual owned by #4725. The
standalone row reaches the test and fails while reading the first callback
result, so this slice must preserve the callback's `(value, key, map)` call
shape and native Map identity.

Minimal controls from the same baseline are:

```text
Map/prototype/forEach/deleted-values-during-foreach.js:             host pass, standalone pass
Map/prototype/forEach/iterates-values-added-after-foreach-begins.js: host pass, standalone pass
Map/prototype/forEach/iterates-values-deleted-then-readded.js:       host pass, standalone pass
Map/prototype/forEach/second-parameter-as-callback-context.js:        host pass, standalone fail (#4725; out of scope)
```

## Scope and implementation plan

1. Keep #4725's optional `thisArg` forwarding out of this change. Trace the
   native Map/Set forEach callback lowering and identify why this test's
   function-valued callback does not receive `(value, key, map)` in standalone.
2. At the narrowest native callback site, resolve the callback closure and
   coerce each backing-store value to its declared callback parameter type:
   value first, Map key second, and the Map receiver third. Preserve Set's
   `value === key` convention and insertion/deletion mutation behavior.
3. Add focused host/standalone regression coverage for two Map entries,
   callback argument order, and callback-visible Map identity; retain the
   mutation controls above and do not add `thisArg` assertions.
4. Run the exact callback body (plus its Test262 assertions), the Map/Set
   mutation controls, focused tests, TS5/TS7 typechecks, lint, format check,
   and hooks.

## Acceptance criteria

- `callback-parameters.js` passes in both host and standalone lanes.
- The three Map mutation controls remain passing in both lanes.
- The #4725 `thisArg` behavior remains separately owned and is not folded into
  this issue's implementation or budget.
- Production delta remains at or below 180 net lines.

## Test Results

Post-fix callback-body replay (the exact Test262 callback and assertions,
wrapped only in an exported numeric result for the compiler harness):

```text
host:       pass (result=1; Map_new/Map_set/Map_forEach imports)
standalone: pass (result=1; no Map_/Set_ imports)
```

Focused native callback controls (`tests/issue-4733.test.ts`) cover named
Map and Set callbacks in host and standalone lanes:

```text
Map value/key/receiver identity: host=10302, standalone=10302 — pass
Set value/key/receiver identity: host=23,    standalone=23    — pass
```

The three canonical mutation controls remain host+standalone pass in the
baseline above; no mutation lowering was changed. The adjacent
`second-parameter-as-callback-context.js` row remains standalone fail under
#4725 and is intentionally excluded.

Validation completed: production diff +53 net lines (within the 180-line
budget); TS5 and TS7 typechecks passed; lint and format checks passed;
`tests/issue-4733.test.ts` plus the existing Map/Set mutation controls passed
(`8/8` tests). The pre-commit fast hook is run as part of the authored commit.
