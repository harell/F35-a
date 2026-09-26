/**
 * F35-A input — tilt steering source (DeviceOrientation).
 *
 * Landscape-aware (screen.orientation.angle 90 / 270), calibrated (recenter = current pose becomes
 * neutral), low-pass filtered and shaped by tiltMath.tiltToAxes. iOS 13+ requires
 * DeviceOrientationEvent.requestPermission() from a user gesture (requestPermission()).
 */
import { lowPass } from './curves';
import { DEFAULT_TILT_NEUTRAL, angleDiff, tiltAngles, tiltToAxes, type TiltAngles, type TiltCalibration } from './tiltMath';

type OrientationCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };

export function screenAngle(): number {
  const so = typeof screen !== 'undefined' ? screen.orientation : undefined;
  if (so && typeof so.angle === 'number') return so.angle;
  const wo = (window as unknown as { orientation?: number }).orientation;
  return typeof wo === 'number' ? (wo + 360) % 360 : 0;
}

export class TiltSource {
  roll = 0;
  pitch = 0;
  /** True once at least one orientation event arrived. */
  hasData = false;
  private listening = false;
  private raw: TiltAngles = { bank: 0, back: DEFAULT_TILT_NEUTRAL.back };
  private filt: TiltAngles = { bank: 0, back: DEFAULT_TILT_NEUTRAL.back };
  private neutral: TiltCalibration = { ...DEFAULT_TILT_NEUTRAL };
  private pendingRecenter = false;
  private sensitivity = 1;
  private invert = false;
  private readonly axes = { roll: 0, pitch: 0 };

  configure(sensitivity: number, invertPitch: boolean): void {
    this.sensitivity = sensitivity;
    this.invert = invertPitch;
  }

  start(): void {
    if (this.listening || typeof window === 'undefined') return;
    this.listening = true;
    window.addEventListener('deviceorientation', this.onOrientation);
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener('deviceorientation', this.onOrientation);
    this.roll = this.pitch = 0;
  }

  /** Current pose becomes neutral (applied on the next sample if none has arrived yet). */
  recenter(): void {
    if (this.hasData) {
      this.neutral.bank = this.filt.bank;
      this.neutral.back = this.filt.back;
    } else {
      this.pendingRecenter = true;
    }
  }

  static async requestPermission(): Promise<boolean> {
    const Ctor = (typeof DeviceOrientationEvent !== 'undefined' ? DeviceOrientationEvent : undefined) as OrientationCtor | undefined;
    if (!Ctor) return false;
    if (typeof Ctor.requestPermission !== 'function') return true; // Android / desktop: no prompt
    try {
      return (await Ctor.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }

  update(dt: number): void {
    if (!this.hasData) {
      this.roll = this.pitch = 0;
      return;
    }
    // low-pass the angles (wrapped) to kill hand tremor & sensor noise
    this.filt.bank = this.filt.bank + angleDiff(this.raw.bank, this.filt.bank) * (1 - Math.exp(-dt / 0.07));
    this.filt.back = lowPass(this.filt.back, this.raw.back, dt, 0.07);
    tiltToAxes(this.filt, this.neutral, this.sensitivity, this.invert, this.axes);
    this.roll = this.axes.roll;
    this.pitch = this.axes.pitch;
  }

  private onOrientation = (e: DeviceOrientationEvent): void => {
    if (e.beta == null || e.gamma == null) return;
    tiltAngles(e.beta, e.gamma, screenAngle(), this.raw);
    if (!this.hasData) {
      this.hasData = true;
      this.filt.bank = this.raw.bank;
      this.filt.back = this.raw.back;
    }
    if (this.pendingRecenter) {
      this.pendingRecenter = false;
      this.neutral.bank = this.raw.bank;
      this.neutral.back = this.raw.back;
    }
  };
}
