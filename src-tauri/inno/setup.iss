; 轻提词 Inno Setup 安装脚本
; 4.7.1：软件内在线升级的入口是小按钮（右下角工具栏 / 设置 → 关于），升级时就是把本安装包
;        用 /VERYSILENT /DIR=<当前安装目录> 静默装一遍，所以本脚本的 [Files] 与
;        [Dirs] 保持"覆盖不改 data"的语义就够用。
; 4.6.0：安装位置可选（默认 D:\轻提词），并在安装目录下建好 data 文件夹
;        —— 笔记默认就存在「安装目录\data」，卸载时该文件夹不会被删除
#define MyAppName "轻提词"
#define MyAppVersion "4.7.1"
#define MyAppPublisher "MicroPrompt"
#define MyAppExeName "轻提词.exe"
#define MyAppDataDir "data"
#define SrcRoot "D:\Desktop\桌面速记\轻提词V4.0\src-tauri"

[Setup]
AppId={{8D7B2C9A-1F3E-4A6B-9C2D-5E6F7A8B9C0D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; 默认安装到 D:\轻提词（用户可在安装向导第二页改成任意位置，包括 C 盘）
DefaultDirName=D:\{#MyAppName}
; 永远显示「选择安装位置」页（默认 auto 在覆盖安装时会跳过这一页）
DisableDirPage=no
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=110
WizardImageFile={#SrcRoot}\nsis\sidebarImage.bmp
WizardSmallImageFile={#SrcRoot}\inno\small.png
SetupIconFile={#SrcRoot}\icons\icon.ico
OutputDir=D:\Desktop\桌面速记\轻提词V4.0\release\installer
OutputBaseFilename=轻提词安装包_v4.7.1
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

[Languages]
Name: "chinese"; MessagesFile: "{#SrcRoot}\inno\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："; Flags: checkedonce

[Files]
Source: "D:\mp4target\release\microprompt-v4.exe"; DestDir: "{app}"; DestName: "{#MyAppExeName}"; Flags: ignoreversion
Source: "D:\mp4target\release\WebView2Loader.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcRoot}\resources\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs

[Dirs]
; 笔记目录：跟着安装位置走；卸载时保留（uninsneveruninstall），避免误删用户笔记
Name: "{app}\{#MyAppDataDir}"; Flags: uninsneveruninstall

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "运行 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
procedure InitializeWizard();
begin
  { D 盘不存在时，默认位置换成系统程序目录，
    否则默认路径会是一个不存在的盘；用户仍可自己改。 }
  if not DirExists('D:\') then
    WizardForm.DirEdit.Text := ExpandConstant('{autopf}\{#MyAppName}');

  { 「选择安装位置」页补一句说明：笔记存在哪、卸载会不会删 }
  WizardForm.SelectDirLabel.Caption :=
    '请选择「{#MyAppName}」的安装位置。' + #13#10 +
    '笔记文件默认保存在安装目录下的 {#MyAppDataDir} 文件夹（可在软件内' +
    '「设置 → 存储」里随时更改或搬到别的盘）；卸载软件时该文件夹会保留。';
end;
