import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from "typeorm";
import { Command } from "./command.entity";

/**
 * Real response shape verified live against hardware this session:
 *   {"id":"...", "capability":"...", "ok":true|false, "result":"..."}
 */
@Entity({ name: "command_results" })
export class CommandResult {
  @PrimaryColumn({ type: "uuid" })
  commandId!: string;

  @OneToOne(() => Command, { onDelete: "CASCADE" })
  @JoinColumn({ name: "commandId" })
  command!: Command;

  @Column({ type: "boolean" })
  ok!: boolean;

  @Column({ type: "text", nullable: true })
  result!: string | null;

  @Column({ type: "timestamptz" })
  receivedAt!: Date;
}
