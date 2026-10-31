# js2wasm Benchmark Results

Date: 2026-10-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.045ms | 0.044ms | 0.046ms | FAILED | host-call |
| string/concat-long | 0.004ms | 0.006ms | 0.006ms | FAILED | js |
| string/indexOf | 0.012ms | 0.012ms | 0.012ms | 0.027ms | host-call |
| string/includes | 0.013ms | 0.016ms | 0.016ms | 0.028ms | js |
| string/split | 0.290ms | 0.346ms | 0.320ms | FAILED | js |
| string/replace | 0.064ms | 0.042ms | 0.042ms | FAILED | host-call |
| string/case-convert | 0.047ms | 0.005ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.128ms | 0.024ms | 0.024ms | FAILED | host-call |
| string/trim | 0.239ms | 0.114ms | 0.114ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.371ms | 0.153ms | 0.152ms | 0.402ms | gc-native |
| array/push-pop | 1.24ms | 0.411ms | 0.413ms | FAILED | host-call |
| array/sort-i32 | 0.472ms | 0.329ms | 0.328ms | FAILED | gc-native |
| array/map-filter | 0.116ms | 0.070ms | 0.075ms | FAILED | host-call |
| array/reduce | 1.18ms | 0.406ms | 0.412ms | FAILED | host-call |
| array/indexOf | 4.05ms | 4.81ms | 5.09ms | FAILED | js |
| array/slice | 0.045ms | 0.043ms | 0.041ms | FAILED | gc-native |
| array/reverse | 5.44ms | 3.15ms | 2.86ms | FAILED | gc-native |
| array/forEach | 0.054ms | 0.033ms | 0.033ms | FAILED | host-call |
| array/find | 0.225ms | 0.013ms | 0.013ms | 0.747ms | host-call |
| dom/create-elements | 0.064ms | 0.621ms | — | — | js |
| dom/set-attributes | 0.113ms | 5.04ms | — | — | js |
| dom/read-attributes | 0.075ms | FAILED | — | — | js |
| dom/modify-text | 0.059ms | 1.25ms | — | — | js |
| mixed/csv-parse | 0.332ms | 0.223ms | 0.220ms | FAILED | gc-native |
| mixed/text-search | 0.313ms | 0.195ms | 0.195ms | 0.859ms | host-call |
| mixed/fibonacci | 0.103ms | 0.162ms | 0.183ms | 0.165ms | js |
| mixed/matrix-multiply | 0.150ms | 0.174ms | 0.179ms | 0.601ms | js |
| mixed/sieve | 1.42ms | 1.92ms | 1.88ms | FAILED | js |

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
| string/concat-short | 10000 | 4.54 | 4.35 | 4.61 | — |
| string/concat-long | 1000 | 3.84 | 5.57 | 5.71 | — |
| string/indexOf | 1000 | 12.11 | 11.90 | 11.94 | 26.89 |
| string/includes | 1000 | 12.58 | 15.78 | 15.52 | 27.95 |
| string/split | 10000 | 28.96 | 34.57 | 31.99 | — |
| string/replace | 1000 | 64.30 | 41.59 | 42.05 | — |
| string/case-convert | 2000 | 23.66 | 2.56 | 2.51 | — |
| string/substring | 10000 | 12.84 | 2.37 | 2.37 | — |
| string/trim | 10000 | 23.91 | 11.41 | 11.41 | — |
| string/startsWith-endsWith | 20000 | 18.54 | 7.67 | 7.62 | 20.08 |
| array/map-filter | 30000 | 3.86 | 2.33 | 2.51 | — |
| array/indexOf | 1000 | 4048.45 | 4807.95 | 5087.63 | — |
| dom/create-elements | 2000 | 32.11 | 310.69 | — | — |
| dom/set-attributes | 6000 | 18.76 | 840.33 | — | — |
| dom/read-attributes | 3000 | 25.05 | — | — | — |
| dom/modify-text | 2000 | 29.33 | 624.12 | — | — |
| mixed/csv-parse | 11000 | 30.16 | 20.30 | 20.00 | — |
| mixed/text-search | 40000 | 7.82 | 4.87 | 4.88 | 21.46 |
| mixed/fibonacci | 10000 | 10.25 | 16.16 | 18.28 | 16.54 |
| mixed/matrix-multiply | 125000 | 1.20 | 1.39 | 1.43 | 4.81 |
| mixed/sieve | 200000 | 7.10 | 9.58 | 9.41 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.04x faster | 1.01x slower | — |
| string/concat-long | 1.45x slower | 1.49x slower | — |
| string/indexOf | 1.02x faster | 1.01x faster | 2.22x slower |
| string/includes | 1.25x slower | 1.23x slower | 2.22x slower |
| string/split | 1.19x slower | 1.10x slower | — |
| string/replace | 1.55x faster | 1.53x faster | — |
| string/case-convert | 9.25x faster | 9.44x faster | — |
| string/substring | 5.42x faster | 5.41x faster | — |
| string/trim | 2.10x faster | 2.10x faster | — |
| string/startsWith-endsWith | 2.42x faster | 2.43x faster | 1.08x slower |
| array/push-pop | 3.01x faster | 3.00x faster | — |
| array/sort-i32 | 1.43x faster | 1.44x faster | — |
| array/map-filter | 1.66x faster | 1.54x faster | — |
| array/reduce | 2.91x faster | 2.87x faster | — |
| array/indexOf | 1.19x slower | 1.26x slower | — |
| array/slice | 1.05x faster | 1.10x faster | — |
| array/reverse | 1.73x faster | 1.91x faster | — |
| array/forEach | 1.63x faster | 1.61x faster | — |
| array/find | 17.44x faster | 17.09x faster | 3.31x slower |
| dom/create-elements | 9.68x slower | — | — |
| dom/set-attributes | 44.79x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 21.28x slower | — | — |
| mixed/csv-parse | 1.49x faster | 1.51x faster | — |
| mixed/text-search | 1.61x faster | 1.60x faster | 2.75x slower |
| mixed/fibonacci | 1.58x slower | 1.78x slower | 1.61x slower |
| mixed/matrix-multiply | 1.16x slower | 1.19x slower | 4.00x slower |
| mixed/sieve | 1.35x slower | 1.33x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.06x slower |
| string/concat-long | 1.02x slower |
| string/indexOf | 1.00x slower |
| string/includes | 1.02x faster |
| string/split | 1.08x faster |
| string/replace | 1.01x slower |
| string/case-convert | 1.02x faster |
| string/substring | 1.00x slower |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.08x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.06x slower |
| array/slice | 1.05x faster |
| array/reverse | 1.10x faster |
| array/forEach | 1.01x slower |
| array/find | 1.02x slower |
| mixed/csv-parse | 1.02x faster |
| mixed/text-search | 1.00x slower |
| mixed/fibonacci | 1.13x slower |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.02x faster |

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
| string/concat-short | 1076.0ms | 469.1ms | — |
| string/concat-long | 812.4ms | 756.7ms | — |
| string/indexOf | 739.4ms | 745.4ms | 462.2ms |
| string/includes | 798.2ms | 808.4ms | 475.4ms |
| string/split | 882.2ms | 830.6ms | — |
| string/replace | 855.6ms | 846.1ms | — |
| string/case-convert | 815.0ms | 780.8ms | — |
| string/substring | 443.3ms | 404.7ms | — |
| string/trim | 770.2ms | 787.5ms | — |
| string/startsWith-endsWith | 812.2ms | 816.9ms | 493.2ms |
| array/push-pop | 790.2ms | 774.4ms | — |
| array/sort-i32 | 842.4ms | 816.7ms | — |
| array/map-filter | 882.2ms | 862.1ms | — |
| array/reduce | 826.2ms | 839.4ms | — |
| array/indexOf | 812.9ms | 837.1ms | — |
| array/slice | 803.8ms | 821.1ms | — |
| array/reverse | 808.8ms | 808.6ms | — |
| array/forEach | 809.3ms | 800.7ms | — |
| array/find | 2242.6ms | 2185.4ms | 421.4ms |
| dom/create-elements | 521.3ms | — | — |
| dom/set-attributes | 486.8ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 529.8ms | — | — |
| mixed/csv-parse | 808.5ms | 793.1ms | — |
| mixed/text-search | 788.9ms | 840.3ms | 521.2ms |
| mixed/fibonacci | 441.8ms | 438.3ms | 429.5ms |
| mixed/matrix-multiply | 819.1ms | 820.7ms | 450.2ms |
| mixed/sieve | 822.8ms | 841.3ms | — |
