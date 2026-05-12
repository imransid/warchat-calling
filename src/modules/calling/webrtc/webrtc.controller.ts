import {
  Controller,
  Post,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { WebRtcService, WebRtcLoginToken } from "./webrtc.service";
import { JwtAuthGuard } from "@/modules/auth/jwt-auth.guard";

@ApiTags("calling")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("calling/webrtc")
export class WebRtcController {
  constructor(private readonly webrtc: WebRtcService) {}

  @Post("token")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Mint a Telnyx WebRTC login token for the current agent",
    description:
      "Returns a short-lived JWT that the browser's @telnyx/webrtc client registers with. A SIP credential is provisioned for the agent on first call and reused thereafter.",
  })
  @ApiResponse({
    status: 200,
    description: "Login token issued",
    schema: {
      example: {
        loginToken: "eyJhbGciOiJSUzI1NiIs...",
        sipUri: "sip:warmchats-agent-uuid@warmchats.sip.telnyx.com",
        expiresAt: "2026-05-12T10:30:00.000Z",
      },
    },
  })
  async getToken(@Request() req: any): Promise<WebRtcLoginToken> {
    return this.webrtc.getLoginToken(req.user.id);
  }
}
