import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding database...\n");

  const workspaceId = process.env.SEED_WORKSPACE_ID || "3";
  const userId = process.env.SEED_USER_ID || "3";
  const agentEmail =
    process.env.SEED_AGENT_EMAIL || `seed-agent-${userId}@warmchats.local`;
  const agentName = process.env.SEED_AGENT_NAME || "Test Agent";
  const agentPhoneNumber =
    process.env.SEED_AGENT_PHONE_NUMBER || "+18801234567890";
  /** Must match Telnyx Caller ID Override on warmchat-webrtc (+1-559-383-9632). */
  const businessPhoneNumber =
    process.env.SEED_BUSINESS_PHONE_NUMBER || "+15593839632";
  const legacyBusinessPhoneNumber = "+15593839633";
  const leadId = process.env.SEED_LEAD_ID || "lead-id";
  const leadPhoneNumber =
    process.env.SEED_LEAD_PHONE_NUMBER || "+18809876543210";
  const leadName = process.env.SEED_LEAD_NAME || "Test Customer";
  const leadEmail =
    process.env.SEED_LEAD_EMAIL || `seed-lead-${leadId}@example.com`;

  // ============================================
  // 1. CREATE WORKSPACE
  // ============================================
  console.log("Creating workspace...");
  const workspace = await prisma.workspace.upsert({
    where: { id: workspaceId },
    update: {},
    create: {
      id: workspaceId,
      name: `WarmChats Test Workspace (${workspaceId})`,
    },
  });
  console.log("✅ Workspace created:", workspace.id);

  // ============================================
  // 2. CREATE TEST USER (AGENT)
  // ============================================
  console.log("\nCreating test agent...");
  const agent = await prisma.user.upsert({
    where: { id: userId },
    update: {
      workspaceId: workspace.id,
      email: agentEmail,
      name: agentName,
      phoneNumber: agentPhoneNumber,
    },
    create: {
      id: userId,
      email: agentEmail,
      name: agentName,
      phoneNumber: agentPhoneNumber,
      workspaceId: workspace.id,
    },
  });
  console.log("✅ Agent created:", agent.id);
  console.log("   Agent phone:", agent.phoneNumber);

  // ============================================
  // 3. CREATE TEST LEAD (CUSTOMER)
  // ============================================
  console.log("\nCreating test lead...");
  const lead = await prisma.lead.upsert({
    where: { id: leadId },
    update: {},
    create: {
      id: leadId,
      name: leadName,
      phoneNumber: leadPhoneNumber,
      email: leadEmail,
      workspaceId: workspace.id,
    },
  });
  console.log("✅ Lead created:", lead.id);

  // Align DB with Telnyx (+15593839633 typo → +15593839632) before upsert.
  await alignBusinessLineWithTelnyx({
    agentId: agent.id,
    workspaceId: workspace.id,
    correct: businessPhoneNumber,
    legacy: legacyBusinessPhoneNumber,
  });

  // ============================================
  // 4. CREATE PHONE NUMBER (FROM TELNYX)
  // ============================================
  console.log("\nCreating phone number...");
  const phoneNumber = await prisma.phoneNumber.upsert({
    where: { phoneNumber: businessPhoneNumber },
    update: {
      workspaceId: workspace.id,
      assignedToUserId: agent.id,
      status: "ACTIVE",
    },
    create: {
      phoneNumber: businessPhoneNumber,
      provider: "telnyx",
      providerSid: `seed:${businessPhoneNumber}`,
      status: "ACTIVE",
      capabilities: {
        voice: true,
        sms: true,
      },
      workspaceId: workspace.id,
      assignedToUserId: agent.id,
    },
  });
  console.log("✅ Phone number created:", phoneNumber.phoneNumber);

  // ============================================
  // 5. CREATE CALLING CONFIGURATION
  // ============================================
  console.log("\nCreating calling configuration...");
  const config = await prisma.callingConfiguration.upsert({
    where: { workspaceId: workspace.id },
    update: {
      // Update with client requirements
      provider: "telnyx",
      ringTimeout: 25,
      missedCallSmsTemplate:
        "Currently in an appointment. I will call you back shortly or text me please.",
      autoChargeOverage: true,
      callingEnabled: true,
    },
    create: {
      workspaceId: workspace.id,
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
  console.log("✅ Configuration created");
  console.log("   Provider:", config.provider);
  console.log("   Ring Timeout:", config.ringTimeout, "seconds");
  console.log("   Auto-charge Overage:", config.autoChargeOverage);
  console.log("   Missed Call SMS:", config.missedCallSmsTemplate);

  // ============================================
  // 6. CREATE BILLING CYCLE
  // ============================================
  console.log("\nCreating billing cycle...");
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  const endDate = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
    23,
    59,
    59,
  );

  const existingCycle = await prisma.billingCycle.findFirst({
    where: { workspaceId: workspace.id, startDate, endDate, status: "ACTIVE" },
  });

  const billingCycle =
    existingCycle ||
    (await prisma.billingCycle.create({
      data: {
        workspaceId: workspace.id,
        startDate,
        endDate,
        status: "ACTIVE",
        planMinuteLimit: 1000,
        overageRate: 0.02,
      },
    }));
  console.log("✅ Billing cycle created");
  console.log("   Plan Limit: 1000 minutes");
  console.log("   Overage Rate: $0.02/min");

  // ============================================
  // SUMMARY
  // ============================================
  console.log("\n" + "=".repeat(60));
  console.log("🎉 Seed complete! Test data ready.");
  console.log("=".repeat(60));
  console.log("\n📋 Test Data IDs:");
  console.log("   Workspace ID:", workspace.id);
  console.log("   Agent ID:", agent.id);
  console.log("   Lead ID:", lead.id);
  console.log("   Phone Number ID:", phoneNumber.id);
  console.log("   Config ID:", config.id);
  console.log("   Billing Cycle ID:", billingCycle.id);
  console.log("\n📞 To test outbound call, use:");
  console.log(`   POST /api/calling/calls/outbound`);
  console.log(`   Body: { "leadId": "${lead.id}" }`);
  console.log("\n🔍 Verify in Swagger:");
  console.log("   GET /api/admin/calling/configuration");
  console.log("   GET /api/calling/can-call");
  console.log("   GET /api/admin/calling/phone-numbers");
}

/**
 * Telnyx webhooks use Caller ID Override (+15593839632). If the DB still has
 * the old +15593839633 row, registerWebOriginCall cannot match the agent.
 */
async function alignBusinessLineWithTelnyx(opts: {
  agentId: string;
  workspaceId: string;
  correct: string;
  legacy: string;
}): Promise<void> {
  const { agentId, workspaceId, correct, legacy } = opts;
  const legacyRow = await prisma.phoneNumber.findUnique({
    where: { phoneNumber: legacy },
  });
  const correctRow = await prisma.phoneNumber.findUnique({
    where: { phoneNumber: correct },
  });

  if (legacyRow) {
    await prisma.phoneNumber.update({
      where: { id: legacyRow.id },
      data: { assignedToUserId: null },
    });
  }

  if (legacyRow && !correctRow) {
    await prisma.phoneNumber.update({
      where: { id: legacyRow.id },
      data: {
        phoneNumber: correct,
        providerSid: `seed:${correct}`,
        assignedToUserId: agentId,
        workspaceId,
        status: "ACTIVE",
      },
    });
    console.log(`✅ Business line renamed ${legacy} → ${correct}`);
  } else if (legacyRow && correctRow) {
    await prisma.phoneNumber.update({
      where: { id: correctRow.id },
      data: {
        assignedToUserId: agentId,
        workspaceId,
        status: "ACTIVE",
      },
    });
    console.log(`✅ Agent reassigned from ${legacy} to ${correct}`);
  } else if (correctRow) {
    await prisma.phoneNumber.update({
      where: { id: correctRow.id },
      data: { assignedToUserId: agentId, workspaceId, status: "ACTIVE" },
    });
  }

  await prisma.call.updateMany({
    where: { fromNumber: legacy, agentId },
    data: { fromNumber: correct },
  });
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
