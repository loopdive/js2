---
name: project_2602_forawait_rest_aliases_source_recompile
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

#2602 (discovered by #2580 M2 slice 1): in `for await ([x, ...y] of [[1,2,3]])`,
a **fresh `compileExpression(y)`** (e.g. the `.length`-on-any reader's speculative
compile in the property-access `savedLen` block) resolves the **SOURCE array**
(a raw vec, field-0 = source length 3), NOT the rest slice `[2,3]` (length 2).
Origin reads `y` = 2 because its `compileExpression(y)` at a *different* point in
the flow gets the rest-slice local; the async state machine leaves the source as a
live SSA value that a later recompile picks up. **Proven exhaustively**: every read
of the receiver my arm gets — `struct.get` field-0, `__extern_get`, `__extern_length`
— returns 3, because the receiver VALUE itself is the source, not the rest.
Sync `[x, ...y] = [1,2,3]` reads 2 correctly; ONLY the async `for await` form
aliases the source. It is an **async-lane local-versioning bug, NOT a substrate
bug** — the #2580 dynamic-read reader merely EXPOSED it. Related: #1373b (IR async
CPS), #1042-adjacent (async state-machine local capture).

**Why it blocks #2580 M2 slice 1 (the `.length`-on-any reader):**
- The reader fires for `any`-typed receivers. The canary `{}`, Cluster A
  (undefined receivers), and Cluster B (async-rest `y`) are all statically
  identical `any` identifiers — NO compile-time separator.
- A clean decline-for-vec (route the vec receiver to origin so async-rest reads 2)
  is structurally impossible: vec-ness is RUNTIME for `any`, and even a runtime
  `ref.test`-vec branch that re-runs origin's read RECOMPILES `y` → the source (3)
  again. The only thing that reads 2 is origin's flow where the speculative compile
  is ROLLED BACK and `y` is resolved later — rollback is compile-time, vec-ness is
  runtime, so it can't be conditionally triggered.
- So slice 1 can NOT fire for vec-class receivers without regressing the 8
  for-await array-rest `.length` tests, UNTIL #2602 fixes `y` to resolve to the
  rest slice. Once #2602 lands, the arm's existing vec arm reads `y.length` = 2
  (struct.get field-0 = 2) and slice 1 lands all-13-green.

**What slice 1 DID fix (waiting behind #2602):** the canary `{}.length===undefined`
→ true (the #2580 HEADLINE) + Cluster A (5 host-builtin-`.length` tests), via a
null-guard `__extern_is_undefined(recv) → box_number(0)` (NOT `ref.is_null` — a JS
`undefined` is a non-null externref). WIP at `issue-2580-m2s1-reader` (b77a1c520 +
the #2602 issue fe93fe9bb), not pushed.

**Lesson:** a speculative `compileExpression` of an *identifier* is NOT guaranteed
to resolve the same wasm value the identifier's live local holds — in the async
state machine they desync. Recompile-based receiver reads (the #2580 reader, and
any future speculative-read site) must read the identifier's LOCAL by index where
possible, or be gated until #2602. See [[project_2580_m1a_length_reftest_dispatch]].
