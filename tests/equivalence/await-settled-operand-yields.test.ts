import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs } from "./helpers.js";

// #6780 — `await <settled operand>` must yield a microtask turn exactly like
// any other await: the caller resumes BEFORE the continuation runs.
async function runBoth(src: string): Promise<{ wasm: string; js: string }> {
  const wasmExports = await compileToWasm(src);
  const jsExports = evaluateAsJs(src);
  const wasm = await (wasmExports.run as () => Promise<string>)();
  const js = await (jsExports.run as () => Promise<string>)();
  return { wasm, js };
}

describe("await of a settled operand yields (#6780)", () => {
  it("`await null` in an async arrow returns to the caller first", async () => {
    const { wasm, js } = await runBoth(`
      const out: string[] = [];
      let shared = 0;
      const af = async (): Promise<number> => { shared = 1; await null; shared = 2; return shared; };
      export async function run(): Promise<string> {
        const p = af();
        out.push("after-call shared=" + shared);
        const v = await p;
        out.push("resolved v=" + v + " shared=" + shared);
        return out.join(",");
      }
    `);
    expect(js).toBe("after-call shared=1,resolved v=2 shared=2");
    expect(wasm).toBe(js);
  });

  it("sibling async functions with one `await null` interleave like JS", async () => {
    const { wasm, js } = await runBoth(`
      const out: string[] = [];
      async function af1(): Promise<void> { out.push("af1-a"); await null; out.push("af1-b"); }
      async function af2(): Promise<void> { out.push("af2-a"); await null; out.push("af2-b"); }
      async function af3(): Promise<void> { out.push("af3-a"); await null; out.push("af3-b"); }
      export async function run(): Promise<string> {
        const p1 = af1(); const p2 = af2(); const p3 = af3();
        out.push("sync-end");
        await p1; await p2; await p3;
        return out.join(",");
      }
    `);
    expect(js).toBe("af1-a,af2-a,af3-a,sync-end,af1-b,af2-b,af3-b");
    expect(wasm).toBe(js);
  });
});
