import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditController } from "./audit.controller";
import { EventLogRecord } from "./event-log.entity";
import { EventLogService } from "./event-log.service";

/**
 * Owner of the append-only event history. Depends only on the platform kernel's event bus; no
 * feature module depends on it (they publish events, this module listens).
 */
@Module({
  imports: [TypeOrmModule.forFeature([EventLogRecord])],
  controllers: [AuditController],
  providers: [EventLogService],
})
export class AuditModule {}
