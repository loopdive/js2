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

  /**
   * (#5166) The physical ValType that carries ONE vec element.
   *
   * `asVal` answers for the primitive elements; `string` answers through the
   * backend's string carrier. A NESTED vec element (`number[][]`, and the
   * `vec<vec<externref>>` a `string[][]` resolves to) is carried as a CONCRETE
   * ref to the inner vec's struct — the identical shape legacy's
   * `resolveWasmType` produces and the one `resolvePositionType` now registers
   * — so recurse to the inner element, resolve its physical vec, and hand back
   * a `ref_null` to that struct. `resolveVecForElement` get-or-creates through
   * the legacy `getOrRegisterVecType` registry, so inner and outer share
   * identity with every other producer of the same shape.
   */
  const physicalElementFor = (elem: IrType): ValType | null => {
    const direct = asVal(elem);
    if (direct) return direct;
    if (elem.kind === "string") return input.resolveString();
    if (elem.kind !== "vec") return null;
    const inner = physicalElementFor(elem.elementType);
    if (!inner) return null;
    const innerVec = input.resolveVecForElement(inner);
    return innerVec ? { kind: "ref_null", typeIdx: innerVec.vecStructTypeIdx } : null;
  };

  return input.entries.map((entry) => {
    const attachment = attachIrVecLayouts(
      entry.fn,
      (type) => {
        const logicalKey = input.typeKey({ kind: "vec", elementType: type.elementType, nullable: false });
        const cached = layouts.get(logicalKey);
        if (cached) return cached;
        const element = physicalElementFor(type.elementType);
        const materializerElement =
          element && (element.kind === "f64" || element.kind === "i32" || element.kind === "externref")
            ? (element as MaterializerElement)
            : null;
        const nativeStringElement =
          type.elementType.kind === "string" &&
          element !== null &&
          (element.kind === "ref" || element.kind === "ref_null");
        // (#5166) A nested vec element is a concrete `ref_null` to the inner
        // vec struct, so it is not a materializer element kind. It is still a
        // fully supported layout — the outer vec is an ordinary
        // `__vec_ref_<inner>`, byte-identical to what legacy emits for
        // `number[][]`. Like the native-string vecs it deliberately gets NO
        // `physicalVectors` entry below: there is no host-array materializer
        // for a vec-of-vecs element (see the async guard further down, which
        // keeps `fromExternFor`'s plain-`Error` invariant unreachable).
        const nestedVecElement = type.elementType.kind === "vec" && element !== null;
        if (!element || (!materializerElement && !nativeStringElement && !nestedVecElement)) {
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
          // (#5166) A fulfilled async resume needs the host-array
          // materializer, and a nested vec has no `physicalVectors` entry to
          // build one from (there is no `__vec_from_extern_*` for a
          // vec-of-vecs element). Withdraw the claim with the SAME typed
          // capability-gap verdict the element allowlist uses, so
          // `fromExternFor`'s "lost its physical layout" plain `Error` — which
          // `classifyIrFailure` would bucket as an untyped invariant, i.e. a
          // HARD compile error — stays unreachable. This is the #4486 lesson
          // applied ahead of the regression rather than after it.
          if (fulfilled && logicalType.elementType.kind === "vec") {
            throw new IrUnsupportedError(
              "type-resolution-unsupported",
              "resolve",
              `async fulfilled resume of nested vec ${logicalKey} is not supported`,
            );
          }
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
