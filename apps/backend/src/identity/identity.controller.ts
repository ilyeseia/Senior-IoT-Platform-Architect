import { BadRequestException, Body, Controller, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { IdentityService } from "./identity.service";
import { Public } from "./public.decorator";

const CredentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

/** Registration additionally accepts the first-admin bootstrap secret (see IdentityService.register). */
const RegisterSchema = CredentialsSchema.extend({ bootstrapToken: z.string().max(256).optional() });

// Matches this codebase's existing convention (mqtt.controller.ts,
// esp-claw.controller.ts, devices.service.ts) of a BadRequestException with
// a readable message, rather than letting a ZodError bubble up as a 500.
function parseCredentials(body: unknown): { email: string; password: string } {
  return parse(CredentialsSchema, body);
}

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(result.error.issues.map((i) => i.message).join("; "));
  }
  return result.data;
}

@Controller("auth")
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Public()
  @Post("register")
  register(@Body() body: unknown) {
    const { email, password, bootstrapToken } = parse(RegisterSchema, body);
    return this.identity.register(email, password, bootstrapToken);
  }

  @Public()
  @Post("login")
  login(@Body() body: unknown, @Req() req: { ip?: string }) {
    const { email, password } = parseCredentials(body);
    return this.identity.login(email, password, req.ip);
  }
}
