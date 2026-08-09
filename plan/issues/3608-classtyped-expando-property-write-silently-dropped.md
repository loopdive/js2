---
id: 3608
title: "default target: undeclared property write on a class-typed receiver is silently dropped (expando lost, only a TS2339 warning)"
status: ready
sprint: current
created: 2026-07-25
updated: 2026-07-25
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: expando-properties
goal: core-semantics
es_edition: ES2015
related: [3252, 2515]
---

# #3608 — undeclared property write on a class-typed receiver is silently dropped

## Problem

On the **default `--target gc` (JS-host) build**, assigning a property that is
not declared on a class to a **statically class-typed** receiver compiles with
only a warning and then **silently discards the store**. The program runs and
produces wrong values instead of failing.

```ts
class P {
  a = "";
}

const p = new P();
p.a = "A";
p.extra = "X"; // warning: Property 'extra' does not exist on type 'P'.

console.log(p.extra); // js2: undefined   — V8/Node: "X"
console.log("extra" in p); // js2: false       — V8/Node: true
```

Compiler output is a **warning only**, and the resulting module is valid Wasm
that runs to completion. There is no error, no trap, no diagnostic at runtime —
the write just does not happen.

## Boundary (measured 2026-07-25, `--target gc`, main @ f5749c3)

The dynamic path **already works**. The bug is specific to the receiver being
statically typed as a class:

| case                                   | V8/Node | js2            |
| -------------------------------------- | ------- | -------------- |
| class-typed instance, undeclared write | `"X"`   | `undefined` ❌ |
| same instance held as `any`            | `"X"`   | `"X"` ✅       |
| object literal held as `any`           | `"X"`   | `"X"` ✅       |
| `"extra" in p` (class-typed)           | `true`  | `false` ❌     |

So js2 has a working expando/dynamic-property representation; a class-typed
receiver simply never routes to it.

## Why it matters

1. **Silent wrong answers.** This is the worst failure mode available: valid
   Wasm, no diagnostic, wrong result. Cf.
   `reference_valid_wasm_is_not_correct_verify_by_value` — "it validates" is not
   "it is correct".
2. **It invalidates benchmark/conformance comparisons.** Found while benchmarking
   the Porffor #262 polymorphism benchmark (see below): the benchmark's whole
   point is adding properties to class instances to force shape transitions. js2
   dropped every one of those writes, so all 7 FLAG variants compiled to the
   _same_ program and the flat timing curve was an artifact, not a result.
   Porffor (latest main) is bit-exact with V8 here; js2 is not.
3. `assert`-style checks that read back an expando pass **vacuously**, the same
   inflation mechanism as #3468 / the standalone-floor vacuity family.

## Root cause (identified)

`src/compiler/import-manifest.ts:336-341` — `DOWNGRADE_DIAG_CODES` downgrades
TS **2339** / **2551** from error to warning with the rationale
`"dynamic property access"`:

```ts
2339, // "Property 'X' does not exist on type 'Y'" — dynamic property access
2551, // "Property 'X' does not exist on type 'Y'. Did you mean 'Z'?" — variant of 2339 with suggestion (#613)
```

That rationale holds for an `any`-typed receiver, where codegen really does
route to the dynamic property path. It does **not** hold for a nominal
class-typed receiver: the class lowers to a closed WasmGC struct, the field
lookup misses, and the store is dropped. The diagnostic downgrade therefore
converts a type error into silent data loss for this receiver class.

## Acceptance criteria

- [ ] `p.extra = "X"` on a class-typed receiver either (a) routes to the same
      dynamic/expando path that the `any` receiver already uses, or (b) fails as
      a **hard compile error**. Silent drop is not an acceptable outcome.
- [ ] `"extra" in p` and `p.extra` read back consistently with whichever
      behaviour is chosen.
- [ ] If (b) is chosen, `DOWNGRADE_DIAG_CODES` is narrowed so 2339/2551 stay
      downgraded only where a dynamic path genuinely exists, and the comment is
      corrected to say so.
- [ ] Equivalence test covering the 4-row boundary table above, asserting
      **values**, not just successful compilation.
- [ ] No test262 regression; check the standalone floor for vacuity movement
      (fixing this may _reveal_ previously-vacuous passes — that is expected and
      should be reported honestly, cf.
      `reference_f1_honest_floor_deinflation_landing_recipe`).

## Repro

```bash
# probe used to pin the boundary
cat > /tmp/probe.ts <<'EOF'
class P { a = ""; }
const p1 = new P(); p1.a = "A"; p1.extra = "X";
console.log("class-typed: " + String(p1.extra));
const p2: any = new P(); p2.extra = "X";
console.log("as-any:      " + String(p2.extra));
const p3 = new P(); p3.extra = "X";
console.log("in-operator: " + String("extra" in p3));
EOF
npx tsx src/cli.ts /tmp/probe.ts -o /tmp/out   # warns, compiles
# run the module; compare against: npx tsx /tmp/probe.ts
```

## Provenance

Found 2026-07-25 while benchmarking
<https://github.com/CanadaHonk/porffor/issues/262#issuecomment-5072076826>
with js2. Not reported upstream. Full measurement writeup, including the
three-engine semantics comparison (V8 / Porffor latest main / js2), is in the
benchmark report produced by that session.

## Note — renumbered from #3599

Originally filed as **#3599**, colliding with
`plan/issues/3599-fyi-source-executor-reuse.md` on `main`. The merged issue keeps
the id, so this file renumbered to **#3608** (fresh id via
`claim-issue.mjs --allocate`, then independently verified free on `main` and
across every open PR). Purely mechanical: file rename plus the `id:` frontmatter
and the heading. No other file referenced this id, and the sibling issue in the
same PR (#3604) was unaffected.

Renumbered by the PR-queue shepherd while resolving the `merge_group` duplicate-id
park on PR #3597. This was the sixth of seven duplicate-id collisions on
2026-07-24/25 — see #3598 for the evidence base and proposed gate fix.
