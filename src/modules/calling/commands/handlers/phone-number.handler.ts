import { CommandHandler, EventBus, ICommandHandler } from "@nestjs/cqrs";
import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import {
  ProvisionPhoneNumberCommand,
  AssignPhoneNumberCommand,
  ReleasePhoneNumberCommand,
} from "../impl";
import { PrismaService } from "@/shared/database/prisma.service";
import { TelephonyProviderFactory } from "../../infrastructure/telephony/telephony-provider.factory";
import {
  PhoneNumberProvisionedEvent,
  PhoneNumberAssignedEvent,
  PhoneNumberReleasedEvent,
} from "../../events/impl";

// ============================================
// PROVISION PHONE NUMBER
// ============================================

@CommandHandler(ProvisionPhoneNumberCommand)
export class ProvisionPhoneNumberHandler implements ICommandHandler<ProvisionPhoneNumberCommand> {
  private readonly logger = new Logger(ProvisionPhoneNumberHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telephonyFactory: TelephonyProviderFactory,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: ProvisionPhoneNumberCommand): Promise<string> {
    const { workspaceId, areaCode, country } = command;

    this.logger.log(
      `Provisioning new phone number for workspace ${workspaceId}`,
    );

    // ============================================
    // 1. ENSURE WORKSPACE EXISTS
    // ============================================

    let workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      // Auto-create workspace for testing
      workspace = await this.prisma.workspace.create({
        data: {
          id: workspaceId,
          name: "Default Workspace",
        },
      });
    }

    // ============================================
    // 2. GET CONFIGURATION (or create default)
    // ============================================

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

    // ============================================
    // 3. PROVISION VIA TELEPHONY PROVIDER
    // ============================================

    let providerResponse;
    try {
      const provider = this.telephonyFactory.getProvider(config.provider);
      providerResponse = await provider.provisionNumber({
        areaCode,
        country: country || "US",
        capabilities: {
          voice: true,
          sms: true,
        },
      });
    } catch (error) {
      this.logger.error(
        `Provider failed to provision number: ${error.message}`,
      );

      // For testing without real provider call, create a mock number
      if (process.env.NODE_ENV !== "production") {
        this.logger.warn("Creating mock phone number for testing");
        providerResponse = {
          phoneNumber: `+1${areaCode || "415"}${Math.floor(
            Math.random() * 9000000 + 1000000,
          )}`,
          sid: `mock-${Date.now()}`,
          capabilities: {
            voice: true,
            sms: true,
          },
        };
      } else {
        throw new BadRequestException(
          `Failed to provision number: ${error.message}`,
        );
      }
    }

    // ============================================
    // 4. SAVE TO DATABASE
    // ============================================

    const phoneNumber = await this.prisma.phoneNumber.create({
      data: {
        phoneNumber: providerResponse.phoneNumber,
        provider: config.provider,
        providerSid: providerResponse.sid,
        status: "ACTIVE",
        capabilities: providerResponse.capabilities,
        workspaceId,
      },
    });

    this.logger.log(
      `Phone number provisioned: ${phoneNumber.phoneNumber} (${phoneNumber.id})`,
    );

    // ============================================
    // 5. EMIT DOMAIN EVENT
    // ============================================

    this.eventBus.publish(
      new PhoneNumberProvisionedEvent(
        phoneNumber.id,
        phoneNumber.phoneNumber,
        workspaceId,
        config.provider,
      ),
    );

    return phoneNumber.id;
  }
}

// ============================================
// ASSIGN PHONE NUMBER
// ============================================

@CommandHandler(AssignPhoneNumberCommand)
export class AssignPhoneNumberHandler implements ICommandHandler<AssignPhoneNumberCommand> {
  private readonly logger = new Logger(AssignPhoneNumberHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: AssignPhoneNumberCommand): Promise<void> {
    const { phoneNumberId, userId } = command;

    this.logger.log(`Assigning number ${phoneNumberId} to user ${userId}`);

    // ============================================
    // 1. VALIDATE PHONE NUMBER EXISTS
    // ============================================

    const phoneNumber = await this.prisma.phoneNumber.findUnique({
      where: { id: phoneNumberId },
    });

    if (!phoneNumber) {
      throw new NotFoundException("Phone number not found");
    }

    if (phoneNumber.status !== "ACTIVE") {
      throw new BadRequestException(
        `Cannot assign ${phoneNumber.status.toLowerCase()} number`,
      );
    }

    // ============================================
    // 2. VALIDATE USER EXISTS
    // ============================================

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    // ============================================
    // 3. CHECK IF USER ALREADY HAS A NUMBER
    // ============================================

    const existingNumber = await this.prisma.phoneNumber.findFirst({
      where: { assignedToUserId: userId },
    });

    if (existingNumber && existingNumber.id !== phoneNumberId) {
      throw new ConflictException(
        `User already has a phone number assigned: ${existingNumber.phoneNumber}`,
      );
    }

    // ============================================
    // 4. ASSIGN NUMBER
    // ============================================

    await this.prisma.phoneNumber.update({
      where: { id: phoneNumberId },
      data: { assignedToUserId: userId },
    });

    this.logger.log(
      `Number ${phoneNumber.phoneNumber} assigned to ${user.email}`,
    );

    // ============================================
    // 5. EMIT EVENT
    // ============================================

    this.eventBus.publish(
      new PhoneNumberAssignedEvent(
        phoneNumberId,
        phoneNumber.phoneNumber,
        userId,
        phoneNumber.workspaceId,
      ),
    );
  }
}

// ============================================
// RELEASE PHONE NUMBER
// ============================================

@CommandHandler(ReleasePhoneNumberCommand)
export class ReleasePhoneNumberHandler implements ICommandHandler<ReleasePhoneNumberCommand> {
  private readonly logger = new Logger(ReleasePhoneNumberHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telephonyFactory: TelephonyProviderFactory,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: ReleasePhoneNumberCommand): Promise<void> {
    const { phoneNumberId, reason } = command;

    this.logger.log(
      `Releasing phone number ${phoneNumberId}. Reason: ${reason || "Not specified"}`,
    );

    // ============================================
    // 1. VALIDATE PHONE NUMBER EXISTS
    // ============================================

    const phoneNumber = await this.prisma.phoneNumber.findUnique({
      where: { id: phoneNumberId },
    });

    if (!phoneNumber) {
      throw new NotFoundException("Phone number not found");
    }

    if (phoneNumber.status === "RELEASED") {
      throw new BadRequestException("Phone number is already released");
    }

    // ============================================
    // 2. RELEASE FROM PROVIDER (Optional)
    // ============================================

    try {
      const provider = this.telephonyFactory.getProvider(phoneNumber.provider);
      await provider.releaseNumber(phoneNumber.providerSid);
      this.logger.log(`Released from provider: ${phoneNumber.providerSid}`);
    } catch (error) {
      this.logger.warn(
        `Failed to release from provider: ${error.message}. Continuing with local release.`,
      );
    }

    // ============================================
    // 3. UPDATE DATABASE
    // ============================================

    await this.prisma.phoneNumber.update({
      where: { id: phoneNumberId },
      data: {
        status: "RELEASED",
        releasedAt: new Date(),
        assignedToUserId: null,
      },
    });

    this.logger.log(`Phone number ${phoneNumber.phoneNumber} released`);

    // ============================================
    // 4. EMIT EVENT
    // ============================================

    this.eventBus.publish(
      new PhoneNumberReleasedEvent(
        phoneNumberId,
        phoneNumber.phoneNumber,
        phoneNumber.workspaceId,
        reason,
      ),
    );
  }
}
