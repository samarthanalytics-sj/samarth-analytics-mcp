' Starts the supervisor with no console window. Windows only.
'
' Why this exists: registering a Scheduled Task that runs without a visible window needs the S4U
' logon type, and that needs elevation. A per-user task needs no admin rights but runs node.exe in
' an interactive console, which then sits on the desktop for the life of the service. That window is
' a hazard rather than a feature: closing it kills the orchestrator, and it looks exactly like a
' leftover terminal somebody should tidy up.
'
' wscript runs this with no window at all, and bWaitOnReturn keeps it alive for as long as node is,
' so the Scheduled Task still sees the service as running and its restart-on-failure still applies.
'
' Nothing here should carry logic. The supervisor owns restarts and logging; this only hides a
' window. On any host with a real service manager, delete this and use that instead.

Dim shell, fso, here
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Resolve paths from this file rather than the working directory, so the task does not depend on
' where it was launched from.
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = fso.GetParentFolderName(here)

' 0 = hidden window, True = block until node exits.
shell.Run "node.exe """ & here & "\supervise.mjs""", 0, True
