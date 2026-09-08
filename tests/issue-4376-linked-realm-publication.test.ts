import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const base = {
  target: "standalone" as const,
  platform: "deno" as const,
  hostBridge: "always" as const,
  skipSemanticDiagnostics: true,
  deferTopLevelInit: true,
  allowJs: true,
};
const linked = {
  ...base,
  standaloneGlobalThisImport: {
    module: "v8x:context",
    name: "__v8x_context_global_this",
    call: "__v8x_context_call",
  },
  link: ["v8x:context"],
};

async function instantiate(source: string, fileName: string, shared = false, imports = {}) {
  const result = await compile(source, { ...(shared ? linked : base), fileName });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary as BufferSource, imports);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports as Record<string, CallableFunction>;
}

describe("literal publication between independently compiled realm modules", () => {
  // Reproduced on unchanged bbb5f398 too; track separately from publication.
  it.fails("preserves a shadowed globalThis without reading the shared realm", async () => {
    const e = await instantiate(
      `export function control():number { const globalThis:any={}; globalThis.api={marker:9}; return globalThis.api.marker; }
       export function local():number { const value:{marker:number}={marker:17};return value.marker; }`,
      "local.ts",
      true,
      {
        "v8x:context": {
          __v8x_context_global_this: () => {
            throw new Error("unexpected realm read");
          },
          __v8x_context_call: () => {
            throw new Error("unexpected realm call");
          },
        },
      },
    );
    expect(e.control()).toBe(9);
    expect(e.local()).toBe(17);
  });
  it("keeps ordinary local typed objects unchanged", async () => {
    const e = await instantiate(
      "export function local():number { const value:{marker:number}={marker:17};return value.marker; }",
      "local.ts",
      true,
    );
    expect(e.local()).toBe(17);
  });
  it.each([
    ["globalThis.api = {marker: 7, use_state: (f) => { globalThis.count = 42; }};", "api"],
    ["globalThis['api'] = ({marker: 7, use_state: (f) => { globalThis.count = 42; }});", "api"],
    ["globalThis.api = {nested: {marker: 7, use_state: (f) => { globalThis.count = 42; }}};", "api.nested"],
  ])("retains published fields and calls: %s", async (publication, access) => {
    const context = await instantiate(
      `
      const realm:any = globalThis;
      realm.count = 0;
      export function __v8x_context_global_this():any {return realm;}
      export function __v8x_context_call(f:any, receiver:any, args:any):any {return f.apply(receiver,args);}
      export function count():number {return realm.count;}
    `,
      "context.ts",
    );
    const imports = { "v8x:context": context } as WebAssembly.Imports;
    const producer = await instantiate(
      `${publication}
      export function object() {return globalThis.${access};}
    `,
      "producer.js",
      true,
      imports,
    );
    const consumer = await instantiate(
      `
      export function object():any {return (globalThis as any).${access};}
      export function marker():number {const o:any=object();return o.marker;}
      export function run():void {const o:any=object();o.use_state(()=>{});}
      export function missing():number {const o:any=object();try{o.absent();return 0;}catch(e){return e instanceof TypeError?1:-1;}}
    `,
      "consumer.ts",
      true,
      imports,
    );
    expect(producer.object()).toBe(consumer.object());
    expect(consumer.marker()).toBe(7);
    consumer.run();
    expect(context.count()).toBe(42);
    expect(consumer.missing()).toBe(1);
  });
});
