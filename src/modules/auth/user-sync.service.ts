import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/shared/database/prisma.service";

@Injectable()
export class UserSyncService {
  private readonly logger = new Logger(UserSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lazily upsert Workspace + User rows so calling-backend queries that join
   * to these tables (Call.agent, Call.workspace, PhoneNumber.workspace, etc.)
   * always find a row.
   *
   * The main Flask API is the system-of-record for users; we keep only the
   * minimum required fields and let admin UIs fill in email/name later. Both
   * email and name on the local User table are now nullable (see migration
   * 20260512_calling_web_layer).
   */
  async ensure(userId: string, workspaceId: string): Promise<void> {
    await this.prisma.workspace.upsert({
      where: { id: workspaceId },
      create: { id: workspaceId, name: `Workspace ${workspaceId.slice(0, 8)}` },
      update: {},
    });

    await this.prisma.user.upsert({
      where: { id: userId },
      create: {
        id: userId,
        workspaceId,
      },
      update: { workspaceId },
    });
  }
}
