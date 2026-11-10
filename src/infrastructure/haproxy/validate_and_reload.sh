#!/usr/bin/env bash
# ==============================================================================
# OLIVE PIZZA — HAPROXY CONFIGURATION VALIDATION & ZERO-DOWNTIME RELOAD RUNNER
# ==============================================================================

set -euo pipefail

CONFIG_PATH="${1:-/etc/haproxy/haproxy.cfg}"
SOCKET_PATH="/run/haproxy/admin.sock"

echo "🔍 [HAProxy] Validating configuration syntax at: ${CONFIG_PATH}..."

# 1. Strict Syntax Check Before Reloading
if ! haproxy -c -V -f "${CONFIG_PATH}"; then
    echo "❌ [HAProxy] Configuration check FAILED! Existing HAProxy process left untouched." >&2
    exit 1
fi

echo "✅ [HAProxy] Configuration syntax is valid."

# 2. Seamless Graceful Reload
if systemctl is-active --quiet haproxy; then
    echo "🔄 [HAProxy] Initiating hitless graceful reload..."
    systemctl reload haproxy
    echo "✅ [HAProxy] Graceful reload triggered successfully."
else
    echo "ℹ️ [HAProxy] HAProxy is not currently active. Starting service..."
    systemctl start haproxy
    echo "✅ [HAProxy] Service started."
fi

# 3. Verify Socket Accessibility
if [ -S "${SOCKET_PATH}" ]; then
    echo "🔌 [HAProxy] Admin socket accessible at ${SOCKET_PATH}."
    echo "show info" | socat "${SOCKET_PATH}" - | grep -E "Name|Version|Uptime|Process_num|CurrConns"
else
    echo "⚠️ [HAProxy] Notice: Admin socket ${SOCKET_PATH} is not present yet."
fi

echo "🏁 [HAProxy] Verification and reload complete."
