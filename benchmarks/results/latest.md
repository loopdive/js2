# js2wasm Benchmark Results

Date: 2026-11-08
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.042ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.017ms | 0.016ms | 0.015ms | linear-memory |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.015ms | linear-memory |
| string/split | 0.425ms | 0.412ms | 0.412ms | FAILED | gc-native |
| string/replace | 0.101ms | 0.055ms | 0.055ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.031ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.163ms | 0.163ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.402ms | 0.220ms | 0.220ms | 0.562ms | gc-native |
| array/push-pop | 1.51ms | 0.532ms | 0.529ms | FAILED | gc-native |
| array/sort-i32 | 0.792ms | 0.393ms | 0.397ms | FAILED | host-call |
| array/map-filter | 0.132ms | 0.075ms | 0.081ms | FAILED | host-call |
| array/reduce | 1.44ms | 0.536ms | 0.536ms | FAILED | host-call |
| array/indexOf | 3.95ms | 5.24ms | 5.23ms | FAILED | js |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.85ms | 3.53ms | 3.53ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.049ms | 0.049ms | FAILED | js |
| array/find | 0.249ms | 0.012ms | 0.012ms | 1.09ms | host-call |
| dom/create-elements | 0.035ms | 0.946ms | — | — | js |
| dom/set-attributes | 0.104ms | 7.64ms | — | — | js |
| dom/read-attributes | 0.058ms | FAILED | — | — | js |
| dom/modify-text | 0.029ms | 1.73ms | — | — | js |
| mixed/csv-parse | 0.479ms | 0.317ms | 0.322ms | FAILED | host-call |
| mixed/text-search | 0.391ms | 0.263ms | 0.263ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.288ms | js |
| mixed/matrix-multiply | 0.158ms | 0.213ms | 0.229ms | 0.724ms | js |
| mixed/sieve | 1.64ms | 2.16ms | 2.15ms | FAILED | js |

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
| string/concat-short | 10000 | 3.30 | 4.20 | 4.40 | — |
| string/concat-long | 1000 | 3.86 | 3.30 | 2.97 | — |
| string/indexOf | 1000 | 19.15 | 16.51 | 16.36 | 14.63 |
| string/includes | 1000 | 19.20 | 20.76 | 20.71 | 15.37 |
| string/split | 10000 | 42.47 | 41.24 | 41.19 | — |
| string/replace | 1000 | 101.49 | 54.74 | 54.61 | — |
| string/case-convert | 2000 | 27.96 | 3.28 | 3.28 | — |
| string/substring | 10000 | 9.90 | 3.08 | 3.07 | — |
| string/trim | 10000 | 16.99 | 16.30 | 16.30 | — |
| string/startsWith-endsWith | 20000 | 20.11 | 11.01 | 11.01 | 28.11 |
| array/map-filter | 30000 | 4.39 | 2.50 | 2.70 | — |
| array/indexOf | 1000 | 3952.78 | 5239.29 | 5232.83 | — |
| dom/create-elements | 2000 | 17.39 | 473.08 | — | — |
| dom/set-attributes | 6000 | 17.33 | 1273.97 | — | — |
| dom/read-attributes | 3000 | 19.25 | — | — | — |
| dom/modify-text | 2000 | 14.41 | 864.10 | — | — |
| mixed/csv-parse | 11000 | 43.57 | 28.79 | 29.23 | — |
| mixed/text-search | 40000 | 9.77 | 6.58 | 6.57 | 26.90 |
| mixed/fibonacci | 10000 | 12.03 | 28.33 | 28.35 | 28.84 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.70 | 1.83 | 5.79 |
| mixed/sieve | 200000 | 8.22 | 10.80 | 10.75 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.27x slower | 1.33x slower | — |
| string/concat-long | 1.17x faster | 1.30x faster | — |
| string/indexOf | 1.16x faster | 1.17x faster | 1.31x faster |
| string/includes | 1.08x slower | 1.08x slower | 1.25x faster |
| string/split | 1.03x faster | 1.03x faster | — |
| string/replace | 1.85x faster | 1.86x faster | — |
| string/case-convert | 8.53x faster | 8.53x faster | — |
| string/substring | 3.22x faster | 3.22x faster | — |
| string/trim | 1.04x faster | 1.04x faster | — |
| string/startsWith-endsWith | 1.83x faster | 1.83x faster | 1.40x slower |
| array/push-pop | 2.83x faster | 2.85x faster | — |
| array/sort-i32 | 2.02x faster | 1.99x faster | — |
| array/map-filter | 1.76x faster | 1.63x faster | — |
| array/reduce | 2.68x faster | 2.68x faster | — |
| array/indexOf | 1.33x slower | 1.32x slower | — |
| array/slice | 1.10x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 1.01x slower | 1.01x slower | — |
| array/find | 21.02x faster | 20.09x faster | 4.40x slower |
| dom/create-elements | 27.20x slower | — | — |
| dom/set-attributes | 73.51x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 59.99x slower | — | — |
| mixed/csv-parse | 1.51x faster | 1.49x faster | — |
| mixed/text-search | 1.49x faster | 1.49x faster | 2.75x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.40x slower |
| mixed/matrix-multiply | 1.35x slower | 1.45x slower | 4.59x slower |
| mixed/sieve | 1.31x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.05x slower |
| string/concat-long | 1.11x faster |
| string/indexOf | 1.01x faster |
| string/includes | 1.00x faster |
| string/split | 1.00x faster |
| string/replace | 1.00x faster |
| string/case-convert | 1.00x faster |
| string/substring | 1.00x faster |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.08x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.05x slower |
| mixed/csv-parse | 1.02x slower |
| mixed/text-search | 1.00x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.08x slower |
| mixed/sieve | 1.00x faster |

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
| array/sort-i32 | 28.1KB | 28.1KB | — |
| array/map-filter | 29.2KB | 29.3KB | — |
| array/reduce | 27.7KB | 27.7KB | — |
| array/indexOf | 25.5KB | 25.5KB | — |
| array/slice | 25.4KB | 25.4KB | — |
| array/reverse | 25.4KB | 25.4KB | — |
| array/forEach | 27.9KB | 27.9KB | — |
| array/find | 61.9KB | 61.9KB | 666B |
| dom/create-elements | 1.9KB | — | — |
| dom/set-attributes | 2.3KB | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 1.9KB | — | — |
| mixed/csv-parse | 27.8KB | 27.8KB | — |
| mixed/text-search | 27.7KB | 27.7KB | 1.9KB |
| mixed/fibonacci | 1.2KB | 1.2KB | 411B |
| mixed/matrix-multiply | 26.6KB | 26.6KB | 1019B |
| mixed/sieve | 26.5KB | 26.5KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1475.8ms | 605.5ms | — |
| string/concat-long | 1100.2ms | 1019.6ms | — |
| string/indexOf | 1015.3ms | 1027.7ms | 585.1ms |
| string/includes | 1018.5ms | 1030.6ms | 596.7ms |
| string/split | 1147.7ms | 1109.6ms | — |
| string/replace | 1158.9ms | 1163.4ms | — |
| string/case-convert | 1106.3ms | 1098.4ms | — |
| string/substring | 568.5ms | 546.6ms | — |
| string/trim | 1119.3ms | 1089.6ms | — |
| string/startsWith-endsWith | 1158.6ms | 1118.3ms | 671.3ms |
| array/push-pop | 1083.3ms | 1075.8ms | — |
| array/sort-i32 | 1892.0ms | 1873.6ms | — |
| array/map-filter | 1982.1ms | 1973.1ms | — |
| array/reduce | 1989.7ms | 1887.9ms | — |
| array/indexOf | 1127.5ms | 1119.7ms | — |
| array/slice | 1069.7ms | 1101.6ms | — |
| array/reverse | 1116.1ms | 1096.4ms | — |
| array/forEach | 1929.7ms | 1889.8ms | — |
| array/find | 3156.7ms | 3163.3ms | 587.3ms |
| dom/create-elements | 712.9ms | — | — |
| dom/set-attributes | 682.3ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 655.7ms | — | — |
| mixed/csv-parse | 1128.2ms | 1120.1ms | — |
| mixed/text-search | 1119.8ms | 1156.6ms | 658.6ms |
| mixed/fibonacci | 587.6ms | 574.7ms | 518.7ms |
| mixed/matrix-multiply | 1122.1ms | 1127.1ms | 559.3ms |
| mixed/sieve | 1115.1ms | 1133.7ms | — |
