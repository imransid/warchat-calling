import { Test, TestingModule } from "@nestjs/testing";
import { CommandBus, EventBus } from "@nestjs/cqrs";
import { InitiateOutboundCallHandler } from "../commands/handlers/initiate-outbound-call.handler";
import { PrismaService } from "@/shared/database/prisma.service";
import { TelephonyProviderFactory } from "../infrastructure/telephony/telephony-provider.factory";
import { InitiateOutboundCallCommand } from "../commands/impl";
import { BadRequestException, ForbiddenException } from "@nestjs/common";

describe("InitiateOutboundCallHandler", () => {
  let handler: InitiateOutboundCallHandler;
  let prismaService: PrismaService;
  let telephonyFactory: TelephonyProviderFactory;
  let eventBus: EventBus;

  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
    },
    lead: {
      findUnique: jest.fn(),
    },
    callingConfiguration: {
      findUnique: jest.fn(),
    },
    billingCycle: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    usageRecord: {
      aggregate: jest.fn(),
    },
    call: {
      create: jest.fn(),
      update: jest.fn(),
    },
    callEvent: {
      create: jest.fn(),
    },
  };

  const mockTelephonyProvider = {
    initiateOutboundCall: jest.fn(),
  };

  const mockTelephonyFactory = {
    getProvider: jest.fn().mockReturnValue(mockTelephonyProvider),
  };

  const mockEventBus = {
    publish: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InitiateOutboundCallHandler,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: TelephonyProviderFactory, useValue: mockTelephonyFactory },
        { provide: EventBus, useValue: mockEventBus },
      ],
    }).compile();

    handler = module.get<InitiateOutboundCallHandler>(
      InitiateOutboundCallHandler,
    );
    prismaService = module.get<PrismaService>(PrismaService);
    telephonyFactory = module.get<TelephonyProviderFactory>(
      TelephonyProviderFactory,
    );
    eventBus = module.get<EventBus>(EventBus);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("execute", () => {
    const validCommand = new InitiateOutboundCallCommand(
      "agent-456",
      "workspace-789",
      { leadId: "lead-123", origin: "phone" },
    );

    const mockAgent = {
      id: "agent-456",
      phoneNumber: "+14155551234",
      assignedNumber: {
        id: "number-123",
        phoneNumber: "+14155559999",
      },
    };

    const mockLead = {
      id: "lead-123",
      phoneNumber: "+14155555678",
    };

    const mockConfig = {
      workspaceId: "workspace-789",
      callingEnabled: true,
      provider: "telnyx",
      autoChargeOverage: false,
    };

    const mockBillingCycle = {
      id: "cycle-123",
      planMinuteLimit: 1000,
    };

    it("should successfully initiate an outbound call", async () => {
      // Arrange
      mockPrismaService.user.findUnique.mockResolvedValue(mockAgent);
      mockPrismaService.lead.findUnique.mockResolvedValue(mockLead);
      mockPrismaService.callingConfiguration.findUnique.mockResolvedValue(
        mockConfig,
      );
      mockPrismaService.billingCycle.findFirst.mockResolvedValue(
        mockBillingCycle,
      );
      mockPrismaService.usageRecord.aggregate.mockResolvedValue({
        _sum: { minutes: 500 },
      });
      mockPrismaService.call.create.mockResolvedValue({
        id: "call-123",
        providerCallSid: "",
      });
      mockTelephonyProvider.initiateOutboundCall.mockResolvedValue({
        sid: "telnyx-call-control-id-123",
        status: "initiated",
      });

      // Act
      const result = await handler.execute(validCommand);

      // Assert
      expect(result).toBe("call-123");
      expect(mockTelephonyProvider.initiateOutboundCall).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "+14155559999", // Business number
          to: "+14155551234", // Agent's real phone first
        }),
      );
      expect(mockPrismaService.call.update).toHaveBeenCalled();
      expect(mockEventBus.publish).toHaveBeenCalled();
    });

    it("should throw error if agent not found", async () => {
      // Arrange
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      // Act & Assert
      await expect(handler.execute(validCommand)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw error if agent has no phone number", async () => {
      // Arrange
      mockPrismaService.user.findUnique.mockResolvedValue({
        ...mockAgent,
        phoneNumber: null,
      });

      // Act & Assert
      await expect(handler.execute(validCommand)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw error if agent has no assigned business number", async () => {
      // Arrange
      mockPrismaService.user.findUnique.mockResolvedValue({
        ...mockAgent,
        assignedNumber: null,
      });

      // Act & Assert
      await expect(handler.execute(validCommand)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("should throw error if calling is not enabled", async () => {
      // Arrange
      mockPrismaService.user.findUnique.mockResolvedValue(mockAgent);
      mockPrismaService.lead.findUnique.mockResolvedValue(mockLead);
      mockPrismaService.callingConfiguration.findUnique.mockResolvedValue({
        ...mockConfig,
        callingEnabled: false,
      });

      // Act & Assert
      await expect(handler.execute(validCommand)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("should throw error if usage limit exceeded", async () => {
      // Arrange
      mockPrismaService.user.findUnique.mockResolvedValue(mockAgent);
      mockPrismaService.lead.findUnique.mockResolvedValue(mockLead);
      mockPrismaService.callingConfiguration.findUnique.mockResolvedValue(
        mockConfig,
      );
      mockPrismaService.billingCycle.findFirst.mockResolvedValue(
        mockBillingCycle,
      );
      mockPrismaService.usageRecord.aggregate.mockResolvedValue({
        _sum: { minutes: 1500 }, // Over limit
      });

      // Act & Assert
      await expect(handler.execute(validCommand)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("should handle telephony provider errors", async () => {
      // Arrange
      mockPrismaService.user.findUnique.mockResolvedValue(mockAgent);
      mockPrismaService.lead.findUnique.mockResolvedValue(mockLead);
      mockPrismaService.callingConfiguration.findUnique.mockResolvedValue(
        mockConfig,
      );
      mockPrismaService.billingCycle.findFirst.mockResolvedValue(
        mockBillingCycle,
      );
      mockPrismaService.usageRecord.aggregate.mockResolvedValue({
        _sum: { minutes: 500 },
      });
      mockPrismaService.call.create.mockResolvedValue({
        id: "call-123",
        providerCallSid: "",
      });
      mockTelephonyProvider.initiateOutboundCall.mockRejectedValue(
        new Error("Provider API error"),
      );

      // Act & Assert
      await expect(handler.execute(validCommand)).rejects.toThrow(
        BadRequestException,
      );

      // Verify call was marked as failed
      expect(mockPrismaService.call.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "FAILED",
            errorMessage: "Provider API error",
          }),
        }),
      );
    });
  });
});

// ============================================
// E2E TESTS
// ============================================

describe("Calling API (e2e)", () => {
  let app: any;

  beforeAll(async () => {
    // Setup test app
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        /* AppModule */
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("POST /api/calling/calls/outbound", () => {
    it("should initiate an outbound call", () => {
      // Test implementation
    });

    it("should return 403 if calling not allowed", () => {
      // Test implementation
    });

    it("should return 400 if lead not found", () => {
      // Test implementation
    });
  });

  describe("GET /api/calling/calls/:callId", () => {
    it("should return call details", () => {
      // Test implementation
    });

    it("should return 404 if call not found", () => {
      // Test implementation
    });
  });
});
