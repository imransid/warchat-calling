import { CommandHandler, EventBus, ICommandHandler, CommandBus } from '@nestjs/cqrs';
import { Injectable, Logger } from '@nestjs/common';
import { ProcessWebhookCommand } from '../impl';
import { PrismaService } from '@/shared/database/prisma.service';
import { TelephonyProviderFactory } from '../../infrastructure/telephony/telephony-provider.factory';
import { CompleteCallCommand } from '../impl';
import { WebhookReceivedEvent, WebhookProcessedEvent } from '../../events/impl';
import { CallStatus } from '@prisma/client';
import { CallingGateway } from '../../gateway/calling.gateway';

@CommandHandler(ProcessWebhookCommand)
export class ProcessWebhookHandler
  implements ICommandHandler<ProcessWebhookCommand>
{
  private readonly logger = new Logger(ProcessWebhookHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telephonyFactory: TelephonyProviderFactory,
    private readonly eventBus: EventBus,
    private readonly commandBus: CommandBus,
    private readonly gateway: CallingGateway,
  ) {}

  async execute(command: ProcessWebhookCommand): Promise<void> {
    const { provider, eventType, payload, providerEventId } = command;

    this.logger.debug(`Processing webhook: ${provider} - ${eventType} - ${providerEventId}`);

    // ============================================
    // 1. CHECK FOR DUPLICATE (IDEMPOTENCY)
    // ============================================

    const existingLog = await this.prisma.webhookLog.findUnique({
      where: { providerEventId },
    });

    if (existingLog && existingLog.status === 'PROCESSED') {
      this.logger.debug(`Webhook already processed: ${providerEventId}`);
      return;
    }

    // ============================================
    // 2. CREATE OR UPDATE WEBHOOK LOG
    // ============================================

    const webhookLog = await this.prisma.webhookLog.upsert({
      where: { providerEventId },
      create: {
        providerEventId,
        provider,
        eventType,
        status: 'PROCESSING',
        payload,
        receivedAt: new Date(),
      },
      update: {
        status: 'PROCESSING',
        retryCount: { increment: 1 },
        lastRetryAt: new Date(),
      },
    });

    // ============================================
    // 3. EMIT WEBHOOK RECEIVED EVENT
    // ============================================

    this.eventBus.publish(
      new WebhookReceivedEvent(provider, eventType, providerEventId, payload),
    );

    try {
      // ============================================
      // 4. PARSE WEBHOOK PAYLOAD
      // ============================================

      const telephonyProvider = this.telephonyFactory.getProvider(provider);
      const parsedData = telephonyProvider.parseWebhook(payload);

      this.logger.debug(`Parsed webhook data:`, parsedData);

      // ============================================
      // 5. FIND CALL RECORD
      // ============================================

      const call = await this.prisma.call.findUnique({
        where: { providerCallSid: parsedData.callSid },
      });

      if (!call) {
        this.logger.warn(`Call not found for SID: ${parsedData.callSid}`);
        
        // Mark webhook as processed even though call not found
        // (might be a webhook for a different system)
        await this.prisma.webhookLog.update({
          where: { id: webhookLog.id },
          data: {
            status: 'PROCESSED',
            processedAt: new Date(),
          },
        });
        
        return;
      }

      // ============================================
      // 6. UPDATE CALL BASED ON EVENT TYPE
      // ============================================

      await this.handleWebhookEvent(
        call.id,
        parsedData.callSid,
        parsedData.status,
        eventType,
        parsedData,
      );

      // ============================================
      // 7. MARK WEBHOOK AS PROCESSED
      // ============================================

      await this.prisma.webhookLog.update({
        where: { id: webhookLog.id },
        data: {
          status: 'PROCESSED',
          processedAt: new Date(),
          callId: call.id,
          workspaceId: call.workspaceId,
        },
      });

      this.eventBus.publish(
        new WebhookProcessedEvent(webhookLog.id, providerEventId, true),
      );
    } catch (error) {
      this.logger.error(`Failed to process webhook: ${error.message}`, error.stack);

      // ============================================
      // 8. MARK WEBHOOK AS FAILED
      // ============================================

      await this.prisma.webhookLog.update({
        where: { id: webhookLog.id },
        data: {
          status: webhookLog.retryCount < 3 ? 'RETRYING' : 'FAILED',
          errorMessage: error.message,
        },
      });

      this.eventBus.publish(
        new WebhookProcessedEvent(
          webhookLog.id,
          providerEventId,
          false,
          error.message,
        ),
      );

      throw error;
    }
  }

  private async handleWebhookEvent(
    callId: string,
    providerCallSid: string,
    status: string,
    eventType: string,
    parsedData: any,
  ): Promise<void> {
    const call = await this.prisma.call.findUnique({
      where: { id: callId },
    });

    const timestamp = new Date();

    // Map status to our internal status
    const internalStatus = this.mapToInternalStatus(status);

    switch (internalStatus) {
      case 'INITIATED':
        // Row + RINGING are usually set in registerWebOriginCall on
        // call.initiated; nothing else to do here.
        break;

      case 'RINGING':
        await this.prisma.call.update({
          where: { id: callId },
          data: {
            status: CallStatus.RINGING,
            ringingAt: call.ringingAt || timestamp,
          },
        });

        await this.prisma.callEvent.create({
          data: {
            callId,
            eventType: call.direction === 'OUTBOUND' ? 'AGENT_RINGING' : 'CUSTOMER_RINGING',
            timestamp,
            payload: parsedData,
            providerEventId: `${providerCallSid}-ringing`,
          },
        });
        break;

      case 'ANSWERED':
      case 'IN_PROGRESS': {
        await this.prisma.call.update({
          where: { id: callId },
          data: {
            status: CallStatus.IN_PROGRESS,
            answeredAt: call.answeredAt || timestamp,
          },
        });

        await this.prisma.callEvent.create({
          data: {
            callId,
            eventType: 'CALL_CONNECTED',
            timestamp,
            payload: parsedData,
            providerEventId: `${providerCallSid}-connected`,
          },
        });

        this.gateway.emitToUser(call.agentId, 'call_state', {
          callId: call.id,
          status: 'IN_PROGRESS',
          direction: call.direction,
          origin: call.origin || 'phone',
          answeredVia: call.answeredVia || (call.origin === 'web' ? 'web' : 'phone'),
        });
        break;
      }

      case 'COMPLETED':
      case 'NO_ANSWER':
      case 'BUSY':
      case 'FAILED':
      case 'CANCELED':
        // Use CompleteCallCommand to handle call completion
        await this.commandBus.execute(
          new CompleteCallCommand(
            callId,
            providerCallSid,
            parsedData.duration || 0,
            internalStatus,
            timestamp,
          ),
        );
        break;

      default:
        this.logger.warn(`Unhandled call status: ${status}`);
    }
  }

  private mapToInternalStatus(status: string): string {
    // This mapping is already done in the provider parseWebhook method
    // but we keep this as a fallback
    const statusMap: Record<string, string> = {
      'INITIATED': 'INITIATED',
      'RINGING': 'RINGING',
      'IN_PROGRESS': 'IN_PROGRESS',
      'COMPLETED': 'COMPLETED',
      'NO_ANSWER': 'NO_ANSWER',
      'BUSY': 'BUSY',
      'FAILED': 'FAILED',
      'CANCELED': 'CANCELED',
    };

    return statusMap[status] || status;
  }
}
