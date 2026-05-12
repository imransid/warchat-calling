import {
  Controller,
  Post,
  Body,
  Res,
  Req,
  Logger,
  HttpStatus,
  Headers,
} from "@nestjs/common";
import { CommandBus } from "@nestjs/cqrs";
import { Request, Response } from "express";
import {
  ProcessWebhookCommand,
  HandleInboundCallCommand,
} from "../commands/impl";
import { TelephonyProviderFactory } from "../infrastructure/telephony/telephony-provider.factory";
import { TelnyxProvider } from "../infrastructure/telephony/telnyx.provider";
import { PrismaService } from "@/shared/database/prisma.service";
import { CallingGateway } from "../gateway/calling.gateway";
import { ConfigService } from "@nestjs/config";
import { InboundCallPlan } from "../commands/handlers/handle-inbound-call.handler";
import * as nacl from "tweetnacl";

/**
 * Webhook entry points for Telnyx.
 *
 * Three flows are driven from here:
 *
 *  1. INBOUND PARALLEL-RING (web + cell)
 *     - call.initiated (direction=incoming, anchor leg) → answer + fork two
 *       new outbound legs (sip:<agent> and tel:<agent-cell>).
 *     - call.answered on EITHER fork leg → bridge winner to anchor, hang up
 *       loser, emit `call_taken_elsewhere` to other tabs.
 *
 *  2. OUTBOUND AGENT-FIRST PSTN (origin = 'phone')
 *     - InitiateOutboundCallHandler dials agent first.
 *     - call.answered (direction=outgoing) on that anchor → transfer to
 *       customer (number masking).
 *
 *  3. OUTBOUND FROM WEB (origin = 'web')
 *     - Browser places the call via @telnyx/webrtc — Telnyx fires
 *       call.initiated (direction=outgoing) from the agent's SIP credential.
 *     - We upsert the Call row at webhook time (no pre-call needed).
 *
 * Idempotency: every fork-leg answer is guarded by reading Call.answeredVia,
 * which is set atomically. Duplicate webhooks become no-ops.
 */
@Controller("webhooks/calling")
export class CallingWebhookController {
  private readonly logger = new Logger(CallingWebhookController.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly telephonyFactory: TelephonyProviderFactory,
    private readonly prisma: PrismaService,
    private readonly gateway: CallingGateway,
    private readonly config: ConfigService,
  ) {}

  @Post("telnyx/status")
  async handleTelnyxStatus(
    @Body() body: any,
    @Headers() headers: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!this.verifyTelnyxSignature(headers, req, body)) {
      this.logger.warn("Rejecting Telnyx webhook — invalid signature");
      return res.status(HttpStatus.UNAUTHORIZED).send();
    }

    const eventType: string =
      body.data?.event_type || body.event_type || "unknown";
    const payload = body.data?.payload || body.payload || {};
    const callControlId: string =
      payload.call_control_id || body.data?.call_control_id;

    this.logger.debug(`Telnyx event: ${eventType} (${callControlId})`);

    try {
      // 1. Inbound anchor leg created → fork parallel ring
      if (
        eventType === "call.initiated" &&
        payload.direction === "incoming" &&
        callControlId
      ) {
        await this.routeInboundTelnyxCall(payload);
      }

      // 2. Outbound SIP-originated call (web origin) → register the call row
      //    so the rest of the lifecycle can attach.
      if (
        eventType === "call.initiated" &&
        payload.direction === "outgoing" &&
        callControlId &&
        this.looksLikeSipFrom(payload.from)
      ) {
        await this.registerWebOriginCall(payload, callControlId);
      }

      // 3. Fork-leg answered (parallel-ring winner) — bridge + hang up loser
      if (
        eventType === "call.answered" &&
        callControlId &&
        this.decodeClientState(payload.client_state)?.kind === "fork_leg"
      ) {
        await this.resolveForkWinner(payload, callControlId);
      } else if (
        // 4. Outbound agent-first PSTN bridge (legacy 'phone' origin)
        eventType === "call.answered" &&
        payload.direction === "outgoing" &&
        callControlId &&
        !this.decodeClientState(payload.client_state)
      ) {
        await this.bridgeOutboundCustomer(callControlId);
      }

      // Persist + route every event into the normal CQRS pipeline (handles
      // status updates, missed-SMS, usage metering, Socket.IO call_state).
      await this.commandBus.execute(
        new ProcessWebhookCommand("telnyx", eventType, body, callControlId),
      );

      return res.status(HttpStatus.OK).send();
    } catch (error) {
      this.logger.error(
        `Telnyx status webhook failed: ${error.message}`,
        error.stack,
      );
      return res
        .status(HttpStatus.OK)
        .send({ accepted: false, error: error.message });
    }
  }

  @Post("telnyx/inbound")
  async handleTelnyxInbound(@Body() body: any, @Res() res: Response) {
    const payload = body.data?.payload || body.payload || body;
    try {
      await this.routeInboundTelnyxCall(payload);
      return res.status(HttpStatus.OK).send({ success: true });
    } catch (error) {
      this.logger.error(`Telnyx inbound failed: ${error.message}`);
      return res
        .status(HttpStatus.OK)
        .send({ success: false, error: error.message });
    }
  }

  @Post("telnyx/sms")
  async handleTelnyxSms(@Body() _body: any, @Res() res: Response) {
    return res.status(HttpStatus.OK).send();
  }

  // ============================================
  // INTERNAL — INBOUND PARALLEL RING
  // ============================================

  private async routeInboundTelnyxCall(payload: any): Promise<void> {
    const fromNumber = payload.from;
    const toNumber = payload.to;
    const callControlId = payload.call_control_id;

    if (!fromNumber || !toNumber || !callControlId) {
      throw new Error(
        `Inbound payload missing fields: from=${fromNumber} to=${toNumber} ccid=${callControlId}`,
      );
    }

    const phoneNumber = await this.prisma.phoneNumber.findUnique({
      where: { phoneNumber: toNumber },
    });
    if (!phoneNumber) {
      throw new Error(`Phone number not configured: ${toNumber}`);
    }

    const plan: InboundCallPlan = await this.commandBus.execute(
      new HandleInboundCallCommand(
        fromNumber,
        toNumber,
        callControlId,
        phoneNumber.workspaceId,
      ),
    );

    const provider = this.telephonyFactory.getProvider(
      "telnyx",
    ) as TelnyxProvider;

    // Busy-on-busy: agent already engaged. Hang up the inbound leg — the
    // CompleteCallHandler pipeline + the NO_ANSWER status set by the command
    // will trigger the missed-call SMS. Do not fork.
    if (plan.busy) {
      this.logger.log(
        `Inbound ${plan.callId}: agent busy, hanging up + queueing missed-SMS`,
      );
      await provider.hangup(callControlId);
      return;
    }

    // 1. Answer the inbound (anchor) leg so we can attach actions to it.
    await provider.executeCallControl(callControlId, { command: "answer" });

    // 2. Fork. Dial the cell number always; dial the SIP/web leg only if
    //    the agent has provisioned a credential and ringStrategy permits.
    const pstnConn = this.config.get<string>("TELNYX_CONNECTION_ID");
    const credConn = this.config.get<string>("TELNYX_CREDENTIAL_CONNECTION_ID");
    if (!pstnConn) {
      throw new Error("TELNYX_CONNECTION_ID not configured for inbound fork");
    }

    const wantsWebLeg =
      plan.ringStrategy !== "phone_first" && !!plan.agentSipUri && !!credConn;
    const wantsPhoneLeg = plan.ringStrategy !== "web_first";

    let webLegSid: string | null = null;
    let phoneLegSid: string | null = null;

    const dials: Promise<void>[] = [];

    if (wantsWebLeg) {
      dials.push(
        provider
          .dialForkLeg({
            from: toNumber,
            to: plan.agentSipUri!,
            connectionId: credConn!,
            anchorCallControlId: callControlId,
            timeoutSecs: plan.ringTimeout,
            leg: "web",
            callId: plan.callId,
          })
          .then(async (sid) => {
            webLegSid = sid;
          })
          .catch((err) =>
            this.logger.error(`Web leg dial failed: ${err.message}`),
          ),
      );
    }

    if (wantsPhoneLeg) {
      dials.push(
        provider
          .dialForkLeg({
            from: toNumber,
            to: plan.agentPhoneNumber,
            connectionId: pstnConn,
            anchorCallControlId: callControlId,
            timeoutSecs: plan.ringTimeout,
            leg: "phone",
            callId: plan.callId,
          })
          .then(async (sid) => {
            phoneLegSid = sid;
          })
          .catch((err) =>
            this.logger.error(`Phone leg dial failed: ${err.message}`),
          ),
      );
    }

    await Promise.all(dials);

    if (!webLegSid && !phoneLegSid) {
      this.logger.error(
        `Both fork legs failed for call ${plan.callId} — hanging up`,
      );
      await provider.hangup(callControlId);
      return;
    }

    await this.prisma.call.update({
      where: { id: plan.callId },
      data: {
        webLegSid,
        phoneLegSid,
        providerMetadata: {
          stage: "RINGING_FORK",
          anchorCallControlId: callControlId,
          webLegSid,
          phoneLegSid,
        } as any,
      },
    });
  }

  // ============================================
  // INTERNAL — FORK WINNER
  // ============================================

  private async resolveForkWinner(
    payload: any,
    callControlId: string,
  ): Promise<void> {
    const state = this.decodeClientState(payload.client_state);
    if (!state || state.kind !== "fork_leg") return;

    const call = await this.prisma.call.findUnique({
      where: { id: state.callId },
    });
    if (!call) {
      this.logger.warn(`Fork-leg answer: no call row for ${state.callId}`);
      return;
    }

    // Idempotency: another fork leg already won.
    if (call.answeredVia) {
      this.logger.debug(
        `Fork ${state.callId}: ${state.leg} answered after ${call.answeredVia} already won — hanging up loser`,
      );
      await (this.telephonyFactory.getProvider("telnyx") as TelnyxProvider).hangup(
        callControlId,
      );
      return;
    }

    const provider = this.telephonyFactory.getProvider(
      "telnyx",
    ) as TelnyxProvider;

    const winner = state.leg as "web" | "phone";
    const loserSid =
      winner === "web" ? call.phoneLegSid : call.webLegSid;

    // Atomic claim — first writer wins.
    const claim = await this.prisma.call.updateMany({
      where: { id: call.id, answeredVia: null },
      data: {
        answeredVia: winner,
        status: "IN_PROGRESS",
        answeredAt: new Date(),
      },
    });
    if (claim.count === 0) {
      // Lost the race — hang up our (losing) leg.
      await provider.hangup(callControlId);
      return;
    }

    // Bridge winner to the inbound anchor.
    try {
      await provider.bridge(state.anchor, callControlId);
    } catch (err) {
      this.logger.error(
        `Bridge failed for call ${call.id}: ${err.message}`,
      );
    }

    // Hang up the loser leg.
    if (loserSid) {
      await provider.hangup(loserSid);
    }

    await this.prisma.callEvent.create({
      data: {
        callId: call.id,
        eventType: winner === "web" ? "ANSWERED_ON_WEB" : "ANSWERED_ON_PHONE",
        timestamp: new Date(),
        payload: { winner, loserSid },
      },
    });

    this.gateway.emitToUser(call.agentId, "call_taken_elsewhere", {
      callId: call.id,
      answeredVia: winner,
    });
    this.gateway.emitToUser(call.agentId, "call_state", {
      callId: call.id,
      status: "IN_PROGRESS",
      answeredVia: winner,
    });
  }

  // ============================================
  // INTERNAL — OUTBOUND FROM WEB (SIP origin)
  // ============================================

  /**
   * When the browser's @telnyx/webrtc SDK places an outbound call, Telnyx
   * delivers `call.initiated` with direction=outgoing and `from` set to the
   * agent's SIP credential URI. We use that to identify the agent, upsert
   * the Lead by destination phone number, and create the Call row.
   */
  private async registerWebOriginCall(
    payload: any,
    callControlId: string,
  ): Promise<void> {
    // Skip if we already know this call (e.g. duplicate webhook).
    const existing = await this.prisma.call.findUnique({
      where: { providerCallSid: callControlId },
    });
    if (existing) return;

    const fromSip: string = payload.from;
    const toPhone: string = payload.to;
    if (!fromSip || !toPhone) return;

    const agent = await this.prisma.user.findFirst({
      where: { telnyxSipUri: fromSip },
      include: { assignedNumber: true },
    });
    if (!agent) {
      this.logger.warn(
        `SIP outbound from unknown agent ${fromSip} — ignoring`,
      );
      return;
    }
    if (!agent.assignedNumber) {
      this.logger.warn(
        `Agent ${agent.id} has no business number assigned — call may not be billable correctly`,
      );
    }

    let lead = await this.prisma.lead.findFirst({
      where: { phoneNumber: toPhone, workspaceId: agent.workspaceId },
    });
    if (!lead) {
      lead = await this.prisma.lead.create({
        data: { phoneNumber: toPhone, workspaceId: agent.workspaceId },
      });
    }

    if (!agent.assignedNumber) return;

    const call = await this.prisma.call.create({
      data: {
        providerCallSid: callControlId,
        direction: "OUTBOUND",
        status: "RINGING",
        fromNumber: agent.assignedNumber.phoneNumber,
        toNumber: toPhone,
        leadId: lead.id,
        agentId: agent.id,
        businessNumberId: agent.assignedNumber.id,
        agentPhoneNumber: agent.phoneNumber || agent.telnyxSipUri || "",
        customerNumber: toPhone,
        workspaceId: agent.workspaceId,
        origin: "web",
        initiatedAt: new Date(),
        ringingAt: new Date(),
        providerMetadata: { stage: "WEB_OUTBOUND", fromSip } as any,
      },
    });

    await this.prisma.callEvent.create({
      data: {
        callId: call.id,
        eventType: "CALL_INITIATED",
        timestamp: new Date(),
        payload: { direction: "OUTBOUND", origin: "web" },
        providerEventId: callControlId,
      },
    });

    this.gateway.emitToUser(agent.id, "call_state", {
      callId: call.id,
      status: "RINGING",
      direction: "OUTBOUND",
      origin: "web",
    });
  }

  // ============================================
  // INTERNAL — OUTBOUND AGENT-FIRST PSTN BRIDGE (legacy)
  // ============================================

  private async bridgeOutboundCustomer(callControlId: string): Promise<void> {
    const call = await this.prisma.call.findUnique({
      where: { providerCallSid: callControlId },
      include: { businessNumber: true },
    });
    if (!call || call.direction !== "OUTBOUND") return;

    const meta = (call.providerMetadata as any) || {};
    if (meta.stage !== "DIALING_AGENT") return;

    const customerNumber = meta.customerNumber || call.customerNumber;
    if (!customerNumber) {
      this.logger.error(
        `Outbound bridge failed — no customerNumber on call ${call.id}`,
      );
      return;
    }

    const provider = this.telephonyFactory.getProvider(
      "telnyx",
    ) as TelnyxProvider;

    try {
      await provider.executeCallControl(callControlId, {
        command: "transfer",
        to: customerNumber,
        from: call.businessNumber.phoneNumber,
        webhook_url: `${process.env.APP_URL}/webhooks/calling/telnyx/status`,
      });

      await this.prisma.call.update({
        where: { id: call.id },
        data: {
          providerMetadata: {
            ...meta,
            stage: "BRIDGING_CUSTOMER",
          } as any,
        },
      });

      await this.prisma.callEvent.create({
        data: {
          callId: call.id,
          eventType: "CUSTOMER_RINGING",
          timestamp: new Date(),
          payload: { customerNumber, stage: "BRIDGING_CUSTOMER" },
        },
      });
    } catch (error) {
      this.logger.error(
        `Outbound bridge FAILED for call ${call.id}: ${error.message}`,
      );
      try {
        await provider.hangup(callControlId);
      } catch {
        /* swallow */
      }
    }
  }

  // ============================================
  // HELPERS
  // ============================================

  private decodeClientState(
    raw: string | undefined,
  ): { kind: string; leg?: "web" | "phone"; anchor?: string; callId?: string } | null {
    if (!raw) return null;
    try {
      const json = Buffer.from(raw, "base64").toString("utf8");
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  private looksLikeSipFrom(from: string | undefined): boolean {
    return !!from && from.startsWith("sip:");
  }

  /**
   * Verify Telnyx Ed25519 webhook signature.
   *   header `telnyx-signature-ed25519` is base64 signature of
   *     `${timestamp}|${rawBody}`
   *   header `telnyx-timestamp`         is unix seconds
   * Public key (base64) comes from env `TELNYX_PUBLIC_KEY`.
   *
   * Falls open (returns true) when TELNYX_PUBLIC_KEY is unset, so local dev
   * + the first deploy can warm up. Production deployments MUST configure it.
   */
  private verifyTelnyxSignature(
    headers: Record<string, string | string[] | undefined>,
    req: Request,
    body: any,
  ): boolean {
    const pubB64 = this.config.get<string>("TELNYX_PUBLIC_KEY");
    if (!pubB64) return true;

    const sig =
      (headers["telnyx-signature-ed25519"] as string) ||
      (headers["Telnyx-Signature-Ed25519"] as string);
    const ts =
      (headers["telnyx-timestamp"] as string) ||
      (headers["Telnyx-Timestamp"] as string);
    if (!sig || !ts) return false;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(ts, 10)) > 300) {
      this.logger.warn("Telnyx webhook rejected: timestamp skew > 5min");
      return false;
    }

    const raw =
      (req as any).rawBody?.toString("utf8") ?? JSON.stringify(body);
    const message = `${ts}|${raw}`;
    try {
      const pub = Buffer.from(pubB64, "base64");
      const sigBytes = Buffer.from(sig, "base64");
      return nacl.sign.detached.verify(
        new Uint8Array(Buffer.from(message, "utf8")),
        new Uint8Array(sigBytes),
        new Uint8Array(pub),
      );
    } catch (err) {
      this.logger.warn(`Telnyx signature verify error: ${(err as Error).message}`);
      return false;
    }
  }
}
