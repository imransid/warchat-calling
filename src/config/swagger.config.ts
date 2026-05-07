import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { INestApplication } from '@nestjs/common';

export class SwaggerConfig {
  static setup(app: INestApplication): void {
    const config = new DocumentBuilder()
      .setTitle('WarmChats Calling API')
      .setDescription(`
# WarmChats Calling Module API Documentation

## Overview
Complete click-to-call, call forwarding, and number masking solution with CQRS architecture.

## Features
- **Click-to-Call**: Agent-first dial flow for outbound calls
- **Inbound Forwarding**: Automatic call routing with 20-30s timeout
- **Number Masking**: Customer sees business number only
- **Usage Metering**: Track minutes, enforce plan limits
- **Call Logging**: Complete audit trail in conversation thread
- **Analytics**: Dashboard stats and reporting

## Authentication
All endpoints (except webhooks) require Bearer token authentication.

Include the token in the Authorization header:
\`\`\`
Authorization: Bearer <your-jwt-token>
\`\`\`

## Rate Limiting
- **Standard endpoints**: 100 requests/minute per user
- **Webhook endpoints**: No rate limit (provider-verified)

## Webhooks
Webhook endpoints are called by Telnyx and do not require authentication.
They use signature verification for security.

## Error Handling
All errors follow the standard format:
\`\`\`json
{
  "statusCode": 400,
  "message": "Error description",
  "error": "Bad Request"
}
\`\`\`

## Call Flow

### Outbound Call
1. Agent clicks "Call" button → \`POST /api/calling/calls/outbound\`
2. System validates safeguards (number, plan, limits)
3. System calls agent's real phone first
4. Agent answers → system bridges customer
5. Customer sees business number as caller ID
6. Status updates via webhooks
7. Call logged in conversation thread

### Inbound Call
1. Customer dials business number
2. Provider webhook → \`POST /webhooks/calling/[provider]/inbound\`
3. System forwards to agent (20-30s timeout)
4. Agent answers → call connects
5. OR: No answer → auto SMS sent to customer
6. Call logged with full metadata

## Pagination
List endpoints support pagination via \`limit\` and \`offset\` query parameters:
- \`limit\`: Number of records (1-100, default: 50)
- \`offset\`: Starting position (default: 0)

## Date Formats
All dates use ISO 8601 format: \`2024-01-15T10:30:00Z\`

## Support
For issues or questions, contact: support@warmchats.com
      `)
      .setVersion('1.0.0')
      .setContact(
        'WarmChats Support',
        'https://warmchats.com',
        'support@warmchats.com'
      )
      .setLicense('MIT', 'https://opensource.org/licenses/MIT')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          name: 'Authorization',
          description: 'Enter JWT token',
          in: 'header',
        },
        'JWT-auth'
      )
      .addTag('calling', 'Call management endpoints - Initiate calls, retrieve history, check capabilities')
      .addTag('admin', 'Administration endpoints - Manage phone numbers, configuration, and usage limits')
      .addTag('webhooks', 'Webhook endpoints - Called by Telnyx')
      .addTag('analytics', 'Analytics endpoints - Dashboard stats, usage reports, performance metrics')
      .addServer('http://localhost:3000', 'Local Development')
      .addServer('https://api-staging.warmchats.com', 'Staging')
      .addServer('https://api.warmchats.com', 'Production')
      .build();

    const document = SwaggerModule.createDocument(app, config, {
      deepScanRoutes: true,
      operationIdFactory: (controllerKey: string, methodKey: string) => methodKey,
    });

    // Customize Swagger UI
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'none',
        filter: true,
        showRequestDuration: true,
        syntaxHighlight: {
          activate: true,
          theme: 'monokai',
        },
        tryItOutEnabled: true,
        requestSnippetsEnabled: true,
        defaultModelsExpandDepth: 3,
        defaultModelExpandDepth: 3,
      },
      customSiteTitle: 'WarmChats Calling API Documentation',
      customfavIcon: '/favicon.ico',
      customCss: `
        .swagger-ui .topbar { display: none }
        .swagger-ui .info { margin: 50px 0 }
        .swagger-ui .info .title { font-size: 36px; color: #3b82f6 }
        .swagger-ui .scheme-container { background: #f8fafc; padding: 20px; border-radius: 8px }
      `,
    });

    // Also serve the raw OpenAPI spec
    const jsonDocument = JSON.stringify(document, null, 2);
    app.getHttpAdapter().get('/api/docs-json', (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.send(jsonDocument);
    });

    console.log('\n📚 Swagger Documentation available at:');
    console.log('   → Interactive UI: http://localhost:3000/api/docs');
    console.log('   → OpenAPI JSON: http://localhost:3000/api/docs-json\n');
  }
}

// OpenAPI Schema Examples
export const OpenAPIExamples = {
  Call: {
    id: '123e4567-e89b-12d3-a456-426614174000',
    providerCallSid: 'CA1234567890abcdef1234567890abcdef',
    direction: 'OUTBOUND',
    status: 'COMPLETED',
    fromNumber: '+14155559999',
    toNumber: '+14155555678',
    duration: 185,
    initiatedAt: '2024-01-15T10:30:00Z',
    answeredAt: '2024-01-15T10:30:05Z',
    completedAt: '2024-01-15T10:33:05Z',
    lead: {
      id: 'lead-123',
      name: 'Jane Smith',
      phoneNumber: '+14155555678',
    },
    agent: {
      id: 'agent-456',
      name: 'John Doe',
      email: 'john@warmchats.com',
    },
  },

  UsageStats: {
    billingCycle: {
      id: 'cycle-123',
      startDate: '2024-01-01T00:00:00Z',
      endDate: '2024-01-31T23:59:59Z',
      planLimit: 1000,
    },
    usage: {
      totalMinutes: 487.5,
      totalCost: 0.0,
      totalCalls: 142,
      percentageUsed: 48.75,
      remainingMinutes: 512.5,
      isOverLimit: false,
    },
    breakdown: {
      byStatus: {
        COMPLETED: 120,
        NO_ANSWER: 15,
        BUSY: 5,
        FAILED: 2,
      },
    },
  },

  PhoneNumber: {
    id: '123e4567-e89b-12d3-a456-426614174000',
    phoneNumber: '+14155551234',
    provider: 'telnyx',
    providerSid: 'PN1234567890abcdef1234567890abcdef',
    status: 'ACTIVE',
    capabilities: {
      voice: true,
      sms: true,
    },
    assignedToUser: {
      id: 'user-123',
      name: 'John Doe',
      email: 'john@warmchats.com',
    },
    createdAt: '2024-01-01T00:00:00Z',
  },
};