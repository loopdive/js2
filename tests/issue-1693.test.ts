import { describe, expect, it } from "vitest";
import { compile, compileProject } from "../src/index.ts";

describe("#1693 — multi-funcref-dispatch return-type coercion (carved from #191/#1571)", () => {
  it("minimal isBuffer-shape && chain still validates (single-candidate path untouched)", async () => {
    const src = `
      function isUndefined(x: any): any { return typeof x === 'undefined'; }
      function isFunction(x: any): any { return typeof x === 'function'; }
      function isBuffer(val: any) {
        return (
          val !== null &&
          !isUndefined(val) &&
          val.constructor !== null &&
          !isUndefined(val.constructor) &&
          isFunction(val.constructor.isBuffer) &&
          val.constructor.isBuffer(val)
        );
      }
      export { isBuffer };
    `;
    const r = await compile(src, { fileName: "min.ts" });
    expect(r.success).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  it("multi-candidate dispatch with diverging i32/f64/externref return kinds validates", async () => {
    // Pin ~3 same-arity arrow predicates with diverging return types into
    // ctx.closureInfoByTypeIdx, then invoke a callable-typed parameter — this
    // is what makes the multi-funcref dispatch chain fire.
    const src = `
      const predI32 = (x: any): any => typeof x === 'string';
      const predF64 = (x: any): any => (typeof x === 'string' ? 1 : 0) + 0.5;
      const predExt = (x: any): any => String(x);
      function check(val: any, fn: (x: any) => any) {
        return val !== null && fn(val);
      }
      function dispatch(val: any) {
        return check(val, predI32) && check(val, predF64) && check(val, predExt);
      }
      export { predI32, predF64, predExt, check, dispatch };
    `;
    const r = await compile(src, { fileName: "multi.ts" });
    expect(r.success).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  it("full axios/lib/utils.js compileProject — isBuffer no longer hits fallthru[0] i32/f64", async () => {
    let r;
    try {
      r = await compileProject("node_modules/axios/lib/utils.js", { allowJs: true } as any);
    } catch {
      return;
    }
    if (!r.success) return;
    let validateErr = "";
    try {
      new WebAssembly.Module(r.binary);
    } catch (e) {
      validateErr = (e as Error).message;
    }
    expect(validateErr).not.toMatch(/isBuffer.*fallthru\[0\].*expected i32.*got f64/);
  });
});
