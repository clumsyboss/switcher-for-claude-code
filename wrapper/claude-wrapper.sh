#!/bin/sh
# Switcher for Claude Code: the pin wrapper for macOS and Linux.
#
# Claude Code starts each chat through `claudeCode.claudeProcessWrapper` when
# that setting is on, as
#     claude-wrapper.sh <real claude> <claude's arguments...>
# The switcher turns it on only while something is pinned. This finds the
# chat's id in the arguments (--resume=<id> or --session-id=<id>, or the
# two-part forms) and the folder it starts in, and looks both up in the pins
# file named by CLAUDESWITCHER_PINS:
#     login<TAB>account<TAB>expiresAtMs<TAB>dir
#     chat<TAB>id<TAB>account        folder<TAB>folder<TAB>account
# The chat's own pin wins, then the deepest pinned folder. A pinned chat is
# started on that account's pinning login: CLAUDE_SECURESTORAGE_CONFIG_DIR
# points at <pins folder>/pinning/<account>, which moves only where Claude
# Code keeps its login (settings, skills and history stay in ~/.claude).
# The login must last at least another hour, or the chat could stop mid-way;
# otherwise, and for every chat that isn't pinned, it starts exactly as
# Claude Code asked (the active account). CLAUDE_CONFIG_DIR is never touched.
#
# A pinned chat is noted in pinning/.inuse/<pid>.json. `exec` replaces this
# script with claude (same pid), so input, output and signals go straight to
# it, but nothing is left to delete the note: the switcher ignores notes whose
# pid has ended.
#
# `claude-wrapper.sh --switcher-selftest` prints "claudeswitcher-wrapper ok
# <version>" and starts nothing.

[ "$#" -gt 0 ] || { echo "claude-wrapper: no program to run" >&2; exit 2; }
if [ "$1" = "--switcher-selftest" ]; then echo "claudeswitcher-wrapper ok 1.4.0"; exit 0; fi

sid=""
prev=""
has_settings=""
for a in "$@"; do
  case "$a" in
    --resume=*) sid="${a#--resume=}" ;;
    --session-id=*) sid="${a#--session-id=}" ;;
    --settings|--settings=*) has_settings=1 ;;
  esac
  if [ "$prev" = "--resume" ] || [ "$prev" = "--session-id" ]; then sid="$a"; fi
  prev="$a"
done
case "$sid" in
  ''|*[!A-Za-z0-9-]*) sid="" ;;
esac
[ "${#sid}" -ge 8 ] && [ "${#sid}" -le 64 ] || sid=""

if [ -n "$CLAUDESWITCHER_PINS" ] && [ -f "$CLAUDESWITCHER_PINS" ]; then
  root=$(dirname "$CLAUDESWITCHER_PINS")
  cwd=$(pwd -P 2>/dev/null || pwd)
  now=$(date +%s)
  # Prints "<account><TAB><dir>" when the chat's account has a pinning login
  # that lasts another hour and sits in its own folder under root/pinning.
  found=$(awk -F '\t' -v s="$sid" -v c="$cwd" -v r="$root" -v now="$now" '
    function trim(p) { sub(/\/+$/, "", p); return p }
    BEGIN { c = trim(c); best = ""; bestlen = -1; chat = "" }
    NF == 3 && $1 == "chat" && s != "" && $2 == s { chat = $3 }
    NF == 3 && $1 == "folder" { f = trim($2); if (f != "" && (c == f || index(c, f "/") == 1) && length(f) > bestlen) { best = $3; bestlen = length(f) } }
    NF == 4 && $1 == "login" { ex[$2] = $3; dir[$2] = $4; has[$2] = 1 }
    END {
      a = (chat != "") ? chat : best
      if (a == "" || length(a) > 32 || a !~ /^[A-Za-z0-9][A-Za-z0-9._-]*$/ || !(a in has)) exit
      if (ex[a] !~ /^[0-9]+$/ || length(ex[a]) > 16 || ex[a] / 1000 <= now + 3600) exit
      if (dir[a] != r "/pinning/" a) exit
      print a "\t" dir[a]
    }
  ' "$CLAUDESWITCHER_PINS" 2>/dev/null)
  if [ -n "$found" ]; then
    tab=$(printf '\t')
    account="${found%%"$tab"*}"
    dir="${found#*"$tab"}"
    CLAUDE_SECURESTORAGE_CONFIG_DIR="$dir"
    export CLAUDE_SECURESTORAGE_CONFIG_DIR
    # A token in the environment would win over the pinning login.
    unset CLAUDE_CODE_OAUTH_TOKEN

    # The in-use note; best effort, a chat never fails to start because of it.
    inuse="$root/pinning/.inuse"
    if mkdir -p "$inuse" 2>/dev/null; then
      nl='
'
      case "$cwd" in
        *"$tab"*|*"$nl"*) cwdjson=null ;;
        *) cwdjson="\"$(printf '%s' "$cwd" | sed 's/\\/\\\\/g; s/"/\\"/g')\"" ;;
      esac
      if [ -n "$sid" ]; then sidjson="\"$sid\""; else sidjson=null; fi
      note="$inuse/$$.json"
      printf '{"v":1,"name":"%s","pid":%s,"sessionId":%s,"cwd":%s,"startedAt":%s}\n' \
        "$account" "$$" "$sidjson" "$cwdjson" "$((now * 1000))" > "$note.tmp" 2>/dev/null &&
        mv -f "$note.tmp" "$note" 2>/dev/null
      rm -f "$note.tmp" 2>/dev/null
    fi

    # The account's own Remote Control and Artifacts choices, when it has a
    # settings file that looks like a JSON object. Never when Claude Code
    # already passes --settings: a second one would replace its own.
    sf="$root/pinning/$account.settings.json"
    if [ -z "$has_settings" ] && [ -f "$sf" ] && [ "$(wc -c < "$sf")" -le 65536 ]; then
      body=$(tr -d ' \t\r\n' < "$sf")
      case "$body" in
        "{"*"}") set -- "$@" --settings "$sf" ;;
      esac
    fi
  fi
fi

exec "$@"
