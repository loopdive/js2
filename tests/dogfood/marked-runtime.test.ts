// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Marked's renderer/tokenizer objects are ordinary compiled WasmGC classes.
// A dynamic property read can expose one through a host proxy before a later
// `any`-typed call. Keep that path on the generated class-member discriminator
// instead of treating the proxy as an ordinary JavaScript object.

import { describe, expect, it } from "vitest";

import { compile } from "../../src/index.js";
import { buildImports, instantiateWasm, wrapExports } from "../../src/runtime.js";

describe("marked generic class-method bridge", () => {
  it("dispatches a WasmGC renderer method after a dynamic field read", async () => {
    const result = await compile(
      `
        class Renderer {
          space(_value: any): string { return "ok"; }
        }
        class Parser {
          renderer: any;
          constructor() { this.renderer = new Renderer(); }
        }
        function getRenderer(parser: any): any { return parser.renderer; }
        function invoke(renderer: any): string { return renderer.space("x"); }
        export function runCase(): string {
          return invoke(getRenderer(new Parser()));
        }
      `,
      { fileName: "marked-runtime-probe.ts", skipSemanticDiagnostics: true, target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(
      result.binary,
      imports.env,
      imports.string_constants,
      imports.string_constants16,
    );
    imports.setExports?.(instance.exports as Record<string, Function>);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });

    expect((exports.runCase as () => string)()).toBe("ok");
  });

  it("copies static rule fields through a module-initializer object spread", async () => {
    const result = await compile(
      `
        const newline = /^(?:[ \\t]*(?:\\n|$))+/;
        const code = /^ {4}[^\\n]+/;
        const blockNormal = { newline, code };
        const blockGfm = { ...blockNormal, paragraph: /^[^\\n]+/ };
        const rules = { block: blockGfm };

        class Tokenizer {
          rules: any;
          constructor() { this.rules = rules; }
          space(src: string): string {
            return this.rules.block.newline.exec(src)?.[0] ?? "missing";
          }
        }

        export function runCase(): string {
          return new Tokenizer().space("\\ntext");
        }
      `,
      { fileName: "marked-spread-probe.ts", skipSemanticDiagnostics: true, target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(
      result.binary,
      imports.env,
      imports.string_constants,
      imports.string_constants16,
    );
    imports.setExports?.(instance.exports as Record<string, Function>);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });

    expect((exports.runCase as () => string)()).toBe("\n");
  });

  it("keeps an inline token array raw across a closed method dispatcher", async () => {
    const result = await compile(
      `
        class Lexer {
          blockTokens(src: string, tokens: any[] = [], _top = false): any[] {
            tokens.push(src);
            return tokens;
          }
        }

        class Tokenizer {
          lexer: any;
          constructor() { this.lexer = new Lexer(); }
          run(): string { return this.lexer.blockTokens("ok", [])[0]; }
        }

        export function runCase(): string {
          return new Tokenizer().run();
        }
      `,
      { fileName: "marked-vec-argument-probe.ts", skipSemanticDiagnostics: true, target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(
      result.binary,
      imports.env,
      imports.string_constants,
      imports.string_constants16,
    );
    imports.setExports?.(instance.exports as Record<string, Function>);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });

    expect((exports.runCase as () => string)()).toBe("ok");
  });

  it("concatenates strings for compound assignment to an inferred token field", async () => {
    const result = await compile(
      `
        export function runCase(): string {
          const token = { type: "list", raw: "" };
          token.raw += "- one\\n";
          token.raw += "- two\\n";
          return token.raw;
        }
      `,
      { fileName: "marked-token-raw-probe.ts", skipSemanticDiagnostics: true, target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(
      result.binary,
      imports.env,
      imports.string_constants,
      imports.string_constants16,
    );
    imports.setExports?.(instance.exports as Record<string, Function>);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });

    expect((exports.runCase as () => string)()).toBe("- one\n- two\n");
  });

  it("preserves reference records across a dynamic helper and iterates conditional split rows", async () => {
    const result = await compile(
      `
        function makeReference(match, entry) {
          const href = entry.href;
          const title = entry.title || null;
          const text = match[1].replace(/x/g, "x");
          return {
            type: match[0].charAt(0) === "!" ? "image" : "link",
            raw: match[0],
            href,
            title,
            text,
            tokens: [text],
          };
        }

        function resolveReference(links, tag) {
          const match = /^\\[(x)\\]$/.exec("[x]");
          const direct = makeReference(match, { href: "direct", title: "Direct" });
          if (tag === "direct") return direct.href + "|" + direct.title;
          const entry = links[tag.toLowerCase()];
          if (!entry) return "missing";
          const reference = makeReference(match, entry);
          return reference.href + "|" + (reference.title || "missing");
        }

        function renderDirectReference() {
          const match = /^\\[(x)\\]$/.exec("[x]");
          const reference = makeReference(match, {
            href: "https://example.test/direct",
            title: "Direct",
          });
          return reference.href + "|" + reference.title;
        }

        export function referenceCase() {
          const links = Object.create(null);
          const tag = "ref";
          links[tag] || (links[tag] = { href: "https://example.test/ref", title: "Reference" });
          return renderDirectReference() + ";" + resolveReference(links, "REF");
        }

        function buildTable() {
          const match = /^(head)\\n([:-]+)\\n((?:.*\\n?)*)$/.exec("head\\n---\\na\\nb");
          const rows = match[3]?.trim() ? match[3].replace(/x/g, "").split("\\n") : [];
          const table = { rows: [] };
          for (const row of rows) table.rows.push([row]);
          return table;
        }

        export function tableCase() {
          return buildTable().rows.length;
        }
      `,
      { fileName: "marked-residual-carrier-probe.js", skipSemanticDiagnostics: true, target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(
      result.binary,
      imports.env,
      imports.string_constants,
      imports.string_constants16,
    );
    imports.setExports?.(instance.exports as Record<string, Function>);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });

    expect((exports.referenceCase as () => string)()).toBe(
      "https://example.test/direct|Direct;https://example.test/ref|Reference",
    );
    expect((exports.tableCase as () => number)()).toBe(2);
  });

  it("preserves a definition record stored through an array expando", async () => {
    const result = await compile(
      `
        class Lexer {
          tokens;
          constructor() {
            this.tokens = [];
            this.tokens.links = Object.create(null);
          }
          lex() {
            const definition = { tag: "ref", href: "https://example.test/ref", title: "Reference" };
            this.tokens.links[definition.tag] ||
              (this.tokens.links[definition.tag] = { href: definition.href, title: definition.title });
            return this.tokens;
          }
        }

        function resolve(tokens) {
          const entry = tokens.links["ref"];
          return entry.href + "|" + entry.title;
        }

        export function runCase() {
          return resolve(new Lexer().lex());
        }
      `,
      { fileName: "marked-array-expando-probe.js", skipSemanticDiagnostics: true, target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(
      result.binary,
      imports.env,
      imports.string_constants,
      imports.string_constants16,
    );
    imports.setExports?.(instance.exports as Record<string, Function>);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });

    expect((exports.runCase as () => string)()).toBe("https://example.test/ref|Reference");
  });

  it("preserves nested row vectors across a table token record", async () => {
    const result = await compile(
      `
        function splitRow(row, align) {
          return row.split("|").map((value, index) => ({
            text: value.trim(),
            align: align[index],
          }));
        }

        class Tokenizer {
          table(source) {
            const lines = source.trim().split("\\n");
            const token = { type: "table", align: ["left", "right"], rows: [] };
            if (lines.length === 2) {
              for (const line of lines) token.rows.push(splitRow(line, token.align));
              return token;
            }
          }
        }

        class Renderer {
          table(token) {
            let output = "";
            for (const row of token.rows) {
              for (const cell of row) output += "[" + cell.text + ":" + cell.align + "]";
            }
            return output;
          }
        }

        export function runCase() {
          return new Renderer().table(new Tokenizer().table("a|b\\nc|d"));
        }
      `,
      { fileName: "marked-table-row-probe.js", skipSemanticDiagnostics: true, target: "gc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(
      result.binary,
      imports.env,
      imports.string_constants,
      imports.string_constants16,
    );
    imports.setExports?.(instance.exports as Record<string, Function>);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });

    expect((exports.runCase as () => string)()).toBe("[a:left][b:right][c:left][d:right]");
  });
});
