// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const cases = [
  {
    name: "for-of rechecks delegated result done before reading value",
    source: `function test() {
      var doneReads = 0, valueReads = 0, iterations = 0;
      var raw = { get done() { doneReads++; return doneReads > 1; }, get value() { valueReads++; return 3; } };
      var iterator = { next: function() { return raw; } };
      var iterable = {}; iterable[Symbol.iterator] = function() { return iterator; };
      function* g() { yield* iterable; }
      for (var value of g()) { iterations++; }
      return doneReads === 2 && valueReads === 0 && iterations === 0 ? 1 : 0;
    }`,
  },
  {
    name: "direct next done property observes the original getter again",
    source: `function test() {
      var doneReads = 0;
      var raw = { get done() { doneReads++; return doneReads > 1; } };
      var iterator = { next: function() { return raw; } };
      var iterable = {}; iterable[Symbol.iterator] = function() { return iterator; };
      function* g() { yield* iterable; }
      var done = g().next().done;
      return doneReads === 2 && done === true ? 1 : 0;
    }`,
  },
  {
    name: "next preserves result identity without reading value",
    source: `function test() {
      var doneReads = 0, valueReads = 0;
      var raw = { get done() { doneReads++; return false; }, get value() { valueReads++; return 3; } };
      var iterator = { next: function() { return raw; } };
      var iterable = {}; iterable[Symbol.iterator] = function() { return iterator; };
      function* g() { return yield* iterable; }
      var result = g().next(9876);
      return result === raw && doneReads === 1 && valueReads === 0 ? 1 : 0;
    }`,
  },
  {
    name: "next method is captured and receives one argument",
    source: `function test() {
      var calls = 0, good = 0;
      var iterator = { next: function(value) {
        calls++;
        if (this === iterator && arguments.length === 1 && value === (calls === 1 ? undefined : 17)) good++;
        return { value: calls === 1 ? 3 : 42, done: calls === 2 };
      } };
      var iterable = {}; iterable[Symbol.iterator] = function() { return iterator; };
      function* g() { return yield* iterable; }
      var gen = g(); gen.next(999);
      iterator.next = function() { throw 123; };
      var result = gen.next(17);
      return good === 2 && calls === 2 && result.done === true && result.value === 42 ? 1 : 0;
    }`,
  },
  {
    name: "throw forwards raw non-done result and receiver",
    source: `function test() {
      var doneReads = 0, valueReads = 0, good = 0;
      var raw = { get done() { doneReads++; return false; }, get value() { valueReads++; return 8; } };
      var iterator = { next: function() { return { done: false }; }, throw: function(value) {
        if (this === iterator && arguments.length === 1 && value === 9) good++;
        return raw;
      } };
      var iterable = {}; iterable[Symbol.iterator] = function() { return iterator; };
      function* g() { yield* iterable; }
      var gen = g(); gen.next(); var result = gen.throw(9);
      return result === raw && good === 1 && doneReads === 1 && valueReads === 0 ? 1 : 0;
    }`,
  },
  {
    name: "missing throw closes without inspecting cleanup result",
    source: `function test() {
      var good = 0, caught = 0;
      var iterator = { next: function() { return { done: false }; }, return: function() {
        if (this === iterator && arguments.length === 0) good++;
        return { get done() { throw 123; }, get value() { throw 456; } };
      } };
      var iterable = {}; iterable[Symbol.iterator] = function() { return iterator; };
      function* g() { yield* iterable; }
      var gen = g(); gen.next();
      try { gen.throw(9); } catch (error) { if (error instanceof TypeError) caught++; }
      return good === 1 && caught === 1 ? 1 : 0;
    }`,
  },
  {
    name: "false throw is noncallable rather than absent",
    source: `function test() {
      var closed = 0, caught = 0;
      var iterator = { next: function() { return { done: false }; }, throw: false,
        return: function() { closed++; return {}; } };
      var iterable = {}; iterable[Symbol.iterator] = function() { return iterator; };
      function* g() { yield* iterable; }
      var gen = g(); gen.next();
      try { gen.throw(9); } catch (error) { if (error instanceof TypeError) caught++; }
      return closed === 0 && caught === 1 ? 1 : 0;
    }`,
  },
  {
    name: "return with done false suspends and next resumes delegate",
    source: `function test() {
      var good = 0, calls = 0;
      var raw = { value: 33, done: false };
      var iterator = { next: function(value) {
        calls++; if (calls === 2 && value === 17) good++;
        return { value: calls === 2 ? 42 : 3, done: calls === 2 };
      }, return: function(value) {
        if (this === iterator && arguments.length === 1 && value === 9) good++;
        return raw;
      } };
      var iterable = {}; iterable[Symbol.iterator] = function() { return iterator; };
      function* g() { return yield* iterable; }
      var gen = g(); gen.next(); var returned = gen.return(9); var final = gen.next(17);
      return returned === raw && good === 2 && final.done === true && final.value === 42 ? 1 : 0;
    }`,
  },
  {
    name: "missing return propagates outer return payload",
    source: `function test() {
      var iterator = { next: function() { return { done: false }; } };
      var iterable = {}; iterable[Symbol.iterator] = function() { return iterator; };
      function* g() { yield* iterable; return 100; }
      var gen = g(); gen.next(); var result = gen.return(9);
      return result.done === true && result.value === 9 ? 1 : 0;
    }`,
  },
  {
    name: "return done true uses delegate completion value",
    source: `function test() {
      var reads = 0;
      var iterator = { next: function() { return { done: false }; }, return: function(value) {
        return { done: true, get value() { reads++; return 42; } };
      } };
      var iterable = {}; iterable[Symbol.iterator] = function() { return iterator; };
      function* g() { yield* iterable; return 100; }
      var gen = g(); gen.next(); var result = gen.return(9);
      return result.done === true && result.value === 42 && reads === 1 ? 1 : 0;
    }`,
  },
  {
    name: "zero return is noncallable rather than absent",
    source: `function test() {
      var caught = 0;
      var iterator = { next: function() { return { done: false }; }, return: 0 };
      var iterable = {}; iterable[Symbol.iterator] = function() { return iterator; };
      function* g() { yield* iterable; }
      var gen = g(); gen.next();
      try { gen.return(9); } catch (error) { if (error instanceof TypeError) caught++; }
      return caught === 1 ? 1 : 0;
    }`,
  },
  {
    name: "missing throw argument forwards undefined rather than null",
    source:
      "function test(){var received=0;var iterator={next:function(){return {done:false};},throw:function(value){if(value===undefined&&arguments.length===1)received++;return {done:true,value:12};}};var iterable={};iterable[Symbol.iterator]=function(){return iterator;};function* g(){yield* iterable;}var gen=g();gen.next();var result=gen.throw();return received===1&&result.done===true?1:0;}",
  },
  {
    name: "shorthand next method",
    source:
      "function test(){ var i=0;var iterator={next(v){return {value:++i,done:i>1};}};var iterable={};iterable[Symbol.iterator]=function(){return iterator;};function* g(){yield* iterable;}var gen=g();var first=gen.next();var last=gen.next();return first.value===1&&first.done===false&&last.done===true?1:0;}",
  },
  {
    name: "forof second done getter throw does not close",
    source:
      "function test(){var reads=0,closed=0,caught=0;var raw={get done(){if(++reads===2)throw 17;return false;},get value(){throw 18;}};var iterator={next:function(){return raw;},return:function(){closed++;return {done:true};}};var iterable={};iterable[Symbol.iterator]=function(){return iterator;};function* g(){yield* iterable;}try{for(var x of g()){} }catch(e){if(e===17)caught++;}return reads===2&&closed===0&&caught===1?1:0;}",
  },
  {
    name: "raw result destructuring bracket and helper property reads",
    source:
      "function test(){var reads=0;var raw={get done(){reads++;return false;},value:23};var iterator={next:function(){return raw;}};var iterable={};iterable[Symbol.iterator]=function(){return iterator;};function* g(){yield* iterable;}function read(r){return r['value'];}var result=g().next();var {value,done}=result;return value===23&&done===false&&read(result)===23&&result['done']===false&&reads===3?1:0;}",
  },
  {
    name: "yield star caught delegated next getter error",
    source:
      "function test(){var iterator={get next(){throw 17;}};var iterable={};iterable[Symbol.iterator]=function(){return iterator;};function* g(){try{yield* iterable;}catch(e){yield e;}}var gen=g();var result=gen.next();return result.value===17&&result.done===false&&gen.next().done===true?1:0;}",
  },
  {
    name: "yield star finally on absent delegated throw",
    source:
      "function test(){var closed=0,finalized=0,caught=0;var iterator={next:function(){return {done:false};},return:function(){closed++;return {};}};var iterable={};iterable[Symbol.iterator]=function(){return iterator;};function* g(){try{yield* iterable;}finally{finalized++;}}var gen=g();gen.next();try{gen.throw(17);}catch(e){if(e instanceof TypeError)caught++;}return closed===1&&finalized===1&&caught===1?1:0;}",
  },
  {
    name: "opaque next preserves object payload without ToPrimitive (open-object identity control)",
    source:
      "function test(){var conversions=0,seen=0;var payload={};payload.valueOf=function(){conversions++;return 7;};var iterator={next:function(v){if(v===payload)seen++;return {done:false};}};var iterable={};iterable[Symbol.iterator]=function(){return iterator;};var g=function*(){yield* iterable;};var gen=g();gen.next();gen.next(payload);return seen===1&&conversions===0?1:0;}",
  },
  {
    name: "opaque return preserves object payload without ToPrimitive (open-object identity control)",
    source:
      "function test(){var conversions=0,seen=0;var payload={};payload.valueOf=function(){conversions++;return 7;};var iterator={next:function(){return {done:false};},return:function(v){if(v===payload)seen++;return {done:true};}};var iterable={};iterable[Symbol.iterator]=function(){return iterator;};var g=function*(){yield* iterable;};var gen=g();gen.next();gen.return(payload);return seen===1&&conversions===0?1:0;}",
  },
  {
    name: "reentrant next rejects before mutating active frame",
    source:
      "function test(){var attempts=0,caught=0;var iterable={};var g=function*(){yield* iterable;};var gen=g();var iterator={next:function(){if(attempts++===0){try{gen.next();}catch(e){if(e instanceof TypeError)caught++;}}return {value:1,done:false};}};iterable[Symbol.iterator]=function(){return iterator;};gen.next();return caught===1&&attempts===1?1:0;}",
  },
  {
    name: "reentrant return rejects before mutating active frame",
    source:
      "function test(){var attempts=0,caught=0;var iterable={};var g=function*(){yield* iterable;};var gen=g();var iterator={next:function(){if(attempts++===0){try{gen.return();}catch(e){if(e instanceof TypeError)caught++;}}return {value:1,done:false};}};iterable[Symbol.iterator]=function(){return iterator;};gen.next();return caught===1&&attempts===1?1:0;}",
  },
  {
    name: "reentrant throw rejects before mutating active frame",
    source:
      "function test(){var attempts=0,caught=0;var iterable={};var g=function*(){yield* iterable;};var gen=g();var iterator={next:function(){if(attempts++===0){try{gen.throw();}catch(e){if(e instanceof TypeError)caught++;}}return {value:1,done:false};}};iterable[Symbol.iterator]=function(){return iterator;};gen.next();return caught===1&&attempts===1?1:0;}",
  },
  {
    name: "missing next payload is undefined",
    source:
      "function test(){var seen=0;var iterator={next:function(v){if(v===undefined&&arguments.length===1)seen++;return {done:false};},return:function(v){if(v===undefined&&arguments.length===1)seen++;return {done:true};}};var iterable={};iterable[Symbol.iterator]=function(){return iterator;};var g=function*(){yield* iterable;};var gen=g();gen.next();gen.next();return seen===2?1:0;}",
  },
  {
    name: "missing return payload is undefined",
    source:
      "function test(){var seen=0;var iterator={next:function(v){if(v===undefined&&arguments.length===1)seen++;return {done:false};},return:function(v){if(v===undefined&&arguments.length===1)seen++;return {done:true};}};var iterable={};iterable[Symbol.iterator]=function(){return iterator;};var g=function*(){yield* iterable;};var gen=g();gen.next();gen.return();return seen===2?1:0;}",
  },
  {
    name: "numeric completion value in mixed generic module is undefined",
    source:
      "function* numeric(){yield 1;} function test(){var iterator={next:function(){return {done:false};}};var iterable={};iterable[Symbol.iterator]=function(){return iterator;};function* generic(){yield* iterable;}generic().next();var gen=numeric();gen.next();var result=gen.next();return result.done===true&&result.value===undefined?1:0;}",
  },
  {
    name: "caught delegate failure reacquires iterator on later loop entry",
    source:
      "function test(){var started=0,caught=0;var iterable={};iterable[Symbol.iterator]=function(){started++;return {next:function(){throw 7;}};};function* g(){for(var i=0;i<2;i++){try{yield* iterable;}catch(e){if(e===7)caught++;}}yield 1;}var result=g().next();return result.value===1&&started===2&&caught===2?1:0;}",
  },
  {
    name: "return yield star completion executes finally once",
    source:
      "function test(){var finalized=0;var iterable={};iterable[Symbol.iterator]=function(){return {next:function(){return {done:true,value:17};}};};function* g(){try{return yield* iterable;}finally{finalized++;}}var result=g().next();return result.done===true&&result.value===17&&finalized===1?1:0;}",
  },
];

describe("#5199 generic yield-star native protocol", () => {
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
