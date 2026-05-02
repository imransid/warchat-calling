// ============================================
// TELEPHONY PROVIDER INTERFACE
// ============================================

export interface OutboundCallRequest {
  from: string; // Business number
  to: string; // Phone number to dial
  callbackUrl: string; // Webhook URL for status updates
  callbackMethod: 'POST' | 'GET';
  metadata?: Record<string, any>;
  timeout?: number;
}

export interface OutboundCallResponse {
  sid: string; // Provider call ID
  status: string;
  direction: string;
}

export interface InboundCallResponse {
  xml: string; // TwiML or TeXML response
}

export interface SendSmsRequest {
  from: string;
  to: string;
  body: string;
}

export interface SendSmsResponse {
  sid: string;
  status: string;
}

export interface ProvisionNumberRequest {
  areaCode?: string;
  country?: string;
  capabilities?: {
    voice?: boolean;
    sms?: boolean;
  };
}

export interface ProvisionNumberResponse {
  phoneNumber: string;
  sid: string;
  capabilities: {
    voice: boolean;
    sms: boolean;
  };
}

export abstract class ITelephonyProvider {
  abstract initiateOutboundCall(
    request: OutboundCallRequest,
  ): Promise<OutboundCallResponse>;

  abstract generateInboundCallResponse(params: {
    forwardTo: string;
    timeout: number;
    callbackUrl: string;
  }): InboundCallResponse;

  abstract sendSms(request: SendSmsRequest): Promise<SendSmsResponse>;

  abstract provisionNumber(
    request: ProvisionNumberRequest,
  ): Promise<ProvisionNumberResponse>;

  abstract releaseNumber(phoneNumberSid: string): Promise<void>;

  abstract parseWebhook(payload: any): {
    callSid: string;
    status: string;
    duration?: number;
    direction?: string;
    from?: string;
    to?: string;
  };
}
