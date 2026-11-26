# 내가 쓰는 대로 — 런처 (Windows). 「AsIWrite Launcher.bat」이 부릅니다.
#
# 필요한 것은 전부 이 폴더의 .runtime 안에만 설치해요 — 컴퓨터의 다른 곳은 건드리지 않아요.
#   · Node.js (버전 고정, 공식 SHA-256 확인)        .runtime\node-v…
#   · 게임 묶음 (GitHub Release, SHA-256 확인)       .runtime\game-…   ← 없으면 소스에서 직접 빌드
#   · 브라우저 프로필 (AI 모델·저장 파일·설정)        .runtime\browser   (엣지/크롬을 전용 프로필로 엶)
#   · (엣지·크롬이 없을 때만) 휴대용 크롬              .runtime\chrome-…
# 지우려면 launcher\Uninstall.bat 을 실행하거나 .runtime 폴더를 지우면 돼요.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$RT = Join-Path $Root '.runtime'
$LockText = Get-Content (Join-Path $Root 'launcher\runtime.lock') -Encoding UTF8
function Lock([string]$k) { $l = $LockText | Where-Object { $_ -match "^$([regex]::Escape($k))=" } | Select-Object -First 1; if ($l) { return ($l -split '=', 2)[1].Trim() } else { return '' } }
function Fail([string]$m) { Write-Host ''; Write-Host "[!] $m" -ForegroundColor Red; Read-Host '엔터를 누르면 닫혀요' | Out-Null; exit 1 }
function Ask([string]$q) { $a = Read-Host $q; return ($a -eq '' -or $a -match '^[yYㅛ]') }

# ── 이 컴퓨터 ──
$arch = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
$Plat = if ($arch -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
$NodeV = Lock 'NODE_VERSION'
$NodeDir = Join-Path $RT "node-v$NodeV-$Plat"
$Node = Join-Path $NodeDir 'node.exe'
$GameV = Lock 'GAME_VERSION'
$GameUrl = if ($env:ASIWRITE_GAME_URL) { $env:ASIWRITE_GAME_URL } else { Lock 'GAME_URL' }
$GameSha = Lock 'GAME_SHA256'
$FromSrc = -not ($GameV -and $GameUrl -and $GameSha)
$GameDir = if ($FromSrc) { Join-Path $RT 'game-src' } else { Join-Path $RT "game-$GameV" }

function SrcChanged {
  $stamp = Join-Path $GameDir '.built'
  if (-not (Test-Path $stamp)) { return $true }
  $t = (Get-Item $stamp).LastWriteTime
  $paths = 'src', 'public', 'server', 'index.html', 'package.json', 'package-lock.json' | Where-Object { Test-Path $_ }
  return [bool](Get-ChildItem $paths -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $t } | Select-Object -First 1)
}

# ── 브라우저 (전용 프로필을 폴더 안에 두려면 엣지·크롬 계열이 필요) ──
function FindBrowser {
  $c = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    (Join-Path $RT "chrome-$(Lock 'CHROME_VERSION')-win64\chrome-win64\chrome.exe")
  )
  foreach ($p in $c) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

# ── 무엇을 설치해야 하나 ──
$Need = @()
if (-not (Test-Path $Node)) { $Need += "Node.js $NodeV (약 30MB)" }
if ($FromSrc) { if (SrcChanged) { $Need += '게임을 소스에서 빌드 (패키지 약 600MB, 몇 분)' } }
elseif (-not (Test-Path (Join-Path $GameDir 'server.mjs'))) { $Need += "게임 묶음 $GameV (약 10MB)" }
$Browser = FindBrowser
$WantChrome = (-not $Browser) -and ($Plat -eq 'win-x64')

if ($Need.Count -gt 0 -or $WantChrome) {
  Write-Host '────────────────────────────────────────────'
  Write-Host ' 내가 쓰는 대로 — 처음 실행 준비'
  Write-Host '────────────────────────────────────────────'
  Write-Host '다음을 이 폴더 안(.runtime)에만 설치해요. 컴퓨터의 다른 곳은 건드리지 않아요.'
  foreach ($n in $Need) { Write-Host "  · $n" }
  if ($WantChrome) { Write-Host "  · (선택) 휴대용 크롬 $(Lock 'CHROME_VERSION') (약 200MB) — 엣지·크롬이 없어서 필요해요" }
  Write-Host '받은 파일은 launcher\runtime.lock 에 적힌 SHA-256 값과 맞는지 확인한 뒤에만 설치해요.'
  Write-Host ''
  if (-not (Ask '설치할까요? [Y/n]')) { Write-Host '설치하지 않았어요. 언제든 다시 실행하면 돼요.'; exit 0 }
  New-Item -ItemType Directory -Force -Path $RT | Out-Null
}

function Download([string]$url, [string]$file, [string]$sha) {
  Write-Host "  내려받는 중: $(Split-Path -Leaf $file)"
  $part = "$file.part"
  try {
    if ($url -like 'file://*') { Copy-Item ([Uri]$url).LocalPath $part } else { Invoke-WebRequest -Uri $url -OutFile $part -UseBasicParsing }
  } catch { Remove-Item $part -ErrorAction SilentlyContinue; return $false }
  $got = (Get-FileHash $part -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $sha.ToLower()) { Remove-Item $part; Write-Host '  [!] 파일이 예상과 달라요 (SHA-256 불일치). 설치하지 않았어요.' -ForegroundColor Yellow; return $false }
  Move-Item -Force $part $file
  return $true
}

# ── Node.js ──
if (-not (Test-Path $Node)) {
  Write-Host ''; Write-Host "▶ Node.js $NodeV"
  $z = Join-Path $RT "node-v$NodeV-$Plat.zip"
  if (-not (Download "https://nodejs.org/dist/v$NodeV/node-v$NodeV-$Plat.zip" $z (Lock "NODE_SHA256_$Plat"))) { Fail 'Node.js를 받지 못했어요. 인터넷 연결을 확인해 주세요.' }
  Expand-Archive -Force $z -DestinationPath $RT
  Remove-Item $z
}
$env:PATH = "$NodeDir;$env:PATH"
$env:npm_config_cache = Join-Path $RT 'npm-cache'     # npm 캐시도 폴더 안에
$env:npm_config_update_notifier = 'false'

function BuildFromSource {
  Write-Host ''; Write-Host '▶ 소스에서 게임 빌드 (처음 한 번, 몇 분 걸려요)'
  & (Join-Path $NodeDir 'npm.cmd') ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Fail '패키지 설치에 실패했어요. 인터넷 연결을 확인해 주세요.' }
  & $Node 'tools/release.mjs' '--out' $script:GameDir
  if ($LASTEXITCODE -ne 0) { Fail '빌드에 실패했어요.' }
}

# ── 게임 ──
if ($FromSrc) { if (SrcChanged) { BuildFromSource } }
elseif (-not (Test-Path (Join-Path $GameDir 'server.mjs'))) {
  Write-Host ''; Write-Host "▶ 게임 묶음 $GameV"
  $z = Join-Path $RT "game-$GameV.zip"
  if (Download $GameUrl $z $GameSha) {
    Expand-Archive -Force $z -DestinationPath $GameDir
    Remove-Item $z
  } else {
    Write-Host '  게임 묶음을 받지 못해 소스에서 직접 빌드할게요.'
    $script:GameDir = Join-Path $RT 'game-src'
    if (SrcChanged) { BuildFromSource }
  }
}

# ── 휴대용 크롬 (선택) ──
if ($WantChrome) {
  Write-Host ''
  if (Ask '휴대용 크롬을 받을까요? 받지 않으면 기본 브라우저로 열고, 그때는 AI 모델·저장 파일이 브라우저 쪽에 저장돼요. [Y/n]') {
    $cv = Lock 'CHROME_VERSION'
    $cz = Join-Path $RT "chrome-$cv-win64.zip"
    $curl = if ($env:ASIWRITE_CHROME_URL) { $env:ASIWRITE_CHROME_URL } else { "https://storage.googleapis.com/chrome-for-testing-public/$cv/win64/chrome-win64.zip" }
    if (Download $curl $cz (Lock 'CHROME_SHA256_win64')) {
      Expand-Archive -Force $cz -DestinationPath (Join-Path $RT "chrome-$cv-win64")
      Remove-Item $cz
      $Browser = FindBrowser
    }
  }
}

# ── 실행 ──
Write-Host ''; Write-Host '내가 쓰는 대로 를 시작합니다.'
$portFile = Join-Path $RT 'port'
Remove-Item $portFile -ErrorAction SilentlyContinue
$srv = Start-Process -FilePath $Node -ArgumentList @("`"$(Join-Path $GameDir 'server.mjs')`"", '--port', '5173', '--port-file', "`"$portFile`"") -NoNewWindow -PassThru
for ($i = 0; $i -lt 100 -and -not (Test-Path $portFile); $i++) { if ($srv.HasExited) { Fail '게임 서버가 시작되지 않았어요.' }; Start-Sleep -Milliseconds 200 }
if (-not (Test-Path $portFile)) { Fail '게임 서버가 응답하지 않아요.' }
$Url = "http://localhost:$((Get-Content $portFile).Trim())"
Write-Host "  $Url"
try {
  if ($env:ASIWRITE_NO_BROWSER) { Write-Host '  (브라우저를 열지 않음) 끝내려면 이 창을 닫으세요.'; $srv.WaitForExit() }
  elseif ($Browser) {
    Write-Host '  게임 창을 닫거나 타이틀의 「종료」를 누르면 끝나요.'
    $t0 = Get-Date
    $b = Start-Process -FilePath $Browser -ArgumentList @("--user-data-dir=`"$(Join-Path $RT 'browser')`"", "--app=$Url", '--no-first-run', '--no-default-browser-check', '--window-size=1440,900') -PassThru
    $b.WaitForExit()
    # 이미 열린 게임 창에 넘겨주고 바로 끝난 경우엔 서버를 계속 둬요
    if (((Get-Date) - $t0).TotalSeconds -lt 5) { Write-Host '  (게임 창이 따로 열려 있어요. 끝내려면 타이틀의 「종료」를 누르거나 이 창을 닫으세요.)'; $srv.WaitForExit() }
  } else {
    Write-Host '  기본 브라우저로 열어요. 끝내려면 타이틀의 「종료」를 누르거나 이 창을 닫으세요.'
    Start-Process $Url
    $srv.WaitForExit()
  }
} finally {
  if (-not $srv.HasExited) { Stop-Process -Id $srv.Id -ErrorAction SilentlyContinue }
}
