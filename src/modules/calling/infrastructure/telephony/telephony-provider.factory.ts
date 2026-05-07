import { Injectable } from "@nestjs/common";
import { ITelephonyProvider } from "./telephony-provider.interface";
import { TelnyxProvider } from "./telnyx.provider";

/**
 * Telnyx is the only supported provider per the April 28 Discord update
 * ("Telynx is my provider / Use Telnyx only"). The factory is kept as a
 * thin indirection so handlers don't need to know the concrete class —
 * easier to swap or add a second provider later if needed without
 * touching every call site.
 */
@Injectable()
export class TelephonyProviderFactory {
  constructor(private readonly telnyxProvider: TelnyxProvider) {}

  getProvider(providerName?: string): ITelephonyProvider {
    const name = (providerName || "telnyx").toLowerCase();

    if (name !== "telnyx") {
      throw new Error(
        `Unsupported telephony provider: "${providerName}". This deployment is Telnyx-only.`,
      );
    }

    return this.telnyxProvider;
  }
}
