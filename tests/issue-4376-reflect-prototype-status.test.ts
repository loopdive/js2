import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(body: string): Promise<number> {
  const result = await compile(
    `export function test(): number {
    function prevent(target: any): void { Object.preventExtensions(target); }
    function update(target: any, proto: any): boolean {
      return Reflect.setPrototypeOf(target, proto);
    }
    ${body}
  }`,
    { target: "standalone", hostBridge: "always", skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  return Number(
    execFileSync(
      process.execPath,
      [
        "--experimental-wasm-exnref",
        "-e",
        "const b=require('node:fs').readFileSync(0); const e=new WebAssembly.Instance(new WebAssembly.Module(b),{}).exports; process.stdout.write(String(e.test()));",
      ],
      { input: result.binary, encoding: "utf8" },
    ),
  );
}

describe("Reflect prototype refusal status", () => {
  it("rejects a cycle without changing the prototype", async () => {
    expect(
      await run(`const a=Object.create(null), b=Object.create(a);
      return !update(a,b) && Object.getPrototypeOf(a)===null ? 1 : 0;`),
    ).toBe(1);
  });
  it("rejects a new prototype on a non-extensible object", async () => {
    expect(
      await run(`const a=Object.create(null), b=Object.create(null);
      prevent(a);
      return !update(a,b) && Object.getPrototypeOf(a)===null ? 1 : 0;`),
    ).toBe(1);
  });
  it("accepts the existing prototype on a non-extensible object", async () => {
    expect(
      await run(`const b=Object.create(null), a=Object.create(b);
      prevent(a); return update(a,b) ? 1 : 0;`),
    ).toBe(1);
  });
  it.each(["undefined", "1", "true", "'x'", "Symbol('x')"])("rejects dynamic prototype %s", async (proto) => {
    expect(
      await run(`const a=Object.create(null);
      try { update(a,${proto}); } catch(e) { return e instanceof TypeError ? 1 : -1; }
      return 0;`),
    ).toBe(1);
  });
  it("rejects dynamic null targets", async () => {
    expect(
      await run(`try { update(null,null); } catch(e) { return e instanceof TypeError ? 1 : -1; }
      return 0;`),
    ).toBe(1);
  });
});
