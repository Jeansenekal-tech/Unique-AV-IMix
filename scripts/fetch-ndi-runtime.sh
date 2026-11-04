#!/usr/bin/env bash
# Downloads the NDI® SDK for Apple and copies its runtime (libndi.dylib,
# universal) into the given folder. Used by CI to test with the real
# runtime and – when BUNDLE_NDI_RUNTIME=true – to ship it inside the app.
# By downloading it you accept the NDI SDK licence (https://ndi.video).
set -euo pipefail
DEST="${1:?destination folder}"
URL="${NDI_SDK_URL:-https://downloads.ndi.tv/SDK/NDI_SDK_Mac/Install_NDI_SDK_v6_Apple.pkg}"
WORK="$(mktemp -d)"
curl -fsSL --retry 3 -o "$WORK/ndi.pkg" "$URL"
pkgutil --expand-full "$WORK/ndi.pkg" "$WORK/pkg"
LIB="$(find "$WORK/pkg" -name 'libndi.dylib' -path '*macOS*' | head -1)"
[ -n "$LIB" ] || LIB="$(find "$WORK/pkg" -name 'libndi*.dylib' | head -1)"
[ -n "$LIB" ] || { echo "libndi.dylib not found in the NDI SDK package"; find "$WORK/pkg" -maxdepth 6 | head -50; exit 1; }
mkdir -p "$DEST"
cp "$LIB" "$DEST/libndi.dylib"
LICENSE="$(find "$WORK/pkg" -iname '*license*' -type f | head -1 || true)"
[ -n "$LICENSE" ] && cp "$LICENSE" "$DEST/NDI-LICENSE.$(basename "$LICENSE" | sed 's/.*\.//')" || true
file "$DEST/libndi.dylib"
echo "NDI runtime → $DEST/libndi.dylib"
