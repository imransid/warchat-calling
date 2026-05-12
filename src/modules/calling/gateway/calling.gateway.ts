import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from "@nestjs/websockets";
import { Logger, Injectable } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import { JwtService } from "@nestjs/jwt";
import { CommandBus } from "@nestjs/cqrs";
import { ConfigService } from "@nestjs/config";
import { UserSyncService } from "@/modules/auth/user-sync.service";
import { JwtPayload } from "@/modules/auth/jwt.strategy";

interface CallSocket extends Socket {
  data: {
    userId: string;
    workspaceId: string;
    role: string;
  };
}

/**
 * Real-time signaling for the calling feature.
 *
 * Events emitted to the client (from webhook handlers via this gateway):
 *   - incoming_call            inbound call routed to this agent
 *   - call_state               status transitions for a call already shown in UI
 *   - call_taken_elsewhere     another device/session of the same user answered
 *   - missed_while_busy        new inbound dropped because agent was occupied
 *
 * Events received from the client:
 *   - accept_call / reject_call / hangup_call — driven by user actions in the
 *     IncomingCallModal / ActiveCallWindow. Treated as advisory hints — the
 *     authoritative state machine is still Telnyx webhooks.
 */
@Injectable()
@WebSocketGateway({
  namespace: "/calls",
  transports: ["websocket"],
  cors: {
    origin: (origin, cb) => cb(null, true),
    credentials: true,
  },
})
export class CallingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(CallingGateway.name);

  @WebSocketServer()
  server: Server;

  // userId -> set of socket ids (one user can have multiple tabs/devices)
  private readonly userSockets = new Map<string, Set<string>>();

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly userSync: UserSyncService,
    private readonly commandBus: CommandBus,
  ) {}

  async handleConnection(client: CallSocket) {
    try {
      const token =
        (client.handshake.auth?.token as string | undefined) ||
        (client.handshake.headers?.authorization as string | undefined)?.replace(
          /^Bearer\s+/i,
          "",
        );

      if (!token) {
        client.emit("auth_error", { message: "Missing token" });
        client.disconnect(true);
        return;
      }

      const payload = this.jwt.verify<JwtPayload>(token, {
        secret: this.config.get<string>("JWT_SECRET_KEY"),
        algorithms: ["HS256"],
      });

      if (payload.type && payload.type !== "access") {
        client.emit("auth_error", { message: "Not an access token" });
        client.disconnect(true);
        return;
      }

      await this.userSync.ensure(payload.sub, payload.org_id);

      client.data = {
        userId: payload.sub,
        workspaceId: payload.org_id,
        role: payload.role || "Representative",
      };

      client.join(`user:${payload.sub}`);
      client.join(`workspace:${payload.org_id}`);

      const set = this.userSockets.get(payload.sub) ?? new Set<string>();
      set.add(client.id);
      this.userSockets.set(payload.sub, set);

      this.logger.debug(
        `Socket connected: user=${payload.sub} socket=${client.id} (total=${set.size})`,
      );
      client.emit("connected", { userId: payload.sub });
    } catch (err) {
      this.logger.warn(`Socket handshake rejected: ${err.message}`);
      client.emit("auth_error", { message: "Invalid token" });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: CallSocket) {
    const userId = client.data?.userId;
    if (!userId) return;
    const set = this.userSockets.get(userId);
    if (set) {
      set.delete(client.id);
      if (set.size === 0) this.userSockets.delete(userId);
    }
    this.logger.debug(`Socket disconnected: user=${userId} socket=${client.id}`);
  }

  // --------------------------------------------------------------------------
  // Server-side emit helpers (used by webhook + command handlers)
  // --------------------------------------------------------------------------

  emitToUser(userId: string, event: string, data: any): void {
    if (!this.server) return;
    this.server.to(`user:${userId}`).emit(event, data);
  }

  emitToWorkspace(workspaceId: string, event: string, data: any): void {
    if (!this.server) return;
    this.server.to(`workspace:${workspaceId}`).emit(event, data);
  }

  isUserOnline(userId: string): boolean {
    const set = this.userSockets.get(userId);
    return !!set && set.size > 0;
  }

  // --------------------------------------------------------------------------
  // Client → server messages (advisory; webhooks drive authoritative state)
  // --------------------------------------------------------------------------

  @SubscribeMessage("ping")
  onPing(@ConnectedSocket() client: CallSocket) {
    return { pong: true, userId: client.data?.userId };
  }
}
