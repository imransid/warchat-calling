import {
  IsString,
  IsUUID,
  IsOptional,
  IsObject,
  IsEnum,
  IsNumber,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ============================================
// CALL DTOs
// ============================================

export class InitiateCallDto {
  @ApiProperty({
    description: 'ID of the lead to call',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  leadId: string;

  @ApiPropertyOptional({
    description: 'Additional metadata for the call',
    example: { campaign: 'Q4-Sales', source: 'website' },
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class CallResponseDto {
  @ApiProperty({ description: 'Unique call identifier' })
  callId: string;

  @ApiProperty({ description: 'Current call status' })
  status: string;

  @ApiPropertyOptional({ description: 'Provider call SID' })
  providerCallSid?: string;
}

export class CallDetailsDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  direction: 'INBOUND' | 'OUTBOUND';

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
  @ApiPropertyOptional({ description: 'Area code for number', example: '415' })
  @IsOptional()
  @IsString()
  areaCode?: string;

  @ApiPropertyOptional({ description: 'Country code', example: 'US' })
  @IsOptional()
  @IsString()
  country?: string;
}

export class AssignNumberDto {
  @ApiProperty({ description: 'Phone number ID to assign' })
  @IsUUID()
  phoneNumberId: string;

  @ApiProperty({ description: 'User ID to assign to' })
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
    description: 'Ring timeout in seconds',
    minimum: 20,
    maximum: 30,
  })
  @IsOptional()
  @IsNumber()
  @Min(20)
  @Max(30)
  ringTimeout?: number;

  @ApiPropertyOptional({ description: 'Missed call SMS template' })
  @IsOptional()
  @IsString()
  missedCallSmsTemplate?: string;

  @ApiPropertyOptional({ description: 'Enable or disable calling' })
  @IsOptional()
  callingEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Enable or disable recording' })
  @IsOptional()
  recordingEnabled?: boolean;
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
  @IsEnum(['INBOUND', 'OUTBOUND'])
  direction?: 'INBOUND' | 'OUTBOUND';

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
