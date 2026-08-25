import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileProject } from "../src/index.js";
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

async function runProject(files: Record<string, string>): Promise<unknown> {
  const directory = mkdtempSync(join(tmpdir(), "js2-hono-async-project-"));
  try {
    for (const [name, source] of Object.entries(files)) writeFileSync(join(directory, name), source);
    const result = await compileProject(join(directory, "entry.js"), {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "web",
      deferTopLevelInit: true,
    });
    if (!result.success) {
      throw new Error(
        `Compile failed:\n${result.errors.map((error) => `  L${error.line}: ${error.message}`).join("\n")}`,
      );
    }
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    imports.__setInstance?.(instance);
    instance.exports.__module_init?.();
    return (instance.exports as Record<string, (...args: unknown[]) => unknown>).test!();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
          #routers = [];
          #routes = [];

          select(router: any): number {
            this.#routers = [router] as any;
            this.#routes = void 0 as any;
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

  it("awaits a dynamically stored middleware before recursive dispatch settles", async () => {
    expect(
      await run(`
        type ContextLike = { finalized: boolean; response: number; phase: number };

        function compose(middleware: any[]) {
          return (context: ContextLike) => {
            let index = -1;
            return dispatch(0);

            async function dispatch(i: number): Promise<ContextLike> {
              if (i <= index) throw new Error("next called twice");
              index = i;
              let handler: any;
              let response: any;
              if (middleware[i]) handler = middleware[i][0][0];
              if (handler) {
                response = await handler(context, () => dispatch(i + 1));
              } else if (!context.finalized) {
                context.phase = 2;
                response = 404;
              }
              if (response && !context.finalized) {
                context.response = response;
                context.finalized = true;
              }
              return context;
            }
          };
        }

        export async function test(): Promise<number> {
          const context: ContextLike = { finalized: false, response: 0, phase: 0 };
          const middleware: any[] = [[[async (_context: ContextLike, next: any) => {
            context.phase = 1;
            await next();
            context.phase = 3;
            context.response = 301;
          }]]];
          const result = await compose(middleware)(context);
          return result.finalized && result.response === 301 && result.phase === 3 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("settles recursive middleware through try branches before its caller resumes", async () => {
    expect(
      await run(`
        type ContextLike = { finalized: boolean; response: number; phase: number; error?: any };

        function compose(middleware: any[], onError: any, onNotFound: any) {
          return (context: ContextLike, next?: any) => {
            let index = -1;
            return dispatch(0);

            async function dispatch(i: number): Promise<ContextLike> {
              if (i <= index) throw new Error("next called twice");
              index = i;
              let response: any;
              let isError = false;
              let handler: any;
              if (middleware[i]) handler = middleware[i][0][0];
              else handler = (i === middleware.length && next) || undefined;
              if (handler) {
                try {
                  response = await handler(context, () => dispatch(i + 1));
                } catch (error) {
                  if (error instanceof Error && onError) {
                    context.error = error;
                    response = await onError(error, context);
                    isError = true;
                  } else {
                    throw error;
                  }
                }
              } else if (context.finalized === false && onNotFound) {
                context.phase = 2;
                response = await onNotFound(context);
              }
              if (response && (context.finalized === false || isError)) {
                context.response = response;
                context.finalized = true;
              }
              return context;
            }
          };
        }

        export async function test(): Promise<number> {
          const context: ContextLike = { finalized: false, response: 0, phase: 0 };
          const middleware: any[] = [[[async (c: ContextLike, next: any) => {
            c.phase = 1;
            await next();
            if (c.response === 404) {
              c.phase = 3;
              c.response = 301;
              c.finalized = true;
            }
          }]]];
          const onError = (_error: any, _context: ContextLike) => 500;
          const onNotFound = (_context: ContextLike) => 404;
          const composed = compose(middleware, onError, onNotFound);
          const result = await composed(context);
          if (!result.finalized) throw new Error("not finalized");
          return result.response === 301 && context.phase === 3 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("awaits a synchronous host Response through recursive middleware dispatch", async () => {
    expect(
      await run(`
        class ContextLike {
          finalized = false;
          phase = 0;
          #response?: Response;

          get res(): Response {
            return this.#response ||= new Response(null);
          }

          set res(response: Response) {
            this.#response = response;
            this.finalized = true;
          }
        }

        function compose(middleware: any[], onError: any, onNotFound: any) {
          return (context: ContextLike, next?: any) => {
            let index = -1;
            return dispatch(0);

            async function dispatch(i: number): Promise<ContextLike> {
              if (i <= index) throw new Error("next called twice");
              index = i;
              let response: any;
              let isError = false;
              let handler: any;
              if (middleware[i]) handler = middleware[i][0][0];
              else handler = (i === middleware.length && next) || undefined;
              if (handler) {
                try {
                  response = await handler(context, () => dispatch(i + 1));
                } catch (error) {
                  if (error instanceof Error && onError) {
                    response = await onError(error, context);
                    isError = true;
                  } else {
                    throw error;
                  }
                }
              } else if (context.finalized === false && onNotFound) {
                context.phase = 2;
                response = await onNotFound(context);
              }
              if (response && (context.finalized === false || isError)) context.res = response;
              return context;
            }
          };
        }

        export async function test(): Promise<number> {
          const context = new ContextLike();
          const middleware: any[] = [[[async (c: ContextLike, next: any) => {
            c.phase = 1;
            await next();
            if (c.res.status === 404) {
              c.phase = 3;
              c.res = new Response(null, { status: 301 });
            }
          }]]];
          const onError = (_error: any, _context: ContextLike) => new Response(null, { status: 500 });
          const onNotFound = (_context: ContextLike) => new Response(null, { status: 404 });
          const result = await compose(middleware, onError, onNotFound)(context);
          if (!result.finalized) throw new Error("not finalized");
          return result.res.status === 301 && result.phase === 3 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("awaits a synchronous host value through an imported recursive dispatcher", async () => {
    expect(
      await runProject({
        "compose.js": `
          export function compose(middleware, onError, onNotFound) {
            return (context, next) => {
              let index = -1;
              return dispatch(0);
              async function dispatch(i) {
                if (i <= index) throw new Error("next called twice");
                index = i;
                let response;
                let isError = false;
                let handler;
                if (middleware[i]) handler = middleware[i][0][0];
                else handler = (i === middleware.length && next) || undefined;
                if (handler) {
                  try {
                    response = await handler(context, () => dispatch(i + 1));
                  } catch (error) {
                    if (error instanceof Error && onError) {
                      response = await onError(error, context);
                      isError = true;
                    } else {
                      throw error;
                    }
                  }
                } else if (context.finalized === false && onNotFound) {
                  response = await onNotFound(context);
                }
                if (response && (context.finalized === false || isError)) context.res = response;
                return context;
              }
            };
          }
        `,
        "middleware.js": `
          export function trailing() {
            return async function trailing2(context, next) {
              await next();
              if (context.res.status === 404) {
                context.phase = 3;
                context.res = new Response(null, { status: 301 });
              }
            };
          }
        `,
        "entry.js": `
          import { compose } from "./compose.js";
          import { trailing } from "./middleware.js";

          class ContextLike {
            finalized = false;
            phase = 0;
            #response;
            get res() { return this.#response ||= new Response(null); }
            set res(response) {
              this.#response = response;
              this.finalized = true;
            }
          }

          const context = new ContextLike();
          const middleware = [[[trailing()]]];
          const defaultNotFound = (_context) => new Response(null, { status: 404 });

          function request() {
            const onError = (_error, _context) => new Response(null, { status: 500 });
            const composed = compose(middleware, onError, defaultNotFound);
            return (async () => {
              const result = await composed(context);
              if (!result.finalized) throw new Error("not finalized");
              return result.res;
            })();
          }

          export async function test() {
            const response = await request();
            return response.status === 301 && context.phase === 3 ? 1 : 0;
          }
        `,
      }),
    ).toBe(1);
  });

  it("awaits a conditionally recursive Promise inside an async IIFE", async () => {
    expect(
      await run(`
        async function leaf(depth: number): Promise<number> {
          if (depth > 0) return await (() => leaf(depth - 1))();
          return 7;
        }

        function request(): Promise<number> {
          return (async () => {
            const value = await leaf(1);
            return value;
          })();
        }

        export async function test(): Promise<number> {
          return await request();
        }
      `),
    ).toBe(7);
  });

  it("preserves an omitted captured option through an async closure resume", async () => {
    expect(
      await run(`
        async function leaf(depth: number): Promise<number> {
          if (depth > 0) return await (() => leaf(depth - 1))();
          return 1;
        }

        function middleware(options?: { skip?: (path: string) => boolean }) {
          return async function run(): Promise<number> {
            await leaf(1);
            return options?.skip?.("/path") ? -1 : 7;
          };
        }

        export async function test(): Promise<number> {
          const run = middleware();
          return await run();
        }
      `),
    ).toBe(7);
  });

  it("activates a dynamic const-call nested-await continuation", async () => {
    const result = await compile(
      `
        declare function pending(): Promise<any>;

        const consume = (value: any) => ({
          commit(): void {
            if (value === undefined) throw new Error("missing value");
          },
        });

        const callback = async (): Promise<void> => {
          consume(await pending()).commit();
        };

        export function test(): number {
          return typeof callback === "function" ? 1 : 0;
        }
      `,
      { platform: "web" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.wat).toContain("__async_resume_fanon_");

    const typedScalar = await compile(
      `
        declare function pending(): Promise<number>;
        const consume = (value: number): void => { void value; };
        const callback = async (): Promise<void> => {
          consume(await pending());
        };
        export function test(): number {
          return typeof callback === "function" ? 1 : 0;
        }
      `,
      { platform: "web" },
    );
    expect(typedScalar.success, typedScalar.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(typedScalar.wat).not.toContain("__async_resume_fanon_");
  });

  it("invokes a path-extension predicate through a closure", async () => {
    expect(
      await run(`
        export function test(): number {
          const hasExtension = (path: string): boolean => /\\.\\w+$/.test(path.split("/").at(-1) ?? "");
          return hasExtension("/foo.html") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("commits a private router selection after a caught fallback", async () => {
    expect(
      await runProject({
        "errors.js": `
          export class UnsupportedPathError extends Error {}
        `,
        "routers.js": `
          import { UnsupportedPathError } from "./errors.js";
          export class RejectingRouter {
            name = "rejecting";
            add() {}
            match(_method, _path) { throw new UnsupportedPathError("unsupported"); }
          }
          export class WorkingRouter {
            name = "working";
            value = 7;
            add() {}
            match(_method, _path) { return this.value; }
          }
        `,
        "smart.js": `
          import { UnsupportedPathError } from "./errors.js";
          export class SmartRouter {
            #routers = [];
            #routes = [];
            constructor(init) { this.#routers = init.routers; }
            match(method, path) {
              if (!this.#routes) throw new Error("already selected");
              const routers = this.#routers;
              const routes = this.#routes;
              const len = routers.length;
              let i = 0;
              let result;
              for (; i < len; i++) {
                const router = routers[i];
                try {
                  for (let i2 = 0, len2 = routes.length; i2 < len2; i2++) {
                    router.add(...routes[i2]);
                  }
                  result = router.match(method, path);
                } catch (error) {
                  if (error instanceof UnsupportedPathError) continue;
                  throw error;
                }
                this.#routers = [router];
                this.#routes = void 0;
                break;
              }
              if (i === len) throw new Error("no router");
              return result + this.activeRouter.value;
            }
            get activeRouter() {
              if (this.#routes || this.#routers.length !== 1) throw new Error("not selected");
              return this.#routers[0];
            }
          }
        `,
        "entry.js": `
          import { RejectingRouter, WorkingRouter } from "./routers.js";
          import { SmartRouter } from "./smart.js";
          export function test() {
            const router = new SmartRouter({ routers: [new RejectingRouter(), new WorkingRouter()] });
            return router.match("GET", "/");
          }
        `,
      }),
    ).toBe(14);
  });
});
