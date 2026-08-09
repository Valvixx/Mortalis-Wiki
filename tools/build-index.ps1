$projectRoot = Split-Path -Parent $PSScriptRoot
$contentRoot = Join-Path $projectRoot "content"

$notes = Get-ChildItem -LiteralPath $contentRoot -Recurse -File -Filter "*.md" |
  Sort-Object FullName |
  ForEach-Object {
    $relative = $_.FullName.Substring($contentRoot.Length + 1).Replace("\\", "/")
    $parts = $relative.Split("/")
    [ordered]@{
      path = "content/$relative"
      relative = $relative
      title = [IO.Path]::GetFileNameWithoutExtension($_.Name)
      folder = if ($parts.Length -gt 1) { $parts[0..($parts.Length - 2)] -join "/" } else { "" }
    }
  }

$assets = Get-ChildItem -LiteralPath $contentRoot -Recurse -File |
  Where-Object { $_.Extension -ine ".md" -and $_.Name -ne "index.json" } |
  Sort-Object FullName |
  ForEach-Object { "content/" + $_.FullName.Substring($contentRoot.Length + 1).Replace("\\", "/") }

[ordered]@{ notes = @($notes); assets = @($assets) } |
  ConvertTo-Json -Depth 4 |
  Set-Content -LiteralPath (Join-Path $contentRoot "index.json") -Encoding utf8

Write-Host "Индекс обновлён: $($notes.Count) заметок, $($assets.Count) вложений."
