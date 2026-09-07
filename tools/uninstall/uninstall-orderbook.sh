#!/usr/bin/env bash
# Remove OrderBook (Master Panel, Office Panel, or both) from this Mac.
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
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

APP_SUPPORT="$HOME/Library/Application Support"
RELEASES_DIR="/OrderBook-Releases"

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
  echo "-- $product"

  # Quit politely first so the server's own shutdown runs, then make sure of
  # it by path: the shell, its Node server and the vendored postgres all live
  # inside the bundle.
  if [ "$DRY_RUN" = 1 ]; then
    say dry-run "would quit app \"$product\" and stop every process under $product.app/Contents/MacOS and .../Resources/panel/vendor/postgres"
  else
    command -v osascript >/dev/null 2>&1 && osascript -e "quit app \"$product\"" >/dev/null 2>&1 || true
    sleep 2
    for app_dir in "/Applications/$product.app" "$HOME/Applications/$product.app"; do
      pkill -f "$app_dir/Contents/MacOS/" >/dev/null 2>&1 || true
      pkill -f "$app_dir/Contents/Resources/panel/vendor/postgres" >/dev/null 2>&1 || true
    done
    say remove "stopped $product processes (if any)"
  fi

  remove_path 'app bundle' "/Applications/$product.app"
  remove_path 'app bundle' "$HOME/Applications/$product.app"

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

  if [ "$DRY_RUN" = 1 ]; then
    say dry-run "would delete login item \"$product\""
  elif command -v osascript >/dev/null 2>&1; then
    # No login item is the normal case; a failure here means nothing to do.
    osascript -e "tell application \"System Events\" to delete login item \"$product\"" >/dev/null 2>&1 || true
    say remove "login item \"$product\" (if any)"
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
