// ═══════════════════════════════════════════════════════
// Classes — constructors, inheritance, private fields,
// getters/setters, static methods, instanceof
// ═══════════════════════════════════════════════════════
//
// js2 maps each class to a WasmGC `struct` and uses `ref.cast` for
// `instanceof` checks. Private fields (#field) become non-exported
// struct slots, so they are truly inaccessible from outside the class.
// Static methods compile to ordinary exported functions.

class Animal {
  #name: string;
  #age: number;

  constructor(name: string, age: number) {
    this.#name = name;
    this.#age = age;
  }

  // Getter — accessed without parentheses.
  get name(): string {
    return this.#name;
  }

  // Setter — assigned to like a field.
  set name(value: string) {
    this.#name = value;
  }

  get age(): number {
    return this.#age;
  }

  speak(): string {
    return this.#name + " makes a sound";
  }

  // Static method — called on the class, not the instance.
  static kingdom(): string {
    return "Animalia";
  }
}

class Dog extends Animal {
  #breed: string;

  constructor(name: string, age: number, breed: string) {
    super(name, age); // call the parent constructor
    this.#breed = breed;
  }

  // Override and chain to super.
  speak(): string {
    return super.speak() + " — woof!";
  }

  get breed(): string {
    return this.#breed;
  }

  // Static methods can be overridden on the subclass.
  static kingdom(): string {
    return "Animalia (canine)";
  }
}

export function main(): void {
  const rex = new Dog("Rex", 4, "Labrador");

  // Accessors look like field reads.
  console.log("name  = " + rex.name);
  console.log("age   = " + rex.age.toString());
  console.log("breed = " + rex.breed);

  // Method dispatch picks the most-derived override.
  console.log(rex.speak());

  // Setters look like field writes.
  rex.name = "Rex Jr.";
  console.log("renamed: " + rex.name);

  // instanceof traverses the prototype chain.
  console.log("rex instanceof Dog    = " + (rex instanceof Dog ? "true" : "false"));
  console.log("rex instanceof Animal = " + (rex instanceof Animal ? "true" : "false"));

  // Static methods are called on the class.
  console.log("Animal.kingdom() = " + Animal.kingdom());
  console.log("Dog.kingdom()    = " + Dog.kingdom());
}
