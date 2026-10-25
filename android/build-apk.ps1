# Builds PocketSignals.apk without Gradle: aapt2 -> javac -> d8 -> zipalign -> apksigner.
$ErrorActionPreference = 'Stop'
$A = "$env:USERPROFILE\Android"
$BT = "$A\sdk\build-tools\34.0.0"
$JAR = "$A\sdk\platforms\android-34\android.jar"
$env:JAVA_HOME = "$A\jdk"; $env:PATH = "$A\jdk\bin;$env:PATH"
$here = $PSScriptRoot
$src = "$here\app\src\main"
$out = "$here\build"

Push-Location (Join-Path $here '..')
node tools/build-mobile.js
Pop-Location

Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$out\res", "$out\gen", "$out\classes", "$out\dex" | Out-Null

& "$BT\aapt2.exe" compile --dir "$src\res" -o "$out\res\res.zip"
# Assets are added with jar below: aapt2 -A on Windows writes "www\file" entry names, which Android cannot open.
# Same version as the PC app (package.json); versionCode 1.0.20 -> 10020 so Android accepts each update.
$ver = (Get-Content (Join-Path $here '..\package.json') -Raw | ConvertFrom-Json).version
$p = $ver.Split('.') | ForEach-Object { [int]$_ }
$code = $p[0] * 10000 + $p[1] * 100 + $p[2]
& "$BT\aapt2.exe" link -I $JAR --manifest "$src\AndroidManifest.xml" -o "$out\base.apk" --java "$out\gen" "$out\res\res.zip" --min-sdk-version 24 --target-sdk-version 34 --version-code $code --version-name $ver --replace-version
if ($LASTEXITCODE) { throw 'aapt2 link failed' }

$java = Get-ChildItem "$src\java", "$out\gen" -Recurse -Filter *.java | ForEach-Object FullName
# Compile against the JDK's Java 8 API plus android.jar; d8 desugars the lambdas afterwards.
& javac -nowarn --release 8 -classpath $JAR -d "$out\classes" @java
if ($LASTEXITCODE) { throw 'javac failed' }

$classes = Get-ChildItem "$out\classes" -Recurse -Filter *.class | ForEach-Object FullName
& "$BT\d8.bat" --min-api 24 --lib $JAR --output "$out\dex" @classes
if ($LASTEXITCODE) { throw 'd8 failed' }

Copy-Item "$out\base.apk" "$out\unsigned.apk"
Push-Location "$out\dex"; & jar uf "$out\unsigned.apk" classes.dex; Pop-Location
Push-Location "$src"; & jar uf "$out\unsigned.apk" assets; Pop-Location
& "$BT\zipalign.exe" -f 4 "$out\unsigned.apk" "$out\aligned.apk"

$ks = "$here\signal-app.keystore"
if (-not (Test-Path $ks)) {
  & keytool -genkeypair -keystore $ks -alias signalapp -keyalg RSA -keysize 2048 -validity 10000 -storepass signalapp -keypass signalapp -dname "CN=Signal-App"
}
& "$BT\apksigner.bat" sign --ks $ks --ks-pass pass:signalapp --key-pass pass:signalapp --out "$here\..\PocketSignals.apk" "$out\aligned.apk"
if ($LASTEXITCODE) { throw 'apksigner failed' }
& "$BT\apksigner.bat" verify "$here\..\PocketSignals.apk"
Write-Host "APK fertig: $(Resolve-Path "$here\..\PocketSignals.apk")"
