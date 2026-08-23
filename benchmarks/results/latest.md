# js2wasm Benchmark Results

Date: 2026-08-23
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.037ms | 0.040ms | 0.047ms | FAILED | js |
| string/concat-long | 0.003ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.016ms | 0.048ms | 0.011ms | 0.013ms | gc-native |
| string/includes | 0.015ms | 0.091ms | 0.013ms | 0.014ms | gc-native |
| string/split | 0.338ms | 3.98ms | 0.388ms | FAILED | js |
| string/replace | 0.090ms | 0.223ms | 0.048ms | FAILED | gc-native |
| string/case-convert | 0.047ms | 0.178ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.101ms | 0.036ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.156ms | 0.700ms | 0.159ms | FAILED | js |
| string/startsWith-endsWith | 0.450ms | 0.316ms | 0.247ms | 0.489ms | gc-native |
| array/push-pop | 1.22ms | 0.400ms | 0.399ms | FAILED | gc-native |
| array/sort-i32 | 0.610ms | 0.317ms | 0.318ms | FAILED | host-call |
| array/map-filter | 0.111ms | 0.068ms | 0.070ms | FAILED | host-call |
| array/reduce | 1.86ms | 0.435ms | 0.391ms | FAILED | gc-native |
| array/indexOf | 5.05ms | 2.38ms | 2.46ms | FAILED | host-call |
| array/slice | 0.018ms | 0.019ms | 0.018ms | FAILED | js |
| array/reverse | 7.69ms | 3.50ms | 3.33ms | FAILED | gc-native |
| array/forEach | 0.046ms | 0.021ms | 0.024ms | FAILED | host-call |
| array/find | 0.272ms | 0.012ms | 0.013ms | 0.951ms | host-call |
| dom/create-elements | 0.038ms | FAILED | — | — | js |
| dom/set-attributes | 0.108ms | FAILED | — | — | js |
| dom/read-attributes | 0.045ms | FAILED | — | — | js |
| dom/modify-text | 0.033ms | FAILED | — | — | js |
| mixed/csv-parse | 0.386ms | 5.96ms | 0.293ms | FAILED | gc-native |
| mixed/text-search | 0.416ms | 1.17ms | 0.246ms | 1.05ms | gc-native |
| mixed/fibonacci | 0.126ms | 0.190ms | 0.197ms | 0.200ms | js |
| mixed/matrix-multiply | 0.173ms | 0.207ms | 0.212ms | 0.663ms | js |
| mixed/sieve | 1.39ms | 1.48ms | 1.51ms | FAILED | js |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | warmup | memory access out of bounds |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| dom/create-elements | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/set-attributes | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/read-attributes | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/modify-text | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.69 | 4.01 | 4.74 | — |
| string/concat-long | 1000 | 3.45 | 5.29 | 3.85 | — |
| string/indexOf | 1000 | 15.52 | 47.50 | 10.52 | 13.06 |
| string/includes | 1000 | 15.42 | 91.44 | 13.35 | 14.07 |
| string/split | 10000 | 33.78 | 397.85 | 38.81 | — |
| string/replace | 1000 | 90.09 | 222.96 | 48.03 | — |
| string/case-convert | 2000 | 23.73 | 89.25 | 2.49 | — |
| string/substring | 10000 | 10.14 | 3.57 | 3.07 | — |
| string/trim | 10000 | 15.59 | 70.04 | 15.93 | — |
| string/startsWith-endsWith | 20000 | 22.49 | 15.79 | 12.36 | 24.44 |
| array/map-filter | 30000 | 3.70 | 2.25 | 2.32 | — |
| array/indexOf | 1000 | 5048.32 | 2379.42 | 2464.77 | — |
| dom/create-elements | 2000 | 18.88 | — | — | — |
| dom/set-attributes | 6000 | 17.96 | — | — | — |
| dom/read-attributes | 3000 | 14.89 | — | — | — |
| dom/modify-text | 2000 | 16.44 | — | — | — |
| mixed/csv-parse | 11000 | 35.05 | 542.01 | 26.62 | — |
| mixed/text-search | 40000 | 10.40 | 29.27 | 6.16 | 26.15 |
| mixed/fibonacci | 10000 | 12.58 | 19.01 | 19.69 | 20.04 |
| mixed/matrix-multiply | 125000 | 1.39 | 1.66 | 1.69 | 5.31 |
| mixed/sieve | 200000 | 6.95 | 7.42 | 7.57 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.09x slower | 1.28x slower | — |
| string/concat-long | 1.53x slower | 1.12x slower | — |
| string/indexOf | 3.06x slower | 1.48x faster | 1.19x faster |
| string/includes | 5.93x slower | 1.16x faster | 1.10x faster |
| string/split | 11.78x slower | 1.15x slower | — |
| string/replace | 2.47x slower | 1.88x faster | — |
| string/case-convert | 3.76x slower | 9.55x faster | — |
| string/substring | 2.84x faster | 3.31x faster | — |
| string/trim | 4.49x slower | 1.02x slower | — |
| string/startsWith-endsWith | 1.42x faster | 1.82x faster | 1.09x slower |
| array/push-pop | 3.04x faster | 3.05x faster | — |
| array/sort-i32 | 1.93x faster | 1.92x faster | — |
| array/map-filter | 1.64x faster | 1.60x faster | — |
| array/reduce | 4.28x faster | 4.76x faster | — |
| array/indexOf | 2.12x faster | 2.05x faster | — |
| array/slice | 1.09x slower | 1.01x slower | — |
| array/reverse | 2.20x faster | 2.31x faster | — |
| array/forEach | 2.21x faster | 1.92x faster | — |
| array/find | 21.85x faster | 21.67x faster | 3.50x slower |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 15.46x slower | 1.32x faster | — |
| mixed/text-search | 2.82x slower | 1.69x faster | 2.52x slower |
| mixed/fibonacci | 1.51x slower | 1.57x slower | 1.59x slower |
| mixed/matrix-multiply | 1.20x slower | 1.22x slower | 3.83x slower |
| mixed/sieve | 1.07x slower | 1.09x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.18x slower |
| string/concat-long | 1.37x faster |
| string/indexOf | 4.51x faster |
| string/includes | 6.85x faster |
| string/split | 10.25x faster |
| string/replace | 4.64x faster |
| string/case-convert | 35.91x faster |
| string/substring | 1.17x faster |
| string/trim | 4.40x faster |
| string/startsWith-endsWith | 1.28x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.03x slower |
| array/reduce | 1.11x faster |
| array/indexOf | 1.04x slower |
| array/slice | 1.08x faster |
| array/reverse | 1.05x faster |
| array/forEach | 1.15x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 20.36x faster |
| mixed/text-search | 4.75x faster |
| mixed/fibonacci | 1.04x slower |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.02x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.7KB | 2.1KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1077.6ms | 975.7ms | — |
| string/concat-long | 548.7ms | 843.5ms | — |
| string/indexOf | 583.2ms | 842.6ms | 779.9ms |
| string/includes | 583.8ms | 887.6ms | 734.1ms |
| string/split | 673.3ms | 871.1ms | — |
| string/replace | 666.2ms | 887.8ms | — |
| string/case-convert | 694.4ms | 737.4ms | — |
| string/substring | 571.1ms | 642.6ms | — |
| string/trim | 654.9ms | 857.6ms | — |
| string/startsWith-endsWith | 664.4ms | 852.2ms | 821.5ms |
| array/push-pop | 679.1ms | 720.1ms | — |
| array/sort-i32 | 813.1ms | 847.2ms | — |
| array/map-filter | 812.2ms | 872.6ms | — |
| array/reduce | 735.7ms | 838.0ms | — |
| array/indexOf | 743.5ms | 782.2ms | — |
| array/slice | 660.2ms | 777.0ms | — |
| array/reverse | 680.6ms | 715.1ms | — |
| array/forEach | 765.5ms | 898.5ms | — |
| array/find | 649.1ms | 736.5ms | 733.5ms |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 683.8ms | 822.0ms | — |
| mixed/text-search | 672.6ms | 875.6ms | 774.3ms |
| mixed/fibonacci | 655.3ms | 697.1ms | 679.9ms |
| mixed/matrix-multiply | 742.7ms | 790.3ms | 710.6ms |
| mixed/sieve | 738.5ms | 810.5ms | — |
