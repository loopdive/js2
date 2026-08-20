// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irTypeBindingKey } from "./abi-bindings.js";
import {
  forEachInstrDeep,
  type IrClosureSignature,
  type IrFunction,
  type IrInstr,
  type IrObjectShape,
  type IrType,
  type IrVecLayoutRef,
  mapNestedBuffers,
} from "./nodes.js";

export interface IrVecLayoutAttachment {
  readonly function: IrFunction;
  readonly usesVec: boolean;
  /** Backend-side evidence for logical vector types retained in IrAsyncPlan. */
  readonly asyncPlanLayouts: ReadonlyMap<IrType, IrVecLayoutRef>;
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

function sameLayout(left: IrVecLayoutRef, right: IrVecLayoutRef): boolean {
  return (
    irTypeBindingKey(left.carrierType.binding) === irTypeBindingKey(right.carrierType.binding) &&
    irTypeBindingKey(left.dataType.binding) === irTypeBindingKey(right.dataType.binding) &&
    left.lengthFieldIndex === right.lengthFieldIndex &&
    left.dataFieldIndex === right.dataFieldIndex
  );
}

/**
 * Attach the final symbolic storage layout to every logical vector type.
 *
 * This pass deliberately runs after inference and middle-end transforms. A
 * backend may therefore select its physical carrier without leaking a Wasm
 * type index into JS type propagation, call-graph analysis, or optimization.
 * Existing attachments are checked rather than overwritten so a sealed
 * component cannot later lower through a different layout.
 */
export function attachIrVecLayouts(
  fn: IrFunction,
  layoutFor: (type: Extract<IrType, { kind: "vec" }>) => IrVecLayoutRef,
  logicalTypeForPhysical?: (type: Extract<IrType, { kind: "val" }>) => Extract<IrType, { kind: "vec" }> | null,
): IrVecLayoutAttachment {
  const typeMemo = new Map<IrType, IrType>();
  const objectMemo = new Map<IrObjectShape, IrObjectShape>();
  let usesVec = false;

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
      case "vec": {
        usesVec = true;
        const placeholder = { ...type };
        typeMemo.set(type, placeholder);
        const elementType = mapType(type.elementType);
        const candidate = { ...type, elementType };
        const layout = layoutFor(candidate);
        if (type.layout && !sameLayout(type.layout, layout)) {
          throw new Error("IR vec type already carries a different prepared layout");
        }
        mapped =
          type.layout && elementType === type.elementType
            ? type
            : Object.assign(placeholder, { elementType, layout: type.layout ?? layout });
        break;
      }
      case "object": {
        const placeholder = { ...type };
        typeMemo.set(type, placeholder);
        mapped = Object.assign(placeholder, { shape: mapObjectShape(type.shape) });
        break;
      }
      case "closure":
      case "callable": {
        const placeholder = { ...type };
        typeMemo.set(type, placeholder);
        mapped = Object.assign(placeholder, { signature: mapSignature(type.signature) });
        break;
      }
      case "class":
        // Class shapes carry allocator sidecars keyed by object identity.
        mapped = type;
        break;
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
      case "val": {
        const logical = logicalTypeForPhysical?.(type);
        if (logical) {
          mapped = mapType(logical);
          break;
        }
        mapped = type;
        break;
      }
      case "string":
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
    !usesVec ||
    (params === fn.params && resultTypes === fn.resultTypes && blocks === fn.blocks && closureSubtypeUnchanged)
      ? fn
      : {
          ...fn,
          params,
          resultTypes,
          blocks,
          ...(closureSubtype === undefined ? {} : { closureSubtype }),
        };

  // IrAsyncPlan stays canonical and target-neutral. Resolve every type site
  // against the selected layout only to publish backend-side Program ABI
  // evidence; never write the layout refs into the semantic plan or its hash.
  const asyncPlanLayouts = new Map<IrType, IrVecLayoutRef>();
  const seenAsyncTypes = new Set<IrType>();
  const collectAsyncType = (type: IrType): void => {
    if (seenAsyncTypes.has(type)) return;
    seenAsyncTypes.add(type);
    if (type.kind === "vec") {
      const prepared = mapType(type);
      if (prepared.kind !== "vec" || !prepared.layout) {
        throw new Error("IR async vec type has no prepared backend layout evidence");
      }
      asyncPlanLayouts.set(type, prepared.layout);
      collectAsyncType(type.elementType);
      return;
    }
    switch (type.kind) {
      case "object":
        for (const field of type.shape.fields) collectAsyncType(field.type);
        return;
      case "closure":
      case "callable":
        for (const param of type.signature.params) collectAsyncType(param);
        if (type.signature.returnType) collectAsyncType(type.signature.returnType);
        return;
      case "union":
        for (const member of type.members) collectAsyncType(member);
        return;
      case "boxed":
        collectAsyncType(type.inner);
        return;
      case "val":
      case "string":
      case "class":
      case "extern":
      case "dynamic":
        return;
    }
  };
  const collectAsyncInstr = (instr: IrInstr): void => {
    forEachInstrDeep(instr, (nested) => {
      if (nested.resultType) collectAsyncType(nested.resultType);
      switch (nested.kind) {
        case "const":
          if (nested.value.kind === "null") collectAsyncType(nested.value.ty);
          return;
        case "box":
          collectAsyncType(nested.toType);
          return;
        case "object.new":
          for (const field of nested.shape.fields) collectAsyncType(field.type);
          return;
        case "closure.new":
          for (const param of nested.signature.params) collectAsyncType(param);
          if (nested.signature.returnType) collectAsyncType(nested.signature.returnType);
          for (const capture of nested.captureFieldTypes) collectAsyncType(capture);
          return;
        case "vec.new_fixed":
        case "forof.vec":
          collectAsyncType(nested.elementType);
          return;
        default:
          return;
      }
    });
  };
  if (fn.asyncPlan) {
    if (fn.asyncPlan.abi.fulfillmentType) collectAsyncType(fn.asyncPlan.abi.fulfillmentType);
    for (const value of fn.asyncPlan.params) collectAsyncType(value.type);
    for (const value of fn.asyncPlan.values) collectAsyncType(value.type);
    for (const spill of fn.asyncPlan.spills) collectAsyncType(spill.type);
    for (const state of fn.asyncPlan.states) {
      if (state.resume) collectAsyncType(state.resume.type);
      for (const instr of state.body) collectAsyncInstr(instr);
    }
  }
  return Object.freeze({ function: mapped, usesVec, asyncPlanLayouts });
}
