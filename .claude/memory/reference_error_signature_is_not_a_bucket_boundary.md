---
name: reference_error_signature_is_not_a_bucket_boundary
description: "Sizing a test262 lever by first-assertion error text produces wrong buckets — a downstream defect gets smeared across an unrelated-looking row, and a type bug can print as a value bug. Histogram to generate hypotheses; attribute per-file to draw boundaries."
metadata:
  node_type: memory
  type: reference
  originSessionId: 003c07aa-a2eb-5278-b5b1-6c63a0be18a6
---

**A failure's error text tells you where a test STOPPED, not which defect it
stopped on.** Bucketing a lever by first-assertion message therefore draws
boundaries in the wrong place, and the error is not random — it systematically
merges unrelated mechanisms and hides real ones.

**Four buckets dissolved this way in a single session (2026-08-06/07)**, three
of them sized by people who then had to retract their own numbers.

## The four

1. **"Method invocation is broken" → ~2–4 files, not the commonest shape.** A
   10-shape matrix showed inline literal methods already work: TypeScript types
   `this` as the literal and the read lowers to `struct.get`. Only a function
   defined *elsewhere* leaves `this` untyped. 155 files carried the shape, 86
   failed, and subtracting owned mechanisms left 12 — of which causality
   spot-checks disqualified most as constructor `this`, accessor receivers,
   bare-call sloppy `this`, prototype-chain lookup and IsCallable.

2. **A 41-file "M4 gOPD" bucket was FOUR mechanisms.** 15 `constructor`, 14
   `verifyProperty`, 11 global-object receiver, 1 `f.length`. The 14 are **not a
   descriptor bug at all** — their error is `"<m> should be an own property"`,
   i.e. `hasOwnProperty`. `gOPD(Array.prototype,"every")` already returns a
   correct descriptor, but only for a **direct syntactic** receiver; the whole
   mechanism is compile-time synthesis and `verifyProperty(obj, …)` takes its
   receiver as a *parameter*, so no static synthesis can ever fire there.

3. **A 13-file `[[Construct]]` row was 14, and the fix made all 14 construct
   correctly — while fixing only 2.** The rest fail on a *second* defect:
   standalone `<wrapper>.valueOf()` returns the wrapper, not
   `[[PrimitiveValue]]`. It prints `SameValue(«true», «true»)` because the
   wrapper stringifies as `"true"` — **a type bug that reads as a value bug.**
   Only the 2 files asserting via `hasOwnProperty` instead of `valueOf` moved.

4. **A "one mechanism gated too tightly" pointer was script-vs-module goal.**
   The claim was that 11 global-object files needed an alias-gate relaxation.
   Three of them use a **direct** `this`, and in module goal the existing fold
   already answers all five assertions correctly — they still fail. The real
   discriminator is that script top-level `this` is the realm global object and
   standalone has none (`isScriptGlobalThisReceiver` is `!ctx.standalone`,
   deferred to #3365).

## The rule

**Histogram the signature to GENERATE hypotheses. Attribute per-file to DRAW
boundaries.** Before quoting a bucket size:

- Take 3–5 files from the bucket and read what actually fails, not what prints.
- Ask whether the assertion that fired is the *first* thing wrong, or the first
  thing *observable*. A test that dies at line 59 never reaches the line-61
  assertion your defect would break.
- Expect a fix to move **fewer** files than the bucket, and say so up front.
  Three lanes here predicted their own yield correctly only after doing this.

## Two consequences that bite later

**Masking cuts both ways — a fix can CREATE a visible instance of another
defect.** `15.2.3.6-4-589.js` needs two independent fixes; it currently dies on
`hasOwnProperty` before reaching the assertion a var-widening defect would
break. If the `hasOwnProperty` half lands first, that file becomes a *fresh
failure* of the other defect rather than a new pass — which reads as a
regression to anyone who did not write it down.

**Do not count a masked file toward either fix's value.** It belongs to
neither until both land.

## Related

- [[reference_a_regression_summary_gives_size_never_shape]] — the same
  epistemics on the regression side: read the ROWS, diff the ERROR TEXTS.
- [[reference_standalone_eval_instrument_reports_unmeasured_failures]] — when
  the error text is not merely misleading but *manufactured* by a broken
  instrument.
