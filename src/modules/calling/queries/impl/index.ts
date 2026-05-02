import { IQuery } from '@nestjs/cqrs';

// ============================================
// CALL QUERIES
// ============================================

export class GetCallByIdQuery implements IQuery {
  constructor(public readonly callId: string) {}
}

export class GetCallsByLeadQuery implements IQuery {
  constructor(
    public readonly leadId: string,
    public readonly limit?: number,
    public readonly offset?: number,
  ) {}
}

export class GetCallsByAgentQuery implements IQuery {
  constructor(
    public readonly agentId: string,
    public readonly startDate?: Date,
    public readonly endDate?: Date,
    public readonly limit?: number,
    public readonly offset?: number,
  ) {}
}

export class GetCallsByWorkspaceQuery implements IQuery {
  constructor(
    public readonly workspaceId: string,
    public readonly filters?: {
      status?: string[];
      direction?: 'INBOUND' | 'OUTBOUND';
      agentId?: string;
      startDate?: Date;
      endDate?: Date;
    },
    public readonly limit?: number,
    public readonly offset?: number,
  ) {}
}

export class GetCallEventsQuery implements IQuery {
  constructor(public readonly callId: string) {}
}

// ============================================
// USAGE QUERIES
// ============================================

export class GetUsageStatsByWorkspaceQuery implements IQuery {
  constructor(
    public readonly workspaceId: string,
    public readonly billingCycleId?: string,
  ) {}
}

export class GetUsageStatsByAgentQuery implements IQuery {
  constructor(
    public readonly agentId: string,
    public readonly billingCycleId?: string,
  ) {}
}

export class GetCurrentBillingCycleQuery implements IQuery {
  constructor(public readonly workspaceId: string) {}
}

export class GetUsageBreakdownQuery implements IQuery {
  constructor(
    public readonly workspaceId: string,
    public readonly billingCycleId: string,
    public readonly groupBy: 'agent' | 'day' | 'status',
  ) {}
}

// ============================================
// PHONE NUMBER QUERIES
// ============================================

export class GetPhoneNumberByIdQuery implements IQuery {
  constructor(public readonly phoneNumberId: string) {}
}

export class GetPhoneNumbersByWorkspaceQuery implements IQuery {
  constructor(
    public readonly workspaceId: string,
    public readonly includeReleased?: boolean,
  ) {}
}

export class GetAssignedPhoneNumberQuery implements IQuery {
  constructor(public readonly userId: string) {}
}

export class GetAvailablePhoneNumbersQuery implements IQuery {
  constructor(public readonly workspaceId: string) {}
}

// ============================================
// DASHBOARD QUERIES
// ============================================

export class GetCallDashboardStatsQuery implements IQuery {
  constructor(
    public readonly workspaceId: string,
    public readonly startDate?: Date,
    public readonly endDate?: Date,
  ) {}
}

export class GetAgentPerformanceQuery implements IQuery {
  constructor(
    public readonly agentId: string,
    public readonly startDate?: Date,
    public readonly endDate?: Date,
  ) {}
}

// ============================================
// CONFIGURATION QUERIES
// ============================================

export class GetCallingConfigurationQuery implements IQuery {
  constructor(public readonly workspaceId: string) {}
}

export class CanUserMakeCallQuery implements IQuery {
  constructor(
    public readonly userId: string,
    public readonly workspaceId: string,
  ) {}
}
