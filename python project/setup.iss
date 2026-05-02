[Setup]
AppName=流绘
AppVersion=1.0.0
AppPublisher=LiuHui
DefaultDirName={autopf}\流绘
DefaultGroupName=流绘
OutputDir=F:\openclaw\openclaw\workspace\python project\installer
OutputBaseFilename=流绘-Setup
Compression=lzma2/ultra64
SolidCompression=yes
SetupIconFile=F:\openclaw\openclaw\workspace\python project\frontend\assets\app-icon.ico
UninstallDisplayIcon={app}\流绘.exe
PrivilegesRequired=lowest
WizardStyle=modern

[Files]
Source: "F:\openclaw\openclaw\workspace\python project\dist\流绘\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\流绘"; Filename: "{app}\流绘.exe"
Name: "{autodesktop}\流绘"; Filename: "{app}\流绘.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加选项:"

[Run]
Filename: "{app}\流绘.exe"; Description: "启动流绘"; Flags: nowait postinstall skipifsilent
