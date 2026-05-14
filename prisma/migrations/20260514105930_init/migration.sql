-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Download" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "inputLabel" TEXT NOT NULL,
    "name" TEXT,
    "alldebridMagnetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "expirationMode" TEXT NOT NULL DEFAULT 'duration',
    "expirationSeconds" INTEGER,
    "firstOpenedAt" DATETIME,
    "scheduledDeleteAt" DATETIME,
    "shareToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" DATETIME,
    "deletedAt" DATETIME,
    CONSTRAINT "Download_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DownloadFile" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "downloadId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "directUrl" TEXT,
    "sourceUrl" TEXT,
    CONSTRAINT "DownloadFile_downloadId_fkey" FOREIGN KEY ("downloadId") REFERENCES "Download" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Download_shareToken_key" ON "Download"("shareToken");

-- CreateIndex
CREATE INDEX "Download_userId_idx" ON "Download"("userId");

-- CreateIndex
CREATE INDEX "Download_status_idx" ON "Download"("status");

-- CreateIndex
CREATE INDEX "DownloadFile_downloadId_idx" ON "DownloadFile"("downloadId");
