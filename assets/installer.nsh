; OpenCRM installer additions (included by electron-builder, see package.json build.nsis.include).
;  - "Choose features" page after the folder page: desktop shortcut, start with Windows, and which features
;    the first-run setup guide should walk through.
;  - The choices go to %APPDATA%\OpenCRM\installer-choices.json, which OpenCRM reads once on its next start.
;  - Anything not ticked can be set up later: ? -> Setup checklist, or the matching tab in Settings.
; Keep this file ASCII-only.

!include nsDialogs.nsh
!include LogicLib.nsh

!define OC_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

!macro customPageAfterChangeDir
  Var OcPageShown
  Var OcDesktop
  Var OcStartup
  Var OcMe
  Var OcAi
  Var OcEmail
  Var OcTracking
  Var OcAgents
  Var OcWindows
  Var OcCbDesktop
  Var OcCbStartup
  Var OcCbMe
  Var OcCbAi
  Var OcCbEmail
  Var OcCbTracking
  Var OcCbAgents
  Var OcCbWindows

  Page custom OcFeaturesPage OcFeaturesLeave

  Function OcFeaturesPage
    !insertmacro MUI_HEADER_TEXT "Choose features" "Shortcuts, startup, and what to set up the first time OpenCRM opens."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ; first time on this page: sensible defaults (a re-install starts with the setup boxes empty)
    ${If} $OcPageShown != "1"
      StrCpy $OcDesktop ${BST_CHECKED}
      ReadRegStr $1 HKCU "${OC_RUN_KEY}" "OpenCRM"
      ${If} $1 != ""
        StrCpy $OcStartup ${BST_CHECKED}
      ${Else}
        StrCpy $OcStartup ${BST_UNCHECKED}
      ${EndIf}
      ${If} ${FileExists} "$APPDATA\OpenCRM\config.json"
        StrCpy $OcMe ${BST_UNCHECKED}
        StrCpy $OcAi ${BST_UNCHECKED}
        StrCpy $OcEmail ${BST_UNCHECKED}
      ${Else}
        StrCpy $OcMe ${BST_CHECKED}
        StrCpy $OcAi ${BST_CHECKED}
        StrCpy $OcEmail ${BST_CHECKED}
      ${EndIf}
      StrCpy $OcTracking ${BST_UNCHECKED}
      StrCpy $OcAgents ${BST_UNCHECKED}
      StrCpy $OcWindows ${BST_UNCHECKED}
    ${EndIf}
    StrCpy $OcPageShown "1"

    ${NSD_CreateLabel} 0 0 100% 10u "Shortcuts and startup"
    Pop $0
    ${NSD_CreateCheckbox} 8u 11u -8u 10u "Desktop shortcut"
    Pop $OcCbDesktop
    ${NSD_SetState} $OcCbDesktop $OcDesktop
    ${NSD_CreateCheckbox} 8u 22u -8u 10u "Start OpenCRM with Windows, in the tray (reminders and new-mail alerts keep working)"
    Pop $OcCbStartup
    ${NSD_SetState} $OcCbStartup $OcStartup

    ${NSD_CreateLabel} 0 38u 100% 10u "Set up when OpenCRM opens (a short guide walks you through each one; you can skip any step):"
    Pop $0
    ${NSD_CreateCheckbox} 8u 50u 46% 10u "About me (name, signature)"
    Pop $OcCbMe
    ${NSD_SetState} $OcCbMe $OcMe
    ${NSD_CreateCheckbox} 8u 61u 46% 10u "Local AI (AI search, writing help)"
    Pop $OcCbAi
    ${NSD_SetState} $OcCbAi $OcAi
    ${NSD_CreateCheckbox} 8u 72u 46% 10u "Email accounts"
    Pop $OcCbEmail
    ${NSD_SetState} $OcCbEmail $OcEmail
    ${NSD_CreateCheckbox} 52% 50u 48% 10u "Email open and click tracking"
    Pop $OcCbTracking
    ${NSD_SetState} $OcCbTracking $OcTracking
    ${NSD_CreateCheckbox} 52% 61u 48% 10u "AI agents: Claude, Hermes... (MCP)"
    Pop $OcCbAgents
    ${NSD_SetState} $OcCbAgents $OcAgents
    ${NSD_CreateCheckbox} 52% 72u 48% 10u "Tray, notifications, quick-add key"
    Pop $OcCbWindows
    ${NSD_SetState} $OcCbWindows $OcWindows

    ${NSD_CreateLabel} 0 90u 100% 40u "Nothing here is final. Whatever you leave unticked can be set up later: in OpenCRM, the ? button opens the Setup checklist (with a 'Set up now' button for each feature), and each feature has its own tab in Settings (the gear icon). The full tutorial is under ? > Tutorial."
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function OcFeaturesLeave
    ${NSD_GetState} $OcCbDesktop $OcDesktop
    ${NSD_GetState} $OcCbStartup $OcStartup
    ${NSD_GetState} $OcCbMe $OcMe
    ${NSD_GetState} $OcCbAi $OcAi
    ${NSD_GetState} $OcCbEmail $OcEmail
    ${NSD_GetState} $OcCbTracking $OcTracking
    ${NSD_GetState} $OcCbAgents $OcAgents
    ${NSD_GetState} $OcCbWindows $OcWindows
  FunctionEnd
!macroend

!macro customInstall
  ; Only when the page was shown (a silent /S install keeps whatever was there before).
  ${If} $OcPageShown == "1"
    ${If} $OcDesktop == ${BST_CHECKED}
      CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$appExe" "" "$appExe" 0
    ${Else}
      Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
    ${EndIf}
    ${If} $OcStartup == ${BST_CHECKED}
      WriteRegStr HKCU "${OC_RUN_KEY}" "OpenCRM" '"$appExe" --hidden'
    ${Else}
      DeleteRegValue HKCU "${OC_RUN_KEY}" "OpenCRM"
    ${EndIf}
    CreateDirectory "$APPDATA\OpenCRM"
    FileOpen $0 "$APPDATA\OpenCRM\installer-choices.json" w
    FileWrite $0 '{"desktop":$OcDesktop,"startWithWindows":$OcStartup,"me":$OcMe,"ai":$OcAi,"email":$OcEmail,"tracking":$OcTracking,"agents":$OcAgents,"windows":$OcWindows}'
    FileClose $0
  ${EndIf}
!macroend

!macro customUnInstall
  ; A real uninstall (not an update) removes the shortcut and the startup entry. Your databases and settings stay.
  ${IfNot} ${isUpdated}
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
    DeleteRegValue HKCU "${OC_RUN_KEY}" "OpenCRM"
  ${EndIf}
!macroend
