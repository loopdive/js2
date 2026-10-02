import { expect, it } from "vitest";
import { compile } from "../src/index.js";

for (const expression of ["+value", "value.valueOf()", "throw thrown;"]) {
  it(`retains a thrown object in an envelope: ${expression}`, async () => {
    const result = await compile(
      `
    const thrown:any = { marker: 73 };
    const source:any = { valueOf():any { throw thrown; } };
    const values:any[] = [undefined, source];
    function envelope(id:number):any {
      const value:any = values[id];
      try { ${expression.startsWith("throw") ? expression : `return [true, ${expression}];`} }
      catch (error) { return [false, error]; }
    }
    export function run():number {
      const result:any = envelope(1);
      return result[0] === false && result[1] === thrown ? 73 : 0;
    }
  `,
      { target: "standalone", platform: "deno", hostBridge: "always", deferTopLevelInit: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = result.importObject ?? {};
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports);
    (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
    (instance.exports.__module_init as () => void)();
    expect((instance.exports.run as () => number)()).toBe(73);
  });
}

it("does not invoke conversion on an untaken numeric read", async () => {
  const result = await compile(
    `
    let calls = 0;
    const source:any = { valueOf():number { calls++; return 42; } };
    export function run(take:number):number {
      let value:any = 0;
      value = source;
      if (take) return +value;
      return calls;
    }
  `,
    { target: "standalone", deferTopLevelInit: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const imports = result.importObject ?? {};
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports);
  (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
  (instance.exports.__module_init as () => void)();
  const run = instance.exports.run as (take: number) => number;
  expect(run(0)).toBe(0);
  expect(run(1)).toBe(42);
  expect(run(0)).toBe(1);
});
