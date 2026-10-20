# js2wasm Benchmark Results

Date: 2026-10-20
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.045ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.016ms | 0.016ms | 0.018ms | gc-native |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.015ms | linear-memory |
| string/split | 0.424ms | 0.411ms | 0.412ms | FAILED | host-call |
| string/replace | 0.101ms | 0.054ms | 0.054ms | FAILED | host-call |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.031ms | 0.031ms | FAILED | host-call |
| string/trim | 0.171ms | 0.163ms | 0.163ms | FAILED | host-call |
| string/startsWith-endsWith | 0.400ms | 0.220ms | 0.220ms | 0.561ms | gc-native |
| array/push-pop | 1.50ms | 0.533ms | 0.540ms | FAILED | host-call |
| array/sort-i32 | 0.790ms | 0.393ms | 0.436ms | FAILED | host-call |
| array/map-filter | 0.130ms | 0.076ms | 0.082ms | FAILED | host-call |
| array/reduce | 2.24ms | 0.536ms | 0.531ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.027ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.53ms | 3.53ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.049ms | 0.050ms | FAILED | js |
| array/find | 0.255ms | 0.012ms | 0.012ms | 1.08ms | gc-native |
| dom/create-elements | 0.036ms | 0.945ms | — | — | js |
| dom/set-attributes | 0.104ms | 6.80ms | — | — | js |
| dom/read-attributes | 0.058ms | FAILED | — | — | js |
| dom/modify-text | 0.029ms | 1.73ms | — | — | js |
| mixed/csv-parse | 0.487ms | 0.316ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 0.264ms | 0.263ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 0.213ms | 0.214ms | 0.723ms | js |
| mixed/sieve | 1.64ms | 2.15ms | 2.16ms | FAILED | js |

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
| string/concat-short | 10000 | 3.32 | 4.54 | 4.41 | — |
| string/concat-long | 1000 | 3.57 | 3.15 | 3.09 | — |
| string/indexOf | 1000 | 19.18 | 16.40 | 16.30 | 18.32 |
| string/includes | 1000 | 19.23 | 21.27 | 20.78 | 15.40 |
| string/split | 10000 | 42.39 | 41.10 | 41.17 | — |
| string/replace | 1000 | 100.64 | 54.11 | 54.12 | — |
| string/case-convert | 2000 | 27.87 | 3.29 | 3.28 | — |
| string/substring | 10000 | 9.87 | 3.07 | 3.07 | — |
| string/trim | 10000 | 17.05 | 16.26 | 16.29 | — |
| string/startsWith-endsWith | 20000 | 20.01 | 11.02 | 11.01 | 28.07 |
| array/map-filter | 30000 | 4.33 | 2.55 | 2.74 | — |
| array/indexOf | 1000 | 3953.20 | 2644.71 | 2641.23 | — |
| dom/create-elements | 2000 | 17.90 | 472.39 | — | — |
| dom/set-attributes | 6000 | 17.27 | 1133.10 | — | — |
| dom/read-attributes | 3000 | 19.21 | — | — | — |
| dom/modify-text | 2000 | 14.54 | 867.38 | — | — |
| mixed/csv-parse | 11000 | 44.27 | 28.74 | 28.66 | — |
| mixed/text-search | 40000 | 9.74 | 6.59 | 6.58 | 27.30 |
| mixed/fibonacci | 10000 | 12.03 | 28.32 | 28.33 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.70 | 1.71 | 5.79 |
| mixed/sieve | 200000 | 8.22 | 10.74 | 10.82 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.37x slower | 1.33x slower | — |
| string/concat-long | 1.13x faster | 1.15x faster | — |
| string/indexOf | 1.17x faster | 1.18x faster | 1.05x faster |
| string/includes | 1.11x slower | 1.08x slower | 1.25x faster |
| string/split | 1.03x faster | 1.03x faster | — |
| string/replace | 1.86x faster | 1.86x faster | — |
| string/case-convert | 8.48x faster | 8.50x faster | — |
| string/substring | 3.21x faster | 3.21x faster | — |
| string/trim | 1.05x faster | 1.05x faster | — |
| string/startsWith-endsWith | 1.82x faster | 1.82x faster | 1.40x slower |
| array/push-pop | 2.82x faster | 2.78x faster | — |
| array/sort-i32 | 2.01x faster | 1.81x faster | — |
| array/map-filter | 1.70x faster | 1.58x faster | — |
| array/reduce | 4.19x faster | 4.23x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.06x slower | 1.06x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.00x slower | 1.01x slower | — |
| array/find | 20.90x faster | 21.23x faster | 4.25x slower |
| dom/create-elements | 26.39x slower | — | — |
| dom/set-attributes | 65.60x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 59.67x slower | — | — |
| mixed/csv-parse | 1.54x faster | 1.54x faster | — |
| mixed/text-search | 1.48x faster | 1.48x faster | 2.80x slower |
| mixed/fibonacci | 2.35x slower | 2.36x slower | 2.33x slower |
| mixed/matrix-multiply | 1.35x slower | 1.35x slower | 4.57x slower |
| mixed/sieve | 1.31x slower | 1.32x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.02x faster |
| string/indexOf | 1.01x faster |
| string/includes | 1.02x faster |
| string/split | 1.00x slower |
| string/replace | 1.00x slower |
| string/case-convert | 1.00x faster |
| string/substring | 1.00x slower |
| string/trim | 1.00x slower |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.11x slower |
| array/map-filter | 1.08x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x slower |
| array/find | 1.02x faster |
| mixed/csv-parse | 1.00x faster |
| mixed/text-search | 1.00x faster |
| mixed/fibonacci | 1.00x slower |
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
| array/indexOf | 26.4KB | 26.4KB | — |
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
| string/concat-short | 1488.4ms | 602.5ms | — |
| string/concat-long | 1098.7ms | 1038.3ms | — |
| string/indexOf | 1013.1ms | 1003.1ms | 593.9ms |
| string/includes | 1016.7ms | 1013.3ms | 611.7ms |
| string/split | 1121.5ms | 1093.1ms | — |
| string/replace | 1204.1ms | 1139.9ms | — |
| string/case-convert | 1089.4ms | 1101.8ms | — |
| string/substring | 546.9ms | 530.7ms | — |
| string/trim | 1077.5ms | 1091.9ms | — |
| string/startsWith-endsWith | 1132.3ms | 1144.1ms | 665.2ms |
| array/push-pop | 1102.1ms | 1107.7ms | — |
| array/sort-i32 | 1201.5ms | 1133.8ms | — |
| array/map-filter | 1250.5ms | 1237.1ms | — |
| array/reduce | 1134.3ms | 1149.6ms | — |
| array/indexOf | 1115.5ms | 1116.8ms | — |
| array/slice | 1066.3ms | 1068.0ms | — |
| array/reverse | 1090.9ms | 1072.7ms | — |
| array/forEach | 1142.1ms | 1132.2ms | — |
| array/find | 2456.1ms | 2425.9ms | 579.9ms |
| dom/create-elements | 676.1ms | — | — |
| dom/set-attributes | 643.7ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 673.6ms | — | — |
| mixed/csv-parse | 1117.7ms | 1121.5ms | — |
| mixed/text-search | 1140.5ms | 1143.9ms | 667.2ms |
| mixed/fibonacci | 602.1ms | 575.8ms | 513.9ms |
| mixed/matrix-multiply | 1122.4ms | 1126.3ms | 568.9ms |
| mixed/sieve | 1119.6ms | 1121.2ms | — |
