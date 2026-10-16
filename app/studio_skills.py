"""Local, inert skill documents. Never execute imported scripts."""
import json
import re
import uuid
from pathlib import Path, PurePosixPath
from fastapi import HTTPException
from pydantic import BaseModel, Field
import main as core

class ImportSkill(BaseModel):
    name: str = Field(min_length=1,max_length=80)
    files: dict[str,str]

def root():
    p=Path(core.DATA_DIR)/'studio_skills';p.mkdir(parents=True,exist_ok=True);return p

def read(sid):
    if not re.fullmatch(r'[a-f0-9]{32}',sid): raise HTTPException(400,'技能编号无效。')
    p=root()/(sid+'.json')
    if not p.exists(): raise HTTPException(404,'技能已删除，请重新选择。')
    return json.loads(p.read_text(encoding='utf-8'))

def validate(files):
    if len(files)>100 or sum(len(v.encode('utf-8')) for v in files.values())>512000:
        raise HTTPException(400,'技能包最多 100 个文本文件、合计 500 KB。')
    for name in files:
        p=PurePosixPath(name)
        if p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name or p.suffix.lower() not in ('.md','.txt','.json'):
            raise HTTPException(400,'仅支持技能文本、说明和 JSON 配置文件。')
    if not files.get('SKILL.md','').strip(): raise HTTPException(400,'请选择含 SKILL.md 的技能文件夹。')
    refs=[]
    if 'agent-skill.json' in files:
        try: refs=json.loads(files['agent-skill.json']).get('instructionReferences',[])
        except (ValueError,AttributeError): raise HTTPException(400,'agent-skill.json 格式错误。')
    if not isinstance(refs,list) or any(not isinstance(r,str) or not r.startswith('references/') or r not in files for r in refs):
        raise HTTPException(400,'技能引用文件不存在，或不在 references 目录。')
    text='\n\n'.join([files['SKILL.md']]+[files[r] for r in refs])
    if len(text)>40000: raise HTTPException(400,'技能指令和自动引用合计不能超过 40000 字符。')
    return text

def instructions(ids):
    if len(ids)>3: raise HTTPException(400,'一次最多使用 3 个技能。')
    text='\n\n'.join('【技能：'+s['name']+'】\n'+validate(s['files']) for s in [read(sid) for sid in dict.fromkeys(ids)])
    if len(text)>40000: raise HTTPException(400,'所选技能指令过长，请减少技能。')
    return text

def install(app):
    @app.get('/api/studio/skills')
    async def listing():
        return {'items':[{'id':s['id'],'name':s['name'],'file_count':len(s['files'])} for s in [json.loads(p.read_text(encoding='utf-8')) for p in sorted(root().glob('*.json'))]]}
    @app.post('/api/studio/skills')
    async def importing(payload:ImportSkill):
        validate(payload.files)
        s={'id':uuid.uuid4().hex,**payload.model_dump()}
        (root()/(s['id']+'.json')).write_text(json.dumps(s,ensure_ascii=False),encoding='utf-8')
        return {'id':s['id'],'name':s['name']}
    @app.get('/api/studio/skills/{sid}')
    async def detail(sid:str): return read(sid)
    @app.delete('/api/studio/skills/{sid}')
    async def delete(sid:str):
        read(sid);(root()/(sid+'.json')).unlink();return {'ok':True}
