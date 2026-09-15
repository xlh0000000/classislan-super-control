$ErrorActionPreference = "Continue"
$dest = "D:\Code\ClassislandControl\_pkgs"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$pkgs = @(
"AsyncImageLoader.Avalonia/3.8.0","Avalonia/12.1.1","Avalonia.Angle.Windows.Natives/2.1.27548.20260419",
"Avalonia.AvaloniaEdit/12.0.0-rc1","Avalonia.BuildServices/11.3.2","Avalonia.Controls.ColorPicker/12.1.1",
"Avalonia.Controls.DataGrid/12.0.0","Avalonia.Desktop/12.1.1","Avalonia.FreeDesktop/12.1.1",
"Avalonia.FreeDesktop.AtSpi/12.1.1","Avalonia.HarfBuzz/12.1.1","Avalonia.Labs.CommandManager/12.0.2",
"Avalonia.Markup.Xaml.Loader/12.1.1","Avalonia.Native/12.1.1","Avalonia.Remote.Protocol/12.1.1",
"Avalonia.Skia/12.1.1","Avalonia.Win32/12.1.1","Avalonia.X11/12.1.1",
"ClassIsland.ColorDocument.Avalonia/12.0.0","ClassIsland.ColorTextBlock.Avalonia/12.0.0","ClassIsland.Core/2.1.1.1",
"ClassIsland.Markdown.Avalonia/12.0.0","ClassIsland.Markdown.Avalonia.Html/12.0.0","ClassIsland.Markdown.Avalonia.Svg/12.0.0",
"ClassIsland.Markdown.Avalonia.SyntaxHigh/12.0.0","ClassIsland.Markdown.Avalonia.Tight/12.0.0",
"ClassIsland.Platforms.Abstractions/2.1.1.1","ClassIsland.PluginSdk/2.1.1.1","ClassIsland.Shared/2.1.1.1",
"ClassIsland.Shared.IPC/2.1.1.1","CommunityToolkit.Mvvm/8.2.1","CsesSharp/1.0.0","dotnetCampus.Ipc/2.0.0-alpha410",
"DynamicData/9.1.2","ExCSS/4.3.1","FluentAvaloniaUI/3.0.0","Google.Protobuf/3.27.0-rc1","Grpc.Core.Api/2.71.0",
"Grpc.Net.Client/2.71.0","Grpc.Net.Common/2.71.0","HarfBuzzSharp/8.3.1.3","HarfBuzzSharp.NativeAssets.Linux/8.3.1.3",
"HarfBuzzSharp.NativeAssets.macOS/8.3.1.3","HarfBuzzSharp.NativeAssets.WebAssembly/8.3.1.3",
"HarfBuzzSharp.NativeAssets.Win32/8.3.1.3","HtmlAgilityPack/1.11.42","Lib.Harmony.Thin/2.4.2",
"MicroCom.Runtime/0.11.6","Microsoft.Extensions.Configuration/10.0.10","Microsoft.Extensions.Configuration.Abstractions/10.0.10",
"Microsoft.Extensions.Configuration.Binder/10.0.10","Microsoft.Extensions.Configuration.CommandLine/10.0.10",
"Microsoft.Extensions.Configuration.EnvironmentVariables/10.0.10","Microsoft.Extensions.Configuration.FileExtensions/10.0.10",
"Microsoft.Extensions.Configuration.Json/10.0.10","Microsoft.Extensions.Configuration.UserSecrets/10.0.10",
"Microsoft.Extensions.DependencyInjection/10.0.10","Microsoft.Extensions.DependencyInjection.Abstractions/10.0.10",
"Microsoft.Extensions.Diagnostics/10.0.10","Microsoft.Extensions.Diagnostics.Abstractions/10.0.10",
"Microsoft.Extensions.FileProviders.Abstractions/10.0.10","Microsoft.Extensions.FileProviders.Physical/10.0.10",
"Microsoft.Extensions.FileSystemGlobbing/10.0.10","Microsoft.Extensions.Hosting/10.0.10",
"Microsoft.Extensions.Hosting.Abstractions/10.0.10","Microsoft.Extensions.Logging/10.0.10",
"Microsoft.Extensions.Logging.Abstractions/10.0.10","Microsoft.Extensions.Logging.Configuration/10.0.10",
"Microsoft.Extensions.Logging.Console/10.0.10","Microsoft.Extensions.Logging.Debug/10.0.10",
"Microsoft.Extensions.Logging.EventLog/10.0.10","Microsoft.Extensions.Logging.EventSource/10.0.10",
"Microsoft.Extensions.Options/10.0.10","Microsoft.Extensions.Options.ConfigurationExtensions/10.0.10",
"Microsoft.Extensions.Primitives/10.0.10","Mono.Cecil/0.11.6","MonoMod.Backports/1.1.2","MonoMod.Core/1.3.3",
"MonoMod.ILHelpers/1.1.0","MonoMod.Utils/25.0.11","MoonSharp/2.0.0","Newtonsoft.Json/13.0.2","Octokit/9.1.0",
"ReactiveUI/20.2.45","ShimSkiaSharp/4.5.0","SkiaSharp/3.119.4","SkiaSharp.NativeAssets.Linux/3.119.4",
"SkiaSharp.NativeAssets.macOS/3.119.4","SkiaSharp.NativeAssets.WebAssembly/3.119.4","SkiaSharp.NativeAssets.Win32/3.119.4",
"SmoothScroll.Avalonia/12.0.0.10","SmoothScroll.Avalonia.Interaction/12.0.0.10","SoundFlow/1.2.1","Splat/15.3.1",
"Svg.Controls.Avalonia/12.0.0.5","Svg.Custom/4.5.0","Svg.Model/4.5.0","Svg.SceneGraph/4.5.0",
"System.ComponentModel.Annotations/5.0.0","System.Diagnostics.EventLog/10.0.10","System.Reactive/6.0.1",
"Tmds.DBus.Protocol/0.94.1","Xaml.Behaviors/12.0.0","YamlDotNet/16.3.0"
)
$failed = @()
foreach ($p in $pkgs) {
  $parts = $p.Split("/")
  $id = $parts[0]; $ver = $parts[1]
  $lid = $id.ToLowerInvariant(); $lver = $ver.ToLowerInvariant()
  $url = "https://api.nuget.org/v3-flatcontainer/$lid/$lver/$lid.$lver.nupkg"
  $out = Join-Path $dest "$id.$ver.nupkg"
  if (Test-Path $out) { if ((Get-Item $out).Length -gt 0) { Write-Host "skip $id.$ver"; continue } }
  $expected = 0
  $h = curl.exe -sIL $url 2>$null | Select-String -Pattern '^content-length:' | Select-Object -Last 1
  if ($h) { $expected = [int64]($h.ToString().Split(":")[1].Trim()) }
  if ($expected -eq 0) { Write-Host "MISSING $id.$ver"; $failed += $p; continue }
  $ok = $false
  for ($i = 0; $i -lt 25; $i++) {
    curl.exe -s -L -C - --max-time 90 -o $out $url 2>$null | Out-Null
    $sz = 0; if (Test-Path $out) { $sz = (Get-Item $out).Length }
    if ($sz -ge $expected) { $ok = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if ($ok) { Write-Host "ok   $id.$ver ($expected)" } else { Write-Host "FAIL $id.$ver $((Get-Item $out -ErrorAction SilentlyContinue).Length)/$expected"; $failed += $p }
}
Write-Host "==== FAILED: $($failed.Count) ===="
$failed | ForEach-Object { Write-Host $_ }