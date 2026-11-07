# js2wasm Benchmark Results

Date: 2026-11-06
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.043ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | host-call |
| string/indexOf | 0.019ms | 0.016ms | 0.016ms | 0.015ms | linear-memory |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.015ms | linear-memory |
| string/split | 0.425ms | 0.413ms | 0.413ms | FAILED | gc-native |
| string/replace | 0.104ms | 0.054ms | 0.054ms | FAILED | host-call |
| string/case-convert | 0.055ms | 0.007ms | 0.007ms | FAILED | host-call |
| string/substring | 0.098ms | 0.031ms | 0.031ms | FAILED | host-call |
| string/trim | 0.169ms | 0.163ms | 0.163ms | FAILED | host-call |
| string/startsWith-endsWith | 0.402ms | 0.220ms | 0.220ms | 0.561ms | gc-native |
| array/push-pop | 1.52ms | 0.536ms | 0.530ms | FAILED | gc-native |
| array/sort-i32 | 0.800ms | 0.399ms | 0.399ms | FAILED | host-call |
| array/map-filter | 0.139ms | 0.075ms | 0.082ms | FAILED | host-call |
| array/reduce | 2.24ms | 0.530ms | 0.537ms | FAILED | host-call |
| array/indexOf | 3.97ms | 5.23ms | 5.23ms | FAILED | js |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.056ms | 0.049ms | 0.049ms | FAILED | host-call |
| array/find | 0.262ms | 0.012ms | 0.012ms | 1.08ms | gc-native |
| dom/create-elements | 0.040ms | 0.965ms | — | — | js |
| dom/set-attributes | 0.104ms | 6.89ms | — | — | js |
| dom/read-attributes | 0.057ms | FAILED | — | — | js |
| dom/modify-text | 0.028ms | 1.72ms | — | — | js |
| mixed/csv-parse | 0.493ms | 0.318ms | 0.316ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 0.265ms | 0.263ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 0.213ms | 0.230ms | 0.726ms | js |
| mixed/sieve | 1.65ms | 2.14ms | 2.17ms | FAILED | js |

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
| string/concat-short | 10000 | 2.78 | 4.27 | 4.36 | — |
| string/concat-long | 1000 | 3.55 | 2.97 | 2.97 | — |
| string/indexOf | 1000 | 19.16 | 16.14 | 16.13 | 14.60 |
| string/includes | 1000 | 19.17 | 20.77 | 20.97 | 15.41 |
| string/split | 10000 | 42.48 | 41.34 | 41.31 | — |
| string/replace | 1000 | 103.87 | 54.07 | 54.11 | — |
| string/case-convert | 2000 | 27.72 | 3.27 | 3.28 | — |
| string/substring | 10000 | 9.84 | 3.07 | 3.07 | — |
| string/trim | 10000 | 16.94 | 16.28 | 16.31 | — |
| string/startsWith-endsWith | 20000 | 20.08 | 11.01 | 11.00 | 28.05 |
| array/map-filter | 30000 | 4.64 | 2.49 | 2.72 | — |
| array/indexOf | 1000 | 3965.04 | 5230.91 | 5229.21 | — |
| dom/create-elements | 2000 | 20.23 | 482.42 | — | — |
| dom/set-attributes | 6000 | 17.40 | 1148.80 | — | — |
| dom/read-attributes | 3000 | 18.85 | — | — | — |
| dom/modify-text | 2000 | 14.12 | 860.50 | — | — |
| mixed/csv-parse | 11000 | 44.84 | 28.89 | 28.77 | — |
| mixed/text-search | 40000 | 9.73 | 6.61 | 6.58 | 27.11 |
| mixed/fibonacci | 10000 | 12.19 | 28.34 | 28.34 | 28.07 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.71 | 1.84 | 5.81 |
| mixed/sieve | 200000 | 8.27 | 10.68 | 10.83 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.54x slower | 1.57x slower | — |
| string/concat-long | 1.20x faster | 1.20x faster | — |
| string/indexOf | 1.19x faster | 1.19x faster | 1.31x faster |
| string/includes | 1.08x slower | 1.09x slower | 1.24x faster |
| string/split | 1.03x faster | 1.03x faster | — |
| string/replace | 1.92x faster | 1.92x faster | — |
| string/case-convert | 8.47x faster | 8.46x faster | — |
| string/substring | 3.20x faster | 3.20x faster | — |
| string/trim | 1.04x faster | 1.04x faster | — |
| string/startsWith-endsWith | 1.82x faster | 1.82x faster | 1.40x slower |
| array/push-pop | 2.83x faster | 2.86x faster | — |
| array/sort-i32 | 2.01x faster | 2.01x faster | — |
| array/map-filter | 1.86x faster | 1.71x faster | — |
| array/reduce | 4.22x faster | 4.17x faster | — |
| array/indexOf | 1.32x slower | 1.32x slower | — |
| array/slice | 1.07x slower | 1.06x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.15x faster | 1.15x faster | — |
| array/find | 21.61x faster | 21.72x faster | 4.14x slower |
| dom/create-elements | 23.84x slower | — | — |
| dom/set-attributes | 66.01x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 60.93x slower | — | — |
| mixed/csv-parse | 1.55x faster | 1.56x faster | — |
| mixed/text-search | 1.47x faster | 1.48x faster | 2.78x slower |
| mixed/fibonacci | 2.32x slower | 2.32x slower | 2.30x slower |
| mixed/matrix-multiply | 1.35x slower | 1.46x slower | 4.60x slower |
| mixed/sieve | 1.29x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.02x slower |
| string/concat-long | 1.00x slower |
| string/indexOf | 1.00x faster |
| string/includes | 1.01x slower |
| string/split | 1.00x faster |
| string/replace | 1.00x slower |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x slower |
| string/trim | 1.00x slower |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.09x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 1.00x faster |
| mixed/text-search | 1.01x faster |
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
| array/sort-i32 | 28.0KB | 28.0KB | — |
| array/map-filter | 29.1KB | 29.1KB | — |
| array/reduce | 27.6KB | 27.6KB | — |
| array/indexOf | 25.5KB | 25.5KB | — |
| array/slice | 25.4KB | 25.4KB | — |
| array/reverse | 25.4KB | 25.4KB | — |
| array/forEach | 27.8KB | 27.8KB | — |
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
| string/concat-short | 1493.6ms | 588.7ms | — |
| string/concat-long | 1104.6ms | 1021.2ms | — |
| string/indexOf | 1027.6ms | 1014.0ms | 594.0ms |
| string/includes | 987.4ms | 1014.0ms | 609.7ms |
| string/split | 1128.9ms | 1115.2ms | — |
| string/replace | 1140.9ms | 1144.2ms | — |
| string/case-convert | 1080.2ms | 1068.1ms | — |
| string/substring | 527.9ms | 541.4ms | — |
| string/trim | 1094.5ms | 1093.5ms | — |
| string/startsWith-endsWith | 1122.8ms | 1106.0ms | 684.1ms |
| array/push-pop | 1106.4ms | 1062.7ms | — |
| array/sort-i32 | 1171.1ms | 1139.3ms | — |
| array/map-filter | 1212.4ms | 1176.8ms | — |
| array/reduce | 1128.3ms | 1139.0ms | — |
| array/indexOf | 1117.6ms | 1104.0ms | — |
| array/slice | 1117.7ms | 1083.8ms | — |
| array/reverse | 1115.6ms | 1098.2ms | — |
| array/forEach | 1137.7ms | 1150.5ms | — |
| array/find | 3169.9ms | 3102.6ms | 615.4ms |
| dom/create-elements | 723.3ms | — | — |
| dom/set-attributes | 662.2ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 633.9ms | — | — |
| mixed/csv-parse | 1109.2ms | 1126.0ms | — |
| mixed/text-search | 1089.1ms | 1145.0ms | 664.1ms |
| mixed/fibonacci | 577.5ms | 571.4ms | 511.9ms |
| mixed/matrix-multiply | 1140.7ms | 1141.7ms | 565.8ms |
| mixed/sieve | 1145.2ms | 1142.7ms | — |
