# 🚀 WarmChats Calling Module

Production-ready NestJS calling module with **CQRS pattern**, **Prisma ORM**, **PostgreSQL**, and **Telnyx** provider integration.

## ✅ Features (All Client Requirements Implemented)

- ✅ **Click-to-Call (Outbound)** - Agent-first dial flow
- ✅ **Inbound Forwarding** - 25-second timeout (client-configured)
- ✅ **Number Masking** - Customer sees business number only
- ✅ **Call Logging** - Complete audit trail in conversation thread
- ✅ **Auto-Charge Overage** - Calls never blocked, auto-charge at $0.02/min
- ✅ **Custom Missed-Call SMS** - Client's exact wording
- ✅ **Telnyx Provider** - Primary (Twilio optional)
- ✅ **Usage Dashboard** - Clear overage display
- ✅ **Admin Interface** - Phone number & config management
- ✅ **Swagger Documentation** - Interactive API docs


ngrok http 3000

## 🏗️ Architecture

- **CQRS Pattern** - Commands (writes) + Queries (reads) + Events
- **Event Sourcing** - Complete call lifecycle tracking
- **Provider Abstraction** - Easy switch between Telnyx/Twilio
- **Idempotent Webhooks** - Duplicate prevention
- **Production-Ready** - Error handling, retry logic, monitoring

## 📦 Installation

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- Redis 6+
- Telnyx account credentials

### Setup Steps

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your Telnyx credentials

# 3. Setup database
npx prisma generate
npx prisma migrate dev

# 4. Start development server
npm run start:dev
```

### Access Points

- **API**: http://localhost:3000/api
- **Swagger UI**: http://localhost:3000/api/docs
- **Health Check**: http://localhost:3000/health

## 🎯 Client Configuration

The system is pre-configured with client requirements from Discord (April 28, 2026):

```typescript
{
  provider: "telnyx",                  // ✅ Telnyx only
  ringTimeout: 25,                     // ✅ 25 seconds
  autoChargeOverage: true,             // ✅ Auto-charge enabled
  missedCallSmsTemplate: 
    "Currently in an appointment. I will call you back shortly or text me please."
                                       // ✅ Client's exact wording
}
```

## 📁 Project Structure

```
warmchats-calling/
├── prisma/
│   └── schema.prisma              # Database schema
├── src/
│   ├── modules/calling/
│   │   ├── commands/              # CQRS Commands (writes)
│   │   │   ├── impl/              # Command definitions
│   │   │   └── handlers/          # Business logic
│   │   ├── queries/               # CQRS Queries (reads)
│   │   │   ├── impl/              # Query definitions
│   │   │   └── handlers/          # Data retrieval
│   │   ├── events/                # Domain events
│   │   ├── controllers/
│   │   │   ├── calling.controller.ts    # Main API
│   │   │   ├── admin.controller.ts      # Admin API
│   │   │   └── webhook.controller.ts    # Webhooks
│   │   ├── infrastructure/
│   │   │   └── telephony/         # Provider implementations
│   │   ├── dto/                   # Data transfer objects
│   │   ├── __tests__/             # Unit tests
│   │   └── calling.module.ts      # Module definition
│   ├── shared/
│   │   └── database/              # Prisma service
│   ├── config/
│   │   └── swagger.config.ts      # API documentation
│   ├── app.module.ts              # Root module
│   └── main.ts                    # Entry point
├── docs/
│   ├── CLIENT_SETUP_GUIDE.md      # Client setup
│   ├── CLIENT_CHANGELOG.md        # Change log
│   ├── API_DOCUMENTATION.md       # API reference
│   ├── DEPLOYMENT.md              # Production guide
│   └── ARCHITECTURE.md            # Architecture docs
├── package.json
├── tsconfig.json
├── nest-cli.json
└── .env.example
```

## 🔧 Telnyx Setup (Client Requirement)

### Get Your Credentials

1. Login to https://portal.telnyx.com
2. Get **API Key** from API Keys section
3. Get **Connection ID** from Voice → Connections
4. Get **Messaging Profile ID** (already have for SMS)

### Configure Webhook

Set webhook URL in Telnyx portal:
```
https://your-app.com/webhooks/calling/telnyx/status
```

Enable events:
- `call.initiated`
- `call.answered`
- `call.hangup`

## 📞 API Endpoints

### Calling API
```
POST   /api/calling/calls/outbound       Initiate call
GET    /api/calling/calls/:callId        Get call details
GET    /api/calling/leads/:leadId/calls  Call history
GET    /api/calling/usage/workspace      Usage stats
GET    /api/calling/analytics/dashboard  Dashboard
GET    /api/calling/can-call             Capability check
```

### Admin API
```
POST   /api/admin/calling/phone-numbers           Provision number
GET    /api/admin/calling/phone-numbers           List numbers
PUT    /api/admin/calling/phone-numbers/:id/assign  Assign number
DELETE /api/admin/calling/phone-numbers/:id       Release number
GET    /api/admin/calling/configuration           Get config
PUT    /api/admin/calling/configuration           Update config
```

### Webhook Endpoints
```
POST   /webhooks/calling/telnyx/status    Status callbacks
POST   /webhooks/calling/telnyx/inbound   Inbound calls
POST   /webhooks/calling/twilio/status    (Optional)
POST   /webhooks/calling/twilio/inbound   (Optional)
```

## 🧪 Testing

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Coverage
npm run test:cov
```

## 🚀 Deployment

See `docs/DEPLOYMENT.md` for complete production deployment guide.

### Docker

```bash
docker build -t warmchats-calling .
docker run -p 3000:3000 warmchats-calling
```

### Environment Variables

Required in production:
- `DATABASE_URL`
- `TELNYX_API_KEY`
- `TELNYX_CONNECTION_ID`
- `TELNYX_MESSAGING_PROFILE_ID`
- `REDIS_HOST`
- `JWT_SECRET`

## 📚 Documentation

- **CLIENT_SETUP_GUIDE.md** - Setup with your Telnyx account
- **CLIENT_CHANGELOG.md** - All changes from client feedback
- **API_DOCUMENTATION.md** - Complete API reference
- **DEPLOYMENT.md** - Production deployment
- **ARCHITECTURE.md** - Design patterns & decisions

## 🔐 Security

- ✅ JWT Bearer authentication
- ✅ Webhook signature verification
- ✅ Idempotency protection
- ✅ Encrypted credentials storage
- ✅ Rate limiting ready
- ✅ CORS configuration
- ✅ Helmet security headers

## 📞 Support

- **Backend**: Sarwar Alam
- **Frontend**: Sabbir
- **Setup**: See `docs/CLIENT_SETUP_GUIDE.md`

## 📄 License

MIT License - See LICENSE file

---

**Built with ❤️ using NestJS + CQRS + Prisma + PostgreSQL + Telnyx**

**Version**: 1.0.0  
**Last Updated**: May 1, 2026
