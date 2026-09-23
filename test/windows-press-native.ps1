# CI only. Drive real Windows mouse input against the fixture's own HWND.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$null = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrbPressInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION data; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window,uint flags);
  [DllImport("user32.dll")] private static extern uint SendInput(uint count,INPUT[] inputs,int size);
  public static uint Button(bool down) {
    INPUT input=new INPUT { type=0, data=new INPUTUNION { mi=new MOUSEINPUT { dwFlags=down?2u:4u } } };
    return SendInput(1,new INPUT[] { input },Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
$null = [OrbPressInput]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
function Write-Record($value) {
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
$ownerPid=[uint32]0
if (-not [uint32]::TryParse($env:GPT_ORB_PRESS_PID,[ref]$ownerPid) -or $ownerPid -eq 0) { throw 'Missing fixture owner PID.' }
$initial=New-Object OrbPressInput+POINT
if (-not [OrbPressInput]::GetCursorPos([ref]$initial)) { throw 'Native cursor unavailable.' }
Write-Record @{kind='ready';cursor=@{x=$initial.x;y=$initial.y}}
try {
  while ($null -ne ($line=[Console]::In.ReadLine())) {
    $label=$null
    try {
      if ($line.Length -gt 2048) { throw 'Input query too long.' }
      $query=$line | ConvertFrom-Json
      if ($null -eq $query -or $query -is [array] -or $query.label -isnot [string] -or $query.label.Length -gt 80) { throw 'Invalid query.' }
      $label=$query.label
      foreach ($key in $query.PSObject.Properties.Name) { if (@('label','handleHex','operation','x','y') -notcontains $key) { throw 'Unknown input property.' } }
      if ($query.handleHex -isnot [string] -or $query.handleHex -notmatch '\A[0-9a-fA-F]{1,16}\z') { throw 'Invalid fixture HWND.' }
      $window=[IntPtr]::new([Convert]::ToInt64($query.handleHex,16))
      $windowPid=[uint32]0
      $null=[OrbPressInput]::GetWindowThreadProcessId($window,[ref]$windowPid)
      if ($windowPid -ne $ownerPid) { throw 'Input target is not owned by fixture.' }
      $sent=$null
      switch ($query.operation) {
        'move' {
          foreach ($coordinate in @($query.x,$query.y)) {
            if ($coordinate -isnot [int] -and $coordinate -isnot [long]) { throw 'Invalid cursor coordinate.' }
            if ([Math]::Abs([long]$coordinate) -gt 32768) { throw 'Cursor coordinate outside fixture range.' }
          }
          if (-not [OrbPressInput]::SetCursorPos([int]$query.x,[int]$query.y)) { throw 'SetCursorPos failed.' }
        }
        'down' {
          $point=New-Object OrbPressInput+POINT
          if (-not [OrbPressInput]::GetCursorPos([ref]$point)) { throw 'Native cursor unavailable.' }
          $hit=[OrbPressInput]::GetAncestor([OrbPressInput]::WindowFromPoint($point),2)
          if ($hit -ne $window) { throw 'The fixture orb is not the native hit target; input was not sent.' }
          $sent=[OrbPressInput]::Button($true)
          if ($sent -ne 1) { throw 'Windows did not accept mouse down.' }
        }
        'up' { $sent=[OrbPressInput]::Button($false); if ($sent -ne 1) { throw 'Windows did not accept mouse up.' } }
        'sample' {}
        default { throw 'Unsupported input operation.' }
      }
      $rectangle=New-Object OrbPressInput+RECT
      $cursor=New-Object OrbPressInput+POINT
      if (-not [OrbPressInput]::GetWindowRect($window,[ref]$rectangle) -or -not [OrbPressInput]::GetCursorPos([ref]$cursor)) { throw 'Native bounds/cursor sample unavailable.' }
      Write-Record @{label=$label;operation=$query.operation;sent=$sent;dpi=[OrbPressInput]::GetDpiForWindow($window)
        bounds=@{x=$rectangle.left;y=$rectangle.top;width=$rectangle.right-$rectangle.left;height=$rectangle.bottom-$rectangle.top}
        cursor=@{x=$cursor.x;y=$cursor.y}}
    } catch { Write-Record @{label=$label;error=$_.Exception.Message} }
  }
} finally {
  $null=[OrbPressInput]::Button($false)
  $null=[OrbPressInput]::SetCursorPos($initial.x,$initial.y)
}
