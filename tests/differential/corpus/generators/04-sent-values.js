function* echo() {
  let received = [];
  let x = yield "ready";
  while (x !== "stop") {
    received.push(x);
    x = yield received.length;
  }
  return received;
}
const g = echo();
console.log(g.next().value);
console.log(g.next("a").value);
console.log(g.next("b").value);
const last = g.next("stop");
console.log(last.value.join(","));
console.log(last.done);
