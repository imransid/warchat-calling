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
 * Webhook entry points for telephony providers.
 *
 * Critical change: the Telnyx inbound flow now drives the call with the
 * Call Control API (answer, then transfer), rather than returning a JSON
 * blob the provider never reads.  Without this, an inbound call to the
 * business number never reached the agent's phone.
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
  // TWILIO (kept for parity)
  // ============================================

  @Post("twilio/status")
  async handleTwilioStatus(
    @Body() body: any,
    @Headers() _headers: any,
    @Res() res: Response,
  ) {
    this.logger.debug(`Twilio status: ${body.CallStatus}`);
    try {
      await this.commandBus.execute(
        new ProcessWebhookCommand(
          "twilio",
          body.CallStatus,
          body,
          body.CallSid,
        ),
      );
      return res.status(HttpStatus.OK).send();
    } catch (error) {
      this.logger.error(`Twilio status webhook failed: ${error.message}`);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send();
    }
  }

  @Post("twilio/inbound")
  async handleTwilioInbound(@Body() body: any, @Res() res: Response) {
    this.logger.debug(`Twilio inbound: ${body.From} -> ${body.To}`);

    try {
      const phoneNumber = await this.prisma.phoneNumber.findUnique({
        where: { phoneNumber: body.To },
        include: { workspace: true },
      });

      if (!phoneNumber) {
        return res
          .status(HttpStatus.NOT_FOUND)
          .header("Content-Type", "text/xml")
          .send(
            '<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not configured.</Say><Hangup/></Response>',
          );
      }

      const result = await this.commandBus.execute(
        new HandleInboundCallCommand(
          body.From,
          body.To,
          body.CallSid,
          phoneNumber.workspaceId,
        ),
      );

      const provider = this.telephonyFactory.getProvider("twilio");
      const response = provider.generateInboundCallResponse({
        forwardTo: result.forwardTo,
        timeout: result.timeout,
        callbackUrl: `${process.env.APP_URL}/webhooks/calling/twilio/status`,
      });

      return res
        .status(HttpStatus.OK)
        .header("Content-Type", "text/xml")
        .send(response.xml);
    } catch (error) {
      this.logger.error(`Twilio inbound failed: ${error.message}`);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .header("Content-Type", "text/xml")
        .send(
          '<?xml version="1.0" encoding="UTF-8"?><Response><Say>An error occurred.</Say><Hangup/></Response>',
        );
    }
  }

  @Post("twilio/sms")
  async handleTwilioSms(@Body() body: any, @Res() res: Response) {
    this.logger.debug(`Twilio inbound SMS: ${body.From} -> ${body.To}`);
    // Inbound SMS handling is delegated to the messaging module (out of scope here).
    return res.status(HttpStatus.OK).send();
  }

  // ============================================
  // TELNYX
  // ============================================

  /**
   * Single status webhook receives ALL Telnyx call events
   * (initiated, answered, bridged, hangup, etc.) for both inbound and
   * outbound calls.  The ProcessWebhookHandler then routes them to the
   * appropriate command (CompleteCall, etc.)
   *
   * For inbound calls we additionally drive the Call Control API here:
   *   - on call.initiated  → answer + transfer to agent
   *   - on call.hangup     → ProcessWebhookCommand handles missed-SMS
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
      // Drive inbound forwarding — Telnyx delivers inbound calls as
      // "call.initiated" with direction=incoming on the status webhook.
      if (
        eventType === "call.initiated" &&
        payload.direction === "incoming" &&
        callControlId
      ) {
        await this.routeInboundTelnyxCall(payload);
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
   * configured on the messaging/voice profile.  Treat it the same way.
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
}
