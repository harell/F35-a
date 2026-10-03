"""
F35-A — hero landmarks: the Auckland Harbour Bridge measurements behind tools/hero/examples/harbour-bridge.html.

A bridge doesn't fit the kit (model.json prisms), so this script only measures; the geometry is bespoke in the page.
Run after
  python3 tools/hero/site.py --name harbour_bridge --lat -36.8313 --lon 174.7452 --size 1300 --res 0.3 --scale 80
  python3 tools/hero/sites/harbour_bridge.py --site /tmp/hero/harbour_bridge
It reads the OSM piers (bridge:support=pier, from the LINZ chart) from the main OSM API, fits the pier line as the
bridge axis, re-centres it on the LiDAR deck edges, and prints:
  - the deck's two grades and the vertical curve between them (the page's deck(s));
  - the top-chord profile of both trusses above the deck (the page's CH table) and their offset from the centreline;
  - the panel length, from the autocorrelation of the top bracing along the centreline;
  - full-width objects over the road (sign gantries) and the flagpole spike.
Writes <site>/axis.json {o, dir, nrm} in the site frame (x = E − E0 east, z = N1 − N south): s runs north along the
pier line (southern-most pier at s = −679.0), t across it. Data: LINZ CC BY 4.0, © OpenStreetMap contributors (ODbL).
"""
import argparse, json, urllib.request
import xml.etree.ElementTree as ET

import numpy as np
from pyproj import Transformer

PIERS = ('1000929555', '1000929556', '1000929557', '1000929558', '1000929559', '1000929560')
to_nztm = Transformer.from_crs(4326, 2193, always_xy=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    a = ap.parse_args()
    site = json.load(open(f'{a.site}/site.json'))
    E0, _, _, N1 = site['box_nztm']
    lo0, la0, lo1, la1 = site['box_wgs84']
    url = f'https://api.openstreetmap.org/api/0.6/map?bbox={lo0:.6f},{la0:.6f},{lo1:.6f},{la1:.6f}'
    root = ET.fromstring(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'F35-A-hero-buildings/1.0'}), timeout=120).read())
    nodes = {n.get('id'): (float(n.get('lon')), float(n.get('lat'))) for n in root.iter('node')}
    piers = []
    for w in root.iter('way'):
        if w.get('id') in PIERS:
            xy = [to_nztm.transform(*nodes[nd.get('ref')]) for nd in w.iter('nd')]
            piers.append(np.mean([[E - E0, N1 - N] for E, N in xy], axis=0))
    piers = np.array(piers)

    d = np.load(f'{a.site}/lidar.npz')
    dsm = d['dsm']
    H, W = dsm.shape
    sample = lambda x, z: dsm[np.clip(np.round(z).astype(int), 0, H - 1), np.clip(np.round(x).astype(int), 0, W - 1)]

    # axis = the pier line, pointing north
    c = piers.mean(0)
    _, _, vt = np.linalg.svd(piers - c)
    dv = vt[0] if vt[0][1] < 0 else -vt[0]
    nv = np.array([-dv[1], dv[0]])
    # re-centre on the deck: fit the mid-point of the deck edges along s
    ss, cc = [], []
    for s in range(-740, 160, 4):
        ts = np.arange(-30, 30.5, 0.5)
        h = sample(*(c + dv * s + np.outer(ts, nv)).T)
        if (h > 3).any():
            ss.append(s); cc.append((ts[h > 3].min() + ts[h > 3].max()) / 2)
    k = np.polyfit(ss, cc, 1)
    o = c + nv * k[1]
    dv = dv + nv * k[0]; dv /= np.linalg.norm(dv); nv = np.array([-dv[1], dv[0]])
    # s origin: the page's frame puts the southern-most pier at s = −679.0 (main span centre ≈ −20.7)
    o = o + dv * (min((p - o) @ dv for p in piers) + 679.0)
    json.dump({'o': o.tolist(), 'dir': dv.tolist(), 'nrm': nv.tolist()}, open(f'{a.site}/axis.json', 'w'))
    print('piers at s =', sorted(round(float((p - o) @ dv), 1) for p in piers))

    ts = np.arange(-25, 25.5, 0.5)
    s_all = np.arange(-800, 330, 1.0)
    X = np.array([sample(*(o + dv * s + np.outer(ts, nv)).T) for s in s_all])
    deck = np.median(X[:, np.abs(ts) <= 17], axis=1)
    deck = np.array([np.median(deck[max(0, i - 12): i + 13]) for i in range(len(deck))])
    m1 = (s_all > -740) & (s_all < -260); m2 = (s_all > 160) & (s_all < 260)
    g1 = np.polyfit(s_all[m1], deck[m1], 1); g2 = np.polyfit(s_all[m2], deck[m2], 1)
    sv = (g2[1] - g1[1]) / (g1[0] - g2[0])
    crest = deck[np.argmin(abs(s_all - sv))]
    L = 8 * (np.polyval(g1, sv) - crest) / (g1[0] - g2[0])
    print(f'deck grades {g1[0]:+.5f} (c {g1[1]:.3f}) and {g2[0]:+.5f} (c {g2[1]:.3f}), RMS {np.std(deck[m1] - np.polyval(g1, s_all[m1])):.2f} m;'
          f' vertical curve centred at s {sv:.1f}, length {L:.0f} m, crest {crest:.2f} m')

    for side in (-7.5, 7.5):
        top = X[:, np.abs(ts - side) <= 1.5].max(1)
        print(f'top chord t={side:+}:', [(x, round(float(np.percentile(top[(s_all >= x - 3) & (s_all < x + 3)], 90)), 1)) for x in range(-196, 128, 12)])
    j = np.argmin(abs(ts))
    m = (s_all > -160) & (s_all < 90)
    h = X[m, j] - np.convolve(X[m, j], np.ones(31) / 31, 'same')
    h = h[20:-20]
    ac = np.correlate(h, h, 'full')[len(h) - 1:]
    print('panel length (top bracing period) ≈', int(np.argmax(ac[8:30]) + 8), 'm')
    for s0 in range(-800, 330, 2):
        i = np.argmin(abs(s_all - s0))
        row = X[i] - deck[i]
        wide = (row > 5) & (np.abs(np.abs(ts) - 7.5) > 2.5)
        if wide.sum() > 40:
            print(f'full-width object at s {s0}: up to {row.max():.1f} m over the road')
    print('highest point', round(float(X.max()), 1), 'm at s', s_all[np.unravel_index(X.argmax(), X.shape)[0]])


if __name__ == '__main__':
    main()
