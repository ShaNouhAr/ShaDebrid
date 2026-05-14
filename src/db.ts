import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  log: ["warn", "error"],
});

const SETTING_API_KEY = "alldebrid.apikey";
const SETTING_PUBLIC_BASE_URL = "public.baseUrl";

export async function getPublicBaseUrlSetting(): Promise<string | null> {
  const s = await prisma.setting.findUnique({
    where: { key: SETTING_PUBLIC_BASE_URL },
  });
  const v = s?.value?.trim();
  return v || null;
}

/** Empty string clears the override (use request / PUBLIC_URL). */
export async function setPublicBaseUrl(value: string): Promise<void> {
  const v = value.trim().replace(/\/$/, "");
  if (!v) {
    await prisma.setting.deleteMany({
      where: { key: SETTING_PUBLIC_BASE_URL },
    });
    return;
  }
  await prisma.setting.upsert({
    where: { key: SETTING_PUBLIC_BASE_URL },
    create: { key: SETTING_PUBLIC_BASE_URL, value: v },
    update: { value: v },
  });
}

export async function getAlldebridApiKey(): Promise<string | null> {
  const s = await prisma.setting.findUnique({ where: { key: SETTING_API_KEY } });
  return s?.value || null;
}

export async function setAlldebridApiKey(value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SETTING_API_KEY },
    create: { key: SETTING_API_KEY, value },
    update: { value },
  });
}
