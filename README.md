# Olive Pizza — Authoritative Backend API (v2.2.0)

Production-grade, highly resilient backend engine for **Olive Pizza**, powering the entire multi-tenant franchise ecosystem: Customer Web & Mobile apps, Owner Dashboard, Franchise Portals, Restaurant Manager (KDS/Operations), Delivery Raider apps, and POS Billing Terminals.

---

## 1. Architectural Highlights

- **Dual-Database Authoritative Architecture**:
  - **Layerbase Serverless PostgreSQL**: The single authoritative source of truth for canonical orders (`canonical_orders`), financial ledgers, audit trails, user permissions (`app_users`), branches, and bill sequencing (`permanent_bill_no`).
  - **Firebase Firestore**: High-speed, real-time reactive event stream for live driver GPS tracking, active order queues, menu sync, and push notifications.
- **Unified Order Lifecycle State Machine**:
  $$\text{PLACED} \longrightarrow \text{PREPARING} \longrightarrow \text{READY} \longrightarrow \text{OUT\_FOR\_DELIVERY} \longrightarrow \text{DELIVERED}$$
  Guarded by distributed PostgreSQL locks (`order_locks`) and strict idempotency keys (`order_idempotency_records`).
- **Real-Time Fleet & Dispatch**:
  - Intelligent proximity-based rider allocation with automated replacement saga handling.
  - Live GPS breadcrumbs streamed via WebSocket and Supabase Realtime telemetry.
- **Enterprise Security & Compliance**:
  - Strict role-based access control (RBAC) with `requireRole` and `requireDeveloper` guards.
  - Zero client-exposed secrets; all sensitive payment credentials, HMAC tokens, and service accounts reside strictly on the server.
  - Indian standards compliant: ₹ INR currency, 5% GST taxation (CGST 2.5% + SGST 2.5%), and IST timestamps.

---

## 2. Authorized Administrative Accounts

The following system accounts have predefined access rules configured across the platform:

| Email Account | Role | Platform Access Scope |
| :--- | :--- | :--- |
| **`webhub2811@gmail.com`** | `owner` (Super Admin) | **Full Access** to Owner Portal (`:5174`), Franchise (`:5175`), Restaurant Manager (`:5176`), Delivery (`:5177`), and POS (`:5178`) |
| **`olivepizzarjn@gmail.com`** | `owner` | **Full Administrative Access** across all operational portals |
| **`samyakshrivastava28@gmail.com`** | `restaurant_manager` | Restaurant Manager (`:5176`) & Branch Operations |
| **`samyaks695@gmail.com`** | `delivery_partner` | Delivery Raider Mobile Application (`:5177`) |
| **`samyakssaamm@gmail.com`** | `delivery_partner` | Delivery Raider Mobile Application (`:5177`) |

---

## 3. Application Port Matrix

| Service | Port | Description |
| :--- | :--- | :--- |
| **Backend API** | `5000` | Express REST, WebSockets, gRPC, Background Jobs |
| **Customer App** | `3000` | Customer Web & PWA / Capacitor Native Container |
| **Owner Dashboard** | `5174` | SDUI Designer, Global Analytics, Media Vault |
| **Franchise Portal** | `5175` | Franchisee Financials, Settlement & P&L |
| **Restaurant Manager** | `5176` | Live Kitchen Display System, Order Acceptance & Alarms |
| **Delivery Raider** | `5177` | Rider Handover, Turn-by-Turn GPS Navigation |
| **POS System** | `5178` | Offline-First Dine-in & Takeaway Thermal Billing |

---

## 4. Getting Started (Local Development)

### Prerequisites
- Node.js `20.x` to `24.x`
- npm `10.x+`

### Installation & Run
```bash
# Install dependencies
npm install

# Run database migrations
npm run build

# Start authoritative backend server
npm start
# Server listens on http://localhost:5000 (Health: http://localhost:5000/api/health)
```

---

## 5. Deployment on Render

This service includes a native `render.yaml` blueprint.

1. In Render, select **Blueprints** -> **New Blueprint Instance** and connect the repository.
2. Link the Environment Group containing all required database connection strings and API keys.
3. See [RENDER_SECRETS_GUIDE.md](docs/RENDER_SECRETS_GUIDE.md) for the exact list of environment secrets.

---

## 6. Testing

```bash
# Run unit and integration test suite
npm test
```
