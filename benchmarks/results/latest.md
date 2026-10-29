# js2wasm Benchmark Results

Date: 2026-10-29
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.022ms | 0.051ms | 0.049ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.016ms | 0.016ms | 0.022ms | gc-native |
| string/includes | 0.019ms | 0.019ms | 0.019ms | 0.025ms | js |
| string/split | 0.425ms | 0.506ms | 0.508ms | FAILED | js |
| string/replace | 0.096ms | 0.055ms | 0.054ms | FAILED | gc-native |
| string/case-convert | 0.059ms | 0.007ms | 0.007ms | FAILED | gc-native |
| string/substring | 0.105ms | 0.034ms | 0.034ms | FAILED | host-call |
| string/trim | 0.173ms | 0.176ms | 0.176ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.233ms | 0.233ms | 0.559ms | host-call |
| array/push-pop | 1.70ms | 0.617ms | 0.617ms | FAILED | gc-native |
| array/sort-i32 | 0.839ms | 0.400ms | 0.409ms | FAILED | host-call |
| array/map-filter | 0.134ms | 0.072ms | 0.078ms | FAILED | host-call |
| array/reduce | 1.71ms | 0.622ms | 0.623ms | FAILED | host-call |
| array/indexOf | 4.47ms | 5.96ms | 5.95ms | FAILED | js |
| array/slice | 0.034ms | 0.017ms | 0.017ms | FAILED | gc-native |
| array/reverse | 8.85ms | 3.61ms | 3.61ms | FAILED | host-call |
| array/forEach | 0.052ms | 0.052ms | 0.052ms | FAILED | js |
| array/find | 0.272ms | 0.011ms | 0.011ms | 1.22ms | host-call |
| dom/create-elements | 0.038ms | 0.914ms | — | — | js |
| dom/set-attributes | 0.108ms | 6.43ms | — | — | js |
| dom/read-attributes | 0.061ms | FAILED | — | — | js |
| dom/modify-text | 0.031ms | 1.65ms | — | — | js |
| mixed/csv-parse | 0.470ms | 0.307ms | 0.304ms | FAILED | gc-native |
| mixed/text-search | 0.404ms | 0.293ms | 0.291ms | 1.13ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.328ms | 0.328ms | 0.325ms | js |
| mixed/matrix-multiply | 0.185ms | 0.213ms | 0.214ms | 0.729ms | js |
| mixed/sieve | 1.82ms | 2.37ms | 2.36ms | FAILED | js |

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
| string/concat-short | 10000 | 2.24 | 5.08 | 4.89 | — |
| string/concat-long | 1000 | 4.19 | 2.96 | 2.91 | — |
| string/indexOf | 1000 | 18.94 | 15.85 | 15.81 | 22.21 |
| string/includes | 1000 | 18.71 | 19.50 | 19.45 | 25.39 |
| string/split | 10000 | 42.47 | 50.58 | 50.77 | — |
| string/replace | 1000 | 96.02 | 54.60 | 54.31 | — |
| string/case-convert | 2000 | 29.73 | 3.69 | 3.69 | — |
| string/substring | 10000 | 10.47 | 3.44 | 3.44 | — |
| string/trim | 10000 | 17.31 | 17.63 | 17.61 | — |
| string/startsWith-endsWith | 20000 | 20.63 | 11.64 | 11.66 | 27.96 |
| array/map-filter | 30000 | 4.46 | 2.40 | 2.60 | — |
| array/indexOf | 1000 | 4466.50 | 5955.66 | 5948.72 | — |
| dom/create-elements | 2000 | 18.97 | 457.03 | — | — |
| dom/set-attributes | 6000 | 18.00 | 1071.47 | — | — |
| dom/read-attributes | 3000 | 20.22 | — | — | — |
| dom/modify-text | 2000 | 15.32 | 822.65 | — | — |
| mixed/csv-parse | 11000 | 42.73 | 27.94 | 27.61 | — |
| mixed/text-search | 40000 | 10.09 | 7.34 | 7.28 | 28.13 |
| mixed/fibonacci | 10000 | 12.53 | 32.76 | 32.78 | 32.49 |
| mixed/matrix-multiply | 125000 | 1.48 | 1.71 | 1.71 | 5.83 |
| mixed/sieve | 200000 | 9.11 | 11.84 | 11.81 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 2.27x slower | 2.18x slower | — |
| string/concat-long | 1.41x faster | 1.44x faster | — |
| string/indexOf | 1.20x faster | 1.20x faster | 1.17x slower |
| string/includes | 1.04x slower | 1.04x slower | 1.36x slower |
| string/split | 1.19x slower | 1.20x slower | — |
| string/replace | 1.76x faster | 1.77x faster | — |
| string/case-convert | 8.05x faster | 8.05x faster | — |
| string/substring | 3.05x faster | 3.04x faster | — |
| string/trim | 1.02x slower | 1.02x slower | — |
| string/startsWith-endsWith | 1.77x faster | 1.77x faster | 1.36x slower |
| array/push-pop | 2.75x faster | 2.75x faster | — |
| array/sort-i32 | 2.10x faster | 2.05x faster | — |
| array/map-filter | 1.86x faster | 1.71x faster | — |
| array/reduce | 2.75x faster | 2.75x faster | — |
| array/indexOf | 1.33x slower | 1.33x slower | — |
| array/slice | 2.03x faster | 2.03x faster | — |
| array/reverse | 2.45x faster | 2.45x faster | — |
| array/forEach | 1.01x slower | 1.01x slower | — |
| array/find | 25.56x faster | 24.66x faster | 4.48x slower |
| dom/create-elements | 24.09x slower | — | — |
| dom/set-attributes | 59.53x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 53.70x slower | — | — |
| mixed/csv-parse | 1.53x faster | 1.55x faster | — |
| mixed/text-search | 1.38x faster | 1.39x faster | 2.79x slower |
| mixed/fibonacci | 2.62x slower | 2.62x slower | 2.59x slower |
| mixed/matrix-multiply | 1.15x slower | 1.15x slower | 3.94x slower |
| mixed/sieve | 1.30x slower | 1.30x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x faster |
| string/concat-long | 1.02x faster |
| string/indexOf | 1.00x faster |
| string/includes | 1.00x faster |
| string/split | 1.00x slower |
| string/replace | 1.01x faster |
| string/case-convert | 1.00x faster |
| string/substring | 1.00x slower |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.02x slower |
| array/map-filter | 1.09x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.04x slower |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.01x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
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
| string/concat-short | 1380.0ms | 589.8ms | — |
| string/concat-long | 1062.8ms | 989.6ms | — |
| string/indexOf | 994.0ms | 975.9ms | 574.0ms |
| string/includes | 992.1ms | 984.9ms | 616.0ms |
| string/split | 1088.8ms | 1151.6ms | — |
| string/replace | 1166.6ms | 1134.9ms | — |
| string/case-convert | 1083.3ms | 1062.4ms | — |
| string/substring | 519.3ms | 516.1ms | — |
| string/trim | 1053.6ms | 1064.6ms | — |
| string/startsWith-endsWith | 1067.8ms | 1095.5ms | 657.2ms |
| array/push-pop | 1084.7ms | 1055.6ms | — |
| array/sort-i32 | 1133.2ms | 1090.9ms | — |
| array/map-filter | 1222.9ms | 1183.5ms | — |
| array/reduce | 1136.7ms | 1131.9ms | — |
| array/indexOf | 1096.2ms | 1068.0ms | — |
| array/slice | 1063.5ms | 1068.4ms | — |
| array/reverse | 1044.0ms | 1059.6ms | — |
| array/forEach | 1082.9ms | 1091.8ms | — |
| array/find | 3073.7ms | 3028.5ms | 572.7ms |
| dom/create-elements | 661.6ms | — | — |
| dom/set-attributes | 618.4ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 653.8ms | — | — |
| mixed/csv-parse | 1103.0ms | 1095.1ms | — |
| mixed/text-search | 1106.3ms | 1129.9ms | 647.9ms |
| mixed/fibonacci | 585.3ms | 570.6ms | 496.0ms |
| mixed/matrix-multiply | 1115.0ms | 1104.7ms | 542.8ms |
| mixed/sieve | 1103.7ms | 1114.9ms | — |
