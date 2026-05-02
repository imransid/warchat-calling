# 🎯 WarmChats Calling - Client Setup Guide (Telnyx)

## 📋 Client Requirements (From Discord - April 28, 2026)

Based on your feedback in the Discord channel, here's your customized setup:

### ✅ Your Confirmed Requirements

1. **Provider**: Telnyx ONLY (you already have Telnyx for SMS)
2. **Overage Handling**: Auto-charge overage (don't block calls)
3. **Ring Timeout**: 25 seconds
4. **Missed-Call SMS**: "Currently in an appointment. I will call you back shortly or text me please."
5. **Account Ownership**: You own the Telnyx account, we integrate it

---

## 🚀 Quick Setup (5 Steps)

### Step 1: Get Your Telnyx Credentials

Since you already have Telnyx for SMS, you'll need:

```
1. Login to: https://portal.telnyx.com
2. Go to: API Keys (left sidebar)
3. Copy:
   - API Key (starts with "KEY...")
   - Connection ID (for voice calls)
   - Messaging Profile ID (you already have this for SMS)
```

### Step 2: Configure Environment

Create `.env` file with YOUR Telnyx credentials:

```env
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/warmchats"

# Telnyx (YOUR account - you own this)
TELNYX_API_KEY="YOUR_API_KEY_HERE"
TELNYX_CONNECTION_ID="YOUR_CONNECTION_ID_HERE"
TELNYX_MESSAGING_PROFILE_ID="YOUR_MESSAGING_PROFILE_ID_HERE"

# Application
APP_URL="https://your-app.com"
NODE_ENV="production"

# Redis
REDIS_HOST="localhost"
REDIS_PORT="6379"
```

### Step 3: Configure Telnyx Webhooks

In your Telnyx Portal:

1. **Go to**: Voice → Connections → Your Connection
2. **Set Webhook URL**: `https://your-app.com/webhooks/calling/telnyx/status`
3. **Enable Events**:
   - `call.initiated`
   - `call.answered`
   - `call.hangup`
   - `call.machine.detection.ended`

### Step 4: Workspace Configuration

The system will auto-configure with YOUR settings:

```typescript
// Auto-configured based on your requirements
{
  provider: "telnyx",              // Telnyx only
  ringTimeout: 25,                  // 25 seconds (your requirement)
  missedCallSmsTemplate: "Currently in an appointment. I will call you back shortly or text me please.",
  autoChargeOverage: true,          // Auto-charge, don't block
  callingEnabled: true
}
```

### Step 5: Assign Phone Numbers

You already have Telnyx numbers for SMS. To use them for calling:

```bash
# API call to assign number to agent
POST /api/admin/calling/phone-numbers/:phoneNumberId/assign
{
  "userId": "agent-sarah-id"
}
```

---

## 💰 Overage Handling (Your Requirement)

### How Auto-Charge Works

```
Plan: 1000 minutes/month
Current usage: 950 minutes
New call: 75 minutes

┌─────────────────────────────────────┐
│ BEFORE (Block Mode - NOT your setup)│
├─────────────────────────────────────┤
│ ❌ Call blocked                     │
│ "Monthly limit exceeded"            │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ AFTER (Auto-Charge - YOUR setup)    │
├─────────────────────────────────────┤
│ ✅ Call proceeds                    │
│ Included: 50 minutes (free)         │
│ Overage: 25 minutes × $0.02 = $0.50 │
│ Auto-charged to your Telnyx account │
└─────────────────────────────────────┘
```

### Dashboard Display

**Usage Stats (visible to you and agents):**
```
Plan: 1000 minutes
Used: 1025 minutes (102.5%)

Breakdown:
- Included: 1000 minutes ($0.00)
- Overage: 25 minutes ($0.50)
- Total Cost: $0.50
```

**Status Color:**
- 0-80%: Green
- 81-100%: Yellow
- 100%+: Orange (but calls still work!)

---

## 📞 Call Flow (With Your Settings)

### Outbound Call

```
1. Agent clicks "Call"
   ↓
2. System checks:
   ✓ Agent has assigned number
   ✓ Calling enabled
   ✓ Auto-charge enabled (no blocking!)
   ↓
3. Telnyx calls agent first
   Agent's phone rings (25 second timeout)
   ↓
4. Agent answers
   ↓
5. Telnyx bridges customer
   Customer sees: YOUR business number
   ↓
6. Call logged + usage tracked
```

### Inbound Call (Missed)

```
1. Customer calls business number
   ↓
2. Forward to agent (25 second timeout)
   ↓
3. No answer after 25 seconds
   ↓
4. Auto-SMS sent:
   "Currently in an appointment. I will 
    call you back shortly or text me please."
   ↓
5. Call logged as MISSED
```

---

## 🔧 Account Integration

### Your Account, Our Integration

**What you own:**
- ✅ Telnyx account credentials
- ✅ Phone numbers
- ✅ Usage costs (billed by Telnyx)
- ✅ Account control

**What we provide:**
- ✅ Integration code
- ✅ Webhook handling
- ✅ Call logging
- ✅ Usage dashboard
- ✅ Number management UI

### Billing Flow

```
┌──────────────────────────────────────┐
│ Your Telnyx Account                  │
│ - You pay Telnyx directly            │
│ - Charges: minutes + SMS             │
│ - Your billing dashboard: portal.telnyx.com
└──────────────────────────────────────┘
          ↓
┌──────────────────────────────────────┐
│ WarmChats System                     │
│ - Tracks usage for reporting         │
│ - Shows usage to agents               │
│ - Enforces soft limits (with overage)│
│ - Does NOT charge you                │
└──────────────────────────────────────┘
```

---

## 📊 Admin Dashboard Features

### Usage Overview (Visible to You)

```
Current Cycle: January 2026
Plan: 1000 minutes

┌─────────────────────────────────────┐
│ Total Usage: 1025 minutes (102.5%) │
│                                     │
│ Included: 1000 min        $0.00     │
│ Overage:  25 min × $0.02  $0.50     │
│ ─────────────────────────            │
│ Total Cost:               $0.50     │
└─────────────────────────────────────┘

By Agent:
- Sarah:  425 min (15 overage)  $0.30
- John:   350 min (0 overage)   $0.00
- Mike:   250 min (10 overage)  $0.20

By Status:
- Completed: 920 calls
- Missed:    82 calls
- Failed:    23 calls
```

### Configuration Panel

```
Provider: Telnyx ✓
Ring Timeout: 25 seconds
Auto-Charge Overage: Enabled ✓

Missed-Call SMS:
"Currently in an appointment. I will call 
 you back shortly or text me please."

[Save Configuration]
```

---

## 🔒 Security & Access

### Your Credentials (Secure Storage)

```typescript
// Stored encrypted in database
{
  provider: "telnyx",
  providerAccountSid: "ENCRYPTED_API_KEY",
  providerAuthToken: "ENCRYPTED_SECRET"
}
```

**Access Control:**
- Only workspace owner can modify
- Credentials encrypted at rest
- Never exposed in logs
- Webhook signatures verified

---

## 📈 Usage Tracking

### Real-Time Dashboard

**For Agents (Limited View):**
```
My Usage This Month:
425 / 1000 minutes (42.5%)
Remaining: 575 minutes
```

**For You (Full View):**
```
Workspace Usage:
1025 / 1000 minutes (102.5%)

Cost Breakdown:
- Base Plan: $29/month (1000 min)
- Overage: $0.50 (25 min × $0.02)
- Total: $29.50

Export Report [CSV] [PDF]
```

---

## 🎯 API Endpoints (For You)

### Check Usage
```bash
GET /api/calling/usage/workspace
Authorization: Bearer YOUR_TOKEN

Response:
{
  "totalMinutes": 1025,
  "planLimit": 1000,
  "overage": 25,
  "overageCost": 0.50,
  "percentageUsed": 102.5,
  "autoChargeEnabled": true
}
```

### Update Configuration
```bash
PUT /api/admin/calling/configuration
Authorization: Bearer YOUR_TOKEN

{
  "ringTimeout": 25,
  "missedCallSmsTemplate": "Your custom message",
  "autoChargeOverage": true
}
```

### View Overage Charges
```bash
GET /api/admin/calling/usage/breakdown?groupBy=agent
Authorization: Bearer YOUR_TOKEN

Response:
[
  {
    "agentId": "sarah",
    "totalMinutes": 425,
    "overageMinutes": 15,
    "overageCost": 0.30
  }
]
```

---

## ✅ Verification Checklist

After setup, verify:

```
□ Telnyx webhook configured
□ Test outbound call works
□ Agent's phone rings first ✓
□ Customer sees business number ✓
□ Test inbound call forwarding
□ 25 second timeout works ✓
□ Missed-call SMS received ✓
  (With your custom message)
□ Call logged in conversation ✓
□ Usage dashboard shows data ✓
□ Overage calculation correct ✓
□ Auto-charge allows calls over limit ✓
```

---

## 🚨 Important Notes

### About Overage Auto-Charge

⚠️ **This setting means:**
- Calls will NEVER be blocked due to usage limits
- System will auto-charge at $0.02/minute for overage
- YOU are responsible for Telnyx billing
- Dashboard shows usage clearly to prevent surprises

💡 **Recommendation:**
Set up email alerts when usage reaches:
- 80% of plan
- 100% of plan (entering overage)
- Every 100 overage minutes

### About Your Account

✅ **You maintain control:**
- Login to Telnyx portal anytime
- View real-time usage
- Manage numbers
- Update payment method
- Download invoices

🔗 **We integrate:**
- No access to your billing
- No charges from us
- Pure integration service
- You see same data in both systems

---

## 📞 Support

**Technical Issues:**
- Backend: Sarwar Alam
- Frontend: Sabbir
- Integration: Team

**Telnyx Account Issues:**
- Direct: support@telnyx.com
- Portal: https://portal.telnyx.com
- Your account, your control

---

## 🎉 You're Ready!

Your setup is configured exactly as requested:
- ✅ Telnyx only (no Twilio)
- ✅ 25 second ring timeout
- ✅ Your custom missed-call SMS
- ✅ Auto-charge overage (no blocking)
- ✅ You own the account
- ✅ Clear usage dashboard

**Next:** Team will connect the frontend API and you're live!

---

**Configuration Updated**: May 1, 2026
**Based On**: Discord conversation (joseph-team channel)
**Your Account**: Telnyx (client-owned)
