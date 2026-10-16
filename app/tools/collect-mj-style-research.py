"""Collect a bounded, public research batch; never runs image generation."""
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urljoin
import concurrent.futures
import hashlib
import html
import json
import re
import requests
from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / 'references' / 'deepwhite-style-research' / 'batch-001'
SOURCES = [
    ('style-reference', c, f'https://style-reference.com/sref/{c}')
    for c in ['495247150','1736491683','469710847','1648693186','3563478172','2749571961']
] + [
    ('kajimelo', c, f'https://www.kajimelo.com/midjourney-sref-library/sref{c}')
    for c in ['2345517735','2301579864','1376370611','3852948173','1612682886','3114264950']
]

# Editorial labels based on visual review of the downloaded examples, not model testing.
REVIEW = {
 '495247150':('温暖三维动画','动画角色','圆润角色、柔和暖光；可研究动画人物与搭配场景。'),
 '1736491683':('暖光动漫人像','动漫人物','本批样例主要为女性人像；尚不能推断男性或场景效果。'),
 '469710847':('冷暗电影影像','写实电影','人脸细节和城市夜景样例；关注低照度、颗粒与对比。'),
 '1648693186':('低饱和未来废土','科幻场景','车辆环境与人物样例；灰绿低饱和、空旷空间。'),
 '3563478172':('复古高对比海报','风格探索','人像与文字海报差异明显；更适合方向探索，暂不作为正式人设推荐。'),
 '2749571961':('暗黑末世氛围','悬疑场景','样例包含拼图与手机展示，不作为干净资产参考直接使用。'),
 '2345517735':('霓虹纪实电影感','写实电影','夜景车辆、人物和环境拼图；可研究都市悬疑氛围。'),
 '2301579864':('冷暗末世写实','悬疑场景','熊角色及暗调环境样例；不等于已验证真人角色。'),
 '1376370611':('明亮奇幻三维','动画角色','动物角色与奇幻环境；可研究动画短片的统一氛围。'),
 '3852948173':('清爽赛璐璐动画','动漫人物','动物角色及环境拼图；真人身份保持尚无本地验证。'),
 '1612682886':('柔和油画田园','风格探索','绘画笔触和田园色调；可研究场景美术方向。'),
 '3114264950':('柔光极简空间','场景美术','几何化空间、低饱和柔光；细节较少，适合概念探索。'),
}

class Page(HTMLParser):
    def __init__(self):
        super().__init__(); self.images=[]; self.meta={}; self.text=[]; self.skip=0
    def handle_starttag(self,tag,attrs):
        d=dict(attrs)
        if tag in ('script','style'): self.skip+=1
        if tag=='img': self.images.append(d)
        if tag=='meta': self.meta[d.get('property',d.get('name',''))]=d.get('content','')
    def handle_endtag(self,tag):
        if tag in ('script','style'): self.skip=max(0,self.skip-1)
    def handle_data(self,text):
        if not self.skip and text.strip(): self.text.append(text.strip())

def collect(source):
    site,code,url=source
    r=requests.get(url,timeout=30);r.raise_for_status();r.encoding='utf-8'
    p=Page();p.feed(r.text);text=' '.join(p.text)
    if not re.search(r'(?:--|–)sref\s+'+re.escape(code)+r'\b',text):
        raise ValueError(f'Public code not found: {url}')
    # Only assets from this entry, not related recommendations or paywalled content.
    candidates=[]
    for img in p.images:
        src=urljoin(url,img.get('src') or '')
        if site=='style-reference' and src.startswith('https://img.sref-midjourney.com/'):
            candidates.append(src)
        elif site=='kajimelo' and f'/srefs/sref{code}/' in src:
            candidates.append(src)
    candidates=list(dict.fromkeys(candidates))
    # Prefer two different prompts on Style Reference, where generated groups have -0..-3 suffixes.
    selected=[];groups=set()
    for src in candidates:
        group=re.sub(r'-[0-3]\.webp$', '',src) if site=='style-reference' else src
        if group in groups:continue
        groups.add(group);selected.append(src)
        if len(selected)==2:break
    if not selected:raise ValueError(f'No public sample image: {url}')
    folder=ROOT/'images'/f'{site}-{code}';folder.mkdir(parents=True,exist_ok=True)
    images=[]
    for index,src in enumerate(selected,1):
        response=requests.get(src,timeout=40);response.raise_for_status()
        if len(response.content)>20_000_000:raise ValueError('Image exceeds research download limit')
        filename=folder/f'{index:02d}.webp';filename.write_bytes(response.content)
        with Image.open(filename) as im:im.verify()
        with Image.open(filename) as im:width,height=im.size
        images.append({'local_path':filename.relative_to(ROOT).as_posix(),'source_url':src,'width':width,'height':height,'sha256':hashlib.sha256(response.content).hexdigest()})
    # These are observations across a page, not a tested or recombined parameter recipe.
    observations={}
    for flag in ['v','version','sv','sw','ar','stylize','chaos','quality','seed']:
        values=sorted(set(re.findall(r'(?<!\w)(?:--|–)'+flag+r'\s+([0-9]+(?:[.:][0-9]+)?)\b',text)))
        if values:observations[flag]=values
    title=p.meta.get('og:title','SREF '+code)
    return {'id':'DW-SREF-'+code,'source_site':site,'source_url':url,'source_title':title,
        'code':code,'copy_command':'--sref '+code,'page_parameter_observations':observations,
        'version_status':'source_page_observation_only' if observations.get('v') else 'not_stated',
        'parameters_note':'页面出现的参数，不表示两张样例共用，也未拼接成推荐配置。未出现的参数未补默认值。',
        'images':images,'retrieved_on':'2026-09-20','verification':'collected_not_generated',
        'image_reuse_status':'commercial_redistribution_not_confirmed','production_enabled':False,
        'classification_status':'pending_visual_review'}

def gallery(items):
    cards=[]
    for item in items:
        images=''.join(f'<a href="{html.escape(i["local_path"])}" target="_blank"><img src="{html.escape(i["local_path"])}" loading="lazy" alt="{item["id"]} 的来源样例"></a>'for i in item['images'])
        observations=html.escape(json.dumps(item['page_parameter_observations'],ensure_ascii=False))
        name,category,note=REVIEW.get(item['code'],(item['source_title'],'待分类','待视觉复核'))
        cards.append(f'''<article data-search="{html.escape(name+' '+category+' '+item['source_title']+' '+item['code']+' '+item['source_site'],quote=True)}"><div class="photos">{images}</div><div class="content"><small>{item['id']} · {item['source_site']}</small><h2>{html.escape(name)} · {html.escape(category)}</h2><p>{html.escape(note)}（人工整理判断）</p><input aria-label="可复制的风格代码" readonly value="{item['copy_command']}"><p>页面参数：{observations if observations!='{}' else '未明确提供'}</p><p class="note">仅收集，未在本站生成验证。参数是页面记录，不是推荐组合。</p><a href="{html.escape(item['source_url'])}" target="_blank" rel="noreferrer">查看原始案例与提示词 ↗</a></div></article>''')
    return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DeepWhite · MJ 风格研究库 001</title><style>*{box-sizing:border-box}body{margin:0;background:#15191b;color:#e7ece7;font:14px/1.6 system-ui,'Microsoft Yahei'}header{padding:40px 5vw 24px;border-bottom:1px solid #35413a}h1{font-size:29px;margin:4px 0}header p{color:#adbbb1;max-width:920px}header small{letter-spacing:2px;color:#bfd9c5}.search{display:flex;gap:12px;flex-wrap:wrap;margin:22px 0 0}input,select{background:#26302a;border:1px solid #526457;border-radius:8px;padding:10px;color:#e7ece7}#search{width:min(480px,100%)}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:22px;padding:30px 5vw}article{border:1px solid #3b4940;border-radius:12px;overflow:hidden;background:#202724}.photos{display:grid;grid-template-columns:1fr 1fr;background:#0e1310}.photos img{width:100%;height:260px;object-fit:contain;display:block}.content{padding:18px}h2{font-size:15px;min-height:44px}small,.note{color:#aab8ad}.note{font-size:11px}a{color:#bee1c7}.content input{width:100%;font-family:monospace}.content p{overflow-wrap:anywhere;font-size:12px}footer{padding:20px 5vw;color:#aab8ad}article[hidden]{display:none}@media(max-width:420px){main{grid-template-columns:1fr}.photos img{height:200px}}</style><header><small>DEEPWHITE / STYLE RESEARCH / BATCH 001</small><h1>MJ 风格案例研究库</h1><p>首批公开案例与图片，用于建立自己的精选库。自己的编号以 DW-SREF 开头；下方 MJ 代码来自原站，不是我们原创。尚未确认图片的商业再分发权限，不自动加入产品。</p><p>缺少参数或版本就保留空缺。点击图片查看本地大图，点击来源查看完整提示词与上下文。未发起任何付费生成。</p><div class="search"><input id="search" placeholder="搜索代码、英文风格词或来源"><select id="source"><option value="">全部来源</option><option>style-reference</option><option>kajimelo</option></select><span id="count"></span></div></header><main>'''+''.join(cards)+'''</main><footer>收集日期：2026-09-20 · 数据：<a href="catalog.json">JSON</a> · 图片均保留来源及校验值。</footer><script>const cards=[...document.querySelectorAll('article')],search=document.querySelector('#search'),source=document.querySelector('#source');function filter(){let n=0;for(const c of cards){c.hidden=!(c.dataset.search.toLowerCase().includes(search.value.toLowerCase())&&c.dataset.search.includes(source.value));if(!c.hidden)n++}document.querySelector('#count').textContent=n+' 个风格'}search.oninput=source.onchange=filter;filter();</script></html>'''

if __name__=='__main__':
    ROOT.mkdir(parents=True,exist_ok=True);items=[];failures=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        pending={pool.submit(collect,s):s for s in SOURCES}
        for future in concurrent.futures.as_completed(pending):
            try:items.append(future.result())
            except Exception as e:failures.append({'source':pending[future][2],'error':str(e)})
    items.sort(key=lambda x:(x['source_site'],x['code']))
    (ROOT/'catalog.json').write_text(json.dumps({'items':items,'failures':failures},ensure_ascii=False,indent=2),encoding='utf-8')
    (ROOT/'index.html').write_text(gallery(items),encoding='utf-8')
    print(json.dumps({'styles':len(items),'images':sum(len(x['images'])for x in items),'failures':failures,'folder':str(ROOT)},ensure_ascii=False))
