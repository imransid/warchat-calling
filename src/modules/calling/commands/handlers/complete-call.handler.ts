import { CommandHandler, EventBus, ICommandHandler, CommandBus } from '@nestjs/cqrs';
import { Injectable, Logger } from '@nestjs/common';
import { CompleteCallCommand, RecordCallUsageCommand, SendMissedCallSmsCommand } from '../impl';
import { PrismaService } from '@/shared/database/prisma.service';
import { CallCompletedEvent, MissedCallEvent } from '../../events/impl';
import { CallStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

@CommandHandler(CompleteCallCommand)
export class CompleteCallHandler
  implements ICommandHandler<CompleteCallCommand>
{
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
    private readonly commandBus: CommandBus,
  ) {}

  async execute(command: CompleteCallCommand): Promise<void> {
    const { callId, providerCallSid, duration, status, timestamp } = command;

    // ============================================
    // 1. UPDATE CALL RECORD
    // ============================================

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

    // ============================================
    // 2. LOG COMPLETION EVENT
    // ============================================

    await this.prisma.callEvent.create({
      data: {
        callId,
        eventType: status === 'COMPLETED' ? 'CALL_COMPLETED' : 
                   status === 'NO_ANSWER' ? 'CALL_NO_ANSWER' :
                   status === 'BUSY' ? 'CALL_BUSY' :
                   'CALL_FAILED',
        timestamp,
        payload: {
          duration,
          status,
        },
        providerEventId: `${providerCallSid}-completed`,
      },
    });

    // ============================================
    // 3. RECORD USAGE (if call was answered)
    // ============================================

    if (status === 'COMPLETED' && duration > 0) {
      // Get current billing cycle
      const billingCycle = await this.getCurrentBillingCycle(call.workspaceId);

      // Convert seconds to minutes (fractional)
      const minutes = new Decimal(duration).dividedBy(60);

      // Record usage
      await this.commandBus.execute(
        new RecordCallUsageCommand(callId, minutes.toNumber(), billingCycle.id),
      );
    }

    // ============================================
    // 4. HANDLE MISSED CALL (if inbound and not answered)
    // ============================================

    if (
      call.direction === 'INBOUND' &&
      (status === 'NO_ANSWER' || status === 'BUSY' || status === 'FAILED')
    ) {
      // Emit missed call event
      this.eventBus.publish(
        new MissedCallEvent(
          callId,
          call.customerNumber,
          call.businessNumber.phoneNumber,
          call.workspaceId,
        ),
      );

      // Get configuration for SMS template
      const config = await this.prisma.callingConfiguration.findUnique({
        where: { workspaceId: call.workspaceId },
      });

      const template = config?.missedCallSmsTemplate || 
        "Hi! I missed your call. I'll get back to you shortly.";

      // Send missed-call SMS
      await this.commandBus.execute(
        new SendMissedCallSmsCommand(
          callId,
          call.customerNumber,
          call.businessNumber.phoneNumber,
          template,
        ),
      );
    }

    // ============================================
    // 5. EMIT DOMAIN EVENT
    // ============================================

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
        status: 'ACTIVE',
      },
    });

    if (!cycle) {
      const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

      cycle = await this.prisma.billingCycle.create({
        data: {
          workspaceId,
          startDate,
          endDate,
          status: 'ACTIVE',
          planMinuteLimit: 1000,
          overageRate: 0.02,
        },
      });
    }

    return cycle;
  }
}

// ============================================
// RECORD USAGE HANDLER
// ============================================

@CommandHandler(RecordCallUsageCommand)
export class RecordCallUsageHandler
  implements ICommandHandler<RecordCallUsageCommand>
{
  private readonly logger = new Logger(RecordCallUsageHandler.name);

  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async execute(command: RecordCallUsageCommand): Promise<void> {
    const { callId, minutes, billingCycleId } = command;

    const call = await this.prisma.call.findUnique({
      where: { id: callId },
    });

    const billingCycle = await this.prisma.billingCycle.findUnique({
      where: { id: billingCycleId },
    });

    // Get workspace configuration for auto-charge setting
    const config = await this.prisma.callingConfiguration.findUnique({
      where: { workspaceId: call.workspaceId },
    });

    // Calculate current usage
    const currentUsage = await this.prisma.usageRecord.aggregate({
      where: {
        billingCycleId,
        workspaceId: call.workspaceId,
      },
      _sum: {
        minutes: true,
      },
    });

    const totalMinutes = Number(currentUsage._sum.minutes || 0);
    const planLimit = billingCycle.planMinuteLimit;
    const isOverage = totalMinutes + minutes > planLimit;

    // Calculate cost based on client requirement: auto-charge overage
    let cost = 0;
    if (isOverage && config?.autoChargeOverage) {
      // All minutes over the limit are charged at overage rate
      const overageMinutes = (totalMinutes + minutes) - planLimit;
      const includedMinutes = Math.max(0, minutes - overageMinutes);
      cost = overageMinutes * Number(billingCycle.overageRate);
      
      this.logger.log(`Auto-charging overage: ${overageMinutes} minutes at $${billingCycle.overageRate}/min = $${cost}`);
    }

    // Record usage
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
// SEND MISSED CALL SMS HANDLER
// ============================================

@CommandHandler(SendMissedCallSmsCommand)
export class SendMissedCallSmsHandler
  implements ICommandHandler<SendMissedCallSmsCommand>
{
  constructor(
    private readonly prisma: PrismaService,
    // TelephonyProviderFactory will be injected
  ) {}

  async execute(command: SendMissedCallSmsCommand): Promise<void> {
    const { callId, customerNumber, businessNumber, template } = command;

    // TODO: Implement SMS sending via telephony provider
    // This would use the same provider (Twilio/Telnyx) to send SMS
    
    // Log the event
    await this.prisma.callEvent.create({
      data: {
        callId,
        eventType: 'MISSED_CALL_SMS_SENT',
        timestamp: new Date(),
        payload: {
          to: customerNumber,
          from: businessNumber,
          message: template,
        },
      },
    });
  }
}
