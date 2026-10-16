"""Import the user-authorized Fisher style/MJ/filter snapshot, with blob verification."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REVISION = 'bdcf3bec054594fcab591952a8c5acef858d6de4'
SOURCE = ROOT / 'references/fisher-0927'
DEST = ROOT / 'static/fisher-library'
BASE = f'https://raw.githubusercontent.com/Work-Fisher/AIFISHER/{REVISION}/'

def git_hash(data):
    return hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()

def run():
    tree = json.loads((SOURCE / 'tree.json').read_text(encoding='utf-8'))
    expected = {item['path']: item for item in tree['tree'] if item['type'] == 'blob'}
    creative = json.loads((SOURCE / 'src/stable/prompt/creativeCatalog.json').read_text(encoding='utf-8'))
    creative = [entry for entry in creative if entry['kind'] in ('style', 'filter')]
    mj = json.loads((SOURCE / 'src/stable/prompt/mjStyleCatalog.json').read_text(encoding='utf-8'))
    paths = sorted({entry[key].lstrip('/') for entry in creative + mj for key in ('preview','poster','thumbnail') if entry.get(key)})
    def obtain(relative):
        source_path = 'public/' + relative
        item = expected[source_path]
        target = DEST / relative
        if target.exists() and git_hash(target.read_bytes()) == item['sha']:
            data = target.read_bytes()
        else:
            for attempt in range(4):
                try:
                    data = urllib.request.urlopen(BASE + source_path, timeout=45).read()
                    if git_hash(data) != item['sha']: raise ValueError('Source blob mismatch: ' + relative)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    break
                except Exception:
                    if attempt == 3: raise
                    time.sleep(attempt + 1)
        return {'path':relative,'source':source_path,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'git_blob':item['sha']}
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        assets = list(pool.map(obtain, paths))
    entries = []
    for entry in creative + [{**item,'kind':'mj'} for item in mj]:
        entry = dict(entry)
        for key in ('preview','poster','thumbnail'):
            if entry.get(key): entry[key] = '/static/fisher-library/' + entry[key].lstrip('/')
        entries.append(entry)
    DEST.mkdir(parents=True,exist_ok=True)
    (DEST / 'catalog.json').write_text(json.dumps({'source':'https://github.com/Work-Fisher/AIFISHER','revision':REVISION,'entries':entries},ensure_ascii=False,indent=2),encoding='utf-8')
    (SOURCE / 'manifest.json').write_text(json.dumps({'revision':REVISION,'counts':{kind:sum(e['kind']==kind for e in entries) for kind in ('style','filter','mj')},'assets':assets},ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'entries':len(entries),'assets':len(assets),'bytes':sum(a['bytes'] for a in assets)}),flush=True)

if __name__ == '__main__': run()
