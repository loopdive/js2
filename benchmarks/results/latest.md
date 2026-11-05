# js2wasm Benchmark Results

Date: 2026-11-05
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.056ms | 0.069ms | 0.067ms | FAILED | js |
| string/concat-long | 0.006ms | 0.006ms | 0.006ms | FAILED | js |
| string/indexOf | 0.017ms | 0.015ms | 0.015ms | 0.017ms | host-call |
| string/includes | 0.016ms | 0.019ms | 0.021ms | 0.022ms | js |
| string/split | 0.404ms | 0.425ms | 0.425ms | FAILED | js |
| string/replace | 0.100ms | 0.064ms | 0.064ms | FAILED | host-call |
| string/case-convert | 0.075ms | 0.006ms | 0.006ms | FAILED | host-call |
| string/substring | 0.127ms | 0.033ms | 0.033ms | FAILED | gc-native |
| string/trim | 0.224ms | 0.154ms | 0.154ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.485ms | 0.208ms | 0.208ms | 0.567ms | gc-native |
| array/push-pop | 1.56ms | 0.517ms | 0.507ms | FAILED | gc-native |
| array/sort-i32 | 0.654ms | 0.432ms | 0.432ms | FAILED | host-call |
| array/map-filter | 0.151ms | 0.084ms | 0.090ms | FAILED | host-call |
| array/reduce | 1.51ms | 0.512ms | 0.501ms | FAILED | gc-native |
| array/indexOf | 5.40ms | 6.37ms | 6.37ms | FAILED | js |
| array/slice | 0.043ms | 0.052ms | 0.054ms | FAILED | js |
| array/reverse | 8.47ms | 3.82ms | 3.82ms | FAILED | host-call |
| array/forEach | 0.062ms | 0.041ms | 0.041ms | FAILED | host-call |
| array/find | 0.296ms | 0.014ms | 0.015ms | 1.01ms | host-call |
| dom/create-elements | 0.066ms | 0.882ms | — | — | js |
| dom/set-attributes | 0.134ms | 6.16ms | — | — | js |
| dom/read-attributes | 0.073ms | FAILED | — | — | js |
| dom/modify-text | 0.061ms | 1.60ms | — | — | js |
| mixed/csv-parse | 0.476ms | 0.409ms | 0.403ms | FAILED | gc-native |
| mixed/text-search | 0.444ms | 0.277ms | 0.266ms | 1.18ms | gc-native |
| mixed/fibonacci | 0.136ms | 0.217ms | 0.217ms | 0.216ms | js |
| mixed/matrix-multiply | 0.189ms | 0.228ms | 0.227ms | 0.731ms | js |
| mixed/sieve | 1.75ms | 2.50ms | 2.50ms | FAILED | js |

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
| string/concat-short | 10000 | 5.61 | 6.91 | 6.67 | — |
| string/concat-long | 1000 | 5.51 | 6.07 | 6.46 | — |
| string/indexOf | 1000 | 16.58 | 15.40 | 15.48 | 16.65 |
| string/includes | 1000 | 16.43 | 19.09 | 20.74 | 21.55 |
| string/split | 10000 | 40.37 | 42.50 | 42.53 | — |
| string/replace | 1000 | 100.25 | 63.75 | 64.00 | — |
| string/case-convert | 2000 | 37.31 | 2.94 | 3.01 | — |
| string/substring | 10000 | 12.72 | 3.26 | 3.26 | — |
| string/trim | 10000 | 22.37 | 15.39 | 15.39 | — |
| string/startsWith-endsWith | 20000 | 24.27 | 10.40 | 10.40 | 28.35 |
| array/map-filter | 30000 | 5.02 | 2.80 | 3.01 | — |
| array/indexOf | 1000 | 5403.43 | 6368.12 | 6371.66 | — |
| dom/create-elements | 2000 | 33.24 | 440.97 | — | — |
| dom/set-attributes | 6000 | 22.30 | 1026.50 | — | — |
| dom/read-attributes | 3000 | 24.35 | — | — | — |
| dom/modify-text | 2000 | 30.38 | 799.32 | — | — |
| mixed/csv-parse | 11000 | 43.29 | 37.16 | 36.63 | — |
| mixed/text-search | 40000 | 11.11 | 6.94 | 6.65 | 29.54 |
| mixed/fibonacci | 10000 | 13.63 | 21.71 | 21.74 | 21.58 |
| mixed/matrix-multiply | 125000 | 1.51 | 1.82 | 1.82 | 5.84 |
| mixed/sieve | 200000 | 8.73 | 12.52 | 12.51 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.23x slower | 1.19x slower | — |
| string/concat-long | 1.10x slower | 1.17x slower | — |
| string/indexOf | 1.08x faster | 1.07x faster | 1.00x slower |
| string/includes | 1.16x slower | 1.26x slower | 1.31x slower |
| string/split | 1.05x slower | 1.05x slower | — |
| string/replace | 1.57x faster | 1.57x faster | — |
| string/case-convert | 12.67x faster | 12.40x faster | — |
| string/substring | 3.91x faster | 3.91x faster | — |
| string/trim | 1.45x faster | 1.45x faster | — |
| string/startsWith-endsWith | 2.33x faster | 2.33x faster | 1.17x slower |
| array/push-pop | 3.02x faster | 3.08x faster | — |
| array/sort-i32 | 1.52x faster | 1.51x faster | — |
| array/map-filter | 1.80x faster | 1.67x faster | — |
| array/reduce | 2.94x faster | 3.01x faster | — |
| array/indexOf | 1.18x slower | 1.18x slower | — |
| array/slice | 1.22x slower | 1.26x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.53x faster | 1.52x faster | — |
| array/find | 21.34x faster | 20.28x faster | 3.42x slower |
| dom/create-elements | 13.27x slower | — | — |
| dom/set-attributes | 46.03x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 26.31x slower | — | — |
| mixed/csv-parse | 1.17x faster | 1.18x faster | — |
| mixed/text-search | 1.60x faster | 1.67x faster | 2.66x slower |
| mixed/fibonacci | 1.59x slower | 1.59x slower | 1.58x slower |
| mixed/matrix-multiply | 1.20x slower | 1.20x slower | 3.86x slower |
| mixed/sieve | 1.43x slower | 1.43x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.06x slower |
| string/indexOf | 1.00x slower |
| string/includes | 1.09x slower |
| string/split | 1.00x slower |
| string/replace | 1.00x slower |
| string/case-convert | 1.02x slower |
| string/substring | 1.00x faster |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.08x slower |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.03x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.05x slower |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.04x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
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
| string/concat-short | 1407.1ms | 616.9ms | — |
| string/concat-long | 1102.8ms | 1010.7ms | — |
| string/indexOf | 1007.2ms | 1002.4ms | 602.6ms |
| string/includes | 1018.8ms | 997.3ms | 592.7ms |
| string/split | 1106.1ms | 1077.3ms | — |
| string/replace | 1176.8ms | 1146.9ms | — |
| string/case-convert | 1096.7ms | 1070.0ms | — |
| string/substring | 539.9ms | 528.3ms | — |
| string/trim | 1088.2ms | 1085.4ms | — |
| string/startsWith-endsWith | 1076.6ms | 1126.4ms | 677.5ms |
| array/push-pop | 1083.3ms | 1091.0ms | — |
| array/sort-i32 | 1172.8ms | 1134.1ms | — |
| array/map-filter | 1238.3ms | 1210.3ms | — |
| array/reduce | 1140.1ms | 1144.1ms | — |
| array/indexOf | 1104.6ms | 1098.1ms | — |
| array/slice | 1072.3ms | 1065.5ms | — |
| array/reverse | 1066.3ms | 1080.7ms | — |
| array/forEach | 1138.7ms | 1107.8ms | — |
| array/find | 3117.9ms | 3041.9ms | 597.8ms |
| dom/create-elements | 698.4ms | — | — |
| dom/set-attributes | 650.0ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 654.0ms | — | — |
| mixed/csv-parse | 1128.0ms | 1105.9ms | — |
| mixed/text-search | 1125.9ms | 1136.9ms | 656.2ms |
| mixed/fibonacci | 595.9ms | 561.7ms | 503.0ms |
| mixed/matrix-multiply | 1154.1ms | 1128.4ms | 559.7ms |
| mixed/sieve | 1132.2ms | 1125.3ms | — |
