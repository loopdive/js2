---
id: 2008
title: "tagged templates broken: cooked elements read as undefined, .raw access traps, String.raw throws (template object unusable)"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: template-literals
goal: core-semantics
related: [363, 141, 1445]
origin: "2026-06-10 spec-conformance sweep (strings agent): verified on main"
---

# #2008 — template object struct unreadable by element/property access

## Problem

```ts
function tag2(strings: TemplateStringsArray, ...vals: any[]): string {
  return "s0=" + strings[0] + ",s1=" + strings[1];
}
tag2`a${1}b`        // wasm: "s0=undefined,s1=undefined"   node: "s0=a,s1=b"
String.raw`a${1}b`  // wasm: TypeError: Cannot convert undefined or null to object
                    // node: "a1b"
```

Observed: `strings.length` → 2 (correct); `strings[0]` → undefined;
`strings.raw[0]` → `RuntimeError: illegal cast`; `[...strings]` → `[]`.
Substitution values arrive correctly.

## Root cause

`src/codegen/string-ops.ts:463-572` (`compileTaggedTemplateExpression`)
builds a 3-field template vec `{length, data, raw}`; indexed element
access / `.raw` property access / host marshaling of that struct read the
wrong representation (length survives, elements don't), so the template
object is unusable. Regression/incompleteness of #363 + #141 (both done).

## Fix direction

Make the template object an ordinary string vec with a parallel `raw` vec
(matching how arrays are read), or teach element/property access to
recognize the template struct. Cover host marshaling for String.raw.

## Acceptance criteria

- Both repros match Node; `strings.raw[i]`, `strings.length`, spread work
- Substitution values unchanged

## Dupe check

#109/#141/#363 done; #1445 (in-review) covers String.raw *argument
coercion*, not total breakage. New.
