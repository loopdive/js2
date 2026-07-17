// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3331 — the #2106 $undefined-singleton null-guard bug class (4th instance:
 * Map/WeakMap get-miss). Guards:
 *   1. Map/WeakMap `.get(missingKey) === undefined` — typed, any-receiver and
 *      WeakMap lanes (the regression this PR fixes);
 *   2. stored `null` stays distinct from a miss;
 *   3. an `undefined` LITERAL element reads back as `undefined` with
 *      `has === true`;
 *   4. the miss-path A/B battery patterns that were already correct stay
 *      correct (spot subset — the audit's full battery lives in the issue).
 * All run under the DEFAULT regime (singleton ON for standalone).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts", target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#3331 — Map/WeakMap miss values under the $undefined singleton regime", () => {
  it("typed Map.get(miss) === undefined", async () => {
    expect(
      await run(`export function test(): number {
  const m = new Map<string, number>(); m.set("k", 1);
  const v: any = m.get("zz"); return v === undefined ? 1 : 0; }`),
    ).toBe(1);
  });

  it("any-receiver Map.get(miss) === undefined", async () => {
    expect(
      await run(`export function test(): number {
  const m: any = new Map(); m.set("k", 1);
  return m.get("zz") === undefined ? 1 : 0; }`),
    ).toBe(1);
  });

  it("WeakMap.get(miss) === undefined", async () => {
    expect(
      await run(`export function test(): number {
  const wm: any = new WeakMap(); const k: any = {};
  return wm.get(k) === undefined ? 1 : 0; }`),
    ).toBe(1);
  });

  it("stored null stays null (distinct from miss)", async () => {
    expect(
      await run(`export function test(): number {
  const m: any = new Map(); m.set("k", null);
  return m.get("k") === null && m.get("zz") === undefined ? 1 : 0; }`),
    ).toBe(1);
  });

  it("stored undefined LITERAL reads back undefined with has === true", async () => {
    expect(
      await run(`export function test(): number {
  const m: any = new Map(); m.set("k", undefined); let n = 0;
  if (m.get("k") === undefined) n += 1;
  if (m.has("k")) n += 2;
  return n === 3 ? 1 : 0; }`),
    ).toBe(1);
  });

  it("clear() returns undefined (dispatch lane)", async () => {
    expect(
      await run(`export function test(): number {
  const m: any = new Map(); m.set("a", 1);
  return m.clear() === undefined && !m.has("a") ? 1 : 0; }`),
    ).toBe(1);
  });

  it("miss-path battery spot set stays green (property/gopd/in/destructure)", async () => {
    expect(
      await run(`export function test(): number {
  const o: any = { a: undefined, b: 2 }; let n = 0;
  if (o.zz === undefined) n += 1;
  if ("a" in o && !("zz" in o)) n += 2;
  if (Object.getOwnPropertyDescriptor(o, "zz") === undefined) n += 4;
  const { a = 5, zz = 6 } = o;
  if (a === 5 && zz === 6) n += 8;
  return n === 15 ? 1 : 0; }`),
    ).toBe(1);
  });
});
