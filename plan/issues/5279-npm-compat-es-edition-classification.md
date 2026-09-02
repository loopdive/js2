---
id: 5279
title: "Classify each npm-compat package by the ECMAScript edition it requires"
status: done
sprint: current
created: 2026-09-02
updated: 2026-09-02
completed: 2026-09-02
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: tooling
area: tooling, dogfood, website
language_feature: n/a
goal: dogfood
related: [1710, 3781, 3958]
files:
  - scripts/lib/es-edition.mjs
  - scripts/lib/npm-compat-es-edition.mjs
  - scripts/generate-npm-compat-report.mjs
  - website/components/npm-compat-chart.js
  - tests/es-edition-classifier.test.ts
origin: "user: we should classify the npm packages by the ES edition they require"
---

# #5279 — classify each npm-compat package by the ECMAScript edition it requires

## Problem

The npm-compat dashboard said whether each package compiles, validates and
passes its tests, but not what the package actually asks of the compiler. So
"acorn passes, tailwindcss does not" carried no signal about _why_, and the
corpus could not answer the one question that orders the work: **which
ECMAScript edition must the compiler support to run real npm code?**

Without it, a failure and a feature gap look the same on the card.

## What it does

Every package row now carries an `esEdition` classification: the newest edition
required by the package's **own module graph**, walked from its published entry
module and stopping at the package boundary.

Two axes are reported separately, because they cost different work and fail
differently:

| Axis         | Means                                        | Example                           |
| ------------ | -------------------------------------------- | --------------------------------- |
| **syntax**   | grammar the parser and codegen must accept   | `a?.b` is ES2020 — unpolyfillable |
| **builtins** | library surface the runtime must provide     | `Object.entries` is ES2017        |

The split is not academic: react's grammar is **ES5** (it ships transpiled)
while its runtime needs **ES2021** `AggregateError`. A compiler that "supports
ES5" does not run react.

### The library map is derived, not hand-written

TypeScript ships one `lib.es<year>.<area>.d.ts` per edition per area — the
authoritative, maintained statement of which edition introduced which global,
static and prototype member. The classifier reads those files and builds the
map from them, so a new edition lands without anyone editing a table, and every
classification is traceable to a lib file. `lib.es*.intl.d.ts` is excluded:
Intl is ECMA-402, a separate standard, and counting it would report a package
as needing ES2020 for `Intl.DisplayNames`.

### What it refuses to claim

The number is only worth reading if it never over-reports, so three cases
deliberately do **not** raise the edition:

- **A bare prototype-method read.** `x.flat()` is only `Array.prototype.flat`
  if `x` is an Array, which needs type information this classifier does not
  use. Recorded as evidence in a separate `heuristic` bucket, never counted.
- **A shadowed global.** A file with its own `Promise` binding is not using the
  ES2015 global.
- **An unextracted tarball.** Reports `unavailable` rather than reading an
  absent package as ES5.

Following the module graph rather than the entry file alone is what makes the
answer honest for a gate module: react's `index.js` is five lines that `require`
one of two real builds, and classifying those five lines would report ES5 for a
package whose implementation is not. External dependencies are counted, not
followed, so a barrel package (lit) shows a visible `externalDependencies`
count instead of a silent "ES5".

## Result — the corpus as a timeline

| Edition | Packages                                                                 |
| ------- | ------------------------------------------------------------------------ |
| ES2015  | clsx, jest, lit, lodash, lodash-es, moment, react-dom, styled-components |
| ES2018  | redux                                                                    |
| ES2020  | axios, cookie, typescript, webpack                                       |
| ES2021  | react, uuid                                                              |
| ES2022  | acorn, eslint, hono, jsdom, marked, prettier, tailwindcss                |
| ES2025  | stylelint (`import … with { type: "json" }`)                             |
| ESNext  | three (`Float16Array`)                                                   |

Two things fall out of that table immediately:

1. **Every package that currently runs needs ES2022 or below** — and the whole
   ES2025/ESNext tail fails. The edition is a usable predictor of support.
2. **Seven packages need ES2022**, the largest cluster above ES2015, so class
   fields and private members are the highest-leverage grammar remaining rather
   than a long-tail nicety.

## Acceptance criteria

- [x] Each package row carries `esEdition` with `required`, `syntax`,
      `builtins`, per-axis evidence (feature, file, line) and the scanned-file
      count.
- [x] The library map is derived from TypeScript's `lib.es*.d.ts`, not
      hand-curated, and excludes ECMA-402.
- [x] A prototype-method read, a shadowed global, and an unextracted package
      never raise the reported edition.
- [x] The report summary carries an `esEditions` rollup ordered oldest first,
      naming the packages behind each count and stating its own method.
- [x] The dashboard shows a per-card `needs ES####` badge (with the evidence in
      its tooltip) and a corpus-wide edition strip.
- [x] Tests pin the derivation, the syntax table, the refusals, and the
      evidence-trimming behaviour.

## Notes

- Evidence is trimmed **after** sorting by edition. Trimming during collection
  dropped whichever feature was encountered last — including the one that set
  the headline edition, which then had no evidence behind it at all (stylelint
  read "ES2025" with nothing above ES2020 listed).
- `NodeFlags.AwaitUsing` is `Const | Using`, so a naive bit test reads every
  `const` as an ES2025 `using` declaration. `Using` is the discriminating bit.
- The graph walk stops at 400 files and sets `graphTruncated`; jsdom, webpack
  and lodash-es reach it. Their reported edition is a floor, not a ceiling.
