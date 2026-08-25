import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

async function run(source: string, exportName = "test"): Promise<unknown> {
  const result = await compile(source, { platform: "web" });
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((error) => `  L${error.line}: ${error.message}`).join("\n")}`,
    );
  }
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  imports.__setInstance?.(instance);
  return (instance.exports as Record<string, (...args: unknown[]) => unknown>)[exportName]!();
}

describe("#3995 Hono erased class boundary regressions", () => {
  it("invokes a compiled prototype setter through an any-typed write", async () => {
    expect(
      await run(`
        class ContextLike {
          finalized = false;
          #response?: Response;

          get res(): Response {
            return this.#response ||= new Response(null);
          }

          set res(next: Response) {
            this.#response = next;
            this.finalized = true;
          }
        }

        function finish(context: any, response: any): void {
          context.res = response;
        }

        export function test(): number {
          const context = new ContextLike();
          finish(context, { status: 200 });
          return context.finalized && context.res.status === 200 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("forwards a runtime tuple spread into a compiled class method", async () => {
    expect(
      await run(`
        class RouterLike {
          result = "";

          add(method: any, path: any, handler: any): void {
            this.result = method + ":" + path + ":" + handler;
          }
        }

        function addRoute(router: any, route: any[]): void {
          router.add(...route);
        }

        export function test(): number {
          const router = new RouterLike();
          addRoute(router, ["GET", "/items", 7]);
          return router.result === "GET:/items:7" ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("expands a statically known tuple spread into a contextual tuple", async () => {
    expect(
      await run(`
        function expand(route: [string, number]): [boolean, string, number] {
          return [true, ...route];
        }

        export function test(): number {
          const value = expand(["GET", 7]);
          return value[0] && value[1] === "GET" ? value[2] : -1;
        }
      `),
    ).toBe(7);
  });

  it("appends every element from a runtime native array spread", async () => {
    expect(
      await run(`
        type Route = [string, number];
        export function test(): number {
          const target: Route[] = [];
          const source: Route[] = [];
          source.push(["GET", 3]);
          source.push(["POST", 4]);
          target.push(...source);
          return target.length === 2 && target[0][0] === "GET" && target[1][0] === "POST"
            ? target[0][1] + target[1][1]
            : -1;
        }
      `),
    ).toBe(7);
  });

  it("keeps an out-of-bounds row nullable until the member-read TypeError guard", async () => {
    expect(
      await run(`
        export function test(): number {
          const rows: Array<{ value: number }> = [];
          try {
            return rows[0].value;
          } catch (error) {
            return error instanceof TypeError ? 1 : -1;
          }
        }
      `),
    ).toBe(1);
  });

  it("initializes an optional numeric private field as undefined", async () => {
    expect(
      await run(`
        class Node {
          #index?: number;
          write(): number {
            if (this.#index !== undefined) return -1;
            this.#index = 7;
            return this.#index;
          }
        }

        export function test(): number {
          return new Node().write();
        }
      `),
    ).toBe(7);
  });

  it("restores a compiled class stored in an Object.create dictionary", async () => {
    expect(
      await run(`
        var Node = class _Node {
          #methods;
          #children;
          constructor() {
            this.#children = Object.create(null);
            this.#methods = [];
          }
          insert(): number {
            let current = this;
            current.#children.a = new _Node();
            current = current.#children.a;
            current.#methods.push({ value: 1 });
            return current.#methods.length;
          }
        };

        export function test(): number {
          return new Node().insert();
        }
      `),
    ).toBe(1);
  });

  it("recognizes an Error-subclass class expression through a caught any value", async () => {
    expect(
      await run(`
        var UnsupportedPathError = class extends Error {};

        export function test(): number {
          try {
            throw new UnsupportedPathError("*");
          } catch (error: any) {
            return error instanceof UnsupportedPathError ? 1 : 0;
          }
        }
      `),
    ).toBe(1);
  });

  it("preserves a named class expression's private brand through a widened receiver", async () => {
    expect(
      await run(`
        var Node = class _Node {
          #children: any = Object.create(null);
          #methods: any[] = [];

          insert(): number {
            let current: any = this;
            current.#children.x = new _Node();
            current = current.#children.x;
            current.#methods.push(1);
            return current.#methods.length;
          }
        };

        export function test(): number {
          return new Node().insert();
        }
      `),
    ).toBe(1);
  });

  it("clears an inferred private array field before reading its sibling", async () => {
    expect(
      await run(`
        var SmartRouter = class {
          #routers: any[] = [];
          #routes: any = [];

          select(router: any): number {
            this.#routers = [router];
            this.#routes = void 0;
            return this.activeRouter.value;
          }

          get activeRouter(): any {
            if (this.#routes || this.#routers.length !== 1) {
              throw new Error("not selected");
            }
            return this.#routers[0];
          }
        };

        export function test(): number {
          return new SmartRouter().select({ value: 7 });
        }
      `),
    ).toBe(7);
  });

  it("returns a Promise from a concise arrow IIFE instead of a default null", async () => {
    expect(
      await run(`
        export async function test(): Promise<number> {
          let phase = 0;
          async function inner(): Promise<number> {
            phase = 1;
            return 7;
          }
          const value = await (() => inner())();
          return phase * 10 + value;
        }
      `),
    ).toBe(17);
  });

  it("installs the class instance receiver for a function-valued class field", async () => {
    expect(
      await run(`
        function match() {
          return this.build();
        }

        class Router {
          #value = 7;
          match = match;

          build(): number {
            return this.#value;
          }
        }

        export function test(): number {
          return new Router().match();
        }
      `),
    ).toBe(7);
  });

  it("writes logical assignment through a mutable capture cell", async () => {
    expect(
      await run(`
        export function test(): number {
          let hasOwnRoute = false;
          [0].forEach(() => {
            hasOwnRoute ||= true;
          });
          return hasOwnRoute ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("does not reclassify a linear await because of an unrelated synchronous guard", async () => {
    expect(
      await run(`
        export function test(): number {
          async function leaf(): Promise<number> {
            return 7;
          }
          async function inner(depth: number): Promise<number> {
            if (depth < 0) return -1;
            return await leaf();
          }
          return inner(1) as any as number;
        }
      `),
    ).toBe(7);
  });

  it("resumes a recursive await nested in a conditional branch", async () => {
    expect(
      await run(`
        export async function test(): Promise<number> {
          async function inner(depth: number): Promise<number> {
            if (depth > 0) return await (() => inner(depth - 1))();
            return 7;
          }
          return await inner(1);
        }
      `),
    ).toBe(7);
  });

  it("keeps a conditionally recursive async sibling on its reserved Promise ABI", async () => {
    expect(
      await run(`
        export async function test(): Promise<number> {
          function sibling(): number {
            return 1;
          }
          async function inner(depth: number): Promise<number> {
            if (depth > 0) return await inner(depth - 1);
            return 6 + sibling();
          }
          return await inner(1);
        }
      `),
    ).toBe(7);
  });

  it("keeps a forward sibling caller on the conditionally async callee's Promise ABI", async () => {
    expect(
      await run(`
        export async function test(): Promise<number> {
          function caller(depth: number): Promise<number> {
            return inner(depth);
          }
          async function inner(depth: number): Promise<number> {
            if (depth > 0) return await inner(depth - 1);
            return 7;
          }
          return await caller(1);
        }
      `),
    ).toBe(7);
  });

  it("admits a conditional await owned by a top-level host-visible async function", async () => {
    expect(
      await run(`
        export async function test(): Promise<number> {
          async function leaf(): Promise<number> {
            return 7;
          }
          let takeBranch = true;
          if (takeBranch) return await (() => leaf())();
          return -1;
        }
      `),
    ).toBe(7);
  });
});
