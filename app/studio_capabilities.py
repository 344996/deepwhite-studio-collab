"""Conservative parameter contracts from references/model-selection/deepwhite-docs.txt."""
import re
from fastapi import HTTPException

RATIOS=['1:1','16:9','9:16','4:3','3:4','3:2','2:3','21:9']


def option(label,values,default=None):
    return {'label':label,'values':values,'default':values[0] if default is None else default}


def profile(mid,kind):
    m=mid.lower()
    p={'kind':kind,'fields':{},'max_images':0,'max_videos':0,'max_audios':0,'prompt_max':20000,'prompt_min':1,
       'supported':True,'note':'参数范围依据本站接口文档；最终费用以实际账单为准。'}
    f=p['fields']
    if kind=='chat':
        if 'context-ir' in m:
            p.update(supported=False,note='此型号是专用视频提示词工具，将在后续工具阶段接入。')
        p['max_images']=8
        if re.search(r'glm-5\.[23](?!-)|deepseek-v4(?!.*vision)',m): p['max_images']=0
        if 'v4.1-flash' in m: p['max_images']=8
        p['prompt_max']=100000
        return p
    if kind=='audio':
        # This deliberately narrow list mirrors the documented DeepWhite adapters.
        # Text fields are validated by parameters() and rendered as inputs by the
        # dedicated audio node; option fields remain finite selects.
        speech={
            'qwen3-tts-flash': {'voice': {'label':'音色 ID','type':'text','max_length':100}},
            'qwen3-tts-instruct-flash': {
                'voice': {'label':'音色 ID','type':'text','max_length':100},
                'instructions': {'label':'语气与表达要求','type':'text','max_length':1000},
            },
            'minimax-speech-2.8-turbo': {'voice_id': {'label':'音色 ID','type':'text','max_length':100}},
            'minimax-speech-2.8-hd': {'voice_id': {'label':'音色 ID','type':'text','max_length':100}},
        }
        if m in speech:
            p.update(channel='speech',prompt_min=1,prompt_max=5000,max_audios=0)
            f.update(speech[m])
        elif m in ('mureka-v8-bgm','mureka-v9-bgm'):
            p.update(channel='music',prompt_min=0,prompt_max=2048)
            f.update(n=option('生成数量',[1,2,3],2),instrumental_id={'label':'伴奏模板 ID','type':'text','max_length':120})
        elif m in ('suno','suno-music'):
            p.update(channel='music',prompt_min=1,prompt_max=5000)
            f.update(version=option('Suno 版本',['v3.5','v4','v4.5','v4.5+','v4.5-all','v5','v5.5'],'v5'),
                     custom=option('使用自定义歌词',[False,True],False),instrumental=option('纯音乐',[True,False],True),
                     title={'label':'曲名','type':'text','max_length':120},style={'label':'曲风','type':'text','max_length':500},
                     vocal_gender={'label':'人声偏好','type':'text','max_length':40})
        elif m=='suno-sounds':
            p.update(channel='sound',prompt_min=1,prompt_max=2000)
        else:
            p.update(supported=False,note='此音频型号的专用接口或参数尚未核对，暂不能提交。')
        return p
    if kind=='image':
        p['max_images']=10
        f['ratio']=option('比例',RATIOS)
        if 'image-g2' in m:
            f['resolution']=option('分辨率',['1k'])
            f['ratio']=option('比例',['adaptive','16:9','4:3','1:1','3:4','9:16','21:9'],'1:1')
            # The 2026-10-20 user-provided G2 response confirms the upstream
            # 5–2000 character constraint for both t2i/i2i variants.
            p.update(prompt_min=5, prompt_max=2000)
        elif 'seedream' in m:
            f.clear();f['resolution']=option('分辨率',['1k','2k']);f['output_format']=option('输出格式',['jpeg','png'])
            p.update(prompt_min=5,prompt_max=2000)
        elif 'qwen-image' in m:
            f['resolution']=option('分辨率',['1k','2k']);p.update(max_images=3,prompt_max=3000)
        elif 'image-nb-' in m:
            values=['0.5k','1k','2k','4k'] if 'nb-2' in m and 'lite' not in m else ['1k','2k','4k'] if 'pro' in m else ['1k']
            f['resolution']=option('分辨率',values,'1k');p.update(max_images=14,prompt_max=1000 if 'flash' in m else 20000)
        elif 'image-g-v2.5-' in m:
            f['resolution']=option('分辨率',['1k','2k','4k']);p['max_images']=15 if 'lowprice' in m else 16
            if 'lowprice' not in m:
                f['quality']=option('质量',['auto','low','medium','high','xhigh','max'])
                f['output_format']=option('输出格式',['png','jpeg','webp'])
                f['background']=option('背景',['auto','transparent','opaque'])
            else:
                # Live API rejection supplied by the user on 2026-09-17 overrides
                # llms.txt's stale "1–5000" lower bound.
                p.update(prompt_min=5,prompt_max=5000,note='此模型提示词需 5–5000 个字符；最终费用以实际账单为准。')
        elif 'image-g-v2-lowprice' in m:
            f['resolution']=option('分辨率',['1k','2k','4k']);p['max_images']=16
        elif 'image-gk' in m:
            p['max_images']=0
            f['ratio']=option('比例',['1:1','16:9','9:16','3:2','2:3'])
        elif m.startswith('wan-2.7'):
            f.clear();p.update(max_images=9,prompt_max=2048 if 'i2i' in m else 5000)
        elif m=='midjourney-imagine':
            p.update(supported=False,note='MJ 使用专用文生图面板。')
        else:
            p.update(supported=False,note='此模型的专用参数与接口尚未核对，暂不能在基础生图节点提交。')
        return p
    if kind!='video':
        p.update(supported=False,note='此类工具属于后续阶段。');return p
    p['max_images']=2
    f['ratio']=option('比例',['16:9','9:16','1:1','4:3','3:4'])
    if m.startswith('seedance'):
        newer='2.5' in m
        resolutions=['480p','720p','1080p','2k','4k']
        if 'standard' in m: resolutions+=['native1080p']+([] if newer else ['native4k'])
        f['resolution']=option('分辨率',resolutions,'720p')
        f['duration']=option('时长（秒）',list(range(4,31 if newer else 16)),5)
        f['generate_audio']=option('生成声音',[True,False],True)
        f['ratio']=option('比例',['adaptive',*f['ratio']['values'],'21:9'],'16:9')
        p.update(max_images=30 if newer else 9,max_videos=10 if newer else 3,max_audios=10 if newer else 3)
    elif m.startswith('wan-3.0'):
        f['resolution']=option('分辨率',['480P','720P','1080P'],'720P');f['duration']=option('时长（秒）',list(range(2,31)),5)
        f['generate_audio']=option('生成声音',[True,False]);p.update(max_images=10,max_videos=5,max_audios=5)
    elif m.startswith('wan-2.7-spicy'):
        f['resolution']=option('分辨率',['720p','1080p']);f['duration']=option('时长（秒）',list(range(2,16)),5);p['max_images']=1
    elif m.startswith('hailuo-h3'):
        values=['480p','768p'] if 'turbo' in m else ['480P','768P'] if 'max' in m else ['768P','2K']
        f['resolution']=option('分辨率',values);f['duration']=option('时长（秒）',list(range(5,16)))
        p.update(max_images=9 if 'max' not in m else 2,max_videos=3 if 'max' not in m else 0,max_audios=3 if 'max' not in m else 0)
    elif m.startswith('minimax-h3-ow'):
        p.update(supported=False,note='此系列使用专用内容与角色参数，后续通过专用工具接入。')
    elif m.startswith('flux-3-video') and 'draft-enhance' not in m:
        f['resolution']=option('分辨率',['hd','fhd']);f['duration']=option('时长（秒）',list(range(5,21)));f['generate_audio']=option('生成声音',[True,False]);p.update(max_images=10,max_videos=1)
    elif m.startswith('deepwhiteai-video-v31'):
        f['resolution']=option('分辨率',['720p','1080p','4k']);f['duration']=option('时长（秒）',[8]);f['ratio']=option('比例',['16:9','9:16'])
        p['max_images']=0 if 'lite' in m else 3 if 'fast' in m else 2
    elif m=='deepwhiteai-video-gk-v15':
        f['resolution']=option('分辨率',['480p','720p']);f['duration']=option('时长（秒）',list(range(6,31)));p['max_images']=7
        f['ratio']=option('比例',['16:9','9:16','1:1','3:2','2:3'])
    elif m.startswith('deepwhiteai-video-g-omni'):
        f['resolution']=option('分辨率',['720p','1080p','4k'] if 'lowprice' in m else ['720p'])
        f['ratio']=option('比例',['16:9','9:16']);p.update(max_images=3 if 'lowprice' in m else 16,max_videos=1)
        if 'lowprice' in m:f['duration']=option('时长（秒）',[4,6,8,10],6)
    elif m.startswith(('kling','vidu','hailuo-2.3')) and not re.search(r'(motion|lip-sync|elements|edit|short-play)',m):
        # Do not invent resolution/duration ranges where the summary contract gives no exhaustive enum.
        f.clear();p['max_images']=10 if 'r2v' in m else 2
        p.update(supported=False,note='此系列的专用参数将在后续逐项核对后开放；当前可先使用 Seedance 或 Hailuo H3。')
    else:
        p.update(supported=False,note='此型号是专用视频工具或参数契约尚未核对，将在后续工具阶段接入。')
    return p


def parameters(mid,kind,values):
    spec=profile(mid,kind)
    if not spec['supported']:raise HTTPException(400,spec['note'])
    result={}
    for key,field in spec['fields'].items():
        value=values.get(key,field.get('default',''))
        if field.get('type')=='text':
            value=str(value or '').strip()
            if len(value)>field['max_length']:raise HTTPException(400,f'{field["label"]}不能超过 {field["max_length"]} 个字符。')
            if value:result[key]=value
            continue
        if value not in field['values']:raise HTTPException(400,f'{field["label"]}不支持当前值，请重新选择。')
        result[key]=value
    if kind=='audio':result['channel']=spec['channel']
    if result.get('background')=='transparent' and result.get('output_format')=='jpeg':
        raise HTTPException(400,'透明背景请选择 PNG 或 WebP 格式。')
    return result
