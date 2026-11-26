import { PrismaClient } from "@/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

/**
 * Prisma is the only module that knows about the database. Services receive this client;
 * UI code never imports it. Swapping SQLite for another Prisma-supported database changes
 * this file and the schema provider only.
 */
const globalForDb = globalThis as unknown as { __tcyberDb?: PrismaClient; __tcyberDbUrl?: string };

export function getDb(): PrismaClient {
  const url = process.env.DATABASE_URL ?? "file:./data/t-cyber.db";
  if (!globalForDb.__tcyberDb || globalForDb.__tcyberDbUrl !== url) {
    const adapter = new PrismaBetterSqlite3({ url });
    globalForDb.__tcyberDb = new PrismaClient({ adapter });
    globalForDb.__tcyberDbUrl = url;
  }
  return globalForDb.__tcyberDb;
}

export type Db = PrismaClient;
/** Client available inside an interactive transaction. */
export type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;
