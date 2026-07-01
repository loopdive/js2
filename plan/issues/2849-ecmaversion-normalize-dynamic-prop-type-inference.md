---
id: 2849
title: "dynamic-object numeric property reads back 0 when the same property is also compared via === string / == null (acorn ecmaVersion 2022 not normalised → spurious import attributes)"
status: done
assignee: ttraenkler/dev-2878
completed: 2026-07-02
sprint: current
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
created: 2026-06-29
task_type: bugfix
area: codegen
language_feature: dynamic-object-property-type-inference
goal: acorn-dogfood
related: [2841, 2836, 1712]
depends_on: []
blocks: [1712]
umbrella: 1712
---

# #2849 — dynamic-object property mis-typed when read in heterogeneous (string-`===` / `==null` AND numeric) contexts

Carved out of **#2841**. Distinct root cause: a **compiler codegen bug** in how a
dynamic-object property is typed/stored when the SAME property is used both in a
string/null equality and in a numeric arithmetic/relational context. NOT a
marshalling issue.

## Observable gap (the edge.js half of #1712)

The uncapped NM differential on a module source shows compiled acorn emitting a
spurious `attributes: []` on every `ImportDeclaration` / `ExportNamedDeclaration`
that node-acorn lacks (edge.js had 4; reproducible on a 1-line module). Both run
the SAME pinned acorn@8.16.0.

```
import x from "y";   // ecmaVersion: 2022, sourceType: "module"
// node-acorn : body[0].attributes  -> absent (undefined)
// compiled    : body[0].attributes -> []        (SPURIOUS)
```

## Root cause (verified by bisected repro)

acorn sets `node.attributes` ONLY when `this.options.ecmaVersion >= 16`
(acorn.mjs:1813/1838/1965 — `16` is the YEAR-normalised form of ES2025).
`getOptions` normalises the caller's year-form value:
`else if (options.ecmaVersion >= 2015) { options.ecmaVersion -= 2009; }`
(acorn.mjs:443-444), so `2022 → 13`, and `13 >= 16` is false → no attributes.

Compiled acorn does NOT apply that normalisation: `this.options.ecmaVersion`
stays `2022`, so `2022 >= 16` is TRUE and import-attributes are wrongly enabled.

Minimal repro (no acorn) — the normalisation step is fine in isolation, but
breaks when the property is ALSO compared to a string / null:

```ts
// @ts-nocheck
var d = { ecmaVersion: null, sourceType: 0 };
export function run(ev) {
  var opts = { ecmaVersion: ev, sourceType: 1 };
  var o = {};
  for (var k in d) { o[k] = opts[k]; }
  if (o.ecmaVersion >= 2015) { o.ecmaVersion -= 2009; }   // WORKS: run(2022)=13
  return o.ecmaVersion;
}
```

Adding the acorn-shaped `=== "latest"` / `== null` guards BEFORE the numeric
branch breaks it — `o.ecmaVersion` then reads back **0** in the numeric context:

```ts
  if (o.ecmaVersion === "latest") { o.ecmaVersion = 1e8; }       // <- either of
  else if (o.ecmaVersion == null) { o.ecmaVersion = 11; }        //    these two
  else if (o.ecmaVersion >= 2015) { o.ecmaVersion -= 2009; }     // run(2022)=0 (BUG)
```

Both `=== "latest"` (string compare) and `== null` independently trigger it. The
property `o.ecmaVersion` is used in a STRING/null-equality context AND a numeric
context; the compiler appears to commit the dynamic-object property slot to a
representation that makes the numeric read return 0 (a default/empty slot). This
is a **dynamic-object property type-inference / storage** bug, likely broad
(value-rep scale), and should get an architect spec before coding.

## Scope / why separate from #2841

- #2841 was a HOST-MARSHALLING fix (arrow param `name`/`type`); shipped & verified
  (`background.js` 0 non-quirk).
- This is a CODEGEN bug (dynamic-property polymorphic-type handling). Different
  layer, different fix.
- It only surfaces in the differential on **edge.js** (module sourceType), which
  also cannot parse on `main` until the #2838 return-stack PR **#2325** lands —
  so verification is doubly gated. Recommend scheduling after #2325 merges.

## Acceptance

- `import x from "y";` parsed by compiled acorn at `ecmaVersion: 2022` has NO
  `attributes` field (matches node-acorn); `ecmaVersion: 2025/16` still DOES.
- The minimal repro `run(2022) === 13` with the `=== "latest"` / `== null`
  guards present.
- With #2325 stacked, edge.js uncapped NM differential reaches ZERO non-quirk
  divergences (completing the #1712 edge.js bar together with #2841).
- 0 test262 regressions; full merge_group + standalone-floor.

## Pointers

- acorn: `getOptions` ecmaVersion normalisation (entry module ~443-444);
  `node.attributes` gates (~1813 / ~1838 / ~1965).
- Compiler: dynamic-object property read/write typing for a property used across
  string-equality and numeric contexts (`$Object` slot typing /
  `__extern_get`/`__extern_set` numeric coercion). Likely the same family as the
  any-value polymorphic-read substrate work.
- Repro scripts (this branch, `.tmp/nm-2841/repro-ecma*.mjs`, gitignored).

## Resolution (2026-07-02, dev-2878)

### Root cause (WAT-bisected, host mode)

Not a numeric-vs-string type-inference issue as originally hypothesised — the
trigger is a **representation-coherence** split between a dynamic-key write and a
widened struct read:

1. `var o = {}` is given a **concrete WasmGC struct** type by
   `collectEmptyObjectWidening` (declarations.ts) because a sibling STATIC
   dot-write `o.ecmaVersion = 1e8` (inside the never-taken `=== "latest"` /
   `== null` guard body) contributes an `f64 ecmaVersion` field. Widening makes
   the dot-reads lower to a direct, unguarded `struct.get $N 0`.
2. The for-in write `for (k in d) o[k] = opts[k]` has a **non-literal computed
   key** (`k` is the loop var), so it CANNOT resolve to a struct field and lowers
   to the dynamic `__extern_set` **sidecar** — NOT the struct slot.
3. Read/write diverge: `struct.get` returns the field default (`0`), never the
   sidecar-written `2022`. (Bisected: `var k = "x"; o[k]=v` const-propagates the
   key → lowers to `struct.set` → coherent → no bug; only the non-resolvable key
   breaks.)

Why host-only: the demotion guard that keeps such objects open
(`markObjectHashConsumers`, #2584) is **standalone-gated**, and the host
"live-mirror Proxy writeback" does NOT cover a dynamic-key write.

### Fix

`src/codegen/declarations.ts` — new `hasNonLiteralComputedWrite` detector, wired
into `collectEmptyObjectWidening` **mode-agnostically**: a non-literal
computed-key write `o[<expr>] = v` suppresses empty-object struct widening, so
the receiver stays a `$Object` and both the dynamic write and the dot reads route
through the same (guarded / sidecar) representation. String/number-**literal**
computed keys are deliberately NOT matched — they resolve to a field and lower to
`struct.set`, staying coherent (and keeping the struct fast path). Standalone was
already covered by the (broader) `markObjectHashConsumers` poison.

### Verification

- Minimal repro `run(2022) === 13` with the `=== "latest"` / `== null` guards
  present (host). All variant forms correct; literal-key writes still fast-path;
  pure-numeric path unchanged.
- **0 regressions** in a base-vs-mine differential over 1,399 object / for-in /
  property-accessor test262 files (the directly-affected surface).
- Test: `tests/issue-2849-dynamic-key-object-numeric-read.test.ts`.

### Out of scope (separate pre-existing gaps)

- **Standalone** (`--target standalone`) still reads the property back as an
  externref/object (returns `{}`, not `13`) — an INDEPENDENT gap in the
  standalone dynamic-`$Object` numeric substrate (verified identical on `main`,
  unaffected by this fix). Tracked with the `$Object` dynamic-reader value-rep
  work.
- The acorn `attributes` acceptance (edge.js module differential) remains gated
  on #2325 (edge.js can't parse module source on `main` yet); the underlying
  compiler mis-read that produced it is fixed here.
