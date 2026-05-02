import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
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
export class TelnyxProvider implements ITelephonyProvider {
  private readonly logger = new Logger(TelnyxProvider.name);
  private client: AxiosInstance;
  private apiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('TELNYX_API_KEY');

    if (!this.apiKey) {
      this.logger.warn('Telnyx API key not configured');
    } else {
      this.client = axios.create({
        baseURL: 'https://api.telnyx.com/v2',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });
    }
  }

  async initiateOutboundCall(
    request: OutboundCallRequest,
  ): Promise<OutboundCallResponse> {
    this.logger.debug(`Initiating outbound call from ${request.from} to ${request.to}`);

    try {
      const response = await this.client.post('/calls', {
        connection_id: this.configService.get<string>('TELNYX_CONNECTION_ID'),
        to: request.to,
        from: request.from,
        webhook_url: request.callbackUrl,
        webhook_url_method: request.callbackMethod,
        timeout_secs: request.timeout || 30,
        // Telnyx uses custom headers for metadata
        custom_headers: request.metadata
          ? Object.entries(request.metadata).map(([name, value]) => ({
              name: `X-Metadata-${name}`,
              value: String(value),
            }))
          : undefined,
      });

      const call = response.data.data;

      this.logger.debug(`Call initiated with ID: ${call.call_control_id}`);

      return {
        sid: call.call_control_id,
        status: this.mapTelnyxStatus(call.state),
        direction: 'outbound-api',
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

    // Telnyx uses JSON commands, not XML
    // We'll return a JSON structure that the webhook handler will use
    const commands = {
      type: 'dial',
      to: forwardTo,
      timeout_secs: timeout,
      webhook_url: callbackUrl,
      webhook_url_method: 'POST',
    };

    // For consistency with Twilio, we'll wrap it
    return {
      xml: JSON.stringify(commands),
    };
  }

  async sendSms(request: SendSmsRequest): Promise<SendSmsResponse> {
    this.logger.debug(`Sending SMS from ${request.from} to ${request.to}`);

    try {
      const response = await this.client.post('/messages', {
        from: request.from,
        to: request.to,
        text: request.body,
        messaging_profile_id: this.configService.get<string>(
          'TELNYX_MESSAGING_PROFILE_ID',
        ),
      });

      const message = response.data.data;

      this.logger.debug(`SMS sent with ID: ${message.id}`);

      return {
        sid: message.id,
        status: message.status || 'queued',
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
      const searchResponse = await this.client.get('/available_phone_numbers', {
        params: {
          'filter[national_destination_code]': request.areaCode,
          'filter[features][]': ['voice', 'sms'],
          'filter[limit]': 1,
        },
      });

      const availableNumbers = searchResponse.data.data;

      if (availableNumbers.length === 0) {
        throw new Error('No available numbers found');
      }

      const selectedNumber = availableNumbers[0];

      // Purchase the number
      const purchaseResponse = await this.client.post('/phone_numbers', {
        phone_number: selectedNumber.phone_number,
        connection_id: this.configService.get<string>('TELNYX_CONNECTION_ID'),
        messaging_profile_id: this.configService.get<string>(
          'TELNYX_MESSAGING_PROFILE_ID',
        ),
      });

      const purchasedNumber = purchaseResponse.data.data;

      this.logger.debug(`Number provisioned: ${purchasedNumber.phone_number}`);

      return {
        phoneNumber: purchasedNumber.phone_number,
        sid: purchasedNumber.id,
        capabilities: {
          voice: true,
          sms: true,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to provision number: ${error.message}`, error.stack);
      throw error;
    }
  }

  async releaseNumber(phoneNumberId: string): Promise<void> {
    this.logger.debug(`Releasing number with ID: ${phoneNumberId}`);

    try {
      await this.client.delete(`/phone_numbers/${phoneNumberId}`);
      this.logger.debug(`Number released: ${phoneNumberId}`);
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
    // Telnyx webhook payload structure
    const data = payload.data || payload;

    return {
      callSid: data.call_control_id || data.id,
      status: this.mapTelnyxStatus(data.state || data.status),
      duration: data.duration_secs,
      direction: data.direction,
      from: data.from,
      to: data.to,
    };
  }

  private mapTelnyxStatus(telnyxStatus: string): string {
    // Map Telnyx statuses to our internal statuses
    const statusMap: Record<string, string> = {
      'parked': 'INITIATED',
      'initiated': 'INITIATED',
      'ringing': 'RINGING',
      'answered': 'IN_PROGRESS',
      'active': 'IN_PROGRESS',
      'bridging': 'IN_PROGRESS',
      'bridged': 'IN_PROGRESS',
      'hangup': 'COMPLETED',
      'busy': 'BUSY',
      'no_answer': 'NO_ANSWER',
      'failed': 'FAILED',
      'cancelled': 'CANCELED',
    };

    return statusMap[telnyxStatus] || telnyxStatus.toUpperCase();
  }

  // Telnyx-specific: Execute call control commands
  async executeCallControl(callControlId: string, command: any): Promise<void> {
    this.logger.debug(`Executing call control command: ${command.command}`);

    try {
      await this.client.post(`/calls/${callControlId}/actions/${command.command}`, command);
    } catch (error) {
      this.logger.error(`Failed to execute call control: ${error.message}`, error.stack);
      throw error;
    }
  }
}
