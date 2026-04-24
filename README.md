# OrderGuard Backend 🛡️

> Multi-tenant SaaS backend for Bangladesh e-commerce **fake order detection**.

Built with **Node.js 20 + Express.js + Prisma + Supabase (PostgreSQL)**, deployable to **Render.com Free Tier**.

---

## Features

- 🔐 **JWT Auth** — Access token (15 min) + Refresh token (30 days)
- 🏢 **Multi-tenant** — Full data isolation via `tenantId` on every query
- 📦 **Order Management** — CRUD + status tracking (PENDING → CONFIRMED / FAKE)
- 📞 **Call Logs** — Manual & Twilio-ready call attempt tracking
- 📧 **Email Parsing** — Bangla/English regex parser for order emails
- 🔒 **Security** — Helmet, CORS, rate limiting (global + auth-specific)
- 🪵 **Logging** — Winston with daily rotation + colorized dev output
- 🚀 **Render Ready** — `render.yaml` with build & start commands

---

## Project Structure

```
orderguard-backend/
├── src/
│   ├── config/           # env, database, constants
│   ├── modules/
│   │   ├── auth/         # register, login, refresh, me
│   │   ├── orders/       # CRUD, status, stats
│   │   ├── tenants/      # settings, users, email config
│   │   ├── calls/        # call log CRUD
│   │   └── email/        # email parse & ingest
│   ├── middlewares/      # auth, tenant-scope, validate, error
│   ├── utils/            # logger, response, crypto, validators
│   └── app.js            # Express entry point
├── prisma/
│   ├── schema.prisma     # All models + enums
│   └── seed.js           # Dev seed data
├── .env.example
├── render.yaml
└── package.json
```

---

## Quick Start

### 1. Clone & Install

```bash
git clone <repo-url>
cd orderguard-backend
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Fill in DATABASE_URL, JWT secrets, ENCRYPTION_KEY
```

Generate secrets:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 3. Run Migrations

```bash
npx prisma migrate dev --name init
npx prisma generate
```

### 4. Seed (Optional)

```bash
npm run seed
# Creates: admin@demo.orderguard.app / Admin@1234
```

### 5. Start Dev Server

```bash
npm run dev
```

---

## API Reference

### Base URL
```
http://localhost:3000/api/v1
```

### Health Check
```
GET /api/v1/health
→ { status, timestamp, version, environment }
```

### Auth
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/auth/register` | ❌ | Register tenant + admin user |
| POST | `/auth/login` | ❌ | Login, returns token pair |
| POST | `/auth/refresh` | ❌ | Refresh access token |
| GET | `/auth/me` | ✅ | Current user profile |
| PATCH | `/auth/fcm-token` | ✅ | Update push token |

### Orders
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/orders` | List (paginated, filterable) |
| GET | `/orders/stats` | Dashboard stats by status |
| POST | `/orders` | Create order |
| GET | `/orders/:id` | Single order + calls |
| PUT | `/orders/:id` | Update order details |
| PATCH | `/orders/:id/status` | Update status/callStatus |
| DELETE | `/orders/:id` | Delete order |

### Tenant
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/tenants/settings` | Get tenant profile |
| PATCH | `/tenants/settings` | Update settings |
| GET | `/tenants/users` | List tenant users |
| POST | `/tenants/users` | Invite user (SUPER_ADMIN) |
| GET/PUT/DELETE | `/tenants/email-config` | Gmail config |

### Calls
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/calls` | List all call logs |
| GET | `/calls/order/:orderId` | Calls for one order |
| POST | `/calls` | Log manual call |
| PATCH | `/calls/:id` | Update call (Twilio webhook) |

### Email
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/email/status` | Email config status |
| POST | `/email/parse` | Parse raw email text |
| POST | `/email/ingest` | Create order from parsed email |
| PATCH | `/email/last-checked` | Update poll timestamp |

---

## Response Format

All endpoints return:

```json
{
  "success": true,
  "message": "Human readable message",
  "data": { ... },
  "meta": { "total": 50, "page": 1, "limit": 20, "totalPages": 3 }
}
```

Errors:
```json
{
  "success": false,
  "message": "Validation failed.",
  "data": null,
  "errors": [{ "field": "email", "message": "Valid email required" }]
}
```

---

## Deploy to Render.com

1. Push code to GitHub
2. Create a **Web Service** in Render → connect repo
3. Render auto-detects `render.yaml` and configures the service
4. Add environment variables in **Environment** tab (see `.env.example`)
5. Deploy!

> **Free tier note**: Service spins down after 15 minutes of inactivity.
> Use [UptimeRobot](https://uptimerobot.com/) to ping `/api/v1/health` every 14 minutes.

---

## Supabase Setup

1. Create a project at [supabase.com](https://supabase.com)
2. Go to **Settings → Database → Connection string → URI**
3. Copy the URI and set it as `DATABASE_URL` in `.env`
4. For production, use the **connection pooler** (port 6543) with `?pgbouncer=true`

---

## Security Considerations

- Gmail app passwords are stored **AES-256-CBC encrypted**
- All tenant queries include `tenantId` filter — no cross-tenant leakage
- Refresh tokens are stateless — implement a token blocklist for logout if needed
- `ENCRYPTION_KEY` must be exactly 32 characters
- Never commit `.env` to git

---

## License

MIT © OrderGuard
