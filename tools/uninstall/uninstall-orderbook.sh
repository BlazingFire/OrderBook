#!/usr/bin/env bash
# Remove OrderBook (Master Panel, Office Panel, or both) from this Mac or
# Linux PC. The Windows equivalent is `uninstall-orderbook.ps1` beside this.
#
# Dragging the .app to the Trash leaves the Electron profile, the updater
# cache, the login item and - the part that matters - the data folder under
# ~/Library/Application Support/OrderBook, wherever the operator relocated it.
# That folder is deliberately outside the bundle so an upgrade cannot touch a
# company's records; this script is the one place that removes it, and only
# without --keep-data.
#
# Processes are stopped by their path inside the app bundle, never by name:
# another PostgreSQL may be running on this machine and `pkill postgres`
# would take it down with ours.
#
# The two operating systems put the same things in different places, so the
# path lists below branch on `uname`. Everything else -- the arguments, the
# counters, the dry run, the data/keep-data rule -- is shared, because a
# second copy of this script for Linux is how the two would drift.
#
#   uninstall-orderbook.sh [--panel master|office|all] [--keep-data] [--yes] [--dry-run]
#
# --dry-run prints every path and changes nothing, on any machine.
set -euo pipefail

PANEL=all
KEEP_DATA=0
YES=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --panel) PANEL="${2:-}"; shift ;;
    --panel=*) PANEL="${1#--panel=}" ;;
    --keep-data) KEEP_DATA=1 ;;
    --yes) YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$PANEL" in master|office|all) ;; *) echo "--panel must be master, office or all" >&2; exit 2 ;; esac

PANELS=()
if [ "$PANEL" != office ]; then PANELS+=(master); fi
if [ "$PANEL" != master ]; then PANELS+=(office); fi

product_of() { if [ "$1" = master ]; then echo 'OrderBook Master Panel'; else echo 'OrderBook Office Panel'; fi; }
app_id_of() { echo "com.orderbook.$1"; }
# `executableName` in each panel's electron-builder.yml. The .deb names its
# binary, its /usr/share/applications entry and its icon after this rather than
# after the product name, so a sweep that only knew the product name walked
# past the desktop entry of every Debian install.
exec_of() { echo "orderbook-$1"; }

REMOVED=0; KEPT=0; SKIPPED=0; FAILED=0
say() { printf '[%s] %s\n' "$1" "$2"; }

# rm -rf as the user first; sudo only when that fails (an /Applications
# bundle installed by an administrator), so the password prompt is the
# exception rather than the greeting.
remove_path() {
  local what="$1" path="$2"
  if [ "$DRY_RUN" = 1 ]; then
    if [ -e "$path" ]; then say dry-run "would remove $what: $path"; else say dry-run "would remove $what: $path (absent)"; fi
    return 0
  fi
  if [ ! -e "$path" ]; then say skip "$what not present: $path"; SKIPPED=$((SKIPPED + 1)); return 0; fi
  rm -rf "$path" 2>/dev/null || sudo rm -rf "$path" || true
  if [ -e "$path" ]; then say fail "could not remove $what: $path"; FAILED=$((FAILED + 1))
  else say remove "$what: $path"; REMOVED=$((REMOVED + 1)); fi
}

keep_path() { say keep "$1: $2"; KEPT=$((KEPT + 1)); }

# The relocation pointer is `{"dataDir": "..."}` written by the shell.
# python3 ships with the developer tools; sed is the fallback for a Mac that
# has never had them, and is enough for the one-key file the shell writes.
relocated_dir() {
  local file="$1"
  [ -f "$file" ] || return 0
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("dataDir") or "")' "$file" 2>/dev/null && return 0
  fi
  sed -n 's/.*"dataDir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file"
}

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux) OS=linux ;;
  *) echo "This script covers macOS and Linux. On Windows use uninstall-orderbook.ps1." >&2; exit 2 ;;
esac

# Electron's `app.getPath('appData')`, which is what `electron/shell.ts`
# builds the data folder from -- so this is the same folder the running app
# would name, on either OS, rather than a guess.
if [ "$OS" = mac ]; then
  APP_SUPPORT="$HOME/Library/Application Support"
else
  APP_SUPPORT="${XDG_CONFIG_HOME:-$HOME/.config}"
fi

# Honoured, not assumed. `master/src/config/index.ts` resolves this from
# ORDERBOOK_RELEASES_DIR and only falls back to the drive root -- the .ps1 has
# always read the variable, and this script used to hardcode the fallback, so
# a site that had moved its releases folder kept it after a full uninstall.
RELEASES_DIR="${ORDERBOOK_RELEASES_DIR:-/OrderBook-Releases}"

# ------------------------------------------------------------------ summary
echo
if [ "$DRY_RUN" = 1 ]; then echo 'OrderBook uninstall  (DRY RUN - nothing will be changed)'; else echo 'OrderBook uninstall'; fi
echo "  Panels: ${PANELS[*]}"
if [ "$KEEP_DATA" = 1 ]; then echo '  Data:   KEPT (--keep-data)'; else echo '  Data:   ERASED - database, uploads, documents, settings, logs'; fi
echo
if [ "$YES" != 1 ] && [ "$DRY_RUN" != 1 ]; then
  read -r -p 'Type YES to continue: ' answer
  if [ "$answer" != YES ]; then echo 'Nothing was changed.'; exit 0; fi
fi

for panel in "${PANELS[@]}"; do
  product="$(product_of "$panel")"
  app_id="$(app_id_of "$panel")"
  exec_name="$(exec_of "$panel")"
  echo "-- $product"

  # Quit politely first so the server's own shutdown runs, then make sure of
  # it by path: the shell, its Node server and the vendored postgres all live
  # inside the install folder, and stopping by name would take down an
  # unrelated PostgreSQL on the same machine.
  if [ "$OS" = mac ]; then
    app_dirs=("/Applications/$product.app" "$HOME/Applications/$product.app")
  else
    app_dirs=("/opt/$product" "$HOME/Applications/$product" "$HOME/.local/share/$product")
  fi

  if [ "$DRY_RUN" = 1 ]; then
    say dry-run "would quit \"$product\" and stop every process under: ${app_dirs[*]}"
  else
    if [ "$OS" = mac ] && command -v osascript >/dev/null 2>&1; then
      osascript -e "quit app \"$product\"" >/dev/null 2>&1 || true
    fi
    sleep 2
    for app_dir in "${app_dirs[@]}"; do
      pkill -f "$app_dir/" >/dev/null 2>&1 || true
    done
    # The AppImage runs from a FUSE mount under /tmp, so its own path never
    # matches the list above; it is matched by the product name in the
    # AppImage filename instead, which no other program carries.
    if [ "$OS" = linux ]; then
      pkill -f "${product// /}.*\.AppImage" >/dev/null 2>&1 || true
    fi
    say remove "stopped $product processes (if any)"
  fi

  for app_dir in "${app_dirs[@]}"; do
    remove_path 'application' "$app_dir"
  done

  if [ "$OS" = mac ]; then
    remove_path 'profile' "$APP_SUPPORT/$product"
    remove_path 'cache' "$HOME/Library/Caches/$app_id"
    remove_path 'cache' "$HOME/Library/Caches/$product"
    remove_path 'preferences' "$HOME/Library/Preferences/$app_id.plist"
    remove_path 'logs' "$HOME/Library/Logs/$product"
    remove_path 'saved state' "$HOME/Library/Saved Application State/$app_id.savedState"
    remove_path 'HTTP storage' "$HOME/Library/HTTPStorages/$app_id"
    remove_path 'WebKit storage' "$HOME/Library/WebKit/$product"
    remove_path 'updater cache' "$APP_SUPPORT/Caches/$app_id-updater"
    remove_path 'updater cache' "$APP_SUPPORT/$app_id-updater"
  else
    # Electron on Linux: userData under $XDG_CONFIG_HOME, caches under
    # $XDG_CACHE_HOME, and a .desktop entry per install location.
    remove_path 'profile' "$APP_SUPPORT/$product"
    remove_path 'cache' "${XDG_CACHE_HOME:-$HOME/.cache}/$product"
    remove_path 'updater cache' "${XDG_CACHE_HOME:-$HOME/.cache}/$app_id-updater"
    remove_path 'updater cache' "$APP_SUPPORT/$app_id-updater"
    remove_path 'desktop entry' "${XDG_DATA_HOME:-$HOME/.local/share}/applications/$product.desktop"
    remove_path 'desktop entry' "${XDG_DATA_HOME:-$HOME/.local/share}/applications/$app_id.desktop"
    remove_path 'desktop entry' "/usr/share/applications/$product.desktop"
    # What the .deb actually installs: entry, icons and binary all named for
    # `executableName`, not for the product.
    remove_path 'desktop entry' "/usr/share/applications/$exec_name.desktop"
    remove_path 'desktop entry' "${XDG_DATA_HOME:-$HOME/.local/share}/applications/$exec_name.desktop"
    remove_path 'desktop icon' "$HOME/Desktop/$product.desktop"
    remove_path 'desktop icon' "$HOME/Desktop/$exec_name.desktop"
    for size in 16 32 48 64 128 256 512 1024; do
      remove_path 'application icon' "/usr/share/icons/hicolor/${size}x${size}/apps/$exec_name.png"
    done
    remove_path 'launcher symlink' "/usr/bin/$exec_name"
    # `update-alternatives` is what the .deb's postinst uses when it is present,
    # so the real link lives here and /usr/bin/ only points at it.
    remove_path 'launcher alternative' "/etc/alternatives/$exec_name"
    remove_path 'package docs' "/usr/share/doc/$exec_name-panel"
  fi

  if [ "$OS" = mac ]; then
    if [ "$DRY_RUN" = 1 ]; then
      say dry-run "would delete login item \"$product\""
    elif command -v osascript >/dev/null 2>&1; then
      # No login item is the normal case; a failure here means nothing to do.
      osascript -e "tell application \"System Events\" to delete login item \"$product\"" >/dev/null 2>&1 || true
      say remove "login item \"$product\" (if any)"
    fi
  else
    # `app.setLoginItemSettings` writes an autostart .desktop on Linux. The
    # Master sets one by default on first run; the Office panel does not.
    remove_path 'autostart entry' "$APP_SUPPORT/autostart/$product.desktop"
    remove_path 'autostart entry' "$APP_SUPPORT/autostart/$app_id.desktop"
    remove_path 'autostart entry' "$APP_SUPPORT/autostart/$exec_name.desktop"
  fi

  data_dir="$APP_SUPPORT/OrderBook/$panel"
  pointer="$APP_SUPPORT/OrderBook/$panel-location.json"
  settings="$APP_SUPPORT/OrderBook/$panel-settings.env"
  relocated="$(relocated_dir "$pointer")"
  if [ "$KEEP_DATA" = 1 ]; then
    keep_path 'data folder' "$data_dir"
    [ -n "$relocated" ] && keep_path 'relocated data folder' "$relocated"
    keep_path 'location pointer' "$pointer"
    keep_path 'settings file' "$settings"
  else
    remove_path 'data folder' "$data_dir"
    if [ -n "$relocated" ]; then remove_path 'relocated data folder' "$relocated"
    elif [ "$DRY_RUN" = 1 ]; then say dry-run "would remove the folder named in $pointer, if any"; fi
    remove_path 'location pointer' "$pointer"
    remove_path 'settings file' "$settings"
  fi
done

if [ "$DRY_RUN" != 1 ] && [ "$KEEP_DATA" != 1 ] && [ -d "$APP_SUPPORT/OrderBook" ] && [ -z "$(ls -A "$APP_SUPPORT/OrderBook")" ]; then
  remove_path 'empty OrderBook folder' "$APP_SUPPORT/OrderBook"
fi

case " ${PANELS[*]} " in *" master "*)
  if [ "$KEEP_DATA" = 1 ]; then
    keep_path 'releases folder' "$RELEASES_DIR"
  else
    # A drop box an operator may have filled by hand, so it gets its own
    # question when there is somebody to ask.
    wipe=0
    if [ "$YES" = 1 ] || [ "$DRY_RUN" = 1 ]; then wipe=1
    elif [ -d "$RELEASES_DIR" ]; then
      read -r -p "Also delete the releases folder $RELEASES_DIR? (y/N): " answer
      [ "$answer" = y ] && wipe=1
    fi
    if [ "$wipe" = 1 ]; then remove_path 'releases folder' "$RELEASES_DIR"; else keep_path 'releases folder' "$RELEASES_DIR"; fi
  fi
  ;;
esac

echo
if [ "$DRY_RUN" = 1 ]; then
  echo 'Dry run complete. Nothing was changed.'
else
  echo "Done. removed $REMOVED, kept $KEPT, skipped $SKIPPED, failed $FAILED"
fi
[ "$FAILED" = 0 ]
