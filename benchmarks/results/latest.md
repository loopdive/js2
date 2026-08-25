# js2wasm Benchmark Results

Date: 2026-08-24
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.049ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.105ms | 0.014ms | 0.041ms | gc-native |
| string/split | 0.421ms | 4.64ms | 0.504ms | FAILED | js |
| string/replace | 0.096ms | 0.218ms | 0.059ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.221ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.924ms | 0.196ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.335ms | 0.308ms | 0.560ms | gc-native |
| array/push-pop | 1.68ms | 0.606ms | 0.593ms | FAILED | gc-native |
| array/sort-i32 | 0.839ms | 0.513ms | 0.301ms | FAILED | gc-native |
| array/map-filter | 0.135ms | 0.066ms | 0.072ms | FAILED | host-call |
| array/reduce | 1.68ms | 0.613ms | 0.605ms | FAILED | gc-native |
| array/indexOf | 4.47ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.036ms | 0.017ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.86ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.052ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.271ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.038ms | FAILED | — | — | js |
| dom/set-attributes | 0.110ms | FAILED | — | — | js |
| dom/read-attributes | 0.063ms | FAILED | — | — | js |
| dom/modify-text | 0.030ms | FAILED | — | — | js |
| mixed/csv-parse | 0.472ms | 7.31ms | 0.306ms | FAILED | gc-native |
| mixed/text-search | 0.392ms | 1.30ms | 0.292ms | 1.13ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.315ms | 0.306ms | 0.310ms | js |
| mixed/matrix-multiply | 0.185ms | 0.211ms | 0.212ms | 0.720ms | js |
| mixed/sieve | 1.75ms | 1.49ms | 1.50ms | FAILED | host-call |

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
| dom/create-elements | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/set-attributes | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/read-attributes | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/modify-text | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.39 | 4.90 | 3.85 | — |
| string/concat-long | 1000 | 4.17 | 5.40 | 3.48 | — |
| string/indexOf | 1000 | 18.95 | 59.61 | 12.21 | 16.33 |
| string/includes | 1000 | 18.68 | 104.53 | 13.78 | 41.29 |
| string/split | 10000 | 42.07 | 463.54 | 50.45 | — |
| string/replace | 1000 | 95.62 | 217.51 | 59.30 | — |
| string/case-convert | 2000 | 28.95 | 110.57 | 2.62 | — |
| string/substring | 10000 | 10.41 | 4.00 | 3.44 | — |
| string/trim | 10000 | 17.26 | 92.42 | 19.65 | — |
| string/startsWith-endsWith | 20000 | 20.65 | 16.74 | 15.40 | 28.00 |
| array/map-filter | 30000 | 4.50 | 2.19 | 2.39 | — |
| array/indexOf | 1000 | 4466.60 | 2860.64 | 2859.21 | — |
| dom/create-elements | 2000 | 18.90 | — | — | — |
| dom/set-attributes | 6000 | 18.34 | — | — | — |
| dom/read-attributes | 3000 | 20.86 | — | — | — |
| dom/modify-text | 2000 | 14.80 | — | — | — |
| mixed/csv-parse | 11000 | 42.89 | 664.76 | 27.78 | — |
| mixed/text-search | 40000 | 9.80 | 32.51 | 7.31 | 28.25 |
| mixed/fibonacci | 10000 | 12.53 | 31.55 | 30.58 | 30.97 |
| mixed/matrix-multiply | 125000 | 1.48 | 1.69 | 1.70 | 5.76 |
| mixed/sieve | 200000 | 8.76 | 7.44 | 7.51 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.45x slower | 1.14x slower | — |
| string/concat-long | 1.29x slower | 1.20x faster | — |
| string/indexOf | 3.15x slower | 1.55x faster | 1.16x faster |
| string/includes | 5.59x slower | 1.36x faster | 2.21x slower |
| string/split | 11.02x slower | 1.20x slower | — |
| string/replace | 2.27x slower | 1.61x faster | — |
| string/case-convert | 3.82x slower | 11.06x faster | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 5.35x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.23x faster | 1.34x faster | 1.36x slower |
| array/push-pop | 2.77x faster | 2.84x faster | — |
| array/sort-i32 | 1.63x faster | 2.79x faster | — |
| array/map-filter | 2.06x faster | 1.88x faster | — |
| array/reduce | 2.75x faster | 2.78x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.15x faster | 2.15x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.83x faster | 1.83x faster | — |
| array/find | 18.45x faster | 18.32x faster | 4.46x slower |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 15.50x slower | 1.54x faster | — |
| mixed/text-search | 3.32x slower | 1.34x faster | 2.88x slower |
| mixed/fibonacci | 2.52x slower | 2.44x slower | 2.47x slower |
| mixed/matrix-multiply | 1.14x slower | 1.15x slower | 3.89x slower |
| mixed/sieve | 1.18x faster | 1.17x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.27x faster |
| string/concat-long | 1.55x faster |
| string/indexOf | 4.88x faster |
| string/includes | 7.59x faster |
| string/split | 9.19x faster |
| string/replace | 3.67x faster |
| string/case-convert | 42.25x faster |
| string/substring | 1.16x faster |
| string/trim | 4.70x faster |
| string/startsWith-endsWith | 1.09x faster |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.71x faster |
| array/map-filter | 1.09x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 23.93x faster |
| mixed/text-search | 4.45x faster |
| mixed/fibonacci | 1.03x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.7KB | 2.1KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1235.8ms | 1048.7ms | — |
| string/concat-long | 628.6ms | 916.3ms | — |
| string/indexOf | 633.5ms | 940.7ms | 820.9ms |
| string/includes | 640.2ms | 977.0ms | 800.1ms |
| string/split | 759.2ms | 964.5ms | — |
| string/replace | 776.5ms | 1019.1ms | — |
| string/case-convert | 786.0ms | 849.4ms | — |
| string/substring | 647.2ms | 768.0ms | — |
| string/trim | 751.0ms | 951.8ms | — |
| string/startsWith-endsWith | 750.0ms | 955.7ms | 900.4ms |
| array/push-pop | 767.3ms | 846.9ms | — |
| array/sort-i32 | 911.6ms | 1022.5ms | — |
| array/map-filter | 923.9ms | 998.9ms | — |
| array/reduce | 891.4ms | 932.1ms | — |
| array/indexOf | 841.3ms | 877.9ms | — |
| array/slice | 798.1ms | 841.8ms | — |
| array/reverse | 752.2ms | 849.5ms | — |
| array/forEach | 906.1ms | 939.2ms | — |
| array/find | 737.0ms | 806.9ms | 809.3ms |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 775.4ms | 924.0ms | — |
| mixed/text-search | 747.9ms | 954.2ms | 870.4ms |
| mixed/fibonacci | 750.5ms | 802.4ms | 766.3ms |
| mixed/matrix-multiply | 853.6ms | 925.6ms | 807.4ms |
| mixed/sieve | 811.5ms | 897.6ms | — |
