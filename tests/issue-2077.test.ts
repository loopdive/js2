// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2077 — standalone: reading a caught Error's `.message` / `.name`.
 *
 * `catch (e)` binds `e` as `any`, so the static-typed `$Error` field-read fast
 * path in `property-access.ts` never fired and the read fell through to the
 * generic `__extern_get` host path — unavailable standalone, so it returned
 * null and `e.message` trapped (null deref); `e.name` on a TypeError read
 * "[object Object]".
 *
 * Fix: for a `catch`-clause binding under `--target standalone`/`wasi`, emit a
 * runtime `ref.test $Error`-guarded read (cast + struct.get + coerce to the
 * native string ref), mirroring the standalone instanceof guard.
 *
 * CRITICAL: the guard is scoped to a `catch` binding ONLY. A regression in the
 * first attempt hijacked EVERY `any.message`/`any.name` read, so a plain
 * `const o: any = { message: "x" }` read its field through the Error guard and
 * the non-Error `else` arm returned a null string → `o.message.length` trapped.
 * The catch-binding gate keeps plain-object reads on their working generic path.
 *
 * Values are read IN wasm (returned as numbers/booleans): a native-string ref
 * returned to JS reads as undefined, so the assertions compute lengths /
 * content-equality inside the module.
 */

async function runStandalone(source: string): Promise<unknown> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2077 — standalone caught-Error field reads", () => {
  it("caught Error's .message is the thrown message (was null-deref trap)", async () => {
    const got = await runStandalone(`
      export function test(): number {
        try { throw new Error("msg1"); }
        catch (e: any) { const m: string = e.message; return m === "msg1" ? 1 : 0; }
      }`);
    expect(got).toBe(1); // node: "msg1"
  });

  it("caught Error's .message has the right length", async () => {
    const got = await runStandalone(`
      export function test(): number {
        try { throw new Error("msg1"); }
        catch (e: any) { const m: string = e.message; return m.length; }
      }`);
    expect(got).toBe(4);
  });

  it("caught TypeError's .name is 'TypeError' (was '[object Object]')", async () => {
    const got = await runStandalone(`
      export function test(): number {
        try { throw new TypeError("x"); }
        catch (e: any) { const n: string = e.name; return n === "TypeError" ? 1 : 0; }
      }`);
    expect(got).toBe(1); // node: "TypeError"
  });

  it("caught TypeError's .name has length 9", async () => {
    const got = await runStandalone(`
      export function test(): number {
        try { throw new TypeError("x"); }
        catch (e: any) { const n: string = e.name; return n.length; }
      }`);
    expect(got).toBe(9);
  });

  it("instanceof on the caught value is unchanged", async () => {
    const got = await runStandalone(`
      export function test(): number {
        try { throw new TypeError("x"); }
        catch (e: any) { return (e instanceof TypeError && e instanceof Error) ? 1 : 0; }
      }`);
    expect(got).toBe(1);
  });

  // --- regression guards: plain-object `any.message`/`any.name` must NOT be
  // hijacked by the Error-struct guard (they read through the generic path). ---

  it("plain-object any.message reads the object's own field (not the Error guard)", async () => {
    const got = await runStandalone(`
      export function test(): number {
        const o: any = { message: "hello", name: "obj" };
        const m: string = o.message;
        return m.length;
      }`);
    expect(got).toBe(5); // "hello" — was a null-deref trap under the over-broad guard
  });

  it("plain-object any.message content-equals its value", async () => {
    const got = await runStandalone(`
      export function test(): number {
        const o: any = { message: "hello" };
        const m: string = o.message;
        return m === "hello" ? 1 : 0;
      }`);
    expect(got).toBe(1);
  });

  it("plain-object any.name reads the object's own field", async () => {
    const got = await runStandalone(`
      export function test(): number {
        const o: any = { name: "Bob" };
        const n: string = o.name;
        return n.length;
      }`);
    expect(got).toBe(3);
  });

  // --- non-Error throws / rethrow unaffected ---

  it("throw of a bare string is unaffected", async () => {
    const got = await runStandalone(`
      export function test(): number {
        try { throw "boom"; } catch (e: any) { const s: string = e; return s === "boom" ? 1 : 0; }
      }`);
    expect(got).toBe(1);
  });

  it("throw of a number is unaffected", async () => {
    const got = await runStandalone(`
      export function test(): number {
        try { throw 42; } catch (e: any) { return (e as number) === 42 ? 1 : 0; }
      }`);
    expect(got).toBe(1);
  });

  it("rethrow preserves the Error's message", async () => {
    const got = await runStandalone(`
      export function test(): number {
        try { try { throw new Error("inner"); } catch (e) { throw e; } }
        catch (e2: any) { const m: string = e2.message; return m === "inner" ? 1 : 0; }
      }`);
    expect(got).toBe(1);
  });
});
