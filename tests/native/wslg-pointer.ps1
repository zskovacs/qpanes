# Test-only host pointer input for WSLg move/resize loops. Run as a normal
# PowerShell command through window-chrome.mjs; no execution-policy changes.
# The caller prefixes numeric offsets/deltas/inner dimensions and an exact title.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QpanesPointer {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate int EnumProc(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] public static extern int EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] public static extern int GetWindowTextW(IntPtr hwnd, [Out] char[] buffer, int max);
  [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll", SetLastError=true)] public static extern int GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll", SetLastError=true)] public static extern int SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern int IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static IntPtr FindExact(string expected) {
    IntPtr found = IntPtr.Zero;
    EnumProc visit = (hwnd, parameter) => {
      var buffer = new char[512];
      int count = GetWindowTextW(hwnd, buffer, buffer.Length);
      if (new string(buffer, 0, count) == expected) { found = hwnd; return 0; }
      return 1;
    };
    EnumWindows(visit, IntPtr.Zero);
    GC.KeepAlive(visit);
    return found;
  }
}
'@
$previousDpi = [QpanesPointer]::SetThreadDpiAwarenessContext([IntPtr](-4))
try {
  # Enumerate also minimized WSLg windows; Get-Process picks a different main
  # window when several Linux applications share the RDP host process.
  # The HWND is borrowed; this driver must not close it.
  $window = [QpanesPointer]::FindExact($qpanesTitle)
  if ($window -eq [IntPtr]::Zero) { throw 'Exact Qpanes WSLg host window not found' }
  if ($qpanesMode -eq 'restore') {
    [void][QpanesPointer]::ShowWindow($window,9)
    Start-Sleep -Milliseconds 250
  }
  if ($qpanesMode -eq 'state' -or $qpanesMode -eq 'restore') {
    @{ minimized=([QpanesPointer]::IsIconic($window) -ne 0) } | ConvertTo-Json -Compress
    return
  }
  $rect = New-Object QpanesPointer+RECT
  $client = New-Object QpanesPointer+RECT
  if (![QpanesPointer]::GetWindowRect($window,[ref]$rect)) { throw 'GetWindowRect failed' }
  if (![QpanesPointer]::GetClientRect($window,[ref]$client)) { throw 'GetClientRect failed' }
  # WSLg's host client can include compositor shadow margins around GTK content.
  $startX = $rect.Left + ($client.Right - $qpanesWidth)/2 + $qpanesX
  $startY = $rect.Top + ($client.Bottom - $qpanesHeight)/2 + $qpanesY
  if (![QpanesPointer]::SetCursorPos($startX,$startY)) { throw 'SetCursorPos failed' }
  Start-Sleep -Milliseconds 150
  [QpanesPointer]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  try {
    Start-Sleep -Milliseconds 150
    for ($step=1; $step -le 10; $step++) {
      if (![QpanesPointer]::SetCursorPos(($startX+$qpanesDx*$step/10),($startY+$qpanesDy*$step/10))) { throw 'SetCursorPos failed during drag' }
      Start-Sleep -Milliseconds 75
    }
  } finally { [QpanesPointer]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
  Start-Sleep -Milliseconds 250
} finally { [void][QpanesPointer]::SetThreadDpiAwarenessContext($previousDpi) }
