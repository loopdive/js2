export const cases = [
  {
    name: "borrowed native next rejects invalid receivers",
    source: `function test(){function* base(){yield 1;}var gen=base();var next=gen.next;var caught=0;try{next.call(null);}catch(e){if(e instanceof TypeError)caught++;}try{next.call(3);}catch(e){if(e instanceof TypeError)caught++;}try{next.call({});}catch(e){if(e instanceof TypeError)caught++;}return caught===3&&gen.next().value===1?1:0;}`,
  },
  {
    name: "borrowed iterator method returns arbitrary receiver",
    source: `function test(){function* base(){yield 1;}var gen=base();var method=gen[Symbol.iterator];var receiver={};return method.call(receiver)===receiver&&method.call(null)===null&&method.call(3)===3?1:0;}`,
  },
  {
    name: "prototype next override is inherited",
    source: `function test(){function* base(){yield 1;}var gen=base();var proto=Object.getPrototypeOf(gen);proto.next=function(){return {done:true,value:19};};var result=gen.next();return result.done===true&&result.value===19?1:0;}`,
  },

  {
    name: "nested native generic raw result identity",
    source: `function test(){var reads=0;var raw={get done(){reads++;return false;},value:23};var iterator={next:function(){return raw;}};var iterable={};iterable[Symbol.iterator]=function(){return iterator;};function* inner(){yield* iterable;}function* outer(){yield* inner();}var result=outer().next();return result===raw&&reads===2?1:0;}`,
  },
  {
    name: "own next override affects direct call and delegation",
    source: `function test(){function* base(){yield 1;}var gen=base();var calls=0;gen.next=function(){calls++;return {done:true,value:9};};function* outer(){return yield* gen;}var direct=gen.next();var delegated=outer().next();return calls===2&&direct.value===9&&delegated.value===9&&delegated.done===true?1:0;}`,
  },
  {
    name: "undefined next shadows until deleted",
    source: `function test(){function* base(){yield 1;}var gen=base();var original=gen.next;gen.next=undefined;var caught=0;function* outer(){yield* gen;}try{outer().next();}catch(e){if(e instanceof TypeError)caught++;}try{gen.next();}catch(e){if(e instanceof TypeError)caught++;}delete gen.next;var result=gen.next();return caught===2&&result.value===1&&gen.next===original?1:0;}`,
  },
  {
    name: "own return accessor observes generator receiver",
    source: `function test(){var gets=0,calls=0;function* base(){yield 1;}var gen=base();Object.defineProperty(gen,'return',{configurable:true,get:function(){if(this===gen)gets++;return function(value){if(this===gen&&value===9)calls++;return {done:true,value:12};};}});function* outer(){yield* gen;}var delegated=outer();delegated.next();var result=delegated.return(9);return gets===1&&calls===1&&result.done===true&&result.value===12?1:0;}`,
  },
  {
    name: "shared next closure uses borrowed receiver",
    source: `function test(){function* first(){yield 1;}function* second(){yield 2;}var a=first(),b=second();var next=a.next;var same=next===b.next;var result=next.call(b);return same&&result.value===2&&a.next().value===1?1:0;}`,
  },
  {
    name: "own null and symbol iterator undefined suppress native defaults",
    source: `function test(){function* base(){yield 1;}var gen=base(),caught=0;gen.next=null;try{gen.next();}catch(e){if(e instanceof TypeError)caught++;}delete gen.next;gen[Symbol.iterator]=undefined;function* outer(){yield* gen;}try{outer().next();}catch(e){if(e instanceof TypeError)caught++;}return caught===2&&gen.next().value===1?1:0;}`,
  },
];
