import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosInstance } from "axios";
import {
  ITelephonyProvider,
  OutboundCallRequest,
  OutboundCallResponse,
  SendSmsRequest,
  SendSmsResponse,
  ProvisionNumberRequest,
  ProvisionNumberResponse,
} from "./telephony-provider.interface";

/**
 * Telnyx provider — implements full Call Control + Messaging + Number Order flows.
 *
 * What changed in this revision:
 *  1. Added executeCallControl(): used by the inbound webhook to actually
 *     `answer` and `transfer` an inbound call to the agent.  Without this,
 *     SOW #4 (inbound forwarding) never reached the agent's phone.
 *  2. provisionNumber(): proper 2-step search → number_orders flow per the
 *     Telnyx public API.  The previous code POSTed directly to /phone_numbers
 *     which 404'd — Telnyx does not expose that endpoint for purchase.
 *  3. sendSms(): unchanged (already correct), but documented the messaging
 *     profile id requirement so the missed-call SMS handler can rely on it.
 */
@Injectable()
export class TelnyxProvider implements ITelephonyProvider {
  private readonly logger = new Logger(TelnyxProvider.name);
  private client: AxiosInstance;
  private apiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>("TELNYX_API_KEY");

    if (!this.apiKey) {
      this.logger.warn("Telnyx API key not configured");
    } else {
      this.client = axios.create({
        baseURL: "https://api.telnyx.com/v2",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 15_000,
      });
    }
  }

  // ============================================
  // OUTBOUND
  // ============================================

  async initiateOutboundCall(
    request: OutboundCallRequest,
  ): Promise<OutboundCallResponse> {
    this.logger.debug(
      `Initiating outbound call from ${request.from} to ${request.to}`,
    );

    const response = await this.client.post("/calls", {
      connection_id: this.configService.get<string>("TELNYX_CONNECTION_ID"),
      to: request.to,
      from: request.from,
      webhook_url: request.callbackUrl,
      webhook_url_method: request.callbackMethod,
      timeout_secs: request.timeout || 30,
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
      direction: "outbound-api",
    };
  }

  // ============================================
  // INBOUND — Call Control
  // ============================================

  /**
   * The inbound webhook does NOT respond with TeXML.  Telnyx Voice API
   * (call-control flavor) drives calls by issuing JSON commands against
   * /v2/calls/{call_control_id}/actions/{action}.
   *
   * Flow for an inbound call:
   *   1. Telnyx → POST our /webhooks/calling/telnyx/inbound  (event: call.initiated)
   *   2. We:    POST /v2/calls/{id}/actions/answer
   *   3. Telnyx → POST our webhook again (event: call.answered)
   *   4. We:    POST /v2/calls/{id}/actions/transfer { to: agentPhone, timeout_secs: 25 }
   *   5. Telnyx dials the agent.  If no answer in 25s, Telnyx fires
   *      call.hangup with hangup_cause=originator_cancel — our
   *      CompleteCallHandler picks that up and triggers the missed-call SMS.
   */
  async executeCallControl(
    callControlId: string,
    command: {
      command: "answer" | "transfer" | "hangup" | "speak";
      to?: string;
      timeout_secs?: number;
      from?: string;
      webhook_url?: string;
      payload?: string; // for 'speak'
      voice?: string; // for 'speak'
      language?: string; // for 'speak'
    },
  ): Promise<void> {
    const { command: action, ...body } = command;

    this.logger.debug(
      `Call control ${action} on ${callControlId}: ${JSON.stringify(body)}`,
    );

    try {
      await this.client.post(`/calls/${callControlId}/actions/${action}`, body);
    } catch (error) {
      this.logger.error(
        `Call control ${action} failed for ${callControlId}: ${error.message}`,
      );
      throw error;
    }
  }

  // ============================================
  // SMS — used by missed-call auto-reply
  // ============================================

  async sendSms(request: SendSmsRequest): Promise<SendSmsResponse> {
    this.logger.debug(`Sending SMS from ${request.from} to ${request.to}`);

    const messagingProfileId = this.configService.get<string>(
      "TELNYX_MESSAGING_PROFILE_ID",
    );
    if (!messagingProfileId) {
      throw new Error(
        "TELNYX_MESSAGING_PROFILE_ID not set — missed-call SMS cannot be sent",
      );
    }

    const response = await this.client.post("/messages", {
      from: request.from,
      to: request.to,
      text: request.body,
      messaging_profile_id: messagingProfileId,
    });

    const message = response.data.data;
    this.logger.debug(`SMS sent with ID: ${message.id}`);

    return {
      sid: message.id,
      status: message.status || "queued",
    };
  }

  // ============================================
  // NUMBER PROVISIONING — search + order
  // ============================================

  /**
   * Telnyx's number purchase is a two-step API:
   *   1. GET  /v2/available_phone_numbers          → find candidates
   *   2. POST /v2/number_orders                    → place an order
   *
   * The previous implementation tried POST /v2/phone_numbers which is
   * NOT a purchase endpoint — that's why every call returned 404.
   */
  async provisionNumber(
    request: ProvisionNumberRequest,
  ): Promise<ProvisionNumberResponse> {
    this.logger.debug(
      `Provisioning number (areaCode=${request.areaCode}, country=${request.country || "US"})`,
    );

    // Step 1 — search
    const search = await this.client.get("/available_phone_numbers", {
      params: {
        "filter[national_destination_code]": request.areaCode,
        "filter[country_code]": request.country || "US",
        "filter[features][]": ["voice", "sms"],
        "filter[limit]": 5,
      },
    });

    const candidates: Array<{ phone_number: string }> = search.data.data || [];
    if (candidates.length === 0) {
      throw new Error(`No available numbers in area code ${request.areaCode}`);
    }

    // Step 2 — order the first candidate
    const order = await this.client.post("/number_orders", {
      phone_numbers: [{ phone_number: candidates[0].phone_number }],
      connection_id: this.configService.get<string>("TELNYX_CONNECTION_ID"),
      messaging_profile_id: this.configService.get<string>(
        "TELNYX_MESSAGING_PROFILE_ID",
      ),
    });

    const ordered = order.data.data;
    const orderedNumber = ordered.phone_numbers?.[0];

    if (!orderedNumber) {
      throw new Error("Number order succeeded but returned no phone number");
    }

    this.logger.log(`Number ordered: ${orderedNumber.phone_number}`);

    return {
      phoneNumber: orderedNumber.phone_number,
      sid: orderedNumber.id || ordered.id,
      capabilities: { voice: true, sms: true },
    };
  }

  async releaseNumber(phoneNumberId: string): Promise<void> {
    this.logger.debug(`Releasing number with ID: ${phoneNumberId}`);
    await this.client.delete(`/phone_numbers/${phoneNumberId}`);
  }

  // ============================================
  // WEBRTC — SIP CREDENTIALS + LOGIN TOKENS
  // ============================================

  /**
   * Provision a Telnyx SIP credential (a "telephony credential") for an
   * agent. The browser's @telnyx/webrtc client logs in with a short-lived
   * JWT minted from this credential (see createOnDemandJwt).
   *
   * The credential is owned by a Credential Connection — one shared
   * connection per workspace is fine. We tag the credential with the agent
   * UUID in `tag` so we can map it back.
   */
  async createCredential(params: {
    name: string;
    tag?: string;
  }): Promise<{ id: string; sipUsername: string }> {
    const connectionId = this.configService.get<string>(
      "TELNYX_CREDENTIAL_CONNECTION_ID",
    );
    if (!connectionId) {
      throw new Error("TELNYX_CREDENTIAL_CONNECTION_ID is not configured");
    }

    const response = await this.client.post("/telephony_credentials", {
      connection_id: connectionId,
      name: params.name,
      tag: params.tag,
    });

    const cred = response.data.data;
    this.logger.log(
      `Created Telnyx telephony credential ${cred.id} (sip_username=${cred.sip_username})`,
    );
    return { id: cred.id, sipUsername: cred.sip_username };
  }

  async deleteCredential(credentialId: string): Promise<void> {
    try {
      await this.client.delete(`/telephony_credentials/${credentialId}`);
    } catch (error) {
      this.logger.warn(
        `Failed to delete telephony credential ${credentialId}: ${error.message}`,
      );
    }
  }

  /**
   * Mint a short-lived (≤ 1 hr) JWT that the @telnyx/webrtc SDK uses to
   * register the browser as a SIP endpoint. The endpoint returns a plain
   * text JWT, not JSON.
   */
  async createOnDemandJwt(credentialId: string): Promise<string> {
    const response = await this.client.post(
      `/telephony_credentials/${credentialId}/token`,
      {},
      { responseType: "text", transformResponse: (v) => v },
    );
    return (response.data as string).trim();
  }

  // ============================================
  // PARALLEL-RING FORK
  // ============================================

  /**
   * Dial an outbound leg as part of a fork. The inbound anchor leg
   * (`anchorCallControlId`) is already answered; this places a new outbound
   * call. When that leg's call.answered webhook arrives, the webhook
   * controller bridges it to the anchor and hangs up the loser.
   *
   * We pass `client_state` so the webhook handler can tell parallel-ring
   * legs apart from other outbound calls.
   */
  async dialForkLeg(params: {
    from: string;
    to: string;
    connectionId: string;
    anchorCallControlId: string;
    timeoutSecs: number;
    leg: "web" | "phone";
    callId: string;
  }): Promise<string> {
    const clientState = Buffer.from(
      JSON.stringify({
        kind: "fork_leg",
        leg: params.leg,
        anchor: params.anchorCallControlId,
        callId: params.callId,
      }),
    ).toString("base64");

    const response = await this.client.post("/calls", {
      connection_id: params.connectionId,
      to: params.to,
      from: params.from,
      timeout_secs: params.timeoutSecs,
      webhook_url: `${this.configService.get<string>("APP_URL")}/webhooks/calling/telnyx/status`,
      client_state: clientState,
    });
    return response.data.data.call_control_id;
  }

  /**
   * Bridge two legs that are both already up (e.g. the inbound anchor and
   * the winning outbound fork leg).
   */
  async bridge(
    anchorCallControlId: string,
    targetCallControlId: string,
  ): Promise<void> {
    await this.client.post(`/calls/${anchorCallControlId}/actions/bridge`, {
      call_control_id: targetCallControlId,
    });
  }

  /**
   * Hang up a specific call leg. Used to cancel the losing fork leg as soon
   * as the winner is identified.
   */
  async hangup(callControlId: string): Promise<void> {
    try {
      await this.client.post(`/calls/${callControlId}/actions/hangup`, {});
    } catch (error) {
      // Already hung up / canceled — non-fatal.
      this.logger.debug(
        `hangup on ${callControlId} ignored: ${error.message}`,
      );
    }
  }

  // ============================================
  // WEBHOOK PARSING
  // ============================================

  parseWebhook(payload: any): {
    callSid: string;
    status: string;
    duration?: number;
    direction?: string;
    from?: string;
    to?: string;
  } {
    const data = payload.data || payload;
    const inner = data.payload || data;

    return {
      callSid: inner.call_control_id || inner.id,
      status: this.mapTelnyxStatus(
        data.event_type || inner.state || inner.status,
      ),
      duration: inner.duration_secs ?? inner.call_duration_secs,
      direction: inner.direction,
      from: inner.from,
      to: inner.to,
    };
  }

  /**
   * Map Telnyx event types and states onto the call statuses our DB uses.
   * Telnyx event types are like "call.initiated", "call.answered",
   * "call.hangup", with hangup_cause distinguishing busy/no-answer/failed.
   */
  private mapTelnyxStatus(input: string): string {
    if (!input) return "INITIATED";
    const v = input.toLowerCase();

    // Event types
    if (v.includes("call.initiated")) return "INITIATED";
    if (v.includes("call.bridged")) return "IN_PROGRESS";
    if (v.includes("call.answered")) return "ANSWERED";
    if (v.includes("call.hangup")) return "COMPLETED";

    // Raw states
    if (v === "parked" || v === "ringing") return "RINGING";
    if (v === "bridged") return "IN_PROGRESS";
    if (v === "answered") return "ANSWERED";
    if (v === "busy") return "BUSY";
    if (v === "no-answer" || v === "no_answer") return "NO_ANSWER";
    if (v === "failed") return "FAILED";
    if (v === "completed" || v === "hangup") return "COMPLETED";

    return "INITIATED";
  }
}
