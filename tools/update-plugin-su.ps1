<#
  Replaces files inside bin/s4_artifacts/Plugin_SU.zip (s4-content) and keeps a safe entry order.

  Usage (from anywhere, Windows PowerShell 5.1 or PowerShell 7):
    .\tools\update-plugin-su.ps1 -Asi "<path>\SettlersUnited.asi" -Uploader "<path>\LogUploader.exe"
  Both parameters are optional: only the given files are replaced, everything else stays as it is.

  Order: LogUploader.exe is written LAST. s4settings extracts the zip in entry order and aborts at the first file it
  can't overwrite; an old uploader still running from Plugins\LogUploader would otherwise block SettlersUnited.asi.
  (New plugins start a copy of the uploader from %LOCALAPPDATA%, so the installed exe is not locked anymore.)
#>
param(
    [string]$Asi,
    [string]$Uploader
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zipPath = (Resolve-Path (Join-Path $PSScriptRoot '..\bin\s4_artifacts\Plugin_SU.zip')).Path

$replacements = @{}
if ($Asi)      { $replacements['Plugins/SettlersUnited.asi'] = (Resolve-Path $Asi).Path }
if ($Uploader) { $replacements['Plugins/LogUploader/LogUploader.exe'] = (Resolve-Path $Uploader).Path }
if ($replacements.Count -eq 0) { throw 'Nothing to do: pass -Asi and/or -Uploader.' }

# read the current zip completely
$entries = New-Object System.Collections.ArrayList
$src = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    foreach ($e in $src.Entries) {
        $name = $e.FullName.Replace('\', '/')
        $data = $null
        if (-not $name.EndsWith('/')) {
            $ms = New-Object System.IO.MemoryStream
            $s = $e.Open()
            try { $s.CopyTo($ms) } finally { $s.Dispose() }
            $data = $ms.ToArray()
        }
        [void]$entries.Add([pscustomobject]@{ Name = $name; Data = $data; Time = $e.LastWriteTime })
    }
} finally {
    $src.Dispose()
}

# replace / add
foreach ($name in $replacements.Keys) {
    $file = Get-Item $replacements[$name]
    $existing = $entries | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if ($existing) {
        $existing.Data = [System.IO.File]::ReadAllBytes($file.FullName)
        $existing.Time = [DateTimeOffset]$file.LastWriteTime
    } else {
        $dir = $name.Substring(0, $name.LastIndexOf('/') + 1)
        if (-not ($entries | Where-Object { $_.Name -eq $dir })) {
            [void]$entries.Add([pscustomobject]@{ Name = $dir; Data = $null; Time = [DateTimeOffset]$file.LastWriteTime })
        }
        [void]$entries.Add([pscustomobject]@{ Name = $name; Data = [System.IO.File]::ReadAllBytes($file.FullName); Time = [DateTimeOffset]$file.LastWriteTime })
    }
    Write-Host ("{0} <- {1} ({2:N0} bytes, {3})" -f $name, $file.FullName, $file.Length, $file.LastWriteTime)
}

# uploader last (folder entry + exe), everything else in the original order
$isUploader = { param($n) $n -like 'Plugins/LogUploader/*' }
$ordered = @($entries | Where-Object { -not (& $isUploader $_.Name) }) + @($entries | Where-Object { & $isUploader $_.Name })

# write to a temp file, then replace
$tmp = "$zipPath.tmp"
if (Test-Path $tmp) { Remove-Item $tmp }
$fs = [System.IO.File]::Open($tmp, [System.IO.FileMode]::CreateNew)
$zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($e in $ordered) {
        $entry = $zip.CreateEntry($e.Name, [System.IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = $e.Time
        if ($e.Data) {
            $s = $entry.Open()
            try { $s.Write($e.Data, 0, $e.Data.Length) } finally { $s.Dispose() }
        }
    }
} finally {
    $zip.Dispose()
    $fs.Dispose()
}
Move-Item -Force $tmp $zipPath

Write-Host ''
Write-Host "Plugin_SU.zip updated: $zipPath"
$check = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try { $check.Entries | ForEach-Object { Write-Host ('  {0,-45} {1,10:N0}' -f $_.FullName, $_.Length) } } finally { $check.Dispose() }
