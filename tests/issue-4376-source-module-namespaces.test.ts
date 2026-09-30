import { expect, it } from "vitest";
import { compileMultiSource } from "../src/compiler.js";
import {
  compilerPath,
  GRAPH_CAN_ACCESS_EXPORT,
  GRAPH_CAN_CALL_EXPORT,
  GRAPH_CALL_EXPORT,
  GRAPH_GET_EXPORT,
  GRAPH_SET_EXPORT,
  GRAPH_GET_PROTOTYPE_EXPORT,
  GRAPH_SET_PROTOTYPE_EXPORT,
  GRAPH_NAMESPACE_REGISTRY,
  prepareNamespaceGraph,
} from "../examples/v8x-js2wasm-spike/compile-graph.js";

it.each(["closed", "open"])(
  "publishes native source namespaces with %s prototype objects",
  async (prototypeCarrier) => {
    const graph = prepareNamespaceGraph(
      new Map([
        [
          "ext:app/main.js",
          `import { bump } from './dep.js';
      export function run() {
        const registry=globalThis.${GRAPH_NAMESPACE_REGISTRY};
        const ns=registry['ext:app/dep.js'];
        if(ns===undefined) return -10;
        if(ns.default===undefined) return -11;
        if(ns.value!==41 || ns.bump!==bump || ns.default.answer!==42) return -1;
        ns.bump();
        return ns===registry['ext:app/dep.js'] && ns.value===42 ? 42 : -2;
      }`,
        ],
        [
          "ext:app/dep.js",
          `export let value=41; export function bump(){value++;}
        export const marker=Object.freeze({token:17}); export function fail(){throw marker;}
        export const proto={inherited:7};
        export const otherProto=${prototypeCarrier === "open" ? "Object.create(null); otherProto.inherited=8" : "{inherited:8}"};
        const box={answer:42, make(){return function(x){return this.base+x;};}};
        Object.setPrototypeOf(box,proto); export default box;`,
        ],
        ["ext:app/lazy.js", "throw new Error('disconnected module executed'); export const unused=0;"],
      ]),
      "ext:app/main.js",
    );
    expect(Object.values(graph.projectResolutions[graph.entry]!)).not.toContain(compilerPath("ext:app/lazy.js"));
    expect(graph.files[graph.entry]).not.toContain("ext:app/lazy.js");
    graph.files[graph.entry] += `\nexport function namespaceProbe():number {
    const ns:any=(globalThis as any).${GRAPH_NAMESPACE_REGISTRY}['ext:app/main.js'];
    if(ns===undefined) return -20;
    if(typeof ns.run!=='function') return -21;
    const result = ns.run();
    const dep:any=(globalThis as any).${GRAPH_NAMESPACE_REGISTRY}['ext:app/dep.js'];
    // This closure has the same call shape but no export/observed-value identity.
    const foreign=function(){return 1;};
    if(${GRAPH_CAN_CALL_EXPORT}(foreign)!==0) return -30;
    if(${GRAPH_CAN_ACCESS_EXPORT}({answer:42})!==0) return -31;
    if(${GRAPH_CAN_CALL_EXPORT}(dep.bump)!==1) return -32;
    if(${GRAPH_CALL_EXPORT}(dep.bump,undefined,[])!==undefined) return -33;
    if(dep.value!==43) return -34;
    if(${GRAPH_SET_EXPORT}(dep,'value',0)!==false || dep.value!==43) return -42;
    const object:any=${GRAPH_GET_EXPORT}(dep,'default');
    if(${GRAPH_GET_EXPORT}(object,'answer')!==42) return -35;
    if(${GRAPH_SET_EXPORT}(object,'answer',43)!==true || ${GRAPH_GET_EXPORT}(object,'answer')!==43) return -40;
    if(!Object.isFrozen(dep.marker)) return -44;
    if(${GRAPH_SET_EXPORT}(dep.marker,'token',18)!==false) return -41;
    if(dep.marker.token!==17) return -43;
    if(${GRAPH_GET_PROTOTYPE_EXPORT}(dep)!==null) return -50;
    if(${GRAPH_SET_PROTOTYPE_EXPORT}(dep,null)!==true || ${GRAPH_SET_PROTOTYPE_EXPORT}(dep,dep.proto)!==false) return -51;
    if(${GRAPH_GET_PROTOTYPE_EXPORT}(object)!==dep.proto || ${GRAPH_GET_EXPORT}(object,'inherited')!==7) return -52;
    if(${GRAPH_SET_PROTOTYPE_EXPORT}(object,dep.otherProto)!==true) return -53;
    if(${GRAPH_GET_PROTOTYPE_EXPORT}(object)!==dep.otherProto) return -54;
    if(${GRAPH_GET_EXPORT}(object,'inherited')!==8) return -57;
    if(${GRAPH_SET_PROTOTYPE_EXPORT}(dep.otherProto,object)!==false) return -55;
    if(${GRAPH_SET_PROTOTYPE_EXPORT}(dep.marker,dep.proto)!==false) return -56;
    const child:any=Object.create(object);
    if(child.inherited!==8 || !('inherited' in child)) return -60;
    dep.otherProto.inherited=9;
    if(child.inherited!==9 || ${GRAPH_GET_EXPORT}(object,'inherited')!==9) return -61;
    if(${GRAPH_SET_PROTOTYPE_EXPORT}(object,null)!==true || ${GRAPH_GET_PROTOTYPE_EXPORT}(object)!==null) return -62;
    if(child.inherited!==undefined) return -63;
    if('inherited' in child) return -65;
    if('toString' in child) return -66;
    if(${GRAPH_SET_PROTOTYPE_EXPORT}(object,dep.otherProto)!==true || child.inherited!==9) return -64;
    const make:any=${GRAPH_GET_EXPORT}(object,'make');
    const closure:any=${GRAPH_CALL_EXPORT}(make,object,[]);
    if(${GRAPH_CAN_CALL_EXPORT}(closure)!==1) return -36;
    if(${GRAPH_CALL_EXPORT}(closure,{base:40},[2])!==42) return -37;
    try { ${GRAPH_CALL_EXPORT}(dep.fail,undefined,[]); return -38; }
    catch(error) { if(error!==dep.marker) return -39; }
    return result;
  }`;
    const result = await compileMultiSource(
      graph.files,
      graph.entry,
      {
        target: "standalone",
        platform: "deno",
        allowJs: true,
        hostBridge: "always",
        skipSemanticDiagnostics: true,
        deferTopLevelInit: true,
      },
      undefined,
      graph.projectResolutions,
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
    expect(instance.exports.run).toBeTypeOf("function");
    (result.importObject as { __setInstance?: (instance: WebAssembly.Instance) => void })?.__setInstance?.(instance);
    try {
      (instance.exports.__module_init as () => void)();
      expect((instance.exports.namespaceProbe as () => number)()).toBe(42);
    } catch (error: any) {
      if (error.getArg && instance.exports.__exn_render_prepare) {
        const payload = error.getArg(instance.exports.__exn_tag, 0);
        const length = (instance.exports.__exn_render_prepare as (payload: unknown) => number)(payload);
        const char = instance.exports.__exn_render_char as (index: number) => number;
        throw new Error(Array.from({ length }, (_, index) => String.fromCharCode(char(index))).join(""));
      }
      throw error;
    }
  },
);
