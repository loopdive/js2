// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Which closures this module's `__call_fn_method_<arity>` ladders dispatch,
 * and (#7478) the predicate a linked provider publishes from that set.
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import {
  buildClosureFuncrefExtraction,
  buildClosureRootTest,
} from "../../runtime/wasmgc/values/closure-invocation-bodies.js";
import {
  classifyClosureDispatchRest,
  closureDispatchSelfTypeIdx,
  type ClosureDispatchRestCarrier,
} from "./closure-dispatch-rest.js";
import { getFuncRefWrapperRootTypeIdx } from "./funcref-wrapper-types.js";
import {
  buildTransferredNativeProtoOwnedBitInstrs,
  collectTransferredNativeProtoReceivers,
} from "./transferred-native-proto.js";

/**
 * Number of positional host arguments consumed before a source rest
 * parameter. The lifted Wasm function still has one additional vec formal for
 * `...rest`; the host bridge materializes that vec from the remaining
 * positional arguments instead of counting it as a JavaScript argument.
 */
export function closureHostArity(info: {
  paramTypes: ValType[];
  hasRestParam?: boolean;
  nativeProtoVariadic?: boolean;
}): number {
  if (info.nativeProtoVariadic === true) return Math.max(0, info.paramTypes.length - 2);
  return info.hasRestParam === true ? Math.max(0, info.paramTypes.length - 1) : info.paramTypes.length;
}

export interface ClosureDispatchEntry {
  funcTypeIdx: number;
  returnType: ValType | null;
  selfTypeIdx: number;
  closureArity: number;
  rest?: ClosureDispatchRestCarrier;
}

/**
 * The closures `__call_fn_method_<arity>` dispatches through its funcref
 * ladder, rest-parameter arms last, plus the first root wrapper seen.
 * `arity` is an upper bound on host arity; `minHostArity` a lower one (#6655).
 */
export function collectMethodDispatchEntries(
  ctx: CodegenContext,
  arity: number,
  minHostArity: number,
): { entries: ClosureDispatchEntry[]; baseWrapperIdx: number | undefined } {
  const mod = ctx.mod;
  let baseWrapperIdx: number | undefined;
  const seenFuncTypeIdx = new Set<number>();
  const entries: ClosureDispatchEntry[] = [];
  const restEntries: ClosureDispatchEntry[] = [];
  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (info.hostOneShotOnly === true || info.domCallbackOnly === true) continue;
    if (info.nativeProtoVariadic === true) continue;
    const hostArity = closureHostArity(info);
    if (hostArity > arity) continue;
    // (#6655) An above-cap dispatcher carries ONLY the above-cap closures. It
    // is reached solely from `__apply_closure`'s `8 < n <= top` arm, where a
    // callee of ordinary arity cannot be selected — and a full ladder at
    // arity 14 duplicates every arm `__call_fn_method_8` already has, at 14
    // argument slots each, which is pure compile time on the corpus's largest
    // modules. `minHostArity` is 0 (and therefore inert) for every ordinary
    // dispatcher.
    if (hostArity < minHostArity) continue;
    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;
    if (typeDef.superTypeIdx === -1 && baseWrapperIdx === undefined) {
      baseWrapperIdx = typeIdx;
    }
    const funcTypeDef = mod.types[info.funcTypeIdx];
    const selfTypeIdx = closureDispatchSelfTypeIdx(funcTypeDef?.kind === "func" ? funcTypeDef : undefined, typeIdx);

    const funcType = funcTypeDef?.kind === "func" ? funcTypeDef : undefined;
    const rest = classifyClosureDispatchRest(ctx, typeIdx, info, funcType, hostArity);
    if (rest?.kind === "unsupported") continue; // (#5329) never emit a short call_ref
    if (rest) {
      restEntries.push({
        funcTypeIdx: info.funcTypeIdx,
        returnType: info.returnType,
        selfTypeIdx,
        closureArity: hostArity,
        rest,
      });
      continue;
    }

    if (!seenFuncTypeIdx.has(info.funcTypeIdx)) {
      seenFuncTypeIdx.add(info.funcTypeIdx);
      entries.push({
        funcTypeIdx: info.funcTypeIdx,
        returnType: info.returnType,
        selfTypeIdx,
        closureArity: hostArity,
      });
    }
  }
  entries.push(...restEntries);
  return { entries, baseWrapperIdx };
}

/**
 * (#7478) `1` when the value in `fnLocal` (an externref param) is a closure
 * that THIS module cannot dispatch — no `__call_fn_method_*` ladder arm and no
 * native-prototype arm claims it — else `0`. Appends two scratch locals to
 * `locals`; `undefined` (nothing appended) when the module has no closures.
 *
 * A linked provider's `callableKind` uses it: `__is_callable` is structural,
 * so without it the provider claimed a CONSUMER closure of a signature only the
 * consumer minted (`function g(m)` specialised to `(self, i32)` by
 * `g(false)`), the consumer's `__apply_closure` shipped the call here, and this
 * module's ladder answered the undefined sentinel without running the callee.
 */
export function buildUndispatchableClosureBitInstrs(
  ctx: CodegenContext,
  locals: { name: string; type: ValType }[],
  fnLocal: number,
  paramCount: number,
): Instr[] | undefined {
  const rootTypeIdx = getFuncRefWrapperRootTypeIdx(ctx);
  const { entries } = collectMethodDispatchEntries(ctx, Number.POSITIVE_INFINITY, 0);
  if (rootTypeIdx === undefined || entries.length === 0) return undefined;
  const anyLocal = paramCount + locals.length;
  const funcLocal = anyLocal + 1;
  locals.push({ name: "__own_any", type: { kind: "anyref" } }, { name: "__own_func", type: { kind: "funcref" } });
  const claimed: Instr[] = [
    { op: "local.get", index: fnLocal },
    { op: "any.convert_extern" },
    { op: "local.set", index: anyLocal },
    { op: "ref.null.func" },
    { op: "local.set", index: funcLocal },
    ...buildClosureFuncrefExtraction({ rootTypeIdx, types: ctx.mod.types }, entries, anyLocal, funcLocal),
    ...(buildTransferredNativeProtoOwnedBitInstrs(ctx, collectTransferredNativeProtoReceivers(ctx, 0), fnLocal) ?? [
      { op: "i32.const", value: 0 },
    ]),
  ];
  for (const funcTypeIdx of new Set(entries.map((entry) => entry.funcTypeIdx))) {
    claimed.push({ op: "local.get", index: funcLocal }, { op: "ref.test", typeIdx: funcTypeIdx }, { op: "i32.or" });
  }
  return [...buildClosureRootTest(fnLocal, rootTypeIdx), ...claimed, { op: "i32.eqz" }, { op: "i32.and" }];
}
