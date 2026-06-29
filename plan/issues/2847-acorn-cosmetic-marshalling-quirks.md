---
id: 2847
title: "compiled-acorn cosmetic marshalling quirks — spurious `sourceFile: null` on every node + booleans as i32 0/1"
status: ready
sprint: current
priority: low
horizon: s
feasibility: medium
created: 2026-06-29
task_type: bugfix
area: runtime
language_feature: host-marshalling
goal: acorn-dogfood
related: [1712]
umbrella: 1712
---

# #2847 — compiled-acorn cosmetic marshalling quirks (sourceFile + i32 booleans)

Surfaced by the wider acorn differential corpus
(`tests/dogfood/acorn-corpus.mjs`, #1712 umbrella). These are **cosmetic** —
they do NOT corrupt tree structure or drop identifiers — but they make every
compiled-acorn AST differ from node-acorn on nearly every node, which is why the
corpus harness classifies them as a dedicated `QUIRK` bucket so the REAL gaps
stay legible. Tracking them in one low-priority issue.

## Quirk A — spurious `sourceFile` extra field

Compiled-acorn marshals a `sourceFile` field (value `null`) onto **every** node;
node-acorn (parsed with no `sourceFile` option) does not emit the field at all.

```
extra-field   $.body[*]...sourceFile   expected (absent)   actual null
```

Seen on essentially every node of every input (45–85 occurrences per corpus
file). Fix: omit `sourceFile` from the marshalled node when unset, matching
node-acorn (it only appears when `options.sourceFile` is set).

## Quirk B — booleans marshalled as i32 0/1

Boolean AST fields (`computed`, `optional`, `static`, `generator`, `async`,
`prefix`, `delegate`, `tail`, `method`, `shorthand`, …) marshal across the host
boundary as the **number** `0`/`1` instead of a JS `false`/`true`.

```
primitive-mismatch  $...computed   expected false   actual 0
primitive-mismatch  $...optional   expected false   actual 0
```

Seen 2–31 times per corpus file. Fix: coerce i32-backed boolean node fields to
real JS booleans during host marshalling (a field-name allowlist, or a typed
`bool` marker in the export signatures).

## Why low priority

Neither quirk changes the SHAPE of the tree or the identity/value of any
identifier or literal — a consumer that reads `node.computed` still gets a
truthy/falsy value, and `sourceFile: null` is ignorable. They are tracked
because they block a _byte-exact_ differential pass and clutter the diff, not
because they break parsing.

## Acceptance

- Marshalled boolean node fields are JS booleans; `sourceFile` is absent when
  unset.
- `tests/dogfood/acorn-corpus.mjs` reports `quirkCounts` ≈ 0 across the corpus.
- No test262 regression.
