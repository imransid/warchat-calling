import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/shared/database/prisma.service";
import { TelnyxProvider } from "../infrastructure/telephony/telnyx.provider";

export interface WebRtcLoginToken {
  loginToken: string;
  sipUri: string;
  expiresAt: string;
}

@Injectable()
export class WebRtcService {
  private readonly logger = new Logger(WebRtcService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telnyx: TelnyxProvider,
    private readonly config: ConfigService,
  ) {}

  /**
   * Issue a short-lived login JWT the browser's @telnyx/webrtc SDK uses to
   * register as a SIP endpoint. Creates the underlying Telnyx telephony
   * credential lazily on first request and stores it on the User row.
   */
  async getLoginToken(userId: string): Promise<WebRtcLoginToken> {
    let user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    try {
      if (!user.telnyxCredentialId) {
        const cred = await this.telnyx.createCredential({
          name: `warmchats-agent-${userId}`,
          tag: userId,
        });

        const sipDomain =
          this.config.get<string>("TELNYX_SIP_DOMAIN") ||
          "warmchats.sip.telnyx.com";

        user = await this.prisma.user.update({
          where: { id: userId },
          data: {
            telnyxCredentialId: cred.id,
            telnyxSipUri: `sip:${cred.sipUsername}@${sipDomain}`,
          },
        });
        this.logger.log(`Provisioned SIP credential for user ${userId}`);
      }

      const loginToken = await this.telnyx.createOnDemandJwt(
        user.telnyxCredentialId!,
      );

      // Telnyx on-demand tokens expire in ~1 hour. Frontend should refresh
      // before expiry. We don't decode the JWT here — caller can if needed.
      const expiresAt = new Date(Date.now() + 50 * 60 * 1000).toISOString();

      return {
        loginToken,
        sipUri: user.telnyxSipUri!,
        expiresAt,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Telnyx WebRTC login token could not be issued";

      this.logger.error(`WebRTC token error for user ${userId}: ${message}`);
      throw new ServiceUnavailableException(message);
    }
  }

  /**
   * Look up the SIP URI an inbound call should fork to (the web leg's
   * destination). Returns null if the agent has no credential yet — the
   * caller should fall back to phone-only ringing.
   */
  async getAgentSipUri(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return user?.telnyxSipUri || null;
  }
}
