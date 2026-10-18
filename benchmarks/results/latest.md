# js2wasm Benchmark Results

Date: 2026-10-18
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.042ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.016ms | 0.016ms | 0.015ms | linear-memory |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.018ms | linear-memory |
| string/split | 0.424ms | 0.414ms | 0.413ms | FAILED | gc-native |
| string/replace | 0.101ms | 0.054ms | 0.055ms | FAILED | host-call |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | host-call |
| string/substring | 0.099ms | 0.031ms | 0.031ms | FAILED | host-call |
| string/trim | 0.170ms | 0.163ms | 0.162ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.401ms | 0.220ms | 0.225ms | 0.561ms | host-call |
| array/push-pop | 1.38ms | 0.505ms | 0.500ms | FAILED | gc-native |
| array/sort-i32 | 0.793ms | 0.394ms | 0.394ms | FAILED | host-call |
| array/map-filter | 0.071ms | 0.075ms | 0.081ms | FAILED | js |
| array/reduce | 1.33ms | 0.498ms | 0.498ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.024ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.049ms | 0.049ms | FAILED | host-call |
| array/find | 0.253ms | 0.012ms | 0.012ms | 1.07ms | gc-native |
| dom/create-elements | 0.035ms | 0.946ms | — | — | js |
| dom/set-attributes | 0.104ms | 6.82ms | — | — | js |
| dom/read-attributes | 0.056ms | FAILED | — | — | js |
| dom/modify-text | 0.029ms | 1.74ms | — | — | js |
| mixed/csv-parse | 1.00ms | 0.317ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.391ms | 0.263ms | 0.263ms | 1.10ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.157ms | 0.213ms | 0.214ms | 0.717ms | js |
| mixed/sieve | 1.54ms | 2.09ms | 2.10ms | FAILED | js |

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
| string/concat-short | 10000 | 3.45 | 4.23 | 4.38 | — |
| string/concat-long | 1000 | 3.58 | 3.03 | 2.95 | — |
| string/indexOf | 1000 | 19.14 | 16.49 | 16.48 | 15.06 |
| string/includes | 1000 | 19.19 | 21.20 | 21.16 | 18.48 |
| string/split | 10000 | 42.45 | 41.40 | 41.33 | — |
| string/replace | 1000 | 101.24 | 54.37 | 55.36 | — |
| string/case-convert | 2000 | 27.91 | 3.28 | 3.28 | — |
| string/substring | 10000 | 9.88 | 3.07 | 3.07 | — |
| string/trim | 10000 | 17.02 | 16.26 | 16.23 | — |
| string/startsWith-endsWith | 20000 | 20.07 | 11.00 | 11.24 | 28.03 |
| array/map-filter | 30000 | 2.36 | 2.49 | 2.71 | — |
| array/indexOf | 1000 | 3952.62 | 2637.70 | 2640.02 | — |
| dom/create-elements | 2000 | 17.33 | 472.96 | — | — |
| dom/set-attributes | 6000 | 17.33 | 1136.42 | — | — |
| dom/read-attributes | 3000 | 18.73 | — | — | — |
| dom/modify-text | 2000 | 14.70 | 871.70 | — | — |
| mixed/csv-parse | 11000 | 91.12 | 28.85 | 28.60 | — |
| mixed/text-search | 40000 | 9.78 | 6.58 | 6.56 | 27.40 |
| mixed/fibonacci | 10000 | 12.02 | 28.31 | 28.30 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.70 | 1.71 | 5.74 |
| mixed/sieve | 200000 | 7.70 | 10.44 | 10.50 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.23x slower | 1.27x slower | — |
| string/concat-long | 1.18x faster | 1.22x faster | — |
| string/indexOf | 1.16x faster | 1.16x faster | 1.27x faster |
| string/includes | 1.10x slower | 1.10x slower | 1.04x faster |
| string/split | 1.03x faster | 1.03x faster | — |
| string/replace | 1.86x faster | 1.83x faster | — |
| string/case-convert | 8.52x faster | 8.52x faster | — |
| string/substring | 3.22x faster | 3.22x faster | — |
| string/trim | 1.05x faster | 1.05x faster | — |
| string/startsWith-endsWith | 1.82x faster | 1.79x faster | 1.40x slower |
| array/push-pop | 2.74x faster | 2.77x faster | — |
| array/sort-i32 | 2.02x faster | 2.02x faster | — |
| array/map-filter | 1.06x slower | 1.15x slower | — |
| array/reduce | 2.68x faster | 2.67x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.09x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.01x faster | 1.01x faster | — |
| array/find | 21.57x faster | 21.77x faster | 4.24x slower |
| dom/create-elements | 27.30x slower | — | — |
| dom/set-attributes | 65.57x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 59.28x slower | — | — |
| mixed/csv-parse | 3.16x faster | 3.19x faster | — |
| mixed/text-search | 1.49x faster | 1.49x faster | 2.80x slower |
| mixed/fibonacci | 2.35x slower | 2.35x slower | 2.34x slower |
| mixed/matrix-multiply | 1.35x slower | 1.36x slower | 4.55x slower |
| mixed/sieve | 1.35x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x slower |
| string/concat-long | 1.03x faster |
| string/indexOf | 1.00x faster |
| string/includes | 1.00x faster |
| string/split | 1.00x faster |
| string/replace | 1.02x slower |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x slower |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.02x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.09x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.00x faster |
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
| string/concat-short | 1363.5ms | 546.6ms | — |
| string/concat-long | 1022.2ms | 961.3ms | — |
| string/indexOf | 950.4ms | 944.0ms | 548.1ms |
| string/includes | 925.5ms | 957.4ms | 538.1ms |
| string/split | 1051.8ms | 1079.7ms | — |
| string/replace | 1086.1ms | 1072.7ms | — |
| string/case-convert | 1033.7ms | 1026.6ms | — |
| string/substring | 497.9ms | 487.5ms | — |
| string/trim | 1015.8ms | 1019.1ms | — |
| string/startsWith-endsWith | 1050.3ms | 1071.8ms | 624.2ms |
| array/push-pop | 1021.5ms | 1012.0ms | — |
| array/sort-i32 | 1096.0ms | 1080.0ms | — |
| array/map-filter | 1157.3ms | 1131.2ms | — |
| array/reduce | 1093.9ms | 1075.2ms | — |
| array/indexOf | 1045.7ms | 1035.4ms | — |
| array/slice | 1021.4ms | 1023.4ms | — |
| array/reverse | 1029.7ms | 1030.7ms | — |
| array/forEach | 1062.3ms | 1057.3ms | — |
| array/find | 2387.3ms | 2340.6ms | 533.8ms |
| dom/create-elements | 640.8ms | — | — |
| dom/set-attributes | 605.2ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 592.9ms | — | — |
| mixed/csv-parse | 1032.1ms | 1043.3ms | — |
| mixed/text-search | 1050.0ms | 1071.0ms | 643.9ms |
| mixed/fibonacci | 533.1ms | 526.0ms | 458.3ms |
| mixed/matrix-multiply | 1073.8ms | 1063.2ms | 505.4ms |
| mixed/sieve | 1061.6ms | 1048.6ms | — |
