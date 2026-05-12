import {
  IsString,
  IsUUID,
  IsOptional,
  IsObject,
  IsEnum,
  IsNumber,
  IsBoolean,
  IsIn,
  Min,
  Max,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

// ============================================
// CALL DTOs
// ============================================

export class InitiateCallDto {
  @ApiPropertyOptional({
    description:
      "Existing lead UUID. Either leadId or phoneNumber must be provided.",
    example: "123e4567-e89b-12d3-a456-426614174000",
  })
  @IsOptional()
  @IsUUID()
  leadId?: string;

  @ApiPropertyOptional({
    description:
      "E.164 phone number to call. When provided without leadId, the lead is upserted by (workspaceId, phoneNumber).",
    example: "+14155551234",
  })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiPropertyOptional({
    description: "Optional lead name to record on upsert.",
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description:
      "Where the call originates. 'phone' = legacy agent-first PSTN dial; 'web' = the browser places the call via Telnyx WebRTC.",
    enum: ["phone", "web"],
    default: "phone",
  })
  @IsOptional()
  @IsIn(["phone", "web"])
  origin?: "phone" | "web";

  @ApiPropertyOptional({
    description: "Additional metadata for the call",
    example: { campaign: "Q4-Sales", source: "website" },
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class CallResponseDto {
  @ApiProperty({ description: "Unique call identifier" })
  callId: string;

  @ApiProperty({ description: "Current call status" })
  status: string;

  @ApiPropertyOptional({ description: "Provider call SID" })
  providerCallSid?: string;
}

export class CallDetailsDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  direction: "INBOUND" | "OUTBOUND";

  @ApiProperty()
  status: string;

  @ApiProperty()
  fromNumber: string;

  @ApiProperty()
  toNumber: string;

  @ApiProperty()
  duration: number;

  @ApiProperty()
  initiatedAt: Date;

  @ApiPropertyOptional()
  answeredAt?: Date;

  @ApiPropertyOptional()
  completedAt?: Date;

  @ApiProperty()
  lead: {
    id: string;
    name?: string;
    phoneNumber: string;
  };

  @ApiProperty()
  agent: {
    id: string;
    name: string;
    email: string;
  };
}

// ============================================
// USAGE DTOs
// ============================================

export class UsageStatsDto {
  @ApiProperty()
  totalMinutes: number;

  @ApiProperty()
  totalCost: number;

  @ApiProperty()
  totalCalls: number;

  @ApiProperty()
  percentageUsed: number;

  @ApiProperty()
  remainingMinutes: number;

  @ApiProperty()
  isOverLimit: boolean;
}

export class BillingCycleDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  startDate: Date;

  @ApiProperty()
  endDate: Date;

  @ApiProperty()
  planLimit: number;
}

export class WorkspaceUsageResponseDto {
  @ApiProperty()
  billingCycle: BillingCycleDto;

  @ApiProperty()
  usage: UsageStatsDto;

  @ApiProperty()
  breakdown: {
    byStatus: Record<string, number>;
  };
}

// ============================================
// PHONE NUMBER DTOs
// ============================================

export class ProvisionNumberDto {
  @ApiPropertyOptional({ description: "Area code for number", example: "415" })
  @IsOptional()
  @IsString()
  areaCode?: string;

  @ApiPropertyOptional({ description: "Country code", example: "US" })
  @IsOptional()
  @IsString()
  country?: string;
}

export class AssignNumberDto {
  @ApiProperty({ description: "User ID to assign to" })
  @IsUUID()
  userId: string;
}

export class PhoneNumberDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  phoneNumber: string;

  @ApiProperty()
  provider: string;

  @ApiProperty()
  status: string;

  @ApiPropertyOptional()
  assignedToUserId?: string;

  @ApiPropertyOptional()
  assignedToUser?: {
    id: string;
    name: string;
    email: string;
  };
}

// ============================================
// CONFIGURATION DTOs
// ============================================

export class UpdateCallingConfigDto {
  @ApiPropertyOptional({
    description: "Ring timeout in seconds (SOW-mandated 20–30 range)",
    minimum: 20,
    maximum: 30,
  })
  @IsOptional()
  @IsNumber()
  @Min(20)
  @Max(30)
  ringTimeout?: number;

  @ApiPropertyOptional({ description: "Missed call SMS template" })
  @IsOptional()
  @IsString()
  missedCallSmsTemplate?: string;

  @ApiPropertyOptional({
    description:
      "Inbound ring strategy: 'parallel' (ring web + cell at once), 'web_first' (ring browser then cell), 'phone_first' (ring cell then browser).",
    enum: ["parallel", "web_first", "phone_first"],
  })
  @IsOptional()
  @IsIn(["parallel", "web_first", "phone_first"])
  ringStrategy?: "parallel" | "web_first" | "phone_first";

  @ApiPropertyOptional({ description: "Enable or disable calling" })
  @IsOptional()
  @IsBoolean()
  callingEnabled?: boolean;

  @ApiPropertyOptional({ description: "Enable or disable recording" })
  @IsOptional()
  @IsBoolean()
  recordingEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      "Auto-charge overage instead of blocking when plan limit is reached. Client default = true.",
  })
  @IsOptional()
  @IsBoolean()
  autoChargeOverage?: boolean;

  @ApiPropertyOptional({
    description:
      "Telephony provider. This deployment is Telnyx-only — kept here for forward-compat.",
    enum: ["telnyx"],
  })
  @IsOptional()
  @IsIn(["telnyx"])
  provider?: "telnyx";
}

export class UpdateUsageLimitsDto {
  @ApiProperty({
    description: "Monthly minute allowance for the plan",
    example: 1000,
  })
  @IsNumber()
  @Min(0)
  planMinuteLimit: number;

  @ApiProperty({
    description: "Per-minute overage rate in dollars",
    example: 0.02,
  })
  @IsNumber()
  @Min(0)
  overageRate: number;
}

export class CallingConfigurationDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  workspaceId: string;

  @ApiProperty()
  provider: string;

  @ApiProperty()
  ringTimeout: number;

  @ApiProperty()
  missedCallSmsTemplate: string;

  @ApiProperty()
  callingEnabled: boolean;

  @ApiProperty()
  recordingEnabled: boolean;
}

// ============================================
// ANALYTICS DTOs
// ============================================

export class CallDashboardStatsDto {
  @ApiProperty()
  totalCalls: number;

  @ApiProperty()
  byDirection: {
    INBOUND: number;
    OUTBOUND: number;
  };

  @ApiProperty()
  byStatus: Array<{
    status: string;
    count: number;
    avgDuration: number;
  }>;

  @ApiProperty()
  avgDuration: number;

  @ApiProperty()
  answerRate: number;

  @ApiProperty()
  topAgents: Array<{
    agentId: string;
    callCount: number;
  }>;
}

export class AgentPerformanceDto {
  @ApiProperty()
  agentId: string;

  @ApiProperty()
  totalCalls: number;

  @ApiProperty()
  answeredCalls: number;

  @ApiProperty()
  missedCalls: number;

  @ApiProperty()
  avgCallDuration: number;

  @ApiProperty()
  totalMinutes: number;

  @ApiProperty()
  answerRate: number;
}

// ============================================
// QUERY DTOs
// ============================================

export class GetCallsQueryDto {
  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  offset?: number = 0;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(["INBOUND", "OUTBOUND"])
  direction?: "INBOUND" | "OUTBOUND";

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  endDate?: string;
}

// ============================================
// CAPABILITY CHECK DTOs
// ============================================

export class CanMakeCallResponseDto {
  @ApiProperty()
  canCall: boolean;

  @ApiProperty({ type: [String] })
  reasons: string[];
}
