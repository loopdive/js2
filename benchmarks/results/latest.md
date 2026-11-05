# js2wasm Benchmark Results

Date: 2026-11-05
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.057ms | 0.071ms | 0.069ms | FAILED | js |
| string/concat-long | 0.005ms | 0.006ms | 0.006ms | FAILED | js |
| string/indexOf | 0.017ms | 0.016ms | 0.016ms | 0.038ms | gc-native |
| string/includes | 0.017ms | 0.019ms | 0.019ms | 0.037ms | js |
| string/split | 0.397ms | 0.426ms | 0.427ms | FAILED | js |
| string/replace | 0.103ms | 0.052ms | 0.055ms | FAILED | host-call |
| string/case-convert | 0.065ms | 0.006ms | 0.006ms | FAILED | gc-native |
| string/substring | 0.118ms | 0.033ms | 0.033ms | FAILED | host-call |
| string/trim | 0.207ms | 0.154ms | 0.154ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.484ms | 0.208ms | 0.208ms | 0.571ms | gc-native |
| array/push-pop | 1.59ms | 0.524ms | 0.531ms | FAILED | host-call |
| array/sort-i32 | 0.656ms | 0.431ms | 0.432ms | FAILED | host-call |
| array/map-filter | 0.144ms | 0.085ms | 0.092ms | FAILED | host-call |
| array/reduce | 1.55ms | 0.521ms | 0.517ms | FAILED | gc-native |
| array/indexOf | 5.42ms | 6.39ms | 6.38ms | FAILED | js |
| array/slice | 0.047ms | 0.047ms | 0.053ms | FAILED | js |
| array/reverse | 8.48ms | 3.82ms | 3.82ms | FAILED | host-call |
| array/forEach | 0.062ms | 0.041ms | 0.041ms | FAILED | host-call |
| array/find | 0.347ms | 0.014ms | 0.014ms | 1.02ms | host-call |
| dom/create-elements | 0.066ms | 0.918ms | — | — | js |
| dom/set-attributes | 0.141ms | 6.28ms | — | — | js |
| dom/read-attributes | 0.074ms | FAILED | — | — | js |
| dom/modify-text | 0.061ms | 1.70ms | — | — | js |
| mixed/csv-parse | 0.421ms | 0.328ms | 0.355ms | FAILED | host-call |
| mixed/text-search | 0.442ms | 0.279ms | 0.265ms | 1.19ms | gc-native |
| mixed/fibonacci | 0.136ms | 0.217ms | 0.218ms | 0.216ms | js |
| mixed/matrix-multiply | 0.191ms | 0.226ms | 0.227ms | 0.733ms | js |
| mixed/sieve | 1.79ms | 2.54ms | 2.52ms | FAILED | js |

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
| string/concat-short | 10000 | 5.67 | 7.05 | 6.92 | — |
| string/concat-long | 1000 | 5.48 | 5.87 | 6.12 | — |
| string/indexOf | 1000 | 16.72 | 15.61 | 15.58 | 38.35 |
| string/includes | 1000 | 16.53 | 19.49 | 19.35 | 37.02 |
| string/split | 10000 | 39.67 | 42.58 | 42.66 | — |
| string/replace | 1000 | 102.84 | 52.06 | 55.07 | — |
| string/case-convert | 2000 | 32.70 | 2.95 | 2.86 | — |
| string/substring | 10000 | 11.77 | 3.26 | 3.27 | — |
| string/trim | 10000 | 20.73 | 15.41 | 15.40 | — |
| string/startsWith-endsWith | 20000 | 24.20 | 10.41 | 10.39 | 28.53 |
| array/map-filter | 30000 | 4.80 | 2.83 | 3.06 | — |
| array/indexOf | 1000 | 5420.12 | 6390.39 | 6380.54 | — |
| dom/create-elements | 2000 | 33.16 | 459.25 | — | — |
| dom/set-attributes | 6000 | 23.46 | 1047.48 | — | — |
| dom/read-attributes | 3000 | 24.68 | — | — | — |
| dom/modify-text | 2000 | 30.68 | 850.99 | — | — |
| mixed/csv-parse | 11000 | 38.28 | 29.80 | 32.29 | — |
| mixed/text-search | 40000 | 11.04 | 6.97 | 6.63 | 29.63 |
| mixed/fibonacci | 10000 | 13.65 | 21.72 | 21.76 | 21.57 |
| mixed/matrix-multiply | 125000 | 1.53 | 1.81 | 1.81 | 5.86 |
| mixed/sieve | 200000 | 8.95 | 12.71 | 12.60 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.24x slower | 1.22x slower | — |
| string/concat-long | 1.07x slower | 1.12x slower | — |
| string/indexOf | 1.07x faster | 1.07x faster | 2.29x slower |
| string/includes | 1.18x slower | 1.17x slower | 2.24x slower |
| string/split | 1.07x slower | 1.08x slower | — |
| string/replace | 1.98x faster | 1.87x faster | — |
| string/case-convert | 11.10x faster | 11.45x faster | — |
| string/substring | 3.61x faster | 3.60x faster | — |
| string/trim | 1.35x faster | 1.35x faster | — |
| string/startsWith-endsWith | 2.33x faster | 2.33x faster | 1.18x slower |
| array/push-pop | 3.03x faster | 2.99x faster | — |
| array/sort-i32 | 1.52x faster | 1.52x faster | — |
| array/map-filter | 1.70x faster | 1.57x faster | — |
| array/reduce | 2.98x faster | 3.00x faster | — |
| array/indexOf | 1.18x slower | 1.18x slower | — |
| array/slice | 1.00x slower | 1.13x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.51x faster | 1.51x faster | — |
| array/find | 24.84x faster | 24.25x faster | 2.93x slower |
| dom/create-elements | 13.85x slower | — | — |
| dom/set-attributes | 44.65x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 27.73x slower | — | — |
| mixed/csv-parse | 1.28x faster | 1.19x faster | — |
| mixed/text-search | 1.58x faster | 1.66x faster | 2.68x slower |
| mixed/fibonacci | 1.59x slower | 1.59x slower | 1.58x slower |
| mixed/matrix-multiply | 1.18x slower | 1.19x slower | 3.84x slower |
| mixed/sieve | 1.42x slower | 1.41x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.02x faster |
| string/concat-long | 1.04x slower |
| string/indexOf | 1.00x faster |
| string/includes | 1.01x faster |
| string/split | 1.00x slower |
| string/replace | 1.06x slower |
| string/case-convert | 1.03x faster |
| string/substring | 1.00x slower |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.08x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.13x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.02x slower |
| mixed/csv-parse | 1.08x slower |
| mixed/text-search | 1.05x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x faster |

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
| array/sort-i32 | 28.0KB | 28.0KB | — |
| array/map-filter | 29.1KB | 29.1KB | — |
| array/reduce | 27.6KB | 27.6KB | — |
| array/indexOf | 25.5KB | 25.5KB | — |
| array/slice | 25.4KB | 25.4KB | — |
| array/reverse | 25.4KB | 25.4KB | — |
| array/forEach | 27.8KB | 27.8KB | — |
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
| string/concat-short | 1437.3ms | 597.0ms | — |
| string/concat-long | 1083.4ms | 1039.0ms | — |
| string/indexOf | 1034.6ms | 1035.5ms | 596.4ms |
| string/includes | 1054.2ms | 1037.9ms | 620.5ms |
| string/split | 1125.4ms | 1142.8ms | — |
| string/replace | 1198.5ms | 1204.3ms | — |
| string/case-convert | 1143.8ms | 1107.1ms | — |
| string/substring | 547.8ms | 536.9ms | — |
| string/trim | 1105.8ms | 1104.7ms | — |
| string/startsWith-endsWith | 1143.4ms | 1148.0ms | 697.8ms |
| array/push-pop | 1105.8ms | 1109.0ms | — |
| array/sort-i32 | 1166.5ms | 1157.6ms | — |
| array/map-filter | 1259.0ms | 1243.2ms | — |
| array/reduce | 1174.3ms | 1174.6ms | — |
| array/indexOf | 1149.2ms | 1118.6ms | — |
| array/slice | 1097.6ms | 1090.3ms | — |
| array/reverse | 1113.6ms | 1101.5ms | — |
| array/forEach | 1177.5ms | 1137.1ms | — |
| array/find | 3121.2ms | 3084.5ms | 620.8ms |
| dom/create-elements | 722.3ms | — | — |
| dom/set-attributes | 670.0ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 666.0ms | — | — |
| mixed/csv-parse | 1138.7ms | 1108.0ms | — |
| mixed/text-search | 1146.4ms | 1180.1ms | 693.5ms |
| mixed/fibonacci | 617.0ms | 601.2ms | 528.9ms |
| mixed/matrix-multiply | 1146.7ms | 1151.8ms | 595.3ms |
| mixed/sieve | 1148.5ms | 1157.5ms | — |
