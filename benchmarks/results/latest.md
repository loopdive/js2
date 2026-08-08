# js2wasm Benchmark Results

Date: 2026-08-08
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.117ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.148ms | 0.023ms | FAILED | js |
| string/split | 0.423ms | 5.51ms | 0.449ms | FAILED | js |
| string/replace | 0.104ms | 0.310ms | 0.082ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.236ms | 0.110ms | FAILED | js |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.169ms | 0.911ms | 0.245ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.73ms | 0.289ms | FAILED | gc-native |
| array/push-pop | 1.39ms | 0.500ms | 0.502ms | FAILED | host-call |
| array/sort-i32 | 0.795ms | 0.303ms | 0.301ms | FAILED | gc-native |
| array/map-filter | 0.070ms | 0.067ms | 0.066ms | FAILED | gc-native |
| array/reduce | 2.13ms | 0.502ms | 0.499ms | FAILED | gc-native |
| array/indexOf | 3.96ms | 3.55ms | 3.55ms | FAILED | host-call |
| array/slice | 0.024ms | 0.026ms | 0.026ms | FAILED | js |
| array/reverse | 7.82ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.238ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.040ms | 0.183ms | — | — | js |
| dom/set-attributes | 0.102ms | 0.578ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.146ms | — | — | js |
| dom/modify-text | 0.046ms | 0.122ms | — | — | js |
| mixed/csv-parse | 0.479ms | 8.63ms | 0.606ms | FAILED | js |
| mixed/text-search | 0.391ms | 2.44ms | 0.329ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.118ms | 0.118ms | 0.044ms | linear-memory |
| mixed/matrix-multiply | 0.156ms | 0.191ms | 0.191ms | 0.717ms | js |
| mixed/sieve | 1.51ms | 1.39ms | 1.39ms | FAILED | gc-native |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/startsWith-endsWith | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/text-search | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.33 | 11.65 | 3.89 | — |
| string/concat-long | 1000 | 3.52 | 4.49 | 4.39 | — |
| string/indexOf | 1000 | 19.10 | 65.93 | 23.68 | — |
| string/includes | 1000 | 19.14 | 147.98 | 23.35 | — |
| string/split | 10000 | 42.31 | 550.66 | 44.87 | — |
| string/replace | 1000 | 103.68 | 309.79 | 81.73 | — |
| string/case-convert | 2000 | 27.93 | 118.02 | 55.11 | — |
| string/substring | 10000 | 9.83 | 3.74 | 3.09 | — |
| string/trim | 10000 | 16.94 | 91.14 | 24.52 | — |
| string/startsWith-endsWith | 20000 | 20.08 | 136.31 | 14.43 | — |
| array/map-filter | 30000 | 2.35 | 2.22 | 2.21 | — |
| array/indexOf | 1000 | 3955.48 | 3550.13 | 3550.80 | — |
| dom/create-elements | 2000 | 19.86 | 91.36 | — | — |
| dom/set-attributes | 6000 | 17.07 | 96.34 | — | — |
| dom/read-attributes | 3000 | 18.35 | 48.72 | — | — |
| dom/modify-text | 2000 | 22.84 | 60.76 | — | — |
| mixed/csv-parse | 11000 | 43.55 | 784.47 | 55.05 | — |
| mixed/text-search | 40000 | 9.78 | 61.04 | 8.23 | — |
| mixed/fibonacci | 10000 | 12.17 | 11.83 | 11.82 | 4.37 |
| mixed/matrix-multiply | 125000 | 1.25 | 1.53 | 1.53 | 5.74 |
| mixed/sieve | 200000 | 7.54 | 6.96 | 6.93 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 3.50x slower | 1.17x slower | — |
| string/concat-long | 1.28x slower | 1.25x slower | — |
| string/indexOf | 3.45x slower | 1.24x slower | — |
| string/includes | 7.73x slower | 1.22x slower | — |
| string/split | 13.01x slower | 1.06x slower | — |
| string/replace | 2.99x slower | 1.27x faster | — |
| string/case-convert | 4.23x slower | 1.97x slower | — |
| string/substring | 2.63x faster | 3.18x faster | — |
| string/trim | 5.38x slower | 1.45x slower | — |
| string/startsWith-endsWith | 6.79x slower | 1.39x faster | — |
| array/push-pop | 2.79x faster | 2.78x faster | — |
| array/sort-i32 | 2.63x faster | 2.65x faster | — |
| array/map-filter | 1.06x faster | 1.06x faster | — |
| array/reduce | 4.24x faster | 4.26x faster | — |
| array/indexOf | 1.11x faster | 1.11x faster | — |
| array/slice | 1.10x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.73x faster | 1.73x faster | — |
| array/find | 14.44x faster | 14.49x faster | 4.51x slower |
| dom/create-elements | 4.60x slower | — | — |
| dom/set-attributes | 5.64x slower | — | — |
| dom/read-attributes | 2.66x slower | — | — |
| dom/modify-text | 2.66x slower | — | — |
| mixed/csv-parse | 18.01x slower | 1.26x slower | — |
| mixed/text-search | 6.24x slower | 1.19x faster | — |
| mixed/fibonacci | 1.03x faster | 1.03x faster | 2.79x faster |
| mixed/matrix-multiply | 1.22x slower | 1.22x slower | 4.59x slower |
| mixed/sieve | 1.08x faster | 1.09x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 3.00x faster |
| string/concat-long | 1.02x faster |
| string/indexOf | 2.78x faster |
| string/includes | 6.34x faster |
| string/split | 12.27x faster |
| string/replace | 3.79x faster |
| string/case-convert | 2.14x faster |
| string/substring | 1.21x faster |
| string/trim | 3.72x faster |
| string/startsWith-endsWith | 9.45x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 14.25x faster |
| mixed/text-search | 7.41x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 427B | 1.3KB | — |
| string/includes | 414B | 1.3KB | — |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 4.1KB | — |
| string/case-convert | 1.6KB | 13.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.1KB | 1.4KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 230B | — | — |
| dom/set-attributes | 497B | — | — |
| dom/read-attributes | 347B | — | — |
| dom/modify-text | 237B | — | — |
| mixed/csv-parse | 2.2KB | 4.6KB | — |
| mixed/text-search | 1.8KB | 4.0KB | — |
| mixed/fibonacci | 263B | 263B | 251B |
| mixed/matrix-multiply | 1.5KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1306.3ms | 1087.7ms | — |
| string/concat-long | 625.1ms | 937.8ms | — |
| string/indexOf | 760.0ms | 989.1ms | — |
| string/includes | 780.8ms | 958.6ms | — |
| string/split | 739.8ms | 923.4ms | — |
| string/replace | 793.0ms | 1055.5ms | — |
| string/case-convert | 774.4ms | 1066.7ms | — |
| string/substring | 630.2ms | 682.6ms | — |
| string/trim | 704.9ms | 990.2ms | — |
| string/startsWith-endsWith | 740.9ms | 985.6ms | — |
| array/push-pop | 784.2ms | 837.4ms | — |
| array/sort-i32 | 931.8ms | 994.4ms | — |
| array/map-filter | 886.6ms | 957.8ms | — |
| array/reduce | 820.6ms | 868.8ms | — |
| array/indexOf | 805.5ms | 866.4ms | — |
| array/slice | 721.5ms | 775.0ms | — |
| array/reverse | 741.5ms | 791.7ms | — |
| array/forEach | 849.3ms | 947.2ms | — |
| array/find | 731.6ms | 814.8ms | 813.9ms |
| dom/create-elements | 613.7ms | — | — |
| dom/set-attributes | 714.5ms | — | — |
| dom/read-attributes | 652.2ms | — | — |
| dom/modify-text | 692.2ms | — | — |
| mixed/csv-parse | 761.6ms | 973.5ms | — |
| mixed/text-search | 807.8ms | 1017.0ms | — |
| mixed/fibonacci | 773.7ms | 884.7ms | 727.2ms |
| mixed/matrix-multiply | 803.8ms | 851.2ms | 782.9ms |
| mixed/sieve | 836.8ms | 868.0ms | — |
