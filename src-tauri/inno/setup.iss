; 轻提词 Inno Setup 安装脚本
#define MyAppName "轻提词"
#define MyAppVersion "4.0.2"
#define MyAppPublisher "MicroPrompt"
#define MyAppExeName "轻提词.exe"
#define SrcRoot "D:\Desktop\桌面速记\轻提词V4.0\src-tauri"

[Setup]
AppId={{8D7B2C9A-1F3E-4A6B-9C2D-5E6F7A8B9C0D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
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
OutputBaseFilename=轻提词安装包_v4.0.2
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

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "运行 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
procedure InitializeWizard();
begin
  { 使用 Inno 默认的现代浅色主题；
    不自定义背景色，避免复选框等系统控件渲染不完整 }
end;
