import json,sys,urllib.request,concurrent.futures as cf
base=sys.argv[1]; bb=(174.25,-37.26,175.27,-36.44)
col=json.load(urllib.request.urlopen(base+'/collection.json'))
items=[l['href'] for l in col['links'] if l['rel']=='item']
def get(h):
    d=json.load(urllib.request.urlopen(base+'/'+h[2:]))
    b=d['bbox']
    if b[0]<bb[2] and b[2]>bb[0] and b[1]<bb[3] and b[3]>bb[1]:
        a=[v['href'] for v in d['assets'].values() if v['href'].endswith('.tiff')]
        return h,b,a
with cf.ThreadPoolExecutor(32) as ex:
    res=[r for r in ex.map(get,items) if r]
print(len(items),'items;',len(res),'intersect')
json.dump([{'item':h,'bbox':b,'tif':a} for h,b,a in res],open(sys.argv[2],'w'))
