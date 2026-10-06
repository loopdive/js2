// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";
import { fnInstanceNameOf } from "../src/codegen/function-instance-meta.js";
import { ts } from "../src/ts-api.js";

const FORMS = [
  ["anonymous declaration", "export default function () { return 23; }", "default"],
  ["named declaration", "export default function sourceName() { return 23; }", "sourceName"],
  ["anonymous generator declaration", "export default function* () { yield 23; }", "default"],
  ["named generator declaration", "export default function* sourceName() { yield 23; }", "sourceName"],
  ["anonymous expression", "export default (function () { return 23; });", "default"],
  ["named expression", "export default (function sourceName() { return 23; });", "sourceName"],
  ["anonymous generator expression", "export default (function* () { yield 23; });", "default"],
  ["named generator expression", "export default (function* sourceName() { yield 23; });", "sourceName"],
  ["parenthesized arrow", "export default (((() => 23)));", "default"],
  ["comma expression", "export default (0, function () { return 23; });", ""],
  ["call expression", "function factory() { return function () { return 23; }; } export default factory();", ""],
  ["identifier expression", "const bound = function () { return 23; }; export default bound;", "bound"],
  ["assignment expression", "let bound; export default (bound = function () { return 23; });", "bound"],
] as const;

async function run(files: Record<string, string>, target: "gc" | "standalone" | "wasi"): Promise<number> {
  const compiled = await compileMulti(files, "./entry.js", {
    allowJs: true,
    skipSemanticDiagnostics: true,
    emitWat: false,
    target,
  });

  expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(compiled.binary);
  if (target !== "gc") expect(WebAssembly.Module.imports(module)).toEqual([]);
  const imports = compiled.importObject ?? {};
  const instance = new WebAssembly.Instance(module, imports);
  (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  (instance.exports._start as (() => void) | undefined)?.();
  return (instance.exports.test as () => number)();
}

describe("#5157 default-export function name metadata", () => {
  it("preserves the synthesized Function constructor name", () => {
    const file = ts.createSourceFile("<eval>.ts", "function __new_function_1() {}", ts.ScriptTarget.ESNext, true);
    const declaration = file.statements.find(ts.isFunctionDeclaration);
    expect(declaration).toBeDefined();
    expect(fnInstanceNameOf(declaration!)).toBe("anonymous");
  });
  it.each(FORMS)("%s keeps the definition's name", (_label, source, expected) => {
    const file = ts.createSourceFile("dep.js", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    let definition: ts.Node | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
        if (!ts.isFunctionDeclaration(node) || node.name?.text !== "factory") definition = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(definition).toBeDefined();
    expect(fnInstanceNameOf(definition!)).toBe(expected);
  });

  for (const target of ["standalone"] as const) {
    describe(target, () => {
      it.each(FORMS)("%s agrees across imported, bracket and descriptor reads", async (_label, source, name) => {
        const invoke = source.includes("function*") ? "fn().next().value" : "fn()";
        expect(
          await run(
            {
              "./dep.js": source,
              "./entry.js": `import fn from "./dep.js";
            export function test() {
              if (${invoke} !== 23) return 90;
              if (fn.name !== ${JSON.stringify(name)}) return 91;
              if (fn["name"] !== ${JSON.stringify(name)}) return 92;
              const d = Object.getOwnPropertyDescriptor(fn, "name");
              if (d === undefined || d.value !== ${JSON.stringify(name)}) return 93;
              if (d.writable !== false || d.enumerable !== false || d.configurable !== true) return 94;
              if (!Object.prototype.hasOwnProperty.call(fn, "name")) return 95;
              const keys = Object.getOwnPropertyNames(fn);
              let ownName = false;
              for (let index = 0; index < keys.length; index++) if (keys[index] === "name") ownName = true;
              if (!ownName) return 96;
              return 1;
            }`,
            },
            target,
          ),
        ).toBe(1);
      });

      it("preserves aliases, re-exports, escaped values and initialization count", async () => {
        expect(
          await run(
            {
              "./dep.js": `export let initialized = 0; initialized++;
            export default (function sourceName() { return 23; });`,
              "./bridge.js": `export { default as forwarded, initialized } from "./dep.js";`,
              "./entry.js": `import imported from "./dep.js";
            import { default as alias } from "./dep.js";
            import { forwarded, initialized } from "./bridge.js";
            const escaped = imported;
            function read(value) { return value.name; }
            export function test() {
              if (imported !== alias || alias !== forwarded || forwarded !== escaped) return 90;
              if (initialized !== 1 || escaped() !== 23) return 91;
              if (imported.name !== "sourceName" || alias.name !== "sourceName") return 92;
              if (forwarded.name !== "sourceName" || escaped.name !== "sourceName") return 93;
              if (read(escaped) !== "sourceName") return 94;
              return 1;
            }`,
            },
            target,
          ),
        ).toBe(1);
      });

      it.each([
        ["named generator declaration", "export default function* gName() { yield 23; }", "gName"],
        ["named expression", "export default (function sourceName() { return 23; });", "sourceName"],
        ["anonymous generator expression", "export default (function* () { yield 23; });", "default"],
      ])("clean escaped %s does not acquire the import spelling", async (_label, source, name) => {
        expect(
          await run(
            {
              "./dep.js": source,
              "./bridge.js": `export { default as forwarded } from "./dep.js";`,
              "./entry.js": `import fn from "./dep.js";
            import { forwarded } from "./bridge.js";
            import * as ns from "./dep.js";
            const escaped = fn;
            export function test() {
              if (escaped.name !== ${JSON.stringify(name)} || escaped["name"] !== ${JSON.stringify(name)}) return 91;
              if (forwarded.name !== ${JSON.stringify(name)} || forwarded["name"] !== ${JSON.stringify(name)}) return 92;
              if (ns.default.name !== ${JSON.stringify(name)} || ns.default["name"] !== ${JSON.stringify(name)}) return 93;
              return 1;
            }`,
            },
            target,
          ),
        ).toBe(1);
      });

      it("reads a name redefined during initialization", async () => {
        expect(
          await run(
            {
              "./dep.js": `export default function sourceName() { return 23; }`,
              "./entry.js": `import fn from "./dep.js";
            let observer; observer = fn;
            Object.defineProperty(fn, "name", { value: "changed" });
            export function test() {
              if (observer.name !== "changed" || observer["name"] !== "changed") return 90;
              if (Object.getOwnPropertyDescriptor(observer, "name").value !== "changed") return 91;
              return 1;
            }`,
            },
            target,
          ),
        ).toBe(1);
      });

      it("resolves an alias initialized from a namespace function member", async () => {
        expect(
          await run(
            {
              "./dep.js": `export function sourceName() { return 23; }`,
              "./entry.js": `import * as ns from "./dep.js";
            const alias = ns.sourceName;
            export function test() {
              if (alias.name !== "sourceName" || alias["name"] !== "sourceName") return 90;
              return alias() === 23 ? 1 : 91;
            }`,
            },
            target,
          ),
        ).toBe(1);
      });

      it("respects name deletion and an accessor with exact receiver effects", async () => {
        expect(
          await run(
            {
              "./dep.js": `export default function sourceName() { return 23; }`,
              "./entry.js": `import fn from "./dep.js";
            let observer; observer = fn;
            let gets = 0, evaluations = 0;
            delete fn.name;
            const absent = !Object.prototype.hasOwnProperty.call(fn, "name");
            Object.defineProperty(fn, "name", { configurable: true, get: function () { gets++; return "getter"; } });
            export function test() {
              if (!absent) return 90;
              if (observer.name !== "getter" || observer["name"] !== "getter") return 91;
              if ((evaluations++, observer).name !== "getter") return 92;
              if (gets !== 3 || evaluations !== 1) return 93;
              return 1;
            }`,
            },
            target,
          ),
        ).toBe(1);
      });

      it("preserves a name getter's thrown object and one receiver evaluation", async () => {
        expect(
          await run(
            {
              "./dep.js": `export default function sourceName() { return 23; }`,
              "./entry.js": `import fn from "./dep.js";
            const marker = {}; let gets = 0, evaluations = 0;
            Object.defineProperty(fn, "name", { get: function () { gets++; throw marker; } });
            export function test() {
              let caught = false;
              try { const value = (evaluations++, fn).name; }
              catch (error) { caught = error === marker; }
              return caught && gets === 1 && evaluations === 1 ? 1 : 90;
            }`,
            },
            target,
          ),
        ).toBe(1);
      });

      it("preserves local functions, lexical shadows and named classes", async () => {
        expect(
          await run(
            {
              "./dep.js": `export default function sourceName() { return 23; }`,
              "./entry.js": `import fn from "./dep.js";
            function local() { return 23; }
            const anonymous = function () {};
            const expression = function expressionName() {};
            class NamedClass {}
            export function test() {
              const fn = function shadowName() {};
              if (local.name !== "local" || anonymous.name !== "anonymous") return 90;
              if (expression.name !== "expressionName" || fn.name !== "shadowName") return 91;
              if (NamedClass.name !== "NamedClass" || local() !== 23) return 92;
              return 1;
            }`,
            },
            target,
          ),
        ).toBe(1);
      });
    });
  }

  for (const target of ["gc", "standalone", "wasi"] as const) {
    it(`preserves imported named class names (${target})`, async () => {
      expect(
        await run(
          {
            "./dep.js": `export class SourceClass {}
          export class OtherClass {}`,
            "./entry.js": `import { SourceClass as Alias } from "./dep.js";
          import { OtherClass as OtherAlias } from "./dep.js";
          export function test() {
            if (Alias.name !== "SourceClass" || OtherAlias.name !== "OtherClass") return 90;
            return 1;
          }`,
          },
          target,
        ),
      ).toBe(1);
    });
    it(`preserves the existing anonymous default class name (${target})`, async () => {
      expect(
        await run(
          {
            "./dep.js": `export default class {}`,
            "./entry.js": `import Alias from "./dep.js";
          export function test() { return Alias.name === "default" ? 1 : 90; }`,
          },
          target,
        ),
      ).toBe(1);
    });
  }

  for (const target of ["gc", "wasi"] as const) {
    it(`preserves established non-module name controls (${target})`, async () => {
      expect(
        await run(
          {
            "./entry.js": `function local() { return 23; }
          const anonymous = function () {};
          const expression = function expressionName() {};
          class NamedClass {}
          export function test() {
            if (local.name !== "local" || anonymous.name !== "anonymous") return 90;
            if (expression.name !== "expressionName" || NamedClass.name !== "NamedClass") return 91;
            return local() === 23 ? 1 : 92;
          }`,
          },
          target,
        ),
      ).toBe(1);
    });
  }
});
