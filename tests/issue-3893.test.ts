/**
 * #3893 — whole-param-default generators must route native in the standalone
 * lane instead of falling back to the eager host-buffer path.
 *
 * Every assertion here is kill-switched: with the `param.initializer` bail
 * restored in `isNativeGeneratorExpressionShape`, each compiled module leaks
 * `env::__create_generator` / `__gen_*` / `__get_caught_exception` and
 * `WebAssembly.instantiate(binary, {})` throws
 * `Import #0 "env": module is not an object or function`. Verified 2026-07-31
 * by reverting the guard and re-running: 4/4 fail, 4/4 pass restored.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

const HOST_GEN_IMPORTS = /__create_generator|__gen_create_buffer|__gen_next|__get_caught_exception/;

async function compileStandalone(src: string): Promise<Uint8Array> {
  // NOTE: `{ standalone: true }` is rejected by buildCodegenOptions (#86) — it
  // used to silently run the gc-host lane, making a "standalone" test vacuous.
  const r = (await compile(src, { fileName: "t.ts", target: "standalone" })) as unknown as {
    success: boolean;
    binary: Uint8Array;
    errors?: unknown;
  };
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  return r.binary;
}

async function runStandalone(src: string): Promise<number | undefined> {
  const binary = await compileStandalone(src);
  // Instantiating with NO imports is the assertion: a leaky module cannot.
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports as { test?: () => number }).test?.();
}

describe("#3893 standalone generators with a whole-param default", () => {
  it("emits no host generator imports", async () => {
    const binary = await compileStandalone(
      `export function test(): number {
         const g = function* ({ x }: { x: number } = { x: 23 }) { yield x; };
         return g().next().value as number;
       }`,
    );
    const text = new TextDecoder("utf-8", { fatal: false }).decode(binary);
    expect(text.match(HOST_GEN_IMPORTS)).toBeNull();
  });

  it("applies the default when the argument is omitted", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const g = function* ({ x }: { x: number } = { x: 23 }) { yield x; };
           return g().next().value as number;
         }`,
      ),
    ).toBe(23);
  });

  it("skips the default when an argument is supplied", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const g = function* ({ x }: { x: number } = { x: 23 }) { yield x; };
           return g({ x: 7 }).next().value as number;
         }`,
      ),
    ).toBe(7);
  });

  it("supports a plain identifier param default", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const g = function* (a: number = 9) { yield a; };
           return g().next().value as number;
         }`,
      ),
    ).toBe(9);
  });

  /**
   * The ordering assertion is the one that matters for spec conformance:
   * [[Call]] runs FunctionDeclarationInstantiation (§10.2.11 — parameter
   * defaults evaluate here) and only THEN EvaluateGeneratorBody (§27.5)
   * creates the generator object. So the default MUST fire when `g()` is
   * called, before any `next()`, while the body must NOT run until `next()`.
   * #3032 is the precedent for the body-runs-early violation.
   */
  it("evaluates the default at call time, without running the body", async () => {
    const got = await runStandalone(
      `let calls = 0;
       let bodyRan = 0;
       function mk(): { x: number } { calls = calls + 1; return { x: 5 }; }
       export function test(): number {
         const g = function* ({ x }: { x: number } = mk()) { bodyRan = 1; yield x; };
         const it = g();
         const afterCreate = calls * 10 + bodyRan; // expect 10: default ran, body did not
         const v = it.next().value as number;
         return afterCreate * 100 + v * 10 + bodyRan;
       }`,
    );
    // afterCreate=10 (calls=1, bodyRan=0) · v=5 · bodyRan=1 after next()
    expect(got).toBe(1051);
  });
});
