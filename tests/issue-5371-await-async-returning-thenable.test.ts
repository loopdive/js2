// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5371) `await` of a compiled async function that RETURNS a thenable.
//
// §27.7.5.2 resolves an async function's promise capability with the return
// value, and §27.2.1.3.2 makes a thenable result ADOPT — so
// `async function w() { return hostFn(); }` must fulfil with what `hostFn()`'s
// promise resolves to, never with the promise object.
//
// An async function that genuinely suspends is drive-lowered and already
// settles through the adopting path. Every other async shape stays on the
// legacy SYNCHRONOUS pass-through, whose wasm result is the UNWRAPPED `T`. For
// `Promise<number>` that is an `f64`, so the body's `return hostFn()` — a
// Promise **externref** — was coerced `externref → f64`, i.e.
// `Number(Promise{11})` === **NaN**, and every caller's `await` read NaN.
//
// Measured on the parent (2026-09-12, host lane, untyped `.js` two-file
// project): the six thenable-returning shapes below each returned `NaN`; the
// two controls (an async function returning a plain value, and one that
// `await`s before returning) already passed. With the fix all eight pass.
//
// The carrier is the whole story: `Promise<string>` unwraps to an
// externref-carried `string`, so the identical body was already correct there —
// which is why this reproduces only for primitively-carried fulfilment types.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

// Untyped package half — a plain `.js` module, exactly the dogfood shape.
const MOD = `function hostNum() { return Promise.resolve(11); }

// 1. return a statically-settled promise
export async function fromStatic() { return Promise.resolve(7); }
// 2. return a call whose result is a host promise
export async function fromCall() { return hostNum(); }
// 3. the same value through a local binding
export async function fromLocal() { const p = hostNum(); return p; }
// 4. one thenable arm, one plain arm
export async function fromBranch(flag) { if (flag) { return hostNum(); } return 3; }
// 5. an async ARROW (no call site to mint the promise for it)
export const fromArrow = async () => hostNum();
// 6. an object-literal async METHOD
export const holder = { async m() { return hostNum(); } };

// Controls that already worked on the parent.
export async function plainValue() { return 5; }
export async function awaitedFirst() { const v = await hostNum(); return v; }
`;

const ENTRY = `import { fromStatic, fromCall, fromLocal, fromBranch, fromArrow, holder, plainValue, awaitedFirst } from "./mod.js";

export function c0(): Promise<unknown> { return fromStatic(); }
export function c1(): Promise<unknown> { return fromCall(); }
export function c2(): Promise<unknown> { return fromLocal(); }
export function c3(): Promise<unknown> { return fromBranch(true); }
export function c4(): Promise<unknown> { return fromBranch(false); }
export function c5(): Promise<unknown> { return fromArrow(); }
export function c6(): Promise<unknown> { return holder.m(); }
export function c7(): Promise<unknown> { return plainValue(); }
export function c8(): Promise<unknown> { return awaitedFirst(); }
`;

let cached: Promise<string[]> | undefined;

/** Compile + run the project once; every case reads one slot of the result. */
function settled(): Promise<string[]> {
  cached ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-5371-"));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "mod.js"), MOD);
    writeFileSync(join(root, "entry.ts"), ENTRY);
    const result = await compileProject(join(root, "entry.ts"), {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "node",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const instance = await instantiateWithRuntime(result);
    const exports = instance.exports as Record<string, () => Promise<unknown>>;
    const out: string[] = [];
    for (let i = 0; i < 9; i++) {
      // Stringify so a Promise that leaked through is legible rather than deep-equal noise.
      try {
        const value = await exports[`c${i}`]!();
        out.push(`${typeof value}:${String(value)}`);
      } catch (error) {
        out.push(`throw:${String((error as Error)?.message ?? error)}`);
      }
    }
    return out;
  })();
  return cached;
}

describe("#5371 await of a compiled async function that returns a thenable", () => {
  it("adopts a statically-settled `Promise.resolve(7)` return", async () => {
    expect((await settled())[0]).toBe("number:7");
  });

  it("adopts a host promise returned from a call", async () => {
    expect((await settled())[1]).toBe("number:11");
  });

  it("adopts a host promise returned through a local binding", async () => {
    expect((await settled())[2]).toBe("number:11");
  });

  it("adopts the thenable arm of a branching body and keeps the plain arm", async () => {
    const values = await settled();
    expect([values[3], values[4]]).toEqual(["number:11", "number:3"]);
  });

  it("adopts a thenable returned from an async ARROW", async () => {
    expect((await settled())[5]).toBe("number:11");
  });

  it("adopts a thenable returned from an object-literal async METHOD", async () => {
    expect((await settled())[6]).toBe("number:11");
  });

  // Anti-vacuity: these two shapes pass on the parent as well, so a fix that
  // merely made every async result externref would not be distinguishable
  // without them.
  it("control: an async function returning a plain value is unchanged", async () => {
    expect((await settled())[7]).toBe("number:5");
  });

  it("control: an async function that awaits before returning is unchanged", async () => {
    expect((await settled())[8]).toBe("number:11");
  });
});
