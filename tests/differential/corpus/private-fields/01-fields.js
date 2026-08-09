class Counter {
  #count = 0;
  increment() {
    this.#count += 1;
  }
  get value() {
    return this.#count;
  }
}
const c = new Counter();
c.increment();
c.increment();
c.increment();
console.log(c.value);
console.log(JSON.stringify(c));
