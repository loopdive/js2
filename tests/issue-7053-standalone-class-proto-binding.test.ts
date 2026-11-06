// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7053 (from #7019) — `C.prototype` is typed as the INSTANCE `C`; on
// `--target standalone` its value is a `$Object` (#3976). A slot typed from the
// checker therefore guard-cast it to `ref.null $C`. #6767 withdrew that for a
// call-site-inferred PARAMETER spelled `C.prototype`; the binding forms were
// still lossy: `const prototype = this.prototype` (static method), and passing
// that binding on. axios `AxiosHeaders.accessor([...])` runs at module init and
// threw "Object method called on null or undefined" from
// `Object.defineProperty(prototype, …)`. Every `was ✗` failed on the parent;
// the control must keep answering 0.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function runStandalone(files: Record<string, string>): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-7053-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), source);
  }
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    runtimeEvalProvider: false,
  } as Parameters<typeof compileProject>[1]);
  expect(result.errors.filter((e) => e.severity === "error").map((e) => e.message)).toEqual([]);
  expect(result.success).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance.exports as unknown as Record<string, () => unknown>;
}

describe("#7053 bindings holding C.prototype", () => {
  it("keep the prototype object instead of a null instance-struct slot", async () => {
    const ex = await runStandalone({
      "u.js": `function build(obj, name) {
  Object.defineProperty(obj, "get" + name, { value: function () { return 7; }, configurable: true });
}
class H {
  get(x) { return x; }
  static fromThisArg() { build(this.prototype, "A"); return 1; }
  static fromLocal() { const p = this.prototype; build(p, "B"); return 1; }
  static localIsNull() { const p = this.prototype; return p === null || p === undefined ? 1 : 0; }
  static accessor(names) {
    const prototype = this.prototype;
    function define(n) { build(prototype, n); }
    names.forEach(define);
    return this;
  }
}
H.accessor(["Init"]);
export default H;
`,
      "entry.ts": `import H from "./u.js";
export function initRan(): number { const p: any = H.prototype; return typeof p.getInit === "function" ? 1 : 0; }
export function fromThisArg(): number { H.fromThisArg(); const p: any = H.prototype; return p.getA(); }
export function fromLocal(): number { H.fromLocal(); const p: any = H.prototype; return p.getB(); }
export function localIsNull(): number { return H.localIsNull(); }
export function unknownAbsent(): number { const p: any = H.prototype; return typeof p.getNope === "function" ? 1 : 0; }
`,
    });
    expect(ex.initRan()).toBe(1); // was ✗ (module init threw)
    expect(ex.fromThisArg()).toBe(7); // was ✗
    expect(ex.fromLocal()).toBe(7); // was ✗
    expect(ex.localIsNull()).toBe(0); // was ✗ (slot nulled by the guard-cast)
    expect(ex.unknownAbsent()).toBe(0); // control
  });
});
