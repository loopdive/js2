import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const CONTEXT_MODULE = "v8x:context";
const CONTEXT_GETTER = "__v8x_context_global_this";
const CONTEXT_CALL = "__v8x_context_call";

const sharedGlobalOptions = {
  target: "standalone" as const,
  allowJs: true,
  skipSemanticDiagnostics: true,
  standaloneGlobalThisImport: {
    module: CONTEXT_MODULE,
    name: CONTEXT_GETTER,
    call: CONTEXT_CALL,
  },
  link: [CONTEXT_MODULE],
};

async function compileStandalone(source: string, fileName: string, shared = false) {
  const result = await compile(source, {
    fileName,
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...(shared ? sharedGlobalOptions : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

describe("linked standalone globalThis", () => {
  it("shares properties and callable closures across independently compiled instances", async () => {
    const context = await compileStandalone(
      `
        const realm: any = globalThis as any;
        realm.answer = 40;
        realm.bridgeCalls = 0;
        realm.increment = (value: any): any => value + 2;
        realm.dynamicAnswer = 40;
        realm.dynamicIncrement = (value: any): any => value + 2;
        export function ${CONTEXT_GETTER}(): any { return realm; }
        export function ${CONTEXT_CALL}(callable: any, receiver: any, args: any): any {
          realm.bridgeCalls++;
          const length = args.length;
          if (length === 0) return callable.call(receiver);
          if (length === 1) return callable.call(receiver, args[0]);
          if (length === 2) return callable.call(receiver, args[0], args[1]);
          if (length === 3) return callable.call(receiver, args[0], args[1], args[2]);
          if (length === 4) return callable.call(receiver, args[0], args[1], args[2], args[3]);
          throw new RangeError("context call supports at most four arguments in this canary");
        }
        export function localCall(): any { return ${CONTEXT_CALL}(realm.increment, realm, [realm.answer]); }
        export function bridgeCalls(): number { return realm.bridgeCalls; }
      `,
      "context.ts",
    );
    const reader = await compileStandalone(
      `
        const realm = globalThis;
        export function read() { return realm.answer; }
        export function call() { return realm.increment(realm.answer); }
        export function bareRead() { return dynamicAnswer; }
        export function bareCall() { return dynamicIncrement(dynamicAnswer); }
        export function localCall() { const local = () => 5; return local(); }
      `,
      "reader.js",
      true,
    );

    const { instance: contextInstance } = await WebAssembly.instantiate(context.binary, {});
    const getter = contextInstance.exports[CONTEXT_GETTER];
    const call = contextInstance.exports[CONTEXT_CALL];
    expect(typeof getter).toBe("function");
    expect(typeof call).toBe("function");
    expect((contextInstance.exports.localCall as () => number)()).toBe(42);
    expect((contextInstance.exports.bridgeCalls as () => number)()).toBe(1);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(reader.binary))).toContainEqual({
      module: CONTEXT_MODULE,
      name: CONTEXT_CALL,
      kind: "function",
    });
    const imports = {
      [CONTEXT_MODULE]: {
        [CONTEXT_GETTER]: getter,
        [CONTEXT_CALL]: call,
      },
    } as WebAssembly.Imports;
    const { instance: readerInstance } = await WebAssembly.instantiate(reader.binary, imports);

    expect((readerInstance.exports.read as () => number)()).toBe(40);
    expect((readerInstance.exports.call as () => number)()).toBe(42);
    expect((contextInstance.exports.bridgeCalls as () => number)()).toBe(2);
    expect((readerInstance.exports.bareRead as () => number)()).toBe(40);
    expect((readerInstance.exports.bareCall as () => number)()).toBe(42);
    expect((contextInstance.exports.bridgeCalls as () => number)()).toBe(3);
    expect((readerInstance.exports.localCall as () => number)()).toBe(5);
    expect((contextInstance.exports.bridgeCalls as () => number)()).toBe(3);
  });

  it("declares only the exact linked context surface", async () => {
    const result = await compileStandalone(`export function global() { return globalThis; }`, "consumer.js", true);
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary));
    expect(imports).toEqual([
      {
        module: CONTEXT_MODULE,
        name: CONTEXT_GETTER,
        kind: "function",
      },
      {
        module: CONTEXT_MODULE,
        name: CONTEXT_CALL,
        kind: "function",
      },
    ]);
  });
});
