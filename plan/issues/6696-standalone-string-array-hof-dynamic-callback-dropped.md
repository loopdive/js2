---
id: 6696
title: "standalone: string[].filter(cb) with a dynamic callback silently evaluates to null (the call is dropped)"
status: ready
sprint: Backlog
created: 2026-09-26
updated: 2026-09-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: arrays
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6690, 3015]
---

# #6696 — `string[]` HOF with a dynamic callback is dropped (standalone)

**Surfaced by** #6690 (measured while building its corpus; pre-existing, same
answer on the parent).

```ts
function run(cb: (s: string) => boolean) { const a: string[] = ["a", "bb"]; return a.filter(cb).length; }
export function test(): number { return run((s) => s.length > 1); }
// standalone: 0   (JS-host: 1, expected 1)
```

The same shape over `number[]`, or with an inline arrow over `string[]`, is
correct. A silent wrong answer, not a trap.

## What the WAT shows

`run` compiles `a.filter(cb)` to `drop(__extern_get(a, "filter"))` followed by
a `ref.null` receiver for `.length` — the array-method call is never emitted;
the native-string element vec (`$__vec_ref_<AnyString>`) with an externref
callback falls out of `compileArrayMethodCall` and into a generic property-get
fallback that discards the call.

## Next step

Find where the native-string-element receiver + externref callback leaves
`compileArrayMethodCall` (`src/codegen/array-methods.ts`) without a result and
route it through `setupArrayCallback`'s dynamic-callback arm (#3015/#6690).
