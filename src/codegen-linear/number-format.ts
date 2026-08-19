// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Exact, host-free f64 → linear UTF-8 string formatting.
 *
 * The arithmetic and ECMAScript framing come from the property-tested Ryū
 * implementation in codegen/number-ryu.ts. At compiler time we translate its
 * two representation-specific operations (GC-array table/buffer access) onto
 * immutable linear-memory tables and byte-buffer helpers. No arithmetic port
 * is duplicated here.
 */
import {
  LINEAR_STRING_PAYLOAD_PREFIX_BYTES,
  LINEAR_STRING_PAYLOAD_SIZE_OFFSET,
} from "../ir/analysis/linear-memory-plan.js";
import type { TypedAST } from "../checker/index.js";
import { buildPortableRyuTemplate } from "../codegen/number-ryu-portable.js";
import type { Instr, LocalDef, ValType, WasmModule } from "../ir/types.js";
import { forEachChild, ts } from "../ts-api.js";
import { NUMBER_TO_STRING_RUNTIME } from "./coercion-engine.js";
import type { LinearContext } from "./context.js";
import { isLinkedArena, type LinkedHeapOptions } from "./linked-arena.js";
import { addRuntime as addBaseRuntime } from "./runtime.js";

// All three are ABSOLUTE addresses and are STANDALONE-MODE ONLY (#4540). In the
// ADR-0020 link topology they name bytes the engine artifact owns: 1024 and
// 16384 are inside its shadow stack [0, 65536), and 65536 is the exact first
// byte of its static data. The tables are addressed by these constants across a
// large generated body — as `i32.const` operands AND as `offset=` immediates —
// so rebasing them is a per-site rewrite where one miss reads engine memory and
// returns a plausible wrong number. Until that rewrite exists, `addRuntime`
// REFUSES number formatting in linked mode. See ADR-0022.
const TABLE_BASE = 1024;
/** Keep literals above the immutable Ryū tables in modules that need formatting. */
export const LINEAR_NUMBER_FORMAT_DATA_BASE = 16384;
/** One-page static reservation; malloc grows memory before its first allocation. */
export const LINEAR_NUMBER_FORMAT_HEAP_START = 65536;

const I32: ValType = { kind: "i32" };
const I64: ValType = { kind: "i64" };
const F64: ValType = { kind: "f64" };

export function sourceMayUseLinearNumberToString(ast: TypedAST): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 0 &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "toString"
    ) {
      try {
        const type = ast.checker.getNonNullableType(ast.checker.getTypeAtLocation(node.expression.expression));
        if ((type.flags & ts.TypeFlags.NumberLike) !== 0) {
          found = true;
          return;
        }
      } catch {
        // Unresolved receiver: the direct/IR lowering keeps its normal fallback.
      }
    }
    forEachChild(node, visit);
  };
  visit(ast.sourceFile);
  return found;
}

export function emitLinearStringData(ctx: LinearContext, dataSegmentBase: number): void {
  if (ctx.stringLiterals.size === 0) return;
  const bytes = new Uint8Array(ctx.dataSegmentOffset - dataSegmentBase);
  for (const literal of ctx.stringLiterals.values()) {
    bytes.set(literal.bytes, literal.offset - dataSegmentBase);
  }
  // #4540 — in linked mode the segment is PASSIVE: it carries no address and is
  // inert at instantiation. `finalizeLinkedDataImage` copies it into a block
  // obtained from the memory owner's allocator. `offset` is retained only as
  // the link-time base the literal offsets were assigned from.
  ctx.mod.dataSegments.push({
    offset: dataSegmentBase,
    bytes,
    ...(isLinkedArena(ctx.mod) ? { passive: true } : {}),
  });
}

export function addRuntime(
  mod: WasmModule,
  ast: TypedAST,
  exposeArenaReset: boolean | undefined,
  defaultDataSegmentBase: number,
  linkedHeap?: LinkedHeapOptions,
  heapAllocator?: "bump" | "malloc-v1",
): number {
  const enabled = sourceMayUseLinearNumberToString(ast);
  if (enabled && linkedHeap !== undefined) {
    // #4540 — the Ryū tables are addressed by CONSTANTS baked across a large
    // generated body (`TABLE_BASE` + per-table cursors, consumed as `i32.const`
    // operands and `offset=` immediates). In linked mode those constants name
    // bytes inside the engine's shadow stack, and rebasing them means rewriting
    // every one of those sites correctly — miss one and the formatter silently
    // reads engine memory and returns plausible garbage. Refuse the
    // combination until the tables are rebased with the same bias the literal
    // image uses; a wrong number is worse than a refused compile.
    throw new Error(
      "linear number formatter: number.toString() is not yet supported in linked mode — the Ryū " +
        "tables are placed at fixed link-time addresses that belong to the memory's owner. " +
        "See #4540.",
    );
  }
  addBaseRuntime(mod, {
    exposeArenaReset,
    ...(enabled ? { heapStart: LINEAR_NUMBER_FORMAT_HEAP_START } : {}),
    ...(linkedHeap !== undefined ? { linkedHeap } : {}),
    ...(heapAllocator !== undefined ? { heapAllocator } : {}),
  });
  if (enabled) addLinearNumberToStringRuntime(mod);
  return enabled ? LINEAR_NUMBER_FORMAT_DATA_BASE : defaultDataSegmentBase;
}

function addFunc(
  mod: WasmModule,
  name: string,
  params: ValType[],
  results: ValType[],
  locals: readonly LocalDef[],
  body: readonly Instr[],
): number {
  const typeIdx = mod.types.length;
  mod.types.push({ kind: "func", name: `$type_${name}`, params, results });
  const funcIdx = mod.imports.filter((item) => item.desc.kind === "func").length + mod.functions.length;
  mod.functions.push({ name, typeIdx, locals: [...locals], body: [...body], exported: false });
  return funcIdx;
}

function findFunc(mod: WasmModule, name: string): number {
  const imports = mod.imports.filter((item) => item.desc.kind === "func").length;
  const local = mod.functions.findIndex((func) => func.name === name);
  if (local < 0) throw new Error(`linear number formatter: missing runtime function ${name}`);
  return imports + local;
}

function tableBytes(tables: readonly (readonly bigint[])[]): { bytes: Uint8Array; offsets: number[] } {
  const count = tables.reduce((sum, table) => sum + table.length, 0);
  const bytes = new Uint8Array(count * 8);
  const view = new DataView(bytes.buffer);
  const offsets: number[] = [];
  let cursor = 0;
  for (const table of tables) {
    offsets.push(TABLE_BASE + cursor);
    for (const value of table) {
      view.setBigInt64(cursor, value, true);
      cursor += 8;
    }
  }
  return { bytes, offsets };
}

function loadTableI64(base: number, indexLocal: number): Instr[] {
  const address = (): Instr[] => [
    { op: "i32.const", value: base },
    { op: "local.get", index: indexLocal },
    { op: "i32.const", value: 3 },
    { op: "i32.shl" },
    { op: "i32.add" },
  ];
  return [
    ...address(),
    { op: "i32.load", align: 2, offset: 0 },
    { op: "i64.extend_i32_u" },
    ...address(),
    { op: "i32.load", align: 2, offset: 4 },
    { op: "i64.extend_i32_u" },
    { op: "i64.const", value: 32n },
    { op: "i64.shl" },
    { op: "i64.or" },
  ];
}

function translate(
  body: readonly Instr[],
  tableOffsets: readonly number[],
  calls: ReadonlyMap<number, number>,
  bufGetIdx: number,
  bufSetIdx: number,
): Instr[] {
  const out: Instr[] = [];
  for (let i = 0; i < body.length; i++) {
    const instr = body[i]!;
    const index = body[i + 1];
    const get = body[i + 2];
    if (
      instr.op === "global.get" &&
      index?.op === "local.get" &&
      get?.op === "array.get" &&
      tableOffsets[instr.index] !== undefined
    ) {
      out.push(...loadTableI64(tableOffsets[instr.index]!, index.index));
      i += 2;
      continue;
    }
    const one = body[i + 2];
    const add = body[i + 3];
    const getNext = body[i + 4];
    if (
      instr.op === "global.get" &&
      index?.op === "local.get" &&
      one?.op === "i32.const" &&
      one.value === 1 &&
      add?.op === "i32.add" &&
      getNext?.op === "array.get" &&
      tableOffsets[instr.index] !== undefined
    ) {
      out.push(...loadTableI64(tableOffsets[instr.index]! + 8, index.index));
      i += 4;
      continue;
    }
    if (instr.op === "array.get_u") {
      out.push({ op: "call", funcIdx: bufGetIdx });
      continue;
    }
    if (instr.op === "array.set") {
      out.push({ op: "call", funcIdx: bufSetIdx });
      continue;
    }
    if (instr.op === "array.get") {
      throw new Error("linear number formatter: unmatched portable table read");
    }
    if (instr.op === "call") {
      out.push({ ...instr, funcIdx: calls.get(instr.funcIdx) ?? instr.funcIdx });
      continue;
    }
    if (instr.op === "block" || instr.op === "loop") {
      out.push({ ...instr, body: translate(instr.body, tableOffsets, calls, bufGetIdx, bufSetIdx) });
      continue;
    }
    if (instr.op === "if") {
      out.push({
        ...instr,
        then: translate(instr.then, tableOffsets, calls, bufGetIdx, bufSetIdx),
        ...(instr.else ? { else: translate(instr.else, tableOffsets, calls, bufGetIdx, bufSetIdx) } : {}),
      });
      continue;
    }
    out.push(instr);
  }
  return out;
}

function finalizeString(ptr: number, pos: number): Instr[] {
  return [
    { op: "local.get", index: ptr },
    { op: "local.get", index: pos },
    { op: "i32.const", value: LINEAR_STRING_PAYLOAD_PREFIX_BYTES },
    { op: "i32.add" },
    { op: "i32.store", align: 2, offset: LINEAR_STRING_PAYLOAD_SIZE_OFFSET },
    { op: "local.get", index: ptr },
    { op: "local.get", index: pos },
    { op: "i32.store", align: 2, offset: 8 },
    { op: "local.get", index: ptr },
    { op: "return" },
  ];
}

/** Register the f64 → linear-string coercion and its exact Ryū dependencies. */
export function addLinearNumberToStringRuntime(mod: WasmModule): void {
  if (mod.functions.some((func) => func.name === NUMBER_TO_STRING_RUNTIME)) return;
  const template = buildPortableRyuTemplate();
  const encoded = tableBytes(template.tables);
  mod.dataSegments.push({ offset: TABLE_BASE, bytes: encoded.bytes });

  const bufGetIdx = addFunc(
    mod,
    "__linear_ryu_buf_get",
    [I32, I32],
    [I32],
    [],
    [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "i32.add" },
      { op: "i32.load8_u", align: 0, offset: 12 },
    ],
  );
  const bufSetIdx = addFunc(
    mod,
    "__linear_ryu_buf_set",
    [I32, I32, I32],
    [],
    [],
    [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "i32.add" },
      { op: "local.get", index: 2 },
      { op: "i32.store8", align: 0, offset: 12 },
    ],
  );

  const mul = template.functions.get("__ryu_mul_shift")!;
  const digits = template.functions.get("__num_ryu_digits")!;
  const toBuf = template.functions.get("__num_ryu_to_buf")!;
  const firstTemplateIdx = mod.imports.filter((item) => item.desc.kind === "func").length + mod.functions.length;
  const calls = new Map<number, number>([
    [mul.handle, firstTemplateIdx],
    [digits.handle, firstTemplateIdx + 1],
    [toBuf.handle, firstTemplateIdx + 2],
  ]);
  addFunc(
    mod,
    "__linear_ryu_mul_shift",
    [I64, I64, I64, I32],
    [I64],
    mul.locals,
    translate(mul.body, encoded.offsets, calls, bufGetIdx, bufSetIdx),
  );
  addFunc(
    mod,
    "__linear_ryu_digits",
    [F64],
    [I64, I32],
    digits.locals,
    translate(digits.body, encoded.offsets, calls, bufGetIdx, bufSetIdx),
  );
  const toBufIdx = addFunc(
    mod,
    "__linear_ryu_to_buf",
    [F64, I32, I32, I32],
    [I32],
    toBuf.locals,
    translate(toBuf.body, encoded.offsets, calls, bufGetIdx, bufSetIdx),
  );

  const mallocIdx = findFunc(mod, "__malloc");
  const PTR = 1;
  const POS = 2;
  const NEG = 3;
  const ABS = 4;
  const writeWord = (word: string): Instr[] =>
    [...word].flatMap((char, index): Instr[] => [
      { op: "local.get", index: PTR },
      { op: "i32.const", value: index },
      { op: "i32.const", value: char.charCodeAt(0) },
      { op: "call", funcIdx: bufSetIdx },
    ]);
  const returnWord = (word: string): Instr[] => [
    ...writeWord(word),
    { op: "i32.const", value: word.length },
    { op: "local.set", index: POS },
    ...finalizeString(PTR, POS),
  ];
  const body: Instr[] = [
    { op: "i32.const", value: 268 },
    { op: "call", funcIdx: mallocIdx },
    { op: "local.set", index: PTR },
    { op: "local.get", index: 0 },
    { op: "local.get", index: 0 },
    { op: "f64.ne" },
    { op: "if", blockType: { kind: "empty" }, then: returnWord("NaN") },
    { op: "local.get", index: 0 },
    { op: "f64.const", value: Number.MAX_VALUE },
    { op: "f64.gt" },
    { op: "if", blockType: { kind: "empty" }, then: returnWord("Infinity") },
    { op: "local.get", index: 0 },
    { op: "f64.const", value: -Number.MAX_VALUE },
    { op: "f64.lt" },
    { op: "if", blockType: { kind: "empty" }, then: returnWord("-Infinity") },
    { op: "local.get", index: 0 },
    { op: "f64.const", value: 0 },
    { op: "f64.eq" },
    { op: "if", blockType: { kind: "empty" }, then: returnWord("0") },
    { op: "local.get", index: 0 },
    { op: "f64.const", value: 0 },
    { op: "f64.lt" },
    { op: "local.set", index: NEG },
    { op: "local.get", index: 0 },
    { op: "f64.abs" },
    { op: "local.set", index: ABS },
    { op: "local.get", index: ABS },
    { op: "local.get", index: NEG },
    { op: "local.get", index: PTR },
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: toBufIdx },
    { op: "local.set", index: POS },
    ...finalizeString(PTR, POS),
  ];
  addFunc(
    mod,
    NUMBER_TO_STRING_RUNTIME,
    [F64],
    [I32],
    [
      { name: "ptr", type: I32 },
      { name: "pos", type: I32 },
      { name: "neg", type: I32 },
      { name: "abs", type: F64 },
    ],
    body,
  );
}
