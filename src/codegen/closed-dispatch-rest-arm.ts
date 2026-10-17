// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7021) Rest-parameter methods in the fixed-arity closed-struct dispatcher
 * `__call_m_<name>_<arity>`.
 *
 * A method `use(...args)` compiles to a Wasm function whose LAST formal is the
 * packed rest vec (`(ref null $__vec_<elem>)`). The dispatcher's arm builder
 * treated that slot as an ordinary positional parameter: `x.use(opts)` (arity
 * 1) pushed `opts` and `ref.cast` it to the vec type — `illegal cast` for every
 * call whose first argument is not itself an array. marked's `Marked#use`
 * (`use(...e)`) trapped this way in every upstream Hooks test (0/30).
 *
 * The fix is the JavaScript call semantics (§10.2.1.3 / FunctionDeclarationInstantiation
 * step 27, CreateListFromArrayLike for the rest binding): the formals before the
 * rest index take their arguments as before, and arguments `restIndex …
 * arity-1` are coerced to the rest element type and packed into a fresh vec.
 *
 * Standalone / WASI only. The JS-host lane keeps its previous arms byte for
 * byte (see `restDispatchInfo`).
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext, RestParamInfo } from "./context/types.js";
import type { ValType } from "../ir/types.js";

/**
 * The rest ABI of `<Struct>_<method>` when the fixed-arity dispatcher must pack
 * it, else `null` (no rest parameter, a host lane, or a signature whose last
 * formal is not the registered rest vec — those keep the previous arm).
 */
export function restDispatchInfo(
  ctx: CodegenContext,
  fullName: string,
  paramTypes: readonly ValType[],
): RestParamInfo | null {
  if (!ctx.standalone && !ctx.wasi) return null;
  const rest = ctx.funcRestParams.get(fullName);
  if (!rest || rest.restIndex !== paramTypes.length - 1) return null;
  const slot = paramTypes[rest.restIndex];
  if (!slot || (slot.kind !== "ref" && slot.kind !== "ref_null") || slot.typeIdx !== rest.vecTypeIdx) return null;
  return rest;
}

/**
 * Operands for the rest vec: `struct.new $vec (count, array.new_fixed …)` over
 * the call's arguments `rest.restIndex … providedArity-1`, each sourced by
 * `pushArg` and converted by `coerce` to the rest element type. Fewer
 * arguments than the rest index yield an empty vec.
 */
export function restVecArgInstrs(
  rest: RestParamInfo,
  providedArity: number,
  pushArg: (a: number) => Instr[],
  coerce: (want: ValType) => Instr[],
): Instr[] {
  const count = Math.max(0, providedArity - rest.restIndex);
  const out: Instr[] = [{ op: "i32.const", value: count }];
  for (let a = rest.restIndex; a < providedArity; a++) {
    out.push(...pushArg(a), ...coerce(rest.elemType));
  }
  out.push({ op: "array.new_fixed", typeIdx: rest.arrayTypeIdx, length: count });
  out.push({ op: "struct.new", typeIdx: rest.vecTypeIdx });
  return out;
}
