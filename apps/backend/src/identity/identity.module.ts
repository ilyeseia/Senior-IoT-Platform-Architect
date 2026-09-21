import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "./user.entity";
import { ADMIN_BOOTSTRAP_TOKEN, IdentityService } from "./identity.service";
import { LoginThrottle } from "./login-throttle";
import { IdentityController } from "./identity.controller";
import { JwtAuthGuard } from "./jwt-auth.guard";
import type { Env } from "../config/env.validation";

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get("JWT_SECRET", { infer: true }),
        signOptions: { expiresIn: "12h" },
      }),
    }),
  ],
  controllers: [IdentityController],
  providers: [
    IdentityService,
    LoginThrottle,
    {
      provide: ADMIN_BOOTSTRAP_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => config.get("ADMIN_BOOTSTRAP_TOKEN", { infer: true }),
    },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [IdentityService],
})
export class IdentityModule {}
