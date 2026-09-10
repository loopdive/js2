import { beforeAll, expect, it } from "vitest";
import { compile } from "../src/index.js";

let exports: Record<string, () => number>;
beforeAll(async () => {
  const result = await compile(
    `
var Node = function Node(parser,pos,loc) {
 this.type="";this.start=pos;this.end=0;
 if(parser.options.locations)this.loc={start:loc};
 if(parser.options.directSourceFile)this.sourceFile=parser.options.directSourceFile;
 if(parser.options.ranges)this.range=[pos,0];
};
function Parser(){this.options={locations:false,ranges:false};this.startLoc=undefined;}
Parser.prototype.copyNode=function(node) {
 var newNode=new Node(this,node.start,this.startLoc);
 for(var prop in node)newNode[prop]=node[prop];
 return newNode;
};
var original, copied;
function read(node,key){return node[key];}
export function prepare() {
 var parser=new Parser();
 original=new Node(parser,6,undefined);
 original.type="Identifier";original.name="a";original.end=7;
 copied=parser.copyNode(original);
 return 1;
}
export function originalType(){return original.type==="Identifier"?1:0;}
export function originalStart(){return +original.start;}
export function dynamicType(){return read(original,"type")==="Identifier"?1:0;}
export function dynamicStart(){return +read(original,"start");}
export function copiedType(){return copied.type==="Identifier"?1:0;}
export function copiedStart(){return +copied.start;}
export function copiedEnd(){return +copied.end;}
export function copiedName(){return copied.name==="a"?1:0;}
`,
    {
      target: "standalone",
      platform: "deno",
      hostBridge: "always",
      allowJs: true,
      skipSemanticDiagnostics: true,
      fileName: "copy.mjs",
    },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  exports = instance.exports as typeof exports;
  expect(exports.prepare()).toBe(1);
});

for (const [name, value] of Object.entries({
  originalType: 1,
  originalStart: 6,
  dynamicType: 1,
  dynamicStart: 6,
  copiedType: 1,
  copiedStart: 6,
  copiedEnd: 7,
  copiedName: 1,
})) {
  it(`preserves ${name}`, () => expect(exports[name]()).toBe(value));
}
