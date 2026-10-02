// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

it.each(["queueMicrotask", "coreQueue"])(
  "shares a primordial binding when the core declaration is named %s",
  async (coreName) => {
    const result = await compileMulti(
      {
        "/staged/entry.ts": `
const primordials:any = {};
function script0():void {
  (() => {
    let queueMicrotask = undefined;
    Object.defineProperty(primordials, "queueMicrotask", { get() { return queueMicrotask; } });
    primordials.setQueueMicrotask = (value) => {
      if (queueMicrotask !== undefined) throw new Error("queueMicrotask is already defined");
      queueMicrotask = value;
    };
  })();
}
function script3():void {
  (() => {
    const { setQueueMicrotask } = primordials;
    function ${coreName}() { return 42; }
    setQueueMicrotask(${coreName});
  })();
}
export function run():number {
  script0();
  if (primordials.queueMicrotask !== undefined) return -1;
  script3();
  if (typeof primordials.queueMicrotask !== "function") return -2;
  return primordials.queueMicrotask();
}
`,
      },
      "/staged/entry.ts",
      { target: "standalone", platform: "deno", skipSemanticDiagnostics: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
    try {
      expect((instance.exports.run as () => number)()).toBe(42);
    } catch (error: any) {
      if (error.getArg && instance.exports.__exn_render_prepare) {
        const payload = error.getArg(instance.exports.__exn_tag, 0);
        const length = (instance.exports.__exn_render_prepare as (payload: unknown) => number)(payload);
        const char = instance.exports.__exn_render_char as (index: number) => number;
        throw new Error(Array.from({ length }, (_, index) => String.fromCharCode(char(index))).join(""));
      }
      throw error;
    }
  },
);
