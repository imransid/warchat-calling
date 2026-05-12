import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { ConfigModule } from "@nestjs/config";
import { BullModule } from "@nestjs/bull";
import { ScheduleModule } from "@nestjs/schedule";

// Controllers
import { CallingController } from "./controllers/calling.controller";
import { CallingWebhookController } from "./controllers/webhook.controller";
import { CallingAdminController } from "./controllers/admin.controller";

// Command Handlers
import { InitiateOutboundCallHandler } from "./commands/handlers/initiate-outbound-call.handler";
import { HandleInboundCallHandler } from "./commands/handlers/handle-inbound-call.handler";
import {
  CompleteCallHandler,
  RecordCallUsageHandler,
  SendMissedCallSmsHandler,
} from "./commands/handlers/complete-call.handler";
import { ProcessWebhookHandler } from "./commands/handlers/process-webhook.handler";
import {
  ProvisionPhoneNumberHandler,
  AssignPhoneNumberHandler,
  ReleasePhoneNumberHandler,
} from "./commands/handlers/phone-number.handler";

// Query Handlers
import {
  GetCallByIdHandler,
  GetCallsByLeadHandler,
  GetUsageStatsByWorkspaceHandler,
  GetCurrentBillingCycleHandler,
  GetCallDashboardStatsHandler,
  CanUserMakeCallHandler,
  GetCallingConfigurationHandler,
  GetPhoneNumbersByWorkspaceHandler,
  GetAssignedPhoneNumberHandler,
  GetPhoneNumberByIdHandler,
  GetAvailablePhoneNumbersHandler,
} from "./queries/handlers/call-queries.handler";

// Infrastructure
import { TelephonyProviderFactory } from "./infrastructure/telephony/telephony-provider.factory";
import { TelnyxProvider } from "./infrastructure/telephony/telnyx.provider";

// Webhook retry worker (NEW)
import {
  WebhookRetryScheduler,
  WebhookRetryProcessor,
  WEBHOOK_RETRY_QUEUE_NAME,
} from "./workers/webhook-retry.worker";

// WebRTC + realtime gateway
import { WebRtcController } from "./webrtc/webrtc.controller";
import { WebRtcService } from "./webrtc/webrtc.service";
import { CallingGateway } from "./gateway/calling.gateway";

// Shared
import { PrismaService } from "@/shared/database/prisma.service";

const CommandHandlers = [
  InitiateOutboundCallHandler,
  HandleInboundCallHandler,
  CompleteCallHandler,
  RecordCallUsageHandler,
  SendMissedCallSmsHandler,
  ProcessWebhookHandler,
  ProvisionPhoneNumberHandler,
  AssignPhoneNumberHandler,
  ReleasePhoneNumberHandler,
];

const QueryHandlers = [
  GetCallByIdHandler,
  GetCallsByLeadHandler,
  GetUsageStatsByWorkspaceHandler,
  GetCurrentBillingCycleHandler,
  GetCallDashboardStatsHandler,
  CanUserMakeCallHandler,
  GetCallingConfigurationHandler,
  GetPhoneNumbersByWorkspaceHandler,
  GetAssignedPhoneNumberHandler,
  GetPhoneNumberByIdHandler,
  GetAvailablePhoneNumbersHandler,
];

const Workers = [WebhookRetryScheduler, WebhookRetryProcessor];

const Providers = [
  PrismaService,
  TelephonyProviderFactory,
  TelnyxProvider,
  WebRtcService,
  CallingGateway,
];

@Module({
  imports: [
    CqrsModule,
    ConfigModule,
    ScheduleModule.forRoot(),
    BullModule.registerQueue(
      { name: "calling-webhooks" },
      { name: WEBHOOK_RETRY_QUEUE_NAME },
    ),
  ],
  controllers: [
    CallingController,
    CallingWebhookController,
    CallingAdminController,
    WebRtcController,
  ],
  providers: [...CommandHandlers, ...QueryHandlers, ...Workers, ...Providers],
  exports: [TelephonyProviderFactory, CallingGateway],
})
export class CallingModule {}
