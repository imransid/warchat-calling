import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";
import { SwaggerConfig } from "./config/swagger.config";
import compression = require("compression");
import helmet from "helmet";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn", "log", "debug", "verbose"],
  });

  // ============================================
  // SECURITY
  // ============================================

  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(",") || "*",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  });

  app.use(
    helmet({
      contentSecurityPolicy: process.env.NODE_ENV === "production",
    }),
  );

  // ============================================
  // COMPRESSION
  // ============================================

  app.use(compression());

  // ============================================
  // TEST AUTH MIDDLEWARE (FOR DEVELOPMENT)
  // ============================================
  // This injects a fake user for testing without real auth
  // REMOVE OR REPLACE WITH REAL JWT AUTH IN PRODUCTION!

  if (process.env.NODE_ENV !== "production") {
    app.use((req: any, res: any, next: any) => {
      req.user = {
        id: "agent-id",
        email: "agent@warmchats.com",
        name: "Test Agent",
        workspaceId: "workspace-id",
      };
      next();
    });
  }

  // ============================================
  // VALIDATION
  // ============================================

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
      disableErrorMessages: process.env.NODE_ENV === "production",
    }),
  );

  // ============================================
  // GLOBAL PREFIX (Removed versioning to fix /api/api/v1/api/ issue)
  // ============================================

  app.setGlobalPrefix("api", {
    exclude: [
      "health",
      "webhooks/calling/twilio/(.*)",
      "webhooks/calling/telnyx/(.*)",
    ],
  });

  // ============================================
  // SWAGGER DOCUMENTATION
  // ============================================

  if (
    process.env.NODE_ENV !== "production" ||
    process.env.ENABLE_DOCS === "true"
  ) {
    SwaggerConfig.setup(app);
  }

  // ============================================
  // HEALTH CHECK
  // ============================================

  app.getHttpAdapter().get("/health", (req, res) => {
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || "development",
      version: process.env.npm_package_version || "1.0.0",
    });
  });

  // ============================================
  // GRACEFUL SHUTDOWN
  // ============================================

  app.enableShutdownHooks();

  // ============================================
  // START SERVER
  // ============================================

  const port = process.env.PORT || 3000;
  await app.listen(port);

  const serverUrl = await app.getUrl();

  console.log("\n");
  console.log(
    "╔═══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║   🚀 WarmChats Calling Module                                ║",
  );
  console.log(
    "╠═══════════════════════════════════════════════════════════════╣",
  );
  console.log(`║   Server:        ${serverUrl.padEnd(43)} ║`);
  console.log(
    `║   Environment:   ${(process.env.NODE_ENV || "development").padEnd(43)} ║`,
  );
  console.log(
    "╠═══════════════════════════════════════════════════════════════╣",
  );
  console.log(
    "║   📚 Documentation:                                          ║",
  );
  console.log(`║      Swagger UI:    ${serverUrl}/api/docs                  ║`);
  console.log(
    "╠═══════════════════════════════════════════════════════════════╣",
  );
  console.log(
    "║   🔌 Endpoints:                                              ║",
  );
  console.log(
    "║      Health:        /health                                   ║",
  );
  console.log(
    "║      API:           /api/calling/*                            ║",
  );
  console.log(
    "║      Admin:         /api/admin/calling/*                      ║",
  );
  console.log(
    "║      Webhooks:      /webhooks/calling/[provider]/*            ║",
  );
  console.log(
    "╠═══════════════════════════════════════════════════════════════╣",
  );
  console.log(
    "║   📊 Status:                                                 ║",
  );
  console.log(
    `║      Database:      ${process.env.DATABASE_URL ? "✓ Connected" : "✗ Not configured"}${" ".repeat(35)} ║`,
  );
  console.log(
    `║      Provider:      ${process.env.TELNYX_API_KEY ? "Telnyx" : "Not configured"}${" ".repeat(35)} ║`,
  );
  console.log(
    "║      🧪 Test Auth:  ✓ Enabled (dev mode)                     ║",
  );
  console.log(
    "╚═══════════════════════════════════════════════════════════════╝",
  );
  console.log("\n");
}

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

bootstrap();
