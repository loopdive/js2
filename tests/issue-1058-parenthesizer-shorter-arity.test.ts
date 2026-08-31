// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti, wrapExports } from "../src/index.js";

describe("#1058 TypeScript parenthesizer callable property", () => {
  it("dispatches a one-parameter arrow through its two-parameter interface field", async () => {
    const result = await compileMulti(
      {
        "./core.ts": `
          export function memoize<T>(callback: () => T): () => T {
            let value: T;
            return () => {
              if (callback) {
                value = callback();
                callback = undefined!;
              }
              return value;
            };
          }
        `,
        "./types.ts": `
          export interface Node {
            kind: number;
            value: number;
          }

          export interface ParenthesizerRules {
            parenthesizeLeftSideOfAccess(expression: Node, optionalChain?: boolean): Node;
          }

          export interface Factory {
            createParenthesizedExpression(expression: Node): Node;
            createExpressionWithTypeArguments(expression: Node): Node;
            optionalArgumentEvaluations(): number;
          }
        `,
        "./parenthesizerRules.ts": `
          import type { Factory, Node, ParenthesizerRules } from "./types.js";

          export const nullParenthesizerRules: ParenthesizerRules = {
            parenthesizeLeftSideOfAccess: expression => expression,
          };

          export function createParenthesizerRules(factory: Factory): ParenthesizerRules {
            return { parenthesizeLeftSideOfAccess };

            function parenthesizeLeftSideOfAccess(expression: Node, optionalChain?: boolean): Node {
              return expression.kind === 1 ? expression : factory.createParenthesizedExpression(expression);
            }
          }
        `,
        "./nodeFactory.ts": `
          import { memoize } from "./core.js";
          import { createParenthesizerRules, nullParenthesizerRules } from "./parenthesizerRules.js";
          import type { Factory, Node } from "./types.js";

          export function createNodeFactory(flags: number): Factory {
            let optionalArgumentCount = 0;
            const parenthesizerRules = memoize(() =>
              flags & 1 ? nullParenthesizerRules : createParenthesizerRules(factory)
            );
            const factory: Factory = {
              createParenthesizedExpression,
              createExpressionWithTypeArguments,
              optionalArgumentEvaluations,
            };
            return factory;

            function createParenthesizedExpression(expression: Node): Node {
              return { kind: 1, value: expression.value + 7 };
            }

            function observeOptionalChain(): boolean {
              optionalArgumentCount++;
              return false;
            }

            function createExpressionWithTypeArguments(expression: Node): Node {
              return parenthesizerRules().parenthesizeLeftSideOfAccess(expression, observeOptionalChain());
            }

            function optionalArgumentEvaluations(): number {
              return optionalArgumentCount;
            }
          }
        `,
        "./entry.ts": `
          import { createNodeFactory } from "./nodeFactory.js";

          const realRulesFactory = createNodeFactory(0);
          const nullRulesFactory = createNodeFactory(1);

          export function realRules(): number {
            const node = realRulesFactory.createExpressionWithTypeArguments({ kind: 2, value: 35 });
            return node.value * 10 + realRulesFactory.optionalArgumentEvaluations();
          }

          export function nullRules(): number {
            const node = nullRulesFactory.createExpressionWithTypeArguments({ kind: 1, value: 42 });
            return node.value * 10 + nullRulesFactory.optionalArgumentEvaluations();
          }
        `,
      },
      "./entry.ts",
      {
        target: "gc",
        platform: "node",
        skipSemanticDiagnostics: true,
        experimentalIR: true,
        resolve: { consumerDrivenBarrels: true },
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });

    expect(exports.realRules()).toBe(421);
    expect(exports.nullRules()).toBe(421);
  });
});
