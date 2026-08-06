# Root-cause clusters — standalone lane, ES5-tagged + untagged (2026-08-04)

Clustering of every **non-pass** test262 file in the **standalone** lane whose
edition label is `ES5`, `Unclassified (untagged)`, or `Unclassified (legacy)`.

Companion to [`analysis-2026-08-01-es5-untagged-tail-census.md`](analysis-2026-08-01-es5-untagged-tail-census.md).
**Read the scope note below before comparing numbers** — that census uses a
different, narrower scope and the two totals are not interchangeable.

## Provenance — quote this with any number taken from here

| | |
| --- | --- |
| Standalone rows | `.test262-cache/test262-standalone-current.jsonl`, fetched fresh 2026-08-04T22:04Z (48,619 entries) |
| Host rows (cross-tab only) | `.test262-cache/test262-current.jsonl`, fetched fresh 2026-08-04T22:08Z (48,619 entries) |
| Row timestamps | `4.8.2026, 17:48:02` → `17:58:22` (UTC+2) |
| `oracle_version` / lane | 12 / `honest` |
| Summary baseline SHA | `d3d7ec4c2cda4ebd7711e0ddba0234a7104675f0` (generated 2026-08-04T16:03Z) |
| Edition map | `website/public/benchmarks/results/test262-file-editions.json` @ `0ad2e85` |

Baselines move fast (the 08-01 census measured 172 files flipping in 16 hours).
Re-cut before acting on anything older than about a day.

## Scope — which reading of "ES5 or untagged" this is

This report uses the **landing-page edition labels** produced by
`scripts/generate-editions.ts` (`classifyEdition`), joined per file:

| Edition label | Run | Pass | Non-pass | Pass % |
| --- | ---: | ---: | ---: | ---: |
| `ES5` (`es5id`, or path/no-frontmatter heuristic) | 8,931 | 6,844 | 2,087 | 76.6 % |
| `Unclassified (untagged)` (`esid`-only fall-through, #3639) | 5,445 | 3,680 | 1,765 | 67.6 % |
| `Unclassified (legacy)` (frontmatter, no id key at all) | 273 | 271 | 2 | 99.3 % |
| **Total in scope** | **14,649** | **10,795** | **3,854** | **73.7 %** |

Proposal-scope rows (`scope_official === false`) are excluded. 0 files failed to
map to an edition.

**The 08-01 census scoped differently**: `es5id` present **or** no id key at all
= 8,545 files / 2,369 non-pass. The gap is almost entirely the 5,445 `esid`-only
tests, which this report includes (1,765 non-pass) and that one excludes. Its own
refutation #6 flags the same denominator trap. Neither reading is wrong; they
answer different questions. Where the scopes overlap the two agree — e.g. both
independently land on **119** files for strict-mode `this` / receiver identity.

## Failure mode, before cause

| Mode | Files | Share |
| --- | ---: | ---: |
| **Wrong answer** — compiled, ran, produced the wrong result | 3,380 | 88 % |
| Explicit standalone refusal (compiler says "not supported") | 240 | 6 % |
| Wasm trap (null deref / OOB / illegal cast / invalid module) | 213 | 6 % |
| Compile timeout / unknown | 21 | < 1 % |

The tail is **not** dominated by missing features the compiler knows it is
missing. It is dominated by code that compiles and silently computes the wrong
answer.

## Clusters

First-match-wins partition; cause-shaped rules are ordered ahead of area-shaped
ones so a file lands in the cluster that explains it, not merely the directory it
lives in. Classifier source is at the end — re-runnable.

| Cluster | Files | ES5 | untagged | also fails on host | standalone-only |
| --- | ---: | ---: | ---: | ---: | ---: |
| **B3** Array generic / live-mutation traversal | 738 | 40 | 698 | 477 (65 %) | 261 |
| **B2** Property-attribute round-trip (`verifyProperty`) | 381 | 235 | 146 | 220 (58 %) | 161 |
| **B4** `defineProperty` / `create` / `gOPD` residual | 381 | 370 | 11 | 202 (53 %) | 179 |
| **B1** Missing spec throw | 310 | 102 | 208 | 201 (65 %) | 109 |
| **C1** `with` + Annex B eval/global/function-code scoping | 251 | 248 | 3 | 244 (97 %) | 7 |
| **A1** Explicit standalone-unimplemented refusal | 240 | 115 | 125 | 123 (51 %) | 117 |
| **E1** Unclassified | 230 | 135 | 95 | 176 (77 %) | 54 |
| **A3** Wasm trap | 213 | 126 | 87 | 159 (75 %) | 54 |
| **B5** Object / class / prototype semantics | 200 | 111 | 89 | 125 (63 %) | 75 |
| **C2** Function-object semantics (name/length/toString/bind) | 184 | 139 | 45 | 157 (85 %) | 27 |
| **D1** `String` / `RegExp` residual | 178 | 168 | 10 | 81 (46 %) | 97 |
| **C4** Strict-mode `this` / receiver identity | 119 | 107 | 12 | 113 (95 %) | 6 |
| **C3** Assignment / compound-assignment / inc-dec | 99 | 68 | 31 | 83 (84 %) | 16 |
| **D3** `Number` / `Math` / `JSON` | 97 | 45 | 52 | 26 (27 %) | 71 |
| **C5** Module semantics / namespace objects | 68 | 0 | 68 | 68 (100 %) | 0 |
| **A2** Host-import leak (#2961 honesty reclassification) | 60 | 35 | 25 | 34 (57 %) | 26 |
| **D2** `Date` | 50 | 3 | 47 | 20 (40 %) | 30 |
| **C6** Lexer: unicode identifiers / reserved words / literals | 34 | 24 | 10 | 23 (68 %) | 11 |
| **A4** Compile timeout / unknown | 21 | 16 | 5 | 8 (38 %) | 13 |
| **TOTAL** | **3,854** | 2,087 | 1,767 | **2,540 (66 %)** | **1,314** |

> **66 % of this standalone gap is not standalone-specific — the host lane fails
> the same file.** Only 1,314 files are standalone-only. Fixing B1–B5 pays into
> ES5 conformance on both lanes; only A1/A2, D1 and D3 are meaningfully
> standalone-weighted.

## The one root cause behind B1–B5 (2,010 files, 52 %)

B1–B5 are five symptoms of a single substrate gap: **property access is
shape-specialised rather than routed through the ordinary-object MOP**
(`[[Get]]` / `[[Set]]` / `[[HasProperty]]` / `[[DefineOwnProperty]]` over a
descriptor table and the prototype chain).

Evidence, from the failing tests themselves:

- `Array/prototype/forEach/15.4.4.18-7-b-12.js` — *"deleting own property with
  prototype property causes prototype index property to be visited on an
  Array-like object"*. Fails `testResult !== true`, the single largest signature
  in scope (135 files). The iteration is reading a dense snapshot; the spec
  requires a per-index `HasProperty` + `Get` that walks the prototype chain.
- `Array/prototype/map/15.4.4.19-8-b-15.js` — a getter installed via
  `defineProperty` sets `arr.length = 2` mid-iteration, and `Array.prototype["2"]`
  is an accessor. The spec fixes `len` once (correctly — the loop must still run
  to the original bound) and the shortened index is then supposed to resolve
  **through the prototype chain**. It is the per-index prototype lookup that is
  missing, not a per-step `length` re-read.
- `Array/prototype/map/15.4.4.19-2-9.js` — array-like whose `length` is an own
  **accessor** that overrides an inherited accessor. `LengthOfArrayLike` must be
  a real `[[Get]]` (once, before the loop); the accessor is not consulted at all.
- `Object/defineProperty/15.2.3.6-4-82.js` — `configurable: true` then
  `configurable: false`, then `verifyProperty`. Attributes do not survive the
  round-trip.

Sub-signal counts across the whole scope, all consistent with the same cause:

| Symptom | Files |
| --- | ---: |
| `undefined` where a value was expected | 285 |
| `assert.throws` saw no exception at all | 278 |
| `null` where a value was expected | 205 |
| `[object Object]` where a primitive was expected (ToPrimitive) | 112 |
| `NaN` where a number was expected | 96 |
| Error-constructor identity mismatch (`instanceof TypeError` false) | 92 |

Array method breakdown inside B3, all callback-iteration methods:
`reduceRight` 138 · `reduce` 130 · `map` 88 · `filter` 84 · `some` 77 ·
`forEach` 76 · `every` 74 · `lastIndexOf` 74 · `indexOf` 69 — 810 of 1,033
`Array/prototype` non-passes.

Related issues: #1888 (`ready`), #2992 (`in-progress`), #3251 (`ready`),
#1906 / #1130 / #1140 / #1152 / #1234 / #1018 (all `done` — the remaining
failures are residual to those fixes, not regressions of them).

**Caveat on sizing.** 53–65 % of B1–B5 also fails on the host lane, so this is
not a "standalone substrate" line item; the 08-01 census makes the same point
(its refutation #5) and measured the same over-statement factor. Sizing a
descriptor-MOP fix as "unlocks 2,010 standalone files" overstates the
standalone-specific yield by roughly 2×.

## The second cause: dynamic scope (C1 + C3, 350 files)

`with`-statement lowering and Annex B eval/global/function-code declaration
semantics. **97 % of C1 also fails on host** — this is a front-end scope-model
gap, not a standalone one. Compound assignment is entangled with it: the
`compound-assignment/S11.13.2_A5.*` family (45 files, `scope.x === 1. Actual:
NaN`) fails *inside* a `with` block, so a path filter on
`language/statements/with` undercounts the mechanism. The compiler is explicit
about the limit in 12 of these: *"with statement requires a proven closed
object-literal shape before codegen"* (`#1387`).

## What the existing root-cause map calls this scope

`benchmarks/results/test262-standalone-current.json`'s `root_cause_map` puts
1,572 of these 3,854 in a bucket named
**`class-prototype-private-descriptor`** — "Class element, prototype,
private-name, and descriptor reconciliation gaps". For an ES5/untagged scope that
name actively misleads: essentially none of these tests involve class elements or
private names. The bucket is doing descriptor-MOP work under a class-shaped
label. Worth renaming or splitting before it is used to prioritise ES5 work.

## Reproducing

```js
// 1. fetch both lanes fresh
//    node scripts/fetch-baseline-jsonl.mjs --standalone --force
//    node scripts/fetch-baseline-jsonl.mjs --force
// 2. join edition labels, select non-pass in-scope rows, classify.
import { readFileSync } from "fs";

const ed = JSON.parse(
  readFileSync("website/public/benchmarks/results/test262-file-editions.json", "utf8"),
);
const editionOf = (file) => ed.editions[ed.files[file.replace(/^test\//, "")]];
const IN_SCOPE = new Set(["ES5", "Unclassified (untagged)", "Unclassified (legacy)"]);

const sel = readFileSync(".test262-cache/test262-standalone-current.jsonl", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter(
    (r) =>
      IN_SCOPE.has(editionOf(r.file)) &&
      r.scope_official !== false &&
      r.status !== "pass" &&
      r.status !== "skip",
  );

const f = (r) => r.file.replace(/^test\//, "");
const e = (r) => r.error || "";

// First match wins. Cause-shaped rules before area-shaped ones.
const RULES = [
  ["A1 standalone-unimplemented refusal", (r) => /not yet implemented in --target standalone|not yet callable as a value in --target standalone|is not yet supported in --target standalone|unsupported descriptor shape in standalone|standalone RegExp engine does not support|requires a proven closed object-literal shape/.test(e(r))],
  ["A2 host-import leak", (r) => r.error_category === "host_import_leak"],
  ["A3 wasm trap", (r) => ["null_deref", "oob", "illegal_cast", "wasm_compile"].includes(r.error_category)],
  ["A4 timeout/unknown", (r) => /timeout \(/.test(e(r)) || r.error_category === undefined],
  ["B1 missing spec throw", (r) => /to be thrown but no exception was thrown at all|Expected a .* but got a different error constructor/.test(e(r))],
  ["B2 property-attribute round-trip", (r) => /to be writable, but was not|desc\.(writable|enumerable|configurable)|afterWrite|afterDeleted|should be an own property|to equal .*, actually null|Expected obj\[/.test(e(r))],
  ["B3 Array generic/live-mutation traversal", (r) => /built-ins\/Array\/prototype/.test(f(r))],
  ["B4 defineProperty/create/gOPD residual", (r) => /built-ins\/Object\/(defineProperty|defineProperties|create|getOwnPropertyDescriptor|seal|freeze|isFrozen|isSealed|preventExtensions|getOwnPropertyNames)/.test(f(r))],
  ["C1 with + AnnexB/eval scoping", (r) => /language\/statements\/with|annexB\/language\/(eval|global|function)-code|language\/eval-code|language\/global-code/.test(f(r))],
  ["C2 function object semantics", (r) => /built-ins\/Function|language\/statements\/function|language\/expressions\/function|arguments-object/.test(f(r))],
  ["C4 strict-mode `this` / receiver identity", (r) => /'this' had incorrect value!/.test(e(r)) || /language\/function-code|language\/directive-prologue|language\/expressions\/this|language\/statementList/.test(f(r))],
  ["C5 module semantics / namespace objects", (r) => /language\/module-code|built-ins\/AsyncFunction/.test(f(r))],
  ["C6 lexer: unicode identifiers / reserved words / literals", (r) => /language\/(identifiers|reserved-words|literals|identifier-resolution|white-space|line-terminators|comments)/.test(f(r))],
  ["B5 object/class/prototype semantics", (r) => /language\/expressions\/(object|new|super|class|call|delete|instanceof|tagged-template)|language\/statements\/class|built-ins\/Object|language\/types\/object/.test(f(r))],
  ["D1 String/RegExp residual", (r) => /built-ins\/(String|RegExp)/.test(f(r))],
  ["D2 Date", (r) => /built-ins\/Date/.test(f(r))],
  ["D3 Number/Math/JSON", (r) => /built-ins\/(Number|Math|parseInt|parseFloat|JSON|isNaN|isFinite)/.test(f(r))],
];
```

Host cross-tab: a file is "also fails on host" when its `test262-current.jsonl`
row has `status !== "pass"`.

## Correction (2026-08-04, after reading `src/codegen/hof-native.ts`)

An earlier revision of this file said `length` is "read once up front instead of
re-read through `Get` each step". **That is wrong and would send an implementer
the wrong way.** The spec fixes `len` once for the iteration methods
(§23.1.3.15 step 2 and friends), and `__hof_*` already does exactly that — its
header says so. Adding a per-iteration `length` re-read would be both incorrect
and slower.

The two real gaps are: **per-index `HasProperty` + `Get` through the prototype
chain** (which is what makes a shortened array's index resolve to
`Array.prototype["2"]`), and **`LengthOfArrayLike` being a real `[[Get]]`** so an
accessor `length` is invoked — once, before the loop. Corrected in the body
above and in #3185.

## Issues filed against this analysis (2026-08-04)

| Cluster (this scope) | Files | Issue |
| --- | ---: | --- |
| Descriptor family (attribute round-trip + `defineProperty`/`create`/`gOPD`) | 762 | **#2668** — updated with this re-measure |
| Array generic / live-mutation traversal | 738 | **#3185** — updated; reconcile with #2670, same files under the pre-#3639 `ES2015` label |
| `with` + Annex B eval/global/function-code (incl. 45 compound-assignment files that fail *inside* a `with`) | 307 | **#2663** — updated |
| Reference-layer abrupt completions (`GetValue`/`PutValue`/`ToObject` on an undefined or unresolvable base) | 138 | **#4158** — new |

The fourth row is the **un-owned remainder** of the 310-file "assert.throws saw
no exception" cluster. The other 172 of those files are step-order validation
inside `Array.prototype` (113 → #3185) and illegal descriptor reconfiguration
(59 → #2668/#4008), and are deliberately left with their owners. **Do not size
#4158 at 310**, and do not add the four rows to 1,945 as independent work: #2668
and #3185 share the MOP substrate, so a substrate fix moves both.

## Limits of this analysis

- Clusters are assigned by **error signature and test path**, not by reading
  3,854 test bodies. Spot-checked against ~25 fetched test sources (quoted
  above); the B3 and B4 readings are confirmed directly, the D-series are
  area-shaped and may each hide more than one mechanism.
- **E1 (230 files, 6 %) is genuinely unexplained** and is reported as such rather
  than folded into a neighbouring bucket. Largest residuals inside it:
  `language/statementList` eval-block (45), `language/module-code` ambiguous
  exports (22), `built-ins/encodeURIComponent` (15).
- No compiler was built or run for this analysis — every number derives from the
  published baselines. The causal claims about codegen (dense snapshot, `length`
  read once) are inferred from test descriptions plus compiler source
  (`src/codegen/array-object-proto.ts`, `src/codegen/object-runtime-descriptors.ts`)
  and were **not** confirmed by a local repro.
