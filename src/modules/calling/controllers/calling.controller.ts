import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpStatus,
  HttpCode,
  BadRequestException,
} from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
  ApiBody,
} from "@nestjs/swagger";
import { InitiateOutboundCallCommand } from "../commands/impl";
import {
  GetCallByIdQuery,
  GetCallsByLeadQuery,
  GetUsageStatsByWorkspaceQuery,
  GetCallDashboardStatsQuery,
  CanUserMakeCallQuery,
} from "../queries/impl";
import {
  InitiateCallDto,
  CallResponseDto,
  CallDetailsDto,
  WorkspaceUsageResponseDto,
  CallDashboardStatsDto,
  CanMakeCallResponseDto,
  GetCallsQueryDto,
} from "../dto";

@ApiTags("calling")
@ApiBearerAuth()
@Controller("calling")
// @UseGuards(JwtAuthGuard) // Add your auth guard
export class CallingController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  // ============================================
  // OUTBOUND CALLING
  // ============================================

  @Post("calls/outbound")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Initiate an outbound call",
    description:
      "Initiates an outbound call to a lead. The system will call the agent first (agent-first dial flow), and once the agent answers, it will bridge the customer in. The customer will see the business number as caller ID, never the agent's personal number.",
  })
  @ApiBody({ type: InitiateCallDto })
  @ApiResponse({
    status: 200,
    description: "Call initiated successfully",
    type: CallResponseDto,
    example: {
      callId: "123e4567-e89b-12d3-a456-426614174000",
      status: "INITIATED",
      providerCallSid: "CA1234567890abcdef1234567890abcdef",
    },
  })
  @ApiResponse({
    status: 400,
    description: "Bad request - Invalid lead ID or missing data",
    schema: {
      example: {
        statusCode: 400,
        message: "Lead not found",
        error: "Bad Request",
      },
    },
  })
  @ApiResponse({
    status: 403,
    description:
      "Calling not allowed - No assigned number, plan disabled, or usage limit exceeded",
    schema: {
      example: {
        statusCode: 403,
        message:
          "Cannot make call: User does not have an assigned business number",
        error: "Forbidden",
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: "Unauthorized - Invalid or missing authentication token",
  })
  async initiateCall(
    @Body() dto: InitiateCallDto,
    @Request() req: any,
  ): Promise<CallResponseDto> {
    // Extract user and workspace from authenticated request
    const userId = req.user.id;
    const workspaceId = req.user.workspaceId;

    // Check if user can make calls
    const canMakeCall = await this.queryBus.execute(
      new CanUserMakeCallQuery(userId, workspaceId),
    );

    if (!canMakeCall.canCall) {
      throw new BadRequestException(
        `Cannot make call: ${canMakeCall.reasons.join(", ")}`,
      );
    }

    // Initiate the call
    const callId = await this.commandBus.execute(
      new InitiateOutboundCallCommand(
        dto.leadId,
        userId,
        workspaceId,
        dto.metadata,
      ),
    );

    return {
      callId,
      status: "INITIATED",
    };
  }

  // ============================================
  // CALL RETRIEVAL
  // ============================================

  @Get("calls/:callId")
  @ApiOperation({
    summary: "Get call details by ID",
    description:
      "Retrieves complete details of a specific call including status, duration, participants, and all call events.",
  })
  @ApiParam({
    name: "callId",
    description: "Unique call identifier (UUID)",
    example: "123e4567-e89b-12d3-a456-426614174000",
  })
  @ApiResponse({
    status: 200,
    description: "Call details retrieved successfully",
    type: CallDetailsDto,
  })
  @ApiResponse({
    status: 404,
    description: "Call not found",
  })
  async getCallById(@Param("callId") callId: string) {
    return this.queryBus.execute(new GetCallByIdQuery(callId));
  }

  @Get("leads/:leadId/calls")
  @ApiOperation({
    summary: "Get all calls for a lead",
    description:
      "Retrieves the complete call history for a specific lead with pagination support.",
  })
  @ApiParam({
    name: "leadId",
    description: "Lead identifier (UUID)",
    example: "123e4567-e89b-12d3-a456-426614174000",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Number of records to return (1-100)",
    example: 50,
    type: Number,
  })
  @ApiQuery({
    name: "offset",
    required: false,
    description: "Number of records to skip for pagination",
    example: 0,
    type: Number,
  })
  @ApiResponse({
    status: 200,
    description: "Call history retrieved successfully",
    schema: {
      example: {
        calls: [
          {
            id: "123e4567-e89b-12d3-a456-426614174000",
            direction: "OUTBOUND",
            status: "COMPLETED",
            duration: 185,
            initiatedAt: "2024-01-15T10:30:00Z",
            completedAt: "2024-01-15T10:33:05Z",
            agent: {
              id: "agent-123",
              name: "John Doe",
              email: "john@warmchats.com",
            },
          },
        ],
        total: 25,
        limit: 50,
        offset: 0,
      },
    },
  })
  async getCallsByLead(
    @Param("leadId") leadId: string,
    @Query("limit") limit?: number,
    @Query("offset") offset?: number,
  ) {
    return this.queryBus.execute(
      new GetCallsByLeadQuery(leadId, limit, offset),
    );
  }

  // ============================================
  // USAGE & ANALYTICS
  // ============================================

  @Get("usage/workspace")
  @ApiOperation({
    summary: "Get usage statistics for workspace",
    description:
      "Retrieves current billing cycle usage statistics including total minutes used, remaining minutes, cost, and breakdown by call status.",
  })
  @ApiQuery({
    name: "billingCycleId",
    required: false,
    description: "Specific billing cycle ID (defaults to current cycle)",
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: "Usage statistics retrieved successfully",
    type: WorkspaceUsageResponseDto,
    schema: {
      example: {
        billingCycle: {
          id: "cycle-123",
          startDate: "2024-01-01T00:00:00Z",
          endDate: "2024-01-31T23:59:59Z",
          planLimit: 1000,
        },
        usage: {
          totalMinutes: 487.5,
          totalCost: 0.0,
          totalCalls: 142,
          percentageUsed: 48.75,
          remainingMinutes: 512.5,
          isOverLimit: false,
        },
        breakdown: {
          byStatus: {
            COMPLETED: 120,
            NO_ANSWER: 15,
            BUSY: 5,
            FAILED: 2,
          },
        },
      },
    },
  })
  async getWorkspaceUsage(
    @Request() req: any,
    @Query("billingCycleId") billingCycleId?: string,
  ) {
    const workspaceId = req.user.workspaceId;

    return this.queryBus.execute(
      new GetUsageStatsByWorkspaceQuery(workspaceId, billingCycleId),
    );
  }

  @Get("analytics/dashboard")
  @ApiOperation({
    summary: "Get dashboard statistics",
    description:
      "Retrieves comprehensive analytics for the dashboard including call volume, answer rates, average duration, and top performing agents.",
  })
  @ApiQuery({
    name: "startDate",
    required: false,
    description: "Start date for analytics period (ISO 8601)",
    example: "2024-01-01T00:00:00Z",
    type: String,
  })
  @ApiQuery({
    name: "endDate",
    required: false,
    description: "End date for analytics period (ISO 8601)",
    example: "2024-01-31T23:59:59Z",
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: "Dashboard statistics retrieved successfully",
    type: CallDashboardStatsDto,
  })
  async getDashboardStats(
    @Request() req: any,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    const workspaceId = req.user.workspaceId;

    return this.queryBus.execute(
      new GetCallDashboardStatsQuery(
        workspaceId,
        startDate ? new Date(startDate) : undefined,
        endDate ? new Date(endDate) : undefined,
      ),
    );
  }

  // ============================================
  // USER CAPABILITIES
  // ============================================

  @Get("can-call")
  @ApiOperation({
    summary: "Check if user can make calls",
    description:
      "Validates all safeguards before allowing a call: checks if user has assigned business number, plan allows calling, and usage limits are not exceeded.",
  })
  @ApiResponse({
    status: 200,
    description: "Capability check completed",
    type: CanMakeCallResponseDto,
    schema: {
      examples: {
        allowed: {
          value: {
            canCall: true,
            reasons: [],
          },
        },
        notAllowed: {
          value: {
            canCall: false,
            reasons: [
              "User does not have an assigned business number",
              "Monthly calling limit exceeded",
            ],
          },
        },
      },
    },
  })
  async canUserMakeCall(@Request() req: any) {
    const userId = req.user.id;
    const workspaceId = req.user.workspaceId;

    return this.queryBus.execute(new CanUserMakeCallQuery(userId, workspaceId));
  }
}
