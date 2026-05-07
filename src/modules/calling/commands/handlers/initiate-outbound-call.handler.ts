import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InitiateOutboundCallCommand } from '../impl';
import { PrismaService } from '@/shared/database/prisma.service';
import { TelephonyProviderFactory } from '@/modules/calling/infrastructure/telephony/telephony-provider.factory';
import { CallInitiatedEvent } from '../../events/impl';
import { CallStatus, CallDirection } from '@prisma/client';

@CommandHandler(InitiateOutboundCallCommand)
export class InitiateOutboundCallHandler
  implements ICommandHandler<InitiateOutboundCallCommand>
{
  constructor(
    private readonly prisma: PrismaService,
    private readonly telephonyFactory: TelephonyProviderFactory,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: InitiateOutboundCallCommand): Promise<string> {
    const { leadId, agentId, workspaceId, metadata } = command;

    // ============================================
    // 1. SAFEGUARD CHECKS
    // ============================================

    // Check if agent exists and has phone number
    const agent = await this.prisma.user.findUnique({
      where: { id: agentId },
      include: { assignedNumber: true },
    });

    if (!agent) {
      throw new BadRequestException('Agent not found');
    }

    if (!agent.phoneNumber) {
      throw new BadRequestException(
        'Agent does not have a phone number configured',
      );
    }

    if (!agent.assignedNumber) {
      throw new ForbiddenException(
        'Agent does not have an assigned business number. Please contact admin.',
      );
    }

    // Check if lead exists
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
    });

    if (!lead) {
      throw new BadRequestException('Lead not found');
    }

    // Check workspace configuration
    const config = await this.prisma.callingConfiguration.findUnique({
      where: { workspaceId },
    });

    if (!config || !config.callingEnabled) {
      throw new ForbiddenException(
        'Calling is not enabled for this workspace',
      );
    }

    // Check usage limits
    const currentCycle = await this.getCurrentBillingCycle(workspaceId);
    const usageStats = await this.getUsageStats(workspaceId, currentCycle.id);

    // Check if auto-charge overage is enabled (client requirement)
    if (!config.autoChargeOverage && usageStats.totalMinutes >= currentCycle.planMinuteLimit) {
      throw new ForbiddenException(
        'Monthly calling limit exceeded. Please upgrade your plan or enable auto-charge overage.',
      );
    }

    // If auto-charge enabled, allow call to proceed (will be charged at overage rate)

    // ============================================
    // 2. CREATE CALL RECORD
    // ============================================

    const call = await this.prisma.call.create({
      data: {
        providerCallSid: '', // Will be updated after provider response
        direction: CallDirection.OUTBOUND,
        status: CallStatus.INITIATED,
        fromNumber: agent.assignedNumber.phoneNumber,
        toNumber: lead.phoneNumber,
        leadId,
        agentId,
        businessNumberId: agent.assignedNumber.id,
        agentPhoneNumber: agent.phoneNumber,
        customerNumber: lead.phoneNumber,
        workspaceId,
        initiatedAt: new Date(),
      },
    });

    // ============================================
    // 3. INITIATE CALL VIA TELEPHONY PROVIDER
    // ============================================

    const provider = this.telephonyFactory.getProvider(config.provider);

    try {
      // Agent-first dial flow: call agent first.
      //
      // When the agent answers, Telnyx fires call.answered on the status
      // webhook. The webhook controller then issues a `transfer` action
      // targeting the customer's number, which Telnyx bridges into the
      // same call leg with the business number as caller ID.
      const callResponse = await provider.initiateOutboundCall({
        from: agent.assignedNumber.phoneNumber, // Business number
        to: agent.phoneNumber, // Agent's real phone first
        callbackUrl: `${process.env.APP_URL}/webhooks/calling/telnyx/status`,
        callbackMethod: 'POST',
        metadata: {
          callId: call.id,
          leadId,
          agentId,
          workspaceId,
          customerNumber: lead.phoneNumber,
          stage: 'DIALING_AGENT',
        },
      });

      // Update call with provider SID. We also stash the outbound stage and
      // customer number in providerMetadata so the answer-bridge handler can
      // resolve which leg is currently up without reading volatile metadata
      // headers back from the provider.
      await this.prisma.call.update({
        where: { id: call.id },
        data: {
          providerCallSid: callResponse.sid,
          status: CallStatus.RINGING,
          ringingAt: new Date(),
          providerMetadata: {
            stage: 'DIALING_AGENT',
            customerNumber: lead.phoneNumber,
            agentPhoneNumber: agent.phoneNumber,
            businessNumber: agent.assignedNumber.phoneNumber,
          } as any,
        },
      });

      // Log the event
      await this.prisma.callEvent.create({
        data: {
          callId: call.id,
          eventType: 'CALL_INITIATED',
          timestamp: new Date(),
          payload: {
            direction: 'OUTBOUND',
            stage: 'DIALING_AGENT',
          },
          providerEventId: callResponse.sid,
        },
      });

      // Emit domain event
      this.eventBus.publish(
        new CallInitiatedEvent(
          call.id,
          callResponse.sid,
          'OUTBOUND',
          agentId,
          leadId,
          workspaceId,
        ),
      );

      return call.id;
    } catch (error) {
      // Update call status to failed
      await this.prisma.call.update({
        where: { id: call.id },
        data: {
          status: CallStatus.FAILED,
          errorMessage: error.message,
          completedAt: new Date(),
        },
      });

      throw new BadRequestException(
        `Failed to initiate call: ${error.message}`,
      );
    }
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
      // Create new billing cycle (monthly)
      const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

      cycle = await this.prisma.billingCycle.create({
        data: {
          workspaceId,
          startDate,
          endDate,
          status: 'ACTIVE',
          planMinuteLimit: 1000, // TODO: Get from workspace plan
          overageRate: 0.02, // $0.02 per minute
        },
      });
    }

    return cycle;
  }

  private async getUsageStats(workspaceId: string, billingCycleId: string) {
    const result = await this.prisma.usageRecord.aggregate({
      where: {
        workspaceId,
        billingCycleId,
      },
      _sum: {
        minutes: true,
        cost: true,
      },
    });

    return {
      totalMinutes: Number(result._sum.minutes || 0),
      totalCost: Number(result._sum.cost || 0),
    };
  }
}