' Starts the humemory API + dashboard with no console window, and keeps its
' output in a log file.
'
' Why a .vbs and not a scheduled task: `schtasks /sc onlogon` is refused without
' elevation on this machine, and a task whose action is `cmd` flashes a console
' window at every run. wscript.exe is a windowless script host, and WScript.Shell
' .Run with window style 0 hides whatever it launches — including cmd, which is
' only used here to get the redirection operators.
'
' Loopback-only by default (HUMEMORY_HOST unset) — see README, "Serving the API
' safely". Installed by scripts/windows/install.ps1.

Option Explicit

Dim sh, fso, root, bun, logDir, logFile, quote, command
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

quote = Chr(34)

' The repo root is this script's grandparent (scripts\windows\ -> repo).
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))

bun = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Microsoft\WinGet\Links\bun.exe")
If Not fso.FileExists(bun) Then
  ' Fall back to whatever bun is on PATH rather than failing silently.
  bun = "bun.exe"
End If

logDir = fso.BuildPath(root, "data\logs")
If Not fso.FolderExists(logDir) Then
  If Not fso.FolderExists(fso.GetParentFolderName(logDir)) Then
    fso.CreateFolder fso.GetParentFolderName(logDir)
  End If
  fso.CreateFolder logDir
End If
logFile = fso.BuildPath(logDir, "api.log")

sh.CurrentDirectory = root

' cmd is only here for ">>": window style 0 keeps it invisible.
command = "cmd /c " & quote & quote & bun & quote & " run src/api/server.ts >> " & _
          quote & logFile & quote & " 2>&1" & quote

sh.Run command, 0, False
