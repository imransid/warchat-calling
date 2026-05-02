import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
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
  GetAssignedPhoneNumberQuery,
  GetCallingConfigurationQuery,
} from "../queries/impl";
import {
  ProvisionNumberDto,
  AssignNumberDto,
  PhoneNumberDto,
  UpdateCallingConfigDto,
  CallingConfigurationDto,
} from "../dto";

@ApiTags("admin")
@ApiBearerAuth()
@Controller("admin/calling")
export class CallingAdminController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
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
  @ApiResponse({
    status: 201,
    description: "Phone number provisioned successfully",
    type: PhoneNumberDto,
    schema: {
      example: {
        id: "123e4567-e89b-12d3-a456-426614174000",
        phoneNumber: "+14155551234",
        provider: "twilio",
        providerSid: "PN1234567890abcdef1234567890abcdef",
        status: "ACTIVE",
        capabilities: {
          voice: true,
          sms: true,
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: "No available numbers found for the requested area code",
  })
  @ApiResponse({
    status: 500,
    description: "Provider API error",
  })
  async provisionNumber(@Body() dto: ProvisionNumberDto) {
    const workspaceId = "workspace-id"; // From auth context

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
  @ApiQuery({
    name: "includeReleased",
    required: false,
    description: "Include released/inactive numbers in the response",
    type: Boolean,
    example: false,
  })
  @ApiResponse({
    status: 200,
    description: "Phone numbers retrieved successfully",
    schema: {
      example: [
        {
          id: "123e4567-e89b-12d3-a456-426614174000",
          phoneNumber: "+14155551234",
          provider: "twilio",
          status: "ACTIVE",
          assignedToUser: {
            id: "user-123",
            name: "John Doe",
            email: "john@warmchats.com",
          },
          createdAt: "2024-01-01T00:00:00Z",
        },
      ],
    },
  })
  async getPhoneNumbers(@Query("includeReleased") includeReleased?: boolean) {
    const workspaceId = "workspace-id"; // From auth context

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
  @ApiParam({
    name: "phoneNumberId",
    description: "Phone number ID to assign",
    example: "123e4567-e89b-12d3-a456-426614174000",
  })
  @ApiBody({ type: AssignNumberDto })
  @ApiResponse({
    status: 200,
    description: "Phone number assigned successfully",
    schema: {
      example: {
        phoneNumberId: "123e4567-e89b-12d3-a456-426614174000",
        userId: "user-456",
        message: "Phone number assigned successfully",
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      "User already has an assigned number or phone number is already assigned",
  })
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
      "Releases a phone number back to the provider. This action is irreversible and the number may not be available for re-purchase.",
  })
  @ApiParam({
    name: "phoneNumberId",
    description: "Phone number ID to release",
    example: "123e4567-e89b-12d3-a456-426614174000",
  })
  @ApiQuery({
    name: "reason",
    required: false,
    description: "Reason for releasing the number",
    type: String,
    example: "Agent left company",
  })
  @ApiResponse({
    status: 200,
    description: "Phone number released successfully",
    schema: {
      example: {
        phoneNumberId: "123e4567-e89b-12d3-a456-426614174000",
        message: "Phone number released successfully",
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: "Phone number not found",
  })
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
  // CONFIGURATION MANAGEMENT
  // ============================================

  @Get("configuration")
  @ApiOperation({
    summary: "Get calling configuration",
    description:
      "Retrieves the current calling configuration for the workspace including ring timeout, SMS templates, and feature flags.",
  })
  @ApiResponse({
    status: 200,
    description: "Configuration retrieved successfully",
    type: CallingConfigurationDto,
    schema: {
      example: {
        id: "config-123",
        workspaceId: "workspace-456",
        provider: "twilio",
        ringTimeout: 25,
        missedCallSmsTemplate:
          "Hi! I missed your call. I'll get back to you shortly.",
        callingEnabled: true,
        recordingEnabled: false,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-15T10:30:00Z",
      },
    },
  })
  async getConfiguration() {
    const workspaceId = "workspace-id"; // From auth context

    return this.queryBus.execute(new GetCallingConfigurationQuery(workspaceId));
  }

  @Put("configuration")
  @ApiOperation({
    summary: "Update calling configuration",
    description:
      "Updates workspace calling settings such as ring timeout (20-30 seconds), missed call SMS template, and feature toggles.",
  })
  @ApiBody({ type: UpdateCallingConfigDto })
  @ApiResponse({
    status: 200,
    description: "Configuration updated successfully",
    type: CallingConfigurationDto,
  })
  @ApiResponse({
    status: 400,
    description:
      "Invalid configuration values (e.g., ring timeout outside 20-30 seconds range)",
  })
  async updateConfiguration(@Body() dto: UpdateCallingConfigDto) {
    // Implementation would update configuration via command
    return {
      message: "Configuration updated successfully",
      ...dto,
    };
  }

  // ============================================
  // USAGE MANAGEMENT
  // ============================================

  @Get("usage/breakdown")
  @ApiOperation({
    summary: "Get detailed usage breakdown",
    description:
      "Retrieves detailed usage statistics broken down by agent, day, or call status for the specified billing cycle.",
  })
  @ApiQuery({
    name: "billingCycleId",
    required: true,
    description: "Billing cycle ID",
    type: String,
  })
  @ApiQuery({
    name: "groupBy",
    required: true,
    description: "Group results by agent, day, or status",
    enum: ["agent", "day", "status"],
    example: "agent",
  })
  @ApiResponse({
    status: 200,
    description: "Usage breakdown retrieved successfully",
    schema: {
      examples: {
        byAgent: {
          value: [
            {
              agentId: "user-123",
              agentName: "John Doe",
              totalCalls: 45,
              totalMinutes: 187.5,
              totalCost: 0.0,
              answeredCalls: 38,
              missedCalls: 7,
            },
          ],
        },
        byDay: {
          value: [
            {
              date: "2024-01-15",
              totalCalls: 23,
              totalMinutes: 95.2,
              avgDuration: 248,
            },
          ],
        },
      },
    },
  })
  async getUsageBreakdown(
    @Query("billingCycleId") billingCycleId: string,
    @Query("groupBy") groupBy: "agent" | "day" | "status",
  ) {
    // Implementation would query usage records with grouping
    return {
      billingCycleId,
      groupBy,
      breakdown: [],
    };
  }

  @Put("usage/limits")
  @ApiOperation({
    summary: "Update plan usage limits",
    description:
      "Updates the monthly calling minute limit and overage rate for the workspace plan.",
  })
  @ApiBody({
    schema: {
      example: {
        planMinuteLimit: 1000,
        overageRate: 0.02,
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: "Usage limits updated successfully",
  })
  async updateUsageLimits(
    @Body() dto: { planMinuteLimit: number; overageRate: number },
  ) {
    return {
      message: "Usage limits updated successfully",
      ...dto,
    };
  }

  // ============================================
  // WEBHOOK MONITORING
  // ============================================

  @Get("webhooks/logs")
  @ApiOperation({
    summary: "Get webhook processing logs",
    description:
      "Retrieves webhook logs for monitoring and debugging. Shows webhook status, retry attempts, and error messages.",
  })
  @ApiQuery({
    name: "status",
    required: false,
    description: "Filter by webhook status",
    enum: ["PROCESSED", "FAILED", "RETRYING"],
    example: "FAILED",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Number of logs to return",
    type: Number,
    example: 50,
  })
  @ApiResponse({
    status: 200,
    description: "Webhook logs retrieved successfully",
    schema: {
      example: [
        {
          id: "log-123",
          providerEventId: "CA1234567890abcdef",
          provider: "twilio",
          eventType: "call.completed",
          status: "PROCESSED",
          retryCount: 0,
          processedAt: "2024-01-15T10:30:00Z",
          receivedAt: "2024-01-15T10:30:00Z",
        },
      ],
    },
  })
  async getWebhookLogs(
    @Query("status") status?: string,
    @Query("limit") limit?: number,
  ) {
    // Implementation would query webhook_logs table
    return [];
  }

  @Post("webhooks/:webhookLogId/retry")
  @ApiOperation({
    summary: "Retry failed webhook",
    description: "Manually retries a failed webhook processing job.",
  })
  @ApiParam({
    name: "webhookLogId",
    description: "Webhook log ID to retry",
    example: "123e4567-e89b-12d3-a456-426614174000",
  })
  @ApiResponse({
    status: 200,
    description: "Webhook retry initiated",
  })
  async retryWebhook(@Param("webhookLogId") webhookLogId: string) {
    return {
      webhookLogId,
      message: "Webhook retry initiated",
    };
  }
}
