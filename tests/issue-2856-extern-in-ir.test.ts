// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2856 — extern-in-IR: host-global member access (document/console) through
// the IR front-end, JS-host lane only.
//
// Covers:
//   1. Selector claims: a function whose only "exotic" content is host-global
//      member access (document.*, console.log) is IR-claimed in JS-host mode.
//   2. Wasm validity: extern method calls pad OPTIONAL args to the host
//      import's fixed arity (`createElement(tag, options?)` imports as a
//      3-slot call) — the un-padded form failed Wasm validation with "not
//      enough arguments on the stack" (caught by the #2856 parity probe).
//   3. Runtime parity: IR-on and IR-off compiles produce identical observable
//      behavior (console output / same failure mode) for host-global code.
//   4. Standalone/host-free deferral: the capability gate keeps these
//      functions on the legacy path (no claim), preserving the existing
//      refusal behavior — never a bare host import without a fallback.

import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { makeIrHostGlobalResolver } from "../src/ir/host-extern.js";
import { buildTypeMap } from "../src/ir/propagate.js";

const DOM_SRC = `
export function el(tag: string, css: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  return e;
}
export function main(): void {
  const host = document.body;
  host.innerHTML = "";
  const box = el("div", "display:none");
  host.appendChild(box);
}
`;

const CONSOLE_SRC = `
export function greet(n: number): number {
  console.log("value=" + n.toString());
  return n + 1;
}
`;

function selectWithHostExterns(src: string, jsHost: boolean): Set<string> {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  };
  const baseHost = ts.createCompilerHost(options, true);
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.ES2022, true);
  const host: ts.CompilerHost = {
    ...baseHost,
    getSourceFile: (name, lv, ...rest) => (name === "t.ts" ? sf : baseHost.getSourceFile(name, lv, ...rest)),
    writeFile: () => {},
  };
  const program = ts.createProgram(["t.ts"], options, host);
  const checker = program.getTypeChecker();
  const selection = planIrCompilation(
    sf,
    {
      experimentalIR: true,
      trackFallbacks: true,
      jsHostExterns: jsHost,
      resolveHostGlobal: makeIrHostGlobalResolver(checker),
    },
    buildTypeMap(sf, checker),
  );
  return selection.funcs;
}

describe("#2856 extern-in-IR: host-global member access", () => {
  it("selector claims document-using functions in JS-host mode", () => {
    const funcs = selectWithHostExterns(DOM_SRC, true);
    expect(funcs.has("el")).toBe(true);
    expect(funcs.has("main")).toBe(true);
  });

  it("selector defers host-global functions when jsHostExterns is off (capability gate)", () => {
    const funcs = selectWithHostExterns(DOM_SRC, false);
    expect(funcs.has("el")).toBe(false);
    expect(funcs.has("main")).toBe(false);
  });

  it("compiles document member access to VALID Wasm with optional-arg padding", async () => {
    const r = await compile(DOM_SRC, { fileName: "t.ts" });
    expect(r.success).toBe(true);
    // WebAssembly.Module validates eagerly — the un-padded extern.call
    // regression fails here with "not enough arguments on the stack".
    expect(() => new WebAssembly.Module(r.binary!)).not.toThrow();
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary!)).map((i) => i.name);
    // The IR lowering must reuse the SAME legacy import surface — no new
    // bare host imports (dual-mode rule).
    expect(imports).toContain("global_document");
    expect(imports).toContain("Document_createElement");
    expect(imports).toContain("Document_get_body");
  });

  it("console.log lowers through the legacy variant import and matches legacy output", async () => {
    const outputs: Record<string, string[]> = {};
    for (const ir of [true, false]) {
      const r = await compile(CONSOLE_SRC, { fileName: "t.ts", experimentalIR: ir });
      expect(r.success).toBe(true);
      const logs: string[] = [];
      const imp = r.importObject as unknown as Record<string, Record<string, unknown>>;
      for (const ns of Object.keys(imp)) {
        for (const k of Object.keys(imp[ns]!)) {
          if (k.startsWith("console_log")) {
            const orig = imp[ns]![k] as (...a: unknown[]) => unknown;
            imp[ns]![k] = (...a: unknown[]) => {
              logs.push(`${k}:${a.map(String).join(",")}`);
              return orig?.(...a);
            };
          }
        }
      }
      const { instance } = await WebAssembly.instantiate(r.binary!, imp as unknown as WebAssembly.Imports);
      (imp as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
      const greet = instance.exports.greet as (n: number) => number;
      expect(greet(41)).toBe(42);
      outputs[ir ? "ir" : "legacy"] = logs;
    }
    expect(outputs.ir).toEqual(outputs.legacy);
    expect(outputs.ir!.length).toBeGreaterThan(0);
  });

  it("standalone mode keeps the legacy refusal path (no host-extern claim, no leaked import)", async () => {
    // The capability gate defers under standalone: compile must not leak an
    // unsatisfiable env.global_document import from the IR path. Whatever
    // the legacy standalone behavior is (clean CE refusal or graceful
    // compile), the IR-on and IR-off results must agree.
    const [irOn, irOff] = await Promise.all([
      compile(DOM_SRC, { fileName: "t.ts", target: "standalone", experimentalIR: true } as never),
      compile(DOM_SRC, { fileName: "t.ts", target: "standalone", experimentalIR: false } as never),
    ]);
    expect(irOn.success).toBe(irOff.success);
    if (irOn.success && irOff.success) {
      const names = (b: Uint8Array) => WebAssembly.Module.imports(new WebAssembly.Module(b)).map((i) => i.name);
      expect(names(irOn.binary!)).toEqual(names(irOff.binary!));
    }
  });
});
