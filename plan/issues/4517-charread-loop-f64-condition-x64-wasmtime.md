---
id: 4517
title: "#3931 char-read loop keeps an f64 loop condition — 5.4x wasmtime-x64 regression on the landing string-hash warm lane"
status: in-progress
sprint: current
created: 2026-08-16
updated: 2026-08-16
priority: high
horizon: s
feasibility: medium
task_type: bug
area: ir
goal: performance
related: [3931, 2682, 4505, 4557]
claimed_by: ttraenkler/fable-lead
---

# #4517 — the recognised char-read loop pays two int→float converts + a float compare per iteration

## Evidence chain (2026-08-16, Fable lane — measurements, not attribution)

- Landing lane `string-hash warm` (wasmtime x64, AOT): **238 → ~1,260 µs
  (5.3×)** across three consecutive refreshes after PR #4557 (the #3931
  char-read hoist) merged; the in-run JS control stayed flat.
- The same artifact is **FASTER everywhere testable locally (arm64)**:
  V8/node 7.50 → 1.62 ms median, wasmtime JIT 2.93 → 2.49 ms, wasmtime AOT
  2.92 → 2.50 ms — same wasmtime version (46.0.1) as the runner pins.
- wasm-opt DID inline the `__str_flat_charCodeAt` helper (zero calls survive
  in the -O3 binary), so the cost is the inlined loop shape itself.
- The disassembled hash loop (post-#4557, `-O3`): the BODY is clean i32
  (`h*31 + array.get_u(data, off+i)`), but per iteration it executes
  1. `f64.lt(f64.convert_i32_s(i), f64.convert_i32_s(struct.get len))` —
     the loop condition round-trips BOTH i32 operands through f64, and
  2. un-hoisted `struct.get .data` / `struct.get .off` re-reads.
- Cranelift performs no loop-invariant code motion and no cross-op
  strength reduction, so unlike V8 it executes all of that literally, every
  iteration, in a ~10-instruction loop. The pre-#4557 legacy emission used
  an i32 compare with data/off cached in locals — which is why it measured
  238 µs on the same runner. arm64 tolerates the fcvt+fcmp chain far better
  than the runner's x64, hence the arch split.

## Implementation Plan (Fable; implement per the plan/implement split)

**Fix at the narrowest site**: when `installCanonicalCharReadProof`
(src/ir/from-ast.ts, ~line 9301) recognises the loop, additionally hoist the
receiver's `.length` as an **i32 slot** in the preheader and lower the loop
CONDITION as an i32 compare against it. Do NOT touch the generic for-loop
condition lowering — unrecognised loops keep today's behaviour byte-for-byte.

1. **Preheader** (inside `installCanonicalCharReadProof`, after the flatten
   hoist): emit `len = <i32 length of recv>` into a new slot
   (`declareSlot("__cca_len", i32)`). Source the length from the SAME
   receiver value already lowered for the flatten (`recv`), via the
   backend's string-length intrinsic with an i32 result — mirror how
   `lowerForOfString` obtains its native length; if only an f64-length
   intrinsic exists, emit one `i32.trunc`-style convert ONCE in the
   preheader (string lengths are u31, exact in both types). Extend
   `CharReadProof` with `lenSlot`.
   - Soundness: identical invariance assumption as the flatten hoist that
     already shipped — the recogniser's shape check pins `recv` for the
     loop's extent. If flatten-hoisting is sound, length-hoisting is.
2. **Condition**: in `lowerForStatement`, when `charReadProof` is non-null
   AND the condition is the recognised `i < recv.length` (it is, by shape),
   bypass the generic `lowerExpr(cond)` and emit
   `i32.lt_s(slotRead(i as i32), slotRead(lenSlot))` — using however the
   induction variable is currently materialised (the emitted WAT shows it
   already lives as an i32 local; read it without converts). Keep the
   generic path as the fallback if any piece is unavailable (refuse-loud:
   return to the old lowering, never a half-applied condition).
3. **Do NOT attempt to hoist `.data`/`.off`** — they are raw backend refs
   and an IR value typed with one demotes the whole function (the #3931
   prepared-component constraint, documented in char-code-at-helpers.ts).
   Record the residual: making NativeString fields immutable so wasm-opt
   can hoist the `struct.get`s itself is a follow-up with type-identity
   blast radius; file separately if the measurement below still shows a gap.
4. **Validation gates (in order)**:
   a. `.tmp/probe-stringhash.mjs` (in the fix worktree) — result stays
      862771296; node median must stay ≤ post-#4557 (~1.6 ms on this box).
   b. wasmtime arm64 A/B via the emitted warm artifact (`emit-warm` +
      `wasmtime run -W gc=y -W function-references=y -W exceptions=y
      --invoke warm <wasm> 20000`): expect ≤ 2.5 ms (current post value);
      the pre-#4557 legacy shape suggests the i32 condition is worth
      measurably more.
   c. WAT check: the hash loop's condition contains NO `f64.convert_i32_s`
      and NO `f64.lt` (grep the disassembly) — this is the structural proof
      the x64 runner benefits even though we cannot execute x64 locally.
   d. `npm test -- tests/ir-` scoped set relevant to #3931 (the char-read
      tests) + tsc + equivalence gate.
   e. HONESTY CONSTRAINT for the PR body: local arm64 cannot confirm the
      x64 number. State that the confirmation is the first post-merge
      landing refresh, and that #4505's AC "the #4557 x64 question" gets
      its answer recorded there.
5. **Acceptance**: (c) structural proof + (a)(b)(d) green locally; the
   post-merge refresh restoring `string-hash warm` to the ~240 µs band on
   x64 closes the issue (record the refresh commit hash here).
