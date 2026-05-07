import {
  Controller,
  Post,
  Body,
  Res,
  Logger,
  HttpStatus,
  Headers,
} from "@nestjs/common";
import { CommandBus } from "@nestjs/cqrs";
import { Response } from "express";
import {
  ProcessWebhookCommand,
  HandleInboundCallCommand,
} from "../commands/impl";
import { TelephonyProviderFactory } from "../infrastructure/telephony/telephony-provider.factory";
import { TelnyxProvider } from "../infrastructure/telephony/telnyx.provider";
import { PrismaService } from "@/shared/database/prisma.service";

/**
 * Webhook entry points for Telnyx (the only supported provider per the
 * April 28 Discord update).
 *
 * Inbound calls are driven via the Telnyx Call Control API:
 *   1. `call.initiated` (direction=incoming) → answer + transfer to agent
 *   2. `call.answered`  (direction=outgoing on the bridged leg) → noop
 *   3. `call.hangup`    → CompleteCallHandler triggers missed-SMS if needed
 *
 * Outbound calls follow the agent-first dial pattern:
 *   1. InitiateOutboundCallHandler dials the AGENT first.
 *   2. On `call.answered` (direction=outgoing), this controller issues a
 *      `transfer` action that bridges the customer in, with the business
 *      number set as caller ID (number masking).
 *   3. On `call.hangup`, CompleteCallHandler closes the call and updates
 *      usage metering.
 */
@Controller("webhooks/calling")
export class CallingWebhookController {
  private readonly logger = new Logger(CallingWebhookController.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly telephonyFactory: TelephonyProviderFactory,
    private readonly prisma: PrismaService,
  ) {}

  // ============================================
  // TELNYX
  // ============================================

  /**
   * Single status webhook receives ALL Telnyx call events
   * (initiated, answered, bridged, hangup, etc.) for both inbound and
   * outbound calls. The ProcessWebhookHandler then routes them to the
   * appropriate command (CompleteCall, etc.).
   *
   * In addition we drive the Call Control API inline here:
   *   - on inbound  call.initiated  → answer + transfer to agent
   *   - on outbound call.answered   → transfer to bridge customer
   *   - on          call.hangup     → ProcessWebhookCommand handles missed-SMS
   */
  @Post("telnyx/status")
  async handleTelnyxStatus(
    @Body() body: any,
    @Headers() _headers: any,
    @Res() res: Response,
  ) {
    const eventType: string =
      body.data?.event_type || body.event_type || "unknown";
    const payload = body.data?.payload || body.payload || {};
    const callControlId: string =
      payload.call_control_id || body.data?.call_control_id;

    this.logger.debug(`Telnyx event: ${eventType} (${callControlId})`);

    try {
      // Inbound forwarding — Telnyx delivers inbound calls as
      // "call.initiated" with direction=incoming on the status webhook.
      if (
        eventType === "call.initiated" &&
        payload.direction === "incoming" &&
        callControlId
      ) {
        await this.routeInboundTelnyxCall(payload);
      }

      // Outbound bridge — when the agent leg of an outbound call is
      // answered, dial the customer and bridge them in. Without this, the
      // agent picks up to silence and the customer is never reached.
      if (
        eventType === "call.answered" &&
        payload.direction === "outgoing" &&
        callControlId
      ) {
        await this.bridgeOutboundCustomer(callControlId);
      }

      // Persist + route every event into the normal pipeline
      await this.commandBus.execute(
        new ProcessWebhookCommand("telnyx", eventType, body, callControlId),
      );

      return res.status(HttpStatus.OK).send();
    } catch (error) {
      this.logger.error(
        `Telnyx status webhook failed: ${error.message}`,
        error.stack,
      );
      // Always 200 so Telnyx doesn't keep retrying on app-level errors —
      // the WebhookLog row tracks the failure and BullMQ will retry.
      return res
        .status(HttpStatus.OK)
        .send({ accepted: false, error: error.message });
    }
  }

  /**
   * Some Telnyx setups also POST inbound calls to a dedicated /inbound URL
   * configured on the messaging/voice profile. Treat it the same way.
   */
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
  async handleTelnyxSms(@Body() body: any, @Res() res: Response) {
    this.logger.debug(`Telnyx inbound SMS event`);
    // Inbound SMS handled by the messaging module.
    return res.status(HttpStatus.OK).send();
  }

  // ============================================
  // INTERNAL
  // ============================================

  /**
   * Drive the Telnyx Call Control flow for an inbound call:
   *   1. answer
   *   2. record DB row + look up the agent
   *   3. transfer to agent's real phone with ringTimeout
   *
   * If the agent doesn't pick up within the timeout, Telnyx emits
   * call.hangup with hangup_cause=originator_cancel — that path is
   * handled downstream by CompleteCallHandler which fires the missed-
   * call SMS via SendMissedCallSmsCommand.
   */
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

    // Persist the inbound call + look up the agent + ring timeout
    const result = await this.commandBus.execute(
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

    // 1. Answer the inbound leg so we can attach actions to it
    await provider.executeCallControl(callControlId, { command: "answer" });

    // 2. Transfer to the agent's real phone with the configured ring timeout.
    //    Telnyx will fire call.hangup with hangup_cause if the agent never
    //    picks up — the missed-call SMS pipeline handles that.
    await provider.executeCallControl(callControlId, {
      command: "transfer",
      to: result.forwardTo,
      from: toNumber, // preserve business-number caller ID for the agent leg
      timeout_secs: result.timeout,
      webhook_url: `${process.env.APP_URL}/webhooks/calling/telnyx/status`,
    });
  }

  /**
   * SOW #3 — Click-to-Call (Outbound):
   *
   *   "Agent clicks 'Call' on a lead. The system rings the agent's real
   *    phone first; once the agent answers, the system bridges the
   *    customer in."
   *
   * Step-by-step:
   *   1. InitiateOutboundCallHandler dials the AGENT first via Telnyx.
   *   2. Telnyx fires call.answered when the agent picks up.
   *   3. We look up the call by providerCallSid, read the customerNumber
   *      we stashed in providerMetadata, and issue a `transfer` action
   *      against the same call_control_id. Telnyx then dials the customer
   *      and bridges both legs — customer sees the business number as
   *      caller ID (because that's the `from` we pass).
   *
   * If the customer never picks up, Telnyx emits call.hangup with the
   * appropriate hangup_cause and CompleteCallHandler closes the call out.
   */
  private async bridgeOutboundCustomer(callControlId: string): Promise<void> {
    const call = await this.prisma.call.findUnique({
      where: { providerCallSid: callControlId },
      include: { businessNumber: true },
    });

    if (!call) {
      this.logger.warn(
        `Outbound bridge skipped — no call row for ${callControlId}`,
      );
      return;
    }

    if (call.direction !== "OUTBOUND") return;

    const meta = (call.providerMetadata as any) || {};
    if (meta.stage !== "DIALING_AGENT") {
      // Already bridged (or in some other stage) — don't double-transfer.
      return;
    }

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
        from: call.businessNumber.phoneNumber, // Number masking — customer sees business number
        webhook_url: `${process.env.APP_URL}/webhooks/calling/telnyx/status`,
      });

      // Mark the stage so we don't bridge twice if a duplicate webhook fires.
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
          payload: {
            customerNumber,
            stage: "BRIDGING_CUSTOMER",
          },
        },
      });

      this.logger.log(
        `Outbound bridge: dialing customer ${customerNumber} for call ${call.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Outbound bridge FAILED for call ${call.id}: ${error.message}`,
      );
      // Tear the call down so the agent isn't stuck on a dead leg.
      try {
        await provider.executeCallControl(callControlId, {
          command: "hangup",
        });
      } catch {
        /* swallow */
      }
    }
  }
}
