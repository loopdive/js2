// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ClosureInfo, CodegenContext } from "../codegen/context/types.js";
import {
  CLOSURE_CAPTURE_FIELD_BASE,
  getOrCreateFuncRefWrapperTypes,
  observeClosureAllocation,
  type ClosureAllocationMode,
} from "../codegen/closures/funcref-wrapper-types.js";
import { resolveStandaloneDomCallbackClosureSubtype } from "../codegen/standalone-dom-callback-authority.js";
import type { IrClosureLowering } from "./backend/handles.js";
import type { IrClosureSignature, IrDomCallbackAuthority, IrType } from "./nodes.js";
import type { StructTypeDef, ValType } from "./types.js";
import { irTypeKey } from "./type-key.js";
import {
  createClosureCaptureHeader,
  createClosureCaptureField,
} from "../runtime/wasmgc/values/closure-capture-layouts.js";

function signatureKey(signature: IrClosureSignature): string {
  const params = signature.params.map(irTypeKey).join(",");
  return `(${params})->${signature.returnType === null ? "void" : irTypeKey(signature.returnType)}`;
}

interface CachedClosureLowering {
  readonly lowering: IrClosureLowering;
  readonly info: ClosureInfo;
}

/**
 * Closure allocation registry shared by preparation and final IR lowering.
 *
 * Base structs reuse the canonical legacy wrapper for a signature. Captured
 * subtypes extend that wrapper and keep their allocation metadata in the same
 * module-wide registry. Certified standalone DOM callbacks receive a branded
 * subtype at this allocation seam without changing ordinary closure identity.
 */
export class ClosureStructRegistry {
  private readonly baseCache = new Map<string, CachedClosureLowering>();
  private readonly subCache = new Map<string, CachedClosureLowering>();

  constructor(
    private readonly ctx: CodegenContext,
    private readonly resolveValType: (type: IrType) => ValType,
  ) {}

  private observe(cached: CachedClosureLowering, mode: ClosureAllocationMode): IrClosureLowering {
    observeClosureAllocation(this.ctx, cached.info, mode);
    return cached.lowering;
  }

  resolveBase(signature: IrClosureSignature, mode: ClosureAllocationMode = "support"): IrClosureLowering | null {
    const key = signatureKey(signature);
    const cached = this.baseCache.get(key);
    if (cached) {
      return this.observe(cached, mode);
    }

    let paramTypes: ValType[];
    let resultTypes: ValType[];
    try {
      paramTypes = signature.params.map((param) => this.resolveValType(param));
      resultTypes = signature.returnType === null ? [] : [this.resolveValType(signature.returnType)];
    } catch {
      return null;
    }
    const wrapper = getOrCreateFuncRefWrapperTypes(this.ctx, paramTypes, resultTypes, mode);
    if (!wrapper) return null;

    const lowering: IrClosureLowering = {
      structTypeIdx: wrapper.structTypeIdx,
      funcFieldIdx: 0,
      capFieldIdx: () => {
        throw new Error("ir/integration: base closure struct has no captures");
      },
      funcTypeIdx: wrapper.liftedFuncTypeIdx,
    };
    this.baseCache.set(key, { lowering, info: wrapper.closureInfo });
    return lowering;
  }

  resolveDeferredSubtype(
    signature: IrClosureSignature,
    captureFieldTypes: readonly IrType[],
    hostOneShot?: boolean,
    domCallbackAuthority?: IrDomCallbackAuthority,
    liftedFuncIdx?: number,
  ): IrClosureLowering | null {
    return this.resolveSubtype(
      signature,
      captureFieldTypes,
      hostOneShot ? "host-one-shot" : "ordinary",
      domCallbackAuthority,
      liftedFuncIdx,
    );
  }

  resolveSubtype(
    signature: IrClosureSignature,
    captureFieldTypes: readonly IrType[],
    mode: ClosureAllocationMode = "support",
    domCallbackAuthority?: IrDomCallbackAuthority,
    liftedFuncIdx?: number,
  ): IrClosureLowering | null {
    if (captureFieldTypes.length === 0) {
      const base = this.resolveBase(signature, mode);
      return base && domCallbackAuthority
        ? resolveStandaloneDomCallbackClosureSubtype(this.ctx, domCallbackAuthority, base, base, liftedFuncIdx)
        : base;
    }

    const key = `${signatureKey(signature)}#${captureFieldTypes.map(irTypeKey).join(",")}`;
    const cached = this.subCache.get(key);
    if (cached) {
      const base = this.resolveBase(signature, mode);
      if (!base) return null;
      const lowering = this.observe(cached, mode);
      return domCallbackAuthority
        ? resolveStandaloneDomCallbackClosureSubtype(this.ctx, domCallbackAuthority, base, lowering, liftedFuncIdx)
        : lowering;
    }

    const base = this.resolveBase(signature, mode);
    if (!base) return null;

    const fields = createClosureCaptureHeader();
    for (let index = 0; index < captureFieldTypes.length; index++) {
      let fieldType: ValType;
      try {
        fieldType = this.resolveValType(captureFieldTypes[index]!);
      } catch {
        return null;
      }
      fields.push(createClosureCaptureField(index, fieldType));
    }

    const subtypeIdx = this.ctx.mod.types.length;
    let subtypeOrdinal = this.subCache.size;
    let subtypeName = `__ir_closure_${subtypeOrdinal}`;
    while (this.ctx.structMap.has(subtypeName)) {
      subtypeName = `__ir_closure_${++subtypeOrdinal}`;
    }
    this.ctx.mod.types.push({
      kind: "struct",
      name: subtypeName,
      fields,
      superTypeIdx: base.structTypeIdx,
    } as StructTypeDef);
    this.ctx.structMap.set(subtypeName, subtypeIdx);
    this.ctx.typeIdxToStructName.set(subtypeIdx, subtypeName);
    // These are private callable carriers, not user-visible data structs.
    // Keeping them out of structFields also prevents finalize from emitting
    // data-struct field helpers for closure captures.

    const baseEntry = this.baseCache.get(signatureKey(signature));
    if (!baseEntry || baseEntry.lowering !== base) {
      throw new Error(`ir/integration: canonical wrapper ${base.structTypeIdx} has no closure metadata`);
    }
    const baseInfo = baseEntry.info;
    const info: ClosureInfo = {
      structTypeIdx: subtypeIdx,
      funcTypeIdx: base.funcTypeIdx,
      paramTypes: [...baseInfo.paramTypes],
      returnType: baseInfo.returnType,
      hasCaptures: true,
    };
    observeClosureAllocation(this.ctx, info, mode);

    const fieldIdxByCapture = new Map<number, number>();
    for (let index = 0; index < captureFieldTypes.length; index++) {
      fieldIdxByCapture.set(index, index + CLOSURE_CAPTURE_FIELD_BASE);
    }

    const lowering: IrClosureLowering = {
      structTypeIdx: subtypeIdx,
      funcFieldIdx: 0,
      capFieldIdx: (index: number): number => {
        const fieldIdx = fieldIdxByCapture.get(index);
        if (fieldIdx === undefined) throw new Error(`ir/integration: closure subtype has no capture index ${index}`);
        return fieldIdx;
      },
      funcTypeIdx: base.funcTypeIdx,
    };
    this.subCache.set(key, { lowering, info });
    return domCallbackAuthority
      ? resolveStandaloneDomCallbackClosureSubtype(this.ctx, domCallbackAuthority, base, lowering, liftedFuncIdx)
      : lowering;
  }
}
