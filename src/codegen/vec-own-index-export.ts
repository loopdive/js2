// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { STABLE_FUNC_BASE } from "../emit/resolve-layout.js";
import type { FuncHandle, Instr, ValType, WasmExport, WasmFunction } from "../ir/types.js";
import { ensureHoleType } from "./array-holes.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, definedFuncHandleOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { PROGRAM_ABI_CALLABLE_ROLE } from "./program-abi-planning.js";
import { addFuncType, getArrTypeIdxFromVec } from "./registry/types.js";
import { HOLE_F64_BITS } from "./value-tags.js";
import { VEC_HOST_BRIDGE_ROLE, vecHostBridgeWritebackOrdinal } from "./vec-access-exports.js";

/** Separate raw-presence subfamily; never a seventh core bridge. */
export function vecHostBridgeOwnIndexOrdinal(): number {
  const ordinal = Math.max(vecHostBridgeWritebackOrdinal("setElem"), vecHostBridgeWritebackOrdinal("setLen")) + 1;
  if (ordinal !== 11) throw new Error(`vec own-index ABI must occupy ordinal 11, got ${ordinal}`);
  return ordinal;
}

const NAME = "__vec_own_index";
interface Allocation {
  readonly func: WasmFunction;
  readonly entry: WasmExport;
  readonly name: string;
}
const allocations = new WeakMap<CodegenContext, Allocation>();

/**
 * A0 is raw storage presence, NOT HasProperty or an own descriptor service.
 * Callers must select the supplying instance's helper: canonical Wasm shapes
 * are not instance brands, and externref hole identity is instance-local.
 */
function presence(ctx: CodegenContext, arrayType: number, element: ValType): Instr[] | undefined {
  if (element.kind === "f64") {
    return [
      { op: "array.get", typeIdx: arrayType },
      { op: "i64.reinterpret_f64" },
      { op: "i64.const", value: HOLE_F64_BITS },
      { op: "i64.ne" },
    ];
  }
  if (element.kind === "externref" || element.kind === "ref_extern") {
    const hole = ensureHoleType(ctx);
    // Type alone is insufficient: a user-created empty struct can have the
    // same canonical Wasm type as $Hole. Compare the private singleton itself.
    return [
      { op: "array.get", typeIdx: arrayType },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 3 },
      { op: "ref.test", typeIdx: ctx.holeTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 3 },
          { op: "ref.cast", typeIdx: ctx.holeTypeIdx },
          { op: "global.get", index: hole },
          { op: "ref.eq" },
          { op: "i32.eqz" },
        ],
        else: [{ op: "i32.const", value: 1 }],
      },
    ];
  }
  // These actual storage kinds have no hole sentinel. Do not infer presence
  // for nullable struct/string carriers whose absence representation is unknown.
  if (["i8", "i16", "i32", "i64", "f32"].includes(element.kind)) {
    return [{ op: "drop" }, { op: "drop" }, { op: "i32.const", value: 1 }];
  }
  return undefined;
}

function bodyFor(ctx: CodegenContext): Instr[] {
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 2 }];
  for (const vecType of [...new Set(ctx.vecTypeMap.values())].sort((a, b) => a - b)) {
    const arrayType = getArrTypeIdxFromVec(ctx, vecType);
    const array = ctx.mod.types[arrayType];
    const vec = ctx.mod.types[vecType];
    if (array?.kind !== "array" || vec?.kind !== "struct" || vec.fields[0]?.type.kind !== "i32") continue;
    const read = presence(ctx, arrayType, array.element);
    if (!read) continue;
    const data = (): Instr[] => [
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: vecType },
      { op: "struct.get", typeIdx: vecType, fieldIdx: 1 },
    ];
    body.push(
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: vecType },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx: vecType },
          { op: "struct.get", typeIdx: vecType, fieldIdx: 0 },
          { op: "i32.lt_u" },
          { op: "local.get", index: 1 },
          ...data(),
          { op: "array.len" },
          { op: "i32.lt_u" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [...data(), { op: "local.get", index: 1 }, ...read],
            else: [{ op: "i32.const", value: 0 }],
          },
          { op: "return" },
        ],
      },
    );
  }
  body.push({ op: "i32.const", value: -1 });
  return body;
}

/**
 * Selected host property-service demand, not mere numeric/vector storage.
 * Runtime/start-time publication and consumption are deliberately left to A1.
 */
export function emitVecOwnIndexExport(ctx: CodegenContext): FuncHandle | undefined {
  const existing = allocations.get(ctx);
  if (existing) return definedFuncHandleOf(ctx, existing.func);
  if (!ctx.emitHostBridge || ctx.standalone || ctx.wasi || !ctx.usesVecValue) return undefined;
  const wants = ctx.mod.imports.some(
    (entry) =>
      entry.desc.kind === "func" &&
      entry.module === "env" &&
      ["__getOwnPropertyDescriptor", "__host_set_struct_proto"].includes(entry.name),
  );
  if (!wants) return undefined;
  const body = bodyFor(ctx);
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "i32" }], `$${NAME}_type`);
  const func: WasmFunction = {
    name: NAME,
    typeIdx,
    exported: true,
    locals: [
      { name: "__own_vec", type: { kind: "anyref" } },
      { name: "__own_value", type: { kind: "anyref" } },
    ],
    body,
  };
  const handle = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, handle, func);
  if (!ctx.funcMap.has(NAME)) ctx.funcMap.set(NAME, handle);
  // User exports keep their descriptors. A1 must resolve this allocation's
  // published descriptor, never trust a same-labelled user function.
  let name = NAME;
  const occupied = new Set(ctx.mod.exports.map((entry) => entry.name));
  while (occupied.has(name)) name += "$";
  const entry: WasmExport = { name, desc: { kind: "func", index: handle } };
  ctx.mod.exports.push(entry);
  allocations.set(ctx, { func, entry, name });
  ctx.programAbiCallables?.observeEntrySourceSupports([
    {
      role: VEC_HOST_BRIDGE_ROLE,
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.vecHostBridge,
      derivedOrdinal: vecHostBridgeOwnIndexOrdinal(),
      displayName: NAME,
      funcIdx: handle,
    },
  ]);
  return handle;
}

/** Exact allocator-owned descriptor for later publication; no name lookup. */
export function vecOwnIndexExport(ctx: CodegenContext): WasmExport | undefined {
  return allocations.get(ctx)?.entry;
}

/** Same stable-handle/final-live-index lifecycle as the core vector bridges. */
export function finalizeVecOwnIndexExport(ctx: CodegenContext): void {
  const allocation = allocations.get(ctx);
  if (!allocation) return;
  const { func, entry, name } = allocation;
  const imports = ctx.mod.imports.filter((candidate) => candidate.desc.kind === "func").length;
  if (
    entry.name !== name ||
    entry.desc.kind !== "func" ||
    ctx.mod.exports.filter((candidate) => candidate === entry).length !== 1
  ) {
    throw new Error("vec own-index export lost its allocator-owned descriptor");
  }
  const target =
    entry.desc.index >= STABLE_FUNC_BASE
      ? definedFuncAt(ctx, entry.desc.index)
      : ctx.mod.functions[entry.desc.index - imports];
  const position = ctx.mod.functions.indexOf(func);
  if (position < 0 || target !== func)
    throw new Error("vec own-index export resolves to a different allocator function");
  entry.desc.index = imports + position;
}
