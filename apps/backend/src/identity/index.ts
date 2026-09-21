/** Public API of the identity module: authentication is global (APP_GUARD); routes opt out with @Public(). */
export { IdentityModule } from "./identity.module";
export { Public, IS_PUBLIC_KEY } from "./public.decorator";
