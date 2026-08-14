# js2wasm Benchmark Results

Date: 2026-08-14
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.029ms | 0.046ms | 0.050ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.103ms | 0.015ms | 0.018ms | gc-native |
| string/split | 0.423ms | 5.01ms | 0.448ms | FAILED | js |
| string/replace | 0.105ms | 0.300ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.237ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.923ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.371ms | 0.295ms | 0.562ms | gc-native |
| array/push-pop | 1.43ms | 0.510ms | 0.516ms | FAILED | host-call |
| array/sort-i32 | 0.790ms | 0.296ms | 0.294ms | FAILED | gc-native |
| array/map-filter | 0.133ms | 0.071ms | 0.072ms | FAILED | host-call |
| array/reduce | 2.16ms | 0.501ms | 0.505ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.028ms | 0.029ms | 0.029ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.53ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.036ms | 0.159ms | — | — | js |
| dom/set-attributes | 0.106ms | 0.597ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.122ms | — | — | js |
| dom/modify-text | 0.031ms | 0.105ms | — | — | js |
| mixed/csv-parse | 0.484ms | 7.19ms | 0.317ms | FAILED | gc-native |
| mixed/text-search | 0.395ms | 1.50ms | 0.266ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 1.18ms | js |
| mixed/matrix-multiply | 0.158ms | 0.210ms | 0.210ms | 0.723ms | js |
| mixed/sieve | 1.61ms | 1.45ms | 1.40ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 2.87 | 4.57 | 4.99 | — |
| string/concat-long | 1000 | 3.68 | 4.47 | 3.75 | — |
| string/indexOf | 1000 | 19.18 | 62.77 | 12.37 | 14.78 |
| string/includes | 1000 | 19.23 | 103.12 | 14.82 | 18.22 |
| string/split | 10000 | 42.35 | 501.30 | 44.83 | — |
| string/replace | 1000 | 104.60 | 299.91 | 56.47 | — |
| string/case-convert | 2000 | 27.98 | 118.37 | 2.51 | — |
| string/substring | 10000 | 9.85 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.00 | 92.27 | 18.65 | — |
| string/startsWith-endsWith | 20000 | 20.06 | 18.54 | 14.77 | 28.12 |
| array/map-filter | 30000 | 4.43 | 2.38 | 2.39 | — |
| array/indexOf | 1000 | 3951.59 | 2636.88 | 2635.95 | — |
| dom/create-elements | 2000 | 18.07 | 79.49 | — | — |
| dom/set-attributes | 6000 | 17.59 | 99.58 | — | — |
| dom/read-attributes | 3000 | 18.32 | 40.60 | — | — |
| dom/modify-text | 2000 | 15.47 | 52.61 | — | — |
| mixed/csv-parse | 11000 | 43.96 | 653.70 | 28.77 | — |
| mixed/text-search | 40000 | 9.86 | 37.48 | 6.65 | 26.95 |
| mixed/fibonacci | 10000 | 12.18 | 29.24 | 29.18 | 117.88 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.68 | 1.68 | 5.79 |
| mixed/sieve | 200000 | 8.06 | 7.26 | 6.99 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.60x slower | 1.74x slower | — |
| string/concat-long | 1.22x slower | 1.02x slower | — |
| string/indexOf | 3.27x slower | 1.55x faster | 1.30x faster |
| string/includes | 5.36x slower | 1.30x faster | 1.06x faster |
| string/split | 11.84x slower | 1.06x slower | — |
| string/replace | 2.87x slower | 1.85x faster | — |
| string/case-convert | 4.23x slower | 11.16x faster | — |
| string/substring | 2.63x faster | 3.21x faster | — |
| string/trim | 5.43x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.08x faster | 1.36x faster | 1.40x slower |
| array/push-pop | 2.80x faster | 2.76x faster | — |
| array/sort-i32 | 2.66x faster | 2.69x faster | — |
| array/map-filter | 1.86x faster | 1.86x faster | — |
| array/reduce | 4.30x faster | 4.27x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.04x slower | 1.03x slower | — |
| array/reverse | 2.23x faster | 2.22x faster | — |
| array/forEach | 1.75x faster | 1.75x faster | — |
| array/find | 15.90x faster | 16.02x faster | 4.22x slower |
| dom/create-elements | 4.40x slower | — | — |
| dom/set-attributes | 5.66x slower | — | — |
| dom/read-attributes | 2.22x slower | — | — |
| dom/modify-text | 3.40x slower | — | — |
| mixed/csv-parse | 14.87x slower | 1.53x faster | — |
| mixed/text-search | 3.80x slower | 1.48x faster | 2.73x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 9.68x slower |
| mixed/matrix-multiply | 1.33x slower | 1.33x slower | 4.57x slower |
| mixed/sieve | 1.11x faster | 1.15x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.09x slower |
| string/concat-long | 1.19x faster |
| string/indexOf | 5.08x faster |
| string/includes | 6.96x faster |
| string/split | 11.18x faster |
| string/replace | 5.31x faster |
| string/case-convert | 47.22x faster |
| string/substring | 1.22x faster |
| string/trim | 4.95x faster |
| string/startsWith-endsWith | 1.25x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 22.72x faster |
| mixed/text-search | 5.64x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.04x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.0KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.5KB | 1.7KB |
| array/push-pop | 914B | 1.2KB | — |
| array/sort-i32 | 2.5KB | 2.9KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.6KB | 2.0KB | — |
| array/slice | 994B | 1.3KB | — |
| array/reverse | 972B | 1.3KB | — |
| array/forEach | 2.5KB | 2.8KB | — |
| array/find | 920B | 1.2KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.1KB | — |
| mixed/text-search | 1.9KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.6KB | 1.9KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1328.3ms | 1093.4ms | — |
| string/concat-long | 663.0ms | 945.4ms | — |
| string/indexOf | 654.7ms | 992.7ms | 848.1ms |
| string/includes | 652.2ms | 975.1ms | 856.2ms |
| string/split | 771.6ms | 962.8ms | — |
| string/replace | 776.4ms | 1076.5ms | — |
| string/case-convert | 781.6ms | 843.4ms | — |
| string/substring | 682.2ms | 747.5ms | — |
| string/trim | 738.9ms | 980.1ms | — |
| string/startsWith-endsWith | 755.6ms | 997.9ms | 933.0ms |
| array/push-pop | 810.7ms | 876.8ms | — |
| array/sort-i32 | 945.9ms | 1003.6ms | — |
| array/map-filter | 947.0ms | 995.5ms | — |
| array/reduce | 850.0ms | 893.1ms | — |
| array/indexOf | 850.0ms | 949.4ms | — |
| array/slice | 804.8ms | 874.7ms | — |
| array/reverse | 778.8ms | 877.4ms | — |
| array/forEach | 898.8ms | 956.6ms | — |
| array/find | 744.6ms | 834.7ms | 819.9ms |
| dom/create-elements | 610.6ms | — | — |
| dom/set-attributes | 679.5ms | — | — |
| dom/read-attributes | 693.1ms | — | — |
| dom/modify-text | 591.3ms | — | — |
| mixed/csv-parse | 807.2ms | 928.6ms | — |
| mixed/text-search | 769.4ms | 982.2ms | 913.8ms |
| mixed/fibonacci | 758.3ms | 795.5ms | 765.0ms |
| mixed/matrix-multiply | 856.8ms | 922.9ms | 830.1ms |
| mixed/sieve | 846.1ms | 946.4ms | — |
