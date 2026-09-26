import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { Projector, edgeOfEllipse, insideEllipse, makeScreenPoint } from '../src/hud/hmd/projector';

const W = 844;
const H = 390;

function cam(fov = 60): PerspectiveCamera {
  const c = new PerspectiveCamera(fov, W / H, 0.5, 50_000);
  c.position.set(100, 2000, -300);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}

describe('hud projector', () => {
  it('projects a point straight ahead to the screen centre', () => {
    const c = cam();
    const pr = new Projector();
    pr.update(c, W, H);
    const sp = makeScreenPoint();
    expect(pr.point(new Vector3(100, 2000, -5300), sp)).toBe(true);
    expect(sp.x).toBeCloseTo(W / 2, 3);
    expect(sp.y).toBeCloseTo(H / 2, 3);
    expect(sp.depth).toBeCloseTo(5000, 3);
    expect(sp.onScreen).toBe(true);
    expect(sp.offAxis).toBeCloseTo(0, 5);
  });

  it('maps right/up correctly and the vertical half-FOV to the screen edge', () => {
    const c = cam(60);
    const pr = new Projector();
    pr.update(c, W, H);
    const sp = makeScreenPoint();
    pr.point(new Vector3(100 + 100, 2000, -300 - 1000), sp);
    expect(sp.x).toBeGreaterThan(W / 2);
    const up = Math.tan((30 * Math.PI) / 180) * 1000;
    pr.point(new Vector3(100, 2000 + up, -1300), sp);
    expect(sp.y).toBeCloseTo(0, 2);
    expect(pr.pxPerRad).toBeCloseTo(H / 2 / Math.tan(Math.PI / 6), 3);
  });

  it('reports points behind the camera with a screen direction', () => {
    const c = cam();
    const pr = new Projector();
    pr.update(c, W, H);
    const sp = makeScreenPoint();
    // behind and to the right
    expect(pr.point(new Vector3(100 + 50, 2000, -300 + 400), sp)).toBe(false);
    expect(sp.front).toBe(false);
    expect(sp.onScreen).toBe(false);
    expect(sp.dirX).toBeGreaterThan(0.99);
    expect(sp.offAxis).toBeGreaterThan(Math.PI / 2);
  });

  it('direction projection equals far-point projection and follows camera rotation', () => {
    const c = cam();
    c.quaternion.copy(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.4));
    c.updateMatrixWorld();
    const pr = new Projector();
    pr.update(c, W, H);
    const d = new Vector3(0.2, 0.1, -1).normalize();
    const a = makeScreenPoint();
    const b = makeScreenPoint();
    pr.dir(d, a);
    pr.point(d.clone().multiplyScalar(1e6).add(c.position), b);
    expect(a.x).toBeCloseTo(b.x, 1);
    expect(a.y).toBeCloseTo(b.y, 1);
    // camera forward projects to centre
    pr.dir(pr.forward, a);
    expect(a.x).toBeCloseTo(W / 2, 3);
    expect(a.y).toBeCloseTo(H / 2, 3);
  });

  it('ellipse edge helpers', () => {
    const out = { x: 0, y: 0 };
    edgeOfEllipse(100, 100, 50, 20, 1, 0, out);
    expect(out.x).toBeCloseTo(150);
    expect(out.y).toBeCloseTo(100);
    edgeOfEllipse(100, 100, 50, 20, 0, -3, out);
    expect(out.y).toBeCloseTo(80);
    expect(insideEllipse(120, 100, 100, 100, 50, 20)).toBe(true);
    expect(insideEllipse(100, 125, 100, 100, 50, 20)).toBe(false);
  });
});
