/**
 * Turning text into vectors with a small model that runs inside FryDay (bge-small, 384 numbers,
 * quantized, about 35 MB). The model is downloaded once from Hugging Face into
 * <FRYDAY_HOME>/models; that download is core's, never an agent's. After it, nothing leaves the
 * machine: the code and the queries are embedded here.
 *
 * The library is an optional dependency. When it is missing, switched off in Settings, or the
 * model cannot be had, search works by keyword alone.
 */

import os from 'os';
import path from 'path';
import { getSettings } from '../../settings.js';

/**
 * Where the model is kept. Shared by every FryDay state folder on the machine (the checks and the
 * benchmark use their own folders), so it is downloaded once. FRYDAY_MODELS moves it.
 */
export function modelsDir(): string {
  return process.env['FRYDAY_MODELS'] ?? path.join(os.homedir(), '.fryday-code', 'models');
}

export const EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
// What bge expects in front of a search query (not in front of the passages searched).
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
const MAX_CHARS = 1800; // the model reads at most 512 tokens; the start of a piece says what it is

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

let loading: Promise<Extractor | null> | null = null;
let failedAt = 0;
let lastError: string | null = null;

export function embeddingsWanted(): boolean {
  return process.env['FRYDAY_EMBED'] !== 'off' && getSettings().semanticSearch;
}

export function embedStatus(): { wanted: boolean; ready: boolean; error: string | null } {
  return { wanted: embeddingsWanted(), ready: loaded !== null, error: lastError };
}

let loaded: Extractor | null = null;

async function load(): Promise<Extractor | null> {
  try {
    const lib = (await import('@huggingface/transformers')) as unknown as {
      pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<Extractor>;
      env: { cacheDir: string; allowRemoteModels: boolean; allowLocalModels: boolean };
    };
    lib.env.cacheDir = modelsDir();
    lib.env.allowRemoteModels = process.env['FRYDAY_EMBED_OFFLINE'] !== '1';
    loaded = await lib.pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' });
    lastError = null;
    return loaded;
  } catch (err) {
    lastError = err instanceof Error ? err.message.slice(0, 300) : String(err);
    failedAt = Date.now();
    console.warn(`[fryday-core] code search by meaning is not available: ${lastError}`);
    return null;
  }
}

/** The model, loaded on first use; null when switched off or it cannot be loaded (tried again after 10 minutes). */
export async function embedder(): Promise<Extractor | null> {
  if (!embeddingsWanted()) return null;
  if (loaded) return loaded;
  if (!loading && failedAt && Date.now() - failedAt < 10 * 60_000) return null;
  loading ??= load().finally(() => { loading = null; });
  return loading;
}

async function embed(texts: string[]): Promise<Float32Array[] | null> {
  const model = await embedder();
  if (!model || texts.length === 0) return model ? [] : null;
  const out = await model(texts.map((t) => t.slice(0, MAX_CHARS)), { pooling: 'mean', normalize: true });
  return out.tolist().map((v) => Float32Array.from(v));
}

/** Vectors for pieces of code or text. */
export function embedPassages(texts: string[]): Promise<Float32Array[] | null> {
  return embed(texts);
}

/** The vector for a search query, or null when search by meaning is not available. */
export async function embedQuery(text: string): Promise<Float32Array | null> {
  const out = await embed([`${QUERY_PREFIX}${text}`]);
  return out?.[0] ?? null;
}

/** For tests: put a stand-in model in place (or null to go back to the real one). */
export function setEmbedderForTests(fake: Extractor | null): void {
  loaded = fake;
  failedAt = 0;
}
