// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Finite public boundary projection, not a body semantics or prepared-emission certificate. */
export interface NativeNumberUndefinedBinaryProjection {
  readonly exports: readonly { name: string; kind: number; contract: string }[];
  readonly memories: readonly string[];
  readonly initialBytes: readonly (readonly [number, number])[];
}
interface Cursor {
  bytes: Uint8Array;
  at: number;
  end: number;
}
function fail(detail: string): never {
  throw Error(`native Number/Undefined binary: ${detail}`);
}
function byte(c: Cursor): number {
  if (c.at >= c.end) fail("truncated DATA");
  return c.bytes[c.at++]!;
}
function leb(c: Cursor, signed = false, bits = 32): bigint {
  let value = 0n,
    shift = 0n,
    last = 0;
  for (let i = 0; i < Math.ceil(bits / 7); i++) {
    last = byte(c);
    value |= BigInt(last & 127) << shift;
    shift += 7n;
    if (!(last & 128)) {
      if (signed && last & 64) value -= 1n << shift;
      const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
      const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
      if (value < min || value > max) fail("LEB bounds");
      return value;
    }
  }
  return fail("unterminated LEB");
}
function u(c: Cursor): number {
  return Number(leb(c));
}
function name(c: Cursor): string {
  const size = u(c),
    end = c.at + size;
  if (end > c.end) fail("truncated name");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(c.bytes.subarray(c.at, end));
  c.at = end;
  return text;
}
function val(c: Cursor, packed = false): number {
  const tag = byte(c);
  if (tag === 0x63 || tag === 0x64) {
    leb(c, true, 33);
    return tag;
  }
  if (
    [
      0x7f, 0x7e, 0x7d, 0x7c, 0x70, 0x6f, 0x6e, 0x6d, 0x6c, 0x6b, 0x6a, 0x69, 0x68, 0x67, 0x66, 0x65, 0x71, 0x72, 0x73,
    ].includes(tag)
  )
    return tag;
  if (packed && (tag === 0x78 || tag === 0x77)) return tag;
  return fail("unknown value type");
}
function vector<T>(c: Cursor, read: (c: Cursor) => T): T[] {
  const count = u(c);
  if (count > c.end - c.at) fail("vector count exceeds DATA");
  return Array.from({ length: count }, () => read(c));
}
function field(c: Cursor): void {
  val(c, true);
  if (byte(c) > 1) fail("field mutability");
}
function type(c: Cursor): string | undefined {
  let tag = byte(c);
  if (tag === 0x4f || tag === 0x50) {
    const supers = vector(c, u);
    if (supers.length > 1) fail("multiple supertypes");
    tag = byte(c);
  }
  if (tag === 0x60) {
    const params = vector(c, (row) => val(row)),
      results = vector(c, (row) => val(row));
    return [...params, ...results].every((row) => row >= 0x7c && row <= 0x7f)
      ? `${params.join(",")}->${results.join(",")}`
      : undefined;
  }
  if (tag === 0x5f) {
    vector(c, field);
    return undefined;
  }
  if (tag === 0x5e) {
    field(c);
    return undefined;
  }
  return fail("unknown type definition");
}
function literal(c: Cursor, width: number): string {
  if (c.at + width > c.end) fail("truncated float");
  const data = new DataView(c.bytes.buffer, c.bytes.byteOffset + c.at, width);
  const value = width === 8 ? data.getFloat64(0, true) : data.getFloat32(0, true);
  c.at += width;
  return Number.isNaN(value) ? "NaN" : Object.is(value, -0) ? "-0" : String(value);
}
function expression(c: Cursor): string | undefined {
  const values: string[] = [];
  while (true) {
    const op = byte(c);
    if (op === 0x0b) return values.length === 1 ? values[0] : undefined;
    if (op === 0x41) values.push(`i32:${leb(c, true)}`);
    else if (op === 0x42) values.push(`i64:${leb(c, true, 64)}`);
    else if (op === 0x43) values.push(`f32:${literal(c, 4)}`);
    else if (op === 0x44) values.push(`f64:${literal(c, 8)}`);
    else if (op === 0xd0) {
      leb(c, true, 33);
      values.push("ref.null");
    } else if (op === 0xfb && u(c) === 0) {
      u(c);
      values.push("struct.new");
    } else return fail("unknown constant expression");
  }
}
function limits(c: Cursor): string {
  const flags = u(c);
  if (flags !== 0 && flags !== 1) fail("non-finite memory flags");
  const min = u(c),
    max = flags ? u(c) : undefined;
  if (max !== undefined && min > max) fail("memory limits");
  return `${min}:${max ?? ""}`;
}
/** Rejects accessors/shadow/prototype buffers before any engine or decoder effects. */
export function inspectNativeNumberUndefinedBinary(binary: Uint8Array): NativeNumberUndefinedBinaryProjection {
  if (Object.getPrototypeOf(binary) !== Uint8Array.prototype) fail("byte-buffer prototype");
  for (const key of Reflect.ownKeys(binary)) {
    const d = Object.getOwnPropertyDescriptor(binary, key);
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || !d || !("value" in d)) fail("byte-buffer DATA");
  }
  if (typeof globalThis.WebAssembly?.validate !== "function" || !WebAssembly.validate(Uint8Array.from(binary)))
    fail("engine validation");
  const c: Cursor = { bytes: binary, at: 0, end: binary.length };
  if ([0, 97, 115, 109, 1, 0, 0, 0].some((expected) => byte(c) !== expected)) fail("header");
  const types: (string | undefined)[] = [],
    functions: number[] = [],
    globals: string[] = [],
    memories: string[] = [];
  const exports: { name: string; kind: number; contract: string }[] = [],
    initial = new Map<number, number>();
  const seen = new Set<number>();
  let previous = 0,
    declaredData: number | undefined,
    actualData = 0;
  while (c.at < c.end) {
    const id = byte(c),
      size = u(c),
      end = c.at + size;
    if (end > c.end) fail("section bounds");
    const section: Cursor = { bytes: binary, at: c.at, end };
    if (id !== 0) {
      const rank = id === 13 ? 5.5 : id === 12 ? 9.5 : id;
      if (seen.has(id) || rank < previous) fail("section order/duplicate");
      seen.add(id);
      previous = rank;
    }
    if (id === 0 || id === 10)
      section.at = end; // Engine validates code; custom DATA conveys no boundary authority.
    else if (id === 1) {
      const count = u(section);
      if (count > size) fail("type count");
      for (let i = 0; i < count; i++) {
        if (binary[section.at] === 0x4e) {
          byte(section);
          types.push(...vector(section, type));
        } else types.push(type(section));
      }
    } else if (id === 2 || id === 4 || id === 9 || id === 13) {
      if (u(section) !== 0) fail("nonempty import/table/element/tag domain");
    } else if (id === 3) functions.push(...vector(section, u));
    else if (id === 5) memories.push(...vector(section, limits));
    else if (id === 6) {
      const count = u(section);
      if (count > size) fail("global count");
      for (let i = 0; i < count; i++) {
        const value = val(section),
          mutable = byte(section);
        if (mutable > 1) fail("global mutability");
        const init = expression(section);
        globals.push(value >= 0x7c && value <= 0x7f && init !== undefined ? `${value}:${mutable}:${init}` : "ref");
      }
    } else if (id === 7) {
      const count = u(section);
      if (count > size) fail("export count");
      for (let i = 0; i < count; i++) {
        const text = name(section),
          kind = byte(section),
          index = u(section);
        const contract =
          kind === 0
            ? types[functions[index]!]
            : kind === 2
              ? memories[index]
              : kind === 3
                ? globals[index]
                : undefined;
        if (contract === undefined || contract === "ref" || exports.some((row) => row.name === text))
          fail("export signature/domain");
        exports.push({ name: text, kind, contract });
      }
    } else if (id === 8) fail("automatic startup outside finite contract");
    else if (id === 12) declaredData = u(section);
    else if (id === 11) {
      const count = u(section);
      if (count > size) fail("data count");
      actualData = count;
      for (let i = 0; i < count; i++) {
        if (u(section) !== 0) fail("non-active/default data");
        if (byte(section) !== 0x41) fail("nonconstant data offset");
        const offset = Number(leb(section, true));
        if (byte(section) !== 0x0b) fail("data offset expression");
        const length = u(section),
          memoryMin = Number(memories[0]?.split(":")[0]);
        if (offset < 0 || offset + length > memoryMin * 65536 || section.at + length > end) fail("data bounds");
        for (let j = 0; j < length; j++) {
          const value = byte(section);
          if (value) initial.set(offset + j, value);
          else initial.delete(offset + j);
        }
      }
    } else fail("unknown section grammar");
    if (section.at !== end) fail("unconsumed section DATA");
    c.at = end;
  }
  if (declaredData !== undefined && declaredData !== actualData) fail("declared/actual active data count");
  if (memories.length > 1 || functions.some((index) => types[index] === undefined)) {
    // Internal reference signatures are legal, but every function must still name an actual function type.
    for (const index of functions)
      if (!Number.isInteger(index) || index < 0 || index >= types.length) fail("function type reference");
    if (memories.length > 1) fail("multiple memories");
  }
  return Object.freeze({
    exports: Object.freeze(exports.sort((a, b) => a.name.localeCompare(b.name))),
    memories: Object.freeze(memories),
    initialBytes: Object.freeze([...initial].sort((a, b) => a[0] - b[0]).map((row) => Object.freeze(row))),
  });
}
