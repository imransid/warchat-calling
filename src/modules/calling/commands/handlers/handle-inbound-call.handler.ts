import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { Injectable, BadRequestException } from '@nestjs/common';
import { HandleInboundCallCommand } from '../impl';
import { PrismaService } from '@/shared/database/prisma.service';
import { InboundCallReceivedEvent } from '../../events/impl';
import { CallStatus, CallDirection } from '@prisma/client';

@CommandHandler(HandleInboundCallCommand)
export class HandleInboundCallHandler
  implements ICommandHandler<HandleInboundCallCommand>
{
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: HandleInboundCallCommand): Promise<{
    callId: string;
    forwardTo: string;
    timeout: number;
  }> {
    const { fromNumber, toNumber, providerCallSid, workspaceId } = command;

    // ============================================
    // 1. FIND ASSIGNED AGENT
    // ============================================

    const phoneNumber = await this.prisma.phoneNumber.findUnique({
      where: { phoneNumber: toNumber },
      include: {
        assignedToUser: true,
      },
    });

    if (!phoneNumber || !phoneNumber.assignedToUser) {
      throw new BadRequestException(
        'No agent assigned to this business number',
      );
    }

    const agent = phoneNumber.assignedToUser;

    if (!agent.phoneNumber) {
      throw new BadRequestException(
        'Assigned agent does not have a phone number configured',
      );
    }

    // ============================================
    // 2. FIND OR CREATE LEAD
    // ============================================

    let lead = await this.prisma.lead.findFirst({
      where: {
        phoneNumber: fromNumber,
        workspaceId,
      },
    });

    if (!lead) {
      // Create new lead
      lead = await this.prisma.lead.create({
        data: {
          phoneNumber: fromNumber,
          workspaceId,
        },
      });
    }

    // ============================================
    // 3. GET WORKSPACE CONFIGURATION
    // ============================================

    const config = await this.prisma.callingConfiguration.findUnique({
      where: { workspaceId },
    });

    const ringTimeout = config?.ringTimeout || 25;

    // ============================================
    // 4. CREATE CALL RECORD
    // ============================================

    const call = await this.prisma.call.create({
      data: {
        providerCallSid,
        direction: CallDirection.INBOUND,
        status: CallStatus.RINGING,
        fromNumber,
        toNumber,
        leadId: lead.id,
        agentId: agent.id,
        businessNumberId: phoneNumber.id,
        agentPhoneNumber: agent.phoneNumber,
        customerNumber: fromNumber,
        workspaceId,
        initiatedAt: new Date(),
        ringingAt: new Date(),
      },
    });

    // ============================================
    // 5. LOG EVENT
    // ============================================

    await this.prisma.callEvent.create({
      data: {
        callId: call.id,
        eventType: 'CALL_INITIATED',
        timestamp: new Date(),
        payload: {
          direction: 'INBOUND',
          fromNumber,
          toNumber,
        },
        providerEventId: providerCallSid,
      },
    });

    // ============================================
    // 6. EMIT DOMAIN EVENT
    // ============================================

    this.eventBus.publish(
      new InboundCallReceivedEvent(
        call.id,
        providerCallSid,
        fromNumber,
        toNumber,
        agent.id,
        lead.id,
        workspaceId,
      ),
    );

    // ============================================
    // 7. RETURN FORWARDING INSTRUCTIONS
    // ============================================

    return {
      callId: call.id,
      forwardTo: agent.phoneNumber,
      timeout: ringTimeout,
    };
  }
}
