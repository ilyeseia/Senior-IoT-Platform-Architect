import { BadRequestException } from "@nestjs/common";
import type { ZodTypeAny, z } from "zod";

/**
 * Runtime validation for request bodies. TypeScript interfaces are erased at
 * runtime, so without this a controller receives whatever JSON the caller
 * sent. Zod is already the project's validation library (protocol package,
 * env), so Stage 0 reuses it instead of adding class-validator; Stage 1
 * replaces this with a global pipe + OpenAPI-generating DTOs.
 */
export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException({
      message: "Invalid request body",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}
