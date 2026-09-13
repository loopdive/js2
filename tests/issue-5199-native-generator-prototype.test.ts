// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const cases = [
  {
    name: "inherited next getter has source receiver",
    source: `function* base(){yield 1;}function test(){var g=base(),gets=0,calls=0;var p=Object.create(Object.getPrototypeOf(g));Object.defineProperty(p,'next',{get:function(){if(this===g)gets++;return function(){if(this===g)calls++;return {done:true,value:17};};}});Object.setPrototypeOf(g,p);var r=g.next();return gets===1&&calls===1&&r.value===17?1:0;}`,
  },
  {
    name: "inherited undefined and null shadow until deletion",
    source: `function* base(){yield 1;}function test(){var g=base(),p=Object.create(Object.getPrototypeOf(g)),caught=0;Object.setPrototypeOf(g,p);p.next=undefined;try{g.next();}catch(e){if(e instanceof TypeError)caught++;}p.next=null;try{g.next();}catch(e){if(e instanceof TypeError)caught++;}delete p.next;return caught===2&&g.next().value===1?1:0;}`,
  },
  {
    name: "native generator prototype identity and null replacement",
    source: `function* base(){yield 1;}function identity(x){return Object.getPrototypeOf(x);}function test(){var g=base(),p={};var a=Object.setPrototypeOf(g,p)===g&&identity(g)===p;Object.setPrototypeOf(g,null);return a&&identity(g)===null&&g.next===undefined?1:0;}`,
  },
  {
    name: "generator-valued prototypes preserve identity",
    source: `function* base(){yield 1;}function test(){var a=base(),b=base();a.marker=17;Object.setPrototypeOf(b,a);var o=Object.create(a);return Object.getPrototypeOf(b)===a&&Object.getPrototypeOf(o)===a&&b.marker===17&&o.marker===17?1:0;}`,
  },
  {
    name: "generator prototype cycles throw",
    source: `function* base(){yield 1;}function test(){var a=base(),b=base(),caught=0;Object.setPrototypeOf(a,b);try{Object.setPrototypeOf(b,a);}catch(e){if(e instanceof TypeError)caught++;}try{Object.setPrototypeOf(a,a);}catch(e){if(e instanceof TypeError)caught++;}return caught===2&&Object.getPrototypeOf(a)===b?1:0;}`,
  },
  {
    name: "nonextensible generator prototype preserves same value",
    source: `function* base(){yield 1;}function test(){var g=base(),p=Object.getPrototypeOf(g),caught=0;Object.preventExtensions(g);var same=Object.setPrototypeOf(g,p)===g;try{Object.setPrototypeOf(g,{});}catch(e){if(e instanceof TypeError)caught++;}return same&&caught===1&&!Object.isExtensible(g)&&Object.getPrototypeOf(g)===p?1:0;}`,
  },
  {
    name: "per-factory default prototypes are distinct",
    source: `function* first(){yield 1;}function* second(){yield 2;}function test(){var a=first(),b=second();return first.prototype!==second.prototype&&Object.getPrototypeOf(a)===first.prototype&&Object.getPrototypeOf(b)===second.prototype&&Object.getPrototypeOf(first.prototype)===Object.getPrototypeOf(second.prototype)?1:0;}`,
  },
  {
    name: "factory prototype mutation affects new instances only",
    source: `function* base(){yield 1;}function test(){var a=base(),old=base.prototype,p={};base.prototype=p;var b=base();return Object.getPrototypeOf(a)===old&&Object.getPrototypeOf(b)===p?1:0;}`,
  },
  {
    name: "extracted next valid and invalid receivers",
    source: `function* base(){yield 1;yield 2;}function test(){var g=base(),next=g.next,caught=0;if(typeof next!=='function')return 0;var a=next.call(g);try{next.call(null);}catch(e){if(e instanceof TypeError)caught++;}try{next.call(3);}catch(e){if(e instanceof TypeError)caught++;}try{next.call({});}catch(e){if(e instanceof TypeError)caught++;}return a.value===1&&a.done===false&&caught===3&&g.next().value===2?1:0;}`,
  },
  {
    name: "factory primitive prototype stays public with intrinsic fallback",
    source: `function* base(){yield 1;}function test(){var intrinsic=Object.getPrototypeOf(base.prototype);base.prototype=undefined;var a=base();var one=base.prototype===undefined&&Object.getPrototypeOf(a)===intrinsic;base.prototype=null;var b=base();return one&&base.prototype===null&&Object.getPrototypeOf(b)===intrinsic?1:0;}`,
  },
  {
    name: "factory prototype descriptor and alias bracket identity",
    source: `function* base(){yield 1;}function test(){var alias=base,d=Object.getOwnPropertyDescriptor(alias,'prototype');var p=alias['prototype'];return d&&d.value===p&&d.writable===true&&d.enumerable===false&&d.configurable===false&&Object.getPrototypeOf(base())===p?1:0;}`,
  },
  {
    name: "object generator method with trailing comma remains callable",
    source: `function test(){var calls=0,obj={*method(a,){if(a===42)calls=calls+1;}};obj.method(42,39).next();var ref=obj.method;return calls===1&&typeof ref==='function'?1:0;}`,
  },
  {
    name: "object generator method preserves default parameter evaluation",
    source: `function test(){var obj={*method(x,y=x,z=y){return x===3&&y===3&&z===3?1:0;}};var r=obj.method(3).next();return r.done===true&&r.value===1?1:0;}`,
  },
  {
    name: "object method protocol coexists with a free generator factory",
    source: `function* free(){yield 1;}function test(){var method={*method(){yield 2;}}.method;return typeof method==='function'&&free().next().value===1&&method().next().value===2?1:0;}`,
  },
];

describe("#5199 native generator factory/prototype bridge", () => {
  for (const item of cases) {
    it(item.name, async () => {
      const source = item.source.replace("function test()", "export function test()");
      const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      expect(result.imports).toEqual([]);
      expect(WebAssembly.validate(result.binary!)).toBe(true);
      const { instance } = await WebAssembly.instantiate(result.binary!, {});
      expect((instance.exports.test as () => number)()).toBe(1);
    });
  }
});
