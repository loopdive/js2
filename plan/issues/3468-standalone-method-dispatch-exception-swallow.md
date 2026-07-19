---
id: 3468
title: "Standalone: method calls on function objects silently swallow assertions (assert.sameValue/throws never fire) — root cause is function-object own-property gap, NOT a catch_all swallow"
status: blocked
created: 2026-07-19
blocked_reason: "root-caused; needs architect spec (approach A/B/C) + stakeholder floor-rebaseline decision before implementation"
priority: high
feasibility: hard
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860, 3417]
---

# #3468 — Standalone method-dispatch "exception swallow" (root-caused)

> **Folds under #2860** (standalone↔host gap umbrella); cross-refs #3417
> (oracle-v8 reclassification). Origin: the Cluster C / C1 finding in the
> host↔standalone parity investigation (`/workspace/.tmp/parity-findings.md`).

## STATUS: root-caused, BLOCKED ON A SCOPING + FLOOR-REBASELINE DECISION

The bug is confirmed and multiply-reproduced. **But the root cause is NOT what
the parity investigation hypothesised, and the real fix is a substantial
feature, not a targeted exception-wiring change.** This issue therefore needs a
scoping decision (which approach) and a stakeholder floor-rebaseline decision
(the fix changes the standalone floor) before implementation. No PR is open;
no red regression test is committed (it cannot merge until the floor is
re-baselined).

## Confirmed symptom (real test262 pipeline)

Under `--target standalone` with the **exact** test262-worker compile options
(`allowJs:true, skipSemanticDiagnostics:true`, JS source, `(start)`-init model),
the test262 `assert` harness silently no-ops:

| Probe | Expected | Standalone actual |
| --- | --- | --- |
| `assert.sameValue(1, 2, "m")` | THROW `Test262Error` | **no throw** (vacuous pass) |
| `assert.throws(TypeError, ()=>{})` | THROW | **no throw** (vacuous pass) |
| `assert.sameValue(2, 2)` | no throw | no throw (correct) |

`assert` is a function object; `assert.sameValue`/`assert.throws`/`_isSameValue`
are properties assigned to it. Because those properties are **dropped**, the
call resolves to `undefined` and the assertion's `throw` never executes → the
test is scored a **VACUOUS PASS**.

## Root cause (corrected — this overturns the investigation's hypothesis)

**Function objects (closures) cannot carry own properties under `--target
standalone`.** Assigning a property to a callable value is dropped, and reading
it back yields `undefined`, so a "method" call on a function object never
invokes anything.

Decisive, unconfounded evidence (probes in the worktree `.tmp/`):

- `f.m = fn` then `f.m()` where `f` is a function -> returns **undefined**, not
  the method's value. Distinctive-return probe: method returns `777`, call site
  reads `0` (undefined). Plain-object control `o.m = fn; o.m()` correctly reads
  `777`.
- Side-effect probe: a global written **inside** the method stays at its initial
  value -> **the method body never executes**. The `throw` is never reached
  because the call never happens.
- `f.x = 5; return f.x` on a function object -> **NaN** (undefined). Plain-object
  control returns `5`.
- **The generated WAT contains ZERO `try`/`catch`/`catch_all`.** There is no
  exception being caught and dropped. The investigation's hypothesis — "the
  method-dispatch export wrapper in `closure-exports.ts` saves/restores
  `__current_this` around `call_ref` with no `catch_all`, so add one + rethrow"
  — is **wrong**: no exception ever propagates out of the (never-invoked)
  method, so a `catch_all`+rethrow there would be a **no-op**. Do NOT implement
  that fix.
- The investigation's "`assert._isSameValue("a","b")` returns false correctly,
  so the comparison works" claim was a **false positive**: an un-invoked method
  returns `undefined`, which is falsy, so `... ? 1 : 0` yields `0` — the same as
  a real `false`. A distinctive-value re-test shows `_isSameValue` is **not**
  invoked either.

### Why `__extern_method_call` returns undefined on a function receiver

`a.m(args)` on an `any`-typed receiver lowers to
`__extern_method_call(recv, "m", args)` (`src/codegen/object-runtime.ts` ~3979).
Its dispatch is `ref.test $Object(recv)` -> on match, resolve via `__extern_get`
+ `__apply_closure`; **else return `ref.null.extern` (undefined)**. A closure is
NOT a `$Object`, so the `ref.test` fails and the whole call returns undefined.
Symmetrically, `__extern_get`/`__extern_set` (~1409) gate on `ref.test $Object`
and miss on closures, so both property read and write on a function value are
no-ops.

### What already works (bounds the fix)

- **`.prototype`** assignment/read persists through `new` — there is a dedicated
  prototype slot, not general own-property storage.
- **Class static methods** (`class C { static m() {} }; C.m()`) work — but via
  **compile-time** resolution (static members become module globals +
  tag-dispatch, `src/codegen/class-bodies.ts:800/1450`,
  `class-member-keys.ts`), NOT a runtime callable-carries-properties
  representation.
- There is **no general runtime mechanism** for "a callable value carries
  arbitrary own properties." That is exactly what is missing.

## Candidate approaches (for the scoping decision)

**A. Compile-time function-object property tracking (targeted, mirrors class
statics).** Track properties assigned to module-level function *declarations*
(`assert.sameValue = fn`) into a compile-time map, and statically resolve
`X.prop(...)` / `X.prop` where `X` is such a declaration to a direct call/read.
- Covers the dominant case: the test262 `assert` harness is a module-level
  `function assert(){}` with statically-named method assignments and statically-
  named call sites — all resolvable at compile time.
- Does NOT cover dynamically-aliased function objects (`const g = assert; g.x`)
  or property access on function *values* flowing through `any`.
- Effort: **medium**. Risk: **moderate** (new static-resolution path; must not
  regress the existing `__extern_method_call` dynamic path).

**B. Runtime callable-`$Object` representation (general).** Box a
property-carrying function into a callable `$Object` (internal callable slot) so
`__extern_get`/`_set`/`__extern_method_call` work uniformly and dispatch invokes
through the slot.
- Fully general. Touches value representation, closure classification, `typeof`,
  and call lowering. Effort: **large**. Risk: **high** (broad-impact; validate
  on `merge_group`).

**C. Closure-identity-keyed side property table (general, less invasive to value
rep).** Keep closures as-is; give `__extern_set`/`_get`/`__extern_method_call` a
fallback that stores/looks up properties in a runtime identity-keyed map when the
receiver is a closure rather than a `$Object`.
- More general than A, less invasive than B. Needs closure identity + a global
  map + method-dispatch routing through it. Effort: **medium-high**. Risk:
  **medium**.

**Recommendation:** this is architect-spec territory. Approach **A** is the most
tractable path to unblocking the test262 `assert` harness (the dominant value);
**C** is the general fallback if aliased function objects matter. Route through
`/architect-spec` before implementation.

## Floor / #2860 metric impact (corrected narrative)

The parity finding framed this as a **pure pass->fail lowering** ("~thousands of
vacuous passes become correct fails, lowering the floor to truth"). That is only
partly right — making assert methods callable is a **feature**, so the net floor
direction is **mixed**, not purely down:

- **should-FAIL tests** currently vacuous-pass -> will correctly **FAIL**
  (pass->fail; the "lowering"). This is the dominant flip and the reason the
  standalone-floor regression gate WILL trip on `merge_group`.
- **should-PASS tests** currently vacuous-pass -> still pass (now genuinely; no
  flip).
- Some tests failing **only** because an assert method wasn't callable may flip
  **fail->pass**.

Net is a truthful re-baseline, predominantly downward, but not one-directional.
The exact flip count must be **measured empirically on a representative subset
after the fix lands** (not computable a priori; do NOT run full test262 locally).
A **standalone-floor re-baseline** is required and gated on the stakeholder
decision (per the dispatching tech-lead's instruction: this fix must not
auto-land).

## Regression guard (to add WITH the fix, once floor is re-baselined)

A focused vitest under `tests/` asserting that on `--target standalone`:
- `assert.sameValue(1, 2)` **throws** (scores fail), and
- `assert.throws(TypeError, () => {})` **throws** (scores fail).

Not committed yet — it is a red test until the fix lands, and it cannot merge
before the floor re-baseline.

## Bug 2 (separate, smaller, optional): top-level `throw` statement dropped

Independent of the above: a `throw` statement at module top level is silently
elided from the standalone `(start)`/init body. `throw 42;` as the sole
top-level statement compiles to an empty ~5.6 KB module with **no `(start)`
section**. Verified it is **throw-only**, not whole-init DCE: `var g = 0;
function set(){ g = 7; } set(); throw 42;` runs the side effect (`g === 7`) but
still does not throw. Low test262 value (few tests end in a bare top-level
throw); offer as an optional standalone-correctness win, separate PR.

## Repro probes (durable)

In the worktree `.tmp/`: `repro.mjs`, `probe2.mjs`-`probe8.mjs`, `caseA.wat`,
`C_tail.wat`. All use `compile(src, { target: "standalone", ... })` and
`WebAssembly.instantiate`.
