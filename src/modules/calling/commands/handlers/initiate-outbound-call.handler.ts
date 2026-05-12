import { CommandHandler, EventBus, ICommandHandler } from "@nestjs/cqrs";
import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { InitiateOutboundCallCommand } from "../impl";
import { PrismaService } from "@/shared/database/prisma.service";
import { TelephonyProviderFactory } from "@/modules/calling/infrastructure/telephony/telephony-provider.factory";
import { CallingGateway } from "../../gateway/calling.gateway";
import { CallInitiatedEvent } from "../../events/impl";
import { CallStatus, CallDirection } from "@prisma/client";

/**
 * Initiates an outbound call.
 *
 *   origin = 'phone' → existing agent-first PSTN dial. We POST /v2/calls to
 *     Telnyx with `to = agent.phoneNumber`; the answer-bridge webhook handler
 *     then transfers the customer in with the business number as caller ID.
 *
 *   origin = 'web'   → the browser places the call via @telnyx/webrtc. We do
 *     NOT call Telnyx from here — we just create a placeholder Call row that
 *     the SIP-origin webhook handler matches against. Returning the callId
 *     gives the UI something to thread state through.
 */
@CommandHandler(InitiateOutboundCallCommand)
export class InitiateOutboundCallHandler
  implements ICommandHandler<InitiateOutboundCallCommand>
{
  constructor(
    private readonly prisma: PrismaService,
    private readonly telephonyFactory: TelephonyProviderFactory,
    private readonly eventBus: EventBus,
    private readonly gateway: CallingGateway,
  ) {}

  async execute(command: InitiateOutboundCallCommand): Promise<string> {
    const { agentId, workspaceId, options } = command;
    const origin = options.origin || "phone";

    const agent = await this.prisma.user.findUnique({
      where: { id: agentId },
      include: { assignedNumber: true },
    });
    if (!agent) throw new BadRequestException("Agent not found");
    if (!agent.assignedNumber) {
      throw new ForbiddenException(
        "Agent does not have an assigned business number. Please contact admin.",
      );
    }

    // Lead resolution: prefer existing leadId; otherwise upsert by phoneNumber.
    let lead;
    if (options.leadId) {
      lead = await this.prisma.lead.findUnique({
        where: { id: options.leadId },
      });
      if (!lead) throw new BadRequestException("Lead not found");
    } else if (options.phoneNumber) {
      lead = await this.prisma.lead.findFirst({
        where: { phoneNumber: options.phoneNumber, workspaceId },
      });
      if (!lead) {
        lead = await this.prisma.lead.create({
          data: {
            phoneNumber: options.phoneNumber,
            name: options.name,
            workspaceId,
          },
        });
      } else if (options.name && !lead.name) {
        lead = await this.prisma.lead.update({
          where: { id: lead.id },
          data: { name: options.name },
        });
      }
    } else {
      throw new BadRequestException(
        "Either leadId or phoneNumber must be provided",
      );
    }

    const config = await this.prisma.callingConfiguration.findUnique({
      where: { workspaceId },
    });
    if (!config || !config.callingEnabled) {
      throw new ForbiddenException("Calling is not enabled for this workspace");
    }

    const currentCycle = await this.getCurrentBillingCycle(workspaceId);
    const usageStats = await this.getUsageStats(workspaceId, currentCycle.id);
    if (
      !config.autoChargeOverage &&
      usageStats.totalMinutes >= currentCycle.planMinuteLimit
    ) {
      throw new ForbiddenException(
        "Monthly calling limit exceeded. Please upgrade your plan or enable auto-charge overage.",
      );
    }

    // For phone origin, we need agent.phoneNumber to dial. Web origin uses
    // the SIP credential, so phoneNumber isn't required.
    if (origin === "phone" && !agent.phoneNumber) {
      throw new BadRequestException(
        "Agent does not have a personal phone number configured (required for phone origin)",
      );
    }

    if (origin === "web") {
      // Browser does the dialing. Create a pending row so the UI has an id
      // to bind state to; the SIP-origin webhook handler will create the
      // *actual* row when Telnyx fires call.initiated.
      const placeholder = await this.prisma.call.create({
        data: {
          providerCallSid: `pending-web-${agent.id}-${Date.now()}`,
          direction: CallDirection.OUTBOUND,
          status: CallStatus.INITIATED,
          fromNumber: agent.assignedNumber.phoneNumber,
          toNumber: lead.phoneNumber,
          leadId: lead.id,
          agentId,
          businessNumberId: agent.assignedNumber.id,
          agentPhoneNumber: agent.telnyxSipUri || agent.phoneNumber || "",
          customerNumber: lead.phoneNumber,
          workspaceId,
          origin: "web",
          initiatedAt: new Date(),
          providerMetadata: { stage: "WEB_PENDING" } as any,
        },
      });

      this.gateway.emitToUser(agentId, "call_state", {
        callId: placeholder.id,
        status: "INITIATED",
        direction: "OUTBOUND",
        origin: "web",
        destination: lead.phoneNumber,
      });
      return placeholder.id;
    }

    // origin === 'phone' — existing agent-first PSTN flow
    const call = await this.prisma.call.create({
      data: {
        providerCallSid: "",
        direction: CallDirection.OUTBOUND,
        status: CallStatus.INITIATED,
        fromNumber: agent.assignedNumber.phoneNumber,
        toNumber: lead.phoneNumber,
        leadId: lead.id,
        agentId,
        businessNumberId: agent.assignedNumber.id,
        agentPhoneNumber: agent.phoneNumber!,
        customerNumber: lead.phoneNumber,
        workspaceId,
        origin: "phone",
        initiatedAt: new Date(),
      },
    });

    const provider = this.telephonyFactory.getProvider(config.provider);
    try {
      const callResponse = await provider.initiateOutboundCall({
        from: agent.assignedNumber.phoneNumber,
        to: agent.phoneNumber!,
        callbackUrl: `${process.env.APP_URL}/webhooks/calling/telnyx/status`,
        callbackMethod: "POST",
        metadata: {
          callId: call.id,
          leadId: lead.id,
          agentId,
          workspaceId,
          customerNumber: lead.phoneNumber,
          stage: "DIALING_AGENT",
        },
      });

      await this.prisma.call.update({
        where: { id: call.id },
        data: {
          providerCallSid: callResponse.sid,
          status: CallStatus.RINGING,
          ringingAt: new Date(),
          providerMetadata: {
            stage: "DIALING_AGENT",
            customerNumber: lead.phoneNumber,
            agentPhoneNumber: agent.phoneNumber,
            businessNumber: agent.assignedNumber.phoneNumber,
          } as any,
        },
      });

      await this.prisma.callEvent.create({
        data: {
          callId: call.id,
          eventType: "CALL_INITIATED",
          timestamp: new Date(),
          payload: { direction: "OUTBOUND", stage: "DIALING_AGENT" },
          providerEventId: callResponse.sid,
        },
      });

      this.eventBus.publish(
        new CallInitiatedEvent(
          call.id,
          callResponse.sid,
          "OUTBOUND",
          agentId,
          lead.id,
          workspaceId,
        ),
      );

      this.gateway.emitToUser(agentId, "call_state", {
        callId: call.id,
        status: "RINGING",
        direction: "OUTBOUND",
        origin: "phone",
      });

      return call.id;
    } catch (error) {
      await this.prisma.call.update({
        where: { id: call.id },
        data: {
          status: CallStatus.FAILED,
          errorMessage: (error as Error).message,
          completedAt: new Date(),
        },
      });
      throw new BadRequestException(
        `Failed to initiate call: ${(error as Error).message}`,
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

  private async getUsageStats(workspaceId: string, billingCycleId: string) {
    const result = await this.prisma.usageRecord.aggregate({
      where: { workspaceId, billingCycleId },
      _sum: { minutes: true, cost: true },
    });
    return {
      totalMinutes: Number(result._sum.minutes || 0),
      totalCost: Number(result._sum.cost || 0),
    };
  }
}
