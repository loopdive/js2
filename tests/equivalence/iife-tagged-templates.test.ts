import { describe, it, expect } from "vitest";
import { compileToWasm, assertEquivalent } from "./helpers.js";

describe("IIFE and call expression tagged templates", () => {
  it("IIFE tagged template — function expression", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return (function(strings: TemplateStringsArray): number {
          return strings.length;
        })\`hello\`;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("IIFE tagged template — function expression with substitutions", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return (function(strings: TemplateStringsArray, a: number, b: number): number {
          return strings.length + a + b;
        })\`hello \${10} world \${20}\`;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("IIFE tagged template — arrow function", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return ((strings: TemplateStringsArray): number => strings.length)\`hello\`;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("call expression tagged template — function returning tag", async () => {
    await assertEquivalent(
      `
      function makeTag(): (strings: TemplateStringsArray) => number {
        return function(strings: TemplateStringsArray): number {
          return strings.length;
        };
      }
      export function test(): number {
        return makeTag()\`hello\`;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("call expression tagged template — with substitutions", async () => {
    await assertEquivalent(
      `
      function makeTag(): (strings: TemplateStringsArray, val: number) => number {
        return function(strings: TemplateStringsArray, val: number): number {
          return val;
        };
      }
      export function test(): number {
        return makeTag()\`prefix \${42} suffix\`;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
