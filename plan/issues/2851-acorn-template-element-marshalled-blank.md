---
id: 2851
title: "compiled-acorn marshals TemplateLiteral `quasis[]` TemplateElement nodes BLANK (type/value/tail dropped across host boundary)"
status: ready
sprint: current
priority: high
horizon: m
feasibility: medium
created: 2026-06-29
task_type: bugfix
area: codegen, runtime
language_feature: template-literals
goal: acorn-dogfood
related: [1712, 2841, 2852]
umbrella: 1712
---

# #2851 — compiled-acorn marshals `quasis[]` TemplateElement nodes blank

Surfaced by the wider acorn differential corpus (`tests/dogfood/acorn-corpus.mjs`,
under the #1712 umbrella). Compiled-acorn **parses** template literals without
throwing, but the `TemplateElement` nodes that populate a `TemplateLiteral`'s
`quasis[]` array come back across the JS-host boundary as **blank objects** —
every meaningful field is missing.

## Divergence (compiled-acorn vs node-acorn, same pinned acorn@8.16.0)

For `templates.js`, `escapes-unicode.js` (any source with a template literal):

```
missing-field  $.body[*].declarations[*].init.quasis[*].type    expected "TemplateElement"  actual undefined
missing-field  $.body[*].declarations[*].init.quasis[*].value   expected {raw,cooked}        actual undefined
missing-field  $.body[*].declarations[*].init.quasis[*].tail    expected true/false          actual undefined
```

Also affects tagged templates (`TaggedTemplateExpression.quasi.quasis[*]`) and
nested template expressions (`...init.expressions[*].quasis[*]`).

The `quasis` ARRAY itself has the correct length (no `array-length-mismatch`) —
it is the _element_ `TemplateElement` objects that are emptied, so the cooked /
raw string content of every literal chunk is lost.

## Minimal repro

```js
const b = `hello ${name} world`;
```

node-acorn: `quasis: [ { type:"TemplateElement", value:{raw:"hello ",cooked:"hello "}, tail:false }, { type:"TemplateElement", value:{raw:" world",cooked:" world"}, tail:true } ]`

compiled-acorn: `quasis: [ {}, {} ]` (each element blank; only the cosmetic
`sourceFile`/i32-bool marshalling quirks remain — see #2847).

## Suspected root cause

A host-marshalling gap: `TemplateElement` nodes reached as **array elements**
of `quasis` are not read field-by-field. This is plausibly the **same
marshalling mechanism** as #2841 (arrow/fn-expr `params[]` Identifier nodes lose
`name`/`type`) and #2852 (SequenceExpression `expressions[]` children blank) —
all three are "node-typed elements of a specific array property come back
without their fields." Investigate `wrapExports` / the struct→JS node
marshalling for array-of-struct fields, and whether `TemplateElement`'s
`value: {raw, cooked}` nested object struct is the trip. May share a fix with
#2841/#2852.

## Acceptance

- `tests/dogfood/acorn-corpus.mjs` shows `corpus/templates.js` and
  `corpus/escapes-unicode.js` as `equal` / `equal-modulo-quirks` (no REAL
  divergence on `quasis[*]`).
- A focused equivalence test asserting a marshalled `TemplateLiteral` carries
  `type`, `value.raw`, `value.cooked`, `tail` on each `quasis` element.
- No test262 regression.
