# Render Deployment & Secrets Configuration Guide

This guide details all environment variables and secrets required to deploy the **Olive Pizza Backend** and management frontends on [Render](https://render.com).

---

## 1. Fast Setup with Render Blueprints (`render.yaml`)

Both the backend and frontend repositories include native `render.yaml` configurations.
To deploy:
1. Connect your GitHub repository to Render.
2. Select **Blueprints** -> **New Blueprint Instance**.
3. Choose your repository. Render will automatically detect `render.yaml` and configure the build/start commands and health check paths.

---

## 2. Secrets & Environment Variables Reference

Add these secrets to your Render **Environment Group** (e.g. `olive-pizza-prod-secrets`) or service environment settings:

### A. Database Connections (Layerbase PostgreSQL)
| Variable Key | Required | Description | Example / Value |
| :--- | :--- | :--- | :--- |
| `DATABASE_PROVIDER` | Yes | Database driver provider | `layerbase` |
| `DATABASE_ENV` | Yes | Target deployment environment | `production` |
| `DATABASE_URL` | Yes | Primary PostgreSQL pooler URL | `postgresql://user:pass@ep-polished-field-a15m5bvi.ap-southeast-1.pg.layerbase.com:47226/olivepizza?sslmode=require` |
| `DATABASE_DIRECT_URL` | Yes | Direct (non-pooler) connection URL for migrations | `postgresql://user:pass@ep-polished-field-a15m5bvi.ap-southeast-1.pg.layerbase.com:5432/olivepizza?sslmode=require` |
| `LAYERBASE_DATABASE_URL` | Yes | Serverless pooler URL | Same as `DATABASE_URL` |

---

### B. Redis Cache & Realtime
| Variable Key | Required | Description | Example / Value |
| :--- | :--- | :--- | :--- |
| `REDIS_URL` | Yes | Redis connection string (Upstash/Redislabs) | `rediss://default:password@us1-mature-skylark-12345.upstash.io:6379` |
| `REDIS_PASSWORD` | Optional | If required separately by provider | Password string |

---

### C. Firebase Admin SDK
| Variable Key | Required | Description | Value |
| :--- | :--- | :--- | :--- |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | Yes | Base64-encoded Firebase Service Account JSON | `ewogICJ0eXBlIjogInNlcnZpY2VfYWNjb3VudCIs...` |

> [!TIP]
> To generate the Base64 string from your service account file:
> ```bash
> base64 -w 0 firebase-service-account.json
> ```

---

### D. Cloudinary Asset Management
| Variable Key | Required | Description |
| :--- | :--- | :--- |
| `CLOUDINARY_CLOUD_NAME` | Yes | Cloudinary Cloud Name |
| `CLOUDINARY_API_KEY` | Yes | Cloudinary API Key |
| `CLOUDINARY_API_SECRET` | Yes | Cloudinary API Secret |

---

### E. AI Services & Vision Engine
| Variable Key | Required | Description |
| :--- | :--- | :--- |
| `NVIDIA_API_KEY` | Yes | NVIDIA NIM API Key (DeepSeek V4, Llama 3) |
| `OPENROUTER_API_KEY` | Optional | Fallback model gateway API Key |
| `GEMINI_API_KEY` | Yes | Google Gemini Flash / Pro API Key |
| `STITCH_API_KEY` | Yes | Google Stitch SDUI Design Engine API Key |

---

### F. Cloudflare R2 Object Storage
| Variable Key | Required | Description |
| :--- | :--- | :--- |
| `CLOUDFLARE_R2_ACCOUNT_ID` | Yes | Cloudflare Account ID |
| `CLOUDFLARE_R2_BUCKET_NAME` | Yes | Storage bucket name (`olive-pizza-assets`) |

---

### G. Security & Communication Secrets
| Variable Key | Required | Description |
| :--- | :--- | :--- |
| `JWT_SECRET` | Yes | Secret for auth JWT signing (Auto-generated on Render) |
| `TRACKING_TOKEN_SECRET` | Yes | Secret for delivery GPS telemetry signatures |
| `INTERNAL_RPC_SECRET` | Yes | Secret for secure inter-service communication |
| `DEV_INTERNAL_RPC_SECRET` | Yes | Developer diagnostics endpoint authorization |
| `SMTP_HOST` | Yes | Outgoing email SMTP server (e.g., `smtp.gmail.com`) |
| `SMTP_PORT` | Yes | SMTP Port (`587` for TLS) |
| `SMTP_USER` | Yes | Sender email account |
| `SMTP_PASS` | Yes | App Password / SMTP Password |
| `SMTP_FROM` | Yes | Sender display address (e.g. `Olive Pizza <orders@olivepizza.com>`) |
| `OWNER_EMAIL` | Yes | Administrative notifications recipient (`webhub2811@gmail.com`) |

---

## 3. Render Frontend Services
For the customer and management frontends deployed as Render Static Sites:
| Variable Key | Value |
| :--- | :--- |
| `VITE_API_BASE_URL` | `https://olive-pizza-backend.onrender.com` |
| `VITE_BACKEND_URL` | `https://olive-pizza-backend.onrender.com` |
| `VITE_APP_VERSION` | `2.2.0` |
| `VITE_PHONE_AUTH_MODE` | `production` |
