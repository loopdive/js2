// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3176 — JSON.parse reviver abrupt completions (§25.5.1).
//
// The native InternalizeJSONProperty walk must route Proxy-backed objects and
// arrays through their existing MOP helpers.  These checks deliberately throw
// a caller-owned marker and compare identity after the Wasm boundary: an
// abrupt completion is not useful if the walk replaces the original value.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const result = await compile(src, { target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#3176 standalone JSON.parse reviver abrupt completion", () => {
  it("preserves an object defineProperty trap's thrown identity", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const marker: any = {};
        const bad: any = new Proxy({ 0: null }, { defineProperty: () => { throw marker; } });
        try {
          JSON.parse('["first", null]', function(_: any, value: any) {
            if (value === "first") this[1] = bad;
            return value;
          });
          return 0;
        } catch (error) {
          return error === marker ? 1 : 0;
        }
      }`),
    ).toBe(1);
  });

  it("preserves an array defineProperty trap's thrown identity", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const marker: any = {};
        const bad: any = new Proxy([null], { defineProperty: () => { throw marker; } });
        try {
          JSON.parse('["first", null]', function(_: any, value: any) {
            if (value === "first") this[1] = bad;
            return value;
          });
          return 0;
        } catch (error) {
          return error === marker ? 1 : 0;
        }
      }`),
    ).toBe(1);
  });

  it("preserves an object deleteProperty trap's thrown identity", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const marker: any = {};
        const bad: any = new Proxy({ a: 1 }, { deleteProperty: () => { throw marker; } });
        try {
          JSON.parse('[0, 0]', function() { this[1] = bad; });
          return 0;
        } catch (error) {
          return error === marker ? 1 : 0;
        }
      }`),
    ).toBe(1);
  });

  it("preserves an array deleteProperty trap's thrown identity", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const marker: any = {};
        const bad: any = new Proxy([0], { deleteProperty: () => { throw marker; } });
        try {
          JSON.parse('[0, 0]', function() { this[1] = bad; });
          return 0;
        } catch (error) {
          return error === marker ? 1 : 0;
        }
      }`),
    ).toBe(1);
  });

  it("preserves an ownKeys trap's thrown identity", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const marker: any = {};
        const bad: any = new Proxy({}, { ownKeys: () => { throw marker; } });
        try {
          JSON.parse('[0, 0]', function() { this[1] = bad; });
          return 0;
        } catch (error) {
          return error === marker ? 1 : 0;
        }
      }`),
    ).toBe(1);
  });

  it("preserves an array length get trap's thrown identity", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const marker: any = {};
        const bad: any = new Proxy([], { get: (_: any, name: any) => {
          if (name === "length") throw marker;
          return undefined;
        }});
        try {
          JSON.parse('[0, 0]', function() { this[1] = bad; });
          return 0;
        } catch (error) {
          return error === marker ? 1 : 0;
        }
      }`),
    ).toBe(1);
  });

  it("preserves an array length-coercion trap's thrown identity", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const marker: any = {};
        const uncoercible: any = { valueOf: () => { throw marker; } };
        const bad: any = new Proxy([], { get: (_: any, name: any) => {
          if (name === "length") return uncoercible;
          return undefined;
        }});
        try {
          JSON.parse('[0, 0]', function() { this[1] = bad; });
          return 0;
        } catch (error) {
          return error === marker ? 1 : 0;
        }
      }`),
    ).toBe(1);
  });

  it("keeps the ordinary reviver walk intact", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const value: any = JSON.parse('{"items":[1, 2]}', function(_: any, current: any) {
          return typeof current === "number" ? current + 1 : current;
        });
        return value.items[0] === 2 && value.items[1] === 3 ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
