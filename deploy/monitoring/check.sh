#!/bin/sh
set -eu
# Configuration parsing and rule evaluation only: no server and no notification delivery.
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
monitoring_dir="$root/deploy/monitoring"
test_dir=$(mktemp -d)
# Validation data contains no real credentials; containers run as nobody.
chmod 755 "$test_dir"
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
cp "$monitoring_dir"/*.yml "$test_dir/"
cp "$monitoring_dir/alertmanagers.disabled.yml" "$test_dir/alertmanagers.yml"
sed 's/CHAT_ID/1/' "$monitoring_dir/alertmanager.telegram.yml.template" > "$test_dir/alertmanager.telegram.yml"
printf '%s\n' 'isolated-config-validation-token' > "$test_dir/metrics_token"
printf '%s\n' '123456789:isolated-config-validation-only' > "$test_dir/telegram_token"
chmod 644 "$test_dir"/*
# Both tools parse mounted absolute paths without reaching the API or Telegram.
docker run --rm --network none --tmpfs /tmp:rw,size=128m,mode=1777 --entrypoint /bin/promtool \
  -v "$test_dir:/etc/prometheus:ro" -v "$test_dir/metrics_token:/run/secrets/metrics_token:ro" \
  prom/prometheus:v3.13.5 check config /etc/prometheus/prometheus.yml
docker run --rm --network none --tmpfs /tmp:rw,size=128m,mode=1777 --entrypoint /bin/promtool \
  -v "$test_dir:/etc/prometheus:ro" prom/prometheus:v3.13.5 test rules /etc/prometheus/alerts.test.yml
docker run --rm --network none --tmpfs /tmp:rw,size=128m,mode=1777 --entrypoint /bin/amtool \
  -v "$test_dir:/etc/alertmanager:ro" -v "$test_dir/telegram_token:/run/secrets/telegram_token:ro" \
  prom/alertmanager:v0.34.2 check-config /etc/alertmanager/alertmanager.disabled.yml
docker run --rm --network none --tmpfs /tmp:rw,size=128m,mode=1777 --entrypoint /bin/amtool \
  -v "$test_dir:/etc/alertmanager:ro" -v "$test_dir/telegram_token:/run/secrets/telegram_token:ro" \
  prom/alertmanager:v0.34.2 check-config /etc/alertmanager/alertmanager.telegram.yml
