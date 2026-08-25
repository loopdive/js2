// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Per-backend IR legality verifier (#1850).
//
// `verifyIrFunction` answers "is this a valid IR function?". This pass answers
// the emit-boundary question: "is this valid IR legal for the selected backend
// emitter?". Keeping the check before lowering gives unsupported backend
// surfaces a localized diagnostic instead of a late raw-emitter throw or
// malformed Wasm/bytecode.

import type { IrBinop, IrBlock, IrClassShape, IrFunction, IrInstr, IrType } from "../nodes.js";
import { asVal } from "../nodes.js";
import type { ValType } from "../types.js";
import type { CompileTargetProfile } from "../../target-profile.js";

export type IrBackendKind = "wasmgc" | "linear" | "bytecode" | "porffor";

/** Source/target features whose availability is known before IR construction. */
export type IrBackendTargetCapability =
  | "host-date-snapshot"
  | "host-regexp-constructor"
  | "host-object-define-property"
  | "standalone-function-prototype-call"
  | "standalone-native-regexp-test-carrier"
  | "standalone-wrapper-instanceof"
  | "primitive-wrapper-loose-equality"
  | "legacy-numeric-array-global"
  | "number-to-string";

/**
 * The target facts needed by pre-claim capability checks. Keep this smaller
 * than CodegenContext so the selector and non-Wasm backends can share the
 * legality decision without depending on legacy codegen state.
 */
export interface IrBackendTargetProfile {
  readonly backend: IrBackendKind;
  readonly target: "gc" | "linear" | "standalone" | "wasi";
  readonly allowHostImports: boolean;
  /** Legacy fast-array storage has a distinct ABI not yet represented in IR. */
  readonly fast?: boolean;
}

/**
 * Exact IR projection of the compiler's normalized target policy (#4396).
 *
 * `allowHostImports` means ambient JavaScript capability imports, not JS value
 * interop. A JS value bridge may remain enabled when this is false.
 */
export function projectIrBackendTargetProfile(
  profile: CompileTargetProfile,
  options: { readonly fast?: boolean } = {},
): IrBackendTargetProfile {
  return Object.freeze({
    backend: profile.backend,
    target: profile.target,
    allowHostImports: profile.environment === "javascript" && profile.capabilityPolicy === "ambient-js",
    fast: options.fast,
  });
}

/**
 * Answer predictable target/provider questions before build/lower.
 *
 * This is deliberately separate from verifyIrBackendLegality: a false result
 * is an expected source/target capability exit, while a later legality error
 * after this function returned true is an Invariant (the backend promise was
 * contradicted).
 */
export function supportsIrBackendTargetCapability(
  profile: IrBackendTargetProfile,
  capability: IrBackendTargetCapability,
): boolean {
  switch (capability) {
    case "host-date-snapshot":
      return profile.backend === "wasmgc" && profile.target === "gc" && profile.allowHostImports;
    case "host-regexp-constructor":
      return profile.backend === "wasmgc" && profile.target === "gc" && profile.allowHostImports;
    case "host-object-define-property":
      return profile.backend === "wasmgc" && profile.target === "gc" && profile.allowHostImports;
    case "standalone-function-prototype-call":
      return profile.backend === "wasmgc" && profile.target === "standalone" && !profile.allowHostImports;
    case "standalone-native-regexp-test-carrier":
      return profile.backend === "wasmgc" && profile.target === "standalone" && !profile.allowHostImports;
    case "standalone-wrapper-instanceof":
      // The IR producer consumes the fast lane's native `$AnyValue` object
      // payload as anyref. Non-fast standalone carries dynamic values as
      // externref and needs an explicit extern→any conversion node first.
      return (
        profile.backend === "wasmgc" &&
        profile.target === "standalone" &&
        !profile.allowHostImports &&
        profile.fast === true
      );
    case "primitive-wrapper-loose-equality":
      // #4208 S4 — the focused producer crosses the wrapper object's
      // externref through the canonical `__to_primitive` runtime boundary,
      // then boxes that primitive into the dynamic carrier. That boundary is
      // representation-exact only for the non-fast externref carrier today.
      // Host gc and host-free standalone/WASI both provide the wrapper ctor +
      // OrdinaryToPrimitive runtime family; strict-no-host gc does not.
      return (
        profile.backend === "wasmgc" &&
        profile.fast !== true &&
        (profile.allowHostImports || profile.target === "standalone" || profile.target === "wasi")
      );
    case "legacy-numeric-array-global":
      return profile.backend === "wasmgc" && profile.fast !== true;
    case "number-to-string":
      // (#4467) §7.1.17 Number::toString as a callable provider. Both wasmgc
      // lanes own one: host binds `env.number_toString`, whose externref IS
      // the host string carrier; native/standalone bind the #3912 native
      // formatter behind a thunk that restores the `(ref $AnyString)` carrier.
      // The other backends have no number formatter bound yet, so a numeric
      // template substitution must stay unclaimed there rather than reach a
      // resolver with no provider.
      return profile.backend === "wasmgc";
  }
}

export interface IrBackendLegalityError {
  readonly message: string;
  readonly func: string;
  readonly block?: number;
  readonly instr?: string;
}

export function verifyIrBackendLegality(func: IrFunction, backend: IrBackendKind): IrBackendLegalityError[] {
  const errors: IrBackendLegalityError[] = [];
  const checkedClassShapes = new Set<IrClassShape>();
  const checkType = (type: IrType, block: number | undefined, where: string): void => {
    const msg = backendTypeError(backend, type);
    if (msg) errors.push({ message: `${where}: ${msg}`, func: func.name, block });
    checkNestedTypeShapes(type, block, where, checkType, checkedClassShapes);
  };

  for (const p of func.params) checkType(p.type, undefined, `param ${p.name}`);
  for (let i = 0; i < func.resultTypes.length; i++) checkType(func.resultTypes[i]!, undefined, `result ${i}`);
  for (const slot of func.slots ?? [])
    checkValType(backend, slot.type, errors, func.name, undefined, `slot ${slot.name}`);

  for (const block of func.blocks) {
    const blockId = block.id as number;
    for (let i = 0; i < block.blockArgTypes.length; i++) checkType(block.blockArgTypes[i]!, blockId, `block arg ${i}`);
    for (const instr of block.instrs) checkInstr(func, backend, block, instr, errors, checkType);
  }
  return errors;
}

function checkInstr(
  func: IrFunction,
  backend: IrBackendKind,
  block: IrBlock,
  instr: IrInstr,
  errors: IrBackendLegalityError[],
  checkType: (type: IrType, block: number | undefined, where: string) => void,
): void {
  const blockId = block.id as number;
  const reject = (reason: string): void => {
    errors.push({
      message: `block ${blockId} instr ${instr.kind}: ${reason}`,
      func: func.name,
      block: blockId,
      instr: instr.kind,
    });
  };

  if (instr.resultType) checkType(instr.resultType, blockId, `${instr.kind} result`);

  if (backend === "linear") {
    const reason = linearInstrError(instr);
    if (reason) reject(reason);
  } else if (backend === "bytecode") {
    const reason = bytecodeInstrError(instr);
    if (reason) reject(reason);
  } else if (backend === "porffor") {
    const reason = porfforInstrError(instr);
    if (reason) reject(reason);
  }

  checkInstrEmbeddedTypes(instr, blockId, checkType);
  for (const nested of nestedInstrBuffers(instr)) {
    for (const sub of nested) checkInstr(func, backend, block, sub, errors, checkType);
  }
}

// #2954 — the linear backend's whole-function lowering boundary now permits the
// CORE-OP families (const / arithmetic / locals-as-slots / structured control
// flow / direct call). These lower to core Wasm and `LinearEmitter` emits them
// byte-identically to `WasmGcEmitter`. The representation-DIVERGENT families
// (closures, dynamic boxing, exceptions, non-fixed vec
// iteration, promises) stay rejected here — the linear analogue lands
// with the production wiring (#2956). This mirrors `bytecodeInstrError`'s
// allow-list shape; the operand-type gate (`linearValTypeError`) independently
// rejects any non-{i32,i64,f32,f64} value, so allowing an op kind here never
// admits a divergent-typed operand.
function linearInstrError(instr: IrInstr): string | null {
  switch (instr.kind) {
    case "const":
      switch (instr.value.kind) {
        case "i32":
        case "i64":
        case "f32":
        case "f64":
        case "bool":
          return null;
        default:
          // null/ref/string/undefined consts are representation-divergent.
          return `linear backend does not support const '${instr.value.kind}'`;
      }
    case "intrinsic":
      switch (instr.id) {
        case "math.abs":
        case "math.ceil":
        case "math.floor":
        case "math.sqrt":
        case "math.trunc":
          return null;
        default:
          return `linear backend does not support semantic intrinsic '${instr.id}' without a native backend operation`;
      }
    case "string.repeat":
      return instr.encodingEvidence === "ascii"
        ? null
        : `linear backend requires authenticated ASCII evidence for string.repeat, got '${instr.encodingEvidence}'`;
    case "binary":
    case "unary":
    case "select":
    case "if":
    case "call":
    // #2956 L3: strings use the direct linear backend's canonical i32 arena
    // pointer and existing UTF-8 runtime helpers.
    case "string.const":
    case "string.concat":
    case "string.eq":
    case "string.len":
    case "string.char_at":
    case "string.char_code_at":
    // #2956 L2: aggregates and primitive ref-cells use i32 arena pointers,
    // with field access emitted as typed linear-memory loads/stores.
    case "object.new":
    case "object.get":
    case "object.set":
    case "refcell.new":
    case "refcell.get":
    case "refcell.set":
    case "global.get":
    case "global.set":
    case "slot.read":
    case "slot.write":
    // #2956 L2: vec values are i32 arena pointers in the linear resolver.
    // Fixed construction plus len/get are now representation-complete.
    case "vec.new_fixed":
    case "vec.len":
    case "vec.get":
    case "vec.set":
    // #4558 — the counted-push preallocation (0f7f4039c) wired
    // `emitVecSetLength` into LinearEmitter (an i32.store at the layout's
    // lengthOffset) but never admitted the instruction here, so every
    // function using the preallocated-push lowering demoted at
    // `illegal:instr-vec.set_length` despite the emitter supporting it.
    case "vec.set_length":
    case "while.loop":
    case "for.loop":
    // #2952 slice 2 — br.label lowers to a core-Wasm `br` (depth derived by
    // the shared ctrlStack resolver) and if.stmt to a core `if`/`block`;
    // both are backend-identical structured control flow like the loop
    // kinds above (#1852/#1527 axis rule).
    case "br.label":
    case "if.stmt":
    // #2952 slice 4 — labeled.block is one core `block`; switch is the
    // block-per-case ladder (core blocks + i32/f64.eq + br/br_table). The
    // LinearEmitter's sink IS Instr[], so the switch arm's
    // requireInstrSink holds (unlike porffor/bytecode, which stay
    // rejected below).
    case "labeled.block":
    case "switch":
      return null;
    default:
      return `linear backend does not support IR instruction '${instr.kind}' at the function-lowering boundary`;
  }
}

function bytecodeInstrError(instr: IrInstr): string | null {
  switch (instr.kind) {
    case "const":
      switch (instr.value.kind) {
        case "i32":
        case "f32":
        case "f64":
        case "bool":
          return null;
        default:
          return `bytecode backend does not support const '${instr.value.kind}'`;
      }
    case "binary":
      return bytecodeBinopLegal(instr.op) ? null : `bytecode backend does not support binary op '${instr.op}'`;
    case "unary":
      return instr.op === "f64.neg" ? null : `bytecode backend does not support unary op '${instr.op}'`;
    case "call":
    case "global.get":
    case "global.set":
    case "select":
    case "if":
    case "object.new":
    case "object.get":
    case "object.set":
    case "throw":
      return null;
    default:
      return `bytecode backend does not support IR instruction '${instr.kind}'`;
  }
}

function bytecodeBinopLegal(op: IrBinop): boolean {
  switch (op) {
    case "f64.add":
    case "f64.sub":
    case "f64.mul":
    case "f64.div":
    case "f64.gt":
    case "f64.lt":
    case "f64.ge":
    case "f64.le":
    case "f64.eq":
    case "f64.ne":
    case "i32.gt_s":
    case "i32.lt_s":
    case "i32.ge_s":
    case "i32.le_s":
    case "i32.eq":
    case "i32.ne":
      return true;
    default:
      return false;
  }
}

// #3288 P1 / #3297 P2 — scalar/control-flow Porffor profile. Every admitted
// family reaches a typed BackendEmitter primitive in lower.ts; heap/reference
// families and composite ops that still need a representation decision remain
// rejected before a Porffor emitter can observe them.
function porfforInstrError(instr: IrInstr): string | null {
  switch (instr.kind) {
    case "const":
      switch (instr.value.kind) {
        case "i32":
        case "i64":
        case "f64":
        case "bool":
          return null;
        default:
          return `porffor backend does not support const '${instr.value.kind}'`;
      }
    case "binary":
      return porfforBinopLegal(instr.op)
        ? null
        : `porffor backend does not support binary op '${instr.op}' before typed composite-op lowering`;
    case "unary":
      return instr.op === "ref.is_null" ? `porffor backend does not support unary op '${instr.op}'` : null;
    case "call":
    case "global.get":
    case "global.set":
    case "object.new":
    case "object.get":
    case "object.set":
    case "slot.read":
    case "slot.write":
    case "vec.new_fixed":
    case "vec.len":
    case "vec.get":
    case "vec.set":
    // #4558 — same desync as the linear profile: PorfforSink.emitVecSetLength
    // (a u32 store at the planned layout's lengthOffset) landed with the
    // counted-push preallocation but was never admitted here.
    case "vec.set_length":
    case "select":
    case "if":
    case "early.return":
    case "br.label":
    case "if.stmt":
    case "while.loop":
    case "for.loop":
    case "string.const":
    case "string.concat":
    case "string.len":
    case "string.char_at":
    case "string.char_code_at":
      return null;
    default:
      return `porffor backend does not support IR instruction '${instr.kind}' before typed Porffor lowering`;
  }
}

function porfforBinopLegal(op: IrBinop): boolean {
  switch (op) {
    case "f64.add":
    case "f64.sub":
    case "f64.mul":
    case "f64.div":
    case "f64.copysign":
    case "f64.eq":
    case "f64.ne":
    case "f64.lt":
    case "f64.le":
    case "f64.gt":
    case "f64.ge":
    case "i32.eq":
    case "i32.ne":
    case "i32.and":
    case "i32.or":
    case "i32.lt_s":
    case "i32.le_s":
    case "i32.gt_s":
    case "i32.ge_s":
    case "i32.lt_u":
    case "i32.le_u":
    case "i32.gt_u":
    case "i32.ge_u":
    // (#3758) native i32 arithmetic — `binaryOp` (porffor/sink.ts) maps
    // these to a plain typed `+`/`-`/`*` Porffor node over i32 operands, the
    // same shape as any other typed scalar op in this profile.
    case "i32.add":
    case "i32.sub":
    case "i32.mul":
    case "i64.rem_s":
    // #3499: lower.ts expands these through backend-neutral typed scalar
    // primitives (ToInt32, native i32 bitwise op, and signed/unsigned result
    // conversion). No raw Wasm instruction reaches the Porffor sink.
    case "js.bitand":
    case "js.bitor":
    case "js.bitxor":
    case "js.shl":
    case "js.shr_s":
    case "js.shr_u":
      return true;
    default:
      return false;
  }
}

function backendTypeError(backend: IrBackendKind, type: IrType): string | null {
  if (type.kind === "fnctor") {
    return `${backend} backend does not support nominal fnctor types until an explicit ABI resolver is installed`;
  }
  if (backend === "wasmgc") return null;
  if (backend === "linear") {
    if (type.kind === "string") return null;
    if (type.kind === "vec") {
      const element = asVal(type.elementType);
      return element?.kind === "f64"
        ? null
        : `${backend} backend does not support vec element IR type '${type.elementType.kind}'`;
    }
    if (type.kind === "object") return linearAggregateTypeError(type);
    if (type.kind === "boxed") {
      const inner = asVal(type.inner);
      return inner && (inner.kind === "i32" || inner.kind === "f64")
        ? null
        : `${backend} backend does not support boxed IR type '${type.inner.kind}'`;
    }
    const v = asVal(type);
    if (!v) return `${backend} backend does not support IR type '${type.kind}'`;
    return linearValTypeError(v);
  }
  if (backend === "bytecode") {
    if (type.kind === "object") return null;
    const v = asVal(type);
    if (!v) return `bytecode backend does not support IR type '${type.kind}'`;
    return bytecodeValTypeError(v);
  }
  if (type.kind === "object") return porfforAggregateTypeError(type);
  if (type.kind === "string") return null;
  if (type.kind === "vec") {
    const element = asVal(type.elementType);
    return element?.kind === "f64"
      ? null
      : `${backend} backend does not support vec element IR type '${type.elementType.kind}'`;
  }
  const v = asVal(type);
  if (!v) return `porffor backend does not support IR type '${type.kind}'`;
  return porfforValTypeError(v);
}

function porfforAggregateTypeError(type: Extract<IrType, { kind: "object" }>): string | null {
  for (const field of type.shape.fields) {
    const value = asVal(field.type);
    if (!value || (value.kind !== "i32" && value.kind !== "f64")) {
      return `porffor backend does not support aggregate field IR type '${field.type.kind}'`;
    }
  }
  return null;
}

function linearAggregateTypeError(type: Extract<IrType, { kind: "object" }>): string | null {
  for (const field of type.shape.fields) {
    if (field.type.kind === "val") {
      if (field.type.val.kind !== "i32" && field.type.val.kind !== "f64") {
        return `linear backend does not support aggregate field ValType '${field.type.val.kind}'`;
      }
      continue;
    }
    if (field.type.kind === "object") {
      const nested = linearAggregateTypeError(field.type);
      if (nested) return nested;
      continue;
    }
    if (field.type.kind === "string") continue;
    if (field.type.kind === "boxed") {
      const inner = asVal(field.type.inner);
      if (inner && (inner.kind === "i32" || inner.kind === "f64")) continue;
    }
    return `linear backend does not support aggregate field IR type '${field.type.kind}'`;
  }
  return null;
}

function checkValType(
  backend: IrBackendKind,
  type: ValType,
  errors: IrBackendLegalityError[],
  func: string,
  block: number | undefined,
  where: string,
): void {
  const msg =
    backend === "bytecode"
      ? bytecodeValTypeError(type)
      : backend === "linear"
        ? linearValTypeError(type)
        : backend === "porffor"
          ? porfforValTypeError(type)
          : null;
  if (msg) errors.push({ message: `${where}: ${msg}`, func, block });
}

function linearValTypeError(v: ValType): string | null {
  switch (v.kind) {
    case "i32":
    case "i64":
    case "f32":
    case "f64":
      return null;
    default:
      return `linear backend does not support ValType '${v.kind}'`;
  }
}

function bytecodeValTypeError(v: ValType): string | null {
  switch (v.kind) {
    case "i32":
    case "f32":
    case "f64":
      return null;
    default:
      return `bytecode backend does not support ValType '${v.kind}'`;
  }
}

function porfforValTypeError(v: ValType): string | null {
  switch (v.kind) {
    case "i32":
    case "i64":
    case "f64":
      return null;
    default:
      return `porffor backend does not support ValType '${v.kind}'`;
  }
}

function checkNestedTypeShapes(
  type: IrType,
  block: number | undefined,
  where: string,
  checkType: (type: IrType, block: number | undefined, where: string) => void,
  checkedClassShapes: Set<IrClassShape>,
): void {
  switch (type.kind) {
    case "object":
      for (const field of type.shape.fields) checkType(field.type, block, `${where}.${field.name}`);
      return;
    case "closure":
    case "callable":
      for (let i = 0; i < type.signature.params.length; i++)
        checkType(type.signature.params[i]!, block, `${where}.param${i}`);
      if (type.signature.returnType) checkType(type.signature.returnType, block, `${where}.return`);
      return;
    case "class":
      if (checkedClassShapes.has(type.shape)) return;
      checkedClassShapes.add(type.shape);
      for (const field of type.shape.fields) checkType(field.type, block, `${where}.${field.name}`);
      for (const method of type.shape.methods) {
        for (let i = 0; i < method.params.length; i++)
          checkType(method.params[i]!, block, `${where}.${method.name}.param${i}`);
        if (method.returnType) checkType(method.returnType, block, `${where}.${method.name}.return`);
      }
      return;
    default:
      return;
  }
}

function checkInstrEmbeddedTypes(
  instr: IrInstr,
  block: number,
  checkType: (type: IrType, block: number | undefined, where: string) => void,
): void {
  switch (instr.kind) {
    case "const":
      if (instr.value.kind === "null") checkType(instr.value.ty, block, "const null type");
      return;
    case "box":
      checkType(instr.toType, block, "box target");
      return;
    case "object.new":
      checkType({ kind: "object", shape: instr.shape }, block, "object.new shape");
      return;
    case "closure.new":
      for (let i = 0; i < instr.captureFieldTypes.length; i++) {
        checkType(instr.captureFieldTypes[i]!, block, `closure.new capture ${i}`);
      }
      return;
    case "class.new":
      checkType({ kind: "class", shape: instr.shape }, block, "class.new shape");
      return;
    case "forof.vec":
      checkType(instr.elementType, block, "forof.vec element");
      return;
    case "vec.new_fixed":
      checkType(instr.elementType, block, "vec.new_fixed element");
      return;
    default:
      return;
  }
}

function nestedInstrBuffers(instr: IrInstr): readonly (readonly IrInstr[])[] {
  switch (instr.kind) {
    case "if":
      return [instr.then, instr.else];
    case "forof.vec":
    case "forof.iter":
    case "forof.string":
      return [instr.body];
    case "while.loop":
      return [instr.cond, instr.body];
    case "for.loop":
      return [instr.cond, instr.body, instr.update];
    case "try": {
      const out: (readonly IrInstr[])[] = [instr.body];
      if (instr.catchClause) out.push(instr.catchClause.body);
      if (instr.finallyBody) out.push(instr.finallyBody);
      return out;
    }
    // #2952 slice 2 — statement-level if arms.
    case "if.stmt":
      return [instr.then, instr.else];
    // #2952 slice 4 — labeled block / switch clause buffers.
    case "labeled.block":
      return [instr.body];
    case "switch":
      return instr.bodies;
    default:
      return [];
  }
}
