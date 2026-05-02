import {
  CommandHandler,
  EventBus,
  ICommandHandler,
  CommandBus,
} from "@nestjs/cqrs";
import { Injectable, Logger } from "@nestjs/common";
import {
  CompleteCallCommand,
  RecordCallUsageCommand,
  SendMissedCallSmsCommand,
} from "../impl";
import { PrismaService } from "@/shared/database/prisma.service";
import { TelephonyProviderFactory } from "@/modules/calling/infrastructure/telephony/telephony-provider.factory";
import { CallCompletedEvent, MissedCallEvent } from "../../events/impl";
import { CallStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

// ============================================
// 1. CompleteCallHandler   (unchanged from original)
// ============================================

@CommandHandler(CompleteCallCommand)
export class CompleteCallHandler implements ICommandHandler<CompleteCallCommand> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
    private readonly commandBus: CommandBus,
  ) {}

  async execute(command: CompleteCallCommand): Promise<void> {
    const { callId, providerCallSid, duration, status, timestamp } = command;

    const call = await this.prisma.call.update({
      where: { id: callId },
      data: {
        status: status as CallStatus,
        duration,
        completedAt: timestamp,
      },
      include: {
        lead: true,
        agent: true,
        businessNumber: true,
        workspace: true,
      },
    });

    await this.prisma.callEvent.create({
      data: {
        callId,
        eventType:
          status === "COMPLETED"
            ? "CALL_COMPLETED"
            : status === "NO_ANSWER"
              ? "CALL_NO_ANSWER"
              : status === "BUSY"
                ? "CALL_BUSY"
                : "CALL_FAILED",
        timestamp,
        payload: { duration, status },
        providerEventId: `${providerCallSid}-completed`,
      },
    });

    if (status === "COMPLETED" && duration > 0) {
      const billingCycle = await this.getCurrentBillingCycle(call.workspaceId);
      const minutes = new Decimal(duration).dividedBy(60);
      await this.commandBus.execute(
        new RecordCallUsageCommand(callId, minutes.toNumber(), billingCycle.id),
      );
    }

    if (
      call.direction === "INBOUND" &&
      (status === "NO_ANSWER" || status === "BUSY" || status === "FAILED")
    ) {
      this.eventBus.publish(
        new MissedCallEvent(
          callId,
          call.customerNumber,
          call.businessNumber.phoneNumber,
          call.workspaceId,
        ),
      );

      const config = await this.prisma.callingConfiguration.findUnique({
        where: { workspaceId: call.workspaceId },
      });

      const template =
        config?.missedCallSmsTemplate ||
        "Currently in an appointment. I will call you back shortly or text me please.";

      await this.commandBus.execute(
        new SendMissedCallSmsCommand(
          callId,
          call.customerNumber,
          call.businessNumber.phoneNumber,
          template,
        ),
      );
    }

    this.eventBus.publish(
      new CallCompletedEvent(
        callId,
        providerCallSid,
        status,
        duration,
        call.agentId,
        call.leadId,
        call.workspaceId,
      ),
    );
  }

  private async getCurrentBillingCycle(workspaceId: string) {
    const now = new Date();

    let cycle = await this.prisma.billingCycle.findFirst({
      where: {
        workspaceId,
        startDate: { lte: now },
        endDate: { gte: now },
        status: "ACTIVE",
      },
    });

    if (!cycle) {
      const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      const endDate = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        0,
        23,
        59,
        59,
      );

      cycle = await this.prisma.billingCycle.create({
        data: {
          workspaceId,
          startDate,
          endDate,
          status: "ACTIVE",
          planMinuteLimit: 1000,
          overageRate: 0.02,
        },
      });
    }

    return cycle;
  }
}

// ============================================
// 2. RecordCallUsageHandler   (unchanged from original)
// ============================================

@CommandHandler(RecordCallUsageCommand)
export class RecordCallUsageHandler implements ICommandHandler<RecordCallUsageCommand> {
  private readonly logger = new Logger(RecordCallUsageHandler.name);

  constructor(private readonly prisma: PrismaService) {}

  async execute(command: RecordCallUsageCommand): Promise<void> {
    const { callId, minutes, billingCycleId } = command;

    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    const billingCycle = await this.prisma.billingCycle.findUnique({
      where: { id: billingCycleId },
    });
    const config = await this.prisma.callingConfiguration.findUnique({
      where: { workspaceId: call.workspaceId },
    });

    const currentUsage = await this.prisma.usageRecord.aggregate({
      where: {
        billingCycleId,
        workspaceId: call.workspaceId,
      },
      _sum: { minutes: true },
    });

    const totalMinutes = Number(currentUsage._sum.minutes || 0);
    const planLimit = billingCycle.planMinuteLimit;
    const isOverage = totalMinutes + minutes > planLimit;

    let cost = 0;
    if (isOverage && config?.autoChargeOverage) {
      const overageMinutes = totalMinutes + minutes - planLimit;
      cost = overageMinutes * Number(billingCycle.overageRate);
      this.logger.log(
        `Auto-charging overage: ${overageMinutes} minutes at $${billingCycle.overageRate}/min = $${cost}`,
      );
    }

    await this.prisma.usageRecord.create({
      data: {
        callId,
        billingCycleId,
        workspaceId: call.workspaceId,
        agentId: call.agentId,
        minutes: new Decimal(minutes),
        cost: new Decimal(cost),
        isOverage,
      },
    });
  }
}

// ============================================
// 3. SendMissedCallSmsHandler   ← THE FIX
// ============================================
//
// SOW #5 requires that on a missed inbound call, an SMS is automatically
// sent to the customer from the business number.  The previous handler
// only wrote a CallEvent row — it never actually invoked Telnyx, so no
// SMS ever reached the customer's phone.
//
// This version:
//   1. Looks up the workspace's configured provider (telnyx by default).
//   2. Calls provider.sendSms() — which hits Telnyx /v2/messages with
//      the messaging profile id from env.
//   3. Records success or failure as a CallEvent for audit / debugging.
//   4. Never throws — call completion shouldn't fail because SMS did.
// ============================================

@CommandHandler(SendMissedCallSmsCommand)
export class SendMissedCallSmsHandler implements ICommandHandler<SendMissedCallSmsCommand> {
  private readonly logger = new Logger(SendMissedCallSmsHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telephonyFactory: TelephonyProviderFactory,
  ) {}

  async execute(command: SendMissedCallSmsCommand): Promise<void> {
    const { callId, customerNumber, businessNumber, template } = command;

    const call = await this.prisma.call.findUnique({
      where: { id: callId },
      select: { workspaceId: true },
    });

    if (!call) {
      this.logger.warn(`Cannot send missed SMS — call ${callId} not found`);
      return;
    }

    const config = await this.prisma.callingConfiguration.findUnique({
      where: { workspaceId: call.workspaceId },
    });

    const providerName = config?.provider || "telnyx";
    const provider = this.telephonyFactory.getProvider(providerName);

    try {
      const result = await provider.sendSms({
        from: businessNumber,
        to: customerNumber,
        body: template,
      });

      this.logger.log(
        `Missed-call SMS sent (callId=${callId}, smsSid=${result.sid})`,
      );

      await this.prisma.callEvent.create({
        data: {
          callId,
          eventType: "MISSED_CALL_SMS_SENT",
          timestamp: new Date(),
          payload: {
            to: customerNumber,
            from: businessNumber,
            message: template,
            providerMessageId: result.sid,
            providerStatus: result.status,
          },
        },
      });
    } catch (error) {
      this.logger.error(
        `Missed-call SMS FAILED (callId=${callId}): ${error.message}`,
      );

      await this.prisma.callEvent.create({
        data: {
          callId,
          eventType: "MISSED_CALL_SMS_SENT", // schema has no FAILED variant; payload.error flags it
          timestamp: new Date(),
          payload: {
            to: customerNumber,
            from: businessNumber,
            error: error.message,
            failed: true,
          },
        },
      });
      // Swallowed: SOW failure path shouldn't cascade into call completion.
    }
  }
}
