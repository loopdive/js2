---
id: 2796
title: "diff-test host path: dynamic-object own-key enumerate/copy — for-in empty, spread loses values, Object.assign loses keys"
status: done
completed: 2026-06-28
sprint: 69
created: 2026-06-28
updated: 2026-07-03
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: objects
goal: trustworthiness
related: [2787, 1243, 1271, 1336, 1630, 2804]
origin: "2026-06-28 — #2787 differential-corpus triage (cluster A2)"
---

## Resolution (2026-06-28)

Root-caused the three corpus cases as TWO distinct problems:

- **`for…in` (control/12-for-in-object.js) — a HARNESS exports-timing artifact,
  now FIXED.** The host diff-test lane ran top-level code via the wasm `start`
  section — DURING `WebAssembly.instantiate`, BEFORE `setExports` wires the
  `__struct_field_names` / `__sget_*` exports the `for…in` enumeration needs — so
  a top-level `for…in` enumerated zero keys. The standalone lane never hit this
  (it runs top-level code via an explicitly-called `_start` export AFTER
  instantiation). Added the `deferTopLevelInit` compile option: in JS-host mode
  it exports `__module_init` and skips the wasm `start` section, so the host runs
  top-level code AFTER `setExports` (symmetric with `_start`). `scripts/diff-test.ts`
  now uses it. The for-in codegen itself was already correct — it works whenever
  the struct-introspection exports are reachable. **Net diff-test corpus impact:
  +23 programs flip mismatch/runtime_error → match (86→92 of 104), 0 regressions**
  — the exports-timing artifact had been silently mis-attributing ~23 correct
  programs (top-level array/JSON/Map/struct ops) as host-vs-V8 mismatches.
  Tests: `tests/issue-2796.test.ts`.

- **object spread `{...a}` + `Object.assign` (object/02, object/12) — a genuine
  codegen representation bug, CARVED to #2804.** These stay broken even with the
  runtime fully wired (spread reads `b.x` back as NaN / wrong key order; assign
  drops source keys): the spread result is built as a dynamic `$Object` while TS
  narrows it to a closed struct, and the host `__object_assign` mirror does not
  surface closed-struct sources' own data properties. Tracked separately in
  #2804 (not an enumeration-timing issue).

# #2796 — Host-path dynamic-object own-key enumeration & copy

## Problem (cluster from #2787 diff-test triage)

Three idiomatic object programs fail in the default WasmGC + JS-host path. All
three depend on **enumerating + reading the own enumerable string keys of a
dynamically-built object literal**, and that path drops keys and/or values.

### A — `for...in` over an object yields nothing

`tests/differential/corpus/control/12-for-in-object.js`

```js
const o = { a: 1, b: 2 };
const keys = [];
for (const k in o) keys.push(k);
console.log(keys.sort().join(",")); // V8: a,b   js2wasm: "" (empty)
```

Existing issue #1243/#1271 (for-in / Object.keys enumeration) are marked `done`
but this corpus case **regresses or is uncovered** in the host path.

### B — object spread `{ ...a }` wrong key order + values become NaN

`tests/differential/corpus/object/02-spread.js`

```js
const a = { x: 1, y: 2 };
const b = { ...a, z: 3 };
console.log(Object.keys(b).join(",")); // V8: x,y,z   js2wasm: z,x,y  (wrong order)
console.log(b.x); // V8: 1       js2wasm: NaN    (value dropped)
console.log(b.z); // V8: 3       js2wasm: NaN
```

`Object.keys(b)` returns the keys (so spread does populate the bag), but in the
**wrong insertion order** and with the **copied values lost** (read back as NaN).

### C — `Object.assign` copies no keys

`tests/differential/corpus/object/12-assign.js`

```js
const t = { a: 1 };
const r = Object.assign(t, { b: 2 }, { c: 3 });
console.log(Object.keys(r).join(",")); // V8: a,b,c   js2wasm: "" (empty)
console.log(r === t); // V8: true    js2wasm: true ✓
```

Identity is preserved (`r === t`) but no own enumerable keys are copied from the
sources. Existing issue #1336/#1630 (Object.assign getters/Symbol keys) `done`
but the basic data-property copy **regresses or is uncovered** here.

## Repro

```bash
FORCE_COLOR=0 npx tsx scripts/diff-test.ts   # control/12, object/02, object/12 mismatch
```

## Root cause (hypothesis)

A shared "iterate own enumerable string keys of a dynamic object + read each
value" primitive is incomplete in the host path:

- enumeration order is not insertion order (spread reorders),
- value read-back returns NaN (the boxed value is not recovered),
- the for-in / Object.assign source-enumeration walks zero keys.

Likely centred on the dynamic-object (`$Object` / property-bag) representation
and its key-iteration + value-get helpers. Fixing the shared primitive should
flip all three together.

## Acceptance criteria

- `control/12-for-in-object.js`, `object/02-spread.js`, `object/12-assign.js`
  all match V8 in `scripts/diff-test.ts`.
- Own enumerable string keys enumerate in insertion order; spread/assign copy
  both keys **and** values.

## Notes

- High-value: object spread / assign / for-in are core ES2015+ idioms; this
  cluster also likely covers many test262 object cases. The "done" status of
  #1243/#1271/#1336/#1630 vs the corpus failure suggests these were validated on
  a narrower path (typed objects / specific test262 shapes) than the idiomatic
  untyped object literals the corpus uses — confirm regression vs current main.

## S6 provider-lane handoff (2026-10-18, PR #6672)

The regression helpers in `tests/issue-2796.test.ts` explicitly exercise the
JS-host deferred-init and start-section behavior documented above, but their
`compile()` calls still relied on the old implicit host default. S6 made an
omitted selection native-first, which changed those tests' provider family and
caused the host start-section string control to fail for an unrelated reason.

All three host-path compile sites now select
`semanticProviders: "host-assisted"`. The assertions and expected behavior are
unchanged, and the combined #2787/#2796 focused suite passes 7/7. Native-first
object enumeration/copy behavior remains covered by its own S6/standalone
lanes; this normalization preserves #2796 as a test of the host boundary it
actually documents.
