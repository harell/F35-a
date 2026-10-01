"""
Snap the hand-placed volcanic cones (aucklandMap.ts AKL_CONES / AKL_RANGITOTO) to the LiDAR DEM:
centre = centroid of the summit area (top 30 % of relief inside a search window), height = max.
Prints game-km centres and lat/lon for src/world/terrain/theaters/aucklandMap.ts / src/core/auckland.ts.
Usage: python3 cones.py <dir with dem1m_16.npz>
"""
import sys, numpy as np
from pyproj import Transformer
from scipy.ndimage import map_coordinates, label
D = sys.argv[1] if len(sys.argv) > 1 else '.'
t = Transformer.from_crs(4326, 2193, always_xy=True)
d = np.load(f'{D}/dem1m_16.npz'); h = np.nan_to_num(d['h']); X0 = float(d['x0']); Y1 = float(d['y1']); R = float(d['res'])
O = (-36.8485, 174.7622); MLAT = 110_950.0; MLON = 111_320.0 * np.cos(np.radians(O[0]))
def samp(x, z):
    E, N = t.transform(O[1] + x / MLON, O[0] - z / MLAT)
    return map_coordinates(h, [(Y1 - N) / R - 0.5, (E - X0) / R - 0.5], order=1)
# name: (search centre km x, z, search radius m)
CONES = {'Mt Eden': (0.16, 3.11, 350), 'One Tree Hill': (1.85, 5.71, 350), 'Mt Albert': (-3.76, 4.38, 500), 'Mt Hobson': (2.21, 3.61, 400),
         'Mt St John': (1.60, 3.85, 300), 'Mt Wellington': (7.38, 4.94, 350), 'Mt Roskill': (-2.25, 7.05, 350), 'Mangere Mountain': (1.68, 10.82, 450),
         'North Head': (4.35, -2.39, 350), 'Mt Victoria': (3.19, -2.22, 350), 'Browns Island': (11.83, -1.72, 550), 'Rangitoto': (8.7, -6.85, 500)}
for k, (cx, cz, rad) in CONES.items():
    cx *= 1000; cz *= 1000
    g = np.arange(-rad, rad + 1, 8.0); gx, gz = np.meshgrid(cx + g, cz + g)
    v = samp(gx.ravel(), gz.ravel()).reshape(gx.shape)
    top = v > v.max() - 0.3 * (v.max() - np.percentile(v, 10))
    lab, _ = label(top); m = lab == lab[np.unravel_index(np.argmax(v), v.shape)]
    x, z = gx[m].mean(), gz[m].mean()
    print(f'{k:17s} x {x/1000:6.2f} z {z/1000:6.2f}  h {v.max():5.0f}  lat {O[0]-z/MLAT:.4f} lon {O[1]+x/MLON:.4f}  moved {np.hypot(x-cx, z-cz):4.0f} m')
