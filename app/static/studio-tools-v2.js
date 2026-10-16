/* Only close the existing classic log on Escape. Higher tools retain their own
   Escape semantics, so a nested viewer/input cannot dismiss multiple layers. */
(() => {
  if(window.StudioToolsV2)return;
  document.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||event.isComposing)return;
    const log=document.getElementById('logModal');if(!log?.classList.contains('open'))return;
    if(document.querySelector('dialog[open],#imageEditModal.open,#outputLightbox.open,#promptTemplateModal.open,#errorModal.open,#workflowTransferModal.open,#smartWorkflowTransferModal.open,#smartShortcutModal.open,[popover]:popover-open'))return;
    const assistant=document.getElementById('studioAgentPanel');if(assistant&&!assistant.hidden)return;
    event.preventDefault();event.stopImmediatePropagation();window.closeCanvasLog?.();
  },true);
  window.StudioToolsV2=Object.freeze({ready:true});
})();
