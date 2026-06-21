import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// (#2159 / #38) Standalone DataView offset-windowing.
//
// Before this slice, `new DataView(buffer, byteOffset, byteLength)` in
// standalone / WASI mode validated the offset/length args for RangeError but
// then discarded the window: it returned the *full* backing buffer, so every
// `dv.get/set*(i, …)` addressed byte `i` of the whole buffer (ignoring the
// base offset), and `dv.byteOffset` / `dv.byteLength` reported 0 / full-length.
//
// Fix: when the view is windowed (an explicit byteOffset or byteLength), the
// constructor wraps the shared backing buffer in a `$__dv_window`
// `{buf, byteOffset, byteLength}` struct. The native accessors add the base
// byteOffset to every byte index (so windowed writes are visible through the
// full view — true aliasing, the buffer is shared, not copied), and
// `dv.byteOffset` / `dv.byteLength` read the wrapper fields. Offset-0
// default-length views keep the bare i32_byte vec representation (no wrapper),
// so the dominant case stays fully native; the accessor + property reads accept
// both shapes via a runtime `ref.test $__dv_window` branch.
//
// Standalone native byte buffers don't marshal across the JS export boundary,
// so each case returns an i32/number the test asserts on directly.
async function runNum(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // No DataView host import may leak into the standalone module.
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  expect(labels.some((l) => /__dv_register_view|DataView_/.test(l))).toBe(false);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { t: () => number }).t();
}

describe("#38 — standalone DataView offset-windowing", () => {
  it("windowed write is visible at the correct absolute byte of the full view", async () => {
    expect(
      await runNum(`
export function t(): number {
  let buf = new ArrayBuffer(8);
  let full = new DataView(buf);
  let win = new DataView(buf, 2, 4);
  win.setUint8(0, 77);     // writes absolute byte 2 (base 2 + local 0)
  return full.getUint8(2); // the full view reads it back → 77
}`),
    ).toBe(77);
  });

  it("windowed multi-byte write aliases the parent buffer", async () => {
    expect(
      await runNum(`
export function t(): number {
  let buf = new ArrayBuffer(8);
  let full = new DataView(buf);
  let win = new DataView(buf, 4, 4);
  win.setUint16(0, 4660, false); // 0x1234 at absolute bytes 4..5 (big-endian)
  return full.getUint16(4, false);
}`),
    ).toBe(4660);
  });

  it("within-window int32 round-trips through the window", async () => {
    expect(
      await runNum(`
export function t(): number {
  let buf = new ArrayBuffer(8);
  let win = new DataView(buf, 3, 4);
  win.setInt32(0, 16909060, false); // 0x01020304
  return win.getInt32(0, false);
}`),
    ).toBe(16909060);
  });

  it("dv.byteOffset reflects the constructor argument", async () => {
    expect(
      await runNum(`
export function t(): number {
  let buf = new ArrayBuffer(8);
  let win = new DataView(buf, 3, 2);
  return win.byteOffset;
}`),
    ).toBe(3);
  });

  it("dv.byteLength reflects the explicit windowed length", async () => {
    expect(
      await runNum(`
export function t(): number {
  let buf = new ArrayBuffer(8);
  let win = new DataView(buf, 2, 4);
  return win.byteLength;
}`),
    ).toBe(4);
  });

  it("default byteLength = bufferByteLength - byteOffset", async () => {
    expect(
      await runNum(`
export function t(): number {
  let buf = new ArrayBuffer(10);
  let win = new DataView(buf, 3);
  return win.byteLength; // 10 - 3
}`),
    ).toBe(7);
  });

  it("offset-0 default-length view keeps the bare-vec fast path intact", async () => {
    expect(
      await runNum(`
export function t(): number {
  let buf = new ArrayBuffer(8);
  let dv = new DataView(buf);
  let r = 0;
  if (dv.byteOffset === 0) r = r + 1;
  if (dv.byteLength === 8) r = r + 10;
  dv.setUint8(5, 99);
  if (dv.getUint8(5) === 99) r = r + 100;
  return r;
}`),
    ).toBe(111);
  });

  it("two disjoint windows over one buffer don't clobber each other", async () => {
    expect(
      await runNum(`
export function t(): number {
  let buf = new ArrayBuffer(8);
  let a = new DataView(buf, 0, 4);
  let b = new DataView(buf, 4, 4);
  a.setUint8(0, 11);
  b.setUint8(0, 22);
  // a[0] → byte 0, b[0] → byte 4: independent
  return a.getUint8(0) * 100 + b.getUint8(0);
}`),
    ).toBe(1122);
  });
});
