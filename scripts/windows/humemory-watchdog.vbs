' Restarts the humemory API if it has stopped answering.
'
' The maintenance loop lives inside the API process, so that process is now a
' single point of failure: if it dies at 3am, consolidation stops until the next
' logon. This watchdog is what makes that survivable. It is registered as a
' scheduled task (see install.ps1) whose action is wscript.exe — a windowless
' host — so it never flashes a console, which is the whole reason maintenance
' was moved out of a `cmd`-based task in the first place.
'
' It probes /health, which is deliberately public and cheap: the watchdog does
' not hold the API token and does not need it. Liveness only — staleness is a
' human question, answered by `humemory maintenance status`.

Option Explicit

Dim sh, fso, root, port, url, http, alive, logFile, launcher

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))

port = sh.ExpandEnvironmentStrings("%HUMEMORY_PORT%")
If port = "%HUMEMORY_PORT%" Or port = "" Then port = "3456"
url = "http://127.0.0.1:" & port & "/health"

alive = False
On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
If Err.Number = 0 Then
  ' Short budgets: a hung server should be treated as dead, not waited on.
  http.setTimeouts 2000, 2000, 2000, 5000
  http.open "GET", url, False
  http.send
  If Err.Number = 0 Then
    If http.status = 200 Then alive = True
  End If
End If
Err.Clear
On Error GoTo 0

logFile = fso.BuildPath(root, "data\logs\watchdog.log")

If Not alive Then
  launcher = fso.BuildPath(root, "scripts\windows\humemory-api.vbs")
  If fso.FileExists(launcher) Then
    ' Hidden, same as at logon. If the old process is merely wedged rather than
    ' gone, it still holds the port and the new one exits on its own — which is
    ' why nothing is killed here: a watchdog that kills is a watchdog that can
    ' take down a healthy server on a false negative.
    sh.Run "wscript.exe " & Chr(34) & launcher & Chr(34), 0, False
    WriteLog logFile, "restarted: " & url & " did not answer"
  Else
    WriteLog logFile, "cannot restart: launcher missing at " & launcher
  End If
End If

Sub WriteLog(path, message)
  Dim folder, stream
  On Error Resume Next
  folder = fso.GetParentFolderName(path)
  If Not fso.FolderExists(folder) Then fso.CreateFolder folder
  Set stream = fso.OpenTextFile(path, 8, True)
  stream.WriteLine Now & "  " & message
  stream.Close
  On Error GoTo 0
End Sub
