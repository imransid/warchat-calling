import { Injectable } from '@nestjs/common';
import { ITelephonyProvider } from './telephony-provider.interface';
import { TwilioProvider } from './twilio.provider';
import { TelnyxProvider } from './telnyx.provider';

@Injectable()
export class TelephonyProviderFactory {
  constructor(
    private readonly twilioProvider: TwilioProvider,
    private readonly telnyxProvider: TelnyxProvider,
  ) {}

  getProvider(providerName: string): ITelephonyProvider {
    switch (providerName.toLowerCase()) {
      case 'twilio':
        return this.twilioProvider;
      case 'telnyx':
        return this.telnyxProvider;
      default:
        throw new Error(`Unknown telephony provider: ${providerName}`);
    }
  }
}
