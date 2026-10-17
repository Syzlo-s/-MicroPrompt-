# 轻提词 V4.0 一键构建脚本
# 说明：本机 GNU/MinGW 工具链（dlltool/windres）无法处理含中文的路径，
#       因此把编译输出目录指向英文路径，绕开该缺陷。
$targetDir = 'D:\mp4target'   # 可换成任意英文路径
$root = $PSScriptRoot

Write-Host "[1/3] 编译 Rust 后端 (输出到 $targetDir) ..." -ForegroundColor Cyan
$env:CARGO_TARGET_DIR = $targetDir
Push-Location (Join-Path $root 'src-tauri')
try {
    # --features tauri/custom-protocol：内嵌 dist/ 而非 localhost devUrl（生产构建）
    cargo build --release --features tauri/custom-protocol
    if ($LASTEXITCODE -ne 0) {
        Write-Error "cargo build 失败 (exit $LASTEXITCODE)"
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}

Write-Host "[2/3] 复制产物到 release\ ..." -ForegroundColor Cyan
$destDir = Join-Path $root 'release'
New-Item -ItemType Directory -Path $destDir -Force | Out-Null
Copy-Item (Join-Path $targetDir 'release\microprompt-v4.exe') `
    (Join-Path $destDir '轻提词.exe') -Force
# WebView2Loader.dll 是 Tauri 运行时必需的非系统 DLL，必须与 exe 随行
Copy-Item (Join-Path $targetDir 'release\WebView2Loader.dll') `
    (Join-Path $destDir 'WebView2Loader.dll') -Force

Write-Host "[3/3] 可选：数字签名（没配证书会自动跳过，不影响构建） ..." -ForegroundColor Cyan
$signer = Join-Path $root 'scripts\sign.ps1'
if (Test-Path -LiteralPath $signer) {
    # 放到子进程里跑：sign.ps1 里的 exit 不会把本脚本一起结束掉
    & powershell -NoProfile -ExecutionPolicy Bypass -File $signer
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "签名脚本返回 $LASTEXITCODE；产物仍在，只是这次没有签名。"
    }
} else {
    Write-Host "      （没有 scripts\sign.ps1，跳过）" -ForegroundColor DarkGray
}

Write-Host "完成: $destDir\轻提词.exe (+ WebView2Loader.dll)" -ForegroundColor Green
Write-Host "提醒: 安装包由 Inno 单独出（ISCC.exe src-tauri\inno\setup.iss），出完记得跑 node scripts\verify-installer.mjs" -ForegroundColor DarkGray
