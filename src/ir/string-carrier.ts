// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irTypeBindingKey } from "./abi-bindings.js";
import {
  type IrClosureSignature,
  type IrFunction,
  type IrInstr,
  type IrObjectShape,
  type IrType,
  type IrTypeRef,
  mapNestedBuffers,
} from "./nodes.js";

export interface IrStringCarrierAttachment {
  readonly function: IrFunction;
  readonly usesString: boolean;
}

function mapArray<T>(values: readonly T[], map: (value: T) => T): readonly T[] {
  let changed = false;
  const mapped = values.map((value) => {
    const next = map(value);
    if (next !== value) changed = true;
    return next;
  });
  return changed ? mapped : values;
}

/**
 * Attach one canonical Program-ABI carrier identity to every string type in a
 * final IR function.
 *
 * This is intentionally a preparation pass rather than a type-inference rule:
 * inference continues to produce the backend-neutral `string` kind, while the
 * program preparation boundary supplies the exact carrier identity selected
 * for this compilation. The walk covers nested type shapes and structured
 * instruction buffers so lowering cannot discover an unbound string carrier.
 */
export function attachIrStringCarrier(fn: IrFunction, carrierRef: IrTypeRef): IrStringCarrierAttachment {
  const carrierKey = irTypeBindingKey(carrierRef.binding);
  const typeMemo = new Map<IrType, IrType>();
  const objectMemo = new Map<IrObjectShape, IrObjectShape>();
  let usesString = false;

  const mapSignature = (signature: IrClosureSignature): IrClosureSignature => {
    const params = mapArray(signature.params, mapType);
    const returnType = signature.returnType === null ? null : mapType(signature.returnType);
    return params === signature.params && returnType === signature.returnType
      ? signature
      : { ...signature, params, returnType };
  };

  const mapObjectShape = (shape: IrObjectShape): IrObjectShape => {
    const cached = objectMemo.get(shape);
    if (cached) return cached;
    const placeholder = { ...shape };
    objectMemo.set(shape, placeholder);
    const fields = mapArray(shape.fields, (field) => {
      const type = mapType(field.type);
      return type === field.type ? field : { ...field, type };
    });
    const mapped = Object.assign(placeholder, { fields });
    objectMemo.set(shape, mapped);
    return mapped;
  };

  function mapType(type: IrType): IrType {
    const cached = typeMemo.get(type);
    if (cached) return cached;
    let mapped: IrType;
    switch (type.kind) {
      case "string": {
        usesString = true;
        const existing = type.carrierRef;
        if (existing && irTypeBindingKey(existing.binding) !== carrierKey) {
          throw new Error(
            `IR string type carries ${irTypeBindingKey(existing.binding)}, expected canonical carrier ${carrierKey}`,
          );
        }
        mapped = existing ? type : { ...type, carrierRef };
        break;
      }
      case "object": {
        const placeholder = { ...type };
        typeMemo.set(type, placeholder);
        mapped = Object.assign(placeholder, { shape: mapObjectShape(type.shape) });
        break;
      }
      case "vec": {
        const placeholder = { ...type };
        typeMemo.set(type, placeholder);
        mapped = Object.assign(placeholder, { elementType: mapType(type.elementType) });
        break;
      }
      case "closure":
      case "callable": {
        const placeholder = { ...type };
        typeMemo.set(type, placeholder);
        mapped = Object.assign(placeholder, { signature: mapSignature(type.signature) });
        break;
      }
      case "class": {
        // Class shapes carry exact inventory/allocator sidecars keyed by
        // object identity. Their class binding already owns the complete
        // physical layout, so string preparation must preserve the shape.
        mapped = type;
        break;
      }
      case "union": {
        const placeholder = { ...type };
        typeMemo.set(type, placeholder);
        mapped = Object.assign(placeholder, { members: mapArray(type.members, mapType) });
        break;
      }
      case "boxed": {
        const placeholder = { ...type };
        typeMemo.set(type, placeholder);
        mapped = Object.assign(placeholder, { inner: mapType(type.inner) });
        break;
      }
      case "val":
      case "extern":
      case "dynamic":
        mapped = type;
        break;
    }
    typeMemo.set(type, mapped);
    return mapped;
  }

  const mapBuffer = (buffer: readonly IrInstr[]): readonly IrInstr[] => mapArray(buffer, mapInstr);

  const mapInstr = (instr: IrInstr): IrInstr => {
    const nested = mapNestedBuffers(instr, mapBuffer);
    const resultType = nested.resultType === null ? null : mapType(nested.resultType);
    const base = resultType === nested.resultType ? nested : ({ ...nested, resultType } as IrInstr);
    switch (base.kind) {
      case "const":
        if (base.value.kind !== "null") return base;
        {
          const ty = mapType(base.value.ty);
          return ty === base.value.ty ? base : { ...base, value: { ...base.value, ty } };
        }
      case "box": {
        const toType = mapType(base.toType);
        return toType === base.toType ? base : { ...base, toType };
      }
      case "object.new": {
        const shape = mapObjectShape(base.shape);
        return shape === base.shape ? base : { ...base, shape };
      }
      case "closure.new": {
        const signature = mapSignature(base.signature);
        const captureFieldTypes = mapArray(base.captureFieldTypes, mapType);
        return signature === base.signature && captureFieldTypes === base.captureFieldTypes
          ? base
          : { ...base, signature, captureFieldTypes };
      }
      case "vec.new_fixed":
      case "forof.vec": {
        const elementType = mapType(base.elementType);
        return elementType === base.elementType ? base : { ...base, elementType };
      }
      default:
        return base;
    }
  };

  const params = mapArray(fn.params, (param) => {
    const type = mapType(param.type);
    return type === param.type ? param : { ...param, type };
  });
  const resultTypes = mapArray(fn.resultTypes, mapType);
  const blocks = mapArray(fn.blocks, (block) => {
    const blockArgTypes = mapArray(block.blockArgTypes, mapType);
    const instrs = mapBuffer(block.instrs);
    return blockArgTypes === block.blockArgTypes && instrs === block.instrs
      ? block
      : { ...block, blockArgTypes, instrs };
  });
  const closureSubtype = fn.closureSubtype
    ? {
        signature: mapSignature(fn.closureSubtype.signature),
        captureFieldTypes: mapArray(fn.closureSubtype.captureFieldTypes, mapType),
        ...(fn.closureSubtype.hostOneShot ? { hostOneShot: true } : {}),
        ...(fn.closureSubtype.domCallbackAuthority
          ? { domCallbackAuthority: fn.closureSubtype.domCallbackAuthority }
          : {}),
      }
    : undefined;
  const closureSubtypeUnchanged =
    closureSubtype === undefined ||
    (closureSubtype.signature === fn.closureSubtype?.signature &&
      closureSubtype.captureFieldTypes === fn.closureSubtype.captureFieldTypes &&
      closureSubtype.hostOneShot === fn.closureSubtype.hostOneShot &&
      closureSubtype.domCallbackAuthority === fn.closureSubtype.domCallbackAuthority);
  const mapped =
    !usesString ||
    (params === fn.params && resultTypes === fn.resultTypes && blocks === fn.blocks && closureSubtypeUnchanged)
      ? fn
      : {
          ...fn,
          params,
          resultTypes,
          blocks,
          ...(closureSubtype === undefined ? {} : { closureSubtype }),
        };
  return Object.freeze({ function: mapped, usesString });
}
