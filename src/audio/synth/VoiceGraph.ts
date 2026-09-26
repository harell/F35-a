/**
 * F35-A audio — base class for long-lived (continuous) voices: owns its nodes, oscillators
 * and the edges it taps from shared noise sources, and tears all of it down in dispose().
 *
 * Idle gating: a voice's output is disconnected from its bus after ~1.5 s of silence, so the
 * browser stops pulling (processing) its oscillators / filters — pooled voices that are not
 * assigned cost no CPU on the phone. The output is reconnected as soon as it is needed.
 */
import { freqParam, gainParam, SmoothParam } from '../core/SmoothParam';
import { biquad, gainNode, panner } from './build';

export class VoiceGraph {
  protected readonly nodes: AudioNode[] = [];
  protected readonly sources: AudioScheduledSourceNode[] = [];
  /** Edges from shared sources into this voice (disconnected individually on dispose). */
  private readonly taps: [AudioNode, AudioNode][] = [];

  private outNode: AudioNode | null = null;
  private outDest: AudioNode | null = null;
  private attached = false;
  private lastActive = -Infinity;

  constructor(protected readonly ctx: AudioContext) {}

  /** Route the voice's final node to `dest` (connected; subject to gate()). */
  protected setOutput(node: AudioNode, dest: AudioNode): void {
    this.outNode = node;
    this.outDest = dest;
    node.connect(dest);
    this.attached = true;
    this.lastActive = this.ctx.currentTime;
  }

  /** Keep the voice connected while `active` (and ~1.5 s after, for fade-outs). */
  gate(now: number, active: boolean): void {
    if (!this.outNode || !this.outDest) return;
    if (active) {
      this.lastActive = now;
      if (!this.attached) {
        this.outNode.connect(this.outDest);
        this.attached = true;
      }
    } else if (this.attached && now - this.lastActive > 1.5) {
      try {
        this.outNode.disconnect(this.outDest);
      } catch {
        /* ignore */
      }
      this.attached = false;
    }
  }

  /** Connected to its bus right now (tests / lab). */
  get isAttached(): boolean {
    return this.attached;
  }

  protected own<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  protected gain(v = 0): GainNode {
    return this.own(gainNode(this.ctx, v));
  }

  protected filter(type: BiquadFilterType, f: number, q = 0.707, gainDb = 0): BiquadFilterNode {
    return this.own(biquad(this.ctx, type, f, q, gainDb));
  }

  protected panner(): AudioNode & { pan?: AudioParam } {
    return this.own(panner(this.ctx, 0));
  }

  protected osc(type: OscillatorType, f: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.start();
    this.sources.push(o);
    return o;
  }

  /** Connect a shared source (not owned) into one of our nodes. */
  protected tap(src: AudioNode, dst: AudioNode): void {
    src.connect(dst);
    this.taps.push([src, dst]);
  }

  /**
   * src → filters… → new gain → dst. Returns the gain's smoothed param.
   * `shared` = src belongs to someone else (noise bank) → recorded as a tap.
   */
  protected layer(src: AudioNode, filters: AudioNode[], dst: AudioNode, shared: boolean): SmoothParam {
    const g = this.gain(0);
    const chain = [...filters, g];
    if (shared) this.tap(src, chain[0]);
    else src.connect(chain[0]);
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
    g.connect(dst);
    return gainParam(g.gain, 0);
  }

  protected fp(p: AudioParam, v: number): SmoothParam {
    return freqParam(p, v);
  }

  protected gp(p: AudioParam, v: number): SmoothParam {
    return gainParam(p, v);
  }

  protected pp(pn: AudioNode & { pan?: AudioParam }): SmoothParam | null {
    return pn.pan ? new SmoothParam(pn.pan, 0, 0.01, 0) : null;
  }

  dispose(): void {
    for (const [a, b] of this.taps) {
      try {
        a.disconnect(b);
      } catch {
        /* ignore */
      }
    }
    for (const s of this.sources) {
      try {
        s.stop();
        s.disconnect();
      } catch {
        /* ignore */
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.taps.length = 0;
    this.sources.length = 0;
    this.nodes.length = 0;
  }
}
