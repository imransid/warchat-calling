import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding database...\n");

  // ============================================
  // 1. CREATE WORKSPACE
  // ============================================
  console.log("Creating workspace...");
  const workspace = await prisma.workspace.upsert({
    where: { id: "workspace-id" },
    update: {},
    create: {
      id: "workspace-id",
      name: "WarmChats Test Workspace",
    },
  });
  console.log("✅ Workspace created:", workspace.id);

  // ============================================
  // 2. CREATE TEST USER (AGENT)
  // ============================================
  console.log("\nCreating test agent...");
  const agent = await prisma.user.upsert({
    where: { email: "agent@warmchats.com" },
    update: {},
    create: {
      id: "agent-id",
      email: "agent@warmchats.com",
      name: "Test Agent",
      phoneNumber: "+18801234567890", // ⚠️ REPLACE WITH YOUR REAL PHONE NUMBER
      workspaceId: workspace.id,
    },
  });
  console.log("✅ Agent created:", agent.id);
  console.log("   ⚠️  Update phoneNumber with YOUR real phone for testing!");

  // ============================================
  // 3. CREATE TEST LEAD (CUSTOMER)
  // ============================================
  console.log("\nCreating test lead...");
  const lead = await prisma.lead.upsert({
    where: { id: "lead-id" },
    update: {},
    create: {
      id: "lead-id",
      name: "Test Customer",
      phoneNumber: "+18809876543210", // ⚠️ REPLACE WITH ANOTHER PHONE FOR TESTING
      email: "customer@example.com",
      workspaceId: workspace.id,
    },
  });
  console.log("✅ Lead created:", lead.id);

  // ============================================
  // 4. CREATE PHONE NUMBER (FROM TELNYX)
  // ============================================
  console.log("\nCreating phone number...");
  const phoneNumber = await prisma.phoneNumber.upsert({
    where: { phoneNumber: "+15593839632" }, // Your Telnyx number
    update: {},
    create: {
      phoneNumber: "+15593839632", // ⚠️ Use your actual Telnyx number
      provider: "telnyx",
      providerSid: "telnyx-number-sid", // From Telnyx
      status: "ACTIVE",
      capabilities: {
        voice: true,
        sms: true,
      },
      workspaceId: workspace.id,
      assignedToUserId: agent.id, // Assign to test agent
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

  const billingCycle = await prisma.billingCycle.create({
    data: {
      workspaceId: workspace.id,
      startDate,
      endDate,
      status: "ACTIVE",
      planMinuteLimit: 1000,
      overageRate: 0.02,
    },
  });
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

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
