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
import { PermissionsGuard } from "./permissions.guard";
import { UsersController } from "./users.controller";
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
  controllers: [IdentityController, UsersController],
  providers: [
    IdentityService,
    LoginThrottle,
    {
      provide: ADMIN_BOOTSTRAP_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => config.get("ADMIN_BOOTSTRAP_TOKEN", { infer: true }),
    },
    // Order matters: authentication (signature) first, then authorization (live account + permission).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [IdentityService],
})
export class IdentityModule {}
