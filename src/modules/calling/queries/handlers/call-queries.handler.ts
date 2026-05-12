import { IQueryHandler, QueryHandler } from "@nestjs/cqrs";
import { Injectable } from "@nestjs/common";
import {
  GetCallByIdQuery,
  GetCallsByLeadQuery,
  GetUsageStatsByWorkspaceQuery,
  GetCurrentBillingCycleQuery,
  GetCallDashboardStatsQuery,
  CanUserMakeCallQuery,
  GetCallingConfigurationQuery,
  GetAvailablePhoneNumbersQuery,
  GetPhoneNumberByIdQuery,
  GetAssignedPhoneNumberQuery,
  GetPhoneNumbersByWorkspaceQuery,
} from "../impl";
import { PrismaService } from "@/shared/database/prisma.service";

// ============================================
// GET CALLING CONFIGURATION
// ============================================

@QueryHandler(GetCallingConfigurationQuery)
export class GetCallingConfigurationHandler implements IQueryHandler<GetCallingConfigurationQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: GetCallingConfigurationQuery) {
    const { workspaceId } = query;

    // First, ensure the workspace exists
    let workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    // Create default workspace if not exists
    if (!workspace) {
      workspace = await this.prisma.workspace.create({
        data: {
          id: workspaceId,
          name: "Default Workspace",
        },
      });
    }

    // Now find or create configuration
    let config = await this.prisma.callingConfiguration.findUnique({
      where: { workspaceId },
    });

    if (!config) {
      config = await this.prisma.callingConfiguration.create({
        data: {
          workspaceId,
          provider: "telnyx",
          ringTimeout: 25,
          missedCallSmsTemplate:
            "Currently in an appointment. I will call you back shortly or text me please.",
          autoChargeOverage: true,
          callingEnabled: true,
          recordingEnabled: false,
          providerAccountSid: process.env.TELNYX_API_KEY || "",
          providerAuthToken: process.env.TELNYX_CONNECTION_ID || "",
        },
      });
    }

    return {
      id: config.id,
      workspaceId: config.workspaceId,
      provider: config.provider,
      ringTimeout: config.ringTimeout,
      missedCallSmsTemplate: config.missedCallSmsTemplate,
      autoChargeOverage: config.autoChargeOverage,
      callingEnabled: config.callingEnabled,
      recordingEnabled: config.recordingEnabled,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }
}

// ============================================
// GET PHONE NUMBERS BY WORKSPACE
// ============================================

@QueryHandler(GetPhoneNumbersByWorkspaceQuery)
export class GetPhoneNumbersByWorkspaceHandler implements IQueryHandler<GetPhoneNumbersByWorkspaceQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: GetPhoneNumbersByWorkspaceQuery) {
    const { workspaceId, includeReleased } = query;

    const where: any = { workspaceId };
    if (!includeReleased) {
      where.status = { not: "RELEASED" };
    }

    return await this.prisma.phoneNumber.findMany({
      where,
      include: {
        assignedToUser: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }
}

// ============================================
// GET ASSIGNED PHONE NUMBER
// ============================================

@QueryHandler(GetAssignedPhoneNumberQuery)
export class GetAssignedPhoneNumberHandler implements IQueryHandler<GetAssignedPhoneNumberQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: GetAssignedPhoneNumberQuery) {
    return await this.prisma.phoneNumber.findFirst({
      where: { assignedToUserId: query.userId },
    });
  }
}

// ============================================
// GET PHONE NUMBER BY ID
// ============================================

@QueryHandler(GetPhoneNumberByIdQuery)
export class GetPhoneNumberByIdHandler implements IQueryHandler<GetPhoneNumberByIdQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: GetPhoneNumberByIdQuery) {
    return await this.prisma.phoneNumber.findUnique({
      where: { id: query.phoneNumberId },
    });
  }
}

// ============================================
// GET AVAILABLE PHONE NUMBERS
// ============================================

@QueryHandler(GetAvailablePhoneNumbersQuery)
export class GetAvailablePhoneNumbersHandler implements IQueryHandler<GetAvailablePhoneNumbersQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: GetAvailablePhoneNumbersQuery) {
    return await this.prisma.phoneNumber.findMany({
      where: {
        workspaceId: query.workspaceId,
        status: "ACTIVE",
        assignedToUserId: null,
      },
    });
  }
}

// ============================================
// GET CALL BY ID
// ============================================

@QueryHandler(GetCallByIdQuery)
export class GetCallByIdHandler implements IQueryHandler<GetCallByIdQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: GetCallByIdQuery) {
    const call = await this.prisma.call.findUnique({
      where: { id: query.callId },
      include: {
        lead: true,
        agent: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        businessNumber: true,
        callEvents: {
          orderBy: {
            timestamp: "asc",
          },
        },
      },
    });

    return call;
  }
}

// ============================================
// GET CALLS BY LEAD
// ============================================

@QueryHandler(GetCallsByLeadQuery)
export class GetCallsByLeadHandler implements IQueryHandler<GetCallsByLeadQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: GetCallsByLeadQuery) {
    const { leadId } = query;
    const limit = Number.isFinite(query.limit) ? Math.trunc(query.limit) : 50;
    const offset = Number.isFinite(query.offset) ? Math.trunc(query.offset) : 0;
    const take = limit > 0 ? limit : 50;
    const skip = offset >= 0 ? offset : 0;

    const calls = await this.prisma.call.findMany({
      where: { leadId },
      include: {
        agent: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        businessNumber: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      take,
      skip,
    });

    const total = await this.prisma.call.count({
      where: { leadId },
    });

    return {
      calls,
      total,
      limit,
      offset,
    };
  }
}

// ============================================
// GET USAGE STATS BY WORKSPACE
// ============================================

@QueryHandler(GetUsageStatsByWorkspaceQuery)
export class GetUsageStatsByWorkspaceHandler implements IQueryHandler<GetUsageStatsByWorkspaceQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: GetUsageStatsByWorkspaceQuery) {
    const { workspaceId, billingCycleId } = query;

    // Get or create current billing cycle if not provided
    let cycleId = billingCycleId;
    let billingCycle;

    if (!cycleId) {
      billingCycle = await this.getCurrentBillingCycle(workspaceId);
      cycleId = billingCycle.id;
    } else {
      billingCycle = await this.prisma.billingCycle.findUnique({
        where: { id: cycleId },
      });
    }

    // Aggregate usage
    const usage = await this.prisma.usageRecord.aggregate({
      where: {
        workspaceId,
        billingCycleId: cycleId,
      },
      _sum: {
        minutes: true,
        cost: true,
      },
      _count: {
        id: true,
      },
    });

    const totalMinutes = Number(usage._sum.minutes || 0);
    const totalCost = Number(usage._sum.cost || 0);
    const totalCalls = usage._count.id;

    const planLimit = billingCycle.planMinuteLimit;
    const percentageUsed = (totalMinutes / planLimit) * 100;
    const remainingMinutes = Math.max(0, planLimit - totalMinutes);
    const isOverLimit = totalMinutes > planLimit;

    // Get breakdown by status
    const callsByStatus = await this.prisma.call.groupBy({
      by: ["status"],
      where: {
        workspaceId,
        createdAt: {
          gte: billingCycle.startDate,
          lte: billingCycle.endDate,
        },
      },
      _count: {
        id: true,
      },
    });

    return {
      billingCycle: {
        id: billingCycle.id,
        startDate: billingCycle.startDate,
        endDate: billingCycle.endDate,
        planLimit,
      },
      usage: {
        totalMinutes,
        totalCost,
        totalCalls,
        percentageUsed,
        remainingMinutes,
        isOverLimit,
      },
      breakdown: {
        byStatus: callsByStatus.reduce((acc, item) => {
          acc[item.status] = item._count.id;
          return acc;
        }, {}),
      },
    };
  }

  private async getCurrentBillingCycle(workspaceId: string) {
    const now = new Date();

    let cycle = await this.prisma.billingCycle.findFirst({
      where: {
        workspaceId,
        startDate: { lte: now },
        endDate: { gte: now },
        status: "ACTIVE",
      },
    });

    if (!cycle) {
      const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      const endDate = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        0,
        23,
        59,
        59,
      );

      cycle = await this.prisma.billingCycle.create({
        data: {
          workspaceId,
          startDate,
          endDate,
          status: "ACTIVE",
          planMinuteLimit: 1000,
          overageRate: 0.02,
        },
      });
    }

    return cycle;
  }
}

// ============================================
// GET CURRENT BILLING CYCLE
// ============================================

@QueryHandler(GetCurrentBillingCycleQuery)
export class GetCurrentBillingCycleHandler implements IQueryHandler<GetCurrentBillingCycleQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: GetCurrentBillingCycleQuery) {
    const now = new Date();

    let cycle = await this.prisma.billingCycle.findFirst({
      where: {
        workspaceId: query.workspaceId,
        startDate: { lte: now },
        endDate: { gte: now },
        status: "ACTIVE",
      },
    });

    if (!cycle) {
      const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      const endDate = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        0,
        23,
        59,
        59,
      );

      cycle = await this.prisma.billingCycle.create({
        data: {
          workspaceId: query.workspaceId,
          startDate,
          endDate,
          status: "ACTIVE",
          planMinuteLimit: 1000,
          overageRate: 0.02,
        },
      });
    }

    return cycle;
  }
}

// ============================================
// GET CALL DASHBOARD STATS
// ============================================

@QueryHandler(GetCallDashboardStatsQuery)
export class GetCallDashboardStatsHandler implements IQueryHandler<GetCallDashboardStatsQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: GetCallDashboardStatsQuery) {
    const { workspaceId, startDate, endDate } = query;

    const dateFilter = {
      ...(startDate && { gte: startDate }),
      ...(endDate && { lte: endDate }),
    };

    // Total calls
    const totalCalls = await this.prisma.call.count({
      where: {
        workspaceId,
        createdAt: dateFilter,
      },
    });

    // Calls by direction
    const callsByDirection = await this.prisma.call.groupBy({
      by: ["direction"],
      where: {
        workspaceId,
        createdAt: dateFilter,
      },
      _count: {
        id: true,
      },
    });

    // Calls by status
    const callsByStatus = await this.prisma.call.groupBy({
      by: ["status"],
      where: {
        workspaceId,
        createdAt: dateFilter,
      },
      _count: {
        id: true,
      },
      _avg: {
        duration: true,
      },
    });

    // Average call duration
    const avgDuration = await this.prisma.call.aggregate({
      where: {
        workspaceId,
        createdAt: dateFilter,
        status: "COMPLETED",
      },
      _avg: {
        duration: true,
      },
    });

    // Top agents by call volume
    const topAgents = await this.prisma.call.groupBy({
      by: ["agentId"],
      where: {
        workspaceId,
        createdAt: dateFilter,
      },
      _count: {
        id: true,
      },
      orderBy: {
        _count: {
          id: "desc",
        },
      },
      take: 10,
    });

    // Answer rate (completed / total)
    const completedCalls =
      callsByStatus.find((s) => s.status === "COMPLETED")?._count.id || 0;
    const answerRate = totalCalls > 0 ? (completedCalls / totalCalls) * 100 : 0;

    return {
      totalCalls,
      byDirection: callsByDirection.reduce((acc, item) => {
        acc[item.direction] = item._count.id;
        return acc;
      }, {}),
      byStatus: callsByStatus.map((item) => ({
        status: item.status,
        count: item._count.id,
        avgDuration: item._avg.duration || 0,
      })),
      avgDuration: avgDuration._avg.duration || 0,
      answerRate,
      topAgents: topAgents.map((item) => ({
        agentId: item.agentId,
        callCount: item._count.id,
      })),
    };
  }
}

// ============================================
// CAN USER MAKE CALL (Safeguard Check)
// ============================================

@QueryHandler(CanUserMakeCallQuery)
export class CanUserMakeCallHandler implements IQueryHandler<CanUserMakeCallQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: CanUserMakeCallQuery): Promise<{
    canCall: boolean;
    reasons: string[];
  }> {
    const { userId, workspaceId } = query;
    const reasons: string[] = [];

    // Check if user has assigned phone number
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { assignedNumber: true },
    });

    if (!user) {
      return { canCall: false, reasons: ["User not found"] };
    }

    if (!user.phoneNumber) {
      reasons.push("User does not have a phone number configured");
    }

    if (!user.assignedNumber) {
      reasons.push("User does not have an assigned business number");
    }

    // Check workspace configuration
    const config = await this.prisma.callingConfiguration.findUnique({
      where: { workspaceId },
    });

    if (!config || !config.callingEnabled) {
      reasons.push("Calling is not enabled for this workspace");
    }

    // Check usage limits — but ONLY block when auto-charge is OFF.
    // If autoChargeOverage is true (the client's default per the April 28
    // Discord update), exceeding the plan limit just charges overage; it
    // must NOT prevent the call from going out.
    const billingCycle = await this.getCurrentBillingCycle(workspaceId);
    const usage = await this.prisma.usageRecord.aggregate({
      where: {
        workspaceId,
        billingCycleId: billingCycle.id,
      },
      _sum: {
        minutes: true,
      },
    });

    const totalMinutes = Number(usage._sum.minutes || 0);
    if (
      totalMinutes >= billingCycle.planMinuteLimit &&
      !config?.autoChargeOverage
    ) {
      reasons.push("Monthly calling limit exceeded");
    }

    return {
      canCall: reasons.length === 0,
      reasons,
    };
  }

  private async getCurrentBillingCycle(workspaceId: string) {
    const now = new Date();

    let cycle = await this.prisma.billingCycle.findFirst({
      where: {
        workspaceId,
        startDate: { lte: now },
        endDate: { gte: now },
        status: "ACTIVE",
      },
    });

    if (!cycle) {
      const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      const endDate = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        0,
        23,
        59,
        59,
      );

      cycle = await this.prisma.billingCycle.create({
        data: {
          workspaceId,
          startDate,
          endDate,
          status: "ACTIVE",
          planMinuteLimit: 1000,
          overageRate: 0.02,
        },
      });
    }

    return cycle;
  }
}