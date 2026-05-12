import { Module, Global } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { JwtStrategy } from "./jwt.strategy";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { RolesGuard } from "./roles.guard";
import { UserSyncService } from "./user-sync.service";
import { PrismaService } from "@/shared/database/prisma.service";

@Global()
@Module({
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: "jwt" }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>("JWT_SECRET_KEY"),
        signOptions: { algorithm: "HS256" },
      }),
    }),
  ],
  providers: [
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
    UserSyncService,
    PrismaService,
  ],
  exports: [JwtAuthGuard, RolesGuard, UserSyncService, JwtModule],
})
export class AuthModule {}
