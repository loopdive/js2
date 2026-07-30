// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3617 — standalone plain-fnctor instance `.constructor` identity.
 *
 * Upstream test262's authentic `assert.throws` checks
 * `thrown.constructor === expectedErrorConstructor`. Before this fix a plain
 * `new DummyError()` used a native `$__fnctor_DummyError` struct with no
 * constructor back-pointer, so the read returned `undefined`. These probes use
 * observable runtime results and include two structurally identical empty
 * constructors to reject a type-shape classifier masquerading as identity.
 */

async function runStandalone(body: string): Promise<number> {
  const source = `
    function DummyError(this: any, message: any) {
      this.message = message;
    }
    function OtherError(this: any, message: any) {
      this.message = message;
    }
    function EmptyA(this: any) {}
    function EmptyB(this: any) {}
    function SelfAware(this: any) {
      this.linkReadyInBody = this.constructor === SelfAware;
    }
    function matches(expected: any, value: any): boolean {
      return value.constructor === expected;
    }
    function ctorIsUndefined(value: any): boolean {
      return value.constructor === undefined;
    }
    export function test(): number {
      ${body}
    }
  `;
  const result = await compile(source, { target: "standalone", nativeStrings: true });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#3617 — standalone fnctor instance constructor back-pointer", () => {
  it("matches the exact user constructor through function parameters", async () => {
    expect(
      await runStandalone(`
        var thrown: any = undefined;
        try { throw new DummyError("boom"); } catch (error) { thrown = error; }
        if (ctorIsUndefined(thrown)) return 0;
        if (!matches(DummyError, thrown)) return 0;
        if (matches(OtherError, thrown)) return 0;
        return 1;
      `),
    ).toBe(1);
  });

  it("distinguishes structurally identical empty constructor instances", async () => {
    expect(
      await runStandalone(`
        var a: any = undefined;
        var b: any = undefined;
        try { throw new EmptyA(); } catch (error) { a = error; }
        try { throw new EmptyB(); } catch (error) { b = error; }
        if (!matches(EmptyA, a) || matches(EmptyB, a)) return 0;
        if (!matches(EmptyB, b) || matches(EmptyA, b)) return 0;
        return 1;
      `),
    ).toBe(1);
  });

  it("keeps constructor off the instance's enumerable own keys", async () => {
    expect(
      await runStandalone(`
        var value: any = new DummyError("boom");
        if (value.hasOwnProperty("constructor")) return 0;
        // Closed fnctor source fields are not yet surfaced by Object.keys on
        // main; pin the zero-key baseline and ensure the hidden link adds none.
        return Object.keys(value).length === 0 ? 1 : 0;
      `),
    ).toBe(1);
  });

  it("installs the link before the user constructor body executes", async () => {
    expect(
      await runStandalone(`
        var value = new SelfAware();
        return value.linkReadyInBody ? 1 : 0;
      `),
    ).toBe(1);
  });
});
