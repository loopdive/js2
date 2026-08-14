// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) The BOX side of the small-integer fast path — an i32-domain value
 * that stays in i32 and re-boxes as `ref.i31` instead of calling
 * `__box_number`.
 *
 * Companion to `tonumber-fast-paths.ts` (the *operand* half) and gated by the
 * same `JS2WASM_SMI_FASTPATH` flag. **Default ON at the `all` level** since the
 * #4157 tuned-set flip; with `JS2WASM_SMI_FASTPATH=0` the binary is
 * byte-identical to the pre-#4157 base, because {@link inlineSmiBoxGuards}
 * returns before it reads anything.
 *
 * ## Why this is a finalize pass and not the specced binary-op transform
 *
 * The #4157 spec put the i32-arithmetic half at
 * `binary-ops-typed-dispatch.ts:626`, "when both `leftType` and `rightType` are
 * `externref`". **That arm is dead.** Instrumenting `compileTypedBinaryDispatch`
 * across a whole standalone acorn self-compile, all 1,617 arithmetic/relational
 * dispatches arrive `L=f64 R=f64`; not one arrives with an externref operand.
 * The cause is structural: `compileBinaryExpression` compiles both operands
 * with a NUMERIC HINT, so the `externref → f64` ToNumber is emitted *inside*
 * each operand's own compilation — at the very `type-coercion.ts` site the
 * operand half already patches — and the dispatch only ever sees f64. Ten
 * hand-written operand shapes (member read, call result, element read, `any`
 * params, `any`-vs-literal, `unknown` casts) reproduce it: all f64/f64. Only
 * *equality* reaches that dispatch with externref operands, and equality is not
 * `isNumericOp`.
 *
 * The reachable form of "an i31 add that stays in i32 and re-boxes via `ref.i31`
 * never materialises a `$BoxedNumber`" is therefore at the BOXING site. A
 * finalize pass rather than an emitter hook because the boxing calls come from
 * **two** front ends — legacy `coerceType` and the IR lowering's `emitBox`
 * (`ir/integration.ts`) — and on this workload the IR is the one that matters:
 * hooking only `coerceType` reached 2 sites in a probe module. One pass over
 * the finished bodies covers both, exactly as `const-box-hoist.ts` does for
 * constant boxes.
 *
 * ## The equivalence, arm by arm
 *
 * Read against the native `__box_number` (`registry/imports.ts`), the only
 * definition that produces `ref.i31` — hence the `nativeBoxNumberTypeIdx` gate.
 * Its predicate is: `t = i32.trunc_sat_f64_s(f)` round-trips back through
 * `f64.convert_i32_s`, AND `t` fits signed 31 bits, AND the value is not `-0`;
 * then `ref.i31 t`, else `struct.new $BoxedNumber f`.
 *
 * | producer | rewritten to | why it is the same answer |
 * | --- | --- | --- |
 * | `f64.convert_i32_s; call $__box_number` | 31-bit range test on the **i32**, else the untouched pair | the round-trip clause is vacuous (`trunc_sat_s(f64(x)) == x` for every i32 `x`, and `f64.convert_i32_s` is exact) and so is the `-0` clause (`f64.convert_i32_s` produces `-0` for no input; `x = 0` gives `+0`) |
 * | any other `call $__box_number` (`=all` only) | `__box_number`'s own predicate, inlined, delegating to the call when it fails | it *is* that predicate, instruction for instruction |
 *
 * Both failure arms call the unchanged `__box_number`, so the `$BoxedNumber`
 * allocation path is never duplicated and never re-derived here.
 *
 * ## What is deliberately NOT rewritten
 *
 * - **JS-host mode.** There `__box_number` is an `env::` import and a boxed
 *   number is a JS number, not a WasmGC `ref.i31` — the host could not read one.
 *   `ctx.nativeBoxNumberTypeIdx >= 0` is exactly the condition under which the
 *   i31-producing native was registered (standalone/WASI only).
 * - **`__box_boolean` / `__box_symbol` / `__box_bigint`.** Those carry a TAG
 *   that `ref.i31` would erase (#2785/#2760); only `__box_number` is matched.
 * - **Constant boxes.** `const-box-hoist.ts` runs first and has already turned
 *   them into a `global.get` of a once-seeded global, which is strictly better
 *   than an inline `ref.i31`. Whatever it declined (NaN, no `__module_init`)
 *   falls to the `=all` arm here.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { smiFastPathAllValues, smiFastPathEnabled } from "./tonumber-fast-paths.js";
import { walkChildren } from "./walk-instructions.js";

/** Every instruction array in a body, including nested `if`/`block`/`loop` arms. */
function everyArray(instrs: Instr[]): Instr[][] {
  const out: Instr[][] = [];
  const stack: Instr[][] = [instrs];
  // Builders may reuse one immutable child array in more than one branch, so
  // the object graph is a DAG even though the emitted Wasm is a tree. Rewriting
  // each array once is both sufficient and required (see const-box-hoist).
  const visited = new WeakSet<Instr[]>();
  while (stack.length > 0) {
    const arr = stack.pop()!;
    if (visited.has(arr)) continue;
    visited.add(arr);
    out.push(arr);
    for (const instr of arr) walkChildren(instr, (child) => stack.push(child));
  }
  return out;
}

/** The signed-31-bit round-trip `__box_number` uses: `(t << 1) >> 1 == t`. */
function fitsI31Test(index: number): Instr[] {
  return [
    { op: "local.get", index },
    { op: "i32.const", value: 1 },
    { op: "i32.shl" },
    { op: "i32.const", value: 1 },
    { op: "i32.shr_s" },
    { op: "local.get", index },
    { op: "i32.eq" },
  ];
}

/** `ref.i31` of the i32 in `index`, externalised — `__box_number`'s own then-arm. */
function i31FromLocal(index: number): Instr[] {
  return [{ op: "local.get", index }, { op: "ref.i31" }, { op: "extern.convert_any" }];
}

/**
 * Replace `f64.convert_i32_s; call $__box_number` with the range test on the
 * i32 itself. See the header table for why the other two clauses of
 * `__box_number`'s predicate are vacuous on an i32 source.
 */
function i32Guard(tmp: number, boxCall: Instr): Instr[] {
  return [
    // `local.set`, not `tee` — unlike `f64Guard`, whose tee'd value is consumed
    // straight away by `i32.trunc_sat_f64_s`, nothing here consumes a left-over
    // copy, and one would strand an i32 under the guard's externref result.
    { op: "local.set", index: tmp },
    ...fitsI31Test(tmp),
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } as ValType },
      then: i31FromLocal(tmp),
      else: [{ op: "local.get", index: tmp }, { op: "f64.convert_i32_s" }, boxCall],
    },
  ];
}

/** `__box_number`'s predicate, inlined, delegating to the call when it fails. */
function f64Guard(fTmp: number, tTmp: number, boxCall: Instr): Instr[] {
  return [
    { op: "local.tee", index: fTmp },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: tTmp },
    { op: "f64.convert_i32_s" },
    { op: "local.get", index: fTmp },
    { op: "f64.eq" }, // integral, in i32 range, and clamp-free
    ...fitsI31Test(tTmp),
    { op: "i32.and" },
    // …and not `-0`: `t != 0 || the sign bit is clear`.
    { op: "local.get", index: tTmp },
    { op: "i32.const", value: 0 },
    { op: "i32.ne" },
    { op: "local.get", index: fTmp },
    { op: "i64.reinterpret_f64" },
    { op: "i64.const", value: 0n },
    { op: "i64.lt_s" },
    { op: "i32.eqz" },
    { op: "i32.or" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } as ValType },
      then: i31FromLocal(tTmp),
      else: [{ op: "local.get", index: fTmp }, boxCall],
    },
  ];
}

/**
 * Inline the i31 arm of `__box_number` at its call sites.
 *
 * Placement contract — same as `hoistConstantBoxedNumbers`: **after**
 * `finalizeModuleValueCaches` (so constant boxes are already hoisted and are not
 * re-expanded here) and **before** dead elimination (so the `call $__box_number`
 * kept in each else-arm is index-remapped with every other call). Appending
 * locals is safe at this point: existing indices are unchanged, and the later
 * `stackBalance` / `repairStructTypeMismatches` / `peepholeOptimize` passes read
 * the local table off the function rather than caching it.
 *
 * Runs at the `all` level by default; a no-op only when `JS2WASM_SMI_FASTPATH`
 * is explicitly off.
 */
export function inlineSmiBoxGuards(ctx: CodegenContext): void {
  if (!smiFastPathEnabled()) return;
  if (ctx.nativeBoxNumberTypeIdx < 0) return;
  const boxIdx = ctx.funcMap.get("__box_number");
  if (boxIdx === undefined) return;
  const all = smiFastPathAllValues();
  const debug = process.env.JS2WASM_SMI_BOX_DEBUG === "1";
  let i32Sites = 0;
  let f64Sites = 0;
  let declined = 0;

  for (const fn of ctx.mod.functions) {
    const funcType = ctx.mod.types[fn.typeIdx];
    // A function whose type is not resolvable would give a wrong base for the
    // appended local's index; decline rather than guess.
    if (!funcType || funcType.kind !== "func") continue;
    const numParams = funcType.params.length;
    // One scratch pair per FUNCTION, not per site: every guard is a
    // straight-line `tee … if … end` with no nested guard between the `tee` and
    // its last read, so the temps are dead again before the next guard begins.
    let i32Tmp = -1;
    let f64Tmp = -1;
    const scratch = (kind: "i32" | "f64"): number => {
      const cached = kind === "i32" ? i32Tmp : f64Tmp;
      if (cached >= 0) return cached;
      const index = numParams + fn.locals.length;
      fn.locals.push({ name: `$smi_box_${kind}`, type: { kind } as ValType });
      if (kind === "i32") i32Tmp = index;
      else f64Tmp = index;
      return index;
    };

    for (const arr of everyArray(fn.body)) {
      let hit = false;
      for (const instr of arr) {
        if (instr.op === "call" && instr.funcIdx === boxIdx) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;

      const rewritten: Instr[] = [];
      for (const instr of arr) {
        if (!(instr.op === "call" && instr.funcIdx === boxIdx)) {
          rewritten.push(instr);
          continue;
        }
        // `rewritten` already holds this array's prefix, so its tail is exactly
        // the boxing call's producer sequence.
        const last = rewritten[rewritten.length - 1];
        if (last?.op === "f64.convert_i32_s") {
          rewritten.length -= 1;
          rewritten.push(...i32Guard(scratch("i32"), instr));
          i32Sites++;
          continue;
        }
        if (!all) {
          declined++;
          rewritten.push(instr);
          continue;
        }
        rewritten.push(...f64Guard(scratch("f64"), scratch("i32"), instr));
        f64Sites++;
      }
      arr.length = 0;
      arr.push(...rewritten);
    }
  }

  if (debug) {
    process.stderr.write(
      `[smi-box] level=${all ? "all" : "i32"} i32-guarded=${i32Sites} f64-guarded=${f64Sites} declined=${declined}\n`,
    );
  }
}
