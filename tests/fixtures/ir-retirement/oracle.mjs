// Independent JavaScript oracle. Each factory is a fresh module instance.
export function oracle(name) {
  switch (name) {
    case "scalar":
      return { calculate: (x) => x * 3 + 2 };
    case "namespace":
      return { calculate: (x) => 1 + x };
    case "class-closure":
      return { calculate: (x) => x + 7 };
    case "dynamic":
      return { calculate: (x) => x + 9 };
    case "cjs":
      return { calculate: (x) => x + 11 };
    case "graph":
    case "async": {
      let value = 4;
      return {
        get value() {
          return value;
        },
        bump(x) {
          value += x;
          return value;
        },
        calculate(x) {
          let sum = 0;
          for (let i = 0; i < x; i++) if (i % 2 === 0) sum += i;
          return sum + value + x + 10;
        },
        __module_init: (x) => x + 100,
        async twoAwait(x) {
          const first = await Promise.resolve(x + 1);
          const second = await Promise.resolve(first * 2);
          return second + 3;
        },
      };
    }
    default:
      throw new Error(`Unknown oracle ${name}`);
  }
}
