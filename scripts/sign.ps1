#Requires -Version 5.1
<#
    轻提词 · 代码签名

    为什么需要它：
        SmartScreen 的判据只有两条 ——「文件有没有受信任的数字签名」和「这个签名有没有信誉」。
        轻提词现在的安装包是 NotSigned，所以只要用户是「下载」得到的（文件带
        Mark-of-the-Web），双击就一定弹「Windows 已保护你的电脑」。
        临时的绕法（清下载标记 / 用 .bat 拉起）能让用户装上，但每个用户都会被吓一次，
        而且浏览器下载、网盘转存、微信传输都会重新打上标记 —— 绕不完，只能签。

    证书怎么选（2026-10 核对过 Microsoft Learn「代码签名选项」，别按老文章来）：
        · **微软商店（MSIX）分发：微软免费重签名，商店安装的用户永远看不到 SmartScreen。**
          个人开发者目前唯一「免费且彻底」的路 —— 本项目已注册开发者账号，优先走这条。
        · EV 代码签名证书：**2024 年起已不再即时绕过 SmartScreen**，与 OV 一样要积累信誉。
          为「免弹窗」多花的两百美元买不到效果了（除非企业采购/信任场景需要 EV）。
        · OV 代码签名证书（$150~300/年）：签完仍会弹一段时间，要等微软积累信誉
          （几天~几周，看下载量）；但至少不再显示「未知发布者」。
        · Azure 工件签名（原 Trusted Signing，≈$9.99/月）：**个人名额仅限美国/加拿大**，
          国内个人开发者用不了（组织可用范围也仅美/加/欧盟/英国）。
        · 开源项目可以申请 SignPath Foundation 的免费代码签名。
        · 注意：2023 年 6 月之后，CA 签发的代码签名私钥必须存放在符合 FIPS 140-2 的
          硬件里（U 盾 / 云签名），不能只拿一个 .pfx 文件。

    signtool.exe 从哪来：
        Windows SDK（“Windows SDK Signing Tools for Desktop Apps”）自带，
        装完在 C:\Program Files (x86)\Windows Kits\10\bin\<版本>\x64\signtool.exe。
        本脚本会自动去这些位置找。

    用法：
        # 没配证书：只打印指引，退出码 0（不会让构建失败）
        powershell -ExecutionPolicy Bypass -File scripts\sign.ps1

        # 用 .pfx（老式做法，CA 现在基本不给纯 pfx 了）
        ... -File scripts\sign.ps1 -Pfx D:\cert\mp.pfx -PfxPassword '密码'

        # 用证书存储里的证书（硬件令牌 / 云签名的常见形态）
        ... -File scripts\sign.ps1 -Subject 'MicroPrompt'
        ... -File scripts\sign.ps1 -Thumbprint 0123456789ABCDEF...

        # 只签指定文件 / 换时间戳服务器
        ... -File scripts\sign.ps1 -Files release\轻提词.exe -TimestampUrl http://timestamp.sectigo.com

    退出码：0 = 已签名或（未配证书时）正常跳过；1 = 配了证书但签名/校验失败。
#>
[CmdletBinding()]
param(
    # 要签的文件；不给就签默认产物（release\轻提词.exe 与 release\installer\轻提词安装包_v<版本>.exe）
    [string[]]$Files,

    # 证书文件（.pfx）
    [string]$Pfx,
    [string]$PfxPassword,

    # 从「当前用户 / 本地计算机」的证书存储里按主题或指纹挑证书
    [string]$Subject,
    [string]$Thumbprint,

    [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Write-Ok([string]$t)   { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Write-Skip([string]$t) { Write-Host "  [跳过] $t" -ForegroundColor Yellow }
function Write-Bad([string]$t)  { Write-Host "  [失败] $t" -ForegroundColor Red }

Write-Host '轻提词 · 代码签名' -ForegroundColor Cyan
Write-Host ('=' * 60)

# --------------------------------------------------------------- 找 signtool
function Find-SignTool {
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $patterns = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin\*\x64\signtool.exe'),
        (Join-Path $env:ProgramFiles 'Windows Kits\10\bin\*\x64\signtool.exe')
    ) | Where-Object { $_ -and $_ -notmatch '^\\' }

    $found = @()
    foreach ($p in $patterns) {
        $found += Get-ChildItem -Path $p -ErrorAction SilentlyContinue
    }
    if ($found.Count -gt 0) {
        # 取版本号最高的那个
        return ($found | Sort-Object -Property @{ Expression = { $_.Directory.Parent.Name } } -Descending |
                Select-Object -First 1).FullName
    }
    return $null
}

# ------------------------------------------------------------- 决定要签哪些
function Get-DefaultTargets {
    $version = '0.0.0'
    $conf = Join-Path $projectRoot 'src-tauri\tauri.conf.json'
    if (Test-Path -LiteralPath $conf) {
        $m = [regex]::Match((Get-Content -LiteralPath $conf -Raw), '"version"\s*:\s*"([^"]+)"')
        if ($m.Success) { $version = $m.Groups[1].Value }
    }
    @(
        (Join-Path $projectRoot 'release\轻提词.exe'),
        (Join-Path $projectRoot "release\installer\轻提词安装包_v$version.exe")
    ) | Where-Object { Test-Path -LiteralPath $_ }
}

$targets = if ($Files) {
    $Files | ForEach-Object { if ([IO.Path]::IsPathRooted($_)) { $_ } else { Join-Path $projectRoot $_ } }
} else {
    Get-DefaultTargets
}

if (-not $targets -or @($targets).Count -eq 0) {
    Write-Bad '没有找到要签名的文件（先跑 build.ps1 / ISCC 出包）。'
    exit 1
}

Write-Host '待签文件：'
foreach ($t in $targets) {
    $i = Get-Item -LiteralPath $t
    Write-Host ("  · {0}  ({1:N2} MB)" -f $i.Name, ($i.Length / 1MB))
}

# --------------------------------------------------------------- 有没有证书
# 参数优先，其次读环境变量，方便在 build.ps1 里一次配好：
#   $env:MP_SIGN_SUBJECT / $env:MP_SIGN_PFX / $env:MP_SIGN_PFX_PASSWORD
if (-not $Pfx -and $env:MP_SIGN_PFX) { $Pfx = $env:MP_SIGN_PFX }
if (-not $PfxPassword -and $env:MP_SIGN_PFX_PASSWORD) { $PfxPassword = $env:MP_SIGN_PFX_PASSWORD }
if (-not $Subject -and $env:MP_SIGN_SUBJECT) { $Subject = $env:MP_SIGN_SUBJECT }

$certMode = $null
if ($Pfx) { $certMode = 'pfx' }
elseif ($Thumbprint) { $certMode = 'thumbprint' }
elseif ($Subject) { $certMode = 'subject' }

if (-not $certMode) {
    Write-Skip '没有提供证书，本次不签名。'
    Write-Host ''
    Write-Host '  要真正消除「Windows 已保护你的电脑」，按下面两步走：' -ForegroundColor Yellow
    Write-Host '   1) 若只是想让用户别再看到弹窗：优先考虑**上架微软商店（MSIX）**——微软免费重签名，商店用户零弹窗；' -ForegroundColor Yellow
    Write-Host '      直接下载渠道才需要买 OV 证书（$150~300/年，且注意 EV 2024 起也不再即时绕过）。' -ForegroundColor Yellow
    Write-Host '   2) 要买证书/用证书签名：装 Windows SDK 的 Signing Tools，然后：' -ForegroundColor Yellow
    Write-Host '        .\scripts\sign.ps1 -Subject "你的证书主题"' -ForegroundColor Yellow
    Write-Host '      或者在 build.ps1 前面设 $env:MP_SIGN_SUBJECT = "你的证书主题"。' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  在拿到证书之前：分发时把安装包和「双击安装_轻提词.bat」「install_microprompt.ps1」放一起，' -ForegroundColor DarkGray
    Write-Host '  并让用户先把 zip「解除锁定」再解压（见 _deploy\安装与分发_轻提词.md）。' -ForegroundColor DarkGray
    exit 0
}

$signtool = Find-SignTool
if (-not $signtool) {
    Write-Bad '找不到 signtool.exe。装 Windows SDK 的 “Signing Tools for Desktop Apps” 后重试；'
    Write-Host '         或把 signtool.exe 所在目录加进 PATH。' -ForegroundColor Yellow
    exit 1
}
Write-Ok "signtool: $signtool"

# 证书参数
$certArgs = @()
switch ($certMode) {
    'pfx' {
        if (-not (Test-Path -LiteralPath $Pfx)) { Write-Bad "证书文件不存在：$Pfx"; exit 1 }
        $certArgs = @('/f', $Pfx)
        if ($PfxPassword) { $certArgs += @('/p', $PfxPassword) }
    }
    'thumbprint' { $certArgs = @('/sha1', ($Thumbprint -replace '\s', '')) }
    'subject'    { $certArgs = @('/n', $Subject) }
}

# ------------------------------------------------------------------- 签名
$failed = @()
foreach ($t in $targets) {
    Write-Host ''
    Write-Host "签名：$(Split-Path $t -Leaf)"
    $stampArgs = @('/fd', 'SHA256', '/tr', $TimestampUrl, '/td', 'SHA256')
    $all = @('sign') + $stampArgs + $certArgs + @($t)
    & $signtool @all
    if ($LASTEXITCODE -ne 0) {
        Write-Bad "signtool 返回 $LASTEXITCODE"
        $failed += $t
        continue
    }
    $sig = Get-AuthenticodeSignature -LiteralPath $t
    if ($sig.Status -eq 'Valid') {
        Write-Ok "签名有效：$($sig.SignerCertificate.Subject)"
    } else {
        Write-Bad "签名状态 = $($sig.Status)（$($sig.StatusMessage)）"
        $failed += $t
    }
}

Write-Host ''
if ($failed.Count -gt 0) {
    Write-Bad "以下文件签名未通过：$($failed -join ', ')"
    exit 1
}
Write-Ok '全部签名完成。'
Write-Host '  提醒：OV 证书签完头几天 SmartScreen 仍可能拦（信誉还在积累）；EV 立即可用。' -ForegroundColor DarkGray
Write-Host '        签完请重新算 MD5/SHA256 并更新发布说明（签名会改变文件字节）。' -ForegroundColor DarkGray
exit 0
