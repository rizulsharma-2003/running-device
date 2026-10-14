#!/bin/sh
# Builds resources/ios-mirror, a universal (arm64 + x86_64) macOS helper that
# streams a USB-connected iPhone's screen. Needs Xcode command-line tools.
set -e
cd "$(dirname "$0")/.."
SRC=native/ios-mirror/main.swift
OUT=resources/ios-mirror
TMP=$(mktemp -d)
for arch in arm64 x86_64; do
  xcrun swiftc -O -target "$arch-apple-macos14.0" "$SRC" -o "$TMP/ios-mirror-$arch"
done
lipo -create "$TMP/ios-mirror-arm64" "$TMP/ios-mirror-x86_64" -output "$OUT"
codesign --force --sign - "$OUT"
rm -rf "$TMP"
echo "Built $OUT"
lipo -info "$OUT"
