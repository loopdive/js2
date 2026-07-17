// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Peephole optimization pass for Wasm function bodies.
 *
 * Eliminates redundant instructions that are provably unnecessary:
 *
 * 1. ref.as_non_null after ref.cast — ref.cast (opcode 0x16) already produces
 *    a non-null reference, so the subsequent ref.as_non_null is redundant.
 *    This pattern appears frequently at closure call sites:
 *      struct.get $closure 0
 *      ref.cast $funcType      ;; already non-null
 *      ref.as_non_null         ;; redundant — removed
 *      call_ref $funcType
 *
 * 2. local.get N; drop — loading a local then immediately dropping it is a
 *    no-op (local.get has no side effects). Both instructions are removed.
 *      local.get N   ;; push value
 *      drop          ;; pop it — net effect: nothing. Removed.
 *
 * 3. local.tee N; drop — tee saves to local AND pushes a copy. If the pushed
 *    copy is immediately dropped, replace with local.set (save only, no push):
 *      local.tee N   ;; save + push
 *      drop          ;; pop the copy — replace with local.set N
 *
 * 4. Postfix increment/decrement dead-store: when i++ / x-- is used as a
 *    statement (result discarded), the compiler emits an extra local.get for
 *    the "expression result" that is immediately dropped after the update.
 *    Pattern (272 cases in corpus — #957):
 *      local.get N      ;; push old value (expression result — will be dropped)
 *      local.get N      ;; push N for computation
 *      i32/f64.const 1
 *      i32/f64.add/sub
 *      local.set N      ;; store incremented/decremented value
 *      drop             ;; drop old value — wasted push+drop pair
 *    Optimized:
 *      local.get N
 *      i32/f64.const 1
 *      i32/f64.add/sub
 *      local.set N
 *
 * 5. ref.test T + if(then [local.get N; ref.cast T; ...]) when local N is (ref_null T)
 *    (#955): ref.test already proves the value is non-null and of type T, making the
 *    subsequent ref.cast T a runtime no-op.  Replace ref.cast with ref.as_non_null
 *    (saves 2+ bytes; valid because (ref_null T) + ref.as_non_null → (ref T)):
 *      local.get N         ;; (ref_null T) local
 *      ref.test (ref T)    ;; proved: non-null, type T
 *      if (then
 *        local.get N
 *        ref.cast (ref T)  ;; redundant — replace with ref.as_non_null (1 byte)
 *        ...
 *      )
 *
 * 6. `i32.const 0; i32.or` — bitwise OR with 0 is identity; the upstream value
 *    must already be i32 to satisfy Wasm validation, so the pair is always a
 *    no-op (#1197). Removes the redundant `| 0` coercion that JavaScript code
 *    typically writes to force ToInt32 (the Wasm IR has already produced i32):
 *      array.get $__arr_i32   ;; i32 element load
 *      i32.const 0
 *      i32.or                 ;; redundant — both removed
 *
 * 7. `f64.const 0; f64.const 0; f64.div` → `f64.const NaN` (#1920). Several
 *    emit sites materialize NaN as a 0/0 division (3 instrs) when NaN is
 *    directly encodable as an f64 const (1 instr) — `f64.const NaN` is already
 *    used directly in type-coercion.ts and encodes via the raw 8-byte float.
 *    Normalizes both existing 0/0/div triplets and any future ones (3→1):
 *      f64.const 0
 *      f64.const 0
 *      f64.div        ;; → single f64.const NaN
 *
 * 8. `local.set N; local.get N` → `local.tee N` (#1920). A store immediately
 *    followed by a reload of the SAME local is exactly what `local.tee`
 *    expresses in one instruction (store + leave a copy on the stack). Safe
 *    because nothing observes the stack between the two and the local value is
 *    unchanged (2→1):
 *      local.set N
 *      local.get N    ;; → single local.tee N
 */
import type { Instr, ValType, WasmModule } from "../ir/types.js";
import { walkChildren } from "./walk-instructions.js";

/**
 * Remove redundant ref.as_non_null after ref.cast in a single instruction list.
 * Recurses into block, loop, if/then/else, and try/catch bodies.
 * Mutates the array in place and returns the number of instructions removed.
 *
 * @param localTypes - flat array of Wasm types for locals in the enclosing function:
 *   indices [0..numParams-1] are param types, [numParams..] are declared locals.
 *   Used by Pattern 5 to look up whether a local is (ref_null T).
 */
function optimizeBody(body: Instr[], localTypes?: ValType[]): number {
  let removed = 0;

  // First, recurse into nested child bodies. #1920 — drive the descent through
  // the SHARED `walkChildren` enumerator (walk-instructions.ts) instead of a
  // hand-rolled per-op switch. The old switch silently skipped `try.catchAll`
  // for a long time (the bug this issue tracks): every pass that re-implements
  // child enumeration risks diverging from the others. Going through the one
  // enumerator means peephole automatically covers every nested buffer
  // (`then`/`else`/`body`/`catches[].body`/`catchAll`) and any future Instr
  // child field, with no chance of the walkers drifting apart again.
  for (const instr of body) {
    walkChildren(instr, (children) => {
      removed += optimizeBody(children, localTypes);
    });
  }

  // Scan for peephole patterns
  let i = 0;
  while (i < body.length - 1) {
    const cur = body[i]!;
    const next = body[i + 1]!;

    // Pattern 1: ref.cast followed by ref.as_non_null — remove the latter
    if (cur.op === "ref.cast" && next.op === "ref.as_non_null") {
      body.splice(i + 1, 1);
      removed++;
      // Don't increment i — check for multiple ref.as_non_null in a row
      continue;
    }

    // Pattern 2: local.get N; drop — dead load, remove both
    if (cur.op === "local.get" && next.op === "drop") {
      body.splice(i, 2);
      removed += 2;
      // Don't increment i — recheck at same position (new pair may have formed)
      continue;
    }

    // Pattern 2b: global.get N; drop — dead load, remove both (#908). Reading a
    // Wasm global is side-effect-free, so pushing a global's value and then
    // immediately dropping it is pure dead value traffic — the exact `global.set
    // N; global.get N; drop` tail codegen leaves for a discarded compound
    // assignment to a module global (e.g. `result += squared(10)` as an
    // expression statement). Removing the get/drop pair leaves the `global.set`
    // that precedes it untouched, so the store still lands. Mirror of Pattern 2.
    if (cur.op === "global.get" && next.op === "drop") {
      body.splice(i, 2);
      removed += 2;
      // Don't increment i — recheck at same position (new pair may have formed)
      continue;
    }

    // Pattern 3: local.tee N; drop — pushed copy is unused, replace with local.set
    if (cur.op === "local.tee" && next.op === "drop") {
      body.splice(i, 2, { op: "local.set", index: cur.index });
      removed++; // net: 2 removed, 1 added = 1 instruction saved
      i++;
      continue;
    }

    // Pattern 4: postfix increment/decrement dead-store (#957)
    // local.get N; local.get N; i32/f64.const 1; i32/f64.add/sub; local.set N; drop
    // → local.get N; i32/f64.const 1; i32/f64.add/sub; local.set N
    if (
      i + 5 < body.length &&
      cur.op === "local.get" &&
      body[i + 1]!.op === "local.get" &&
      (body[i + 1] as any).index === (cur as any).index &&
      (body[i + 2]!.op === "i32.const" || body[i + 2]!.op === "f64.const") &&
      (body[i + 3]!.op === "i32.add" ||
        body[i + 3]!.op === "i32.sub" ||
        body[i + 3]!.op === "f64.add" ||
        body[i + 3]!.op === "f64.sub") &&
      body[i + 4]!.op === "local.set" &&
      (body[i + 4] as any).index === (cur as any).index &&
      body[i + 5]!.op === "drop"
    ) {
      // Remove the first local.get N (index i) and the trailing drop (now at i+4 after removal)
      body.splice(i, 1); // remove first local.get N; array shifts left by 1
      body.splice(i + 4, 1); // remove drop (was i+5, now i+4 after first splice)
      removed += 2;
      // Don't increment i — recheck at same position
      continue;
    }

    // Pattern 6: i32.const 0; i32.or — `x | 0` on an i32 is identity (#1197).
    // Wasm validation requires the value below i32.or to already be i32, so
    // OR-ing with 0 has no observable effect. Remove both instructions.
    if (cur.op === "i32.const" && (cur as any).value === 0 && next.op === "i32.or") {
      body.splice(i, 2);
      removed += 2;
      // Don't increment i — recheck at same position (a chain of `| 0` collapses).
      continue;
    }

    // Pattern 7: f64.const 0; f64.const 0; f64.div → f64.const NaN (#1920).
    // Collapse the 0/0-division NaN materialization (3 instrs) into the direct
    // const (1 instr). NaN encodes losslessly via the raw f64 encoder.
    if (
      i + 2 < body.length &&
      cur.op === "f64.const" &&
      (cur as any).value === 0 &&
      next.op === "f64.const" &&
      (next as any).value === 0 &&
      body[i + 2]!.op === "f64.div"
    ) {
      body.splice(i, 3, { op: "f64.const", value: NaN });
      removed += 2; // net: 3 removed, 1 added
      // Don't increment i — a following instruction may now form a new pattern.
      continue;
    }

    // Pattern 8: local.set N; local.get N → local.tee N (#1920). A store of a
    // local immediately followed by a reload of the SAME local is precisely
    // `local.tee` (store + leave a copy on the stack). Nothing observes the
    // stack between them, so the fusion is value- and effect-preserving.
    if (cur.op === "local.set" && next.op === "local.get" && (next as any).index === (cur as any).index) {
      body.splice(i, 2, { op: "local.tee", index: (cur as any).index });
      removed++; // net: 2 removed, 1 added = 1 instruction saved
      // Don't increment i — the new `local.tee N` may pair with a following
      // `drop` (pattern 3 → local.set) for a further reduction.
      continue;
    }

    // Pattern 5: local.get N; ref.test T; if (then [local.get N; ref.cast T; ...rest]) (#955)
    // When local N is of type (ref_null T), the ref.test already proved non-null and
    // correct type, so ref.cast T is redundant for the runtime check.
    // Replace ref.cast T with ref.as_non_null (1 byte vs 3+ bytes, preserves (ref T) type).
    // Only valid when the local is (ref_null T) — ref.as_non_null on anyref would give (ref any).
    if (
      localTypes &&
      i + 2 < body.length &&
      cur.op === "local.get" &&
      next.op === "ref.test" &&
      body[i + 2]!.op === "if"
    ) {
      const localIdx = (cur as any).index as number;
      const testTypeIdx = (next as any).typeIdx as number;
      const ifInstr = body[i + 2]!;
      const localType = localTypes[localIdx];
      // Check: local is (ref_null T) where T matches the ref.test type
      if (
        localType &&
        localType.kind === "ref_null" &&
        (localType as any).typeIdx === testTypeIdx &&
        (ifInstr as any).then &&
        (ifInstr as any).then.length >= 2 &&
        (ifInstr as any).then[0].op === "local.get" &&
        (ifInstr as any).then[0].index === localIdx &&
        (ifInstr as any).then[1].op === "ref.cast" &&
        (ifInstr as any).then[1].typeIdx === testTypeIdx
      ) {
        // Replace ref.cast T with ref.as_non_null in the then branch
        (ifInstr as any).then[1] = { op: "ref.as_non_null" };
        removed++; // net: ref.cast (3+ bytes) → ref.as_non_null (1 byte)
        i++;
        continue;
      }
    }

    i++;
  }

  return removed;
}

/**
 * Resolve param types for a function from the module's type table.
 * Returns an empty array if the type cannot be found or is not a func type.
 */
function getFuncParamTypes(mod: WasmModule, typeIdx: number): ValType[] {
  const typeDef = mod.types[typeIdx];
  if (!typeDef) return [];
  // Direct function type
  if (typeDef.kind === "func") return typeDef.params;
  // Sub type wrapping a func type
  if (typeDef.kind === "sub" && typeDef.type.kind === "func") return typeDef.type.params;
  return [];
}

/**
 * Run peephole optimizations on all function bodies in a WasmModule.
 * Returns the total number of instructions eliminated.
 */
export function peepholeOptimize(mod: WasmModule): number {
  let totalRemoved = 0;
  for (const func of mod.functions) {
    // Build flat local-type array: params first, then declared locals
    const paramTypes = getFuncParamTypes(mod, func.typeIdx);
    const localTypes: ValType[] = [...paramTypes, ...func.locals.map((l) => l.type)];
    totalRemoved += optimizeBody(func.body, localTypes);
  }
  return totalRemoved;
}
