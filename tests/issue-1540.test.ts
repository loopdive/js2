// Issue #1540 — JSX runtime: bind _jsx/_jsxs/_Fragment as host import.
//
// Builds on #1531 (parser accepts .tsx/.jsx). TypeScript desugars JSX into
// `_jsx(type, props, key)` calls importing the runtime from
// `"react/jsx-runtime"` (or a configured jsxImportSource). Without this
// fix the import classifier silently resolved every JSX call to a no-op,
// so `<div/>` evaluated to `undefined`. With the fix:
//
//   - `import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment }
//      from "react/jsx-runtime"` is detected during preprocessImports
//   - codegen registers `__jsx_runtime_jsx` / `__jsx_runtime_jsxs` /
//     `__jsx_runtime_Fragment` host imports
//   - call sites to the recorded local names route to the matching import
//   - the runtime returns either a user-supplied `deps.jsxRuntime` binding
//     or a built-in React-shaped fallback (`{ $$typeof, type, props, key,
//     ref }`)
//
// Tests below use the pre-desugared form (`_jsx(...)`) because #1531 may
// or may not be merged into main at the time this PR lands; the surface
// we're testing here is the *runtime binding*, not the JSX-parser fix.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndRun(
  src: string,
  deps?: Record<string, unknown>,
  fileName = "x.tsx",
): Promise<{ instance: WebAssembly.Instance; exports: Record<string, Function> }> {
  const r = await compile(src, { fileName });
  if (!r.success) {
    throw new Error("compile failed: " + JSON.stringify(r.errors.slice(0, 3).map((e) => e.message)));
  }
  const imports = buildImports(r.imports ?? [], deps, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return { instance, exports: instance.exports as Record<string, Function> };
}

describe("issue #1540 — JSX runtime host binding", () => {
  it("emits __jsx_runtime_jsx import for `jsx as _jsx` from react/jsx-runtime", async () => {
    const src = `
      import { jsx as _jsx } from "react/jsx-runtime";
      export function make() { return _jsx("div", null, null); }
    `;
    const r = await compile(src, { fileName: "x.tsx" });
    expect(r.success).toBe(true);
    const jsxImports = (r.imports ?? []).filter((i) => i.name.includes("jsx"));
    expect(jsxImports.length).toBeGreaterThan(0);
    const jsxImport = jsxImports.find((i) => i.name === "__jsx_runtime_jsx");
    expect(jsxImport).toBeDefined();
    expect(jsxImport!.intent.type).toBe("jsx_runtime");
    if (jsxImport!.intent.type === "jsx_runtime") {
      expect(jsxImport!.intent.method).toBe("jsx");
      expect(jsxImport!.intent.specifier).toBe("react/jsx-runtime");
    }
  });

  it("built-in fallback produces React-shaped elements (`el.type === 'div'`)", async () => {
    const src = `
      import { jsx as _jsx } from "react/jsx-runtime";
      export function makeDiv() { return _jsx("div", null, null); }
    `;
    const { exports } = await compileAndRun(src);
    const el = (exports as any).makeDiv() as { type?: unknown; key?: unknown; $$typeof?: unknown };
    expect(el).toBeDefined();
    expect(el.type).toBe("div");
    expect(el.key).toBe(null);
    // Matches React's REACT_ELEMENT_TYPE marker so React.isValidElement
    // recognises elements produced by the built-in fallback.
    expect(el.$$typeof).toBe(Symbol.for("react.element"));
  });

  it("`_Fragment` is a stable Symbol across calls (identity holds)", async () => {
    const src = `
      import { Fragment as _Fragment, jsx as _jsx } from "react/jsx-runtime";
      export function frag1() { return _Fragment; }
      export function frag2() { return _Fragment; }
      export function fragInJsx() { return _jsx(_Fragment, null, null); }
    `;
    const { exports } = await compileAndRun(src);
    const a = (exports.frag1 as Function)();
    const b = (exports.frag2 as Function)();
    expect(a).toBe(b);
    expect(a).toBe(Symbol.for("react.fragment"));
    const el = (exports.fragInJsx as Function)() as { type?: unknown };
    expect(el.type).toBe(a);
  });

  it("user-supplied `deps.jsxRuntime` overrides the built-in fallback", async () => {
    const calls: unknown[][] = [];
    const myJsx = (type: unknown, props: unknown, key: unknown) => {
      calls.push([type, props, key]);
      return { type, key, _wasOverridden: true };
    };
    const src = `
      import { jsx as _jsx } from "react/jsx-runtime";
      export function makeDiv() { return _jsx("div", null, null); }
    `;
    const { exports } = await compileAndRun(src, { jsxRuntime: { jsx: myJsx } });
    const el = (exports as any).makeDiv() as { _wasOverridden?: boolean; type?: unknown };
    expect(el._wasOverridden).toBe(true);
    expect(el.type).toBe("div");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("div");
  });

  it("module-shaped dep via `deps[specifier]` is recognised", async () => {
    const calls: string[] = [];
    const myJsx = (type: unknown) => {
      calls.push("called");
      return { type, _viaModuleDep: true };
    };
    const src = `
      import { jsx as _jsx } from "react/jsx-runtime";
      export function makeDiv() { return _jsx("div", null, null); }
    `;
    const { exports } = await compileAndRun(src, {
      "react/jsx-runtime": { jsx: myJsx },
    });
    const el = (exports as any).makeDiv() as { _viaModuleDep?: boolean };
    expect(el._viaModuleDep).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("`_jsxs` (multi-child variant) routes to __jsx_runtime_jsxs", async () => {
    const src = `
      import { jsxs as _jsxs } from "react/jsx-runtime";
      export function make() { return _jsxs("ul", null, null); }
    `;
    const r = await compile(src, { fileName: "x.tsx" });
    expect(r.success).toBe(true);
    const jsxs = (r.imports ?? []).find((i) => i.name === "__jsx_runtime_jsxs");
    expect(jsxs).toBeDefined();
    if (jsxs && jsxs.intent.type === "jsx_runtime") {
      expect(jsxs.intent.method).toBe("jsxs");
    }
    const { exports } = await compileAndRun(src);
    const el = (exports as any).make() as { type?: unknown };
    expect(el.type).toBe("ul");
  });

  it("aliased local names (`jsx as h`) are honoured", async () => {
    const src = `
      import { jsx as h } from "react/jsx-runtime";
      export function make() { return h("span", null, null); }
    `;
    const { exports } = await compileAndRun(src);
    const el = (exports as any).make() as { type?: unknown };
    expect(el.type).toBe("span");
  });

  it("preact/jsx-runtime specifier flows through to intent", async () => {
    const src = `
      import { jsx as _jsx } from "preact/jsx-runtime";
      export function make() { return _jsx("p", null, null); }
    `;
    const r = await compile(src, { fileName: "x.tsx" });
    expect(r.success).toBe(true);
    const jsxImport = (r.imports ?? []).find((i) => i.name === "__jsx_runtime_jsx");
    expect(jsxImport).toBeDefined();
    if (jsxImport && jsxImport.intent.type === "jsx_runtime") {
      expect(jsxImport.intent.specifier).toBe("preact/jsx-runtime");
    }
  });

  it("component reference (function as `type` arg) round-trips", async () => {
    // For the built-in fallback, `el.type` should be the function reference
    // itself (an externref to the Wasm function). We can't compare directly
    // to a JS `function` value, but it must not be undefined or a string —
    // it should be a callable externref.
    const src = `
      import { jsx as _jsx } from "react/jsx-runtime";
      function MyComp() { return _jsx("span", null, null); }
      export function makeEl() { return _jsx(MyComp, null, null); }
    `;
    const { exports } = await compileAndRun(src);
    const el = (exports as any).makeEl() as { type?: unknown };
    expect(el.type).toBeDefined();
    expect(typeof el.type).not.toBe("undefined");
    // The exact representation of the function reference is implementation-defined,
    // so we only assert that it's not the literal string "div" or null.
    expect(el.type).not.toBe("div");
    expect(el.type).not.toBe(null);
  });
});
