import json,os,sys,numpy as np,rasterio
from rasterio.windows import from_bounds
from rasterio.enums import Resampling
from pyproj import Transformer
os.environ['GDAL_DISABLE_READDIR_ON_OPEN']='EMPTY_DIR'; os.environ['GDAL_HTTP_MULTIRANGE']='YES'
name,prefix,res=sys.argv[1],sys.argv[2],float(sys.argv[3])
# game box ±45 km around Sky Tower in equirect -> NZTM bounds (+margin)
O=(-36.8485,174.7622); MLAT=110950; MLON=111320*np.cos(np.radians(O[0]))
t=Transformer.from_crs(4326,2193,always_xy=True)
xs,zs=np.meshgrid(np.linspace(-46000,46000,50),np.linspace(-46000,46000,50))
E,N=t.transform(O[1]+xs/MLON, O[0]-zs/MLAT)
x0,x1,y0,y1=E.min(),E.max(),N.min(),N.max()
x0,y0=np.floor(x0/res)*res,np.floor(y0/res)*res
W=int(np.ceil((x1-x0)/res)); H=int(np.ceil((y1-y0)/res))
mos=np.full((H,W),np.nan,np.float32)
for it in json.load(open(name)):
  url='/vsicurl/https://nz-elevation.s3.ap-southeast-2.amazonaws.com/'+prefix+'/'+it['tif'][0][2:]
  with rasterio.open(url) as s:
    b=s.bounds; ix0,iy1=max(b.left,x0),min(b.top,y0+H*res); ix1,iy0=min(b.right,x0+W*res),max(b.bottom,y0)
    if ix0>=ix1 or iy0>=iy1: continue
    c0=int(round((ix0-x0)/res)); c1=int(round((ix1-x0)/res)); r0=int(round((y0+H*res-iy1)/res)); r1=int(round((y0+H*res-iy0)/res))
    win=from_bounds(ix0,iy0,ix1,iy1,s.transform)
    a=s.read(1,window=win,out_shape=(r1-r0,c1-c0),resampling=Resampling.average,masked=True).astype(np.float32).filled(np.nan)
    sub=mos[r0:r1,c0:c1]; m=~np.isnan(a); sub[m]=a[m]
    print(it['tif'][0],a.shape,np.nanmin(a) if m.any() else None,np.nanmax(a) if m.any() else None,flush=True)
np.savez_compressed(sys.argv[4],h=mos,x0=x0,y1=y0+H*res,res=res)
print('saved',mos.shape,np.isnan(mos).mean())
