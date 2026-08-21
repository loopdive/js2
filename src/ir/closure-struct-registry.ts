// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "../codegen/context/types.js";
import {
  CLOSURE_CAPTURE_FIELD_BASE,
  closureArityField,
  closureBagField,
  getOrCreateFuncRefWrapperTypes,
  type ClosureAllocationMode,
} from "../codegen/closures/funcref-wrapper-types.js";
import { resolveStandaloneDomCallbackClosureSubtype } from "../codegen/standalone-dom-callback-authority.js";
import type { IrClosureLowering } from "./backend/handles.js";
import type { IrClosureSignature, IrDomCallbackAuthority, IrType } from "./nodes.js";
import type { FieldDef, StructTypeDef, ValType } from "./types.js";
import { irTypeKey } from "./type-key.js";

function signatureKey(signature: IrClosureSignature): string {
  const params = signature.params.map(irTypeKey).join(",");
  return `(${params})->${signature.returnType === null ? "void" : irTypeKey(signature.returnType)}`;
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
  private readonly baseCache = new Map<string, IrClosureLowering>();
  private readonly subCache = new Map<string, IrClosureLowering>();

  constructor(
    private readonly ctx: CodegenContext,
    private readonly resolveValType: (type: IrType) => ValType,
  ) {}

  private observe(typeIdx: number, mode: ClosureAllocationMode): void {
    const info = this.ctx.closureInfoByTypeIdx.get(typeIdx);
    if (!info) return;
    if (mode === "ordinary") info.hostOneShotOnly = false;
    else if (mode === "host-one-shot" && info.hostOneShotOnly === undefined) info.hostOneShotOnly = true;
  }

  resolveBase(signature: IrClosureSignature, mode: ClosureAllocationMode = "support"): IrClosureLowering | null {
    const key = signatureKey(signature);
    const cached = this.baseCache.get(key);
    if (cached) {
      this.observe(cached.structTypeIdx, mode);
      return cached;
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
    this.baseCache.set(key, lowering);
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
      this.observe(cached.structTypeIdx, mode);
      if (!domCallbackAuthority) return cached;
      const base = this.resolveBase(signature, mode);
      return base
        ? resolveStandaloneDomCallbackClosureSubtype(this.ctx, domCallbackAuthority, base, cached, liftedFuncIdx)
        : null;
    }

    const base = this.resolveBase(signature, mode);
    if (!base) return null;

    const fields: FieldDef[] = [
      { name: "func", type: { kind: "funcref" }, mutable: false },
      closureArityField(),
      closureBagField(),
    ];
    for (let index = 0; index < captureFieldTypes.length; index++) {
      let fieldType: ValType;
      try {
        fieldType = this.resolveValType(captureFieldTypes[index]!);
      } catch {
        return null;
      }
      fields.push({ name: `cap${index}`, type: fieldType, mutable: false });
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

    const baseInfo = this.ctx.closureInfoByTypeIdx.get(base.structTypeIdx);
    if (!baseInfo) {
      throw new Error(`ir/integration: canonical wrapper ${base.structTypeIdx} has no closure metadata`);
    }
    this.ctx.closureInfoByTypeIdx.set(subtypeIdx, {
      structTypeIdx: subtypeIdx,
      funcTypeIdx: base.funcTypeIdx,
      paramTypes: [...baseInfo.paramTypes],
      returnType: baseInfo.returnType,
      hasCaptures: true,
      ...(mode === "host-one-shot" ? { hostOneShotOnly: true } : mode === "ordinary" ? { hostOneShotOnly: false } : {}),
    });

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
    this.subCache.set(key, lowering);
    return domCallbackAuthority
      ? resolveStandaloneDomCallbackClosureSubtype(this.ctx, domCallbackAuthority, base, lowering, liftedFuncIdx)
      : lowering;
  }
}
