/** Job context + temp-dir lifecycle. */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { getConfig } from "../config";

export type Job = {
  id: string;
  telegramId: number;
  chatId: number;
  url: string;
  youtubeId: string;
  dir: string;
};

export function newJobId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export async function createJobDir(id: string): Promise<string> {
  const dir = join(getConfig().workDir, id);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanupJobDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
