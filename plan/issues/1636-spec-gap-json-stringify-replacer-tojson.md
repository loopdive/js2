---
id: 1636
title: "spec gap: JSON.stringify replacer/toJSON/property-list (49 of 66 test262 fails)"
status: ready
created: 2026-05-08
updated: 2026-06-19
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: json
goal: spec-completeness
sprint: Backlog
renumbered_from: 1341
parent: 1328
related: 1324
---
# #1341 — JSON.stringify: replacer function, toJSON method, property-list filter

> **Status correction (2026-05-27).** A prior agent recorded this issue as
> ~87.9% / effectively done. That was wrong. Re-measured on current `main`
> via the real test262 runner: **`built-ins/JSON/stringify` = 18 / 66 (27.3%)**.
> The issue is genuinely OPEN, the root cause is structural (not a localized
> `src/runtime.ts` patch), and it is escalated for an architect spec.
> See **§Confirmed root cause** and **§Escalation** below.

## Problem

`built-ins/JSON/stringify`: **18 / 66 pass (27.3%)** (re-measured 2026-05-27 on
current main) — dominated by assertion_fail, with type_error / runtime_error /
null_deref tails.
`built-ins/JSON/parse`: ~71% (separate, not addressed here).

Spec §25.5.2 (JSON.stringify) requires:
1. **`replacer`** can be a function (called for every key, with `(key, value)`) or an Array
   (used as a property allow-list for objects).
2. **`toJSON`** method on a value: if present, called via `Get(value, "toJSON")` and the result
   replaces the value (Date, BigInt, Temporal use this).
3. **`SerializeJSONProperty`** algorithm: nested objects, arrays, escaping, NaN/Infinity → null.
4. **Cycle detection** must throw TypeError.
5. **Indent** can be a Number or String, capped at 10 spaces.

Current `__json_stringify` host-imports JS `JSON.stringify` directly, which should be spec-compliant.
The 42 assertion_fail errors strongly suggest:
- We're calling `JSON.stringify(value, replacer, space)` but the replacer is a Wasm closure that
  the host JS engine cannot invoke (no JS-to-Wasm bridge for the replacer callback).
- Or: the Wasm callbacks are wrapped in a way that loses the `this` (the holder object) per spec
  §25.5.2.2.

Pure-Wasm JSON is tracked by #1324; this issue is the host-mode fidelity problem.

## Confirmed root cause (2026-05-27)

The previous "Implementation Plan" assumed a localized fix at the
`__json_stringify` boundary (wrap the Wasm replacer in a JS closure). That
is **necessary but not sufficient**, because of a deeper, structural problem
in how Wasm values reach the host serializer.

**`_wasmToPlain` flattens the value graph *before* host `JSON.stringify` sees
it** (`src/runtime.ts:1564`, invoked from the stringify path at lines ~3075,
~3098, ~3534). It walks named structs (`_structToPlainObject`) and vec
wrappers recursively and returns a fresh plain JS object/array tree. By the
time the host `JSON.stringify(plain, replacer, space)` runs, the original
WasmGC values are gone. This loses, *irrecoverably*, everything
`SerializeJSONProperty` (§25.5.2.2 / §25.5.2.3) needs to observe on the
**live** value:

1. **`toJSON`** — §25.5.2.2 step 2 does `Get(value, "toJSON")` and, if
   callable, invokes it with the *original* value as `this` and the key as
   the argument. The flattened plain object has no `toJSON` method (methods
   are not struct fields), so it is never called. (Affects Date, BigInt
   wrappers, custom `toJSON`.)
2. **Replacer `this` = the live holder** — §25.5.2.2 step 3 calls the
   replacer with `this` set to the holder object and `(key, value)`. After
   flattening, the holder identity is a throwaway plain object, not the
   user's live struct, so `replacer-function-arguments.js` (which asserts on
   `this` identity and call order) fails.
3. **Wrapper `[[PrimitiveValue]]`** — `new String()/new Number()/new
   Boolean()` wrappers must be unwrapped per §25.5.2.2 steps 4–6 *after*
   `toJSON`. Flattening drops the wrapper brand, so `value-tojson-*.js` and
   wrapper tests fail.
4. **Cycle detection** — §25.5.2.2 requires a TypeError when a value is
   already on the serialization stack. Detection must run over the *live*
   graph during the recursive walk; the eager flatten neither detects cycles
   (it would infinite-loop or pre-resolve them) nor preserves identity for a
   stack check.
5. **String escaping / marshaling count** — `value-string-escape-ascii.js`
   shows a string-marshaling count mismatch at the boundary independent of
   the above.

### Why this is NOT a localized `runtime.ts` patch

A correct fix requires implementing **`SerializeJSONProperty` recursion over
live values** (Wasm-side or a faithful host-side walk that can call back into
Wasm for each node), so that `toJSON`, the replacer `this`/holder, wrapper
unwrapping, and cycle detection all observe the original value at each step —
instead of a pre-flattened copy. That, in turn, depends on a reliable
**JS↔Wasm closure-marshaling boundary** for the per-node replacer/`toJSON`
callbacks (no general JS-callable Wasm function-ref trampoline yet —
**#1308 / #1382**). Net: this is a cross-cutting serialization-model change,
not a patch to `_wasmToPlain` or the `__json_stringify` import.

## Escalation — needs architect spec

Routing this to an architect (`/architect-spec`) to design the
`SerializeJSONProperty`-over-live-values lowering. The spec should cover:

- Where recursion lives (Wasm-native `SerializeJSONProperty` vs host walk that
  calls back into Wasm per node) and how it interacts with the existing
  `_wasmToPlain` fast path for the common no-replacer/no-`toJSON` case.
- The JS↔Wasm callback boundary for replacer + `toJSON` (depends on
  **#1308 / #1382** closure marshaling — call out the dependency explicitly).
- Wrapper-object `[[PrimitiveValue]]` unwrap order vs `toJSON`.
- Cycle detection over live values (stack of seen holders).
- Whether to keep the flatten path as the standalone/pure-Wasm route (#1324)
  and only take the live-value path in JS-host mode, or unify both.

**Recommendation:** do NOT attempt a speculative partial fix at the boundary
— without the live-value walk it cannot move the four acceptance-criteria
tests and risks regressing the currently-passing flatten path. Hold for the
architect spec.

## Dependencies

- **#1308 / #1382** — JS↔Wasm closure marshaling (replacer + `toJSON`
  callbacks must be JS-callable with correct `this`). This is the
  closure-value boundary the live-value walk depends on.
- **#1644** — BigInt i64-bigint-brand representation. `JSON.stringify` must
  throw `TypeError` on a BigInt value (§25.5.2.2 step 12) and must invoke a
  BigInt `toJSON` if present; both need the BigInt brand to be observable at
  the serialization boundary, which #1644 establishes.
- **#1630 / #1631** — struct-target writeback + descriptor model. Wrapper
  `[[PrimitiveValue]]` unwrap and `toJSON` result substitution both depend on
  the descriptor/writeback model these issues define for struct-backed
  objects; without it the live-value walk cannot faithfully observe wrapper
  brands or replaced values.
- **#1324** — pure-Wasm JSON (the standalone-mode counterpart; the spec
  should decide whether the two paths unify).

## Acceptance criteria (unchanged)

1. `built-ins/JSON/stringify/replacer-function-arguments.js` passes.
2. `built-ins/JSON/stringify/value-tojson-{primitive,object}.js` passes.
3. `built-ins/JSON/stringify/replacer-array-{normal,non-normal}.js` passes.
4. Pass-rate for `built-ins/JSON/stringify` rises from 27% to ≥75%.

### Test262 sample (verified failing on current main, 2026-05-27)

- `test262/test/built-ins/JSON/stringify/replacer-function-arguments.js` — null-deref / holder-`this` lost
- `test262/test/built-ins/JSON/stringify/value-tojson-object.js` — `toJSON` never called
- `test262/test/built-ins/JSON/stringify/value-string-escape-ascii.js` — string-marshaling count mismatch

## Slice A landed (2026-05-28)

Implementation: `src/runtime.ts` — new helpers
`_normaliseJsonReplacer`, `_serializeJSONProperty`, `_serializeJSONObject`,
`_serializeJSONArray`, `_liveGet`, `_isJsonCallable`, `_invokeJsonCallable`,
`_liveIsArray`, `_liveGetEnumerableKeys`, `_quoteJSON`. The
`JSON_stringify` host import now branches on the normalised replacer:
`kind: "none"` → existing fast path (`_wasmToPlain` + host JSON.stringify);
`kind: "fn" | "list"` → live walk per §25.5.2.4 SerializeJSONProperty so
the replacer is invoked with the *original* WasmGC holder identity and
cycles raise TypeError instead of infinite-looping inside `_wasmToPlain`.

Tests: `tests/issue-1636-json-stringify.test.ts` — 7 active cases
covering cycle-self / cycle-via-replacer / numeric transform / drop /
no-replacer regression / pretty-print / array-skip-→-null. 3 cases
intentionally skipped and tagged `[Slice B]` (toJSON-on-plain-object,
needs `__sget_<method>` shim), `[Slice C]` (replacer `this`-identity,
needs #1308/#1382 explicit-`this` dispatch), `[boundary]` (the typed
host-import boundary coerces an `undefined` JSON output back to
"undefined" stringification).

Existing #1342 replacer suite stays green; the pre-existing
`issue-json-stringify-structs` failure on `serializes an array of
structs` reproduces on the unmodified branch and is unrelated to this
slice.

Slices B / C / D remain as specified above.
- `test262/test/built-ins/JSON/stringify/replacer-array-normal.js`

## Slice B landed (2026-05-28)

Implementation: `src/runtime.ts` — new helper `_hasReachableToJSON` and a
gate inside `JSON_stringify` on the `rep.kind === "none"` branch. The fast
`_wasmToPlain` + host `JSON.stringify` path is preserved when no `toJSON`
method is reachable from the root; when one is reachable, control falls
through to the existing live SerializeJSONProperty walk added in Slice A.

The walk's `_serializeJSONProperty` (lines 2143-2201) was already invoking
`toJSON` via `_invokeJsonCallable`; Slice B only had to route the
no-replacer call into it. Recursion in `_hasReachableToJSON` is bounded
(via `seen: Set`) and lazy (returns true on first match), so the common
no-`toJSON` case keeps its perf characteristic.

Tests: 4 new cases in `tests/issue-1636-json-stringify.test.ts`:
1. `JSON.stringify({ toJSON: () => "replaced" })` → `"replaced"` (arrow)
2. `JSON.stringify({ toJSON() { return 42; } })` → `42` (method shorthand)
3. `JSON.stringify({ toJSON: function () { return "fn"; } })` → `"fn"`
4. Regression guard: `JSON.stringify({ a:1, b:2 })` still hits the fast
   path (verified `_hasReachableToJSON` returns false).

Out of scope for Slice B (deferred to a deeper compiler change):
- **Nested `toJSON` inside an array literal**
  (`JSON.stringify([1, {toJSON:...}, 3])`) — the compiler flattens
  heterogeneous array-literal elements into a bare JS array via the
  externref-coerce path, destroying the WasmGC struct's `__sget_toJSON`
  binding before `_hasReachableToJSON` can observe it. Visible regression:
  closure-typed fields serialize as `[]` because the closure struct is
  flattened by `_wasmToPlain`. Same root cause Slice A flagged for
  primitive brand loss (§"Empirical baseline" probe #3).
- **Nested `toJSON` on an object property with `any`-typed parent** —
  TypeScript inference collapses `any`-typed object literals onto the
  first matching anonymous struct, so the parent struct ends up with the
  inner literal's field shape and the user's actual fields disappear at
  codegen. Visible: outer obj's enumerable keys come back as the inner's
  fields. Both blockers belong to a sibling issue (Slice 5 of the
  architect spec).

## Architect spec (2026-05-28, sendev-1542)

The 2026-05-27 escalation block stays — this is genuinely a cross-cutting
codegen change, not a localized `runtime.ts` patch. This section operationalises
the work into mergeable slices grounded in empirical probes, and identifies the
**codegen-side dependency the prior root-cause section missed**.

### Empirical baseline (2026-05-28 probes)

Three probes against current `main` (HEAD `7006b91e2`, src/runtime.ts:3563-3611):

1. **toJSON ignored (FAIL).** `JSON.stringify({a:1, toJSON: () => "T"})` → `{"a":1}`; should be `"T"`. Confirms `_wasmToPlain` flattens the value graph and drops sidecar/closure-valued `toJSON` before host `JSON.stringify` runs.
2. **Replacer with live-holder `this` (RUNTIME-ERROR illegal cast).** The host wraps the replacer via the `callback_maker` host bridge (`src/runtime.ts:7367-7372`), which dispatches via `__cb_${id}(cap, ...args)`. `cap` is the closure capture; **there is no separate `this` parameter** in the `__cb_${id}` signature. When host JSON.stringify invokes the replacer with `this = holder`, the holder reaches Wasm in the position the closure expects a typed capture and `ref.cast` traps. This is the same failure mode as #1529-A but for closure dispatch.
3. **Primitive brand loss (REGRESSION).** `JSON.stringify({a:1,b:"x",c:true})` returns `'{"a":1,"b":"x","c":1}'` — boolean `true` becomes `1`. The existing flatten path **already** loses brands on f64-typed struct fields. So the "currently-passing flatten path" framing in the 2026-05-27 escalation block is optimistic; even non-replacer/no-toJSON cases lose fidelity once boolean fields are involved.

### Codegen dependency the prior section missed

There are **two** JS→Wasm closure-call mechanisms in current `runtime.ts`, used in different code paths:

| Path | Mechanism | `this` carried? | Where |
|------|-----------|-----------------|-------|
| Generic closure dispatch (Symbol.iterator, Symbol.toPrimitive, replacer literal) | `__call_fn_N(closure, ...args)` | NO — `this` is captured via the closure's own capture | `src/runtime.ts:1419, 1423, 1626, 1655, 3578` |
| Host-callback bridge (when a Wasm closure is *handed to host JS code*) | `__cb_${id}(cap, ...args)` | NO — same omission | `src/runtime.ts:7367` |

Neither path threads a host-supplied `this` into the Wasm callee. For JSON.stringify the spec wants `Call(toJSON, value, [key])` — `this = value` — and `Call(replacer, holder, [key, value])` — `this = holder`. Both `this` values are *host-decided*, not captured.

**Conclusion:** the impl needs a third dispatch mechanism, e.g. `__call_fn_method_N(closure, thisVal, ...args)` (codegen change in `src/codegen/expressions/calls.ts` + closure literal emit in `src/codegen/expressions/literals.ts` + a runtime export). Without it, no host walk over live values can implement spec §25.5.2.2 step 3 (replacer this) or step 2.b.i (toJSON this).

This dependency is **not** the general JS-callable Wasm function-ref trampoline (#1308/#1382) — those issues are about handing a Wasm function pointer to arbitrary host code so the host can invoke it whenever. Here we already control the invocation site (it's our own host walk), we just need to pass `this`. That's a smaller, scoped change.

### Sliced impl plan

**Slice 1 — `__call_fn_method_N` codegen + runtime export (~150 LOC, no test262 movement)**

- Add `__call_fn_method_0/1/2/3` exports in `src/codegen/expressions/calls.ts` (sibling to the existing `__call_fn_N` emitters)
- Signature: `(funcref $closure, anyref $this, …args) → anyref`. The body is the same as `__call_fn_N` except instead of dropping `$this`, it stores it in a thread-local global that the closure body's `this`-resolution can read (or, simpler: rebind the closure's existing `this` capture slot at call time — needs design).
- Acceptance: no test262 movement (no consumer yet). Unit test: a closure literal `function(){ return this.x }` invoked via `__call_fn_method_0(closure, {x:42})` returns 42.

**Slice 2 — toJSON pre-walk (~70 LOC, lands ~10-15 fails)**

- Add `_collectToJSONHolders(v, exports)` — a recursive *non-flattening* walk that returns either `null` (no `toJSON` reachable) or a map `WeakMap<wasmStruct, callable>` of nodes that have `toJSON`.
- In `JSON_stringify`: if the map is empty, skip pre-walk (preserves the existing 16/18 flatten fast path). Else, recursively rebuild the value graph, substituting each entry per spec §25.5.2.2 step 2 via `__call_fn_method_1(toJSON, holder, key)`.
- Hand the substituted tree to existing `_wasmToPlain` + `JSON.stringify`.
- Acceptance: `value-tojson-arguments.js`, `value-tojson-object.js`, `value-tojson-primitive.js`, `value-tojson-result.js`, `value-tojson-not-function.js` flip pass. Targeted test: `tests/issue-1636-tojson.test.ts` (3 unit cases).

**Slice 3 — host-side SerializeJSONProperty walk for replacer-with-this (~200 LOC, lands ~20 fails)**

- Replace `JSON.stringify(plain, rep, sp)` with an in-runtime `SerializeJSONProperty` recursion that calls the replacer at each node via `__call_fn_method_2(replacer, holder, key, value)` *during* the walk — so `holder` identity is preserved per §25.5.2.2 step 3.
- Gate on `rep !== undefined` AND replacer is a Wasm closure (the JS-function-replacer case keeps the current bridge).
- Cycle detection: stack-of-seen-holders, throw `TypeError` on revisit per §25.5.2.2 step 1.
- Acceptance: `replacer-function-arguments.js`, `replacer-function-result.js`, the `replacer-array-*-object.js` cluster.

**Slice 4 — wrapper `[[PrimitiveValue]]` unwrap + BigInt TypeError + escape count (~80 LOC)**

- Wrapper unwrap depends on **#1568** (Object(BigInt)/Object(Symbol) auto-box — already complete) and **#1630/#1631** (struct-writeback descriptor model — also complete). Read the brand via the existing wrapper-prototype-chain check.
- BigInt TypeError per §25.5.2.2 step 12 — depends on **#1644** Slice B (i64-bigint-brand, PR #766 in flight). Until Slice B lands, throw a TypeError on any value whose `typeof === "bigint"`.
- String escape count: investigate `value-string-escape-ascii.js` once the live-walk path exists; likely a marshaling-boundary issue inside the substituted-string handling.

**Slice 5 — primitive brand fidelity on flatten path (~30 LOC, regression fix surfaced by the 2026-05-28 probe)**

- `_structToPlainObject` reads field values via `__sget_<f>`; if the field is f64 but a struct flag says "boolean", round-trip through Boolean.
- Same for f64-as-Number-wrapper vs raw number (depends on #1568 brand observability — same module).
- This is a **separate sub-issue** worth carving — it affects the 16 currently-passing cases as well, so it can ship independent of #1636.

### Why this is mergeable in slices (not all-or-nothing)

The 2026-05-27 escalation framed this as "no localized patch." The slices above preserve that conclusion (no single PR can move all 49 fails) **but** show three landable slices with measurable, non-overlapping acceptance buckets:

- Slice 1 unblocks all subsequent slices (codegen dep) — no observable test262 effect.
- Slice 2 lands ~10-15 (toJSON family) — does NOT regress flatten path because of the empty-map gate.
- Slice 3 lands ~20 (replacer-with-this) — does NOT touch toJSON.
- Slice 4 lands the wrapper / BigInt / escape tail — depends on Slices 2/3.
- Slice 5 is the surprise regression-fix carved out as a standalone issue (likely a new #1636-aside).

### Dependencies (corrected)

- **#1308 / #1382** — NOT a blocker. Those are about exporting Wasm closures to *arbitrary* host code; here our host walk owns the invocation.
- **`__call_fn_method_N` codegen** (new dep) — Slice 1 of this spec.
- **#1644 Slice B** — Slice 4 (BigInt TypeError). In flight as PR #766.
- **#1568** — DONE. Used in Slice 4 + Slice 5.
- **#1630 / #1631** — DONE. Used in Slice 4 (brand observability).
- **#1324** — Separate workstream (pure-Wasm JSON for standalone mode). Slices 2/3/4 stay JS-host only; #1324 keeps the flatten path for `--standalone`.

### Risk register

| Risk | Mitigation |
|------|------------|
| Slice 1 changes closure ABI → breaks existing `__call_fn_N` callers | New exports `__call_fn_method_N` are *additive*. Existing `__call_fn_N` untouched. |
| Slice 2 pre-walk on a non-toJSON graph imposes a perf tax | Empty-map gate skips the walk entirely. The walk only runs if `_collectToJSONHolders` returned non-null. |
| Slice 3 cycle-detection diverges from host `JSON.stringify` cycle semantics | Pin to spec §25.5.2.2 exactly; add cycle test from `value-tojson-array-circular.js`. |
| Slice 5 brand round-trip changes existing-pass output | Gate slice 5 on a per-field brand flag — only applies to fields explicitly typed `boolean`/`Number`/etc. Audit existing flatten-path test262 passes before merging. |

### Verdict

Spec deliverable: this section. Implementation order: 1 → 2 → 3 → 4. Slice 5 belongs in a sibling issue (it surfaces a pre-existing brand-loss bug that affects more than JSON). Any developer (not necessarily senior-dev) can pick up Slice 2 / 3 / 4 individually once Slice 1 lands. Slice 1 itself is senior-dev work (closure-ABI codegen).

Status returning to `ready` — escalation block above remains valid until Slice 1 has an owner; once Slice 1 lands, status flips to `in-progress` and subsequent slices are carved as child issues `#1636-S2`, `#1636-S3`, `#1636-S4`.

## ⚠️ Slice 1 caused a strict-`this` regression — guard Slices 2/3 (2026-05-29)

Slice 1's `__call_fn_method_N` this-threading (PR #873) shipped a
`__current_this` **fallback** that leaked a `this` value into **strict-mode**
functions that must observe `undefined`. Net **−101 test262** at the #873
merge (171 regressions / 70 fixes), clustered in `language/function-code`
(strict `this`), `language/directive-prologue`, and `built-ins/Array`
(`every`/`some` thisArg threading) — `'this' had incorrect value!`,
`typeof this` ≠ `"undefined"`, `innerThisCorrect` failures.

Fixed by **PR #895** — gated the `__current_this` fallback to
**host-dispatchable closures only**; ~139 tests recovered in exactly those
clusters. Confirmed via per-test baseline diff (investigation 2026-05-29).

**Guard for Slices 2/3:** any further this-val threading must NOT install a
`this` for a call site whose target is a strict-mode function. Add a strict-mode
regression test (a strict fn asserting `this === undefined`) to the slice's
test set before merging.

## Frontmatter reconcile (2026-06-12)

Was `in-progress` with no open PR, no active agent, and no Suspended Work section (session died sprints 42-52). Reset to `ready` during the sprint-62 issue review; re-validate against current main before claiming (#2148).
