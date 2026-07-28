class Adder {
  #value = 0;
  #add(n) {
    this.#value += n;
  }
  addTwice(n) {
    this.#add(n);
    this.#add(n);
  }
  get() {
    return this.#value;
  }
}
const a = new Adder();
a.addTwice(5);
a.addTwice(3);
console.log(a.get());
