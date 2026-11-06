# js2wasm Benchmark Results

Date: 2026-11-06
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.044ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.016ms | 0.016ms | 0.017ms | gc-native |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.015ms | linear-memory |
| string/split | 0.424ms | 0.413ms | 0.411ms | FAILED | gc-native |
| string/replace | 0.101ms | 0.054ms | 0.054ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | host-call |
| string/substring | 0.099ms | 0.031ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 0.163ms | 0.163ms | FAILED | host-call |
| string/startsWith-endsWith | 0.402ms | 0.220ms | 0.220ms | 0.559ms | host-call |
| array/push-pop | 1.49ms | 0.531ms | 0.531ms | FAILED | gc-native |
| array/sort-i32 | 0.788ms | 0.395ms | 0.400ms | FAILED | host-call |
| array/map-filter | 0.126ms | 0.075ms | 0.081ms | FAILED | host-call |
| array/reduce | 1.42ms | 0.531ms | 0.530ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 5.24ms | 5.23ms | FAILED | js |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.055ms | 0.049ms | 0.049ms | FAILED | host-call |
| array/find | 0.253ms | 0.012ms | 0.012ms | 1.09ms | gc-native |
| dom/create-elements | 0.034ms | 0.930ms | — | — | js |
| dom/set-attributes | 0.103ms | 6.73ms | — | — | js |
| dom/read-attributes | 0.056ms | FAILED | — | — | js |
| dom/modify-text | 0.029ms | 1.72ms | — | — | js |
| mixed/csv-parse | 0.486ms | 0.317ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.391ms | 0.264ms | 0.263ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.296ms | js |
| mixed/matrix-multiply | 0.157ms | 0.213ms | 0.228ms | 0.726ms | js |
| mixed/sieve | 1.62ms | 2.16ms | 2.19ms | FAILED | js |

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
| string/concat-short | 10000 | 3.21 | 4.41 | 4.40 | — |
| string/concat-long | 1000 | 3.57 | 3.00 | 2.92 | — |
| string/indexOf | 1000 | 19.12 | 16.38 | 16.34 | 16.70 |
| string/includes | 1000 | 19.17 | 20.91 | 20.86 | 15.37 |
| string/split | 10000 | 42.35 | 41.27 | 41.11 | — |
| string/replace | 1000 | 101.23 | 54.43 | 53.96 | — |
| string/case-convert | 2000 | 27.80 | 3.28 | 3.28 | — |
| string/substring | 10000 | 9.86 | 3.07 | 3.07 | — |
| string/trim | 10000 | 17.07 | 16.30 | 16.31 | — |
| string/startsWith-endsWith | 20000 | 20.11 | 11.00 | 11.00 | 27.96 |
| array/map-filter | 30000 | 4.19 | 2.50 | 2.68 | — |
| array/indexOf | 1000 | 3948.04 | 5243.27 | 5226.84 | — |
| dom/create-elements | 2000 | 17.05 | 465.20 | — | — |
| dom/set-attributes | 6000 | 17.14 | 1120.93 | — | — |
| dom/read-attributes | 3000 | 18.65 | — | — | — |
| dom/modify-text | 2000 | 14.39 | 858.35 | — | — |
| mixed/csv-parse | 11000 | 44.19 | 28.82 | 28.65 | — |
| mixed/text-search | 40000 | 9.76 | 6.60 | 6.57 | 27.23 |
| mixed/fibonacci | 10000 | 12.03 | 28.34 | 28.34 | 29.65 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.70 | 1.82 | 5.81 |
| mixed/sieve | 200000 | 8.09 | 10.79 | 10.94 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.37x slower | 1.37x slower | — |
| string/concat-long | 1.19x faster | 1.22x faster | — |
| string/indexOf | 1.17x faster | 1.17x faster | 1.14x faster |
| string/includes | 1.09x slower | 1.09x slower | 1.25x faster |
| string/split | 1.03x faster | 1.03x faster | — |
| string/replace | 1.86x faster | 1.88x faster | — |
| string/case-convert | 8.48x faster | 8.48x faster | — |
| string/substring | 3.21x faster | 3.21x faster | — |
| string/trim | 1.05x faster | 1.05x faster | — |
| string/startsWith-endsWith | 1.83x faster | 1.83x faster | 1.39x slower |
| array/push-pop | 2.80x faster | 2.81x faster | — |
| array/sort-i32 | 2.00x faster | 1.97x faster | — |
| array/map-filter | 1.68x faster | 1.56x faster | — |
| array/reduce | 2.68x faster | 2.68x faster | — |
| array/indexOf | 1.33x slower | 1.32x slower | — |
| array/slice | 1.08x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.12x faster | 1.12x faster | — |
| array/find | 21.77x faster | 21.84x faster | 4.29x slower |
| dom/create-elements | 27.29x slower | — | — |
| dom/set-attributes | 65.42x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 59.66x slower | — | — |
| mixed/csv-parse | 1.53x faster | 1.54x faster | — |
| mixed/text-search | 1.48x faster | 1.49x faster | 2.79x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.47x slower |
| mixed/matrix-multiply | 1.35x slower | 1.45x slower | 4.62x slower |
| mixed/sieve | 1.33x slower | 1.35x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.00x faster |
| string/concat-long | 1.03x faster |
| string/indexOf | 1.00x faster |
| string/includes | 1.00x faster |
| string/split | 1.00x faster |
| string/replace | 1.01x faster |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x faster |
| string/trim | 1.00x slower |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.07x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.01x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.07x slower |
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
| array/find | 61.8KB | 61.8KB | 666B |
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
| string/concat-short | 1422.1ms | 605.3ms | — |
| string/concat-long | 1087.9ms | 1001.1ms | — |
| string/indexOf | 988.2ms | 1000.4ms | 602.4ms |
| string/includes | 1024.6ms | 1007.4ms | 606.2ms |
| string/split | 1144.0ms | 1169.4ms | — |
| string/replace | 1171.2ms | 1158.0ms | — |
| string/case-convert | 1102.3ms | 1078.9ms | — |
| string/substring | 541.9ms | 540.3ms | — |
| string/trim | 1077.8ms | 1071.9ms | — |
| string/startsWith-endsWith | 1104.8ms | 1121.8ms | 663.8ms |
| array/push-pop | 1094.2ms | 1081.5ms | — |
| array/sort-i32 | 1157.6ms | 1140.9ms | — |
| array/map-filter | 1235.7ms | 1204.1ms | — |
| array/reduce | 1157.7ms | 1161.2ms | — |
| array/indexOf | 1135.6ms | 1100.3ms | — |
| array/slice | 1056.6ms | 1064.1ms | — |
| array/reverse | 1071.9ms | 1086.6ms | — |
| array/forEach | 1148.3ms | 1137.3ms | — |
| array/find | 3161.3ms | 3076.3ms | 588.8ms |
| dom/create-elements | 679.8ms | — | — |
| dom/set-attributes | 640.7ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 642.0ms | — | — |
| mixed/csv-parse | 1113.4ms | 1108.2ms | — |
| mixed/text-search | 1133.2ms | 1148.6ms | 690.5ms |
| mixed/fibonacci | 595.3ms | 581.5ms | 522.3ms |
| mixed/matrix-multiply | 1117.2ms | 1124.9ms | 561.3ms |
| mixed/sieve | 1108.4ms | 1129.4ms | — |
