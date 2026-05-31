import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStr(src: string): Promise<string> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE:" + (r.errors?.[0]?.message ?? "?"));
  const imports = buildImports(r.imports, undefined, r.stringPool, {});
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports.test as () => string)();
}

async function runI32(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE:" + (r.errors?.[0]?.message ?? "?"));
  const imports = buildImports(r.imports, undefined, r.stringPool, {});
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports.test as () => number)();
}

describe("#1638 Date.prototype string formatters", () => {
  it("toISOString formats epoch correctly", async () => {
    expect(await runStr(`export function test(): string { return new Date(0).toISOString(); }`)).toBe(
      "1970-01-01T00:00:00.000Z",
    );
  });

  it("toISOString formats an arbitrary timestamp", async () => {
    const t = 1700000000000;
    expect(await runStr(`export function test(): string { return new Date(${t}).toISOString(); }`)).toBe(
      new Date(t).toISOString(),
    );
  });

  it("toUTCString uses the spec UTCString format (Www, DD Mmm YYYY HH:mm:ss GMT)", async () => {
    expect(await runStr(`export function test(): string { return new Date(0).toUTCString(); }`)).toBe(
      "Thu, 01 Jan 1970 00:00:00 GMT",
    );
  });

  it("toDateString returns 'Www Mmm DD YYYY'", async () => {
    expect(await runStr(`export function test(): string { return new Date(0).toDateString(); }`)).toBe(
      "Thu Jan 01 1970",
    );
  });

  it("toTimeString returns the time + timezone part", async () => {
    expect(await runStr(`export function test(): string { return new Date(0).toTimeString(); }`)).toBe(
      "00:00:00 GMT+0000 (Coordinated Universal Time)",
    );
  });

  it("toString combines date and time parts", async () => {
    expect(await runStr(`export function test(): string { return new Date(0).toString(); }`)).toBe(
      "Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)",
    );
  });

  it("formatters return 'Invalid Date' for an invalid Date", async () => {
    expect(await runStr(`export function test(): string { return new Date(NaN).toString(); }`)).toBe("Invalid Date");
    expect(await runStr(`export function test(): string { return new Date(NaN).toUTCString(); }`)).toBe("Invalid Date");
    expect(await runStr(`export function test(): string { return new Date(NaN).toDateString(); }`)).toBe(
      "Invalid Date",
    );
  });

  it("toISOString throws RangeError on an invalid Date", async () => {
    expect(
      await runI32(
        `export function test(): number { try { new Date(NaN).toISOString(); return 0; } catch (e) { return e instanceof RangeError ? 1 : 2; } }`,
      ),
    ).toBe(1);
  });

  it("toJSON returns null for an invalid Date, ISO for a valid one", async () => {
    expect(
      await runI32(
        `export function test(): number { const d: Date = new Date(NaN); return d.toJSON() === null ? 1 : 0; }`,
      ),
    ).toBe(1);
    expect(await runStr(`export function test(): string { const d: Date = new Date(0); return d.toJSON(); }`)).toBe(
      "1970-01-01T00:00:00.000Z",
    );
  });

  it("does not regress getTime / getHours / setHours (the `in`-operator fix)", async () => {
    expect(await runI32(`export function test(): number { return new Date(0).getTime() === 0 ? 1 : 0; }`)).toBe(1);
    expect(
      await runI32(`export function test(): number { const d = new Date(0); d.setHours(5); return d.getHours(); }`),
    ).toBe(5);
  });
});
