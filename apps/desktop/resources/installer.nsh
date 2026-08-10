; Sidelong installer customisation.
;
; Running Setup for a new version when an old one is already installed used to
; open a wizard that said "Install", with nothing anywhere to say that a version
; was already there or what would happen to it. This adds a first page that says
; which of the three things is actually about to happen -- install, update, or
; reinstall -- and names both versions.
;
; The check is a registry read, not electron-builder's `${isUpdated}`: that flag
; means "this installer was launched by the auto-updater", which is a different
; question and is false in exactly the case we care about (you downloaded the
; .exe and double-clicked it).

!include LogicLib.nsh
!include WinMessages.nsh

; Everything lives inside the macro on purpose. This file is included at the very
; top of the generated script, before multiUser.nsh defines
; UNINSTALL_REGISTRY_KEY -- and NSIS resolves ${DEFINES} where the line sits, so
; a Function out here fails to build with "unknown variable/constant". The macro
; is expanded further down, by which point the define exists.
!macro customWelcomePage
  Var /GLOBAL installedVersion

  !define MUI_WELCOMEPAGE_TITLE_3LINES
  ; The clean-machine wording. Both branches below overwrite it in place when
  ; something is already installed.
  !define MUI_WELCOMEPAGE_TITLE "Install Sidelong ${VERSION}"
  !define MUI_WELCOMEPAGE_TEXT "A status bar for Claude Code.$\r$\n$\r$\nIt installs for the current user only and needs no administrator rights."
  ; SHOW, not PRE: the PRE callback runs before MUI has created the page, so
  ; SendMessage had no controls to write to and the compile-time text was drawn
  ; regardless. SHOW runs after creation and before display.
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW readInstalledVersion
  !insertmacro MUI_PAGE_WELCOME

  ; Declared AFTER the page macro: $mui.WelcomePage.* are MUI2's own variables
  ; and do not exist until MUI_PAGE_WELCOME has been inserted. The name in
  ; MUI_PAGE_CUSTOMFUNCTION_SHOW above resolves at link time, so the order is
  ; only a compile-time constraint, not a logical one.
  ;
  ; Both hives, explicitly, and NOT SHELL_CONTEXT.
  ;
  ; The welcome page is the FIRST page -- it runs before multiUser's install-mode
  ; page, so SHELL_CONTEXT is still its default of HKLM. Reading it found nothing
  ; for a per-user install and the page cheerfully said "Install" over the top of
  ; an existing one, which is the whole bug this file exists to fix.
  ;
  ; HKCU first because perMachine is false, HKLM after it so an older machine-wide
  ; install from some other build is still recognised rather than silently
  ; treated as a clean box.
  Function readInstalledVersion
    ReadRegStr $installedVersion HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    ${If} $installedVersion == ""
      ReadRegStr $installedVersion HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    ${EndIf}

    ${If} $installedVersion == ""
      ; Nothing installed: the compile-time wording below is already correct.
      Return
    ${EndIf}

    ${If} $installedVersion == "${VERSION}"
      SendMessage $mui.WelcomePage.Title ${WM_SETTEXT} 0 "STR:Reinstall Sidelong ${VERSION}"
      SendMessage $mui.WelcomePage.Text ${WM_SETTEXT} 0 \
        "STR:Sidelong ${VERSION} is already installed. Continuing reinstalls the same version over it.$\r$\n$\r$\nYour settings, hooks and statistics are kept."
    ${Else}
      SendMessage $mui.WelcomePage.Title ${WM_SETTEXT} 0 "STR:Update Sidelong"
      SendMessage $mui.WelcomePage.Text ${WM_SETTEXT} 0 \
        "STR:Version $installedVersion is installed. This will update it to ${VERSION}.$\r$\n$\r$\nYour settings, hooks and statistics are kept. Close Sidelong first if it is running."
    ${EndIf}
  FunctionEnd
!macroend
