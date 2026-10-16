' Start kolonna_watch.ps1 with no window at all (startup shortcut points here).
' Path is taken from this file's folder, so no Cyrillic literals are needed.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\kolonna_watch.ps1""", 0, False
