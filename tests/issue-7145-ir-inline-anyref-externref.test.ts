// #7145 — `console.log(m.get("a"))` on the native-first gc profile: the IR
// inliner splices `__map_get` (result anyref) as a `block (result anyref)`
// straight into the externref `console_log_externref` import. The late
// call-arg repair only coerces a bare `call` producer, so the block left the
// operand uncoerced and the module failed validation. The console lowering now
// retags an abstract GC ref (`anyref`/`eqref`) with `extern.convert_any` itself.
import { describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

// The differential corpus program `builtins/03-map-set.js`, reduced to the
// failing statement (one `.get`, so `__map_get` stays a single-caller inline).
const MODULE_SRC = `const m = new Map();
m.set("a", 1);
console.log(m.get("a"));
`;

/** Each `call` to the externref console import must be fed an externref. */
function consoleCallOperands(wat: string): string[] {
  const lines = wat.split("\n").map((l) => l.trim());
  const funcImports = lines.filter((l) => l.startsWith("(import ") && l.includes("(func "));
  const idx = funcImports.findIndex((l) => l.includes('"console_log_externref"'));
  expect(idx, "console_log_externref import").toBeGreaterThanOrEqual(0);
  const preceding: string[] = [];
  for (let i = 1; i < lines.length; i++) if (lines[i] === `call ${idx}`) preceding.push(lines[i - 1]!);
  return preceding;
}

describe("#7145 inlined anyref result coerced to the externref console import", () => {
  it("gc native-first: validates, no anyref block feeds the import, prints 1", async () => {
    const r = await compile(MODULE_SRC, { fileName: "03-map-set.js", deferTopLevelInit: true, emitWat: true });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    // The inliner still fires (the case this pins) …
    expect(r.wat).toContain("(block (result anyref)");
    // … and every operand of the externref import is retagged first.
    const operands = consoleCallOperands(r.wat!);
    expect(operands.length).toBe(1);
    expect(operands).toEqual(["extern.convert_any"]);

    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      const built = buildImports(r.imports, {}, r.stringPool);
      const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
      built.setInstance?.(instance);
      (instance.exports.__module_init as () => void)();
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual(["1"]);
  });

  it("gc and standalone: the same statement inside a function compiles to valid wasm", async () => {
    const src = `export function test(): number {
  const m = new Map();
  m.set("a", 1);
  console.log(m.get("a"));
  return m.size;
}`;
    for (const target of [undefined, "standalone"] as const) {
      const r = await compile(src, { fileName: "probe.ts", ...(target ? { target } : {}) });
      expect(r.success, `${target ?? "gc"}: ${r.errors.map((e) => e.message).join("\n")}`).toBe(true);
      expect(WebAssembly.validate(r.binary), target ?? "gc").toBe(true);
    }
  });
});
