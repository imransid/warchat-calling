import {
  CommandBus,
  CommandHandler,
  EventBus,
  ICommandHandler,
} from "@nestjs/cqrs";
import { Injectable, BadRequestException } from "@nestjs/common";
import { HandleInboundCallCommand, SendMissedCallSmsCommand } from "../impl";
import { PrismaService } from "@/shared/database/prisma.service";
import { InboundCallReceivedEvent } from "../../events/impl";
import { CallStatus, CallDirection } from "@prisma/client";
import { CallingGateway } from "../../gateway/calling.gateway";

export type RingStrategy = "parallel" | "web_first" | "phone_first";

export interface InboundCallPlan {
  callId: string;
  agentId: string;
  agentPhoneNumber: string;
  agentSipUri: string | null;
  businessNumber: string;
  ringTimeout: number;
  ringStrategy: RingStrategy;
  // True when the agent is already on another call. The caller (webhook
  // controller) should not fork rings; instead hang up the inbound leg.
  // The missed-call SMS pipeline still fires because Call.status=NO_ANSWER
  // for INBOUND with BUSY_AGENT_OCCUPIED event triggers CompleteCallHandler.
  busy: boolean;
  // Pre-formatted lead name/phone for the incoming_call socket event.
  leadName: string | null;
  fromNumber: string;
}

@Injectable()
@CommandHandler(HandleInboundCallCommand)
export class HandleInboundCallHandler
  implements ICommandHandler<HandleInboundCallCommand>
{
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
    private readonly commandBus: CommandBus,
    private readonly gateway: CallingGateway,
  ) {}

  async execute(command: HandleInboundCallCommand): Promise<InboundCallPlan> {
    const { fromNumber, toNumber, providerCallSid, workspaceId } = command;

    const phoneNumber = await this.prisma.phoneNumber.findUnique({
      where: { phoneNumber: toNumber },
      include: { assignedToUser: true },
    });

    if (!phoneNumber || !phoneNumber.assignedToUser) {
      throw new BadRequestException(
        "No agent assigned to this business number",
      );
    }

    const agent = phoneNumber.assignedToUser;
    if (!agent.phoneNumber) {
      throw new BadRequestException(
        "Assigned agent does not have a phone number configured",
      );
    }

    let lead = await this.prisma.lead.findFirst({
      where: { phoneNumber: fromNumber, workspaceId },
    });
    if (!lead) {
      lead = await this.prisma.lead.create({
        data: { phoneNumber: fromNumber, workspaceId },
      });
    }

    const config = await this.prisma.callingConfiguration.findUnique({
      where: { workspaceId },
    });
    const ringTimeout = config?.ringTimeout || 25;
    const ringStrategy = (config?.ringStrategy as RingStrategy) || "parallel";

    // ----- Busy-on-busy detection -----------------------------------------
    // If the agent is already on (or being rung for) another call, drop
    // this inbound as NO_ANSWER and let the missed-call SMS pipeline handle
    // the auto-reply. Phase 2 may add hold/swap.
    const existingActive = await this.prisma.call.findFirst({
      where: {
        agentId: agent.id,
        status: { in: [CallStatus.RINGING, CallStatus.IN_PROGRESS] },
      },
      select: { id: true },
    });
    const busy = !!existingActive;

    const call = await this.prisma.call.create({
      data: {
        providerCallSid,
        direction: CallDirection.INBOUND,
        status: busy ? CallStatus.NO_ANSWER : CallStatus.RINGING,
        fromNumber,
        toNumber,
        leadId: lead.id,
        agentId: agent.id,
        businessNumberId: phoneNumber.id,
        agentPhoneNumber: agent.phoneNumber,
        customerNumber: fromNumber,
        workspaceId,
        initiatedAt: new Date(),
        ringingAt: busy ? null : new Date(),
        completedAt: busy ? new Date() : null,
      },
    });

    await this.prisma.callEvent.create({
      data: {
        callId: call.id,
        eventType: busy ? "BUSY_AGENT_OCCUPIED" : "CALL_INITIATED",
        timestamp: new Date(),
        payload: {
          direction: "INBOUND",
          fromNumber,
          toNumber,
          ringStrategy,
        },
        providerEventId: busy ? null : providerCallSid,
      },
    });

    if (busy) {
      this.gateway.emitToUser(agent.id, "missed_while_busy", {
        callId: call.id,
        fromNumber,
        leadName: lead.name,
        leadId: lead.id,
        at: new Date().toISOString(),
      });
      // Trigger the same missed-call SMS the no-answer path would fire.
      const template =
        config?.missedCallSmsTemplate ||
        "Currently in an appointment. I will call you back shortly or text me please.";
      void this.commandBus.execute(
        new SendMissedCallSmsCommand(
          call.id,
          fromNumber, // customer
          toNumber, // business number
          template,
        ),
      );
    } else {
      this.gateway.emitToUser(agent.id, "incoming_call", {
        callId: call.id,
        fromNumber,
        leadName: lead.name,
        leadId: lead.id,
        businessNumber: toNumber,
        ringStrategy,
        at: new Date().toISOString(),
      });
    }

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

    return {
      callId: call.id,
      agentId: agent.id,
      agentPhoneNumber: agent.phoneNumber,
      agentSipUri: agent.telnyxSipUri || null,
      businessNumber: toNumber,
      ringTimeout,
      ringStrategy,
      busy,
      leadName: lead.name || null,
      fromNumber,
    };
  }
}
