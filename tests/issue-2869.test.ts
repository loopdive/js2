import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";
import { instantiateWasm } from "../src/runtime-instantiate.ts";

// #2869 — destructuring with a member-expression assignment target
// (`[x.y] = vals`, `{ k: x.y } = src`, `for ([x.y] of …)`). Before this fix the
// write to `x.y` was DROPPED (`emitAssignToTarget` early-returned on a non-static
// struct field) for the array path, and the member-set dispatch baked into the
// DETACHED destructure body buffer desynced by one funcIdx when a later in-window
// late import shifted the defined-function table (the `need 3 got 2` invalid-Wasm
// / runtime-recursion symptom on a plain `{}`).
//
// The fix (architect Direction 1):
//   1. emitAssignToTarget falls through to the #2664 member-set dispatcher
//      (`__set_member_<name>` → `__extern_set_strict` terminal) for a dynamic
//      member target, instead of dropping the write.
//   2. The detached destructure buffers (arrDestructInstrsADA / destructInstrsDA /
//      odflInstrs / adflInstrs) are registered with `ctx.liveBodies` for their
//      compile window, so `shiftLateImportIndices` + `fixupModuleGlobalIndices`
//      repoint the already-emitted dispatch `call` in lockstep (#2567/#1109).
//   3. The for-of / for-await typed (tuple/vec/object) paths route member targets
//      through the same dispatcher (they emit into the LIVE loop body, no buffer
//      hazard); for-await is fixed transitively.

async function run(src: string, target?: "standalone"): Promise<unknown> {
  const r = (await compile(src, target ? ({ target, fileName: "test.ts" } as never) : { fileName: "test.ts" })) as {
    success: boolean;
    errors?: { message?: string }[];
    binary: Uint8Array;
    imports: unknown[];
    stringPool?: string[];
  };
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const built = buildImports(r.imports as never, undefined, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
  built.setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

const wrap = (body: string) => `export function test(): number {\n${body}\n}`;

describe("#2869 member-expression assignment-target destructuring", () => {
  // ── assignment-expression: array element member target ────────────────────
  it("array elem member target writes the slot — `[x.y] = [4]` (headline)", async () => {
    expect(await run(wrap(`const x: any = {}; [x.y] = [4]; return x.y === 4 ? 1 : 100 + (x.y | 0);`))).toBe(1);
  });

  it("multiple member targets — `[x.y, x.z] = [1, 2]`", async () => {
    expect(
      await run(
        wrap(`const x: any = {}; [x.y, x.z] = [1, 2];
              if (x.y !== 1) return 100 + (x.y | 0);
              if (x.z !== 2) return 200 + (x.z | 0);
              return 1;`),
      ),
    ).toBe(1);
  });

  it("mixed identifier + member targets, no drop — `[z, x.y] = [1, 2]`", async () => {
    expect(
      await run(
        wrap(`const x: any = {}; let z = 0; [z, x.y] = [1, 2];
              if (z !== 1) return 100 + z;
              if (x.y !== 2) return 200 + (x.y | 0);
              return 1;`),
      ),
    ).toBe(1);
  });

  // The heterogeneous pattern is what exposed the funcIdx desync: the first
  // member target reserves `__set_member_y` + pulls `__extern_set_strict` and the
  // union helpers (a real late-import shift); the second reserves
  // `__set_member_b`. The first dispatch `call`, baked into the detached buffer,
  // must survive the second reserve's shift — it does, because the buffer is in
  // ctx.liveBodies. Pre-fix this produced `need 3 got 2` invalid Wasm.
  it("heterogeneous member targets pull late imports mid-loop — `[z, x.y, a.b] = [10,20,30]`", async () => {
    expect(
      await run(
        wrap(`const x: any = {}; const a: any = {}; let z = 0; [z, x.y, a.b] = [10, 20, 30];
              if (z !== 10) return 100 + z;
              if (x.y !== 20) return 200 + (x.y | 0);
              if (a.b !== 30) return 300 + (a.b | 0);
              return 1;`),
      ),
    ).toBe(1);
  });

  // ── assignment-expression: object property member target ──────────────────
  it("object property member target — `({ a: x.y } = src)`", async () => {
    expect(
      await run(
        wrap(`const x: any = {}; const src = { a: 7 }; ({ a: x.y } = src);
              return x.y === 7 ? 1 : 100 + (x.y | 0);`),
      ),
    ).toBe(1);
  });

  // ── member target WITH default initializer (the `*-init` cluster) ─────────
  it("member target with default, value present — `[x.y = 42] = [7]`", async () => {
    expect(await run(wrap(`const x: any = {}; [x.y = 42] = [7]; return x.y === 7 ? 1 : 100 + (x.y | 0);`))).toBe(1);
  });

  it("member target with default, source empty → default fires — `[x.y = 42] = []`", async () => {
    expect(
      await run(
        wrap(`const x: any = {}; const e: number[] = []; [x.y = 42] = e; return x.y === 42 ? 1 : 100 + (x.y | 0);`),
      ),
    ).toBe(1);
  });

  // ── deeper member receiver / non-numeric value ───────────────────────────
  // The receiver itself is a member expression (`obj.inner`), so the dispatcher
  // resolves a nested base before the strict set. (Accessor-setter invocation on
  // a defineProperty `set` is a separate pre-existing runtime gap — plain
  // `o.y = v` does not invoke it either — so it is NOT asserted here; the
  // destructure write routes through the SAME strict `__extern_set_strict`
  // terminal as a plain member set, which is the spec-relevant property.)
  it("nested member receiver — `[obj.inner.y] = [5]`", async () => {
    expect(
      await run(
        wrap(
          `const obj: any = {}; obj.inner = {}; [obj.inner.y] = [5]; return obj.inner.y === 5 ? 1 : 100 + (obj.inner.y | 0);`,
        ),
      ),
    ).toBe(1);
  });

  it("member target with a string value — `[x.y] = ['hi']`", async () => {
    expect(await run(wrap(`const x: any = {}; [x.y] = ['hi']; return x.y === 'hi' ? 1 : 100;`))).toBe(1);
  });

  it("object pattern, two member targets — `({ a: x.y, b: x.z } = src)`", async () => {
    expect(
      await run(
        wrap(`const x: any = {}; const src = { a: 1, b: 2 }; ({ a: x.y, b: x.z } = src);
              if (x.y !== 1) return 100 + (x.y | 0);
              if (x.z !== 2) return 200 + (x.z | 0);
              return 1;`),
      ),
    ).toBe(1);
  });

  // ── for-of: typed tuple / vec / object element, member target ─────────────
  it("for-of tuple member target — `for ([x.y] of [[4], [5]])`", async () => {
    expect(
      await run(wrap(`const x: any = {}; for ([x.y] of [[4], [5]]) {} return x.y === 5 ? 1 : 100 + (x.y | 0);`)),
    ).toBe(1);
  });

  it("for-of object member target — `for ({ a: x.y } of [{a:11},{a:22}])`", async () => {
    expect(
      await run(
        wrap(
          `const x: any = {}; for ({ a: x.y } of [{ a: 11 }, { a: 22 }]) {} return x.y === 22 ? 1 : 100 + (x.y | 0);`,
        ),
      ),
    ).toBe(1);
  });

  it("for-of mixed identifier + member target — `for ([z, x.y] of [[1,2],[3,4]])`", async () => {
    expect(
      await run(
        wrap(`const x: any = {}; let z = 0; for ([z, x.y] of [[1, 2], [3, 4]]) {}
              if (z !== 3) return 100 + z;
              if (x.y !== 4) return 200 + (x.y | 0);
              return 1;`),
      ),
    ).toBe(1);
  });

  // ── for-await (shares compileForOfAssignDestructuring → fixed transitively) ─
  it("for-await member target — `for await ([x.y] of [[4],[5]])`", async () => {
    expect(
      await run(
        `export async function testAsync(): Promise<number> {
           const x: any = {};
           for await ([x.y] of [[4], [5]]) {}
           return x.y === 5 ? 1 : 100 + (x.y | 0);
         }
         export function test(): number { return 1; }`,
      ),
    ).toBe(1);
  });

  // ── standalone (pure Wasm, native $Object store via __extern_set_strict) ───
  it("standalone: array elem member target — `[x.y] = [4]`", async () => {
    expect(
      await run(wrap(`const x: any = {}; [x.y] = [4]; return x.y === 4 ? 1 : 100 + (x.y | 0);`), "standalone"),
    ).toBe(1);
  });

  it("standalone: object property member target — `({ a: x.y } = src)`", async () => {
    expect(
      await run(
        wrap(`const x: any = {}; const src = { a: 7 }; ({ a: x.y } = src); return x.y === 7 ? 1 : 100 + (x.y | 0);`),
        "standalone",
      ),
    ).toBe(1);
  });

  it("standalone: for-of vec member target — `for ([x.y] of [[4],[5]])`", async () => {
    expect(
      await run(
        wrap(`const x: any = {}; for ([x.y] of [[4], [5]]) {} return x.y === 5 ? 1 : 100 + (x.y | 0);`),
        "standalone",
      ),
    ).toBe(1);
  });

  // ── regression controls: plain identifier / plain member set / object subset ─
  it("control: plain identifier array destructure still works — `[a] = [5]`", async () => {
    expect(await run(wrap(`let a = 0; [a] = [5]; return a === 5 ? 1 : 100 + a;`))).toBe(1);
  });

  it("control: plain `x.y = 4` member assignment still works", async () => {
    expect(await run(wrap(`const x: any = {}; x.y = 4; return x.y === 4 ? 1 : 100 + (x.y | 0);`))).toBe(1);
  });

  it("control: object-pattern externref subset still works — `{ a, b } = o`", async () => {
    expect(await run(wrap(`const o = { a: 3, b: 4 }; const { a, b } = o; return a === 3 && b === 4 ? 1 : 100;`))).toBe(
      1,
    );
  });
});
