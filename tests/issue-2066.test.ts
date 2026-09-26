// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2066 — for-in visited properties deleted during enumeration.
//
// EnumerateObjectProperties (§14.7.5.10) requires that a property deleted
// before it is visited is not visited. The compiler snapshotted all keys up
// front (spec-permitted) but then indexed through the snapshot with no
// per-visit liveness re-check.
//
// Fix: retain the live object ref, register a `__for_in_has(obj, key)` host
// import (honors the WasmGC delete tombstone / `key in obj` for plain objects),
// and emit a per-visit guard at the start of the $continue block that skips
// (br to the increment) when the key has since been deleted.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function run(src: string, fn: string): Promise<string> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const io = r.importObject;
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  // Wire the exports hook so the host runtime can read struct field names
  // (the for-in key enumeration + liveness check depend on it).
  (io as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return (instance.exports as Record<string, () => string>)[fn]!();
}

describe("#2066 for-in skips properties deleted during enumeration", () => {
  it("a property deleted before it is visited is not visited", async () => {
    const src = `
export function test(): string {
  const obj: any = { a: 1, b: 2, c: 3 };
  let s = "";
  for (const k in obj) { s = s + k; if (k === "a") { delete obj.c; } }
  return s;
}`;
    expect(await run(src, "test")).toBe("ab"); // c deleted before its turn
  });

  it("deleting the current key as it is visited still visits the others up to that point", async () => {
    // delete obj[k] then read k: k is already the live binding, deletion only
    // affects later keys (which are all deleted by the time they'd be visited).
    const src = `
export function test(): string {
  const obj: any = { a: 1, b: 2, c: 3 };
  let s = "";
  for (const k in obj) { delete obj[k]; s = s + k; }
  return s;
}`;
    expect(await run(src, "test")).toBe("abc");
  });

  it("plain enumeration (no deletion) visits every own key in order", async () => {
    const src = `
export function test(): string {
  const obj: any = { x: 1, y: 2, z: 3 };
  let s = "";
  for (const k in obj) { s = s + k; }
  return s;
}`;
    expect(await run(src, "test")).toBe("xyz");
  });

  it("deleting an already-visited key does not affect the remaining enumeration", async () => {
    const src = `
export function test(): string {
  const obj: any = { a: 1, b: 2, c: 3 };
  let s = "";
  for (const k in obj) { s = s + k; if (k === "b") { delete obj.a; } }
  return s;
}`;
    expect(await run(src, "test")).toBe("abc");
  });

  it("user continue and the deletion guard coexist", async () => {
    const src = `
export function test(): string {
  const obj: any = { a: 1, b: 2, c: 3 };
  let s = "";
  for (const k in obj) { if (k === "a") { delete obj.c; continue; } s = s + k; }
  return s;
}`;
    expect(await run(src, "test")).toBe("b"); // a continued, c deleted → only b
  });

  it("break still exits the loop", async () => {
    const src = `
export function test(): string {
  const obj: any = { a: 1, b: 2, c: 3 };
  let s = "";
  for (const k in obj) { if (k === "b") break; s = s + k; }
  return s;
}`;
    expect(await run(src, "test")).toBe("a");
  });
});
