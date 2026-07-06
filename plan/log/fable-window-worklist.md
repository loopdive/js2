# Fable-window worklist — ready-to-execute queue (consolidated 2026-07-07)

**Purpose.** During the 2026-07 Opus session the seniors/devs root-caused a set
of conformance gaps that turned out to be substrate-deep or otherwise
**not cleanly landable on Opus** — each was documented and de-risked but left
unimplemented because the real fix needs the Fable budget window (hard /
architectural / `model: fable`). This file consolidates that scattered
de-risking into **one prioritized, root-caused queue** so the next Fable window
can execute without re-deriving.

For each item: **root cause** (one line) · **fix approach** · **exact issue
ref**. Verify each against current `main` before coding — several written
findings this session were stale (verify-first).

---

## Tier 0 — substrate roots (land these first; they unblock the Tier-1 gaps)

These are the deep enablers. Most Tier-1 gaps below are *instances* of one of
these, so landing the substrate closes clusters, not single tests.

| # | root cause (one line) | fix approach |
| --- | --- | --- |
| **#2773** | any/dynamic values have no uniform native representation → reconstructed dynamic reads return `NaN`/`null` when TS can't infer the concrete type. | `[EPIC][ARCH]` value-rep substrate: one native dispatch for reconstructed dynamic values. Closes the object-destructuring-param NaN residual (see Tier-1 #2774 note) and most any-receiver read gaps. |
| **#2963** | methods/builtins have no stable first-class value identity (dynamic `__get_builtin` shape re-materialises a wrapper per access). | Reify builtins/methods as first-class values with canonicalisation. Enables #3080 and the whole class-method-identity cluster (`c.m === C.prototype.m`, ~87 test262 files). |
| **#3037** | standalone dynamic reads don't canonicalise object identity → `ref.eq`/`===` between two reads of the same object is false. | Object-identity canonicalisation substrate for standalone dynamic reads. Co-enabler with #2963 for method/object identity. |
| **#2865** | standalone async generators / `for await` have no Wasm-native carrier — `asyncGen()` returns `null` / leaks `__…`. | Wasm-native async-generator + for-await carrier. Closes the async-generator `forbidden-ext` cluster (~46 files) and unblocks #2978. |
| **#2895** | a genuinely-pending `await` cannot suspend the current frame (only the single-tail-await fast path works). | True frame suspension (AG1 / PATH). Prerequisite for #2978 and real multi-await async. |

---

## Tier 1 — language/semantics gaps (Opus-documented, Fable to land)

Ordered by leverage. Each names the Tier-0 substrate it depends on (if any).

### #3049 — `Iterator.prototype` helpers (`map`/`filter`/`take`/`drop`/`flatMap`/…) → "X is not a function"
- **Root cause:** the 4th layer — the helper's internal iterator-record must
  **dispatch the user callback (mapper/predicate), a *compiled closure*, across
  the `externref` boundary**; that closure-through-externref dispatch is not
  wired, so the helper method resolves as not-a-function / traps.
- **Fix approach:** implement compiled-closure dispatch across `externref` in
  the iterator-helper lowering (materialise the callback as a callable the
  helper record can invoke; reuse the closure-struct call path).
- **Ref:** #3049 (`ready`, hard, `model: fable`).

### #3050 — `Generator.prototype.throw()` through `try/finally` / `try/catch` hits `unreachable`
- **Root cause:** the generator resume machine does **not model try-region
  state**, so a `.throw()` resumed into a `try/finally` cannot route the abrupt
  completion through the `finally` — it falls off into an `unreachable`.
- **Fix approach:** a **try-region state-machine** in the generator (and shared
  async) drive layer — track the active try/finally regions per suspension
  point so a resumed throw unwinds through the correct `finally`.
- **Ref:** #3050 (`ready`, hard, `model: fable`).

### #2978 — standalone `for await` over a sync iterator yielding a **rejected** promise
- **Root cause:** **no bounded synchronous fix exists** — the rejected promise
  must **suspend the async frame** and reject on resume; the current lane can't
  suspend there.
- **Fix approach:** depends on **#2895** (frame suspension) + the **`$Promise`
  widen** from **#2865**'s carrier. Do not attempt a sync shortcut (verified: no
  bounded sync fix).
- **Ref:** #2978 (`ready`, hard, `model: fable`) → blocked on #2895 / #2865.

### #3076 — standalone destructuring must invoke throwing accessor getters / user `@@iterator`
- **Root cause:** the standalone destructuring lowering does **not invoke**
  user-defined getters or a user `@@iterator` while binding a pattern (host mode
  does), so `var {p} = {get p(){throw}}` / `var [a] = throwingIterable` silently
  bind instead of throwing. Also **exposes standalone `assert.throws` leniency**
  (opaque WasmGC thrown values ⇒ any throw passes) → **vacuous** assertions.
- **Fix approach:** wire getter / `@@iterator` invocation into the standalone
  destructuring lane; and de-vacuify standalone `assert.throws` so a real
  Test262Error is distinguished (the vacuity-metric strand — see **#3056**).
- **Ref:** #3076 (`ready`, hard) — **blocks #3040**; vacuity strand **#3056**.

### #3080 — arrow-captured-`this` private-method value identity (`this.#m === (()=>this)().#m`)
- **Root cause:** accessing a private method **as a value** materialises a
  fresh, non-canonical function wrapper per access → two accesses of the same
  method on the same receiver are not `===` (fails for class **declarations**;
  the class-expression form passes since #3045's Bug-2 fix). Method **calls**
  through the arrow are fine — only the value identity fails.
- **Fix approach:** method-value reification/canonicalisation → **folds into
  #2963 / #3037**; not a bespoke wrapper-dedup.
- **Note (verify-first):** #3045's other residual — private-method `.name`
  (`this.#m.name === '#m'`) — is **already resolved on main** (basic / generator
  / static / via-local all pass). **Do not re-chase `.name`.**
- **Ref:** #3080 (filed this session; `ready`, hard, `model: fable`).

---

## Related context (not Fable-window, recorded to prevent re-chasing)

- **Destructuring-param-default cluster (47 files, `Cannot destructure null in
  __closure`).** Root cause = the closure free-variable scan skipped parameter
  defaults, so a var used only in a param default wasn't captured (`(x=o)=>x`
  returned `0`). **Fix is landing via PR #2774 (#3040, Fable)** —
  independently confirmed correct. **Residual after #2774:** object-destructuring
  params still return `NaN` when TS can't infer the field type (arrow-in-var /
  variable arg) — that residual is **#2773**, not #3040.
- **#3026 negative-test residual (6 real, deferred — NOT Fable-window):** eval ×2,
  module+top-level-await, `using`/ERM, strict-`PutValue` runtime, restricted-global
  runtime. Bounded early-error lane is done (#2779, merged). These belong to their
  feature epics, not this queue.
- **Stale-baseline caution:** the fetched `test262-current.jsonl` lagged `main`
  badly this session (e.g. 49/55 `negative_test_fail` entries were phantom).
  **Re-verify any cluster against `runTest262File` on current `main` before
  coding.**
