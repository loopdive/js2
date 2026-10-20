// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { BUILTIN_BRAND_TABLE } from "../src/runtime/contracts/builtin-brands.js";

const TIMEOUT = 90_000;
const SYMBOL_SEEDER = `__nativeproto_seed_${BUILTIN_BRAND_TABLE.Symbol}`;
const SYMBOL_METHOD = `__proto_method_${BUILTIN_BRAND_TABLE.Symbol}_`;

function functionNames(module: WebAssembly.Module): Set<string> {
  const sections = WebAssembly.Module.customSections(module, "name");
  expect(sections).toHaveLength(1);
  const bytes = new Uint8Array(sections[0]);
  const names = new Set<string>();
  const indices = new Set<number>();
  let offset = 0;
  let limit = bytes.length;
  const readU32 = (): number => {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      if (offset >= limit) throw new Error("truncated name-section integer");
      const byte = bytes[offset++];
      if (shift === 28 && (byte & 0xf0) !== 0) throw new Error("overflowing name-section integer");
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value >>> 0;
    }
    throw new Error("invalid name-section integer");
  };
  while (offset < bytes.length) {
    limit = bytes.length;
    const subsection = bytes[offset++];
    const size = readU32();
    const end = offset + size;
    if (end > bytes.length) throw new Error("truncated name subsection");
    limit = end;
    if (subsection === 1) {
      const count = readU32();
      for (let i = 0; i < count; i++) {
        const index = readU32();
        if (indices.has(index)) throw new Error("duplicate function-name index");
        indices.add(index);
        const length = readU32();
        if (offset + length > end) throw new Error("truncated function name");
        names.add(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, offset + length)));
        offset += length;
      }
      expect(offset).toBe(end);
    }
    offset = end;
  }
  expect(names.size).toBeGreaterThan(0);
  return names;
}

async function probe(source: string): Promise<{ value: number; names: Set<string> }> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "symbol-seeder-demand.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const names = functionNames(module);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as { __module_init?: () => void; readResult: () => number };
  exports.__module_init?.();
  return { value: exports.readResult(), names };
}

function expectSymbolMethods(names: Set<string>): void {
  expect(names.has(SYMBOL_SEEDER)).toBe(true);
  expect(names.has(`${SYMBOL_METHOD}valueOf`)).toBe(true);
  expect(names.has(`${SYMBOL_METHOD}toString`)).toBe(true);
}

describe("#6770 standalone Symbol prototype seeder demand", () => {
  it(
    "descriptor-only undefined @@toPrimitive keeps ordinary numeric conversion throwing",
    async () => {
      // No prototype value read is added to arm the reflective-read seeder gate.
      // This isolates the original number-hint assertion from later string/key assertions.
      const result = await probe(`var __r = 0;
Object.defineProperty(Symbol.prototype, Symbol.toPrimitive, { value: undefined });
try { var numeric = +Object(Symbol()); if (numeric === numeric) __r |= 8; } catch (error) { if (error instanceof TypeError) __r |= 1; }
__r |= 2;
export function readResult() { return __r; }
`);
      expect(result.value).toBe(3);
      expectSymbolMethods(result.names);
    },
    TIMEOUT,
  );

  it(
    "descriptor-only null @@toPrimitive keeps the original first numeric assertion throwing",
    async () => {
      const result = await probe(`var __r = 0;
Object.defineProperty(Symbol.prototype, Symbol.toPrimitive, { value: null });
try { var numeric = +Object(Symbol()); if (numeric === numeric) __r |= 8; } catch (error) { if (error instanceof TypeError) __r |= 1; }
__r |= 2;
export function readResult() { return __r; }
`);
      expect(result.value).toBe(3);
      expectSymbolMethods(result.names);
    },
    TIMEOUT,
  );

  it(
    "untouched Symbol intrinsic valueOf, toString and numeric rejection stay unchanged",
    async () => {
      const result = await probe(`var __r = 0;
var symbol = Symbol("seed");
if (symbol.valueOf() === symbol) __r |= 1;
if (symbol.toString() === "Symbol(seed)") __r |= 2;
try { var numeric = +symbol; if (numeric === numeric) __r |= 8; } catch (error) { if (error instanceof TypeError) __r |= 4; }
export function readResult() { return __r; }
`);
      expect(result.value).toBe(7);
    },
    TIMEOUT,
  );

  it(
    "a program with no Symbol prototype demand emits no Symbol seeder or prototype methods",
    async () => {
      const result = await probe(`var __r = 6 * 7;
export function readResult() { return __r; }
`);
      expect(result.value).toBe(42);
      // The guest contains no Symbol/prototype operation. These are actual function-name
      // absence checks, rather than an inference from an omitted global-name subsection.
      expect(result.names.has(SYMBOL_SEEDER)).toBe(false);
      expect([...result.names].some((name) => name.startsWith(SYMBOL_METHOD))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "unrelated nonreflective Number, Boolean and String wrapper behavior stays unchanged",
    async () => {
      const result = await probe(`var __r = 0;
var number = Object(12);
var boolean = Object(true);
var string = Object("ok");
if (number.valueOf() === 12) __r |= 1;
if (boolean.valueOf() === true) __r |= 2;
if (string.valueOf() === "ok") __r |= 4;
if (Number("13") === 13 && Boolean(0) === false && String(45) === "45") __r |= 8;
export function readResult() { return __r; }
`);
      expect(result.value).toBe(15);
    },
    TIMEOUT,
  );
});
