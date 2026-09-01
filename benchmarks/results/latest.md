# js2wasm Benchmark Results

Date: 2026-09-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.051ms | 0.050ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.061ms | 0.012ms | 0.030ms | gc-native |
| string/includes | 0.019ms | 0.106ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.426ms | 7.76ms | 2.56ms | FAILED | js |
| string/replace | 0.094ms | 0.555ms | 0.273ms | FAILED | js |
| string/case-convert | 0.058ms | 0.535ms | 0.232ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.14ms | 2.30ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.43ms | 2.53ms | 0.552ms | js |
| array/push-pop | 1.65ms | 0.595ms | 0.596ms | FAILED | host-call |
| array/sort-i32 | 0.850ms | 0.299ms | 0.554ms | FAILED | host-call |
| array/map-filter | 0.133ms | 0.065ms | 0.066ms | FAILED | host-call |
| array/reduce | 2.37ms | 0.598ms | 0.597ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.033ms | 0.016ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.051ms | 0.028ms | 0.029ms | FAILED | host-call |
| array/find | 0.270ms | 0.015ms | 0.015ms | 1.20ms | gc-native |
| dom/create-elements | 0.034ms | 0.153ms | — | — | js |
| dom/set-attributes | 0.109ms | 0.534ms | — | — | js |
| dom/read-attributes | 0.060ms | 0.133ms | — | — | js |
| dom/modify-text | 0.032ms | 0.111ms | — | — | js |
| mixed/csv-parse | 0.466ms | 8.18ms | 0.536ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.36ms | 2.40ms | 1.13ms | js |
| mixed/fibonacci | 0.125ms | 0.327ms | 0.328ms | 0.325ms | js |
| mixed/matrix-multiply | 0.184ms | 61.62ms | 63.69ms | 0.721ms | js |
| mixed/sieve | 1.73ms | 2.29ms | 2.29ms | FAILED | js |

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
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.34 | 5.05 | 5.00 | — |
| string/concat-long | 1000 | 4.49 | 5.32 | 3.51 | — |
| string/indexOf | 1000 | 18.91 | 60.62 | 12.17 | 30.39 |
| string/includes | 1000 | 18.63 | 105.81 | 13.75 | 16.61 |
| string/split | 10000 | 42.56 | 776.14 | 256.49 | — |
| string/replace | 1000 | 94.14 | 555.09 | 272.85 | — |
| string/case-convert | 2000 | 29.22 | 267.27 | 116.07 | — |
| string/substring | 10000 | 10.39 | 4.00 | 3.43 | — |
| string/trim | 10000 | 17.34 | 314.04 | 229.67 | — |
| string/startsWith-endsWith | 20000 | 20.63 | 121.63 | 126.54 | 27.62 |
| array/map-filter | 30000 | 4.43 | 2.17 | 2.20 | — |
| array/indexOf | 1000 | 4459.96 | 2862.85 | 2862.43 | — |
| dom/create-elements | 2000 | 17.22 | 76.74 | — | — |
| dom/set-attributes | 6000 | 18.22 | 88.92 | — | — |
| dom/read-attributes | 3000 | 19.97 | 44.44 | — | — |
| dom/modify-text | 2000 | 15.84 | 55.74 | — | — |
| mixed/csv-parse | 11000 | 42.39 | 743.36 | 48.68 | — |
| mixed/text-search | 40000 | 10.08 | 108.95 | 59.89 | 28.24 |
| mixed/fibonacci | 10000 | 12.54 | 32.75 | 32.75 | 32.50 |
| mixed/matrix-multiply | 125000 | 1.47 | 492.96 | 509.55 | 5.77 |
| mixed/sieve | 200000 | 8.67 | 11.45 | 11.44 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.51x slower | 1.50x slower | — |
| string/concat-long | 1.19x slower | 1.28x faster | — |
| string/indexOf | 3.21x slower | 1.55x faster | 1.61x slower |
| string/includes | 5.68x slower | 1.35x faster | 1.12x faster |
| string/split | 18.24x slower | 6.03x slower | — |
| string/replace | 5.90x slower | 2.90x slower | — |
| string/case-convert | 9.15x slower | 3.97x slower | — |
| string/substring | 2.60x faster | 3.03x faster | — |
| string/trim | 18.12x slower | 13.25x slower | — |
| string/startsWith-endsWith | 5.90x slower | 6.13x slower | 1.34x slower |
| array/push-pop | 2.77x faster | 2.76x faster | — |
| array/sort-i32 | 2.84x faster | 1.53x faster | — |
| array/map-filter | 2.05x faster | 2.02x faster | — |
| array/reduce | 3.96x faster | 3.97x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.08x faster | 1.98x faster | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 1.81x faster | 1.79x faster | — |
| array/find | 18.39x faster | 18.47x faster | 4.46x slower |
| dom/create-elements | 4.46x slower | — | — |
| dom/set-attributes | 4.88x slower | — | — |
| dom/read-attributes | 2.23x slower | — | — |
| dom/modify-text | 3.52x slower | — | — |
| mixed/csv-parse | 17.54x slower | 1.15x slower | — |
| mixed/text-search | 10.81x slower | 5.94x slower | 2.80x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 334.88x slower | 346.14x slower | 3.92x slower |
| mixed/sieve | 1.32x slower | 1.32x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.01x faster |
| string/concat-long | 1.52x faster |
| string/indexOf | 4.98x faster |
| string/includes | 7.69x faster |
| string/split | 3.03x faster |
| string/replace | 2.03x faster |
| string/case-convert | 2.30x faster |
| string/substring | 1.17x faster |
| string/trim | 1.37x faster |
| string/startsWith-endsWith | 1.04x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.85x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.05x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 15.27x faster |
| mixed/text-search | 1.82x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.03x slower |
| mixed/sieve | 1.00x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.4KB | 3.0KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1606.8ms | 1015.0ms | — |
| string/concat-long | 745.5ms | 954.8ms | — |
| string/indexOf | 652.2ms | 908.3ms | 802.2ms |
| string/includes | 636.8ms | 978.3ms | 800.4ms |
| string/split | 753.0ms | 906.1ms | — |
| string/replace | 758.1ms | 997.8ms | — |
| string/case-convert | 773.5ms | 832.1ms | — |
| string/substring | 637.0ms | 759.9ms | — |
| string/trim | 746.4ms | 945.2ms | — |
| string/startsWith-endsWith | 762.0ms | 947.7ms | 873.4ms |
| array/push-pop | 778.3ms | 834.6ms | — |
| array/sort-i32 | 914.5ms | 962.2ms | — |
| array/map-filter | 916.8ms | 1001.4ms | — |
| array/reduce | 824.7ms | 851.2ms | — |
| array/indexOf | 831.7ms | 932.2ms | — |
| array/slice | 750.4ms | 868.0ms | — |
| array/reverse | 752.8ms | 829.6ms | — |
| array/forEach | 850.5ms | 937.8ms | — |
| array/find | 749.9ms | 832.4ms | 801.1ms |
| dom/create-elements | 682.8ms | — | — |
| dom/set-attributes | 690.4ms | — | — |
| dom/read-attributes | 667.6ms | — | — |
| dom/modify-text | 649.9ms | — | — |
| mixed/csv-parse | 761.2ms | 919.7ms | — |
| mixed/text-search | 766.9ms | 884.9ms | 869.8ms |
| mixed/fibonacci | 730.3ms | 764.4ms | 720.0ms |
| mixed/matrix-multiply | 880.9ms | 968.9ms | 784.2ms |
| mixed/sieve | 816.7ms | 903.6ms | — |
