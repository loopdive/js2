// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4161 — standalone: the define appliers accept a CLOSURE receiver.
//
// `Object.defineProperty(fn, k, desc)` previously hit the appliers' lenient
// terminal no-op and stored NOTHING (while `fn.k = v` round-tripped through the
// #3468 side-table bag). The appliers now substitute the closure's bag for the
// receiver and fall through into their unchanged `$Object` path — including the
// #2042-S4 ValidateAndApplyPropertyDescriptor preflight — and the two #1906
// `__defineProperties` gates admit the closure halves (O closure carrier;
// closure `Properties` map enumerated via its bag).
//
// Harvested from fork PR #4124's #3979 slice; see plan/issues/4161-….md for
// what of that slice was already superseded on main and deliberately dropped.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const standaloneOpts = {
  fileName: "test.ts",
  emitWat: false,
  skipSemanticDiagnostics: true,
  target: "standalone" as const,
};

async function run(src: string): Promise<number> {
  const r = await compile(src, standaloneOpts);
  expect(r.success).toBe(true);
  expect(r.errors.filter((e) => e.severity === "error")).toEqual([]);
  // Standalone must stay host-free: an import here means the module could not
  // instantiate in the real lane, and any assertion below would be vacuous.
  const mod = await WebAssembly.compile(r.binary);
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#4161 — Object.defineProperty on a function receiver defines into the closure bag", () => {
  it("data descriptor: value lands and is visible to read / hasOwnProperty / gOPD", async () => {
    expect(
      await run(`export function test(): number {
  const fn: any = function () {};
  Object.defineProperty(fn, "p", { value: 12, enumerable: true, writable: true, configurable: true });
  if (fn.p !== 12) return 2;
  if (!fn.hasOwnProperty("p")) return 3;
  const d = Object.getOwnPropertyDescriptor(fn, "p");
  if (d === undefined || d.value !== 12) return 4;
  return 1;
}`),
    ).toBe(1);
  });

  it("accessor descriptor: the getter is installed and fires on read", async () => {
    expect(
      await run(`export function test(): number {
  const fn: any = function () {};
  let hits = 0;
  Object.defineProperty(fn, "q", { get: function () { hits = hits + 1; return 7; }, configurable: true });
  if (fn.q !== 7) return 2;
  if (hits !== 1) return 3;
  return 1;
}`),
    ).toBe(1);
  });

  it("the #2042-S4 preflight now RUNS for closure receivers (invalid redefine throws)", async () => {
    expect(
      await run(`export function test(): number {
  const fn: any = function () {};
  Object.defineProperty(fn, "p", { value: 1, configurable: false });
  let threw = 0;
  try {
    Object.defineProperty(fn, "p", { value: 2, configurable: false });
  } catch (e) {
    threw = 1;
  }
  return threw === 1 ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("define → delete → hasOwn cycle stays coherent with #4010 S2/S3", async () => {
    expect(
      await run(`export function test(): number {
  const fn: any = function () {};
  Object.defineProperty(fn, "p", { value: 3, configurable: true, enumerable: true });
  if (fn.p !== 3) return 2;
  if (!(delete fn.p)) return 3;
  if (fn.hasOwnProperty("p")) return 4;
  if (fn.p !== undefined) return 5;
  return 1;
}`),
    ).toBe(1);
  });

  it("GUARD (−684 family): a builtin function's own `name` descriptor is untouched", async () => {
    expect(
      await run(`export function test(): number {
  const f: any = Object.defineProperty;
  const d = Object.getOwnPropertyDescriptor(f, "name");
  if (d === undefined) return 2;
  if (d.value !== "defineProperty") return 3;
  if (d.configurable !== true) return 4;
  return 1;
}`),
    ).toBe(1);
  });
});

describe("#4161 — the #1906 defineProperties gates admit the closure halves", () => {
  it("a FUNCTION `Properties` map is enumerated via its bag", async () => {
    expect(
      await run(`export function test(): number {
  const props: any = function () {};
  props.a = { value: 5, enumerable: true };
  const o: any = {};
  Object.defineProperties(o, props);
  return o.a === 5 ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("a closure O receiver is admitted and the define lands on it", async () => {
    expect(
      await run(`export function test(): number {
  const fn: any = function () {};
  Object.defineProperties(fn, { x: { value: 9, enumerable: true } });
  return fn.x === 9 ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("a bagless FUNCTION `Properties` map is the spec no-op, not a throw", async () => {
    expect(
      await run(`export function test(): number {
  const props: any = function () {};
  const o: any = {};
  Object.defineProperties(o, props);
  return 1;
}`),
    ).toBe(1);
  });

  it("SCOPE PIN: an ARRAY `Properties` map still refuses loudly (bag not authoritative for vecs)", async () => {
    expect(
      await run(`export function test(): number {
  const props: any = [1];
  const o: any = {};
  let threw = 0;
  try { Object.defineProperties(o, props); } catch (e) { threw = 1; }
  return threw;
}`),
    ).toBe(1);
  });
});
