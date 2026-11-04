# js2wasm Benchmark Results

Date: 2026-11-04
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.022ms | 0.046ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.016ms | 0.016ms | 0.015ms | linear-memory |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.015ms | linear-memory |
| string/split | 0.424ms | 0.411ms | 0.414ms | FAILED | host-call |
| string/replace | 0.106ms | 0.054ms | 0.054ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | host-call |
| string/substring | 0.100ms | 0.031ms | 0.031ms | FAILED | host-call |
| string/trim | 0.170ms | 0.163ms | 0.162ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.402ms | 0.220ms | 0.220ms | 0.562ms | gc-native |
| array/push-pop | 1.47ms | 0.531ms | 0.537ms | FAILED | host-call |
| array/sort-i32 | 0.793ms | 0.393ms | 0.398ms | FAILED | host-call |
| array/map-filter | 0.130ms | 0.075ms | 0.081ms | FAILED | host-call |
| array/reduce | 1.46ms | 0.536ms | 0.537ms | FAILED | host-call |
| array/indexOf | 3.95ms | 5.24ms | 5.23ms | FAILED | js |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.53ms | 3.53ms | FAILED | gc-native |
| array/forEach | 0.087ms | 0.049ms | 0.049ms | FAILED | host-call |
| array/find | 0.255ms | 0.012ms | 0.012ms | 1.01ms | gc-native |
| dom/create-elements | 0.053ms | 0.957ms | — | — | js |
| dom/set-attributes | 0.125ms | 6.87ms | — | — | js |
| dom/read-attributes | 0.077ms | FAILED | — | — | js |
| dom/modify-text | 0.047ms | 1.68ms | — | — | js |
| mixed/csv-parse | 0.486ms | 0.316ms | 0.314ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 0.263ms | 0.263ms | 1.08ms | host-call |
| mixed/fibonacci | 0.120ms | 0.284ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 0.213ms | 0.213ms | 0.724ms | js |
| mixed/sieve | 1.65ms | 2.14ms | 2.16ms | FAILED | js |

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
| string/concat-short | 10000 | 2.19 | 4.55 | 4.41 | — |
| string/concat-long | 1000 | 3.61 | 3.10 | 3.07 | — |
| string/indexOf | 1000 | 19.17 | 16.41 | 16.35 | 14.60 |
| string/includes | 1000 | 19.24 | 20.83 | 20.95 | 15.39 |
| string/split | 10000 | 42.35 | 41.07 | 41.44 | — |
| string/replace | 1000 | 106.22 | 54.12 | 53.98 | — |
| string/case-convert | 2000 | 27.80 | 3.28 | 3.28 | — |
| string/substring | 10000 | 9.96 | 3.07 | 3.08 | — |
| string/trim | 10000 | 17.03 | 16.26 | 16.24 | — |
| string/startsWith-endsWith | 20000 | 20.11 | 11.01 | 11.00 | 28.09 |
| array/map-filter | 30000 | 4.34 | 2.51 | 2.71 | — |
| array/indexOf | 1000 | 3953.63 | 5235.24 | 5229.56 | — |
| dom/create-elements | 2000 | 26.48 | 478.26 | — | — |
| dom/set-attributes | 6000 | 20.81 | 1144.71 | — | — |
| dom/read-attributes | 3000 | 25.58 | — | — | — |
| dom/modify-text | 2000 | 23.50 | 841.56 | — | — |
| mixed/csv-parse | 11000 | 44.22 | 28.73 | 28.55 | — |
| mixed/text-search | 40000 | 9.71 | 6.57 | 6.57 | 27.00 |
| mixed/fibonacci | 10000 | 12.03 | 28.36 | 28.33 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.71 | 1.71 | 5.79 |
| mixed/sieve | 200000 | 8.26 | 10.69 | 10.82 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 2.08x slower | 2.01x slower | — |
| string/concat-long | 1.16x faster | 1.17x faster | — |
| string/indexOf | 1.17x faster | 1.17x faster | 1.31x faster |
| string/includes | 1.08x slower | 1.09x slower | 1.25x faster |
| string/split | 1.03x faster | 1.02x faster | — |
| string/replace | 1.96x faster | 1.97x faster | — |
| string/case-convert | 8.48x faster | 8.48x faster | — |
| string/substring | 3.24x faster | 3.24x faster | — |
| string/trim | 1.05x faster | 1.05x faster | — |
| string/startsWith-endsWith | 1.83x faster | 1.83x faster | 1.40x slower |
| array/push-pop | 2.77x faster | 2.74x faster | — |
| array/sort-i32 | 2.02x faster | 1.99x faster | — |
| array/map-filter | 1.73x faster | 1.60x faster | — |
| array/reduce | 2.73x faster | 2.72x faster | — |
| array/indexOf | 1.32x slower | 1.32x slower | — |
| array/slice | 1.08x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.76x faster | — |
| array/find | 21.54x faster | 21.77x faster | 3.95x slower |
| dom/create-elements | 18.06x slower | — | — |
| dom/set-attributes | 55.02x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 35.81x slower | — | — |
| mixed/csv-parse | 1.54x faster | 1.55x faster | — |
| mixed/text-search | 1.48x faster | 1.48x faster | 2.78x slower |
| mixed/fibonacci | 2.36x slower | 2.35x slower | 2.33x slower |
| mixed/matrix-multiply | 1.35x slower | 1.35x slower | 4.58x slower |
| mixed/sieve | 1.29x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.01x faster |
| string/indexOf | 1.00x faster |
| string/includes | 1.01x slower |
| string/split | 1.01x slower |
| string/replace | 1.00x faster |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x slower |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.08x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.00x slower |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
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
| string/concat-short | 1479.0ms | 592.7ms | — |
| string/concat-long | 1100.8ms | 1014.3ms | — |
| string/indexOf | 1009.2ms | 1008.2ms | 591.5ms |
| string/includes | 1067.5ms | 1003.0ms | 610.0ms |
| string/split | 1095.8ms | 1109.4ms | — |
| string/replace | 1187.6ms | 1135.5ms | — |
| string/case-convert | 1079.9ms | 1085.5ms | — |
| string/substring | 539.0ms | 538.7ms | — |
| string/trim | 1063.7ms | 1088.7ms | — |
| string/startsWith-endsWith | 1123.2ms | 1098.1ms | 654.2ms |
| array/push-pop | 1071.7ms | 1057.3ms | — |
| array/sort-i32 | 1152.6ms | 1132.8ms | — |
| array/map-filter | 1237.3ms | 1195.2ms | — |
| array/reduce | 1166.0ms | 1158.2ms | — |
| array/indexOf | 1126.1ms | 1111.8ms | — |
| array/slice | 1067.8ms | 1057.5ms | — |
| array/reverse | 1063.1ms | 1055.1ms | — |
| array/forEach | 1122.7ms | 1124.1ms | — |
| array/find | 3162.8ms | 3061.8ms | 600.3ms |
| dom/create-elements | 719.2ms | — | — |
| dom/set-attributes | 672.1ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 637.6ms | — | — |
| mixed/csv-parse | 1119.6ms | 1127.8ms | — |
| mixed/text-search | 1101.8ms | 1120.6ms | 647.7ms |
| mixed/fibonacci | 594.2ms | 566.0ms | 511.8ms |
| mixed/matrix-multiply | 1155.0ms | 1104.0ms | 579.0ms |
| mixed/sieve | 1109.9ms | 1132.0ms | — |
