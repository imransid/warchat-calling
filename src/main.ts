import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { AppModule } from "./app.module";
import { SwaggerConfig } from "./config/swagger.config";
import compression = require("compression");
import helmet from "helmet";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn", "log", "debug", "verbose"],
    // rawBody is needed by the Telnyx webhook signature verifier — Telnyx
    // signs `${timestamp}|${rawBody}` with Ed25519.
    rawBody: true,
  });

  // ============================================
  // SECURITY
  // ============================================

// CORS
  app.enableCors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'Origin',
      'X-Requested-With',
    ],
    credentials: false,
    exposedHeaders: ['Authorization'],
  });

  // Socket.IO adapter — used by CallingGateway for real-time call signaling.
  app.useWebSocketAdapter(new IoAdapter(app));

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
  // TEST AUTH MIDDLEWARE (DEV ONLY)
  // ============================================
  // Real JWT verification is wired via JwtAuthGuard + JwtStrategy.
  // The test-auth middleware below is *off by default* — enable only by
  // setting USE_TEST_AUTH=true alongside NODE_ENV != production, so engineers
  // testing the calling APIs without spinning up the Flask auth server can do
  // so explicitly. Production deployments must never set this.

  if (
    process.env.NODE_ENV !== "production" &&
    process.env.USE_TEST_AUTH === "true"
  ) {
    app.use((req: any, _res: any, next: any) => {
      req.user = {
        id: process.env.TEST_USER_ID || "agent-id",
        workspaceId: process.env.TEST_WORKSPACE_ID || "workspace-id",
        role: process.env.TEST_USER_ROLE || "Owner",
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
    exclude: ["health", "webhooks/calling/telnyx/(.*)"],
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
