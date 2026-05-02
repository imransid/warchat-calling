import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { ConfigModule } from "@nestjs/config";
import { BullModule } from "@nestjs/bull";

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

// Query Handlers
import {
  GetCallByIdHandler,
  GetCallsByLeadHandler,
  GetUsageStatsByWorkspaceHandler,
  GetCurrentBillingCycleHandler,
  GetCallDashboardStatsHandler,
  CanUserMakeCallHandler,
  GetAvailablePhoneNumbersHandler,
  GetPhoneNumberByIdHandler,
  GetAssignedPhoneNumberHandler,
  GetCallingConfigurationHandler,
  GetPhoneNumbersByWorkspaceHandler,
} from "./queries/handlers/call-queries.handler";

// Infrastructure
import { TelephonyProviderFactory } from "./infrastructure/telephony/telephony-provider.factory";
import { TwilioProvider } from "./infrastructure/telephony/twilio.provider";
import { TelnyxProvider } from "./infrastructure/telephony/telnyx.provider";

import {
  ProvisionPhoneNumberHandler,
  AssignPhoneNumberHandler,
  ReleasePhoneNumberHandler,
} from "./commands/handlers/phone-number.handler";

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

const Providers = [
  PrismaService,
  TelephonyProviderFactory,
  TwilioProvider,
  TelnyxProvider,
];

@Module({
  imports: [
    CqrsModule,
    ConfigModule,
    BullModule.registerQueue({
      name: "calling-webhooks",
    }),
  ],
  controllers: [
    CallingController,
    CallingWebhookController,
    CallingAdminController,
  ],
  providers: [...CommandHandlers, ...QueryHandlers, ...Providers],
  exports: [TelephonyProviderFactory],
})
export class CallingModule {}
