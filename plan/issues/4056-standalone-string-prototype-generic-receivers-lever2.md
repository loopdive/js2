---
id: 4056
title: "LEVER 2 — `String.prototype` generic receivers in standalone: 218/630 ≤ES5 failures (34.6%)"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
assignee: ttraenkler/dev-4056-string-proto-standalone
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: standalone
language_feature: n/a
goal: standalone-mode
---
# LEVER 2 — `String.prototype` generic receivers in standalone: 218/630 ≤ES5 failures (34.6%)

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

**Measured 2026-08-01**, standalone lane, ≤ES5 scope (`es5id:` frontmatter). `built-ins/String/prototype`: **218 fail / 630 run = 34.6%**.

Top signature: 31× `TypeError: Cannot access property on null or undefined at N:N`, e.g. `test/built-ins/String/prototype/match/S15.5.4.10_A2_T17.js`.

**Likely the standalone twin of an already-solved default-lane problem.** Task #21 (`#2742` + the `missing_builtin` family — `String.prototype` generic receivers, 87 + 58 failures) is marked **completed** for the DEFAULT lane. This is the same feature area failing in standalone, so the first move is to establish whether #2742's fix simply never reached the standalone path, or whether standalone needs a different lowering.

**Do that check before writing code** — if it is a routing gap the fix may be small, and sizing it as fresh work would be wrong.

**Sizing caution:** 218 is the failing population in this directory, not a flip estimate. Sample and measure the flip ratio before quoting a number.

Cross-check #3571 (task #11) — `Function.prototype.call/apply/bind` on builtin methods, the uncurryThis/propertyHelper blocker — since generic-receiver dispatch and uncurried builtin methods touch the same seam.

---

## ❌ HYPOTHESIS REFUTED (2026-08-02) — #2742 DID reach standalone

> Measured on `upstream/main` @ `c2b9023e5`, against the **fresh** standalone
> baseline pulled the same day (`test262-standalone-current.jsonl`,
> `timestamp 2.8.2026, 14:01`) and the fresh host baseline
> (`fetch-baseline-jsonl.mjs --force`, 48,353 rows).

The issue's own first move — "establish whether #2742's fix simply never
reached the standalone path" — resolves **NO, it reached**. PR #3954 landed
the standalone arm on 2026-08-01 (`ed94bba25`, the
`SUPERSEDED_BY_BORROWED_PATH` carve-out in `emitStringProtoMemberBody`,
+18/−0). This is **not** a wiring/porting gap.

### The population has MOVED — do not size off the 218

Same scope filter as the original measurement (`es5id:` frontmatter under
`test/built-ins/String/prototype/`), and the **denominator reproduces exactly**
(630), so the two measurements are comparable:

| | issue as filed (2026-08-01) | fresh (2026-08-02) |
| --- | --- | --- |
| run | 630 | 630 |
| fail | 218 (34.6 %) | **130 (20.6 %)** |
| of which standalone-only (host passes) | — | **76** |

−88 files in one day. Anyone re-opening this must re-pull the baseline before
quoting a size.

### Shape census of the 76 flippable files

Classified by matching the **test source** for each receiver idiom (not the
error text):

| shape | n |
| --- | --- |
| **P2 — transferred** (`obj.M = String.prototype.M; obj.M()`) | **52** |
| not a generic-receiver test at all (RegExp engine, descriptor surface, `eval`) | 21 |
| P2 + prototype-assign | 2 |
| **P1 — literal `String.prototype.M.call(obj)`** | **1** |

**P1 is down to a single file.** That is the positive evidence #2742's slice
works. The live gap is **P2**, which #2742 explicitly scoped OUT as
"a genuinely separate second defect [that] needs its own root-cause pass".

## The actual mechanism — two sub-defects, neither one "generic receivers"

Probe: `var a = <recv>; a.M = String.prototype.M; a.M(...)`, compiled for both
lanes, compared **inside wasm** against the truth computed by Node so only `i32`
crosses the boundary. **4 controls** (`Object.keys`, `'ab'.toUpperCase()`,
`String(new Boolean(false))`, `String(new Number(1234))`) green on both lanes —
an earlier revision of this probe had all four RED (it called `String()` on a
returned WasmGC ref in the JS harness) and every reading was junk; the controls
are what caught it.

### (a) Missing per-member arms — an explicit, catchable refusal

On a `new Number(1234)` receiver, **9 of 16** members are already correct in
standalone (`substring`, `charAt`, `toUpperCase`, `toLowerCase`, `charCodeAt`,
`indexOf`, `lastIndexOf`, `toLocaleUpperCase`, `toLocaleLowerCase`). The other
**7** all fail with one message:

```
TypeError: String.prototype.<M> is not yet implemented in --target standalone
```

`slice`, `trim`, `concat`, `split`, `substr`, `localeCompare`, `search` — they
reach `emitProtoMemberBodyRefusal` because `emitStringProtoMemberBody`
(`src/codegen/array-object-proto.ts:813`) has no arm for them. Receiver
coercion and dispatch are **not** involved.

⚠️ **Sized honestly: this bucket is SMALL.** Scanning all 48,619 standalone rows
for that literal message finds **27 failures, 22 of them host-pass**:
`String.split` 9/8 · `String.slice` 4/3 · `String.search` 2/2 ·
`String.concat` 2/2 · `Symbol.valueOf` 2/2 · `String.valueOf` 1/1 ·
`WeakRef.deref` 1/1 · `Date.toJSON` 2/1 · `String.replace` 2/1 ·
`Object.toString` 2/1. It is a floor, not a ceiling (a test that catches the
TypeError fails with a different message), but nothing here supports a large
flip estimate.

Note `trim` refuses **by design** since the #3954 carve-out. That carve-out
bought P1-`trim` at the cost of P2-`trim`; its A/B measured 0 pass→fail over
450 files, so no ≤ES5 file exercises P2-`trim` — but the hole is real.

### (b) The reflective wrapper's `ToString(this)` diverges from `String()`

The bigger and more coherent bucket. `emitStringProtoToStringFlat`
(`src/codegen/string-proto-tostring.ts:60`) already does the #3992
ToPrimitive-first step, which is why plain objects with a user `toString` now
work. It is still wrong for **exotic** receivers, and — decisively — **wrong
where the general `String()` lowering is right**:

| receiver | `String(recv)` standalone | wrapper `ToString(this)` standalone | correct |
| --- | --- | --- | --- |
| `new Array(1,2,3,4,5)` | `"1,2,3,4,5"` ✅ | **`""`** | `"1,2,3,4,5"` |
| `new RegExp("ABC")` | `"/ABC/"` ✅ | **`""`** | `"/ABC/"` |
| `Math` | `"[object Object]"` ✗ | `"[object Object]"` | `"[object Math]"` |
| `function(){}` | `"function(){}"` ✗ | `"[object Object]"` | `"function(){}"` |

For **Array and RegExp** there is a working in-tree reference on the same lane,
which makes those two the actionable part. `Math`/`function` are wrong on
*both* paths — a separate defect, out of scope here.

This drives the ≤ES5 case-conversion cluster (`toLowerCase` 6, `toUpperCase` 6,
`toLocaleLowerCase` 6, `toLocaleUpperCase` 6) plus `substring` 6 — all
flippable, all failing on `new Array(...)` / `new RegExp(...)` /
`{toString(){throw "intostr"}}` receivers.

### Two attributions tested and EXCLUDED

1. **Registration-order hazard** (the #3216/#2875 failure mode this file
   documents repeatedly). Warming `String(new Array(9,9))` in an *earlier*
   function of the same module does **not** fix the wrapper — still wrong.
   So the wrapper is not baking a degraded fallback from an unregistered
   dependency; it genuinely takes a different path.
2. **Receiver representation changed by the property assignment.**
   `String(a)` is correct *both before and after* `a.m = String.prototype.M`,
   so assigning the method does not re-box the array.

### Call SHAPE is the axis today — #2742's note is now stale

Same receiver, same method, differing only in call shape:

```
P1  String.prototype.substring.call(arr, 0, 200)          -> correct
P2  arr.m = String.prototype.substring; arr.m(0, 200)     -> WRONG ("")
```

#2742's "Dispatch is NOT the differentiator … a test-shape distinction, not a
defect axis" was measured 2026-07-31, when **both** shapes were broken. P1 has
since been fixed and P2 has not, so the shape *is* the axis now. Do not
re-derive from that paragraph.

### Recommended next slice (narrowest site)

Fix (b) for Array/RegExp receivers in `string-proto-tostring.ts` — the file
#3992 created for exactly this rule, consumed **only** by the reflective
`__proto_method_*` bodies, which host emits **zero** of. Do **not** change
`__to_primitive` or `__any_to_string`: those are the general point, shared by
array `join`, template literals and `String()`, and that is where the blast
radius lives.

Acceptance: `substring` + the four case-conversion members correct on
`new Array(...)` / `new RegExp(...)` receivers in **both** lanes; `charAt` and
the P1 shape unmoved; kill-switch seen to fail. Report pass→fail and fail→pass
from a scoped standalone A/B with rows floored.

**No code was changed for this entry — it is a measurement/diagnosis record.**
