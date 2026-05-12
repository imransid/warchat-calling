import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";
import { JwtAuthGuard } from "@/modules/auth/jwt-auth.guard";
import { RolesGuard } from "@/modules/auth/roles.guard";
import { Roles } from "@/modules/auth/roles.decorator";
import { CallingGateway } from "../gateway/calling.gateway";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
  ApiQuery,
} from "@nestjs/swagger";
import {
  ProvisionPhoneNumberCommand,
  AssignPhoneNumberCommand,
  ReleasePhoneNumberCommand,
} from "../commands/impl";
import {
  GetPhoneNumbersByWorkspaceQuery,
  GetCallingConfigurationQuery,
} from "../queries/impl";
import {
  ProvisionNumberDto,
  AssignNumberDto,
  UpdateCallingConfigDto,
  UpdateUsageLimitsDto,
  CallingConfigurationDto,
} from "../dto";
import { PrismaService } from "@/shared/database/prisma.service";

/**
 * Admin endpoints for the WarmChats Calling Module.
 *
 * Two correctness fixes vs. the original draft:
 *
 *   1. workspaceId now comes from the authenticated request
 *      (req.user.workspaceId) instead of the hardcoded "workspace-id"
 *      placeholder, which broke any multi-tenant scenario.
 *
 *   2. The five admin endpoints that previously returned canned success
 *      responses without touching the database — updateConfiguration,
 *      updateUsageLimits, getUsageBreakdown, getWebhookLogs, retryWebhook
 *      — now actually persist / read state. These cover SOW #8 (webhook
 *      reliability monitoring) and SOW #9 (admin configuration).
 */
@ApiTags("admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("Owner", "Manager")
@Controller("admin/calling")
export class CallingAdminController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly prisma: PrismaService,
    private readonly gateway: CallingGateway,
  ) {}

  // ============================================
  // PHONE NUMBER MANAGEMENT
  // ============================================

  @Post("phone-numbers")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Provision a new phone number",
    description:
      "Purchases a new business phone number from the telephony provider. The number will be available for assignment to agents.",
  })
  @ApiBody({ type: ProvisionNumberDto })
  @ApiResponse({ status: 201, description: "Phone number provisioned successfully" })
  @ApiResponse({ status: 400, description: "No available numbers for the requested area code" })
  @ApiResponse({ status: 500, description: "Provider API error" })
  async provisionNumber(@Body() dto: ProvisionNumberDto, @Request() req: any) {
    const workspaceId = req.user.workspaceId;

    const phoneNumberId = await this.commandBus.execute(
      new ProvisionPhoneNumberCommand(workspaceId, dto.areaCode, dto.country),
    );

    return { phoneNumberId, message: "Phone number provisioned successfully" };
  }

  @Get("phone-numbers")
  @ApiOperation({
    summary: "List all phone numbers",
    description:
      "Retrieves all phone numbers for the workspace, optionally including released numbers.",
  })
  @ApiQuery({ name: "includeReleased", required: false, type: Boolean })
  @ApiResponse({ status: 200, description: "Phone numbers retrieved successfully" })
  async getPhoneNumbers(
    @Request() req: any,
    @Query("includeReleased") includeReleased?: boolean,
  ) {
    const workspaceId = req.user.workspaceId;

    return this.queryBus.execute(
      new GetPhoneNumbersByWorkspaceQuery(workspaceId, includeReleased),
    );
  }

  @Put("phone-numbers/:phoneNumberId/assign")
  @ApiOperation({
    summary: "Assign phone number to agent",
    description:
      "Assigns a business phone number to a specific agent. Each agent can have only one assigned number.",
  })
  @ApiParam({ name: "phoneNumberId", description: "Phone number ID to assign" })
  @ApiBody({ type: AssignNumberDto })
  @ApiResponse({ status: 200, description: "Phone number assigned successfully" })
  @ApiResponse({ status: 400, description: "User already has an assigned number" })
  async assignNumber(
    @Param("phoneNumberId") phoneNumberId: string,
    @Body() dto: AssignNumberDto,
  ) {
    await this.commandBus.execute(
      new AssignPhoneNumberCommand(phoneNumberId, dto.userId),
    );

    return {
      phoneNumberId,
      userId: dto.userId,
      message: "Phone number assigned successfully",
    };
  }

  @Delete("phone-numbers/:phoneNumberId")
  @ApiOperation({
    summary: "Release phone number",
    description:
      "Releases a phone number back to the provider. This action is irreversible.",
  })
  @ApiParam({ name: "phoneNumberId", description: "Phone number ID to release" })
  @ApiQuery({ name: "reason", required: false, type: String })
  @ApiResponse({ status: 200, description: "Phone number released successfully" })
  @ApiResponse({ status: 404, description: "Phone number not found" })
  async releaseNumber(
    @Param("phoneNumberId") phoneNumberId: string,
    @Query("reason") reason?: string,
  ) {
    await this.commandBus.execute(
      new ReleasePhoneNumberCommand(phoneNumberId, reason),
    );

    return {
      phoneNumberId,
      message: "Phone number released successfully",
    };
  }

  // ============================================
  // CONFIGURATION MANAGEMENT  (SOW #9)
  // ============================================

  @Get("configuration")
  @ApiOperation({
    summary: "Get calling configuration",
    description:
      "Retrieves the current calling configuration for the workspace including ring timeout, SMS template, provider, and feature flags.",
  })
  @ApiResponse({ status: 200, description: "Configuration retrieved successfully", type: CallingConfigurationDto })
  async getConfiguration(@Request() req: any) {
    const workspaceId = req.user.workspaceId;

    return this.queryBus.execute(new GetCallingConfigurationQuery(workspaceId));
  }

  /**
   * Persist whichever fields the admin sent. Previously this endpoint
   * returned a fake success response without touching the DB — so config
   * changes were silently dropped, including the SOW-critical ringTimeout
   * (20–30s) and missedCallSmsTemplate.
   */
  @Put("configuration")
  @ApiOperation({
    summary: "Update calling configuration",
    description:
      "Updates workspace calling settings: ring timeout (20-30s), missed-call SMS template, autoChargeOverage, provider, and feature toggles.",
  })
  @ApiBody({ type: UpdateCallingConfigDto })
  @ApiResponse({ status: 200, description: "Configuration updated successfully", type: CallingConfigurationDto })
  @ApiResponse({ status: 400, description: "Invalid configuration values (e.g., ringTimeout outside 20–30s)" })
  async updateConfiguration(
    @Body() dto: UpdateCallingConfigDto,
    @Request() req: any,
  ) {
    const workspaceId = req.user.workspaceId;

    // Make sure a row exists. GetCallingConfigurationQuery already does this
    // and is the canonical "get-or-create" path, so reuse it.
    await this.queryBus.execute(new GetCallingConfigurationQuery(workspaceId));

    // Build a partial update — only the fields the admin actually sent.
    const data: Record<string, any> = {};
    if (dto.ringTimeout !== undefined) data.ringTimeout = dto.ringTimeout;
    if (dto.missedCallSmsTemplate !== undefined)
      data.missedCallSmsTemplate = dto.missedCallSmsTemplate;
    if (dto.callingEnabled !== undefined) data.callingEnabled = dto.callingEnabled;
    if (dto.recordingEnabled !== undefined)
      data.recordingEnabled = dto.recordingEnabled;
    if (dto.autoChargeOverage !== undefined)
      data.autoChargeOverage = dto.autoChargeOverage;
    if (dto.provider !== undefined) data.provider = dto.provider;
    if (dto.ringStrategy !== undefined) data.ringStrategy = dto.ringStrategy;

    const updated = await this.prisma.callingConfiguration.update({
      where: { workspaceId },
      data,
    });

    return {
      message: "Configuration updated successfully",
      id: updated.id,
      workspaceId: updated.workspaceId,
      provider: updated.provider,
      ringTimeout: updated.ringTimeout,
      ringStrategy: updated.ringStrategy,
      missedCallSmsTemplate: updated.missedCallSmsTemplate,
      callingEnabled: updated.callingEnabled,
      recordingEnabled: updated.recordingEnabled,
      autoChargeOverage: updated.autoChargeOverage,
      updatedAt: updated.updatedAt,
    };
  }

  /**
   * Per-agent web-call readiness for the admin agents page.
   * Includes whether the agent has provisioned a SIP credential and whether
   * any of their browser sessions are currently connected to the gateway.
   */
  @Get("agents/web-status")
  @ApiOperation({
    summary: "Get per-agent WebRTC + online status",
    description:
      "Lists agents in the workspace with their SIP credential status and whether any of their browser sessions are currently connected.",
  })
  async getAgentWebStatus(@Request() req: any) {
    const workspaceId = req.user.workspaceId;
    const agents = await this.prisma.user.findMany({
      where: { workspaceId },
      select: {
        id: true,
        name: true,
        email: true,
        phoneNumber: true,
        telnyxCredentialId: true,
        telnyxSipUri: true,
      },
    });
    return agents.map((a) => ({
      ...a,
      hasCredential: !!a.telnyxCredentialId,
      online: this.gateway.isUserOnline(a.id),
    }));
  }

  // ============================================
  // USAGE MANAGEMENT  (SOW #7 / #9)
  // ============================================

  /**
   * Real implementation — groups usage_records / calls by agent, day, or
   * status for a given billing cycle. Previously returned an empty array.
   */
  @Get("usage/breakdown")
  @ApiOperation({
    summary: "Get detailed usage breakdown",
    description:
      "Retrieves usage statistics grouped by agent, day, or call status for the specified billing cycle.",
  })
  @ApiQuery({ name: "billingCycleId", required: true, type: String })
  @ApiQuery({
    name: "groupBy",
    required: true,
    enum: ["agent", "day", "status"],
  })
  @ApiResponse({ status: 200, description: "Usage breakdown retrieved successfully" })
  async getUsageBreakdown(
    @Request() req: any,
    @Query("billingCycleId") billingCycleId: string,
    @Query("groupBy") groupBy: "agent" | "day" | "status",
  ) {
    const workspaceId = req.user.workspaceId;

    const cycle = await this.prisma.billingCycle.findUnique({
      where: { id: billingCycleId },
    });

    if (!cycle || cycle.workspaceId !== workspaceId) {
      throw new NotFoundException("Billing cycle not found for this workspace");
    }

    if (groupBy === "agent") {
      const grouped = await this.prisma.usageRecord.groupBy({
        by: ["agentId"],
        where: { workspaceId, billingCycleId },
        _sum: { minutes: true, cost: true },
        _count: { id: true },
      });

      // Pull agent names in a single query.
      const agentIds = grouped.map((g: any) => g.agentId);
      const agents = await this.prisma.user.findMany({
        where: { id: { in: agentIds } },
        select: { id: true, name: true, email: true },
      });
      const agentMap = new Map(agents.map((a: any) => [a.id, a]));

      // Per-agent answered/missed counts come from `calls`, not usage_records
      // (since missed calls don't generate usage rows).
      const callsByAgent = await this.prisma.call.groupBy({
        by: ["agentId", "status"],
        where: {
          workspaceId,
          createdAt: { gte: cycle.startDate, lte: cycle.endDate },
        },
        _count: { id: true },
      });
      const callMap: Record<string, { answered: number; missed: number; total: number }> = {};
      for (const row of callsByAgent as any[]) {
        const m = (callMap[row.agentId] ||= { answered: 0, missed: 0, total: 0 });
        m.total += row._count.id;
        if (row.status === "COMPLETED") m.answered += row._count.id;
        else if (
          row.status === "NO_ANSWER" ||
          row.status === "BUSY" ||
          row.status === "FAILED"
        )
          m.missed += row._count.id;
      }

      return {
        billingCycleId,
        groupBy,
        breakdown: (grouped as any[]).map((g: any) => ({
          agentId: g.agentId,
          agentName: (agentMap.get(g.agentId) as any)?.name ?? null,
          agentEmail: (agentMap.get(g.agentId) as any)?.email ?? null,
          totalMinutes: Number(g._sum.minutes ?? 0),
          totalCost: Number(g._sum.cost ?? 0),
          totalCalls: callMap[g.agentId]?.total ?? g._count.id,
          answeredCalls: callMap[g.agentId]?.answered ?? 0,
          missedCalls: callMap[g.agentId]?.missed ?? 0,
        })),
      };
    }

    if (groupBy === "status") {
      const grouped = await this.prisma.call.groupBy({
        by: ["status"],
        where: {
          workspaceId,
          createdAt: { gte: cycle.startDate, lte: cycle.endDate },
        },
        _count: { id: true },
        _avg: { duration: true },
        _sum: { duration: true },
      });

      return {
        billingCycleId,
        groupBy,
        breakdown: (grouped as any[]).map((g: any) => ({
          status: g.status,
          totalCalls: g._count.id,
          avgDuration: g._avg.duration ?? 0,
          totalDurationSeconds: g._sum.duration ?? 0,
        })),
      };
    }

    // groupBy === "day"
    // Prisma's groupBy doesn't truncate timestamps to dates, so we pull rows
    // and bucket in memory. For a single billing cycle this is fine.
    const calls = await this.prisma.call.findMany({
      where: {
        workspaceId,
        createdAt: { gte: cycle.startDate, lte: cycle.endDate },
      },
      select: { createdAt: true, duration: true, status: true },
    });

    const byDay = new Map<
      string,
      { totalCalls: number; totalDuration: number; answered: number }
    >();
    for (const c of calls as any[]) {
      const day = new Date(c.createdAt).toISOString().slice(0, 10);
      const bucket = byDay.get(day) ?? { totalCalls: 0, totalDuration: 0, answered: 0 };
      bucket.totalCalls += 1;
      bucket.totalDuration += c.duration ?? 0;
      if (c.status === "COMPLETED") bucket.answered += 1;
      byDay.set(day, bucket);
    }

    return {
      billingCycleId,
      groupBy,
      breakdown: [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, b]) => ({
          date,
          totalCalls: b.totalCalls,
          totalMinutes: b.totalDuration / 60,
          avgDuration: b.totalCalls ? b.totalDuration / b.totalCalls : 0,
          answeredCalls: b.answered,
        })),
    };
  }

  /**
   * Real persistence — updates the active billing cycle's planMinuteLimit
   * and overageRate. SOW #9 requires admins to be able to configure
   * per-plan calling limits.
   */
  @Put("usage/limits")
  @ApiOperation({
    summary: "Update plan usage limits",
    description:
      "Updates the monthly calling minute limit and overage rate for the workspace's active billing cycle.",
  })
  @ApiBody({ type: UpdateUsageLimitsDto })
  @ApiResponse({ status: 200, description: "Usage limits updated successfully" })
  @ApiResponse({ status: 404, description: "No active billing cycle for this workspace" })
  async updateUsageLimits(
    @Body() dto: UpdateUsageLimitsDto,
    @Request() req: any,
  ) {
    const workspaceId = req.user.workspaceId;
    const now = new Date();

    const cycle = await this.prisma.billingCycle.findFirst({
      where: {
        workspaceId,
        startDate: { lte: now },
        endDate: { gte: now },
        status: "ACTIVE",
      },
    });

    if (!cycle) {
      throw new NotFoundException(
        "No active billing cycle found for this workspace. Create one first.",
      );
    }

    const updated = await this.prisma.billingCycle.update({
      where: { id: cycle.id },
      data: {
        planMinuteLimit: dto.planMinuteLimit,
        overageRate: dto.overageRate,
      },
    });

    return {
      message: "Usage limits updated successfully",
      billingCycleId: updated.id,
      planMinuteLimit: updated.planMinuteLimit,
      overageRate: Number(updated.overageRate),
    };
  }

  // ============================================
  // WEBHOOK MONITORING  (SOW #8)
  // ============================================

  /**
   * Real query against webhook_logs. Was previously returning a hard-coded
   * empty array which made the webhook reliability story unprovable.
   */
  @Get("webhooks/logs")
  @ApiOperation({
    summary: "Get webhook processing logs",
    description:
      "Retrieves webhook logs for monitoring and debugging. Filterable by status; defaults to most-recent first.",
  })
  @ApiQuery({
    name: "status",
    required: false,
    enum: ["RECEIVED", "PROCESSING", "PROCESSED", "FAILED", "RETRYING"],
  })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiQuery({ name: "offset", required: false, type: Number })
  @ApiResponse({ status: 200, description: "Webhook logs retrieved successfully" })
  async getWebhookLogs(
    @Request() req: any,
    @Query("status") status?: string,
    @Query("limit") limit?: number,
    @Query("offset") offset?: number,
  ) {
    const workspaceId = req.user.workspaceId;

    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const skip = Math.max(Number(offset) || 0, 0);

    const where: any = {
      // We only return logs scoped to the workspace once they've been
      // matched to a call. Pre-match logs (where we couldn't find the
      // call) have workspaceId=null and aren't shown to tenant admins.
      workspaceId,
    };
    if (status) where.status = status;

    const [logs, total] = await Promise.all([
      this.prisma.webhookLog.findMany({
        where,
        orderBy: { receivedAt: "desc" },
        take,
        skip,
      }),
      this.prisma.webhookLog.count({ where }),
    ]);

    return {
      total,
      limit: take,
      offset: skip,
      logs,
    };
  }

  /**
   * Manual retry: reset the log to RETRYING and pull lastRetryAt back so
   * the scheduled sweep picks it up immediately on the next minute.
   */
  @Post("webhooks/:webhookLogId/retry")
  @ApiOperation({
    summary: "Retry failed webhook",
    description:
      "Schedules a failed webhook for re-processing on the next sweep tick.",
  })
  @ApiParam({ name: "webhookLogId", description: "Webhook log ID to retry" })
  @ApiResponse({ status: 200, description: "Webhook retry initiated" })
  @ApiResponse({ status: 404, description: "Webhook log not found" })
  async retryWebhook(
    @Param("webhookLogId") webhookLogId: string,
    @Request() req: any,
  ) {
    const workspaceId = req.user.workspaceId;

    const log = await this.prisma.webhookLog.findUnique({
      where: { id: webhookLogId },
    });

    if (!log || log.workspaceId !== workspaceId) {
      throw new NotFoundException("Webhook log not found");
    }

    await this.prisma.webhookLog.update({
      where: { id: webhookLogId },
      data: {
        status: "RETRYING",
        // Pull lastRetryAt back so the scheduler doesn't gate on backoff.
        lastRetryAt: new Date(0),
        errorMessage: null,
      },
    });

    return {
      webhookLogId,
      message: "Webhook retry scheduled — will run on the next sweep tick",
    };
  }
}