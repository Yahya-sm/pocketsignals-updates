# Draws the PocketSignals icon (blue rounded square, white pulse line) and writes ui/icon.png
# plus the Android launcher icons. Run: powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$S = 512

function Draw-Icon([int]$size) {
  $bmp = New-Object Drawing.Bitmap $size, $size
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([Drawing.Color]::Transparent)
  $k = $size / $S

  # Rounded square with a soft diagonal gradient.
  $r = 116 * $k; $d = 2 * $r; $w = $size - 1
  $path = New-Object Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc($w - $d, 0, $d, $d, 270, 90)
  $path.AddArc($w - $d, $w - $d, $d, $d, 0, 90); $path.AddArc(0, $w - $d, $d, $d, 90, 90); $path.CloseFigure()
  $brush = New-Object Drawing.Drawing2D.LinearGradientBrush (New-Object Drawing.PointF 0, 0), (New-Object Drawing.PointF $size, $size), ([Drawing.Color]::FromArgb(92, 152, 255)), ([Drawing.Color]::FromArgb(30, 76, 214))
  $g.FillPath($brush, $path)

  # Pulse line: flat, one sharp spike up and down, flat again – ending in a dot (the signal).
  $pts = @(@(104, 286), @(196, 286), @(232, 186), @(282, 352), @(318, 246), @(346, 286)) |
    ForEach-Object { New-Object Drawing.PointF ($_[0] * $k), ($_[1] * $k) }
  $pen = New-Object Drawing.Pen ([Drawing.Color]::White), (34 * $k)
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $g.DrawLines($pen, [Drawing.PointF[]]$pts)
  $dot = 30 * $k
  $g.FillEllipse([Drawing.Brushes]::White, (404 * $k) - $dot, (286 * $k) - $dot, 2 * $dot, 2 * $dot)

  $g.Dispose()
  return $bmp
}

# Notification icon for Android: only the white pulse line + dot on transparent (Android shows it as a silhouette).
function Draw-Glyph([int]$size) {
  $bmp = New-Object Drawing.Bitmap $size, $size
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([Drawing.Color]::Transparent)
  # The pulse spans x 104..434 and y 186..352 in the 512 grid; scale it to fill the icon with a small margin.
  $k = ($size * 0.84) / 360; $ox = ($size - 360 * $k) / 2 - 74 * $k; $oy = $size / 2 - 269 * $k
  $pts = @(@(104, 286), @(196, 286), @(232, 186), @(282, 352), @(318, 246), @(346, 286)) |
    ForEach-Object { New-Object Drawing.PointF ($ox + $_[0] * $k), ($oy + $_[1] * $k) }
  $pen = New-Object Drawing.Pen ([Drawing.Color]::White), (40 * $k)
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $g.DrawLines($pen, [Drawing.PointF[]]$pts)
  $dot = 34 * $k
  $g.FillEllipse([Drawing.Brushes]::White, $ox + 404 * $k - $dot, $oy + 286 * $k - $dot, 2 * $dot, 2 * $dot)
  $g.Dispose()
  return $bmp
}
foreach ($d in @(@('mdpi', 24), @('hdpi', 36), @('xhdpi', 48), @('xxhdpi', 72), @('xxxhdpi', 96))) {
  $dir = "$root\android\app\src\main\res\drawable-$($d[0])"
  New-Item -ItemType Directory -Force $dir | Out-Null
  $b = Draw-Glyph $d[1]
  $b.Save("$dir\ic_stat_notify.png", [Drawing.Imaging.ImageFormat]::Png); $b.Dispose()
}

$main = Draw-Icon 256
$main.Save("$root\ui\icon.png", [Drawing.Imaging.ImageFormat]::Png); $main.Dispose()
$big = Draw-Icon 512
$big.Save("$root\ui\icon-512.png", [Drawing.Imaging.ImageFormat]::Png); $big.Dispose()
foreach ($d in @(@('mdpi', 48), @('hdpi', 72), @('xhdpi', 96), @('xxhdpi', 144), @('xxxhdpi', 192))) {
  $b = Draw-Icon $d[1]
  $b.Save("$root\android\app\src\main\res\mipmap-$($d[0])\ic_launcher.png", [Drawing.Imaging.ImageFormat]::Png); $b.Dispose()
}
Write-Host 'Icon geschrieben'
