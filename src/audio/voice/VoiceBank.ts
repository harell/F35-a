/**
 * F35-A audio — voice clip loading.
 *
 * load() fetches every public/audio/voice/<id>.mp3 (6 at a time) as bytes — no AudioContext
 * needed, so it can run before the first tap. Decoding happens as soon as a context exists.
 * Missing / undecodable clips are skipped silently (the game just stays quiet for them).
 */
import type { VoiceId } from '../../core/types';
import { VOICE_IDS, voiceUrl } from './voiceIds';

export interface VoiceLoadReport {
  id: VoiceId;
  status: number | 'error';
  bytes: number;
  decoded: boolean;
}

function baseUrl(): string {
  try {
    return import.meta.env?.BASE_URL ?? './';
  } catch {
    return './';
  }
}

export class VoiceBank {
  private readonly bytes = new Map<VoiceId, ArrayBuffer>();
  private readonly buffers = new Map<VoiceId, AudioBuffer>();
  private readonly decoding = new Set<VoiceId>();
  private ctx: BaseAudioContext | null = null;
  private loading: Promise<void> | null = null;
  readonly report = new Map<VoiceId, VoiceLoadReport>();

  /** Clip for playback (null if missing or not decoded yet). */
  get(id: VoiceId): AudioBuffer | null {
    return this.buffers.get(id) ?? null;
  }

  get decodedCount(): number {
    return this.buffers.size;
  }

  /** Provide the context; pending bytes are decoded right away. */
  attach(ctx: BaseAudioContext): void {
    this.ctx = ctx;
    for (const id of this.bytes.keys()) this.decode(id);
  }

  /** Fetch every clip. Never rejects; resolves when all fetches (and decodes, if possible) settle. */
  load(onProgress?: (fraction: number) => void): Promise<void> {
    if (this.loading) return this.loading;
    const ids = [...VOICE_IDS];
    const total = ids.length;
    let done = 0;
    const base = baseUrl();
    const worker = async () => {
      for (;;) {
        const id = ids.shift();
        if (!id) return;
        let status: number | 'error' = 'error';
        let size = 0;
        try {
          const res = await fetch(voiceUrl(id, base));
          status = res.status;
          if (res.ok) {
            const buf = await res.arrayBuffer();
            size = buf.byteLength;
            if (size > 0) {
              this.bytes.set(id, buf);
              await this.decode(id);
            }
          }
        } catch {
          /* offline / missing: skip */
        }
        this.report.set(id, { id, status, bytes: size, decoded: this.buffers.has(id) });
        done++;
        try {
          onProgress?.(done / total);
        } catch {
          /* ignore */
        }
      }
    };
    this.loading = Promise.all(Array.from({ length: 6 }, worker)).then(() => undefined);
    return this.loading;
  }

  private async decode(id: VoiceId): Promise<void> {
    const ctx = this.ctx;
    const bytes = this.bytes.get(id);
    if (!ctx || !bytes || this.buffers.has(id) || this.decoding.has(id)) return;
    this.decoding.add(id);
    try {
      // decodeAudioData detaches its input → pass a copy so a retry stays possible
      const copy = bytes.slice(0);
      const buf = await new Promise<AudioBuffer>((resolve, reject) => {
        const p = ctx.decodeAudioData(copy, resolve, reject) as Promise<AudioBuffer> | undefined;
        p?.then(resolve, reject);
      });
      this.buffers.set(id, buf);
      this.bytes.delete(id);
      const r = this.report.get(id);
      if (r) r.decoded = true;
    } catch {
      /* undecodable clip: skip */
    } finally {
      this.decoding.delete(id);
    }
  }
}
