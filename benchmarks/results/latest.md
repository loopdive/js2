# js2wasm Benchmark Results

Date: 2026-10-18
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.036ms | 0.045ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.017ms | 0.016ms | 0.015ms | linear-memory |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.017ms | linear-memory |
| string/split | 0.416ms | 0.413ms | 0.411ms | FAILED | gc-native |
| string/replace | 0.111ms | 0.054ms | 0.054ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | gc-native |
| string/substring | 0.098ms | 0.031ms | 0.031ms | FAILED | host-call |
| string/trim | 0.170ms | 0.163ms | 0.163ms | FAILED | host-call |
| string/startsWith-endsWith | 0.401ms | 0.220ms | 0.220ms | 0.562ms | gc-native |
| array/push-pop | 1.43ms | 0.505ms | 0.502ms | FAILED | gc-native |
| array/sort-i32 | 0.951ms | 0.396ms | 0.394ms | FAILED | gc-native |
| array/map-filter | 0.127ms | 0.075ms | 0.081ms | FAILED | host-call |
| array/reduce | 1.34ms | 0.501ms | 0.501ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.049ms | 0.049ms | FAILED | gc-native |
| array/find | 0.254ms | 0.012ms | 0.012ms | 1.07ms | gc-native |
| dom/create-elements | 0.037ms | 0.927ms | — | — | js |
| dom/set-attributes | 0.103ms | 6.78ms | — | — | js |
| dom/read-attributes | 0.055ms | FAILED | — | — | js |
| dom/modify-text | 0.030ms | 1.73ms | — | — | js |
| mixed/csv-parse | 0.488ms | 0.317ms | 0.314ms | FAILED | gc-native |
| mixed/text-search | 0.388ms | 0.263ms | 0.263ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 0.213ms | 0.230ms | 0.723ms | js |
| mixed/sieve | 1.56ms | 2.09ms | 2.11ms | FAILED | js |

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
| dom/read-attributes | host-call | warmup | dereferencing a null pointer |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.56 | 4.50 | 4.39 | — |
| string/concat-long | 1000 | 3.57 | 3.17 | 3.09 | — |
| string/indexOf | 1000 | 19.19 | 16.51 | 16.35 | 15.37 |
| string/includes | 1000 | 19.20 | 20.97 | 20.87 | 16.59 |
| string/split | 10000 | 41.58 | 41.26 | 41.11 | — |
| string/replace | 1000 | 111.10 | 54.01 | 53.93 | — |
| string/case-convert | 2000 | 27.81 | 3.28 | 3.27 | — |
| string/substring | 10000 | 9.84 | 3.07 | 3.07 | — |
| string/trim | 10000 | 16.95 | 16.25 | 16.25 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 11.01 | 11.01 | 28.08 |
| array/map-filter | 30000 | 4.22 | 2.49 | 2.69 | — |
| array/indexOf | 1000 | 3952.69 | 2639.52 | 2641.08 | — |
| dom/create-elements | 2000 | 18.53 | 463.72 | — | — |
| dom/set-attributes | 6000 | 17.24 | 1130.22 | — | — |
| dom/read-attributes | 3000 | 18.36 | — | — | — |
| dom/modify-text | 2000 | 15.06 | 863.30 | — | — |
| mixed/csv-parse | 11000 | 44.34 | 28.82 | 28.52 | — |
| mixed/text-search | 40000 | 9.71 | 6.59 | 6.57 | 26.95 |
| mixed/fibonacci | 10000 | 12.02 | 28.31 | 28.31 | 28.14 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.70 | 1.84 | 5.78 |
| mixed/sieve | 200000 | 7.81 | 10.45 | 10.55 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.26x slower | 1.23x slower | — |
| string/concat-long | 1.13x faster | 1.16x faster | — |
| string/indexOf | 1.16x faster | 1.17x faster | 1.25x faster |
| string/includes | 1.09x slower | 1.09x slower | 1.16x faster |
| string/split | 1.01x faster | 1.01x faster | — |
| string/replace | 2.06x faster | 2.06x faster | — |
| string/case-convert | 8.49x faster | 8.49x faster | — |
| string/substring | 3.21x faster | 3.20x faster | — |
| string/trim | 1.04x faster | 1.04x faster | — |
| string/startsWith-endsWith | 1.82x faster | 1.82x faster | 1.40x slower |
| array/push-pop | 2.83x faster | 2.85x faster | — |
| array/sort-i32 | 2.40x faster | 2.41x faster | — |
| array/map-filter | 1.70x faster | 1.57x faster | — |
| array/reduce | 2.69x faster | 2.68x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.00x slower | 1.00x faster | — |
| array/find | 21.50x faster | 21.94x faster | 4.22x slower |
| dom/create-elements | 25.02x slower | — | — |
| dom/set-attributes | 65.55x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 57.31x slower | — | — |
| mixed/csv-parse | 1.54x faster | 1.55x faster | — |
| mixed/text-search | 1.47x faster | 1.48x faster | 2.78x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 1.35x slower | 1.45x slower | 4.57x slower |
| mixed/sieve | 1.34x slower | 1.35x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.02x faster |
| string/concat-long | 1.03x faster |
| string/indexOf | 1.01x faster |
| string/includes | 1.00x faster |
| string/split | 1.00x faster |
| string/replace | 1.00x faster |
| string/case-convert | 1.00x faster |
| string/substring | 1.00x slower |
| string/trim | 1.00x slower |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.08x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.02x faster |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.00x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.08x slower |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.5KB | 1.5KB | — |
| string/concat-long | 18.8KB | 18.8KB | — |
| string/indexOf | 18.9KB | 18.9KB | 10.4KB |
| string/includes | 19.0KB | 19.0KB | 10.4KB |
| string/split | 26.7KB | 26.7KB | — |
| string/replace | 27.5KB | 27.5KB | — |
| string/case-convert | 26.3KB | 26.3KB | — |
| string/substring | 1.0KB | 1.0KB | — |
| string/trim | 26.3KB | 26.3KB | — |
| string/startsWith-endsWith | 27.3KB | 27.3KB | 1.7KB |
| array/push-pop | 25.3KB | 25.3KB | — |
| array/sort-i32 | 27.8KB | 27.8KB | — |
| array/map-filter | 28.9KB | 29.0KB | — |
| array/reduce | 27.4KB | 27.4KB | — |
| array/indexOf | 26.4KB | 26.4KB | — |
| array/slice | 25.4KB | 25.4KB | — |
| array/reverse | 25.4KB | 25.4KB | — |
| array/forEach | 27.6KB | 27.6KB | — |
| array/find | 61.8KB | 61.8KB | 634B |
| dom/create-elements | 1.9KB | — | — |
| dom/set-attributes | 2.3KB | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 1.9KB | — | — |
| mixed/csv-parse | 27.8KB | 27.8KB | — |
| mixed/text-search | 27.7KB | 27.7KB | 1.9KB |
| mixed/fibonacci | 1.2KB | 1.2KB | 411B |
| mixed/matrix-multiply | 26.6KB | 26.6KB | 991B |
| mixed/sieve | 26.5KB | 26.5KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1364.1ms | 550.0ms | — |
| string/concat-long | 1017.7ms | 1001.1ms | — |
| string/indexOf | 950.7ms | 959.7ms | 532.0ms |
| string/includes | 961.3ms | 938.6ms | 548.7ms |
| string/split | 1060.3ms | 1112.9ms | — |
| string/replace | 1107.8ms | 1066.9ms | — |
| string/case-convert | 1003.6ms | 1024.8ms | — |
| string/substring | 499.6ms | 494.0ms | — |
| string/trim | 1019.4ms | 1022.9ms | — |
| string/startsWith-endsWith | 1040.8ms | 1025.2ms | 619.7ms |
| array/push-pop | 1019.4ms | 1021.7ms | — |
| array/sort-i32 | 1100.6ms | 1082.0ms | — |
| array/map-filter | 1148.9ms | 1136.1ms | — |
| array/reduce | 1099.7ms | 1088.8ms | — |
| array/indexOf | 1031.0ms | 1039.6ms | — |
| array/slice | 996.9ms | 1007.8ms | — |
| array/reverse | 1037.0ms | 991.1ms | — |
| array/forEach | 1047.6ms | 1071.2ms | — |
| array/find | 2356.2ms | 2324.8ms | 530.2ms |
| dom/create-elements | 628.2ms | — | — |
| dom/set-attributes | 614.9ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 588.9ms | — | — |
| mixed/csv-parse | 1042.8ms | 1033.8ms | — |
| mixed/text-search | 1059.0ms | 1051.1ms | 606.3ms |
| mixed/fibonacci | 511.4ms | 513.1ms | 471.6ms |
| mixed/matrix-multiply | 1058.6ms | 1064.9ms | 499.1ms |
| mixed/sieve | 1079.6ms | 1070.7ms | — |
