import {
  Process,
  Processor,
  InjectQueue,
  OnQueueFailed,
  OnQueueCompleted,
} from "@nestjs/bull";
import { Job, Queue } from "bull";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { CommandBus } from "@nestjs/cqrs";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ProcessWebhookCommand } from "../commands/impl";
import { PrismaService } from "@/shared/database/prisma.service";

/**
 * Auto-retry worker for failed Telnyx/Twilio webhooks.
 *
 * SOW #8 ("Robust webhook retry + failure handling") requires that a
 * webhook which fails inside our app is automatically retried with a
 * sane backoff — not just left for an admin to find and replay manually.
 *
 * Architecture:
 *
 *   ┌──────────────────────────┐
 *   │ Telnyx hits /webhooks/.. │
 *   └────────────┬─────────────┘
 *                ▼
 *   ┌──────────────────────────┐    fails    ┌──────────────────────┐
 *   │ ProcessWebhookHandler    │ ──────────► │ WebhookLog.status =  │
 *   │ (runs synchronously)     │             │ FAILED, retryCount++ │
 *   └──────────────────────────┘             └──────────┬───────────┘
 *                                                       ▼
 *                          ┌────────────────────────────────────────┐
 *                          │ @Cron every minute:                     │
 *                          │   poll WebhookLog where status=FAILED   │
 *                          │     AND retryCount < MAX_RETRIES        │
 *                          │     AND lastRetryAt was > backoff ago   │
 *                          │   enqueue 'retry-webhook' job each      │
 *                          └────────────────────────┬───────────────┘
 *                                                   ▼
 *                          ┌──────────────────────────────────────┐
 *                          │ WebhookRetryProcessor.handleRetry()  │
 *                          │   re-dispatches ProcessWebhookCmd    │
 *                          │   updates WebhookLog row             │
 *                          └──────────────────────────────────────┘
 *
 * Backoff schedule (matches Telnyx's own retry semantics):
 *   retry 1: 1 minute
 *   retry 2: 5 minutes
 *   retry 3: 30 minutes
 *   then:    give up (status remains FAILED)
 *
 * Idempotency is provided upstream by `WebhookLog.providerEventId @unique`
 * — re-processing the same event is safe because ProcessWebhookHandler
 * looks up the call by providerCallSid and short-circuits on duplicates.
 */

const QUEUE_NAME = "calling-webhook-retries";
const MAX_RETRIES = 3;

// Backoff (minutes) keyed by current retryCount (0-indexed)
const BACKOFF_MINUTES = [1, 5, 30];

interface RetryJobData {
  webhookLogId: string;
}

// ----------------------------------------------------------------------
// Scheduler — runs every minute, finds candidates, enqueues jobs
// ----------------------------------------------------------------------

@Injectable()
export class WebhookRetryScheduler implements OnModuleInit {
  private readonly logger = new Logger(WebhookRetryScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAME) private readonly queue: Queue<RetryJobData>,
  ) {}

  async onModuleInit() {
    this.logger.log("Webhook retry scheduler initialised");
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sweepFailedWebhooks() {
    const now = new Date();

    const candidates = await this.prisma.webhookLog.findMany({
      where: {
        // Only FAILED rows that still have retries left.
        // We deliberately do NOT pick up status=PENDING — those are
        // currently being processed by another worker.
        OR: [{ status: "FAILED" as any }, { status: "RETRYING" as any }],
        retryCount: { lt: MAX_RETRIES },
      },
      orderBy: { lastRetryAt: "asc" },
      take: 100,
    });

    if (candidates.length === 0) return;

    let enqueued = 0;

    for (const log of candidates) {
      // Determine whether enough time has elapsed since the last attempt.
      const backoffMin = BACKOFF_MINUTES[log.retryCount] ?? 60;
      const earliestNextAttempt = log.lastRetryAt
        ? new Date(log.lastRetryAt.getTime() + backoffMin * 60_000)
        : log.processedAt
          ? new Date(log.processedAt.getTime() + backoffMin * 60_000)
          : now; // Never tried yet → run now

      if (earliestNextAttempt > now) continue;

      await this.queue.add(
        "retry-webhook",
        { webhookLogId: log.id },
        {
          // de-duplicate concurrent enqueues for the same log
          jobId: `wh-retry-${log.id}-${log.retryCount}`,
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      );
      enqueued++;
    }

    if (enqueued > 0) {
      this.logger.log(
        `Webhook sweep: ${enqueued} retry job(s) enqueued (${candidates.length} candidates)`,
      );
    }
  }
}

// ----------------------------------------------------------------------
// Processor — consumes jobs, re-runs ProcessWebhookCommand
// ----------------------------------------------------------------------

@Processor(QUEUE_NAME)
@Injectable()
export class WebhookRetryProcessor {
  private readonly logger = new Logger(WebhookRetryProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commandBus: CommandBus,
  ) {}

  @Process("retry-webhook")
  async handleRetry(job: Job<RetryJobData>) {
    const { webhookLogId } = job.data;

    const log = await this.prisma.webhookLog.findUnique({
      where: { id: webhookLogId },
    });

    if (!log) {
      this.logger.warn(`Retry skipped — log ${webhookLogId} disappeared`);
      return;
    }

    if (log.retryCount >= MAX_RETRIES) {
      this.logger.warn(
        `Retry skipped — log ${webhookLogId} already exhausted (${log.retryCount}/${MAX_RETRIES})`,
      );
      return;
    }

    // Mark in-flight
    await this.prisma.webhookLog.update({
      where: { id: webhookLogId },
      data: {
        status: "RETRYING" as any,
        lastRetryAt: new Date(),
        retryCount: { increment: 1 },
      },
    });

    try {
      const payload: any = log.payload;
      const eventType: string =
        payload?.data?.event_type ||
        payload?.event_type ||
        log.eventType ||
        "unknown";

      await this.commandBus.execute(
        new ProcessWebhookCommand(
          log.provider as any,
          eventType,
          payload,
          log.callId ?? undefined,
        ),
      );

      await this.prisma.webhookLog.update({
        where: { id: webhookLogId },
        data: {
          status: "PROCESSED" as any,
          processedAt: new Date(),
          errorMessage: null,
        },
      });

      this.logger.log(
        `Retry success: ${webhookLogId} (attempt ${log.retryCount + 1})`,
      );
    } catch (error) {
      const exhausted = log.retryCount + 1 >= MAX_RETRIES;

      await this.prisma.webhookLog.update({
        where: { id: webhookLogId },
        data: {
          status: "FAILED" as any,
          errorMessage: error.message,
        },
      });

      this.logger.error(
        `Retry FAILED: ${webhookLogId} (attempt ${
          log.retryCount + 1
        }/${MAX_RETRIES})${exhausted ? " — giving up" : ""}: ${error.message}`,
      );

      // Throw so Bull marks the job failed; the scheduler will pick it
      // up again next sweep if retryCount < MAX_RETRIES.
      throw error;
    }
  }

  @OnQueueCompleted()
  onCompleted(job: Job) {
    this.logger.debug(`Job ${job.id} completed`);
  }

  @OnQueueFailed()
  onFailed(job: Job, err: Error) {
    this.logger.debug(`Job ${job.id} failed: ${err.message}`);
  }
}

// ----------------------------------------------------------------------
// Module wiring helper — register in CallingModule.imports/providers
// ----------------------------------------------------------------------

export const WEBHOOK_RETRY_QUEUE_NAME = QUEUE_NAME;
