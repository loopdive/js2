---
id: 4598
title: "STANDALONE: runtime RegExp compilation covers only the Acorn keyword shape + literal patterns — `new RegExp(s)` with a NON-CONSTANT string refuses on groups and escapes (runtime Wasm parser needed, XL)"
status: ready
sprint: current
created: 2026-08-21
updated: 2026-08-21
priority: medium
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: feature
area: runtime
es_edition: 5
language_feature: regexp
goal: es5
related: [4492, 4233, 4163]
origin: "2026-08-21 wave-2 protos lane, item-4 classification. Proven an engine gap by parity, not a dispatch bug."
---

# #4598 — dynamic RegExp needs a runtime parser

## Proof by parity (measured, wave-2 protos lane)

| form | result |
| --- | --- |
| `/(((abc)))/` literal | works |
| `new RegExp("(((abc)))")` — constant string | works (constant-folded) |
| `new RegExp(p)` — the IDENTICAL string built in a loop | **"Unsupported dynamic regular expression pattern"** |
| `\cА` as literal or constant | works |
| `"\\c" + letter` built dynamically | refuses |

So the refusal tracks **compile-time constancy of the pattern string**, not any
pattern feature. This is deliberate and documented:
`ensureDynamicStandaloneRegExpCompiler` (`src/codegen/regexp-standalone.ts:1015`)
states the runtime slice "deliberately compiles the shape Acorn executes for
keyword classification: `^(?:word|word|…)$`, plus ordinary literal patterns" —
groups and escape classes are outside it.

## What closing it needs

Porting the compile-time pattern parser to a **runtime Wasm parser** (or a
self-hosted compiled one) so a pattern string arriving at runtime gets the same
front end a literal gets at compile time. XL by construction: the compile-time
parser's feature surface is the spec's grammar.

Known rows: 3 in the ES5 standalone residue (`RegExp-leading-escape-BMP`,
`RegExp-trailing-escape-BMP` family + the loop-built-group row), plus every
future dynamic-pattern row.

## Not in scope

Dispatch is fine — this is not a routing bug, and no dispatch change can close
it. The refusal message is honest and should stay until the parser exists.
