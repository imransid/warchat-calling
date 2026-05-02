# 📚 WarmChats Calling API - Complete Documentation

## 🚀 Quick Start

### Access Swagger UI
```
http://localhost:3000/api/docs
```

### Get OpenAPI Specification
```
http://localhost:3000/api/docs-json
```

## 🔐 Authentication

All API endpoints (except webhooks) require JWT Bearer token authentication.

### Headers
```
Authorization: Bearer <your-jwt-token>
Content-Type: application/json
```

### Example Request
```bash
curl -X POST http://localhost:3000/api/calling/calls/outbound \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{
    "leadId": "123e4567-e89b-12d3-a456-426614174000",
    "metadata": {
      "campaign": "Q4-Sales"
    }
  }'
```

## 📍 API Endpoints

### **Calling Endpoints** (`/api/calling`)

---

#### **POST** `/api/calling/calls/outbound`
**Initiate an outbound call**

**Request Body:**
```json
{
  "leadId": "123e4567-e89b-12d3-a456-426614174000",
  "metadata": {
    "campaign": "Q4-Sales",
    "source": "website"
  }
}
```

**Success Response (200):**
```json
{
  "callId": "call-789",
  "status": "INITIATED",
  "providerCallSid": "CA1234567890abcdef"
}
```

**Error Responses:**
- **400 Bad Request**: Invalid lead ID
- **403 Forbidden**: No assigned number, plan disabled, or usage limit exceeded
- **401 Unauthorized**: Invalid/missing token

**cURL Example:**
```bash
curl -X POST http://localhost:3000/api/calling/calls/outbound \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "leadId": "123e4567-e89b-12d3-a456-426614174000"
  }'
```

---

#### **GET** `/api/calling/calls/:callId`
**Get call details by ID**

**URL Parameters:**
- `callId` (required): UUID of the call

**Success Response (200):**
```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "direction": "OUTBOUND",
  "status": "COMPLETED",
  "fromNumber": "+14155559999",
  "toNumber": "+14155555678",
  "duration": 185,
  "initiatedAt": "2024-01-15T10:30:00Z",
  "answeredAt": "2024-01-15T10:30:05Z",
  "completedAt": "2024-01-15T10:33:05Z",
  "lead": {
    "id": "lead-123",
    "name": "Jane Smith",
    "phoneNumber": "+14155555678"
  },
  "agent": {
    "id": "agent-456",
    "name": "John Doe",
    "email": "john@warmchats.com"
  },
  "callEvents": [
    {
      "eventType": "CALL_INITIATED",
      "timestamp": "2024-01-15T10:30:00Z"
    },
    {
      "eventType": "AGENT_ANSWERED",
      "timestamp": "2024-01-15T10:30:05Z"
    },
    {
      "eventType": "CALL_COMPLETED",
      "timestamp": "2024-01-15T10:33:05Z"
    }
  ]
}
```

**cURL Example:**
```bash
curl -X GET http://localhost:3000/api/calling/calls/123e4567-e89b-12d3-a456-426614174000 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

#### **GET** `/api/calling/leads/:leadId/calls`
**Get call history for a lead**

**URL Parameters:**
- `leadId` (required): UUID of the lead

**Query Parameters:**
- `limit` (optional): Number of records (1-100, default: 50)
- `offset` (optional): Pagination offset (default: 0)

**Success Response (200):**
```json
{
  "calls": [
    {
      "id": "call-1",
      "direction": "OUTBOUND",
      "status": "COMPLETED",
      "duration": 185,
      "initiatedAt": "2024-01-15T10:30:00Z",
      "agent": {
        "id": "agent-456",
        "name": "John Doe"
      }
    }
  ],
  "total": 25,
  "limit": 50,
  "offset": 0
}
```

**cURL Example:**
```bash
curl -X GET "http://localhost:3000/api/calling/leads/lead-123/calls?limit=20&offset=0" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

#### **GET** `/api/calling/usage/workspace`
**Get usage statistics**

**Query Parameters:**
- `billingCycleId` (optional): Specific billing cycle ID

**Success Response (200):**
```json
{
  "billingCycle": {
    "id": "cycle-123",
    "startDate": "2024-01-01T00:00:00Z",
    "endDate": "2024-01-31T23:59:59Z",
    "planLimit": 1000
  },
  "usage": {
    "totalMinutes": 487.5,
    "totalCost": 0.00,
    "totalCalls": 142,
    "percentageUsed": 48.75,
    "remainingMinutes": 512.5,
    "isOverLimit": false
  },
  "breakdown": {
    "byStatus": {
      "COMPLETED": 120,
      "NO_ANSWER": 15,
      "BUSY": 5,
      "FAILED": 2
    }
  }
}
```

**cURL Example:**
```bash
curl -X GET http://localhost:3000/api/calling/usage/workspace \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

#### **GET** `/api/calling/analytics/dashboard`
**Get dashboard analytics**

**Query Parameters:**
- `startDate` (optional): Start date (ISO 8601)
- `endDate` (optional): End date (ISO 8601)

**Success Response (200):**
```json
{
  "totalCalls": 487,
  "byDirection": {
    "INBOUND": 234,
    "OUTBOUND": 253
  },
  "byStatus": [
    {
      "status": "COMPLETED",
      "count": 412,
      "avgDuration": 187
    },
    {
      "status": "NO_ANSWER",
      "count": 52,
      "avgDuration": 0
    }
  ],
  "avgDuration": 154,
  "answerRate": 84.6,
  "topAgents": [
    {
      "agentId": "agent-123",
      "callCount": 89
    }
  ]
}
```

**cURL Example:**
```bash
curl -X GET "http://localhost:3000/api/calling/analytics/dashboard?startDate=2024-01-01T00:00:00Z" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

#### **GET** `/api/calling/can-call`
**Check if user can make calls**

**Success Response (200):**
```json
{
  "canCall": true,
  "reasons": []
}
```

**OR (if not allowed):**
```json
{
  "canCall": false,
  "reasons": [
    "User does not have an assigned business number",
    "Monthly calling limit exceeded"
  ]
}
```

**cURL Example:**
```bash
curl -X GET http://localhost:3000/api/calling/can-call \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

### **Admin Endpoints** (`/api/admin/calling`)

---

#### **POST** `/api/admin/calling/phone-numbers`
**Provision a new phone number**

**Request Body:**
```json
{
  "areaCode": "415",
  "country": "US"
}
```

**Success Response (201):**
```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "phoneNumber": "+14155551234",
  "provider": "twilio",
  "providerSid": "PN1234567890abcdef",
  "status": "ACTIVE",
  "capabilities": {
    "voice": true,
    "sms": true
  }
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:3000/api/admin/calling/phone-numbers \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "areaCode": "415",
    "country": "US"
  }'
```

---

#### **GET** `/api/admin/calling/phone-numbers`
**List all phone numbers**

**Query Parameters:**
- `includeReleased` (optional): Include released numbers (default: false)

**Success Response (200):**
```json
[
  {
    "id": "number-123",
    "phoneNumber": "+14155551234",
    "provider": "twilio",
    "status": "ACTIVE",
    "assignedToUser": {
      "id": "user-123",
      "name": "John Doe",
      "email": "john@warmchats.com"
    },
    "createdAt": "2024-01-01T00:00:00Z"
  }
]
```

**cURL Example:**
```bash
curl -X GET "http://localhost:3000/api/admin/calling/phone-numbers?includeReleased=false" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

#### **PUT** `/api/admin/calling/phone-numbers/:phoneNumberId/assign`
**Assign phone number to agent**

**URL Parameters:**
- `phoneNumberId` (required): Phone number ID to assign

**Request Body:**
```json
{
  "userId": "user-456"
}
```

**Success Response (200):**
```json
{
  "phoneNumberId": "number-123",
  "userId": "user-456",
  "message": "Phone number assigned successfully"
}
```

**cURL Example:**
```bash
curl -X PUT http://localhost:3000/api/admin/calling/phone-numbers/number-123/assign \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-456"
  }'
```

---

#### **DELETE** `/api/admin/calling/phone-numbers/:phoneNumberId`
**Release phone number**

**URL Parameters:**
- `phoneNumberId` (required): Phone number ID to release

**Query Parameters:**
- `reason` (optional): Reason for release

**Success Response (200):**
```json
{
  "phoneNumberId": "number-123",
  "message": "Phone number released successfully"
}
```

**cURL Example:**
```bash
curl -X DELETE "http://localhost:3000/api/admin/calling/phone-numbers/number-123?reason=Agent%20left%20company" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

#### **GET** `/api/admin/calling/configuration`
**Get calling configuration**

**Success Response (200):**
```json
{
  "id": "config-123",
  "workspaceId": "workspace-456",
  "provider": "twilio",
  "ringTimeout": 25,
  "missedCallSmsTemplate": "Hi! I missed your call. I'll get back to you shortly.",
  "callingEnabled": true,
  "recordingEnabled": false,
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-15T10:30:00Z"
}
```

**cURL Example:**
```bash
curl -X GET http://localhost:3000/api/admin/calling/configuration \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

#### **PUT** `/api/admin/calling/configuration`
**Update calling configuration**

**Request Body:**
```json
{
  "ringTimeout": 30,
  "missedCallSmsTemplate": "Sorry I missed your call! Will call you back soon.",
  "callingEnabled": true,
  "recordingEnabled": false
}
```

**Success Response (200):**
```json
{
  "message": "Configuration updated successfully",
  "ringTimeout": 30,
  "missedCallSmsTemplate": "Sorry I missed your call! Will call you back soon.",
  "callingEnabled": true,
  "recordingEnabled": false
}
```

**cURL Example:**
```bash
curl -X PUT http://localhost:3000/api/admin/calling/configuration \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ringTimeout": 30,
    "missedCallSmsTemplate": "Sorry I missed your call!"
  }'
```

---

### **Webhook Endpoints** (No Authentication Required)

These endpoints are called by telephony providers (Twilio/Telnyx) and use signature verification for security.

#### **POST** `/webhooks/calling/twilio/status`
**Twilio status callback**

Called by Twilio when call status changes.

#### **POST** `/webhooks/calling/twilio/inbound`
**Twilio inbound call**

Called by Twilio when a customer dials the business number.

#### **POST** `/webhooks/calling/telnyx/status`
**Telnyx status callback**

Called by Telnyx when call status changes.

#### **POST** `/webhooks/calling/telnyx/inbound`
**Telnyx inbound call**

Called by Telnyx when a customer dials the business number.

---

## 📊 Response Codes

| Code | Description |
|------|-------------|
| 200  | Success |
| 201  | Created |
| 400  | Bad Request - Invalid input |
| 401  | Unauthorized - Invalid/missing token |
| 403  | Forbidden - Action not allowed |
| 404  | Not Found - Resource doesn't exist |
| 429  | Too Many Requests - Rate limit exceeded |
| 500  | Internal Server Error |

---

## 🔄 Call Status Values

| Status | Description |
|--------|-------------|
| INITIATED | Call has been initiated |
| RINGING | Phone is ringing |
| IN_PROGRESS | Call is active |
| COMPLETED | Call ended successfully |
| NO_ANSWER | Call was not answered |
| BUSY | Line was busy |
| FAILED | Call failed to connect |
| CANCELED | Call was canceled |

---

## 🎯 Best Practices

### 1. **Always Check Capabilities First**
```javascript
const canCall = await fetch('/api/calling/can-call');
if (canCall.canCall) {
  // Initiate call
}
```

### 2. **Handle Errors Gracefully**
```javascript
try {
  const response = await fetch('/api/calling/calls/outbound', {
    method: 'POST',
    body: JSON.stringify({ leadId }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    console.error(error.message);
  }
} catch (error) {
  console.error('Network error:', error);
}
```

### 3. **Implement Retry Logic**
```javascript
async function initiateCallWithRetry(leadId, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await initiateCall(leadId);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}
```

### 4. **Monitor Usage**
```javascript
// Check usage regularly
const usage = await fetch('/api/calling/usage/workspace');
if (usage.percentageUsed > 80) {
  alert('Approaching usage limit!');
}
```

---

## 🧪 Testing with Swagger UI

1. Navigate to `http://localhost:3000/api/docs`
2. Click **Authorize** button
3. Enter your JWT token
4. Select an endpoint to test
5. Click **Try it out**
6. Fill in parameters
7. Click **Execute**
8. View response

---

## 📞 Support

For API issues or questions:
- Email: support@warmchats.com
- Documentation: https://docs.warmchats.com
- GitHub Issues: https://github.com/warmchats/calling-module

---

**Last Updated**: 2024-01-15
**API Version**: 1.0.0
