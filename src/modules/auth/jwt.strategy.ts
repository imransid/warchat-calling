import { Injectable, UnauthorizedException, Logger } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ConfigService } from "@nestjs/config";
import { ExtractJwt, Strategy } from "passport-jwt";
import { UserSyncService } from "./user-sync.service";

export interface JwtPayload {
  sub: string;
  org_id: string;
  role?: string;
  session_id?: string;
  type?: string;
  exp?: number;
  iat?: number;
}

export interface AuthenticatedUser {
  id: string;
  workspaceId: string;
  role: string;
  sessionId?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    config: ConfigService,
    private readonly userSync: UserSyncService,
  ) {
    const secret = config.get<string>("JWT_SECRET_KEY");
    if (!secret) {
      throw new Error(
        "JWT_SECRET_KEY is not configured. It must match the Flask main API's value.",
      );
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
      algorithms: ["HS256"],
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (payload.type && payload.type !== "access") {
      throw new UnauthorizedException("Refresh tokens cannot be used here");
    }
    if (!payload.sub || !payload.org_id) {
      throw new UnauthorizedException("Token missing sub or org_id claim");
    }

    await this.userSync.ensure(payload.sub, payload.org_id);

    return {
      id: payload.sub,
      workspaceId: payload.org_id,
      role: payload.role || "Representative",
      sessionId: payload.session_id,
    };
  }
}
