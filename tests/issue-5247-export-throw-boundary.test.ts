// #5247 — an uncaught compiled `throw` must reach the HOST as the error
// itself, not as the `WebAssembly.Exception` that carried it.
//
// BASE (measured 2026-09-06, both lanes): every uncaught throw arrived as
// `[object WebAssembly.Exception]` with `instanceof Error === false` and
// `name`/`message` `undefined`. The payload was already the host-native Error —
// #5226 proved a wasm `catch` receives it by identity — the host just never saw
// past the wrapper. That is why the fix is at the EXPORT boundary and not at
// the provider seam.
//
// The rows below are chosen to pin the two properties that could plausibly
// break while the headline one is fixed:
//
//   - `caught*` — a throw the module catches ITSELF must keep matching by tag.
//     The wrapper is out-of-line for exactly this reason: wrapping the exported
//     body in place would convert its throw into a JS exception, and an
//     intra-module `catch $__exn` would stop matching it.
//   - `thrownString` — the payload crosses by IDENTITY, so a non-Error throw
//     must arrive unchanged rather than re-minted as an Error.
//
// The LINKED lane is covered by tests/issue-5226-provider-error-identity.test.ts
// (its `hostBoundary` row, flipped by this issue), which also pins the property
// a linked provider depends on: a provider's exports are deliberately NOT
// wrapped, since they are wasm→wasm call targets and unwrapping them would undo
// #5226.
//
// Measured bound, unchanged by this fix: an uncaught `throw { ... }` of a
// compiled OBJECT LITERAL still reaches the host as an opaque WasmGC struct
// (`[object Object]`, fields unreadable). That is the generic compiled-object
// marshalling gap — the same struct is opaque when merely RETURNED — not an
// exception-boundary one, so no row here asserts against it.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SRC = `
export function throwRange(): number {
  throw new RangeError("range-x");
}
export function throwType(): number {
  throw new TypeError("type-x");
}
export function throwPlain(): number {
  throw new Error("plain-x");
}
export function thrownString(): number {
  throw "bare-string" as any;
}
export function noThrow(k: number): number {
  return k + 1;
}
export function caughtLocally(): string {
  try {
    throwRange();
  } catch (e: any) {
    return (e instanceof RangeError ? "RE" : "no-RE") + "|" + String(e && e.message);
  }
  return "no-throw";
}
export function caughtFinally(): string {
  let seen = "none";
  try {
    try {
      throwType();
    } finally {
      seen = "finally";
    }
  } catch (e: any) {
    return seen + "|" + (e instanceof TypeError ? "TE" : "no-TE");
  }
  return "no-throw";
}
`;

async function instantiate(): Promise<Record<string, unknown>> {
  const result = await compile(SRC);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  expect(result.success).toBe(true);
  const imports = result.importObject as WebAssembly.Imports & {
    __setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
  imports.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance.exports as unknown as Record<string, unknown>;
}

/** Read what the HOST actually catches, with no unwrapping of our own. */
function hostThrow(exports: Record<string, unknown>, name: string): unknown {
  try {
    (exports[name] as () => unknown)();
    return "no-throw";
  } catch (error) {
    return error;
  }
}

describe("#5247 — an uncaught throw crosses the export boundary intact", () => {
  it("delivers the thrown Error by identity, with its subclass and message", { timeout: 300_000 }, async () => {
    const exports = await instantiate();

    const range = hostThrow(exports, "throwRange") as RangeError;
    // Base: `[object WebAssembly.Exception]`, instanceof false, name/message undefined.
    expect(range).toBeInstanceOf(RangeError);
    expect(range).toBeInstanceOf(Error);
    expect({ name: range.name, message: range.message }).toEqual({ name: "RangeError", message: "range-x" });

    const type = hostThrow(exports, "throwType") as TypeError;
    expect(type).toBeInstanceOf(TypeError);
    expect(type.message).toBe("type-x");

    const plain = hostThrow(exports, "throwPlain") as Error;
    expect(plain).toBeInstanceOf(Error);
    expect(plain.constructor).toBe(Error);
    expect(plain.message).toBe("plain-x");
  });

  it("crosses a non-Error throw unchanged rather than re-minting one", { timeout: 300_000 }, async () => {
    const exports = await instantiate();
    // The payload is handed over by identity, so a primitive throw must arrive
    // as that primitive — not wrapped in an Error and not stringified. Base:
    // `[object WebAssembly.Exception]`.
    expect(hostThrow(exports, "thrownString")).toBe("bare-string");
  });

  it("leaves a throw the module catches ITSELF matching by tag", { timeout: 300_000 }, async () => {
    const exports = await instantiate();
    // Anti-regression for the in-place-wrapping design that was rejected: these
    // catches are intra-module and must still see the wasm exception.
    expect((exports.caughtLocally as () => string)()).toBe("RE|range-x");
    expect((exports.caughtFinally as () => string)()).toBe("finally|TE");
  });

  it("does not disturb an export that returns normally", { timeout: 300_000 }, async () => {
    const exports = await instantiate();
    expect((exports.noThrow as (k: number) => number)(41)).toBe(42);
  });
});
