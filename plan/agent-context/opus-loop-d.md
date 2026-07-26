# opus-loop-d — session context (2026-07-26)

Durable record so the diagnoses below survive this session. The #3653 issue file
is not on `main` yet (it lives in open PR #3653), so its findings are recorded
here rather than in `plan/issues/` to avoid a same-path collision.

## Landed / in flight

- **#2742 — PR #3660** (green, CLEAN). Group (c) root cause: an accessor getter
  whose return value is a compiled closure crossed to the host **unmarshalled**,
  so V8 saw `typeof o.valueOf === "object"` and `OrdinaryToPrimitive`
  (§7.1.1.1 step 5.b `IsCallable`) silently skipped it, reaching step 6 and
  throwing "Cannot convert object to primitive value". Fixed with
  `_wrapAccessorGetterReturn` in `src/runtime.ts`, confined to the accessor path
  (a generic call-exit marshal was tried and reverted before — #3123/#2835).
  **0 test262 flips (10→10 of 22), 0 regressions**, 3 tests red on the merge base.

## #2742 — measurement corrections (the issue's framing was wrong)

Re-ran the issue's own 22 listed files with positive + negative controls.

- **Group (a) is already fixed** — 8 of 9 pass on `main` today.
- **Group (b) is mislabelled** as `RequireObjectCoercible`. Genuine
  `String.prototype.charAt.call(undefined)` already throws a correct `TypeError`.
  6 of those files are **dynamic `F.prototype.X = …` augmentation**, and the
  decisive control shows it is **not String-specific**: a plain *user* function
  assigned to a user prototype fails identically (`m is not a function`).
- **This corrects #3626's census C1 `missing_builtin` reading** ("genuinely
  missing methods — add/repair the method"). The methods are present and correct.
- Remaining #2742 blocker: **`@@toPrimitive` on the receiver is never consulted**
  (measured 0 accesses vs V8's 1; `toString`/`valueOf` now correct at 1/1).

## #3653 — diagnosis: the 126-test cluster is NOT a `defineProperty` defect

Population = lead's extract of merge_group run `30179758665`: 229 regressions
mentioning "should not be writable/configurable"; 126 of them in
`built-ins/Object/defineProperty` + `defineProperties`, 18 in
`language/arguments-object/mapped`, 13 in freeze/seal.

**Two non-vacuous measurements that disagree:**

1. The 12 real population files reproduce — **12/12 fail**, control passes.
   Errors are `verifyProperty`-shaped ("descriptor should not be enumerable…").
2. The **same shapes read directly via `getOwnPropertyDescriptor` are CORRECT**.
   Encoded `100*w + 10*c + e`, V8 = 0 for each: array generic prop → 0; array
   index "0" → 0; arguments generic prop → 0; mapped arguments index 0 → 0.

⚠️ **The first version of measurement (2) was vacuous** — every expectation
encoded to `0` and so did the sentinel, so "0" proved nothing. Re-run with a
sentinel returning **999** and a known-broken case (`freeze` → **111**) in the
same harness; both surfaced correctly, so the four `0`s are real readings.

**Conclusion:** `defineProperty` stores/reports flags correctly on Array and
Arguments receivers; `verifyProperty` disagrees with `gOPD` about the same
property. **Do not fix `defineProperty`.**

### Corrected mechanism (opus-loop-a, from `propertyHelper.js` source)

I first framed this as sharing #3647's *reflective-route* mechanism. **That was
wrong.** The three `verifyProperty` checks use **three different routes**:

| check | route | kind |
| --- | --- | --- |
| `enumerable` | for-in && `hasOwnProperty` && **`propertyIsEnumerable`** | reflection — #3647 |
| `writable` | `isWritable` does a real **WRITE**, reads back, reverts | **enforcement** |
| `configurable` | `isConfigurable` does a real **DELETE**, then `hasOwnProperty` | **enforcement** |

`propertyIsEnumerable` never appears in the `writable`/`configurable` paths, so
#3647 cannot explain this cluster. The fix site is the **write/delete rejection
paths on Array and Arguments receivers**.

Nor is this "the harness broke post-#3603": #3603 fixed verifyProperty's
*reporting* (failures now surface), not the *routes* it queries. Those routes
were always wrong — these are genuine compiler defects, correctly newly-visible.

**Next axis (the reconciling one): `isWritable` does a NON-STRICT write.** A
strict-mode write to a non-writable property *is* correctly rejected on HEAD
(measured). Sloppy mode must silently fail; if we mutate instead, `isWritable`
reads back the new value and reports "writable" — the exact symptom, with strict
mode still looking correct.

**Two warnings:** (1) this lands in census §2.2's A1/A2, which loop-e refuted —
check with loop-e first, its refutation was of the census *probe*, not
necessarily the behaviour; (2) `isWritable`/`isConfigurable` are **destructive
and self-contaminating** (this is how `verifyProperty(WeakMap.prototype,"get")`
deleted a realm intrinsic in #3603) — **use a fresh receiver per case**.

**Caveat — the 126 is probably ≥2 mechanisms.** Some messages also carry a
*value* mismatch (`15.2.3.7-6-a-164`: "obj['length'] value should be 2";
`15.2.3.6-4-167`: "value should be 1"), suggesting a real second defect in array
`length` truncation on a non-writable redefine.

## #3653 — a real, independent, separable defect: freeze/seal descriptor read-back

- `Object.freeze(o)` → `gOPD` reports **111** (w,c,e all true) where V8 gives **001**.
- `Object.seal(o)` → reports **111** where V8 gives **101**.
- But `isFrozen`/`isSealed` are **correct**, and the write **is** rejected — so
  enforcement and bookkeeping are right; only the read-back lies.
- **Decisive control:** `freeze` applied to a property created via
  `defineProperty` (which has explicit sidecar flags) reports **correctly** — so
  the defect is confined to properties with **no explicit sidecar descriptor
  entry**; freeze/seal never write flags for plain fields.
- Worth landing on its own, but it is **~13/229 (6 %)** and must not be quoted
  as the cluster's mechanism.

## Cross-checks with other lanes

- Corroborates `opus-loop-e`: a **strict-mode** write to a non-writable property
  **is** rejected on HEAD, so the old "#739 `[[Set]]` ignores `[[Writable]]`" row
  was an artifact. Two independent methods now agree.

## Infrastructure findings

- **The equivalence gate's baseline is stale, not racing.** It reported 3 "new
  regressions" plus 1 unrelated `math-pow` improvement — a *bidirectional* move,
  the signature of a stale baseline. Local-vs-local A/B on the cited file:
  merge base **45 pass / 1 fail**, with my change **45 pass / 1 fail** — identical.
  `scripts/equivalence-baseline.json` was last ratcheted **2026-07-10**.
  Note this is **not** #3648's shape: that gate clones a moving reference inline,
  whereas this one reads a **committed, static** baseline. Fix is a `--update`
  ratchet, tracked separately.
- **Both LOC ratchet levels bite independently**: a file-level
  `loc-budget-allow` does **not** satisfy the per-function `#3400/R-FUNC` gate.
- `reference_quality_failfast_masks_downstream_gates` is accurate and load-bearing:
  `quality` aborted at step 13, so ~25 later gates produced no verdict at all.
