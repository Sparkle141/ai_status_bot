Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
widgetDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1Path = fso.BuildPath(widgetDir, "AiDeskPet.ps1")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & ps1Path & """"
shell.Run cmd, 0, False
