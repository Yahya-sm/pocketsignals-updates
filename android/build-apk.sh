#!/usr/bin/env bash
# Builds PocketSignals.apk on Linux (GitHub Actions) without Gradle: aapt2 -> javac -> d8 -> zipalign -> apksigner.
# Same steps as build-apk.ps1. Needs ANDROID_HOME (SDK with platform 34 + build-tools 34), a JDK 17 and
# the signing key as base64 in KEYSTORE_B64 (always the same key, or Android refuses the update).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/.."
src="$here/app/src/main"
out="$here/build"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -n "$SDK" ] || { echo "ANDROID_HOME fehlt"; exit 1; }

JAR="$SDK/platforms/android-34/android.jar"
BT="$(ls -d "$SDK"/build-tools/34.* 2>/dev/null | sort -V | tail -1 || true)"
if [ ! -f "$JAR" ] || [ -z "$BT" ]; then
  yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" "platforms;android-34" "build-tools;34.0.0" >/dev/null
  BT="$SDK/build-tools/34.0.0"
fi

(cd "$root" && node tools/build-mobile.js)

rm -rf "$out"; mkdir -p "$out/res" "$out/gen" "$out/classes" "$out/dex"

ver="$(node -p "require('$root/package.json').version")"
IFS=. read -r a b c <<< "$ver"
code=$((a * 10000 + b * 100 + c))

"$BT/aapt2" compile --dir "$src/res" -o "$out/res/res.zip"
"$BT/aapt2" link -I "$JAR" --manifest "$src/AndroidManifest.xml" -o "$out/base.apk" --java "$out/gen" "$out/res/res.zip" \
  --min-sdk-version 24 --target-sdk-version 34 --version-code "$code" --version-name "$ver" --replace-version

javac -nowarn --release 8 -classpath "$JAR" -d "$out/classes" $(find "$src/java" "$out/gen" -name '*.java')
"$BT/d8" --min-api 24 --lib "$JAR" --output "$out/dex" $(find "$out/classes" -name '*.class')

cp "$out/base.apk" "$out/unsigned.apk"
(cd "$out/dex" && zip -q "$out/unsigned.apk" classes.dex)
(cd "$src" && zip -qr "$out/unsigned.apk" assets)
"$BT/zipalign" -f 4 "$out/unsigned.apk" "$out/aligned.apk"

ks="$out/signal-app.keystore"
[ -n "${KEYSTORE_B64:-}" ] || { echo "KEYSTORE_B64 fehlt"; exit 1; }
echo "$KEYSTORE_B64" | base64 -d > "$ks"
"$BT/apksigner" sign --ks "$ks" --ks-pass pass:signalapp --key-pass pass:signalapp --out "$root/PocketSignals.apk" "$out/aligned.apk"
rm -f "$ks"
"$BT/apksigner" verify "$root/PocketSignals.apk"
echo "APK fertig: $root/PocketSignals.apk ($ver)"
