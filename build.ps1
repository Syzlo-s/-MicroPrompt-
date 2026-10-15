# 轻提词 V4.0 一键构建脚本
# 说明：本机 GNU/MinGW 工具链（dlltool/windres）无法处理含中文的路径，
#       因此把编译输出目录指向英文路径，绕开该缺陷。
$targetDir = 'D:\mp4target'   # 可换成任意英文路径
$root = $PSScriptRoot

Write-Host "[1/2] 编译 Rust 后端 (输出到 $targetDir) ..." -ForegroundColor Cyan
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

Write-Host "[2/2] 复制产物到 release\ ..." -ForegroundColor Cyan
$destDir = Join-Path $root 'release'
New-Item -ItemType Directory -Path $destDir -Force | Out-Null
Copy-Item (Join-Path $targetDir 'release\microprompt-v4.exe') `
    (Join-Path $destDir '轻提词.exe') -Force
# WebView2Loader.dll 是 Tauri 运行时必需的非系统 DLL，必须与 exe 随行
Copy-Item (Join-Path $targetDir 'release\WebView2Loader.dll') `
    (Join-Path $destDir 'WebView2Loader.dll') -Force

Write-Host "完成: $destDir\轻提词.exe (+ WebView2Loader.dll)" -ForegroundColor Green
