// Issue #1531 — JSX syntax must be accepted in .tsx/.jsx input
//
// Before the fix, `compile(src, {fileName: 'x.tsx'})` rejected every JSX
// construct as a parse error because `analyzeSource` forced ScriptKind.TS
// regardless of extension and never set `compilerOptions.jsx`.
//
// This test verifies that JSX no longer triggers parse errors. Whether the
// resulting code runs end-to-end is a separate concern (#1033) — this is a
// parser-only fix.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

async function parseErrors(src: string, fileName: string): Promise<string[]> {
  const r = await compile(src, { fileName });
  if (r.success) return [];
  return (r.errors ?? []).map((e) => e.message);
}

describe("issue #1531 — JSX syntax parsing in .tsx/.jsx", () => {
  it("accepts minimal JSX element in .tsx", async () => {
    // We only care that parsing succeeds; codegen for raw _jsx calls may
    // still report missing-binding errors, but never the JSX-syntax errors
    // listed in the issue (`'>' expected`, `Unterminated regular expression
    // literal`, etc).
    const errs = await parseErrors("const el = <div>hello</div>;", "x.tsx");
    expect(errs.some((m) => /'>' expected/.test(m))).toBe(false);
    expect(errs.some((m) => /Unterminated regular expression/.test(m))).toBe(false);
    expect(errs.some((m) => /Type expected/.test(m))).toBe(false);
  });

  it("accepts a function component returning JSX in .tsx", async () => {
    const src = "function F() { return <div/>; }";
    const errs = await parseErrors(src, "comp.tsx");
    expect(errs.some((m) => /'>' expected/.test(m))).toBe(false);
    expect(errs.some((m) => /Unterminated regular expression/.test(m))).toBe(false);
    expect(errs.some((m) => /Type expected/.test(m))).toBe(false);
  });

  it("accepts JSX fragment syntax in .tsx", async () => {
    const src = "const el = <><div>a</div><div>b</div></>;";
    const errs = await parseErrors(src, "frag.tsx");
    expect(errs.some((m) => /Type expected/.test(m))).toBe(false);
    expect(errs.some((m) => /Unterminated regular expression/.test(m))).toBe(false);
  });

  it("accepts JSX inside .jsx files", async () => {
    const errs = await parseErrors("const el = <div/>;", "page.jsx");
    expect(errs.some((m) => /'>' expected/.test(m))).toBe(false);
    expect(errs.some((m) => /Unterminated regular expression/.test(m))).toBe(false);
  });

  it("desugared _jsx() call from JSX input compiles", async () => {
    // TypeScript with JsxEmit.ReactJSX desugars JSX to _jsx() calls before
    // codegen — this is the shape codegen will see. Verify the bare call
    // (no JSX syntax) still compiles in .tsx context.
    const r = await compile('const el = _jsx("div", {children: "hello"});', { fileName: "x.tsx" });
    // We don't require r.success here (the symbol _jsx is unbound), but the
    // failure must NOT be a JSX-syntax failure.
    if (!r.success) {
      const msgs = (r.errors ?? []).map((e) => e.message);
      expect(msgs.some((m) => /Unterminated regular expression/.test(m))).toBe(false);
      expect(msgs.some((m) => /'>' expected/.test(m))).toBe(false);
    }
  });

  it("does not regress .ts files (no JSX enabled)", async () => {
    // In .ts mode, `<T>x` is a type assertion. Ensure normal TS still parses.
    const r = await compile("function id<T>(x: T): T { return x; }\nexport const r = id<number>(1);", {
      fileName: "x.ts",
    });
    expect(r.success).toBe(true);
  });

  it("does not regress simple .js files", async () => {
    const r = await compile("export function add(a, b) { return a + b; }", { fileName: "x.js" });
    expect(r.success).toBe(true);
  });
});
