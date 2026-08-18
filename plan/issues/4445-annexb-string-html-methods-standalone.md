---
id: 4445
title: "annexB String.prototype HTML methods (anchor/big/…/sup) return undefined in standalone — implement CreateHTML natively"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-08-15
updated: 2026-08-18
assignee: claude/es6-standalone-session
priority: high
horizon: s
feasibility: medium
task_type: conformance
area: codegen
es_edition: es6
goal: standalone-mode
related: [4444, 3256, 2175]
loc-budget-allow:
  - src/codegen/array-object-proto.ts
func-budget-allow:
  - src/codegen/array-object-proto.ts::emitStringProtoMemberBody
---

# #4445 — annexB String HTML methods: implement CreateHTML in standalone

## Problem

All 13 annexB §B.2.3 String.prototype HTML wrapper methods — `anchor`, `big`,
`blink`, `bold`, `fixed`, `fontcolor`, `fontsize`, `italics`, `link`, `small`,
`strike`, `sub`, `sup` — are unimplemented in the standalone lane. Method calls
compile but produce `undefined`.

**79 non-passing ES2015 tests** under `annexB/built-ins/String/prototype/*`
(6-7 per method). Per-method breakdown of the 6 failures:

- `B.2.3.N.js` (functional: `"42".anchor(42) === '<a name="42">42</a>'`) — fixed here
- `this-val-tostring-err.js` (RequireObjectCoercible + ToString(this) abrupt) — fixed here
- `length.js`, `name.js`, `prop-desc.js`, `not-a-constructor.js` — method
  reflection, owned by #2175/PR #4553 machinery; NOT this issue's scope. If the
  method-meta machinery on main covers self-hosted string helpers, wire it; do
  not build new reflection machinery here.

Spec (B.2.3.2.1 CreateHTML): `ToString(RequireObjectCoercible(this))`, then
`"<" + tag + (attr ? " " + attr + '="' + ToString(value).replaceAll('"', "&quot;") + '"' : "") + ">" + S + "</" + tag + ">"`.

## Implementation Plan (fable, 2026-08-15)

The string family has a **self-hosted stdlib mechanism** (#3256): TS source in
`src/stdlib/strings.ts` (`SELF_HOSTED_STRING_HELPERS`, ~L276-346) is compiled
through the compiler's own IR pipeline by
`src/codegen/native-strings-selfhost.ts` (`emitSelfHostedStringHelpers`), which
registers each unit in `ctx.nativeStrHelpers` under its `canonicalName`.
`repeat`/`padStart`/`padEnd` are the model.

1. **Stdlib unit** — add to `src/stdlib/strings.ts` one generic helper:
   `__sh_str_createHTML(s: str, tag: str, attr: str, value: str, hasAttr: i32) -> str`
   (or a `str`-only ABI using an empty-attr sentinel if the i32 param needs a
   thunk — follow the existing `thunk` pattern at ~L329). Body: pure string
   concat + a quote-escape loop (`replaceAll('"', "&quot;")` — check what
   self-hosted units may call; if `replaceAll` isn't available in the
   self-hosted subset, write the scan/concat loop manually like the pad family).
   Register `canonicalName: "__str_createHTML"`.
2. **Dispatch** — `src/codegen/string-ops.ts` has the per-method call-site
   dispatch (`if (method === "startsWith") { … ctx.nativeStrHelpers.get(...) }`,
   ~L3032). Add one arm for the 13 method names via a small
   `HTML_METHODS: Record<name, {tag, attr}>` table (per B.2.3.2-15:
   anchor→a/name, link→a/href, fontcolor→font/color, fontsize→font/size, the
   other 9 have no attribute). Compile receiver with the existing
   `compileReceiverToLocal` (this already carries the
   RequireObjectCoercible/ToString semantics the other methods use — verify
   with `this-val-tostring-err.js`, which requires the abrupt completion from
   `ToString(this)` to propagate), the attr value with
   `compileStringValueToLocal(expr.arguments[0], "undefined", …)` (note: spec
   passes the value through ToString, so `undefined` → the literal string
   `"undefined"` — same as the search-family default), then
   `call __str_createHTML`.
3. **Method-name lists** — add the 13 names wherever string proto method names
   are enumerated so the dispatch is reachable: check
   `src/codegen/array-object-proto.ts` ~L210 region ("repeat" appears in a
   method-name list) and `numeric-property-analysis.ts` ~L249; grep for an
   existing `"repeat"` entry and mirror it.
4. **gc lane** — the JS-host lane already passes these via host strings; make
   the new arm either standalone-only (`ctx.nativeStrings`) or verify it is
   semantically identical in both lanes (preferred if cheap). Do not regress
   the gc baseline.

## Validation

- Scoped run (~2 min): `TEST262_TARGET=standalone TEST262_PATH_FILTER="annexB/built-ins/String/prototype" pnpm run test:262`
  Expect: the 13 `B.2.3.*.js` + 13 `this-val-tostring-err.js` flip to pass
  (26); reflection files stay failing unless method-meta already covers them.
- Unit test: `tests/issue-4445-annexb-html-methods.test.ts` compiling
  `"_".anchor('"x"')` (quote escaping), `"".link(undefined)`, and an abrupt
  `{toString(){throw …}}` receiver, both targets.
- Equivalence guard: `npm test -- tests/equivalence.test.ts` unaffected.

## Result (2026-08-15, Opus implementation — dev-4445-html)

**Standalone 17/111 → 95/111 (+78) on the issue filter; the 13 HTML method
dirs went 4/82 → 82/82. gc lane unchanged: 108/111 before and after, same 3
failures file-for-file (official wrapper, all four arms).**
A/B-measured against reverted HEAD copies, not inherited from an artifact.
Correction (agent's own late re-measure): an earlier draft quoted gc as
92/111 from a fast in-process driver; the 16-row gap was `strict rerun` rows
the sharded path builds from a harness assembly the driver doesn't use. The
official-wrapper figures above supersede it; the "gc unchanged" conclusion is
unaffected.

The plan's premise was stale: #3069 had already landed the native direct-call
CreateHTML lowering. The actual gap was the VALUE-ERASED shape —
`String.prototype.anchor.call(x, v)` — because the 13 names were missing from
`STRING_PROTO_METHODS` in `src/codegen/array-object-proto.ts`. Fix: 13 names
into that CSV + 9 zero-arities into `PROTO_METHOD_LENGTH` + a reflective
CreateHTML closure body (`src/codegen/string-proto-html.ts`, spec-order
RequireObjectCoercible → ToString(this) → ToString(value)+quote-escape) reusing
the #3069 tag table (moved to `html-wrapper-native.ts` behind an own-property
accessor `htmlWrapperFor`). The reflection files (length/name/prop-desc/
not-a-constructor) flipped for free via the existing method-meta machinery —
no new reflection machinery was built. Also fixed a latent hazard: bare
`HTML_WRAPPER_TAGS[member]` answered inherited `Object.prototype.toString` for
`member === "toString"`, which would have compiled
`String.prototype.toString.call(x)` to `"<undefined>x</undefined>"`.

**Follow-up worth its own issue**: `trimLeft`/`trimRight` have the identical
CSV defect (6 tests) — 4 flip by adding the names; `reference-trimStart/End`
additionally need alias identity (`trimLeft === trimStart`), which the CSV
mechanism cannot express. Residual annexB String failures (16) are all
non-HTML members: #1474 dynamic-regexp refusals, `substr` coercion, the trim
aliases.
