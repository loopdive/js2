export const cases = [
  {
    name: "numeric suspended return preserves open object",
    source: `function* g(){yield 1;}function test(){var conversions=0;var payload={};payload.valueOf=function(){conversions++;return 7;};var gen=g();gen.next();var result=gen.return(payload);return result.done===true&&result.value===payload&&conversions===0?1:0;}`,
  },
  {
    name: "numeric completed return preserves open object",
    source: `function* g(){yield 1;}function test(){var conversions=0;var payload={};payload.valueOf=function(){conversions++;return 7;};var gen=g();gen.next();gen.next();var result=gen.return(payload);return result.done===true&&result.value===payload&&conversions===0?1:0;}`,
  },
  {
    name: "numeric ignored next payload does not convert object",
    source: `function* g(){yield 1;yield 2;}function test(){var conversions=0;var payload={};payload.valueOf=function(){conversions++;return 7;};var gen=g();gen.next();var result=gen.next(payload);return result.value===2&&conversions===0?1:0;}`,
  },
];
