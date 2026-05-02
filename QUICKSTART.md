# 🚀 Quick Start Guide

Get up and running in **5 minutes**.

## Prerequisites

- Node.js 18 or higher
- PostgreSQL 14+ running
- Redis 6+ running
- Telnyx account with API credentials

## Step 1: Install Dependencies

```bash
npm install
```

## Step 2: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
DATABASE_URL="postgresql://user:password@localhost:5432/warmchats"

# Your Telnyx Credentials (get from portal.telnyx.com)
TELNYX_API_KEY=YOUR_API_KEY
TELNYX_CONNECTION_ID=YOUR_CONNECTION_ID
TELNYX_MESSAGING_PROFILE_ID=YOUR_PROFILE_ID

REDIS_HOST=localhost
REDIS_PORT=6379

JWT_SECRET=your_secret_key_here
```

## Step 3: Setup Database

```bash
# Generate Prisma client
npx prisma generate

# Run migrations
npx prisma migrate dev --name init
```

## Step 4: Start Server

```bash
# Development mode
npm run start:dev

# OR Production mode
npm run build
npm run start:prod
```

## Step 5: Test It!

### Open Swagger UI
```
http://localhost:3000/api/docs
```

### Health Check
```bash
curl http://localhost:3000/health
```

### Make a Test Call (via API)
```bash
curl -X POST http://localhost:3000/api/calling/calls/outbound \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "leadId": "lead-uuid-here"
  }'
```

## ✅ Verification Checklist

- [ ] Server starts without errors
- [ ] Database connection successful
- [ ] Redis connection successful
- [ ] Swagger UI loads at `/api/docs`
- [ ] Health check returns 200 OK
- [ ] Telnyx credentials configured

## 🐛 Troubleshooting

### Database Connection Error
```bash
# Check PostgreSQL is running
psql -U postgres -c "SELECT version();"

# Check DATABASE_URL format
echo $DATABASE_URL
```

### Prisma Issues
```bash
# Reset and regenerate
npx prisma generate
npx prisma migrate reset
npx prisma migrate dev
```

### Redis Connection
```bash
# Check Redis is running
redis-cli ping
# Should return: PONG
```

### Port Already in Use
```bash
# Find what's using port 3000
lsof -i :3000

# Or change port in .env
PORT=3001
```

## 📚 Next Steps

1. Read `docs/CLIENT_SETUP_GUIDE.md` for Telnyx setup
2. Read `docs/API_DOCUMENTATION.md` for endpoint details
3. Read `docs/DEPLOYMENT.md` for production deployment
4. Configure webhooks in Telnyx portal

## 🔗 Useful Commands

```bash
# Format code
npm run format

# Lint code
npm run lint

# Run tests
npm run test

# View database in Prisma Studio
npx prisma studio

# Generate types after schema changes
npx prisma generate
```

## 📞 Need Help?

- See `README.md` for full documentation
- See `docs/` folder for detailed guides
- Contact: Sarwar Alam (backend) or Sabbir (frontend)

---

**Ready to make calls!** 🎉
