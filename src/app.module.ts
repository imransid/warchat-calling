import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { BullModule } from "@nestjs/bull";
import { CallingModule } from "./modules/calling/calling.module";
import { AuthModule } from "./modules/auth/auth.module";
import { PrismaService } from "./shared/database/prisma.service";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
    }),
    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST || "localhost",
        port: parseInt(process.env.REDIS_PORT || "6379", 10),
        password: process.env.REDIS_PASSWORD,
      },
    }),
    AuthModule,
    CallingModule,
  ],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class AppModule {}
