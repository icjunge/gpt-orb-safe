# CI fixture only; excluded from the installed application. Standard queries are
# read-only. The one explicit experiment uses fixed blur parameters on a HWND
# owned by the fixture process, never a caller-selected compositor policy.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$null = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrbBackdropProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] private struct ACCENT_POLICY { public int state, flags; public uint color; public int animation; }
  [StructLayout(LayoutKind.Sequential)] private struct COMPOSITION_DATA { public int attribute; public IntPtr data; public UIntPtr size; }
  [DllImport("dwmapi.dll")] public static extern int DwmIsCompositionEnabled([MarshalAs(UnmanagedType.Bool)] out bool enabled);
  [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")] public static extern int DwmGetInt(IntPtr window, int attribute, out int value, int size);
  [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")] public static extern int DwmGetRect(IntPtr window, int attribute, out RECT value, int size);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetWindowRect(IntPtr window, out RECT rectangle);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetClientRect(IntPtr window, out RECT rectangle);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool ClientToScreen(IntPtr window, ref POINT point);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr window, IntPtr region);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr region, out RECT rectangle);
  [DllImport("gdi32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool PtInRegion(IntPtr region, int x, int y);
  [DllImport("gdi32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool DeleteObject(IntPtr value);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] private static extern int GetWindowLong32(IntPtr window, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowCompositionAttribute")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetWindowCompositionAttribute(IntPtr window, ref COMPOSITION_DATA data);
  public static uint ReadStyle(IntPtr window, int index) {
    return IntPtr.Size == 8 ? unchecked((uint)GetWindowLongPtr64(window, index).ToInt64()) : unchecked((uint)GetWindowLong32(window,index));
  }
  public static bool ExperimentAccentBlur(IntPtr window) {
    ACCENT_POLICY accent = new ACCENT_POLICY { state=3, flags=2, color=0, animation=0 };
    IntPtr memory=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ACCENT_POLICY)));
    try {
      Marshal.StructureToPtr(accent,memory,false);
      COMPOSITION_DATA data=new COMPOSITION_DATA { attribute=19, data=memory, size=new UIntPtr((uint)Marshal.SizeOf(typeof(ACCENT_POLICY))) };
      return SetWindowCompositionAttribute(window,ref data);
    } finally { Marshal.FreeHGlobal(memory); }
  }
}
'@

function Write-Record($value) {
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}
function Rect-Record($rectangle) {
  return @{x=$rectangle.left;y=$rectangle.top;width=$rectangle.right-$rectangle.left;height=$rectangle.bottom-$rectangle.top}
}

$ownerPid = [uint32]0
if (-not [uint32]::TryParse($env:GPT_ORB_BACKDROP_PID, [ref]$ownerPid) -or $ownerPid -eq 0) {
  throw 'Missing fixture owner process ID.'
}
$compositionEnabled=$false
$compositionResult=[OrbBackdropProbe]::DwmIsCompositionEnabled([ref]$compositionEnabled)
$transparency=$null
$caption=$null
try { $transparency=(Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name EnableTransparency).EnableTransparency } catch {}
try { $caption=(Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name ProductName).ProductName } catch {}
Write-Record @{
  kind='system';dwm=@{hresult=$compositionResult;enabled=$compositionEnabled};osCaption=$caption
  remoteSession=([OrbBackdropProbe]::GetSystemMetrics(0x1000) -ne 0)
  remoteControl=([OrbBackdropProbe]::GetSystemMetrics(0x2001) -ne 0)
  enableTransparency=$transparency;fixtureOwnerPid=$ownerPid
}

while ($null -ne ($line=[Console]::In.ReadLine())) {
  $label=$null
  try {
    if ($line.Length -gt 4096) { throw 'Query too long.' }
    $query=$line | ConvertFrom-Json
    if ($null -eq $query -or $query -is [array] -or $query.label -isnot [string] -or $query.label.Length -gt 80) { throw 'Invalid query label.' }
    $label=$query.label
    if ($query.handleHex -isnot [string] -or $query.handleHex -notmatch '\A(?:0x)?[0-9a-fA-F]{1,16}\z') { throw 'Invalid fixture window handle.' }
    $allowed=@('label','handleHex','experimentAccentBlur')
    foreach ($property in $query.PSObject.Properties.Name) { if ($allowed -notcontains $property) { throw 'Unknown query property.' } }
    if ($null -ne $query.experimentAccentBlur -and $query.experimentAccentBlur -isnot [bool]) { throw 'Invalid experiment flag.' }
    $value=[Convert]::ToUInt64(($query.handleHex -replace '^0x',''),16)
    if ($value -gt [long]::MaxValue) { throw 'Invalid fixture handle range.' }
    $window=[IntPtr]::new([long]$value)
    if (-not [OrbBackdropProbe]::IsWindow($window)) { throw 'Fixture window no longer exists.' }
    $windowPid=[uint32]0
    $null=[OrbBackdropProbe]::GetWindowThreadProcessId($window,[ref]$windowPid)
    if ($windowPid -ne $ownerPid) { throw 'Window is not owned by the fixture process.' }

    $experiment=$null
    if ($query.experimentAccentBlur -eq $true) {
      try { $experiment=@{requested=$true;state=3;flags=2;result=[OrbBackdropProbe]::ExperimentAccentBlur($window)} }
      catch { $experiment=@{requested=$true;state=3;flags=2;result=$false;error=$_.Exception.Message} }
    }
    $windowRect=New-Object OrbBackdropProbe+RECT
    $clientRect=New-Object OrbBackdropProbe+RECT
    $clientOrigin=New-Object OrbBackdropProbe+POINT
    $frameRect=New-Object OrbBackdropProbe+RECT
    $windowRectOk=[OrbBackdropProbe]::GetWindowRect($window,[ref]$windowRect)
    $clientRectOk=[OrbBackdropProbe]::GetClientRect($window,[ref]$clientRect)
    $clientOriginOk=[OrbBackdropProbe]::ClientToScreen($window,[ref]$clientOrigin)
    $frameResult=[OrbBackdropProbe]::DwmGetRect($window,9,[ref]$frameRect,16)
    $backdrop=0;$backdropResult=[OrbBackdropProbe]::DwmGetInt($window,38,[ref]$backdrop,4)
    $hostBrush=0;$hostBrushResult=[OrbBackdropProbe]::DwmGetInt($window,17,[ref]$hostBrush,4)
    $cloaked=0;$cloakedResult=[OrbBackdropProbe]::DwmGetInt($window,14,[ref]$cloaked,4)
    $region=[OrbBackdropProbe]::CreateRectRgn(0,0,0,0)
    if ($region -eq [IntPtr]::Zero) { throw 'Unable to allocate diagnostic region.' }
    try {
      $regionResult=[OrbBackdropProbe]::GetWindowRgn($window,$region)
      $regionBox=New-Object OrbBackdropProbe+RECT
      $regionBoxResult=[OrbBackdropProbe]::GetRgnBox($region,[ref]$regionBox)
      $width=$windowRect.right-$windowRect.left;$height=$windowRect.bottom-$windowRect.top
      $contains=@{
        topLeft=[OrbBackdropProbe]::PtInRegion($region,4,4)
        topRight=[OrbBackdropProbe]::PtInRegion($region,$width-5,4)
        bottomLeft=[OrbBackdropProbe]::PtInRegion($region,4,$height-5)
        bottomRight=[OrbBackdropProbe]::PtInRegion($region,$width-5,$height-5)
        center=[OrbBackdropProbe]::PtInRegion($region,[int]($width/2),[int]($height/2))
      }
    } finally { $null=[OrbBackdropProbe]::DeleteObject($region) }
    $style=[OrbBackdropProbe]::ReadStyle($window,-16)
    $extendedStyle=[OrbBackdropProbe]::ReadStyle($window,-20)
    Write-Record @{
      kind='window';label=$label;ownerPid=$windowPid;handleHex=$query.handleHex
      windowRect=@{ok=$windowRectOk;bounds=(Rect-Record $windowRect)}
      clientRect=@{ok=$clientRectOk;bounds=(Rect-Record $clientRect)}
      clientOrigin=@{ok=$clientOriginOk;x=$clientOrigin.x;y=$clientOrigin.y}
      extendedFrameBounds=@{hresult=$frameResult;bounds=(Rect-Record $frameRect)}
      region=@{result=$regionResult;boxResult=$regionBoxResult;bounds=(Rect-Record $regionBox);contains=$contains}
      systemBackdrop=@{hresult=$backdropResult;value=$backdrop}
      hostBackdropBrush=@{hresult=$hostBrushResult;value=$hostBrush}
      cloaked=@{hresult=$cloakedResult;value=$cloaked}
      styles=@{style=('0x{0:x8}' -f $style);extendedStyle=('0x{0:x8}' -f $extendedStyle)
        layered=(($extendedStyle -band 0x00080000) -ne 0);noRedirectionBitmap=(($extendedStyle -band 0x00200000) -ne 0)
        noActivate=(($extendedStyle -band 0x08000000) -ne 0);topmost=(($extendedStyle -band 8) -ne 0)}
      experimentAccentBlur=$experiment
    }
  } catch { Write-Record @{kind='window';label=$label;error=$_.Exception.Message} }
}
