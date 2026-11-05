// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { irDynamic } from "../src/ir/nodes.js";
import { IrUnsupportedError } from "../src/ir/outcomes.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-7138-missing-source-strictness");

describe("#7138 direct from-AST strictness metadata", () => {
  for (const [name, write] of [
    ["named", "o.value = v;"],
    ["computed", "o[k] = v;"],
  ] as const) {
    it(`refuses an unknown ${name} dynamic store instead of guessing its mode`, () => {
      const source = ts.createSourceFile(
        `issue-7138-unknown-${name}.ts`,
        `function write(o: any, k: any, v: any): void { ${write} }`,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const declaration = source.statements.find(ts.isFunctionDeclaration);
      expect(declaration).toBeDefined();
      let refusal: unknown;
      try {
        lowerFunctionAstToIr(declaration!, {
          ownerUnitId: identities.next(`write-${name}`).unitId,
          paramTypeOverrides: [irDynamic(), irDynamic(), irDynamic()],
          returnTypeOverride: null,
          // Deliberately no canonical resolver and no ambient-this strictness.
          // This unit test never asks hybrid compilation to use a legacy body.
        });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(IrUnsupportedError);
      expect(refusal).toMatchObject({ kind: "unsupported", code: "property-write-unsupported", stage: "build" });
      expect((refusal as Error).message).toContain("requires source strictness");
    });
  }
});
