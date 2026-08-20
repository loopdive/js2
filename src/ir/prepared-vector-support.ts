// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "../codegen/context/types.js";
import { definedFuncAt } from "../codegen/func-space.js";
import {
  planProgramAbiEntrySourceSupportCallable,
  PROGRAM_ABI_CALLABLE_ROLE,
} from "../codegen/program-abi-planning.js";
import { buildVecFromExternMaterializer, vecFromExternFuncIdx } from "../codegen/type-coercion.js";
import {
  VEC_HOST_BRIDGE_ROLE,
  vecHostBridgeMaterializerOrdinal,
  type VecHostBridgeMaterializerElementKind,
} from "../codegen/vec-access-exports.js";
import { irTypeBindingKey } from "./abi-bindings.js";
import { sameIrCallableBinding } from "./callable-bindings.js";
import type { IrVecLowering } from "./lower.js";
import { asVal, irVal, type IrFuncRef, type IrFunction, type IrType, type IrVecLayoutRef } from "./nodes.js";
import { IrUnsupportedError } from "./outcomes.js";
import type { ValType } from "./types.js";
import { attachIrVecLayouts } from "./vec-layout.js";

interface PreparedVectorEntry {
  readonly fn: IrFunction;
}

type MaterializerElement = ValType & { readonly kind: VecHostBridgeMaterializerElementKind };

/** Attach backend layouts and exact host-to-vec materializers after IR construction. */
export function prepareIrVectorSupport<T extends PreparedVectorEntry>(input: {
  readonly ctx: CodegenContext;
  readonly entries: readonly T[];
  readonly resolveVecForElement: (element: ValType) => IrVecLowering | null;
  readonly resolvePhysicalVec: (value: ValType) => IrVecLowering | null;
  readonly resolveString: () => ValType | null;
  readonly typeKey: (type: IrType) => string;
}): T[] {
  const registry = input.ctx.programAbiTypes;
  if (!registry) return [...input.entries];
  const layouts = new Map<string, IrVecLayoutRef>();
  const physicalVectors = new Map<string, { readonly structTypeIdx: number; readonly element: MaterializerElement }>();
  const materializers = new Map<string, IrFuncRef>();
  const fromExternFor = (logicalKey: string): IrFuncRef => {
    const cached = materializers.get(logicalKey);
    if (cached) return cached;
    const physical = physicalVectors.get(logicalKey);
    if (!physical) throw new Error(`prepared async vector ${logicalKey} lost its physical layout`);
    const name = buildVecFromExternMaterializer(input.ctx, physical.structTypeIdx);
    const handle = name ? vecFromExternFuncIdx(input.ctx, physical.structTypeIdx) : undefined;
    const func = handle === undefined ? undefined : definedFuncAt(input.ctx, handle);
    const ref = func
      ? planProgramAbiEntrySourceSupportCallable(input.ctx, {
          role: VEC_HOST_BRIDGE_ROLE,
          roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.vecHostBridge,
          derivedOrdinal: vecHostBridgeMaterializerOrdinal(physical.element.kind),
          displayName: name!,
          func,
        })
      : undefined;
    if (!ref) throw new Error(`no sealed extern materializer for ${logicalKey}`);
    materializers.set(logicalKey, ref);
    return ref;
  };

  return input.entries.map((entry) => {
    const attachment = attachIrVecLayouts(
      entry.fn,
      (type) => {
        const logicalKey = input.typeKey({ kind: "vec", elementType: type.elementType, nullable: false });
        const cached = layouts.get(logicalKey);
        if (cached) return cached;
        const element = asVal(type.elementType) ?? (type.elementType.kind === "string" ? input.resolveString() : null);
        const materializerElement =
          element && (element.kind === "f64" || element.kind === "i32" || element.kind === "externref")
            ? (element as MaterializerElement)
            : null;
        const nativeStringElement =
          type.elementType.kind === "string" &&
          element !== null &&
          (element.kind === "ref" || element.kind === "ref_null");
        if (!element || (!materializerElement && !nativeStringElement)) {
          // (#4486) The physical vec registry carries exactly three element
          // kinds. Everything else — most visibly a NESTED vec, i.e. the
          // `vec<vec<externref>>` a `string[][]` param resolves to — is a
          // CAPABILITY GAP by construction, never a producer-promise
          // violation: the element allowlist is a property of the backend's
          // vec layouts, not of anything the selector or the builder promised.
          //
          // It threw a plain `Error`, so `classifyIrFailure` bucketed it as
          // the untyped `unexpected-internal-throw` invariant and the claim
          // withdrawal became a HARD compile error, with a perfectly good
          // legacy body already emitted (`legacyBodyEmitted: true`). Measured
          // on main: `for (const r of rows)` over `string[][]` did not compile
          // at all, while its `number[][]` / `boolean[][]` siblings took the
          // soft `type-resolution-unsupported`@resolve path (the #1921
          // contract) and demoted cleanly. Same class as #3565/#3784/#4035;
          // typed here so all nestings withdraw the claim identically.
          throw new IrUnsupportedError(
            "type-resolution-unsupported",
            "resolve",
            `prepared vec element ${input.typeKey(type.elementType)} is not supported`,
          );
        }
        const vec = input.resolveVecForElement(element);
        if (!vec) throw new Error(`no physical vector layout for ${logicalKey}`);
        const layout = registry.prepareVectorLayout(logicalKey, vec.vecStructTypeIdx, vec.arrayTypeIdx);
        layouts.set(logicalKey, layout);
        if (materializerElement) {
          physicalVectors.set(logicalKey, { structTypeIdx: vec.vecStructTypeIdx, element: materializerElement });
        }
        return layout;
      },
      (type) => {
        if (type.val.kind !== "ref" && type.val.kind !== "ref_null") return null;
        const vec = input.resolvePhysicalVec(type.val);
        return vec
          ? { kind: "vec", elementType: irVal(vec.elementValType), nullable: type.val.kind === "ref_null" }
          : null;
      },
    );
    let fn = attachment.function;
    if (attachment.asyncPlanLayouts.size > 0) {
      if (!fn.asyncRuntime) throw new Error(`async vector owner ${fn.name} has no prepared runtime attachment`);
      const typeLayouts = Object.freeze(
        [...attachment.asyncPlanLayouts].map(([logicalType, layout]) => {
          if (logicalType.kind !== "vec") throw new Error(`non-vector async layout key ${logicalType.kind}`);
          const logicalKey = input.typeKey({ kind: "vec", elementType: logicalType.elementType, nullable: false });
          const fulfilled =
            fn.asyncPlan?.states.some(
              (state) => state.resume?.source === "fulfilled" && state.resume.type === logicalType,
            ) === true;
          return Object.freeze({
            logicalType,
            layout,
            ...(fulfilled ? { fromExtern: fromExternFor(logicalKey) } : {}),
          });
        }),
      );
      if (fn.asyncRuntime.typeLayouts) {
        const divergent =
          fn.asyncRuntime.typeLayouts.length !== typeLayouts.length ||
          fn.asyncRuntime.typeLayouts.some((prior, index) => {
            const next = typeLayouts[index]!;
            return (
              prior.logicalType !== next.logicalType ||
              irTypeBindingKey(prior.layout.carrierType.binding) !==
                irTypeBindingKey(next.layout.carrierType.binding) ||
              irTypeBindingKey(prior.layout.dataType.binding) !== irTypeBindingKey(next.layout.dataType.binding) ||
              prior.layout.lengthFieldIndex !== next.layout.lengthFieldIndex ||
              prior.layout.dataFieldIndex !== next.layout.dataFieldIndex ||
              (prior.fromExtern === undefined) !== (next.fromExtern === undefined) ||
              (prior.fromExtern !== undefined &&
                next.fromExtern !== undefined &&
                !sameIrCallableBinding(prior.fromExtern.binding, next.fromExtern.binding))
            );
          });
        if (divergent) throw new Error(`async vector owner ${fn.name} carries divergent prepared layouts`);
      } else {
        fn = { ...fn, asyncRuntime: Object.freeze({ ...fn.asyncRuntime, typeLayouts }) };
      }
    }
    return (fn === entry.fn ? entry : { ...entry, fn }) as T;
  });
}
