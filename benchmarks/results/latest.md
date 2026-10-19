# js2wasm Benchmark Results

Date: 2026-10-19
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.036ms | 0.045ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | host-call |
| string/indexOf | 0.019ms | 0.016ms | 0.016ms | 0.021ms | host-call |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.015ms | linear-memory |
| string/split | 0.413ms | 0.413ms | 0.438ms | FAILED | host-call |
| string/replace | 0.102ms | 0.054ms | 0.054ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | host-call |
| string/substring | 0.099ms | 0.031ms | 0.031ms | FAILED | host-call |
| string/trim | 0.170ms | 0.163ms | 0.163ms | FAILED | host-call |
| string/startsWith-endsWith | 0.401ms | 0.220ms | 0.220ms | 0.560ms | host-call |
| array/push-pop | 1.39ms | 0.508ms | 0.505ms | FAILED | gc-native |
| array/sort-i32 | 0.913ms | 0.395ms | 0.395ms | FAILED | gc-native |
| array/map-filter | 0.127ms | 0.075ms | 0.081ms | FAILED | host-call |
| array/reduce | 1.34ms | 0.505ms | 0.504ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.049ms | 0.049ms | FAILED | host-call |
| array/find | 0.254ms | 0.012ms | 0.012ms | 1.08ms | gc-native |
| dom/create-elements | 0.035ms | 0.955ms | — | — | js |
| dom/set-attributes | 0.105ms | 6.75ms | — | — | js |
| dom/read-attributes | 0.056ms | FAILED | — | — | js |
| dom/modify-text | 0.030ms | 1.68ms | — | — | js |
| mixed/csv-parse | 0.480ms | 0.318ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.388ms | 0.264ms | 0.263ms | 1.10ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.289ms | js |
| mixed/matrix-multiply | 0.158ms | 0.213ms | 0.215ms | 0.720ms | js |
| mixed/sieve | 1.54ms | 2.12ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 3.59 | 4.50 | 4.39 | — |
| string/concat-long | 1000 | 3.57 | 3.01 | 3.03 | — |
| string/indexOf | 1000 | 19.16 | 16.32 | 16.47 | 20.52 |
| string/includes | 1000 | 19.22 | 20.99 | 20.97 | 15.44 |
| string/split | 10000 | 41.35 | 41.27 | 43.75 | — |
| string/replace | 1000 | 101.60 | 54.20 | 54.15 | — |
| string/case-convert | 2000 | 27.82 | 3.27 | 3.28 | — |
| string/substring | 10000 | 9.90 | 3.07 | 3.08 | — |
| string/trim | 10000 | 16.98 | 16.27 | 16.27 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 11.02 | 11.02 | 28.01 |
| array/map-filter | 30000 | 4.24 | 2.48 | 2.71 | — |
| array/indexOf | 1000 | 3948.71 | 2639.41 | 2638.95 | — |
| dom/create-elements | 2000 | 17.66 | 477.26 | — | — |
| dom/set-attributes | 6000 | 17.48 | 1124.74 | — | — |
| dom/read-attributes | 3000 | 18.76 | — | — | — |
| dom/modify-text | 2000 | 15.10 | 839.53 | — | — |
| mixed/csv-parse | 11000 | 43.61 | 28.91 | 28.60 | — |
| mixed/text-search | 40000 | 9.70 | 6.59 | 6.58 | 27.46 |
| mixed/fibonacci | 10000 | 12.03 | 28.29 | 28.30 | 28.92 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.70 | 1.72 | 5.76 |
| mixed/sieve | 200000 | 7.68 | 10.61 | 10.62 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.25x slower | 1.22x slower | — |
| string/concat-long | 1.19x faster | 1.18x faster | — |
| string/indexOf | 1.17x faster | 1.16x faster | 1.07x slower |
| string/includes | 1.09x slower | 1.09x slower | 1.24x faster |
| string/split | 1.00x faster | 1.06x slower | — |
| string/replace | 1.87x faster | 1.88x faster | — |
| string/case-convert | 8.50x faster | 8.47x faster | — |
| string/substring | 3.23x faster | 3.22x faster | — |
| string/trim | 1.04x faster | 1.04x faster | — |
| string/startsWith-endsWith | 1.82x faster | 1.82x faster | 1.40x slower |
| array/push-pop | 2.73x faster | 2.75x faster | — |
| array/sort-i32 | 2.31x faster | 2.31x faster | — |
| array/map-filter | 1.70x faster | 1.57x faster | — |
| array/reduce | 2.65x faster | 2.66x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.00x faster | 1.00x faster | — |
| array/find | 21.55x faster | 21.68x faster | 4.27x slower |
| dom/create-elements | 27.02x slower | — | — |
| dom/set-attributes | 64.35x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 55.58x slower | — | — |
| mixed/csv-parse | 1.51x faster | 1.52x faster | — |
| mixed/text-search | 1.47x faster | 1.47x faster | 2.83x slower |
| mixed/fibonacci | 2.35x slower | 2.35x slower | 2.40x slower |
| mixed/matrix-multiply | 1.35x slower | 1.36x slower | 4.57x slower |
| mixed/sieve | 1.38x slower | 1.38x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.02x faster |
| string/concat-long | 1.01x slower |
| string/indexOf | 1.01x slower |
| string/includes | 1.00x faster |
| string/split | 1.06x slower |
| string/replace | 1.00x faster |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x slower |
| string/trim | 1.00x slower |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.09x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.00x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.00x slower |

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
| string/concat-short | 1325.2ms | 552.4ms | — |
| string/concat-long | 1051.1ms | 959.1ms | — |
| string/indexOf | 966.1ms | 947.3ms | 568.7ms |
| string/includes | 991.0ms | 973.5ms | 556.4ms |
| string/split | 1042.4ms | 1050.0ms | — |
| string/replace | 1135.8ms | 1108.7ms | — |
| string/case-convert | 1018.5ms | 1026.8ms | — |
| string/substring | 497.1ms | 500.6ms | — |
| string/trim | 1021.0ms | 996.3ms | — |
| string/startsWith-endsWith | 1055.6ms | 1055.9ms | 624.9ms |
| array/push-pop | 1038.9ms | 1023.0ms | — |
| array/sort-i32 | 1106.1ms | 1069.0ms | — |
| array/map-filter | 1138.4ms | 1169.5ms | — |
| array/reduce | 1125.3ms | 1088.0ms | — |
| array/indexOf | 1048.8ms | 1038.6ms | — |
| array/slice | 1025.3ms | 1020.7ms | — |
| array/reverse | 1000.4ms | 1017.2ms | — |
| array/forEach | 1086.3ms | 1050.2ms | — |
| array/find | 2368.1ms | 2306.6ms | 543.7ms |
| dom/create-elements | 647.0ms | — | — |
| dom/set-attributes | 593.2ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 603.8ms | — | — |
| mixed/csv-parse | 1027.6ms | 1058.9ms | — |
| mixed/text-search | 1055.6ms | 1091.9ms | 607.1ms |
| mixed/fibonacci | 533.9ms | 509.0ms | 489.1ms |
| mixed/matrix-multiply | 1049.6ms | 1061.2ms | 530.2ms |
| mixed/sieve | 1047.4ms | 1056.7ms | — |
