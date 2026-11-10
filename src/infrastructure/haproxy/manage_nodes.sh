#!/usr/bin/env bash
# ==============================================================================
# OLIVE PIZZA — HORIZONTAL CLUSTER NODE MANAGER (HAPROXY RUNTIME SOCKET)
# ==============================================================================
# Usage:
#   ./manage_nodes.sh status
#   ./manage_nodes.sh enable <node_number>   # e.g., ./manage_nodes.sh enable 2
#   ./manage_nodes.sh drain <node_number>    # graceful traffic drainage
#   ./manage_nodes.sh disable <node_number>  # set to maintenance mode
#   ./manage_nodes.sh stats                  # quick traffic summary
# ==============================================================================

set -euo pipefail

SOCKET="/run/haproxy/admin.sock"

if [ ! -S "${SOCKET}" ]; then
    echo "❌ Error: HAProxy runtime socket not found at: ${SOCKET}" >&2
    echo "Ensure HAProxy is running and 'stats socket ${SOCKET}' is configured." >&2
    exit 1
fi

send_cmd() {
    local cmd="$1"
    echo "${cmd}" | socat "${SOCKET}" -
}

COMMAND="${1:-status}"
NODE_NUM="${2:-}"

case "${COMMAND}" in
    status)
        echo "📊 === Olive Pizza HAProxy Cluster Nodes Status ==="
        send_cmd "show servers state" | awk '
            NR==1 { next }
            /olivepizza_api/ || /olivepizza_websocket/ {
                backend = $2
                server = $4
                state = ($6 == 2 ? "READY" : ($6 == 1 ? "DRAIN" : "MAINT/DISABLED"))
                weight = $5
                chk = ($17 == 0 ? "DOWN" : "UP")
                printf "  %-22s %-16s State: %-14s Check: %s\n", backend, server, state, chk
            }
        '
        ;;

    enable)
        if [ -z "${NODE_NUM}" ]; then
            echo "Usage: $0 enable <node_number> (e.g. 2 for app_node_2)" >&2
            exit 1
        fi
        echo "🚀 Enabling traffic to app_node_${NODE_NUM} in all backends..."
        send_cmd "set server olivepizza_api/app_node_${NODE_NUM} state ready"
        send_cmd "set server olivepizza_websocket/app_node_${NODE_NUM}_ws state ready"
        echo "✅ Node ${NODE_NUM} set to READY."
        ;;

    drain)
        if [ -z "${NODE_NUM}" ]; then
            echo "Usage: $0 drain <node_number> (e.g. 2 for app_node_2)" >&2
            exit 1
        fi
        echo "⏳ Draining traffic from app_node_${NODE_NUM} (existing connections finish, new connections redirected)..."
        send_cmd "set server olivepizza_api/app_node_${NODE_NUM} state drain"
        send_cmd "set server olivepizza_websocket/app_node_${NODE_NUM}_ws state drain"
        echo "✅ Node ${NODE_NUM} set to DRAIN."
        ;;

    disable)
        if [ -z "${NODE_NUM}" ]; then
            echo "Usage: $0 disable <node_number> (e.g. 2 for app_node_2)" >&2
            exit 1
        fi
        echo "🛑 Disabling app_node_${NODE_NUM} (MAINT mode)..."
        send_cmd "set server olivepizza_api/app_node_${NODE_NUM} state maint"
        send_cmd "set server olivepizza_websocket/app_node_${NODE_NUM}_ws state maint"
        echo "✅ Node ${NODE_NUM} set to MAINT."
        ;;

    stats)
        echo "📈 === Cluster Traffic Statistics ==="
        send_cmd "show stat" | cut -d',' -f1,2,5,8,9,18,34 | column -s, -t | grep -E "pxname|olivepizza|stats"
        ;;

    *)
        echo "Unknown command: ${COMMAND}" >&2
        echo "Available commands: status, enable <node>, drain <node>, disable <node>, stats" >&2
        exit 1
        ;;
esac
