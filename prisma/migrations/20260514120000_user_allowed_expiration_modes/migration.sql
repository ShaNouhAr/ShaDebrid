ALTER TABLE "User" ADD COLUMN "allowedExpirationModes" TEXT NOT NULL DEFAULT 'single_use,duration,none';
