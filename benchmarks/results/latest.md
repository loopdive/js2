# js2wasm Benchmark Results

Date: 2026-08-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.029ms | 0.044ms | 0.041ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.071ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.134ms | 0.024ms | FAILED | js |
| string/split | 0.414ms | 5.64ms | 0.449ms | FAILED | js |
| string/replace | 0.108ms | 0.328ms | 0.082ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.233ms | 0.111ms | FAILED | js |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.172ms | 0.899ms | 0.243ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.58ms | 0.286ms | FAILED | gc-native |
| array/push-pop | 1.49ms | 0.511ms | 0.507ms | FAILED | gc-native |
| array/sort-i32 | 0.790ms | 0.305ms | 0.300ms | FAILED | gc-native |
| array/map-filter | 0.136ms | 0.064ms | 0.064ms | FAILED | host-call |
| array/reduce | 1.41ms | 0.508ms | 0.509ms | FAILED | host-call |
| array/indexOf | 3.95ms | 3.55ms | 3.55ms | FAILED | host-call |
| array/slice | 0.028ms | 0.030ms | 0.029ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.054ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.240ms | 0.017ms | 0.017ms | 1.00ms | gc-native |
| dom/create-elements | 0.232ms | 0.185ms | — | — | host-call |
| dom/set-attributes | 0.105ms | 0.565ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.142ms | — | — | js |
| dom/modify-text | 0.052ms | 0.127ms | — | — | js |
| mixed/csv-parse | 0.486ms | 8.59ms | 0.624ms | FAILED | js |
| mixed/text-search | 0.395ms | 2.43ms | 0.328ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.118ms | 0.118ms | 0.044ms | linear-memory |
| mixed/matrix-multiply | 0.159ms | 0.191ms | 0.191ms | 0.716ms | js |
| mixed/sieve | 1.60ms | 1.39ms | 1.41ms | FAILED | host-call |

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
| string/concat-short | 10000 | 2.95 | 4.44 | 4.09 | — |
| string/concat-long | 1000 | 3.74 | 4.50 | 4.56 | — |
| string/indexOf | 1000 | 19.17 | 70.94 | 24.03 | — |
| string/includes | 1000 | 19.20 | 134.07 | 23.56 | — |
| string/split | 10000 | 41.40 | 563.63 | 44.90 | — |
| string/replace | 1000 | 107.63 | 327.86 | 81.82 | — |
| string/case-convert | 2000 | 29.04 | 116.71 | 55.40 | — |
| string/substring | 10000 | 9.92 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.19 | 89.90 | 24.32 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 129.12 | 14.31 | — |
| array/map-filter | 30000 | 4.52 | 2.14 | 2.14 | — |
| array/indexOf | 1000 | 3948.60 | 3551.54 | 3551.90 | — |
| dom/create-elements | 2000 | 116.05 | 92.52 | — | — |
| dom/set-attributes | 6000 | 17.57 | 94.16 | — | — |
| dom/read-attributes | 3000 | 18.39 | 47.34 | — | — |
| dom/modify-text | 2000 | 26.23 | 63.74 | — | — |
| mixed/csv-parse | 11000 | 44.15 | 780.97 | 56.77 | — |
| mixed/text-search | 40000 | 9.88 | 60.66 | 8.21 | — |
| mixed/fibonacci | 10000 | 12.18 | 11.82 | 11.82 | 4.37 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.53 | 1.53 | 5.73 |
| mixed/sieve | 200000 | 8.01 | 6.94 | 7.03 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.51x slower | 1.39x slower | — |
| string/concat-long | 1.20x slower | 1.22x slower | — |
| string/indexOf | 3.70x slower | 1.25x slower | — |
| string/includes | 6.98x slower | 1.23x slower | — |
| string/split | 13.62x slower | 1.08x slower | — |
| string/replace | 3.05x slower | 1.32x faster | — |
| string/case-convert | 4.02x slower | 1.91x slower | — |
| string/substring | 2.64x faster | 3.23x faster | — |
| string/trim | 5.23x slower | 1.42x slower | — |
| string/startsWith-endsWith | 6.44x slower | 1.40x faster | — |
| array/push-pop | 2.92x faster | 2.94x faster | — |
| array/sort-i32 | 2.59x faster | 2.64x faster | — |
| array/map-filter | 2.12x faster | 2.11x faster | — |
| array/reduce | 2.78x faster | 2.77x faster | — |
| array/indexOf | 1.11x faster | 1.11x faster | — |
| array/slice | 1.10x slower | 1.05x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.92x faster | 1.93x faster | — |
| array/find | 13.77x faster | 14.19x faster | 4.17x slower |
| dom/create-elements | 1.25x faster | — | — |
| dom/set-attributes | 5.36x slower | — | — |
| dom/read-attributes | 2.57x slower | — | — |
| dom/modify-text | 2.43x slower | — | — |
| mixed/csv-parse | 17.69x slower | 1.29x slower | — |
| mixed/text-search | 6.14x slower | 1.20x faster | — |
| mixed/fibonacci | 1.03x faster | 1.03x faster | 2.79x faster |
| mixed/matrix-multiply | 1.21x slower | 1.21x slower | 4.51x slower |
| mixed/sieve | 1.15x faster | 1.14x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.08x faster |
| string/concat-long | 1.01x slower |
| string/indexOf | 2.95x faster |
| string/includes | 5.69x faster |
| string/split | 12.55x faster |
| string/replace | 4.01x faster |
| string/case-convert | 2.11x faster |
| string/substring | 1.22x faster |
| string/trim | 3.70x faster |
| string/startsWith-endsWith | 9.02x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.05x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.03x faster |
| mixed/csv-parse | 13.76x faster |
| mixed/text-search | 7.39x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 1331.2ms | 1148.8ms | — |
| string/concat-long | 690.2ms | 1021.3ms | — |
| string/indexOf | 869.8ms | 1063.8ms | — |
| string/includes | 835.5ms | 1118.8ms | — |
| string/split | 825.4ms | 1056.4ms | — |
| string/replace | 899.3ms | 1147.1ms | — |
| string/case-convert | 878.4ms | 1190.6ms | — |
| string/substring | 703.3ms | 807.8ms | — |
| string/trim | 786.3ms | 1106.9ms | — |
| string/startsWith-endsWith | 784.3ms | 1055.5ms | — |
| array/push-pop | 786.3ms | 875.7ms | — |
| array/sort-i32 | 963.7ms | 1039.6ms | — |
| array/map-filter | 967.2ms | 1067.8ms | — |
| array/reduce | 884.3ms | 941.7ms | — |
| array/indexOf | 892.5ms | 952.9ms | — |
| array/slice | 823.7ms | 892.9ms | — |
| array/reverse | 772.1ms | 849.1ms | — |
| array/forEach | 895.4ms | 968.0ms | — |
| array/find | 789.6ms | 896.1ms | 864.4ms |
| dom/create-elements | 698.5ms | — | — |
| dom/set-attributes | 768.4ms | — | — |
| dom/read-attributes | 742.5ms | — | — |
| dom/modify-text | 758.3ms | — | — |
| mixed/csv-parse | 858.8ms | 1059.8ms | — |
| mixed/text-search | 783.0ms | 1051.1ms | — |
| mixed/fibonacci | 827.8ms | 858.3ms | 745.1ms |
| mixed/matrix-multiply | 871.5ms | 919.4ms | 817.3ms |
| mixed/sieve | 829.5ms | 876.5ms | — |
