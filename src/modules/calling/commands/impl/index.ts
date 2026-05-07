import { ICommand } from "@nestjs/cqrs";

// ============================================
// OUTBOUND CALLING COMMANDS
// ============================================

export class InitiateOutboundCallCommand implements ICommand {
  constructor(
    public readonly leadId: string,
    public readonly agentId: string,
    public readonly workspaceId: string,
    public readonly metadata?: Record<string, any>,
  ) {}
}

export class HandleAgentAnsweredCommand implements ICommand {
  constructor(
    public readonly callId: string,
    public readonly providerCallSid: string,
    public readonly timestamp: Date,
  ) {}
}

export class BridgeCustomerCommand implements ICommand {
  constructor(
    public readonly callId: string,
    public readonly agentCallSid: string,
  ) {}
}

export class CompleteCallCommand implements ICommand {
  constructor(
    public readonly callId: string,
    public readonly providerCallSid: string,
    public readonly duration: number,
    public readonly status:
      | "COMPLETED"
      | "NO_ANSWER"
      | "BUSY"
      | "FAILED"
      | "CANCELED",
    public readonly timestamp: Date,
  ) {}
}

// ============================================
// INBOUND CALLING COMMANDS
// ============================================

export class HandleInboundCallCommand implements ICommand {
  constructor(
    public readonly fromNumber: string,
    public readonly toNumber: string, // Business number
    public readonly providerCallSid: string,
    public readonly workspaceId: string,
  ) {}
}

export class ForwardInboundCallCommand implements ICommand {
  constructor(
    public readonly callId: string,
    public readonly agentPhoneNumber: string,
    public readonly timeout: number,
  ) {}
}

export class SendMissedCallSmsCommand implements ICommand {
  constructor(
    public readonly callId: string,
    public readonly customerNumber: string,
    public readonly businessNumber: string,
    public readonly template: string,
  ) {}
}

// ============================================
// NUMBER MANAGEMENT COMMANDS
// ============================================

export class ProvisionPhoneNumberCommand implements ICommand {
  constructor(
    public readonly workspaceId: string,
    public readonly areaCode?: string,
    public readonly country?: string,
  ) {}
}

export class AssignPhoneNumberCommand implements ICommand {
  constructor(
    public readonly phoneNumberId: string,
    public readonly userId: string,
  ) {}
}

export class ReleasePhoneNumberCommand implements ICommand {
  constructor(
    public readonly phoneNumberId: string,
    public readonly reason?: string,
  ) {}
}

// ============================================
// USAGE METERING COMMANDS
// ============================================

export class RecordCallUsageCommand implements ICommand {
  constructor(
    public readonly callId: string,
    public readonly minutes: number,
    public readonly billingCycleId: string,
  ) {}
}

export class EnforceUsageLimitCommand implements ICommand {
  constructor(
    public readonly workspaceId: string,
    public readonly billingCycleId: string,
  ) {}
}

// ============================================
// WEBHOOK PROCESSING COMMANDS
// ============================================

export class ProcessWebhookCommand implements ICommand {
  constructor(
    public readonly provider: "telnyx",
    public readonly eventType: string,
    public readonly payload: any,
    public readonly providerEventId: string,
  ) {}
}

export class RetryFailedWebhookCommand implements ICommand {
  constructor(public readonly webhookLogId: string) {}
}
