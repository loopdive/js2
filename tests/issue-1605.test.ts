import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compilesToValidWasm(src: string): Promise<boolean> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
  if (!r.success || r.errors.some((e) => e.severity === "error")) return false;
  return WebAssembly.validate(r.binary);
}

describe("#1605 — class setter assignment via prototype / class object", () => {
  it("instance setter write through C.prototype emits valid wasm (var-close scope)", async () => {
    const src = `
      var probe;
      class C {
        set a(_ = null) {
          var x = 'inside';
          probe = function() { return x; };
        }
      }
      C.prototype.a = null;
    `;
    expect(await compilesToValidWasm(src)).toBe(true);
  });

  it("static setter write through class object emits valid wasm", async () => {
    const src = `
      var probe;
      class C {
        static set a(_ = null) {
          var x = 'inside';
          probe = function() { return x; };
        }
      }
      C.a = null;
    `;
    expect(await compilesToValidWasm(src)).toBe(true);
  });

  it("setter with null default and no body var emits valid wasm", async () => {
    expect(await compilesToValidWasm(`class C { set a(_ = null) {} } C.prototype.a = null;`)).toBe(true);
  });
});
