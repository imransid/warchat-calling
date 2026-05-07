// ============================================
// TELEPHONY PROVIDER INTERFACE — Telnyx only
// ============================================
//
// Inbound call handling is driven by Telnyx Call Control actions
// (executeCallControl on the concrete TelnyxProvider), not by returning a
// TwiML/TeXML XML body, so there is no `generateInboundCallResponse`
// method on this interface anymore.

export interface OutboundCallRequest {
  from: string; // Business number (caller ID)
  to: string; // Phone number to dial first (the agent)
  callbackUrl: string; // Webhook URL for status updates
  callbackMethod: "POST" | "GET";
  metadata?: Record<string, any>;
  timeout?: number;
}

export interface OutboundCallResponse {
  sid: string; // Provider call ID (Telnyx call_control_id)
  status: string;
  direction: string;
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
