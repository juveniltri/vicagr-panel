import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    // Several procedures return the whole row to the browser; the webhook
    // route asks for these with omit: false.
    omit: {
      proyecto: {
        secretoWebhookCifrado: true,
        secretoWebhookIv: true,
        secretoWebhookAuthTag: true,
      },
    },
    log:
      process.env.NODE_ENV === "development" ? ["query", "error"] : ["error"],
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient>;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
