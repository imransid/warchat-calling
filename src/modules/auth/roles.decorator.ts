import { SetMetadata } from "@nestjs/common";

export const ROLES_KEY = "calling_roles";

export type WorkspaceRole = "Owner" | "Manager" | "Representative" | "Guest";

export const Roles = (...roles: WorkspaceRole[]) =>
  SetMetadata(ROLES_KEY, roles);
