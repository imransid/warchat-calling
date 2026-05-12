import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ROLES_KEY, WorkspaceRole } from "./roles.decorator";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<WorkspaceRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const role = req.user?.role;
    if (!role) {
      throw new ForbiddenException("Role missing on user");
    }
    if (!required.includes(role)) {
      throw new ForbiddenException(
        `Role '${role}' lacks permission. Required: ${required.join(", ")}`,
      );
    }
    return true;
  }
}
