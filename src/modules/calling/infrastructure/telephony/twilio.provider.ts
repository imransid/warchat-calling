import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Twilio from 'twilio';
import {
  ITelephonyProvider,
  OutboundCallRequest,
  OutboundCallResponse,
  InboundCallResponse,
  SendSmsRequest,
  SendSmsResponse,
  ProvisionNumberRequest,
  ProvisionNumberResponse,
} from './telephony-provider.interface';

@Injectable()
export class TwilioProvider implements ITelephonyProvider {
  private readonly logger = new Logger(TwilioProvider.name);
  private client: Twilio.Twilio;

  constructor(private readonly configService: ConfigService) {
    const accountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID');
    const authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN');

    if (!accountSid || !authToken) {
      this.logger.warn('Twilio credentials not configured');
    } else {
      this.client = Twilio(accountSid, authToken);
    }
  }

  async initiateOutboundCall(
    request: OutboundCallRequest,
  ): Promise<OutboundCallResponse> {
    this.logger.debug(`Initiating outbound call from ${request.from} to ${request.to}`);

    try {
      const call = await this.client.calls.create({
        from: request.from,
        to: request.to,
        url: request.callbackUrl,
        method: request.callbackMethod,
        statusCallback: request.callbackUrl,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
        timeout: request.timeout || 30,
        // Pass metadata in URL parameters
        ...(request.metadata && {
          url: `${request.callbackUrl}?${new URLSearchParams(
            Object.entries(request.metadata).map(([k, v]) => [k, String(v)]),
          )}`,
        }),
      });

      this.logger.debug(`Call initiated with SID: ${call.sid}`);

      return {
        sid: call.sid,
        status: call.status,
        direction: call.direction,
      };
    } catch (error) {
      this.logger.error(`Failed to initiate call: ${error.message}`, error.stack);
      throw error;
    }
  }

  generateInboundCallResponse(params: {
    forwardTo: string;
    timeout: number;
    callbackUrl: string;
  }): InboundCallResponse {
    const { forwardTo, timeout, callbackUrl } = params;

    // Generate TwiML to forward the call
    const twiml = new Twilio.twiml.VoiceResponse();

    twiml.dial({
      callerId: undefined, // Will use the caller ID from the inbound call
      timeout,
      action: callbackUrl,
      method: 'POST',
    }, forwardTo);

    return {
      xml: twiml.toString(),
    };
  }

  async sendSms(request: SendSmsRequest): Promise<SendSmsResponse> {
    this.logger.debug(`Sending SMS from ${request.from} to ${request.to}`);

    try {
      const message = await this.client.messages.create({
        from: request.from,
        to: request.to,
        body: request.body,
      });

      this.logger.debug(`SMS sent with SID: ${message.sid}`);

      return {
        sid: message.sid,
        status: message.status,
      };
    } catch (error) {
      this.logger.error(`Failed to send SMS: ${error.message}`, error.stack);
      throw error;
    }
  }

  async provisionNumber(
    request: ProvisionNumberRequest,
  ): Promise<ProvisionNumberResponse> {
    this.logger.debug(`Provisioning number with area code: ${request.areaCode}`);

    try {
      // Search for available numbers
      const areaCode =
        request.areaCode != null && request.areaCode !== ''
          ? parseInt(String(request.areaCode).replace(/\D/g, ''), 10)
          : undefined;

      const availableNumbers = await this.client
        .availablePhoneNumbers(request.country || 'US')
        .local.list({
          ...(areaCode != null && !Number.isNaN(areaCode) ? { areaCode } : {}),
          voiceEnabled: request.capabilities?.voice !== false,
          smsEnabled: request.capabilities?.sms !== false,
          limit: 1,
        });

      if (availableNumbers.length === 0) {
        throw new Error('No available numbers found');
      }

      const selectedNumber = availableNumbers[0];

      // Purchase the number
      const purchasedNumber = await this.client.incomingPhoneNumbers.create({
        phoneNumber: selectedNumber.phoneNumber,
        voiceUrl: `${process.env.APP_URL}/webhooks/calling/twilio/inbound`,
        voiceMethod: 'POST',
        smsUrl: `${process.env.APP_URL}/webhooks/calling/twilio/sms`,
        smsMethod: 'POST',
      });

      this.logger.debug(`Number provisioned: ${purchasedNumber.phoneNumber}`);

      return {
        phoneNumber: purchasedNumber.phoneNumber,
        sid: purchasedNumber.sid,
        capabilities: {
          voice: purchasedNumber.capabilities.voice,
          sms: purchasedNumber.capabilities.sms,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to provision number: ${error.message}`, error.stack);
      throw error;
    }
  }

  async releaseNumber(phoneNumberSid: string): Promise<void> {
    this.logger.debug(`Releasing number with SID: ${phoneNumberSid}`);

    try {
      await this.client.incomingPhoneNumbers(phoneNumberSid).remove();
      this.logger.debug(`Number released: ${phoneNumberSid}`);
    } catch (error) {
      this.logger.error(`Failed to release number: ${error.message}`, error.stack);
      throw error;
    }
  }

  parseWebhook(payload: any): {
    callSid: string;
    status: string;
    duration?: number;
    direction?: string;
    from?: string;
    to?: string;
  } {
    // Twilio webhook payload structure
    return {
      callSid: payload.CallSid,
      status: this.mapTwilioStatus(payload.CallStatus),
      duration: payload.CallDuration ? parseInt(payload.CallDuration, 10) : undefined,
      direction: payload.Direction,
      from: payload.From,
      to: payload.To,
    };
  }

  private mapTwilioStatus(twilioStatus: string): string {
    // Map Twilio statuses to our internal statuses
    const statusMap: Record<string, string> = {
      'queued': 'INITIATED',
      'initiated': 'INITIATED',
      'ringing': 'RINGING',
      'in-progress': 'IN_PROGRESS',
      'completed': 'COMPLETED',
      'busy': 'BUSY',
      'no-answer': 'NO_ANSWER',
      'failed': 'FAILED',
      'canceled': 'CANCELED',
    };

    return statusMap[twilioStatus] || twilioStatus.toUpperCase();
  }
}
