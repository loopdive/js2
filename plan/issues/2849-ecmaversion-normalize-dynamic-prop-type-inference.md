---
id: 2849
title: "dynamic-object numeric property reads back 0 when the same property is also compared via === string / == null (acorn ecmaVersion 2022 not normalised → spurious import attributes)"
status: blocked
assignee: ttraenkler/fable-dev
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
related: [2841, 2836, 1712, 2937, 2944]
depends_on: []
blocked_on: 2944
blocks: [1712]
umbrella: 1712
---

> **REOPENED 2026-07-02 (was `done`).** The host-mode fix (PR #2432, extend the
> `objectHashConsumerVars` poison to host) was **REVERTED in #2937**: keeping
> acorn's poisoned `{}` vars on `$Object` in host mode broke compiled-acorn with
> a uniform null-deref on EVERY input, because the poisoned value ESCAPES the
> identifier into struct-typed slots (`getOptions` return, `this.options` field)
> that the poison never re-types — a total host-mode parse break, strictly worse
> than this narrow `getOptions` quirk. So this host bug is live again. The
> **real cure is the escape-discipline substrate slice #2944** (externref-typed
> escapes for poisoned `$Object` values); this issue is `blocked_on: 2944`.
> Standalone is UNAFFECTED (its poison was never reverted). The reduced host
> arms in `tests/issue-2849.test.ts` are marked `it.fails` pinned here — they
> flip red (forcing restoration) when #2944 lands.

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

## Corrected Root Cause & Design (2026-07-02, supersedes the original diagnosis below)

> The original "Root cause" section below is **superseded**. Two of its
> framings were wrong when re-measured on current `main`:
>
> 1. **The "no-guards WORKS: run(2022)=13" claim did NOT reproduce** — the whole
>    for-in-copy family read back `undefined`/`0` in my minimal harness. That was
>    itself a **harness false-negative**: the repro never called
>    `importResult.setExports(instance.exports)`, so host `__extern_get`/`_safeGet`
>    on a struct returned `undefined`. With `setExports` wired (as the test262
>    runner does), the no-guards case already returns 13 on current main — for-in
>    over a closed struct is NOT broken.
> 2. **The bug is NOT string/null-specific.** A numeric-only guard triggers it
>    too. The "`=== string` / `== null`" framing is incidental.

### Actual mechanism (bisected, `setExports` wired)

The trigger needs BOTH:

- `o = {}` populated via **dynamic-key writes** `o[k]=v` (the for-in copy loop) —
  these land in `o`'s dynamic `$Object` **sidecar**; AND
- a **STATIC-named write** `o.ecmaVersion = <const>` somewhere in the function
  (even an **unreached** branch — `if (ev<0) { o.ecmaVersion=999 }` is enough).

The static-named write makes the compile-time widening pre-pass
`collectEmptyObjectWidening` (`src/codegen/declarations.ts:2197`, via
`collectPropsFromStatements`) register `ecmaVersion` as a **real struct field**
on `o`'s widened `__anon_N` struct type (default 0). The scan is
**reachability-blind**, so an unreached branch still registers it. Thereafter
every read `o.ecmaVersion` (static OR computed) resolves `o` to that struct and
lowers to `struct.get` of the empty field → **0**, while the for-in values sit
untouched in the sidecar. A COMPUTED write `o["ecmaVersion"]=v` does NOT trigger
it (the pre-pass only scans `PropertyAccessExpression` targets), and neither does
`direct`/literal-key construction (their writes hit the same field the reads use).

Proof points (host lane, `setExports` wired): `F; return o.ecmaVersion` = 2022;
add an unreached `o.ecmaVersion=999` → 0; only the written prop corrupts
(`o.sourceType` still 1).

### Candidate strategies

- **(a) write-through coherence** — when a static write widens a field on an
  object that also takes dynamic-key writes, mirror dynamic writes of that name
  into the field. Rejected: fragile (must intercept every dynamic-key write and
  reflect it into the right field at runtime), and doubles the storage.
- **(b) sidecar-wins (CHOSEN)** — a `{}` var that is ALSO the subject of any
  `$Object`-hash consumer (computed `o[k]` read/write, `k in o`, `for (k in o)`,
  `Object.keys/values/entries/…`) must NOT be struct-widened; it stays a
  `$Object` so static-named reads/writes route through the SAME sidecar the
  dynamic writes land in. **This mechanism already exists** — `#2584`'s
  `objectHashConsumerVars` poison-set (`markObjectHashConsumers`,
  `declarations.ts:2569`) + the widening-suppression at `declarations.ts:2252`.
  It was **gated `if (ctx.standalone)`** (declarations.ts:2228) on the assumption
  "host keeps the struct fast path via the live-mirror Proxy" — but the Proxy
  does NOT bridge the for-in `o[k]=` → static `struct.get` divergence, so host
  regressed (#2849). Fix: extend the poison to host mode.
- **(c) read-side sidecar fallback** — on a `struct.get` that yields the default,
  consult the sidecar. Rejected as **unsound**: a genuine 0 is indistinguishable
  from an unset field default.

**Chosen: (b).** Rationale — it reuses the exact precedent designed for this
class (#2584 for computed-access divergence, #2372 for dynamic-descriptor
divergence), keeps the static fast path byte-for-byte untouched (only vars with
a dynamic-access consumer are poisoned), and unifies host with standalone
(both now keep such objects on `$Object`). Blast radius: host `{}`-with-dynamic-
access vars move struct→`$Object` (a representation change for that narrow class,
already the standalone behavior); validated by full `merge_group` + standalone
floor. Note: this touches the widening **decision** pre-pass (extends an existing
suppression), not struct layout/registration logic.

### Change

`src/codegen/declarations.ts:2228` — drop the `ctx.standalone` gate on the
`markObjectHashConsumers` scan so the `objectHashConsumerVars` poison (and its
widening-suppression at 2252) applies in host mode too.

### Guardrails

- byte-diff (sha256) neutrality on a corpus of `{}`-with-only-static-access
  programs — the static fast path must be untouched;
- equivalence tests green;
- new `tests/issue-2849.test.ts`: the dead-branch repro + the guarded
  (`==null` / `=== "latest"` / numeric-only) for-in-copy family, host AND
  standalone;
- full `merge_group` + standalone floor for the representation change.

### Follow-up (separate, pre-existing — NOT this issue)

The **standalone** lane has a distinct, pre-existing gap for the same for-in-copy
shape: `var o={}; for (k in d) o[k]=opts[k]; … o.ecmaVersion` reads back
`0`/`null` under `--target standalone` (the `$Object` dynamic read-back of a
value copied from a struct receiver via a runtime key). This is unaffected by
#2849 (my fix only extends the host poison; standalone codegen is byte-identical
— sha256 verified) and is out of scope here (the #2849 / edge.js acorn use case
is host/node-acorn). Should be filed separately against the standalone
`$Object`/struct dynamic-read substrate (relates to #2896 / the value-rep work).
The #2849 tests therefore assert the standalone lane only for **purity + no
trap**, not the normalised numeric.

## ~~Root cause (verified by bisected repro)~~ (SUPERSEDED — see above)

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
  for (var k in d) {
    o[k] = opts[k];
  }
  if (o.ecmaVersion >= 2015) {
    o.ecmaVersion -= 2009;
  } // WORKS: run(2022)=13
  return o.ecmaVersion;
}
```

Adding the acorn-shaped `=== "latest"` / `== null` guards BEFORE the numeric
branch breaks it — `o.ecmaVersion` then reads back **0** in the numeric context:

```ts
if (o.ecmaVersion === "latest") {
  o.ecmaVersion = 1e8;
} // <- either of
else if (o.ecmaVersion == null) {
  o.ecmaVersion = 11;
} //    these two
else if (o.ecmaVersion >= 2015) {
  o.ecmaVersion -= 2009;
} // run(2022)=0 (BUG)
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
