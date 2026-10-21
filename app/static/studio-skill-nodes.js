/* Visual metadata for Skill nodes saved by the retired assistant; links stay out of generation inputs. */
(() => {
  'use strict';
  const $ = (selector, root=document) => root.querySelector(selector);
  const uid = value => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!document.querySelector('link[data-studio-skill-nodes]')) {
    const css=document.createElement('link');css.rel='stylesheet';css.href='/static/studio-skill-nodes.css?v=0.1';
    css.dataset.studioSkillNodes='1';document.head.append(css);
  }

  // The built-in assistant is retired. Saved Skill nodes stay readable and editable;
  // new work continues through an external agent over MCP.

  function decorate() {
    if (typeof nodes === 'undefined') return;
    const metadata = new Map(nodes.filter(node => node.studioAgentNodeKind)
      .map(node => [node.id, node]));
    for (const element of document.querySelectorAll('#nodes .node[data-id]')) {
      const node = metadata.get(element.dataset.id);
      if (!node) continue;
      element.classList.toggle('studio-agent-script-source', node.studioAgentNodeKind === 'script-source');
      element.classList.toggle('studio-agent-skill-run', node.studioAgentNodeKind === 'skill-run');
      const title = $('.node-title', element);
      if (title && node.studioTitle && title.textContent !== node.studioTitle) title.textContent = node.studioTitle;
      if (node.studioAgentNodeKind === 'skill-run' && !$('.studio-skill-node-meta', element)) {
        const body = $('.node-body', element);
        if (body) {
          const card = document.createElement('div');
          card.className = 'studio-skill-node-meta';
          const inputIds = node.studioSkillNode?.input_node_ids || [];
          const outputIds = node.studioSkillNode?.output_node_ids || [];
          const summary=document.createElement('div');summary.className='studio-skill-node-summary';
          summary.textContent = `技能：${node.studioSkillNode?.name || '已选技能'} · 输入 ${inputIds.length} 项 · 输出 ${outputIds.length} 项`;
          const status=document.createElement('small');status.className='studio-skill-node-status';
          status.textContent=node.studioSkillNode?.statusLabel || '方案已写入';
          const note=document.createElement('small');note.className='studio-skill-node-legacy';
          note.textContent='旧版内置助手生成。可直接编辑；如需继续，请在已连接的外接智能体中说明此节点。';
          card.append(summary,status,note);
          body.prepend(card);
        }
      }
    }
    drawWorkflowLinks(metadata);
  }

  function drawWorkflowLinks(metadata) {
    const host = document.getElementById('world');
    if (!host) return;
    let svg = $('#studioSkillWorkflowLinks', host);
    const nodeIds = new Set(nodes.map(node => node.id));
    const links = [];
    for (const node of metadata.values()) {
      const targets = node.studioAgentNodeKind === 'script-source'
        ? node.studioAgentSkillNodeIds || []
        : node.studioAgentNodeKind === 'skill-run'
          ? node.studioSkillNode?.output_node_ids || [] : [];
      for (const targetId of targets) {
        if (nodeIds.has(node.id) && nodeIds.has(targetId)) links.push([node.id, targetId]);
      }
    }
    // Ordinary canvases have no skill links. Avoid measuring the entire world
    // (and forcing layout) just to maintain an empty decorative SVG.
    if (!links.length) {
      svg?.remove();
      return;
    }
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.id = 'studioSkillWorkflowLinks';
      svg.setAttribute('aria-hidden','true');
      host.insertBefore(svg,document.getElementById('nodes'));
    }
    svg.setAttribute('width', String(Math.max(host.scrollWidth, 6000)));
    svg.setAttribute('height', String(Math.max(host.scrollHeight, 4000)));
    svg.replaceChildren();
    for (const [fromId,toId] of links) {
      const a=portPoint(fromId,'out'), b=portPoint(toId,'in');
      if(!a||!b) continue;
      const x1=a.x,y1=a.y,x2=b.x,y2=b.y;
      const path=document.createElementNS('http://www.w3.org/2000/svg','path');
      const curve=Math.max(48,Math.abs(x2-x1)*.42);
      path.setAttribute('d',`M ${x1} ${y1} C ${x1+curve} ${y1}, ${x2-curve} ${y2}, ${x2} ${y2}`);
      path.setAttribute('class','studio-skill-workflow-link');svg.append(path);
    }
  }

  window.studioSkillNodesRefresh = decorate;
  window.studioSkillNodeStatus = (sessionId,status,label) => {
    if(typeof nodes==='undefined') return;
    let changed=false;
    for(const node of nodes) if(node.studioAgentSession===String(sessionId)&&node.studioAgentNodeKind==='skill-run') {
      if(node.studioSkillNode?.status===status&&node.studioSkillNode?.statusLabel===label) continue;
      node.studioSkillNode={...(node.studioSkillNode||{}),status,statusLabel:label};changed=true;
    }
    if(changed){render();scheduleSave();}
  };
  const observer = new MutationObserver(records => {
    if(records.every(record=>record.target.closest?.('#studioSkillWorkflowLinks'))) return;
    requestAnimationFrame(decorate);
  });
  observer.observe(document.getElementById('nodes') || document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['style']});
  window.addEventListener('resize',decorate);
  document.addEventListener('scroll',decorate,true);
  setTimeout(decorate,0);
})();
