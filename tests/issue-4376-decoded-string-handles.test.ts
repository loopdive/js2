import { expect, it } from "vitest";
import { compile } from "../src/index.js";

for (const decodedExpression of [
  "decode(buffer)",
  '"prefix".slice(1,1)',
  '"prefix".slice(1,4)',
  '"xx😀YY".slice(2,4)',
]) {
  it(`looks up a string Map key by its logical contents: ${decodedExpression}`, async () => {
    const result = await compile(
      `
    const ids = new Map<any,number>();
    ids.set("", 42);
    ids.set("ref", 42);
    ids.set("😀", 42);
    const strings = new Set<string>(["", "ref", "😀"]);
    function decode(buffer:any):any {
      const bytes = new Uint8Array(buffer);
      let text = "";
      for (let i=0; i<bytes.length; i+=2)
        text += String.fromCharCode(bytes[i] + bytes[i+1]*256);
      return text;
    }
    export function run():number {
      const buffer:any = new ArrayBuffer(0);
      ids.set(buffer,99);
      ids.delete(buffer);
      const decoded:any = ${decodedExpression};
      if (typeof decoded !== "string") return -1;
      if (!strings.has(decoded)) return -2;
      return ids.get(decoded) ?? -4;
    }
  `,
      { target: "standalone", platform: "deno", hostBridge: "always", deferTopLevelInit: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = result.importObject ?? {};
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports);
    (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
    (instance.exports.__module_init as () => void)();
    expect((instance.exports.run as () => number)()).toBe(42);
  });
}
