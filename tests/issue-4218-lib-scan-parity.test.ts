// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4218 — syntactic lib.d.ts scan parity pins.
//
// The merge-group park of PR #4481 traced to alias-typed ambient globals:
// `declare var parent: WindowProxy` (alias of `Window`) stopped classifying
// as an extern-class global under the syntactic walk, silently dropping the
// `global_parent` host-import registration — a pass → compile_error flip on
// any test262 input reading a bare `parent`/`frames` identifier. These tests
// pin the alias-resolution fix plus the two other checker-parity cases the
// exhaustive lib-surface differential surfaced (type predicates and
// `unique symbol`).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { analyzeSource } from "../src/checker/index.ts";
import { ts } from "../src/ts-api.ts";
import {
  buildLibDeclIndex,
  isExternDeclaredLibName,
  isVoidTypeNode,
  mapLibTypeNodeToWasm,
  resolveLibTypeName,
} from "../src/codegen/lib-decl-index.ts";

function libIndexFor(source: string) {
  const ast = analyzeSource(source, "t.ts");
  const libSfs = ast.program.getSourceFiles().filter((sf) => {
    const b = sf.fileName.split("/").pop() ?? sf.fileName;
    return b.startsWith("lib.") && b.endsWith(".d.ts");
  });
  return buildLibDeclIndex(libSfs);
}

describe("#4218 syntactic lib scan — checker parity pins", () => {
  it("registers global_parent/global_frames for alias-typed ambient globals (WindowProxy → Window)", async () => {
    // `new Date()` triggers the lib scan (sourceUsesLibGlobals); the bare
    // `parent`/`frames` reads must resolve to registered host globals.
    const src = "var d = new Date(); var x = parent; var y = frames; console.log(typeof x, typeof y, d.getTime());";
    const r = await compile(src, { fileName: "t.ts" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const text = Buffer.from(r.binary).toString("latin1");
    expect(text.includes("global_parent")).toBe(true);
    expect(text.includes("global_frames")).toBe(true);
  });

  it("resolves lib type aliases and classifies their targets as extern classes", () => {
    const index = libIndexFor("document;");
    expect(resolveLibTypeName("WindowProxy", index)).toBe("Window");
    expect(isExternDeclaredLibName("WindowProxy", index)).toBe(true);
    expect(isExternDeclaredLibName("Window", index)).toBe(true);
    // Builtins stay excluded from the declare-var XConstructor pattern.
    expect(isExternDeclaredLibName("Date", index)).toBe(false);
  });

  it("maps type predicates to branded boolean and asserts-predicates to void", () => {
    const sf = ts.createSourceFile(
      "p.d.ts",
      "declare function isFoo(x: unknown): x is string; declare function assertFoo(x: unknown): asserts x;",
      ts.ScriptTarget.Latest,
      true,
    );
    const index = buildLibDeclIndex([sf]);
    const [pred, asserts] = sf.statements as unknown as ts.FunctionDeclaration[];
    expect(mapLibTypeNodeToWasm(pred.type, index, new Map())).toEqual({ kind: "i32", boolean: true });
    expect(isVoidTypeNode(asserts.type)).toBe(true);
  });

  it("maps `unique symbol` like the checker maps UniqueESSymbol (i32)", () => {
    const sf = ts.createSourceFile(
      "u.d.ts",
      "interface I { readonly tag: unique symbol; }",
      ts.ScriptTarget.Latest,
      true,
    );
    const index = buildLibDeclIndex([sf]);
    const iface = sf.statements[0] as ts.InterfaceDeclaration;
    const prop = iface.members[0] as ts.PropertySignature;
    expect(mapLibTypeNodeToWasm(prop.type, index, new Map())).toEqual({ kind: "i32" });
  });
});
