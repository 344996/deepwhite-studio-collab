(() => {
    'use strict';

    const STORAGE_KEY = 'studio_canvas_grid_layout_v1';
    const GAP = 32;
    const GROUP_TYPES = new Set(['group', 'promptGroup']);
    const isGroup = node => GROUP_TYPES.has(node?.type);

    const readSettings = () => {
        try {
            const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            return {
                snapEnabled: value.snapEnabled !== false,
                snapStep: clampStep(value.snapStep)
            };
        } catch (_) {
            return {snapEnabled:true, snapStep:20};
        }
    };
    const clampStep = value => {
        const number = Number(value);
        return Number.isFinite(number) ? Math.min(200, Math.max(1, Math.round(number))) : 20;
    };
    let settings = readSettings();
    let dragStart = null;
    let dragUndoPushed = false;

    function persistSettings() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) {}
    }

    function validNodes() {
        return typeof nodes !== 'undefined' && Array.isArray(nodes) ? nodes : [];
    }

    function atomicIds(ids) {
        if (typeof canvasArrangeAtomicIds === 'function') return canvasArrangeAtomicIds(ids);
        const out = new Set((ids || []).filter(id => validNodes().some(node => node.id === id)));
        let changed = true;
        while (changed) {
            changed = false;
            validNodes().filter(isGroup).forEach(group => {
                if ((group.items || []).some(id => out.has(id))) {
                    (group.items || []).forEach(id => out.delete(id));
                    out.add(group.id);
                    changed = true;
                }
            });
        }
        return [...out];
    }

    function nodeRectFor(node) {
        if (typeof nodeRect === 'function') return nodeRect(node);
        const element = document.querySelector(`.node[data-id="${CSS.escape(String(node.id))}"]`);
        return {
            x:Number(node.x) || 0,
            y:Number(node.y) || 0,
            w:element?.offsetWidth || Number(node.w) || 260,
            h:element?.offsetHeight || Number(node.h) || 200
        };
    }

    function collectEntity(node) {
        const members = new Map();
        const visit = current => {
            if (!current || members.has(current.id)) return;
            members.set(current.id, current);
            if (isGroup(current)) (current.items || []).forEach(id => visit(validNodes().find(item => item.id === id)));
        };
        visit(node);
        const rects = [...members.values()].map(nodeRectFor);
        const left = Math.min(...rects.map(rect => rect.x));
        const top = Math.min(...rects.map(rect => rect.y));
        const right = Math.max(...rects.map(rect => rect.x + rect.w));
        const bottom = Math.max(...rects.map(rect => rect.y + rect.h));
        return {node, members:[...members.values()], left, top, width:right-left, height:bottom-top};
    }

    function selectedAtomicEntities() {
        const ids = typeof selected !== 'undefined' && selected instanceof Set ? [...selected] : [];
        return atomicIds(ids).map(id => validNodes().find(node => node.id === id)).filter(Boolean).map(collectEntity);
    }

    function allAtomicEntities() {
        return atomicIds(validNodes().map(node => node.id))
            .map(id => validNodes().find(node => node.id === id)).filter(Boolean).map(collectEntity);
    }

    function atomicEntityCount(ids) {
        const live = new Set(validNodes().map(node => node.id));
        return atomicIds(ids).filter(id => live.has(id)).length;
    }

    function hasIntersection(a, b) {
        return a.left < b.left + b.width && a.left + a.width > b.left &&
            a.top < b.top + b.height && a.top + a.height > b.top;
    }

    function gridPositions(entities, originX, originY) {
        const columns = Math.max(1, Math.ceil(Math.sqrt(entities.length)));
        const columnWidths = Array(columns).fill(0);
        const rowHeights = Array(Math.ceil(entities.length / columns)).fill(0);
        entities.forEach((entity, index) => {
            const col = index % columns;
            const row = Math.floor(index / columns);
            columnWidths[col] = Math.max(columnWidths[col], entity.width);
            rowHeights[row] = Math.max(rowHeights[row], entity.height);
        });
        const xOffsets = [];
        const yOffsets = [];
        let acc = 0;
        columnWidths.forEach((width, index) => { xOffsets[index] = acc; acc += width + GAP; });
        acc = 0;
        rowHeights.forEach((height, index) => { yOffsets[index] = acc; acc += height + GAP; });
        return entities.map((entity, index) => ({
            entity,
            left:originX + xOffsets[index % columns],
            top:originY + yOffsets[Math.floor(index / columns)]
        }));
    }

    function arrange(entities, selectedOnly) {
        if (typeof canvas === 'undefined' || !canvas || entities.length < 2) return false;
        const uniqueIds = new Set(entities.flatMap(entity => entity.members.map(member => member.id)));
        const obstacles = selectedOnly
            ? allAtomicEntities().filter(entity => !entity.members.some(member => uniqueIds.has(member.id)))
            : [];
        const originX = Math.min(...entities.map(entity => entity.left));
        let originY = Math.min(...entities.map(entity => entity.top));
        let positions = gridPositions(entities, originX, originY);

        // Keep the selected grid intact and move it below untouched nodes if the target area is occupied.
        for (let attempt = 0; attempt < 100; attempt++) {
            const collisions = positions.flatMap(position => obstacles
                .filter(obstacle => hasIntersection(
                    {left:position.left, top:position.top, width:position.entity.width, height:position.entity.height},
                    obstacle
                )));
            if (!collisions.length) break;
            originY = Math.max(...collisions.map(obstacle => obstacle.top + obstacle.height)) + GAP;
            positions = gridPositions(entities, originX, originY);
        }

        const changes = positions.map(({entity, left, top}) => ({entity, dx:left-entity.left, dy:top-entity.top}))
            .filter(change => change.dx || change.dy);
        if (!changes.length) return false;
        if (typeof pushUndo === 'function') pushUndo();
        changes.forEach(({entity, dx, dy}) => {
            if (typeof translateCanvasNodeWithMembers === 'function') translateCanvasNodeWithMembers(entity.node, dx, dy);
            else entity.members.forEach(member => { member.x = Math.round((Number(member.x)||0)+dx); member.y = Math.round((Number(member.y)||0)+dy); });
        });
        if (typeof render === 'function') render();
        if (typeof scheduleSave === 'function') scheduleSave();
        return true;
    }

    function arrangeSelected() {
        const entities = selectedAtomicEntities();
        return arrange(entities, true);
    }

    function arrangeAll() {
        return arrange(allAtomicEntities(), false);
    }

    function dragSnapshot(event) {
        const nodeElement = event.target?.closest?.('.node[data-id]');
        if (event.button !== 0 || !nodeElement || event.target?.closest?.('.resize-handle,.port,button,input,textarea,select,[contenteditable="true"]')) {
            dragStart = null;
            dragUndoPushed = false;
            return;
        }
        dragStart = {
            duplicated:event.altKey,
            clientX:event.clientX,
            clientY:event.clientY
        };
        dragUndoPushed = false;
    }

    function beforeDragMove(event) {
        if (!dragStart || dragUndoPushed || typeof dragNode === 'undefined' || !dragNode) return;
        if (event.clientX === dragStart.clientX && event.clientY === dragStart.clientY) return;
        if (!dragStart.duplicated && typeof pushUndo === 'function') pushUndo();
        dragUndoPushed = true;
    }

    function snapAfterDrag(event) {
        if (!dragStart) return;
        const didMove = dragUndoPushed;
        dragStart = null;
        dragUndoPushed = false;
        if (!didMove || !settings.snapEnabled || typeof dragNode === 'undefined' || !dragNode) return;
        const anchor = dragNode.node;
        if (!anchor || (anchor.x === dragNode.ox && anchor.y === dragNode.oy)) return;
        const step = settings.snapStep;
        const dx = Math.round(anchor.x / step) * step - anchor.x;
        const dy = Math.round(anchor.y / step) * step - anchor.y;
        if (!dx && !dy) return;
        const moved = [...new Map([anchor, ...(dragNode.children || []).map(child => child.node)].map(node => [node.id,node])).values()];
        moved.forEach(node => { node.x = Math.round(node.x + dx); node.y = Math.round(node.y + dy); });
        moved.forEach(node => {
            const element = document.querySelector(`.node[data-id="${CSS.escape(String(node.id))}"]`);
            if (element) { element.style.left = `${node.x}px`; element.style.top = `${node.y}px`; }
        });
        if (typeof renderLinks === 'function') renderLinks();
        if (typeof renderSelectionHub === 'function') renderSelectionHub();
        if (typeof scheduleMinimapRender === 'function') scheduleMinimapRender();
    }

    function createToolbar() {
        const minimap = document.getElementById('minimap');
        const host = minimap?.parentElement;
        if (!host || document.getElementById('studioGridLayoutTools')) return;
        const toolbar = document.createElement('div');
        toolbar.id = 'studioGridLayoutTools';
        toolbar.className = 'studio-grid-layout-tools';
        toolbar.innerHTML = `
            <button id="studioGridArrangeSelected" type="button" disabled>网格整理选中</button>
            <button id="studioGridArrangeAll" type="button" disabled>网格整理全部</button>
            <button id="studioGridSettingsToggle" type="button" aria-expanded="false" aria-controls="studioGridSettingsPopover">画布设置</button>
            <div id="studioGridSettingsPopover" class="studio-grid-settings-popover" hidden>
                <label class="studio-grid-snap-row"><input id="studioGridSnapEnabled" type="checkbox"><span>拖动吸附</span></label>
                <label class="studio-grid-step-row" for="studioGridSnapStep"><span>吸附步长</span><input id="studioGridSnapStep" type="number" min="1" max="200" step="1"></label>
                <div id="studioCanvasSettingsContainer" class="studio-canvas-settings-extra"></div>
            </div>`;
        host.appendChild(toolbar);
        const selectedButton = toolbar.querySelector('#studioGridArrangeSelected');
        const allButton = toolbar.querySelector('#studioGridArrangeAll');
        const settingsButton = toolbar.querySelector('#studioGridSettingsToggle');
        const popover = toolbar.querySelector('#studioGridSettingsPopover');
        const snapToggle = toolbar.querySelector('#studioGridSnapEnabled');
        const stepInput = toolbar.querySelector('#studioGridSnapStep');
        const sharedContainer = toolbar.querySelector('#studioCanvasSettingsContainer');
        snapToggle.checked = settings.snapEnabled;
        stepInput.value = String(settings.snapStep);

        toolbar.addEventListener('mousedown', event => event.stopPropagation());
        selectedButton.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); arrangeSelected(); });
        allButton.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); arrangeAll(); });
        settingsButton.addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation();
            const open = popover.hidden;
            popover.hidden = !open;
            settingsButton.setAttribute('aria-expanded', String(open));
        });
        snapToggle.addEventListener('change', () => { settings.snapEnabled = snapToggle.checked; persistSettings(); });
        stepInput.addEventListener('change', () => {
            settings.snapStep = clampStep(stepInput.value);
            stepInput.value = String(settings.snapStep);
            persistSettings();
        });
        document.addEventListener('mousedown', event => {
            if (!toolbar.contains(event.target)) {
                popover.hidden = true;
                settingsButton.setAttribute('aria-expanded', 'false');
            }
        });
        window.addEventListener('keydown', event => {
            if (event.key === 'Escape') { popover.hidden = true; settingsButton.setAttribute('aria-expanded', 'false'); }
        });
        window.StudioCanvasSettings = {...(window.StudioCanvasSettings || {}), container:sharedContainer};
        window.dispatchEvent(new Event('studio-canvas-settings-ready'));

        const updateButtons = () => {
            // Button availability needs IDs only. Actual arrangement still reads
            // entity bounds; pan/zoom/drag must not measure every card for a count.
            const selectedCount = atomicEntityCount(typeof selected !== 'undefined' && selected instanceof Set ? [...selected] : []);
            selectedButton.disabled = selectedCount < 2;
            allButton.disabled = atomicEntityCount(validNodes().map(node => node.id)) < 2;
        };
        document.addEventListener('mouseup', updateButtons, true);
        document.addEventListener('click', event => {
            if (event.target?.closest?.('.node')) requestAnimationFrame(updateButtons);
        }, true);
        window.StudioGridLayout = {
            arrangeSelected,
            arrangeAll,
            getSettings:() => ({...settings}),
            setSettings:value => {
                if (typeof value?.snapEnabled === 'boolean') settings.snapEnabled = value.snapEnabled;
                if (value?.snapStep != null) settings.snapStep = clampStep(value.snapStep);
                persistSettings();
                snapToggle.checked = settings.snapEnabled;
                stepInput.value = String(settings.snapStep);
            },
            refresh:updateButtons
        };
        updateButtons();
    }

    function initialize() {
        createToolbar();
        for (const name of ['render', 'renderSelectionHub']) {
            const original = window[name];
            if (typeof original === 'function') window[name] = function(...args) {
                const result = original.apply(this,args);
                window.StudioGridLayout?.refresh();
                return result;
            };
        }
        const nodesContainer = document.getElementById('nodes');
        nodesContainer?.addEventListener('mousedown', dragSnapshot, true);
        window.addEventListener('mousemove', beforeDragMove, true);
        window.addEventListener('mouseup', event => {
            snapAfterDrag(event);
            setTimeout(() => window.StudioGridLayout?.refresh(), 0);
        }, true);
        window.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') setTimeout(() => window.StudioGridLayout?.refresh(), 0);
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, {once:true});
    else initialize();
})();
