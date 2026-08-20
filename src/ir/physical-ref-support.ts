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
 * Attach symbolic Program-ABI identities to final backend-owned reference
 * carriers. Inference and optimization remain unaware of those identities;
 * this preparation-only walk covers the synchronous function/type sites that
 * can reach WasmGC lowering or dependency sealing. Async-plan carrier
 * attachments remain an explicit sidecar concern for the async migration.
 */
export function attachIrPhysicalRefTypeRefs(
  fn: IrFunction,
  refFor: (type: Extract<IrType, { readonly kind: "val" }>) => IrTypeRef | undefined,
): IrFunction {
  const typeMemo = new Map<IrType, IrType>();
  const objectMemo = new Map<IrObjectShape, IrObjectShape>();
  const desiredRefMemo = new Map<IrType, IrTypeRef | null>();
  const containsTargetMemo = new Map<IrType, boolean>();

  const desiredRef = (type: Extract<IrType, { readonly kind: "val" }>): IrTypeRef | undefined => {
    const cached = desiredRefMemo.get(type);
    if (cached !== undefined) return cached ?? undefined;
    const ref = refFor(type);
    if (ref && type.val.kind !== "ref" && type.val.kind !== "ref_null") {
      throw new Error(`IR physical reference identity cannot attach to scalar ${type.val.kind}`);
    }
    if (type.typeRef && ref && irTypeBindingKey(type.typeRef.binding) !== irTypeBindingKey(ref.binding)) {
      throw new Error(
        `IR physical reference type carries ${irTypeBindingKey(type.typeRef.binding)}, expected ${irTypeBindingKey(ref.binding)}`,
      );
    }
    desiredRefMemo.set(type, ref ?? null);
    return ref;
  };

  const nestedTypes = (type: IrType): readonly IrType[] => {
    switch (type.kind) {
      case "val":
      case "string":
      case "class":
      case "extern":
      case "dynamic":
        return [];
      case "object":
        return type.shape.fields.map((field) => field.type);
      case "vec":
        return [type.elementType];
      case "closure":
      case "callable":
        return type.signature.returnType === null
          ? type.signature.params
          : [...type.signature.params, type.signature.returnType];
      case "union":
        return type.members;
      case "boxed":
        return [type.inner];
    }
  };

  const containsTarget = (root: IrType): boolean => {
    const cached = containsTargetMemo.get(root);
    if (cached !== undefined) return cached;

    // Build the complete reachable type graph before deciding which nodes
    // contain a target. A recursive DFS cannot safely memoize `false` at a
    // back-edge: A -> B -> A with the target on A would otherwise leave B on
    // its original raw-index graph. Reverse propagation gives every member of
    // a target-reaching cycle the same rewrite verdict.
    const reachable = new Set<IrType>();
    const reverse = new Map<IrType, Set<IrType>>();
    const pending = [root];
    while (pending.length > 0) {
      const type = pending.pop()!;
      if (reachable.has(type)) continue;
      reachable.add(type);
      for (const child of nestedTypes(type)) {
        let parents = reverse.get(child);
        if (!parents) reverse.set(child, (parents = new Set()));
        parents.add(type);
        if (!reachable.has(child)) pending.push(child);
      }
    }

    const targetReachable = new Set<IrType>();
    const propagate: IrType[] = [];
    for (const type of reachable) {
      const known = containsTargetMemo.get(type);
      const direct = type.kind === "val" && desiredRef(type) !== undefined && type.typeRef === undefined;
      if (known === true || direct) {
        targetReachable.add(type);
        propagate.push(type);
      }
    }
    while (propagate.length > 0) {
      const child = propagate.pop()!;
      for (const parent of reverse.get(child) ?? []) {
        if (targetReachable.has(parent)) continue;
        targetReachable.add(parent);
        propagate.push(parent);
      }
    }
    for (const type of reachable) containsTargetMemo.set(type, targetReachable.has(type));
    return targetReachable.has(root);
  };

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
    if (fields === shape.fields) {
      objectMemo.set(shape, shape);
      return shape;
    }
    const mapped = Object.assign(placeholder, { fields });
    objectMemo.set(shape, mapped);
    return mapped;
  };

  function mapType(type: IrType): IrType {
    const cached = typeMemo.get(type);
    if (cached) return cached;
    if (!containsTarget(type)) {
      typeMemo.set(type, type);
      return type;
    }
    let mapped: IrType;
    switch (type.kind) {
      case "val": {
        const typeRef = desiredRef(type);
        mapped = type.typeRef || !typeRef ? type : { ...type, typeRef };
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
      case "class":
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
  return params === fn.params && resultTypes === fn.resultTypes && blocks === fn.blocks && closureSubtypeUnchanged
    ? fn
    : {
        ...fn,
        params,
        resultTypes,
        blocks,
        ...(closureSubtype === undefined ? {} : { closureSubtype }),
      };
}
