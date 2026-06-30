// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2851 / #2852 / #2841 — `marshal:"copy"` (wrapExports) dropped the fields of
// WasmGC-struct values held in a SIDECAR (dynamically-assigned) property. acorn
// builds AST nodes by `new Node()` then assigning extra fields
// (`node.quasis = [...]`, `node.expressions = [...]`, `node.params = [...]`).
// Those assigned fields are stored as sidecar props. `_structToPlainObject` deep-
// converted the NOMINAL struct fields (`val = _wasmToPlain(getter(obj))`) but
// merged the sidecar props VERBATIM (`result[key] = sc[key]`), so a sidecar
// value that was — or contained — raw WasmGC structs came back blank/opaque:
//   - #2851 TemplateLiteral.quasis[*]  (TemplateElement nodes blank)
//   - #2852 SequenceExpression.expressions[*]  (child nodes blank)
//   - #2841 ArrowFunctionExpression.params[*]  (Identifier nodes blank)
//
// Fix: recurse `_wasmToPlain` on sidecar values too, mirroring the nominal-field
// path. One change in `_structToPlainObject` covers all three array-of-child-node
// shapes.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWasm, wrapExports, buildImports } from "../src/runtime.js";

async function runMarshalled(src: string): Promise<any> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await instantiateWasm(new Uint8Array(r.binary), imports.env, imports.string_constants);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return wrapExports(instance.exports, { marshal: "copy" }).test();
}

// A minimal stand-in for acorn's `Node` class: a couple of nominal fields, then
// the parser assigns the rest dynamically (→ sidecar props).
const NODE = `class Node { type: string = ""; start: number = 0; constructor() {} }`;

describe("#2851/#2852/#2841 sidecar array-of-struct fields marshal deeply", () => {
  it("#2851 TemplateLiteral.quasis[*] carry type/value.raw/value.cooked/tail", async () => {
    const node = await runMarshalled(`
      ${NODE}
      function mkElem(raw: string, tail: boolean): any {
        const e: any = new Node();
        e.type = "TemplateElement"; e.value = { raw: raw, cooked: raw }; e.tail = tail;
        return e;
      }
      export function test(): any {
        const n: any = new Node();
        n.type = "TemplateLiteral";
        n.quasis = [mkElem("hello ", false), mkElem(" world", true)];
        n.expressions = [];
        return n;
      }
    `);
    expect(node.type).toBe("TemplateLiteral");
    expect(node.quasis).toHaveLength(2);
    expect(node.quasis[0]).toMatchObject({
      type: "TemplateElement",
      value: { raw: "hello ", cooked: "hello " },
      tail: false,
    });
    expect(node.quasis[1]).toMatchObject({
      type: "TemplateElement",
      value: { raw: " world", cooked: " world" },
      tail: true,
    });
  });

  it("#2852 SequenceExpression.expressions[*] carry their child fields", async () => {
    const node = await runMarshalled(`
      ${NODE}
      function lit(v: number): any { const n: any = new Node(); n.type = "Literal"; n.value = v; n.raw = "" + v; return n; }
      export function test(): any {
        const n: any = new Node();
        n.type = "SequenceExpression";
        n.expressions = [lit(1), lit(2), lit(3)];
        return n;
      }
    `);
    expect(node.expressions).toHaveLength(3);
    expect(node.expressions.map((e: any) => e.type)).toEqual(["Literal", "Literal", "Literal"]);
    expect(node.expressions.map((e: any) => e.value)).toEqual([1, 2, 3]);
    expect(node.expressions[0]).toMatchObject({ type: "Literal", value: 1, raw: "1" });
  });

  it("#2841 ArrowFunctionExpression.params[*] carry type/name", async () => {
    const node = await runMarshalled(`
      ${NODE}
      function id(nm: string): any { const n: any = new Node(); n.type = "Identifier"; n.name = nm; return n; }
      export function test(): any {
        const n: any = new Node();
        n.type = "ArrowFunctionExpression";
        n.params = [id("a"), id("b")];
        return n;
      }
    `);
    expect(node.params).toHaveLength(2);
    expect(node.params[0]).toMatchObject({ type: "Identifier", name: "a" });
    expect(node.params[1]).toMatchObject({ type: "Identifier", name: "b" });
  });

  it("a sidecar value that is a single nested struct (not an array) is also deep-converted", async () => {
    const node = await runMarshalled(`
      ${NODE}
      export function test(): any {
        const inner: any = new Node(); inner.type = "Identifier"; inner.name = "x";
        const n: any = new Node(); n.type = "ExpressionStatement"; n.expression = inner;
        return n;
      }
    `);
    expect(node.expression).toMatchObject({ type: "Identifier", name: "x" });
  });
});
