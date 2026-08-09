// #3994 — checked-JS packages can expose a recursive flow/type shape while
// the object-assignment widening pre-pass asks for the RHS type. A TypeScript
// checker stack overflow is not a reason to abort the whole package compile;
// the pre-pass must conservatively retain the property-carrier mark and move
// on to the rest of the source.
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { collectObjectLiteralAssignedPropertyNames } from "../src/codegen/declarations/object-shape-widening.js";

describe("#3994 — bounded object-assignment type queries", () => {
  it("keeps scanning when the checker overflows on a recursive RHS", () => {
    const sourceFile = ts.createSourceFile(
      "issue-3994.js",
      "const target = {}; target.alias = target || unknownSymbol; target.done = target;",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const checker = {
      getTypeAtLocation(node: ts.Node): ts.Type {
        // Model the recursive checker path observed in TypeScript 5.9.3's
        // `links.aliasTarget = target || unknownSymbol` assignment. The
        // production pre-pass must only swallow this bounded failure class.
        if (node.getText() === "target || unknownSymbol") {
          throw new RangeError("Maximum call stack size exceeded");
        }
        return { flags: ts.TypeFlags.Object } as ts.Type;
      },
    } as unknown as ts.TypeChecker;
    const objectLiteralAssignedPropertyNames = new Set<string>();
    const context = {
      checker,
      objectLiteralAssignedPropertyNames,
      objectLiteralAssignedPropertyTypes: new Map<string, ts.Type[]>(),
    } as never;

    expect(() => collectObjectLiteralAssignedPropertyNames(context, sourceFile)).not.toThrow();
    expect(objectLiteralAssignedPropertyNames).toEqual(new Set(["alias", "done"]));
  });
});
