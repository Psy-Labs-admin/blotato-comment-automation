#!/bin/sh
set -eu
# Prepare local config only. Starting the telegram profile is a separate explicit command.
if [ "$#" -ne 2 ]; then
  echo 'Usage: enable-telegram.sh /absolute/path/to/bot-token-file numeric-chat-id' >&2
  exit 2
fi
chat_id=$2
case "$chat_id" in -*) chat_id=${chat_id#-};; esac
case "$chat_id" in ''|0*|*[!0-9]*) echo 'Expected a nonzero numeric Telegram chat ID.' >&2; exit 2;; esac
case "$1" in /*) ;; *) echo 'Use an absolute token-file path.' >&2; exit 2;; esac
if [ ! -s "$1" ]; then echo 'The Telegram token file must exist and be nonempty.' >&2; exit 2; fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
local_dir="$root/.local/monitoring"
umask 077
mkdir -p "$local_dir"
chmod 700 "$local_dir"
# Do not print or place the token in environment variables, process arguments or Git.
if [ "$1" != "$local_dir/telegram.token" ]; then cp "$1" "$local_dir/telegram.token"; fi
chmod 644 "$local_dir/telegram.token"
sed "s/CHAT_ID/$2/" "$root/deploy/monitoring/alertmanager.telegram.yml.template" > "$local_dir/alertmanager.yml"
chmod 644 "$local_dir/alertmanager.yml"
cat > "$local_dir/telegram.env" <<ENV
MONITORING_ALERTMANAGER_CONFIG=./.local/monitoring/alertmanager.yml
MONITORING_ALERTMANAGERS_FILE=./deploy/monitoring/alertmanagers.telegram.yml
MONITORING_TELEGRAM_TOKEN_FILE=./.local/monitoring/telegram.token
ENV
printf '%s\n' 'Prepared .local/monitoring/telegram.env. No notifications have been sent.'
