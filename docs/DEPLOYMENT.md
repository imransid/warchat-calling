# Production Deployment Guide

## 📋 Pre-Deployment Checklist

### 1. Environment Configuration

```bash
# Required environment variables
DATABASE_URL="postgresql://..."
APP_URL="https://api.warmchats.com"
NODE_ENV="production"

# Telephony Provider (choose one)
TWILIO_ACCOUNT_SID="..."
TWILIO_AUTH_TOKEN="..."
# OR
TELNYX_API_KEY="..."

# Redis for job queue
REDIS_HOST="..."
REDIS_PORT="6379"
REDIS_PASSWORD="..."

# Security
JWT_SECRET="<strong-random-secret>"

# Monitoring
SENTRY_DSN="..."
```

### 2. Database Setup

```bash
# Run migrations
npx prisma migrate deploy

# Generate Prisma client
npx prisma generate

# Verify connection
npx prisma db pull
```

### 3. Security Configuration

#### Enable Webhook Signature Verification

```typescript
// src/modules/calling/controllers/webhook.controller.ts

import * as twilio from 'twilio';

private verifyTwilioSignature(signature: string, url: string, body: any): boolean {
  const authToken = this.configService.get('TWILIO_AUTH_TOKEN');
  return twilio.validateRequest(authToken, signature, url, body);
}

// In webhook handler:
if (!this.verifyTwilioSignature(
  headers['x-twilio-signature'],
  `${process.env.APP_URL}/webhooks/calling/twilio/status`,
  body
)) {
  throw new UnauthorizedException('Invalid signature');
}
```

#### Enable Rate Limiting

```bash
npm install @nestjs/throttler
```

```typescript
// app.module.ts
import { ThrottlerModule } from '@nestjs/throttler';

@Module({
  imports: [
    ThrottlerModule.forRoot({
      ttl: 60,
      limit: 100, // 100 requests per minute
    }),
  ],
})
```

### 4. Database Indexes

Ensure these indexes exist for performance:

```sql
-- Call queries
CREATE INDEX idx_calls_workspace_created ON calls(workspace_id, created_at DESC);
CREATE INDEX idx_calls_lead_id ON calls(lead_id);
CREATE INDEX idx_calls_agent_id ON calls(agent_id);
CREATE INDEX idx_calls_status ON calls(status);

-- Usage queries
CREATE INDEX idx_usage_workspace_cycle ON usage_records(workspace_id, billing_cycle_id);
CREATE INDEX idx_usage_agent_cycle ON usage_records(agent_id, billing_cycle_id);

-- Webhook processing
CREATE INDEX idx_webhooks_status_retry ON webhook_logs(status, retry_count);
CREATE INDEX idx_webhooks_provider_event ON webhook_logs(provider_event_id);
```

## 🚀 Deployment Options

### Option 1: Docker Deployment

```dockerfile
# Dockerfile
FROM node:18-alpine AS builder

WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:18-alpine AS production

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package*.json ./

EXPOSE 3000

CMD ["npm", "run", "start:prod"]
```

```yaml
# docker-compose.yml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_HOST=redis
      - NODE_ENV=production
    depends_on:
      - postgres
      - redis

  postgres:
    image: postgres:15-alpine
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=warmchats
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=warmchats_calling

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

### Option 2: Heroku Deployment

```bash
# Install Heroku CLI
brew install heroku/brew/heroku

# Login
heroku login

# Create app
heroku create warmchats-calling-api

# Add PostgreSQL
heroku addons:create heroku-postgresql:standard-0

# Add Redis
heroku addons:create heroku-redis:premium-0

# Set environment variables
heroku config:set NODE_ENV=production
heroku config:set TWILIO_ACCOUNT_SID=your_sid
heroku config:set TWILIO_AUTH_TOKEN=your_token

# Deploy
git push heroku main

# Run migrations
heroku run npx prisma migrate deploy
```

### Option 3: AWS ECS/Fargate

```bash
# Build and push Docker image
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com

docker build -t warmchats-calling .
docker tag warmchats-calling:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/warmchats-calling:latest
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/warmchats-calling:latest

# Create ECS task definition and service (via AWS Console or Terraform)
```

### Option 4: Kubernetes

```yaml
# kubernetes/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: warmchats-calling
spec:
  replicas: 3
  selector:
    matchLabels:
      app: warmchats-calling
  template:
    metadata:
      labels:
        app: warmchats-calling
    spec:
      containers:
      - name: app
        image: warmchats/calling:latest
        ports:
        - containerPort: 3000
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: url
        - name: REDIS_HOST
          value: redis-service
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
---
apiVersion: v1
kind: Service
metadata:
  name: warmchats-calling-service
spec:
  selector:
    app: warmchats-calling
  ports:
  - protocol: TCP
    port: 80
    targetPort: 3000
  type: LoadBalancer
```

## 🔧 Post-Deployment Configuration

### 1. Configure Twilio Webhooks

In Twilio Console:
- **Voice URL**: `https://your-app.com/webhooks/calling/twilio/inbound`
- **Status Callback**: `https://your-app.com/webhooks/calling/twilio/status`
- **SMS URL**: `https://your-app.com/webhooks/calling/twilio/sms`

### 2. Configure Telnyx Webhooks

In Telnyx Portal:
- **Webhook URL**: `https://your-app.com/webhooks/calling/telnyx/status`
- **Failover URL**: `https://your-app-backup.com/webhooks/calling/telnyx/status`

### 3. Setup Monitoring

#### Sentry Error Tracking

```typescript
import * as Sentry from '@sentry/node';
import '@sentry/tracing';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  beforeSend(event, hint) {
    // Redact sensitive data
    if (event.request) {
      delete event.request.cookies;
    }
    return event;
  },
});
```

#### Health Check Endpoint

```typescript
@Get('health')
async healthCheck() {
  const dbHealth = await this.prisma.$queryRaw`SELECT 1`;
  const redisHealth = await this.redis.ping();
  
  return {
    status: 'ok',
    database: dbHealth ? 'connected' : 'disconnected',
    redis: redisHealth === 'PONG' ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  };
}
```

### 4. Database Backup

```bash
# Automated daily backups
pg_dump -Fc $DATABASE_URL > backup_$(date +%Y%m%d).dump

# Restore from backup
pg_restore -d $DATABASE_URL backup_20240101.dump
```

## 📊 Performance Optimization

### 1. Connection Pooling

```typescript
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  connection_limit = 20
  pool_timeout = 10
}
```

### 2. Redis Caching

```typescript
// Cache frequent queries
const cacheKey = `usage:${workspaceId}:${billingCycleId}`;
const cached = await this.redis.get(cacheKey);

if (cached) {
  return JSON.parse(cached);
}

const result = await this.queryBus.execute(...);
await this.redis.setex(cacheKey, 300, JSON.stringify(result)); // 5 min cache
```

### 3. Database Query Optimization

```typescript
// Use select to fetch only needed fields
const calls = await this.prisma.call.findMany({
  select: {
    id: true,
    status: true,
    duration: true,
    createdAt: true,
  },
  where: { workspaceId },
  take: 100,
});
```

## 🔐 Security Best Practices

1. **Encrypt Sensitive Data**: Store provider credentials encrypted
2. **API Rate Limiting**: Implement per-user rate limits
3. **Webhook Validation**: Always verify provider signatures
4. **Audit Logging**: Log all PII access
5. **HTTPS Only**: Enforce SSL/TLS for all connections
6. **IP Whitelisting**: Restrict admin endpoints
7. **Regular Updates**: Keep dependencies updated

## 📈 Monitoring & Alerts

### Key Metrics to Monitor

- **Call Success Rate** (target: >95%)
- **Webhook Processing Latency** (target: <500ms)
- **Database Connection Pool** (alert if >80% used)
- **Redis Memory Usage** (alert if >75% used)
- **Provider API Errors** (alert on spike)
- **Usage Limit Violations** (alert immediately)

### Alerting Setup

```typescript
// Example: PagerDuty integration
if (successRate < 0.95) {
  await this.pagerduty.trigger({
    severity: 'error',
    summary: 'Call success rate below threshold',
    details: { successRate, threshold: 0.95 },
  });
}
```

## 🔄 Rollback Plan

```bash
# Revert to previous deployment
kubectl rollout undo deployment/warmchats-calling

# Revert database migration
npx prisma migrate resolve --rolled-back <migration-name>

# Verify rollback
curl https://your-app.com/health
```

## 📞 Support & Troubleshooting

### Common Issues

**Issue**: Webhooks timing out
**Solution**: Check webhook URL accessibility, verify firewall rules

**Issue**: High database load
**Solution**: Add indexes, implement caching, increase connection pool

**Issue**: Call quality issues
**Solution**: Check provider status, verify network latency

---

**Production Deployment Checklist:**
- [ ] Environment variables configured
- [ ] Database migrations applied
- [ ] Webhook URLs configured in provider
- [ ] Security headers enabled
- [ ] Rate limiting active
- [ ] Monitoring/alerting setup
- [ ] Backup strategy implemented
- [ ] Load testing completed
- [ ] Rollback plan documented
- [ ] Team trained on operations
