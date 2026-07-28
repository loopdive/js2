function makeCounter() {
  let total = 0;
  return function* () {
    while (true) {
      total += 1;
      yield total;
    }
  };
}
const start = makeCounter();
const g1 = start();
const g2 = start();
console.log(g1.next().value);
console.log(g1.next().value);
console.log(g2.next().value);
console.log(g1.next().value);
