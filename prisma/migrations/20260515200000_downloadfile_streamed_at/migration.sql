-- Add streamedAt to DownloadFile to track which files of a release have been
-- fully delivered to a visitor through the proxy streaming route. Used by
-- single_use expiration to trigger immediate cleanup once every file is consumed.
ALTER TABLE "DownloadFile" ADD COLUMN "streamedAt" DATETIME;
