---
id: 2582
title: "compiled-acorn module-init: null receiver into wordsRegexp from a numeric-keyed module-object read"
status: ready
created: 2026-06-21
updated: 2026-06-21
priority: high
feasibility: hard
reasoning_effort: high
task_type: fix
area: codegen, runtime
language_feature: computed-member-access
goal: self-hosting-dogfood
sprint: Backlog
model: opus
depends_on: [1712]
related: [1712, 2542]
---

# #2582 — compiled-acorn `buildUnicodeData` throws: `Cannot read properties of null (reading 'replace')`

## Context

This is the **third** independent blocker on the compiled-acorn dogfood
(`self-hosting-dogfood` / #1712), surfaced once the tokenizer **identity loop**
was fixed (#1712 slice 2026-06-21, PR #1874). With the identity loop gone,
compiled acorn now executes far past the loop — into module-init
`buildUnicodeData` — and throws there during `WebAssembly.instantiate`'s start
function:

```
TypeError: Cannot read properties of null (reading 'replace')
    at __extern_method_call (src/runtime.ts) — method="replace", receiver=null
    at wordsRegexp (wasm)            — words.replace(/ /g, "|")
    at buildUnicodeData (wasm)
    at __module_init (wasm)
```

## The defect

acorn's `buildUnicodeData` (acorn dist ~3974) builds Unicode property
alternation regexes:

```js
function wordsRegexp(words) {
  return regexpCache[words] || (regexpCache[words] =
    new RegExp("^(?:" + words.replace(/ /g, "|") + ")$"));
}
function buildUnicodeData(ecmaVersion) {
  var d = data[ecmaVersion] = {
    binary:          wordsRegexp(unicodeBinaryProperties[ecmaVersion] + " " + unicodeGeneralCategoryValues),
    binaryOfStrings: wordsRegexp(unicodeBinaryPropertiesOfStrings[ecmaVersion]),
    nonBinary: {
      General_Category: wordsRegexp(unicodeGeneralCategoryValues),
      Script:           wordsRegexp(unicodeScriptValues[ecmaVersion]),
    },
  };
  …
}
```

`unicodeBinaryPropertiesOfStrings` is a module-level object literal keyed by
numeric ecmaVersion: `{ 9: "", 10: "", 11: "", 12: "", 13: "",
14: ecma14BinaryPropertiesOfStrings }`. For `ecmaVersion === 9`, real JS reads
`""` (empty string) and `wordsRegexp("")` returns `/^(?:)$/`. In the **compiled**
module the read `unicodeBinaryPropertiesOfStrings[ecmaVersion]` yields **null**,
so `wordsRegexp(null)` → `null.replace(...)` throws via the host bridge
(`__extern_method_call(null, "replace", …)`).

So the root cause is a **computed numeric-key member read on a module-level
object literal returning `null` instead of the stored value** — specifically
the `""` (empty-string) entries (the `14:` entry is a real identifier so it may
read fine; the `9..13: ""` entries are the ones that come back null). The
distinguishing factors vs. the simple case (which works) are some combination
of:
- the object is a **module-level global** (not a local),
- read by a **dynamic numeric key** (`obj[ecmaVersion]` where `ecmaVersion` is a
  loop var, not a literal),
- inside a `data[ecmaVersion] = { …: wordsRegexp(obj[k]), … }`
  **assignment-as-expression with a nested object literal**,
- the stored value is the **empty string `""`** (possibly mis-modeled as
  null/undefined at the boundary).

## Reproduction status (from the #1712 slice)

Minimal probes that **DID NOT** reproduce (all returned correct values, so the
trigger is more specific than each alone):
- `obj[numKey]` on a numeric-keyed object via a local key → correct.
- `obj[9]` returning `""` (empty-string value) → `=== ""` was `1`.
- a `for` loop reading `obj[ec]` and concatenating → correct.
- `wordsRegexp("")` and `wordsRegexp(props[9])` and the nested-object-literal
  `{ binaryOfStrings: wordsRegexp(props[k]), other: … }` shape → all correct.

So the next investigator must reproduce with the FULL acorn-ish shape: a
**module-global** object literal with numeric `""` entries, read by a dynamic
key inside a `data[ver] = { … }` assignment whose values are nested
`wordsRegexp(obj[ver])` calls, possibly with a sibling entry that references
another module global (`14: ecma14BinaryPropertiesOfStrings`) — the mixed
string/identifier value types in one object literal may be the trigger (the
object's inferred element type or the WasmGC field representation for a
heterogeneous numeric-keyed literal).

## Suggested approach

1. Build the full repro (module-global numeric-keyed literal with mixed
   `""`/identifier values + dynamic-key read in an assignment-expression). Probe
   driver pattern: `.tmp/drive.mjs` from the #1712 branch
   (`/workspace/.claude/worktrees/issue-1712-acorn-identity/.tmp/`).
2. Emit WAT (`compileToWat`) and inspect how the numeric-keyed module-global
   object is built and how `obj[ver]` reads — does the `""` entry get a struct
   field at all, or does the read take a fallback that returns `ref.null`?
3. Likely fixes to weigh: ensure empty-string values in a numeric-keyed object
   literal are stored (not elided as a falsy default), and that the dynamic
   numeric-key read resolves the stored field rather than falling through to a
   `null`-returning `__extern_get` arm. Cross-check against #2542 (standalone
   dynamic computed-key read/write) — this is the JS-host analog.

## Acceptance

- The full-shape repro reads `obj[ver]` as `""` (not null), and
  `wordsRegexp(obj[ver])` returns `/^(?:)$/` without throwing.
- Compiled acorn's module-init `buildUnicodeData` completes (no
  `Cannot read properties of null` during instantiate).
- No test262 / equivalence regression (this touches computed member access +
  object-literal codegen — validate broadly).
- This unblocks the next acorn dogfood step; #1712 stays open until the full
  parse + AST-match acceptance is met.
