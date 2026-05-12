-- CreateEnum
CREATE TYPE "PhoneNumberStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'RELEASED');

-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('INITIATED', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "CallEventType" AS ENUM ('CALL_INITIATED', 'AGENT_RINGING', 'AGENT_ANSWERED', 'CUSTOMER_RINGING', 'CUSTOMER_ANSWERED', 'CALL_CONNECTED', 'CALL_COMPLETED', 'CALL_FAILED', 'CALL_NO_ANSWER', 'CALL_BUSY', 'CALL_CANCELED', 'MISSED_CALL_SMS_SENT', 'WEB_LEG_RINGING', 'PHONE_LEG_RINGING', 'ANSWERED_ON_WEB', 'ANSWERED_ON_PHONE', 'LOSER_LEG_CANCELED', 'BUSY_AGENT_OCCUPIED');

-- CreateEnum
CREATE TYPE "BillingCycleStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'SETTLED');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'RETRYING');

-- CreateTable
CREATE TABLE "phone_numbers" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSid" TEXT NOT NULL,
    "status" "PhoneNumberStatus" NOT NULL DEFAULT 'PROVISIONING',
    "capabilities" JSONB NOT NULL,
    "assignedToUserId" TEXT,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "phone_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" TEXT NOT NULL,
    "providerCallSid" TEXT NOT NULL,
    "direction" "CallDirection" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'INITIATED',
    "fromNumber" TEXT NOT NULL,
    "toNumber" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "businessNumberId" TEXT NOT NULL,
    "agentPhoneNumber" TEXT NOT NULL,
    "customerNumber" TEXT NOT NULL,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "recordingUrl" TEXT,
    "recordingSid" TEXT,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ringingAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "webLegSid" TEXT,
    "phoneLegSid" TEXT,
    "answeredVia" TEXT,
    "origin" TEXT DEFAULT 'phone',
    "providerMetadata" JSONB,
    "errorMessage" TEXT,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_events" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "eventType" "CallEventType" NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "providerEventId" TEXT,
    "webhookPayload" JSONB,

    CONSTRAINT "call_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_cycles" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "BillingCycleStatus" NOT NULL DEFAULT 'ACTIVE',
    "planMinuteLimit" INTEGER NOT NULL,
    "overageRate" DECIMAL(10,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "billingCycleId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "minutes" DECIMAL(10,4) NOT NULL,
    "cost" DECIMAL(10,4) NOT NULL,
    "isOverage" BOOLEAN NOT NULL DEFAULT false,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calling_configurations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ringTimeout" INTEGER NOT NULL DEFAULT 25,
    "missedCallSmsTemplate" TEXT NOT NULL DEFAULT 'Currently in an appointment. I will call you back shortly or text me please.',
    "ringStrategy" TEXT NOT NULL DEFAULT 'parallel',
    "provider" TEXT NOT NULL DEFAULT 'telnyx',
    "providerAccountSid" TEXT NOT NULL,
    "providerAuthToken" TEXT NOT NULL,
    "webhookUrl" TEXT,
    "webhookRetryAttempts" INTEGER NOT NULL DEFAULT 3,
    "webhookRetryDelay" INTEGER NOT NULL DEFAULT 5000,
    "callingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "recordingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoChargeOverage" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calling_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_logs" (
    "id" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastRetryAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "payload" JSONB NOT NULL,
    "errorMessage" TEXT,
    "callId" TEXT,
    "workspaceId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "phoneNumber" TEXT,
    "telnyxCredentialId" TEXT,
    "telnyxSipUri" TEXT,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_phoneNumber_key" ON "phone_numbers"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_providerSid_key" ON "phone_numbers"("providerSid");

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_assignedToUserId_key" ON "phone_numbers"("assignedToUserId");

-- CreateIndex
CREATE INDEX "phone_numbers_workspaceId_idx" ON "phone_numbers"("workspaceId");

-- CreateIndex
CREATE INDEX "phone_numbers_assignedToUserId_idx" ON "phone_numbers"("assignedToUserId");

-- CreateIndex
CREATE UNIQUE INDEX "calls_providerCallSid_key" ON "calls"("providerCallSid");

-- CreateIndex
CREATE INDEX "calls_leadId_idx" ON "calls"("leadId");

-- CreateIndex
CREATE INDEX "calls_agentId_idx" ON "calls"("agentId");

-- CreateIndex
CREATE INDEX "calls_workspaceId_idx" ON "calls"("workspaceId");

-- CreateIndex
CREATE INDEX "calls_status_idx" ON "calls"("status");

-- CreateIndex
CREATE INDEX "calls_createdAt_idx" ON "calls"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "call_events_providerEventId_key" ON "call_events"("providerEventId");

-- CreateIndex
CREATE INDEX "call_events_callId_timestamp_idx" ON "call_events"("callId", "timestamp");

-- CreateIndex
CREATE INDEX "billing_cycles_workspaceId_startDate_idx" ON "billing_cycles"("workspaceId", "startDate");

-- CreateIndex
CREATE INDEX "usage_records_billingCycleId_workspaceId_idx" ON "usage_records"("billingCycleId", "workspaceId");

-- CreateIndex
CREATE INDEX "usage_records_agentId_billingCycleId_idx" ON "usage_records"("agentId", "billingCycleId");

-- CreateIndex
CREATE UNIQUE INDEX "calling_configurations_workspaceId_key" ON "calling_configurations"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_logs_providerEventId_key" ON "webhook_logs"("providerEventId");

-- CreateIndex
CREATE INDEX "webhook_logs_providerEventId_idx" ON "webhook_logs"("providerEventId");

-- CreateIndex
CREATE INDEX "webhook_logs_status_retryCount_idx" ON "webhook_logs"("status", "retryCount");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_telnyxCredentialId_key" ON "users"("telnyxCredentialId");

-- CreateIndex
CREATE INDEX "users_workspaceId_idx" ON "users"("workspaceId");

-- CreateIndex
CREATE INDEX "leads_workspaceId_phoneNumber_idx" ON "leads"("workspaceId", "phoneNumber");

-- AddForeignKey
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_businessNumberId_fkey" FOREIGN KEY ("businessNumberId") REFERENCES "phone_numbers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_callId_fkey" FOREIGN KEY ("callId") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_cycles" ADD CONSTRAINT "billing_cycles_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_callId_fkey" FOREIGN KEY ("callId") REFERENCES "calls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_billingCycleId_fkey" FOREIGN KEY ("billingCycleId") REFERENCES "billing_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calling_configurations" ADD CONSTRAINT "calling_configurations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
