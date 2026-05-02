import {
  Controller,
  Post,
  Body,
  Param,
  Res,
  Logger,
  HttpStatus,
  Headers,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { Response } from 'express';
import { ProcessWebhookCommand, HandleInboundCallCommand } from '../commands/impl';
import { TelephonyProviderFactory } from '../infrastructure/telephony/telephony-provider.factory';
import { PrismaService } from '@/shared/database/prisma.service';

@Controller('webhooks/calling')
export class CallingWebhookController {
  private readonly logger = new Logger(CallingWebhookController.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly telephonyFactory: TelephonyProviderFactory,
    private readonly prisma: PrismaService,
  ) {}

  // ============================================
  // TWILIO WEBHOOKS
  // ============================================

  @Post('twilio/status')
  async handleTwilioStatus(
    @Body() body: any,
    @Headers() headers: any,
    @Res() res: Response,
  ) {
    this.logger.debug(`Received Twilio status webhook: ${body.CallStatus}`);

    try {
      // TODO: Verify Twilio signature for security
      // const signature = headers['x-twilio-signature'];
      // this.verifyTwilioSignature(signature, body);

      await this.commandBus.execute(
        new ProcessWebhookCommand(
          'twilio',
          body.CallStatus,
          body,
          body.CallSid,
        ),
      );

      return res.status(HttpStatus.OK).send();
    } catch (error) {
      this.logger.error(`Failed to process Twilio webhook: ${error.message}`);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send();
    }
  }

  @Post('twilio/inbound')
  async handleTwilioInbound(
    @Body() body: any,
    @Res() res: Response,
  ) {
    this.logger.debug(`Received Twilio inbound call: ${body.From} -> ${body.To}`);

    try {
      // Find workspace by phone number
      const phoneNumber = await this.prisma.phoneNumber.findUnique({
        where: { phoneNumber: body.To },
        include: { workspace: true },
      });

      if (!phoneNumber) {
        this.logger.error(`Phone number not found: ${body.To}`);
        return res.status(HttpStatus.NOT_FOUND).send(
          '<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not configured.</Say><Hangup/></Response>',
        );
      }

      // Handle inbound call
      const result = await this.commandBus.execute(
        new HandleInboundCallCommand(
          body.From,
          body.To,
          body.CallSid,
          phoneNumber.workspaceId,
        ),
      );

      // Generate TwiML response to forward the call
      const provider = this.telephonyFactory.getProvider('twilio');
      const response = provider.generateInboundCallResponse({
        forwardTo: result.forwardTo,
        timeout: result.timeout,
        callbackUrl: `${process.env.APP_URL}/webhooks/calling/twilio/status`,
      });

      return res
        .status(HttpStatus.OK)
        .header('Content-Type', 'text/xml')
        .send(response.xml);
    } catch (error) {
      this.logger.error(`Failed to handle inbound call: ${error.message}`);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say>An error occurred.</Say><Hangup/></Response>',
      );
    }
  }

  @Post('twilio/sms')
  async handleTwilioSms(
    @Body() body: any,
    @Res() res: Response,
  ) {
    this.logger.debug(`Received Twilio SMS: ${body.From} -> ${body.To}`);

    // TODO: Handle incoming SMS
    // This would be used for lead replies to missed-call SMS

    return res.status(HttpStatus.OK).send();
  }

  // ============================================
  // TELNYX WEBHOOKS
  // ============================================

  @Post('telnyx/status')
  async handleTelnyxStatus(
    @Body() body: any,
    @Headers() headers: any,
    @Res() res: Response,
  ) {
    this.logger.debug(`Received Telnyx webhook: ${body.data?.event_type}`);

    try {
      // TODO: Verify Telnyx signature for security
      // const signature = headers['telnyx-signature-ed25519'];
      // this.verifyTelnyxSignature(signature, body);

      const eventType = body.data?.event_type || body.event_type;
      const callControlId = body.data?.payload?.call_control_id || body.data?.call_control_id;

      await this.commandBus.execute(
        new ProcessWebhookCommand(
          'telnyx',
          eventType,
          body,
          callControlId,
        ),
      );

      return res.status(HttpStatus.OK).send();
    } catch (error) {
      this.logger.error(`Failed to process Telnyx webhook: ${error.message}`);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send();
    }
  }

  @Post('telnyx/inbound')
  async handleTelnyxInbound(
    @Body() body: any,
    @Res() res: Response,
  ) {
    this.logger.debug(`Received Telnyx inbound call`);

    try {
      const payload = body.data?.payload || body.payload;
      const from = payload.from;
      const to = payload.to;
      const callControlId = payload.call_control_id;

      // Find workspace by phone number
      const phoneNumber = await this.prisma.phoneNumber.findUnique({
        where: { phoneNumber: to },
        include: { workspace: true },
      });

      if (!phoneNumber) {
        this.logger.error(`Phone number not found: ${to}`);
        return res.status(HttpStatus.NOT_FOUND).send({ error: 'Number not configured' });
      }

      // Handle inbound call
      const result = await this.commandBus.execute(
        new HandleInboundCallCommand(
          from,
          to,
          callControlId,
          phoneNumber.workspaceId,
        ),
      );

      // Use Telnyx call control API to forward the call
      const provider = this.telephonyFactory.getProvider('telnyx') as any;
      
      await provider.executeCallControl(callControlId, {
        command: 'transfer',
        to: result.forwardTo,
        timeout_secs: result.timeout,
      });

      return res.status(HttpStatus.OK).send({ success: true });
    } catch (error) {
      this.logger.error(`Failed to handle inbound call: ${error.message}`);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({ error: error.message });
    }
  }

  @Post('telnyx/sms')
  async handleTelnyxSms(
    @Body() body: any,
    @Res() res: Response,
  ) {
    this.logger.debug(`Received Telnyx SMS webhook`);

    // TODO: Handle incoming SMS

    return res.status(HttpStatus.OK).send();
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  private verifyTwilioSignature(signature: string, body: any): boolean {
    // TODO: Implement Twilio signature verification
    // Using twilio.validateRequest()
    return true;
  }

  private verifyTelnyxSignature(signature: string, body: any): boolean {
    // TODO: Implement Telnyx signature verification
    // Using Ed25519 signature verification
    return true;
  }
}
