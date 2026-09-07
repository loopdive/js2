export const cases = [
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
];
cases.push({
  name: "extracted next valid and invalid receivers",
  source: `function* base(){yield 1;yield 2;}function test(){var g=base(),next=g.next,caught=0;if(typeof next!=='function')return 0;var a=next.call(g);try{next.call(null);}catch(e){if(e instanceof TypeError)caught++;}try{next.call(3);}catch(e){if(e instanceof TypeError)caught++;}try{next.call({});}catch(e){if(e instanceof TypeError)caught++;}return a.value===1&&a.done===false&&caught===3&&g.next().value===2?1:0;}`,
});
cases.push({
  name: "factory primitive prototype stays public with intrinsic fallback",
  source: `function* base(){yield 1;}function test(){var intrinsic=Object.getPrototypeOf(base.prototype);base.prototype=undefined;var a=base();var one=base.prototype===undefined&&Object.getPrototypeOf(a)===intrinsic;base.prototype=null;var b=base();return one&&base.prototype===null&&Object.getPrototypeOf(b)===intrinsic?1:0;}`,
});
cases.push({
  name: "factory prototype descriptor and alias bracket identity",
  source: `function* base(){yield 1;}function test(){var alias=base,d=Object.getOwnPropertyDescriptor(alias,'prototype');var p=alias['prototype'];return d&&d.value===p&&d.writable===true&&d.enumerable===false&&d.configurable===false&&Object.getPrototypeOf(base())===p?1:0;}`,
});
