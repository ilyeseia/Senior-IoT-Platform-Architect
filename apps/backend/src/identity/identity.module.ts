import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "./user.entity";
import { IdentityService } from "./identity.service";
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
  providers: [IdentityService, { provide: APP_GUARD, useClass: JwtAuthGuard }],
  exports: [IdentityService],
})
export class IdentityModule {}
