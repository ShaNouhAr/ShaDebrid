import "fastify";
import "@fastify/secure-session";

declare module "fastify" {
  interface FastifyReply {
    locals: Record<string, unknown>;
    renderPage(
      template: string,
      data?: Record<string, unknown>,
      opts?: { layout?: string | false },
    ): Promise<FastifyReply>;
  }
}

declare module "@fastify/secure-session" {
  interface SessionData {
    user: {
      id: number;
      username: string;
      role: "admin" | "user";
    };
    flash: {
      type: "success" | "error" | "info";
      text: string;
    };
  }
}
