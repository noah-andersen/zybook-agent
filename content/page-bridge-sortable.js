  // ══════════════════════════════════════════════════════════
  //  SORTABLE / DRAG-AND-DROP HELPERS (for Parsons problems)
  // ══════════════════════════════════════════════════════════

  /* ── Shared helper: deep Ember component/model finder ──
   * Walks the DOM and Ember's internal structures to find the component
   * that manages the Parsons block arrays.
   *
   * Returns: {
   *   unusedItems: <Ember array for unused blocks>,
   *   usedItems: <Ember array for used blocks>,
   *   allRefs: [...]  // diagnostic logging
   * }
   */
  function findEmberSortableModel(containerEl) {
    if (!containerEl) return null;
    const result = { unusedItems: null, usedItems: null, allRefs: [] };

    function getEmberRefs(el) {
      const refs = [];
      if (!el) return refs;
      try {
        for (const key of Object.keys(el)) {
          if (key.startsWith('__ember') || key.startsWith('__EMBER')) {
            try {
              const ref = el[key];
              if (ref && typeof ref === 'object') refs.push({ key, ref, el });
            } catch (e) { /* skip */ }
          }
        }
      } catch (e) { /* skip */ }
      return refs;
    }

    function findBlockArrays(obj, path, depth, visited) {
      if (!obj || depth > 8 || typeof obj !== 'object') return [];
      if (visited.has(obj)) return [];
      visited.add(obj);
      const found = [];
      let keys;
      try { keys = Object.keys(obj); } catch (e) { return []; }

      for (const key of keys) {
        if (/^(parentElement|parentNode|ownerDocument|childNodes|children|firstChild|lastChild|nextSibling|previousSibling|nodeValue|__ember|__EMBER)/.test(key)) continue;
        try {
          const val = obj[key];
          if (!val) continue;
          const isArr = Array.isArray(val);
          const isEmberArr = !isArr && val.length !== undefined && typeof val.objectAt === 'function';
          if (isArr || isEmberArr) {
            const len = isEmberArr && typeof val.get === 'function' ? val.get('length') : val.length;
            if (len > 0) {
              const first = isEmberArr ? val.objectAt(0) : val[0];
              if (first && typeof first === 'object') {
                const fk = Object.keys(first);
                // Broadened detection: accept arrays with items that have text/code/indent-like properties
                // or have more than 2 keys (likely data objects, not DOM/utility objects)
                const hasBlockProps = fk.some(k => /^(blockId|block_id|id|text|code|content|indent|indentation|codeText|blockText|blockIndent)$/i.test(k));
                const hasEnoughProps = fk.length >= 2 && fk.length <= 30 && !fk.includes('tagName') && !fk.includes('nodeName');
                if (hasBlockProps || (hasEnoughProps && len <= 20)) {
                  found.push({ path: path + '.' + key, array: val, length: len, sampleKeys: fk.slice(0, 20), isEmberArray: typeof val.pushObject === 'function' });
                }
              }
            }
          }
          if (typeof val === 'object' && !isArr && !isEmberArr && !(val instanceof Element) && !(val instanceof NodeList) && depth < 6) {
            found.push(...findBlockArrays(val, path + '.' + key, depth + 1, visited));
          }
        } catch (e) { /* skip */ }
      }
      return found;
    }

    // Collect elements to inspect
    const elements = [];
    const twoLists = containerEl.querySelector('.two-reorderable-lists') || containerEl;
    elements.push(twoLists);
    for (const sl of containerEl.querySelectorAll('.sortable')) elements.push(sl);
    // Also include all children of .two-reorderable-lists that might be components
    for (const child of twoLists.querySelectorAll('*')) {
      if (child.id || child.className) elements.push(child);
    }
    let p = twoLists.parentElement;
    for (let i = 0; i < 8 && p; i++) { elements.push(p); p = p.parentElement; }
    const cr = containerEl.closest('[content_resource_id]');
    if (cr) { elements.push(cr); for (const c of cr.children) elements.push(c); }

    // Also try to find the component via Ember's view registry
    try {
      if (window.Ember) {
        // Try Ember.ViewUtils.getViewBounds or Ember.getOwner
        const viewRegistry = window.Ember.__container__?.lookup('-view-registry:main') ||
                            window.Ember.ViewUtils;
        if (viewRegistry) {
          console.log('[ZyAgent Bridge] Found Ember view registry');
        }
        // Try to get component from a .sortable element's Ember view
        for (const sortableEl of containerEl.querySelectorAll('.sortable, .two-reorderable-lists')) {
          for (const key of Object.keys(sortableEl).filter(k => k.startsWith('__ember'))) {
            const ref = sortableEl[key];
            if (ref && ref.component) {
              const comp = ref.component;
              // Look for block list properties on the component
              for (const ck of Object.keys(comp)) {
                try {
                  const val = comp[ck];
                  if (Array.isArray(val) || (val && typeof val === 'object' && typeof val.objectAt === 'function')) {
                    const len = typeof val.get === 'function' ? val.get('length') : val.length;
                    if (len > 0) {
                      const first = typeof val.objectAt === 'function' ? val.objectAt(0) : val[0];
                      if (first && typeof first === 'object') {
                        console.log('[ZyAgent Bridge] Component prop', ck, 'has array len=', len, 'firstKeys=', Object.keys(first).slice(0, 10));
                      }
                    }
                  }
                } catch (e) { /* skip */ }
              }
            }
          }
        }
      }
    } catch (e) { console.log('[ZyAgent Bridge] Ember view registry search error:', e.message); }

    const allArrays = [];
    const visited = new WeakSet();

    for (const el of elements) {
      for (const { key, ref } of getEmberRefs(el)) {
        result.allRefs.push({
          tag: el.tagName, cls: (el.className || '').substring(0, 40), key,
          keys: Object.keys(ref).filter(k => !k.startsWith('_')).slice(0, 12)
        });
        allArrays.push(...findBlockArrays(ref, key, 0, visited));
        if (ref.args) allArrays.push(...findBlockArrays(ref.args, key + '.args', 0, visited));
        if (ref.component) allArrays.push(...findBlockArrays(ref.component, key + '.component', 0, visited));
      }
    }

    // Classify as unused/used by matching to DOM
    const domTexts = (listEl) => listEl ? Array.from(listEl.querySelectorAll('.block')).map(b => b.textContent.trim()) : [];
    const unusedDomTexts = domTexts(containerEl.querySelector('.sortable[data-list-name="unused"]'));
    const usedDomTexts = domTexts(containerEl.querySelector('.sortable[data-list-name="used"]'));

    console.log('[ZyAgent Bridge] Ember introspection: found', allArrays.length, 'candidate arrays');
    for (const a of allArrays) {
      const items = [];
      const len = a.isEmberArray && typeof a.array.get === 'function' ? a.array.get('length') : a.array.length;
      for (let i = 0; i < len; i++) {
        const item = a.isEmberArray ? a.array.objectAt(i) : a.array[i];
        if (item) {
          // Try many possible text property names
          let t = '';
          if (typeof item === 'string') { t = item; }
          else if (typeof item.get === 'function') {
            t = item.get('text') || item.get('code') || item.get('content') || item.get('codeText') || item.get('blockText') || item.get('label') || '';
          } else {
            t = item.text || item.code || item.content || item.codeText || item.blockText || item.label || '';
          }
          items.push(t);
        }
      }
      console.log('[ZyAgent Bridge]   Array', a.path, '| len=', len, '| ember=', a.isEmberArray, '| sampleKeys=', a.sampleKeys, '| texts=', items.map(t => t.substring(0, 25)).join(', '));

      const score = (arrT, domT) => {
        if (!arrT.length || !domT.length) return 0;
        let m = 0;
        for (const t of arrT) if (domT.some(d => d === t || d.includes(t) || t.includes(d))) m++;
        return m / Math.max(arrT.length, domT.length);
      };
      const uScore = score(items, unusedDomTexts);
      const sScore = score(items, usedDomTexts);

      if (uScore > 0.5 && uScore > sScore && (!result.unusedItems || a.isEmberArray)) {
        result.unusedItems = a.array;
        console.log('[ZyAgent Bridge]   -> UNUSED (score:', uScore.toFixed(2), ')');
      }
      if (sScore > 0.5 && sScore > uScore && (!result.usedItems || a.isEmberArray)) {
        result.usedItems = a.array;
        console.log('[ZyAgent Bridge]   -> USED (score:', sScore.toFixed(2), ')');
      }
      const pl = a.path.toLowerCase();
      if (!result.unusedItems && (pl.includes('unused') || pl.includes('available'))) result.unusedItems = a.array;
      if (!result.usedItems && pl.includes('used') && !pl.includes('unused')) result.usedItems = a.array;
    }

    if (result.unusedItems || result.usedItems) {
      console.log('[ZyAgent Bridge] Ember model found! unused=', !!result.unusedItems, 'used=', !!result.usedItems);
    } else {
      console.log('[ZyAgent Bridge] Could not find Ember model arrays');
      console.log('[ZyAgent Bridge] Refs:', JSON.stringify(result.allRefs, null, 2));
    }
    return result;
  }

  // ── SORTABLE MOVE: Move a block between sortable lists ──
  // Strategy: 1) Ember model manipulation, 2) Mouse drag, 3) DOM fallback
  document.addEventListener('zyagent-sortable-move', function (e) {
    const { requestId, sourceListSelector, targetListSelector, sourceBlockId, sourceBlockText, targetInsertIndex, indentLevel = 0 } = e.detail;
    let success = false;
    let method = 'none';

    try {
      const sourceList = document.querySelector(sourceListSelector);
      const targetList = document.querySelector(targetListSelector);
      if (!sourceList || !targetList) throw new Error('Cannot find source/target lists');

      // Find source block — prefer text match (data-block-id can be duplicated!)
      let sourceBlock = null;
      if (sourceBlockText) {
        for (const b of sourceList.querySelectorAll('.block.moveable:not([aria-disabled="true"])')) {
          if (b.textContent.trim() === sourceBlockText) { sourceBlock = b; break; }
        }
      }
      if (!sourceBlock) sourceBlock = sourceList.querySelector('.block[data-block-id="' + sourceBlockId + '"]:not([aria-disabled="true"])');
      if (!sourceBlock) sourceBlock = sourceList.querySelector('.block[data-block-id="' + sourceBlockId + '"]');
      if (!sourceBlock) throw new Error('Cannot find source block id=' + sourceBlockId + ' text=' + (sourceBlockText || 'N/A'));

      const isBlockInTarget = () => {
        if (sourceBlockText) {
          for (const b of targetList.querySelectorAll('.block.moveable')) {
            if (b.textContent.trim() === sourceBlockText) return true;
          }
        }
        return targetList.querySelectorAll('.block[data-block-id="' + sourceBlockId + '"]:not([aria-disabled="true"])').length > 0;
      };

      // ── Method 1: Ember model manipulation ──
      const tryEmberModel = async () => {
        try {
          const container = sourceList.closest('[content_resource_id]') || sourceList.closest('.two-reorderable-lists') || sourceList.parentElement;
          const model = findEmberSortableModel(container);
          if (!model || !model.unusedItems || !model.usedItems) {
            console.log('[ZyAgent Bridge] Ember model not found — skipping');
            return false;
          }
          const unusedArr = model.unusedItems;
          const usedArr = model.usedItems;
          const unusedLen = typeof unusedArr.get === 'function' ? unusedArr.get('length') : unusedArr.length;
          let itemToMove = null, itemIndex = -1;

          for (let i = 0; i < unusedLen; i++) {
            const item = typeof unusedArr.objectAt === 'function' ? unusedArr.objectAt(i) : unusedArr[i];
            if (!item) continue;
            const gt = (o) => typeof o.get === 'function' ? (o.get('text') || o.get('code') || o.get('content') || '') : (o.text || o.code || o.content || '');
            const gi = (o) => String(typeof o.get === 'function' ? (o.get('blockId') || o.get('block_id') || o.get('id') || '') : (o.blockId || o.block_id || o.id || ''));
            if ((sourceBlockText && gt(item) === sourceBlockText) || (!sourceBlockText && gi(item) === String(sourceBlockId))) {
              itemToMove = item; itemIndex = i; break;
            }
          }
          if (!itemToMove) { console.log('[ZyAgent Bridge] Item not in Ember unused array'); return false; }

          console.log('[ZyAgent Bridge] Found Ember item at index', itemIndex);

          // Remove from unused
          if (typeof unusedArr.removeObject === 'function') unusedArr.removeObject(itemToMove);
          else if (typeof unusedArr.removeAt === 'function') unusedArr.removeAt(itemIndex);
          else unusedArr.splice(itemIndex, 1);

          // Set indent before inserting into used list
          if (indentLevel > 0) {
            try {
              const setVal = (prop, val) => {
                try {
                  if (typeof itemToMove.set === 'function') itemToMove.set(prop, val);
                  else if (prop in itemToMove) itemToMove[prop] = val;
                } catch (e) { /* ignore */ }
              };
              setVal('indent', indentLevel);
              setVal('indentation', indentLevel);
              setVal('indentLevel', indentLevel);
              console.log('[ZyAgent Bridge] Set indent =', indentLevel, 'on item before insertion, keys:', Object.keys(itemToMove).filter(k => !k.startsWith('_')).slice(0, 15));
            } catch (e) { /* ignore */ }
          }

          // Insert into used
          const usedLen = typeof usedArr.get === 'function' ? usedArr.get('length') : usedArr.length;
          const insertIdx = Math.min(targetInsertIndex, usedLen);
          if (typeof usedArr.insertAt === 'function') usedArr.insertAt(insertIdx, itemToMove);
          else if (typeof usedArr.pushObject === 'function' && insertIdx >= usedLen) usedArr.pushObject(itemToMove);
          else if (typeof usedArr.splice === 'function') usedArr.splice(insertIdx, 0, itemToMove);
          else usedArr.push(itemToMove);

          // Trigger Ember change
          if (window.Ember && window.Ember.run) {
            window.Ember.run(() => {
              try {
                if (typeof unusedArr.arrayContentDidChange === 'function') unusedArr.arrayContentDidChange(0, unusedLen, typeof unusedArr.get === 'function' ? unusedArr.get('length') : unusedArr.length);
                if (typeof usedArr.arrayContentDidChange === 'function') usedArr.arrayContentDidChange(0, usedLen, typeof usedArr.get === 'function' ? usedArr.get('length') : usedArr.length);
              } catch (e) { /* ignore */ }
            });
          }
          await new Promise(r => setTimeout(r, 500));
          return true;
        } catch (err) {
          console.log('[ZyAgent Bridge] Ember model error:', err.message);
          return false;
        }
      };

      // ── Method 2: Mouse drag simulation ──
      const doMouseDrag = (grabDelay, steps) => new Promise(resolve => {
        sourceBlock.scrollIntoView({ behavior: 'instant', block: 'center' });
        setTimeout(() => {
          const sr = sourceBlock.getBoundingClientRect();
          const sx = sr.x + sr.width / 2, sy = sr.y + sr.height / 2;
          const targetBlocks = targetList.querySelectorAll('.block');
          let ty;
          if (targetInsertIndex <= 0 || targetBlocks.length === 0) ty = targetList.getBoundingClientRect().y + 10;
          else if (targetInsertIndex >= targetBlocks.length) { const lb = targetBlocks[targetBlocks.length - 1].getBoundingClientRect(); ty = lb.y + lb.height + 10; }
          else { const ab = targetBlocks[targetInsertIndex - 1].getBoundingClientRect(); const nb = targetBlocks[targetInsertIndex].getBoundingClientRect(); ty = (ab.bottom + nb.top) / 2; }
          const tr = targetList.getBoundingClientRect();
          const INDENT_PX = 31;
          const tx = indentLevel > 0 ? tr.x + 10 + ((indentLevel + 0.5) * INDENT_PX) : tr.x + tr.width / 3;

          sourceBlock.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0, view: window }));
          setTimeout(() => {
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx + 1, clientY: sy + 2, button: 0, view: window }));
            setTimeout(() => {
              document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx + 2, clientY: sy + 5, button: 0, view: window }));
              setTimeout(() => {
                let step = 0;
                const iv = setInterval(() => {
                  step++;
                  const r = step / steps;
                  const eased = r < 0.5 ? 2 * r * r : 1 - Math.pow(-2 * r + 2, 2) / 2;
                  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx + (tx - sx) * eased, clientY: sy + (ty - sy) * eased, button: 0, view: window }));
                  if (step >= steps) {
                    clearInterval(iv);
                    setTimeout(() => {
                      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: tx, clientY: ty, button: 0, view: window }));
                      setTimeout(() => {
                        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: tx, clientY: ty, button: 0, view: window }));
                        resolve();
                      }, 150);
                    }, 250);
                  }
                }, 20);
              }, 80);
            }, 80);
          }, grabDelay);
        }, 100);
      });

      // ── Try all methods ──
      const tryAllMethods = async () => {
        const emberOk = await tryEmberModel();
        if (emberOk) {
          await new Promise(r => setTimeout(r, 300));
          if (isBlockInTarget()) return 'ember-model';
          console.log('[ZyAgent Bridge] Ember model done but DOM not synced');
        }

        // Mouse drag 300ms
        sourceBlock.scrollIntoView({ behavior: 'instant', block: 'center' });
        await new Promise(r => setTimeout(r, 100));
        await doMouseDrag(300, 16);
        await new Promise(r => setTimeout(r, 500));
        if (isBlockInTarget()) return emberOk ? 'ember+mouse-300' : 'mouse-drag-300ms';

        // Mouse drag 500ms
        sourceBlock.scrollIntoView({ behavior: 'instant', block: 'center' });
        await new Promise(r => setTimeout(r, 200));
        await doMouseDrag(500, 20);
        await new Promise(r => setTimeout(r, 500));
        if (isBlockInTarget()) return 'mouse-drag-500ms';

        // Pointer + mouse events
        sourceBlock.scrollIntoView({ behavior: 'instant', block: 'center' });
        await new Promise(r => setTimeout(r, 200));
        {
          const r2 = sourceBlock.getBoundingClientRect();
          const sx2 = r2.x + r2.width / 2, sy2 = r2.y + r2.height / 2;
          const t2 = targetList.getBoundingClientRect();
          const tx2 = t2.x + t2.width / 3, ty2 = t2.y + t2.height / 2;
          sourceBlock.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: sx2, clientY: sy2, button: 0, pointerId: 1, pointerType: 'mouse', view: window }));
          sourceBlock.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: sx2, clientY: sy2, button: 0, view: window }));
          await new Promise(r => setTimeout(r, 400));
          for (let i = 1; i <= 20; i++) {
            const ratio = i / 20;
            const cx = sx2 + (tx2 - sx2) * ratio, cy = sy2 + (ty2 - sy2) * ratio;
            document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, pointerId: 1, pointerType: 'mouse', view: window }));
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, view: window }));
            await new Promise(r => setTimeout(r, 20));
          }
          await new Promise(r => setTimeout(r, 300));
          document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: tx2, clientY: ty2, button: 0, pointerId: 1, pointerType: 'mouse', view: window }));
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: tx2, clientY: ty2, button: 0, view: window }));
        }
        await new Promise(r => setTimeout(r, 500));
        if (isBlockInTarget()) return 'pointer-events';

        // DOM manipulation (last resort)
        console.log('[ZyAgent Bridge] All drag strategies failed — DOM manipulation');
        try {
          const tb = targetList.querySelectorAll('.block');
          if (targetInsertIndex <= 0 || tb.length === 0) targetList.insertBefore(sourceBlock, targetList.firstChild);
          else if (targetInsertIndex >= tb.length) targetList.appendChild(sourceBlock);
          else targetList.insertBefore(sourceBlock, tb[targetInsertIndex]);
          targetList.dispatchEvent(new Event('change', { bubbles: true }));
          sourceList.dispatchEvent(new Event('change', { bubbles: true }));
          if (window.Ember && window.Ember.run) { try { window.Ember.run.scheduleOnce('afterRender', () => {}); } catch (e) { /* ignore */ } }
          await new Promise(r => setTimeout(r, 300));
          if (isBlockInTarget()) return 'dom-manipulation';
        } catch (de) { console.warn('[ZyAgent Bridge] DOM manipulation failed:', de.message); }

        return emberOk ? 'ember-model-only' : 'FAILED';
      };

      tryAllMethods().then(rm => {
        console.log('[ZyAgent Bridge] sortable-move result:', rm);
        document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: rm !== 'FAILED', method: rm } }));
      });
      return;

    } catch (err) {
      console.error('[ZyAgent Bridge] sortable-move error:', err);
    }
    document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success, method, error: 'sync-path-failure' } }));
  });

  // ── SORTABLE ADJUST INDENT ──
  document.addEventListener('zyagent-sortable-adjust-indent', function (e) {
    const { requestId, containerSelector, blockText, blockId, desiredIndent } = e.detail;
    const INDENT_PX = 31;

    try {
      const container = document.querySelector(containerSelector) || document;
      const usedList = container.querySelector('.sortable[data-list-name="used"]');
      if (!usedList) throw new Error('Cannot find used list');

      let block = null;
      if (blockText) {
        for (const b of usedList.querySelectorAll('.block.moveable')) {
          if (b.textContent.trim() === blockText) { block = b; break; }
        }
      }
      if (!block && blockId) block = usedList.querySelector('.block[data-block-id="' + blockId + '"]:not([aria-disabled="true"])');
      if (!block) throw new Error('Cannot find block');

      const currentMargin = parseInt(block.style.marginLeft) || 0;
      const desiredMargin = desiredIndent * INDENT_PX;

      if (Math.abs(currentMargin - desiredMargin) < 5) {
        document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: true, method: 'already-correct' } }));
        return;
      }

      console.log('[ZyAgent Bridge] adjust-indent:', blockText?.substring(0, 30), 'from', Math.round(currentMargin / INDENT_PX), 'to', desiredIndent);

      // Strategy 1: Find the Ember/Glimmer component and update indent via its model
      // zyBooks' Parsons blocks are Ember objects. We need to find the actual data object
      // in the component's block array and update its indent property using Ember's set().
      const tryEmberIndent = async () => {
        try {
          const model = findEmberSortableModel(container);
          if (!model || !model.usedItems) return false;
          const usedArr = model.usedItems;
          const len = typeof usedArr.get === 'function' ? usedArr.get('length') : usedArr.length;
          for (let i = 0; i < len; i++) {
            const item = typeof usedArr.objectAt === 'function' ? usedArr.objectAt(i) : usedArr[i];
            if (!item) continue;
            const t = typeof item.get === 'function' ? (item.get('text') || item.get('code') || '') : (item.text || item.code || '');
            if (blockText && (t === blockText || t.trim() === blockText.trim())) {
              const itemKeys = Object.keys(item).filter(k => !k.startsWith('_'));
              console.log('[ZyAgent Bridge] Found Ember item for indent update, keys:', itemKeys.slice(0, 25));

              // Log current indent value for debugging
              const currentEmberIndent = typeof item.get === 'function' ? item.get('indent') : item.indent;
              console.log('[ZyAgent Bridge] Current Ember indent value:', currentEmberIndent, 'desired:', desiredIndent);

              // Use Ember.set for proper observer notification
              if (window.Ember && window.Ember.set) {
                try { window.Ember.set(item, 'indent', desiredIndent); } catch (e) { console.log('[ZyAgent Bridge] Ember.set indent failed:', e.message); }
                try { window.Ember.set(item, 'indentation', desiredIndent); } catch (e) { /* ignore */ }
              } else if (typeof item.set === 'function') {
                item.set('indent', desiredIndent);
                try { item.set('indentation', desiredIndent); } catch (e) { /* ignore */ }
              } else {
                // Plain object fallback
                for (const prop of itemKeys) {
                  if (/^indent(ation|Level)?$/.test(prop)) {
                    item[prop] = desiredIndent;
                  }
                }
              }

              // Also update the DOM marginLeft
              block.style.marginLeft = (desiredIndent * INDENT_PX) + 'px';

              // Trigger Ember change notifications
              if (window.Ember && window.Ember.run) {
                window.Ember.run(() => {
                  try { if (typeof usedArr.arrayContentDidChange === 'function') usedArr.arrayContentDidChange(i, 1, 1); } catch (e) { /* ignore */ }
                  try { if (typeof usedArr.notifyPropertyChange === 'function') usedArr.notifyPropertyChange('[]'); } catch (e) { /* ignore */ }
                  try { if (typeof usedArr.notifyPropertyChange === 'function') usedArr.notifyPropertyChange('length'); } catch (e) { /* ignore */ }
                  try { if (typeof item.notifyPropertyChange === 'function') item.notifyPropertyChange('indent'); } catch (e) { /* ignore */ }
                });
              }
              await new Promise(r => setTimeout(r, 300));
              // Verify
              const newVal = typeof item.get === 'function' ? item.get('indent') : item.indent;
              console.log('[ZyAgent Bridge] After set, Ember indent value:', newVal);
              return true;
            }
          }
        } catch (e) { console.log('[ZyAgent Bridge] Ember indent error:', e.message); }
        return false;
      };

      // Strategy 2: Find the Ember component on the sortable list element and
      // invoke its "onChange" / "onDragEnd" action directly, simulating what
      // happens when a user finishes a drag at the correct X position.
      const tryEmberAction = async () => {
        try {
          // Find the Ember component attached to the .sortable used list or .two-reorderable-lists
          const targets = [usedList, usedList.parentElement, container,
            container.querySelector('.two-reorderable-lists')].filter(Boolean);
          for (const target of targets) {
            for (const key of Object.keys(target)) {
              if (!key.startsWith('__ember') && !key.startsWith('__EMBER')) continue;
              const ref = target[key];
              if (!ref || typeof ref !== 'object') continue;
              // Look for component with actions/handlers
              const comp = ref.component || ref;
              if (!comp) continue;
              // Find action handlers that might handle sort/reorder
              const actionNames = Object.keys(comp).filter(k =>
                /sort|drag|reorder|move|change|update|drop/i.test(k) && typeof comp[k] === 'function'
              );
              if (actionNames.length > 0) {
                console.log('[ZyAgent Bridge] Found component actions:', actionNames);
              }
              // Also check args for action references
              if (ref.args) {
                const argNames = Object.keys(ref.args).filter(k =>
                  /sort|drag|reorder|move|change|update|drop|indent/i.test(k)
                );
                if (argNames.length > 0) {
                  console.log('[ZyAgent Bridge] Found component args:', argNames, '=', argNames.map(k => typeof ref.args[k]));
                }
              }
            }
          }
        } catch (e) { console.log('[ZyAgent Bridge] Ember action search error:', e.message); }
        return false;
      };

      // Strategy 3: Horizontal drag — use BOTH HTML5 drag events and mouse events
      // zyBooks may use either ember-sortable (HTML5 drag) or mouse-based drag
      const doDragIndent = async () => {
        block.scrollIntoView({ behavior: 'instant', block: 'center' });
        await new Promise(r => setTimeout(r, 50));
        const br = block.getBoundingClientRect();
        const sx = br.x + br.width / 2, sy = br.y + br.height / 2;
        const lr = usedList.getBoundingClientRect();
        const tx = lr.x + 10 + ((desiredIndent + 0.5) * INDENT_PX);

        // Try HTML5 drag events first (ember-sortable uses these)
        try {
          const dt = new DataTransfer();
          block.setAttribute('draggable', 'true');
          block.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, dataTransfer: dt, view: window }));
          await new Promise(r => setTimeout(r, 200));
          for (let i = 1; i <= 8; i++) {
            const cx = sx + (tx - sx) * (i / 8);
            usedList.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: cx, clientY: sy, dataTransfer: dt, view: window }));
            await new Promise(r => setTimeout(r, 30));
          }
          await new Promise(r => setTimeout(r, 100));
          usedList.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: tx, clientY: sy, dataTransfer: dt, view: window }));
          block.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, clientX: tx, clientY: sy, dataTransfer: dt, view: window }));
          await new Promise(r => setTimeout(r, 300));
          const afterDrag = parseInt(block.style.marginLeft) || 0;
          if (Math.round(afterDrag / INDENT_PX) === desiredIndent) return true;
        } catch (e) { console.log('[ZyAgent Bridge] HTML5 drag indent error:', e.message); }

        // Fall back to pointer+mouse events
        block.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0, pointerId: 1, pointerType: 'mouse', view: window }));
        block.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0, view: window }));
        await new Promise(r => setTimeout(r, 300));
        document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: sx + 2, clientY: sy, button: 0, pointerId: 1, pointerType: 'mouse', view: window }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx + 2, clientY: sy, button: 0, view: window }));
        await new Promise(r => setTimeout(r, 80));
        for (let i = 1; i <= 10; i++) {
          const cx = sx + (tx - sx) * (i / 10);
          document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: cx, clientY: sy, button: 0, pointerId: 1, pointerType: 'mouse', view: window }));
          document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: cx, clientY: sy, button: 0, view: window }));
          await new Promise(r => setTimeout(r, 25));
        }
        await new Promise(r => setTimeout(r, 200));
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: tx, clientY: sy, button: 0, pointerId: 1, pointerType: 'mouse', view: window }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: tx, clientY: sy, button: 0, view: window }));
        await new Promise(r => setTimeout(r, 300));
        const newMargin = parseInt(block.style.marginLeft) || 0;
        return Math.round(newMargin / INDENT_PX) === desiredIndent;
      };

      // Run strategies
      (async () => {
        // Strategy 1: Try Ember model set
        const emberOk = await tryEmberIndent();
        if (emberOk) {
          block.style.marginLeft = desiredMargin + 'px';
          await new Promise(r => setTimeout(r, 300));
          document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: true, method: 'ember-indent' } }));
          return;
        }

        // Strategy 2: Try finding Ember component actions (diagnostic/exploratory)
        await tryEmberAction();

        // Strategy 3: Try horizontal drag (HTML5 + mouse + pointer)
        const dragOk = await doDragIndent();
        if (dragOk) {
          document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: true, method: 'horizontal-drag' } }));
          return;
        }

        // Strategy 4: Direct DOM set + Ember ref walk + data attribute
        block.style.marginLeft = desiredMargin + 'px';
        block.setAttribute('data-indent', String(desiredIndent));

        // Walk block element itself, parents, and children for __ember/__EMBER refs
        const elementsToCheck = [block];
        // Children of the block
        for (const child of block.querySelectorAll('*')) elementsToCheck.push(child);
        // Parents up to 8 levels
        let el2 = block.parentElement;
        for (let d = 0; d < 8 && el2; d++) { elementsToCheck.push(el2); el2 = el2.parentElement; }

        let foundEmberRef = false;
        for (const checkEl of elementsToCheck) {
          try {
            for (const key of Object.keys(checkEl).filter(k => k.startsWith('__ember') || k.startsWith('__EMBER'))) {
              const ref = checkEl[key];
              if (!ref || typeof ref !== 'object') continue;

              // Direct properties
              if (ref.indent !== undefined) { ref.indent = desiredIndent; foundEmberRef = true; }
              if (ref.indentation !== undefined) { ref.indentation = desiredIndent; foundEmberRef = true; }

              // args object
              if (ref.args && typeof ref.args === 'object') {
                for (const prop of Object.keys(ref.args)) {
                  if (/^indent(ation|Level)?$/.test(prop)) {
                    ref.args[prop] = desiredIndent;
                    foundEmberRef = true;
                  }
                }
              }

              // Try Ember.set on component
              if (ref.component && typeof ref.component.set === 'function') {
                try { ref.component.set('indent', desiredIndent); foundEmberRef = true; } catch (e) { /* ignore */ }
              }

              // Try the state/attrs pattern (Glimmer)
              if (ref.state && typeof ref.state === 'object') {
                if (ref.state.indent !== undefined) { ref.state.indent = desiredIndent; foundEmberRef = true; }
              }
            }
          } catch (e) { /* skip */ }
        }

        if (foundEmberRef) {
          console.log('[ZyAgent Bridge] Updated Ember refs via DOM walk');
          if (window.Ember && window.Ember.run) {
            try { window.Ember.run.scheduleOnce('afterRender', () => {}); } catch (e) { /* ignore */ }
          }
        }

        block.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 200));

        const finalM = parseInt(block.style.marginLeft) || 0;
        const ok = Math.round(finalM / INDENT_PX) === desiredIndent;
        document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: ok || foundEmberRef, method: foundEmberRef ? 'ember-ref-walk' : (ok ? 'direct-dom' : 'FAILED') } }));
      })();
      return;

    } catch (err) {
      console.error('[ZyAgent Bridge] adjust-indent error:', err);
      document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: false, error: err.message } }));
    }
  });

  // ── SORTABLE REORDER: Move a block to a different position within the used list ──
  document.addEventListener('zyagent-sortable-reorder', function (e) {
    const { requestId, containerSelector, blockText, blockId, targetIndex } = e.detail;

    try {
      const container = document.querySelector(containerSelector) || document;
      const usedList = container.querySelector('.sortable[data-list-name="used"]');
      if (!usedList) throw new Error('Cannot find used list');

      let block = null;
      if (blockText) {
        for (const b of usedList.querySelectorAll('.block.moveable')) {
          if (b.textContent.trim() === blockText) { block = b; break; }
        }
      }
      if (!block && blockId) block = usedList.querySelector('.block[data-block-id="' + blockId + '"]:not([aria-disabled="true"])');
      if (!block) throw new Error('Cannot find block to reorder');

      const allBlocks = Array.from(usedList.querySelectorAll('.block'));
      const currentIndex = allBlocks.indexOf(block);
      if (currentIndex === targetIndex) {
        document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: true, method: 'already-correct' } }));
        return;
      }

      console.log('[ZyAgent Bridge] reorder:', blockText?.substring(0, 30), 'from', currentIndex, 'to', targetIndex);

      // Strategy 1: Ember model reorder
      const tryEmberReorder = async () => {
        try {
          const model = findEmberSortableModel(container);
          if (!model || !model.usedItems) return false;
          const usedArr = model.usedItems;
          const len = typeof usedArr.get === 'function' ? usedArr.get('length') : usedArr.length;
          let itemToMove = null, itemIdx = -1;
          for (let i = 0; i < len; i++) {
            const item = typeof usedArr.objectAt === 'function' ? usedArr.objectAt(i) : usedArr[i];
            if (!item) continue;
            const t = typeof item.get === 'function' ? (item.get('text') || item.get('code') || '') : (item.text || item.code || '');
            if (blockText && t === blockText) { itemToMove = item; itemIdx = i; break; }
          }
          if (!itemToMove || itemIdx === targetIndex) return false;

          if (typeof usedArr.removeAt === 'function') usedArr.removeAt(itemIdx);
          else if (typeof usedArr.removeObject === 'function') usedArr.removeObject(itemToMove);
          else usedArr.splice(itemIdx, 1);

          const newIdx = Math.min(targetIndex, (typeof usedArr.get === 'function' ? usedArr.get('length') : usedArr.length));
          if (typeof usedArr.insertAt === 'function') usedArr.insertAt(newIdx, itemToMove);
          else if (typeof usedArr.splice === 'function') usedArr.splice(newIdx, 0, itemToMove);
          else usedArr.push(itemToMove);

          if (window.Ember && window.Ember.run) {
            window.Ember.run(() => {
              try { if (typeof usedArr.arrayContentDidChange === 'function') usedArr.arrayContentDidChange(0, len, typeof usedArr.get === 'function' ? usedArr.get('length') : usedArr.length); } catch (e) { /* ignore */ }
            });
          }
          await new Promise(r => setTimeout(r, 500));
          return true;
        } catch (err) { console.log('[ZyAgent Bridge] Ember reorder error:', err.message); return false; }
      };

      // Strategy 2: Mouse drag
      const doMouseReorder = async () => {
        block.scrollIntoView({ behavior: 'instant', block: 'center' });
        await new Promise(r => setTimeout(r, 100));
        const br = block.getBoundingClientRect();
        const sx = br.x + br.width / 2, sy = br.y + br.height / 2;
        let ty;
        if (targetIndex <= 0) ty = usedList.getBoundingClientRect().y + 3;
        else if (targetIndex >= allBlocks.length) ty = allBlocks[allBlocks.length - 1].getBoundingClientRect().bottom + 10;
        else {
          const tb = allBlocks[targetIndex].getBoundingClientRect();
          const mid = tb.y + tb.height / 2;
          ty = currentIndex < targetIndex ? mid + tb.height * 0.3 : mid - tb.height * 0.3;
        }
        return new Promise(resolve => {
          block.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0, view: window }));
          setTimeout(() => {
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx, clientY: sy + 3, button: 0, view: window }));
            setTimeout(() => {
              const steps = 16;
              let step = 0;
              const iv = setInterval(() => {
                step++;
                document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx, clientY: sy + (ty - sy) * (step / steps), button: 0, view: window }));
                if (step >= steps) {
                  clearInterval(iv);
                  setTimeout(() => {
                    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx, clientY: ty, button: 0, view: window }));
                    setTimeout(() => {
                      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: sx, clientY: ty, button: 0, view: window }));
                      setTimeout(() => {
                        const nb = Array.from(usedList.querySelectorAll('.block'));
                        resolve(nb.indexOf(block) === targetIndex);
                      }, 400);
                    }, 150);
                  }, 200);
                }
              }, 30);
            }, 120);
          }, 300);
        });
      };

      (async () => {
        const emberOk = await tryEmberReorder();
        if (emberOk) {
          const nb = Array.from(usedList.querySelectorAll('.block'));
          if (nb.indexOf(block) === targetIndex) {
            document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: true, method: 'ember-reorder' } }));
            return;
          }
        }
        const mouseOk = await doMouseReorder();
        const m = mouseOk ? (emberOk ? 'ember+mouse-reorder' : 'mouse-reorder') : (emberOk ? 'ember-reorder-only' : 'FAILED');
        document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: mouseOk || emberOk, method: m } }));
      })();
      return;

    } catch (err) {
      console.error('[ZyAgent Bridge] reorder error:', err);
      document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: false, error: err.message } }));
    }
  });

  // ── SORTABLE-REORDER-ALL: Bulk reorder ALL blocks in the used list ──
  document.addEventListener('zyagent-sortable-reorder-all', function (e) {
    const { requestId, containerSelector, desiredOrder } = e.detail;

    try {
      const container = document.querySelector(containerSelector) || document;
      const usedList = container.querySelector('.sortable[data-list-name="used"]');
      if (!usedList) throw new Error('Cannot find used list');

      const desiredTexts = desiredOrder.map(d => d.text);
      const currentTexts = Array.from(usedList.querySelectorAll('.block')).map(b => b.textContent.trim());
      if (JSON.stringify(currentTexts) === JSON.stringify(desiredTexts)) {
        document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: true, method: 'already-correct' } }));
        return;
      }

      console.log('[ZyAgent Bridge] reorder-all: current =', currentTexts.map(t => t.substring(0, 30)));
      console.log('[ZyAgent Bridge] reorder-all: desired =', desiredTexts.map(t => t.substring(0, 30)));

      // Strategy 1: Ember model bulk reorder
      const tryEmberBulkReorder = async () => {
        try {
          const model = findEmberSortableModel(container);
          if (!model || !model.usedItems) return false;
          const usedArr = model.usedItems;
          const len = typeof usedArr.get === 'function' ? usedArr.get('length') : usedArr.length;
          const itemMap = new Map();
          for (let i = 0; i < len; i++) {
            const item = typeof usedArr.objectAt === 'function' ? usedArr.objectAt(i) : usedArr[i];
            if (!item) continue;
            const t = typeof item.get === 'function' ? (item.get('text') || item.get('code') || '') : (item.text || item.code || '');
            if (!itemMap.has(t)) itemMap.set(t, item);
          }
          const newItems = [];
          for (const d of desiredOrder) {
            const item = itemMap.get(d.text);
            if (item) newItems.push(item);
          }
          if (newItems.length !== len) return false;

          if (typeof usedArr.clear === 'function') usedArr.clear();
          else if (typeof usedArr.removeAt === 'function') { for (let i = len - 1; i >= 0; i--) usedArr.removeAt(i); }
          else usedArr.splice(0, len);

          for (const item of newItems) {
            if (typeof usedArr.pushObject === 'function') usedArr.pushObject(item);
            else usedArr.push(item);
          }

          if (window.Ember && window.Ember.run) {
            window.Ember.run(() => {
              try { if (typeof usedArr.arrayContentDidChange === 'function') usedArr.arrayContentDidChange(0, len, newItems.length); } catch (e) { /* ignore */ }
            });
          }
          await new Promise(r => setTimeout(r, 500));
          return true;
        } catch (err) { console.log('[ZyAgent Bridge] Ember bulk reorder error:', err.message); return false; }
      };

      // Strategy 2: Sequential mouse-drag reorder
      const doSequentialReorder = async () => {
        const maxPasses = desiredOrder.length * 3;
        for (let pass = 0; pass < maxPasses; pass++) {
          const nowBlocks = Array.from(usedList.querySelectorAll('.block'));
          const nowTexts = nowBlocks.map(b => b.textContent.trim());
          if (JSON.stringify(nowTexts) === JSON.stringify(desiredTexts)) return true;
          let wrongIdx = -1;
          for (let i = 0; i < desiredTexts.length; i++) { if (nowTexts[i] !== desiredTexts[i]) { wrongIdx = i; break; } }
          if (wrongIdx === -1) return true;

          const wantText = desiredTexts[wrongIdx];
          const currentIdx = nowTexts.indexOf(wantText);
          if (currentIdx === -1) continue;
          const blockToMove = nowBlocks[currentIdx];
          if (blockToMove.getAttribute('aria-disabled') === 'true') continue;

          blockToMove.scrollIntoView({ behavior: 'instant', block: 'center' });
          await new Promise(r => setTimeout(r, 100));
          const br = blockToMove.getBoundingClientRect();
          const sx = br.x + br.width / 2, sy = br.y + br.height / 2;
          let ty;
          if (wrongIdx <= 0) ty = usedList.getBoundingClientRect().y + 3;
          else if (wrongIdx >= nowBlocks.length) ty = nowBlocks[nowBlocks.length - 1].getBoundingClientRect().bottom + 10;
          else {
            const tb = nowBlocks[wrongIdx].getBoundingClientRect();
            const mid = tb.y + tb.height / 2;
            ty = currentIdx < wrongIdx ? mid + tb.height * 0.35 : mid - tb.height * 0.35;
          }

          await new Promise(resolve => {
            blockToMove.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0, view: window }));
            setTimeout(() => {
              document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx + 1, clientY: sy + 2, button: 0, view: window }));
              setTimeout(() => {
                document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx + 2, clientY: sy + 5, button: 0, view: window }));
                setTimeout(() => {
                  const steps = 18;
                  let step = 0;
                  const iv = setInterval(() => {
                    step++;
                    const r = step / steps;
                    const eased = r < 0.5 ? 2 * r * r : 1 - Math.pow(-2 * r + 2, 2) / 2;
                    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx, clientY: sy + (ty - sy) * eased, button: 0, view: window }));
                    if (step >= steps) {
                      clearInterval(iv);
                      setTimeout(() => {
                        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx, clientY: ty, button: 0, view: window }));
                        setTimeout(() => {
                          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: sx, clientY: ty, button: 0, view: window }));
                          setTimeout(resolve, 400);
                        }, 150);
                      }, 250);
                    }
                  }, 20);
                }, 80);
              }, 80);
            }, 300);
          });
        }
        const finalTexts = Array.from(usedList.querySelectorAll('.block')).map(b => b.textContent.trim());
        return JSON.stringify(finalTexts) === JSON.stringify(desiredTexts);
      };

      // Strategy 3: DOM manipulation fallback
      const doDomReorder = () => {
        const nowBlocks = Array.from(usedList.querySelectorAll('.block'));
        const textToBlock = new Map();
        for (const b of nowBlocks) { const t = b.textContent.trim(); if (!textToBlock.has(t)) textToBlock.set(t, b); }
        for (const d of desiredOrder) { const el = textToBlock.get(d.text); if (el) usedList.appendChild(el); }
        usedList.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.Ember && window.Ember.run) { try { window.Ember.run.scheduleOnce('afterRender', () => {}); } catch (e) { /* ignore */ } }
        return JSON.stringify(Array.from(usedList.querySelectorAll('.block')).map(b => b.textContent.trim())) === JSON.stringify(desiredTexts);
      };

      (async () => {
        const emberOk = await tryEmberBulkReorder();
        if (emberOk) {
          await new Promise(r => setTimeout(r, 300));
          const ct = Array.from(usedList.querySelectorAll('.block')).map(b => b.textContent.trim());
          if (JSON.stringify(ct) === JSON.stringify(desiredTexts)) {
            document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: true, method: 'ember-bulk-reorder' } }));
            return;
          }
        }
        const mouseOk = await doSequentialReorder();
        if (mouseOk) {
          document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: true, method: emberOk ? 'ember+mouse-drag' : 'sequential-mouse-drag' } }));
          return;
        }
        const domOk = doDomReorder();
        document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: domOk || emberOk, method: domOk ? 'dom-manipulation' : (emberOk ? 'ember-only' : 'FAILED') } }));
      })();
      return;

    } catch (err) {
      console.error('[ZyAgent Bridge] reorder-all error:', err);
      document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: false, error: err.message } }));
    }
  });

  // ── SORTABLE-READ: Read the current state of both sortable lists ──
  document.addEventListener('zyagent-sortable-read', function (e) {
    const { requestId, containerSelector } = e.detail;
    let result = { unused: [], used: [] };
    try {
      const container = document.querySelector(containerSelector) || document;
      const unusedList = container.querySelector('.sortable[data-list-name="unused"]');
      const usedList = container.querySelector('.sortable[data-list-name="used"]');
      if (unusedList) {
        result.unused = Array.from(unusedList.querySelectorAll('.block')).map(b => ({
          blockId: b.getAttribute('data-block-id'), text: b.textContent.trim(), disabled: b.getAttribute('aria-disabled') === 'true'
        }));
      }
      if (usedList) {
        result.used = Array.from(usedList.querySelectorAll('.block')).map(b => ({
          blockId: b.getAttribute('data-block-id'), text: b.textContent.trim(), disabled: b.getAttribute('aria-disabled') === 'true'
        }));
      }
    } catch (err) { console.error('[ZyAgent Bridge] sortable-read error:', err); }
    document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: true, ...result } }));
  });

  // ── SORTABLE-EMBER-DIAGNOSTIC: Introspect Ember state for debugging ──
  document.addEventListener('zyagent-sortable-ember-diagnostic', function (e) {
    const { requestId, containerSelector } = e.detail;
    try {
      const container = document.querySelector(containerSelector) || document;
      const model = findEmberSortableModel(container);
      const diagnostic = {
        hasEmber: !!window.Ember, emberVersion: window.Ember && window.Ember.VERSION,
        hasEmberSet: !!(window.Ember && window.Ember.set),
        foundUnused: !!model?.unusedItems, foundUsed: !!model?.usedItems,
        unusedLen: model?.unusedItems ? (typeof model.unusedItems.get === 'function' ? model.unusedItems.get('length') : model.unusedItems.length) : 0,
        usedLen: model?.usedItems ? (typeof model.usedItems.get === 'function' ? model.usedItems.get('length') : model.usedItems.length) : 0,
        refs: model?.allRefs || []
      };
      if (model?.usedItems) {
        const items = [];
        for (let i = 0; i < diagnostic.usedLen; i++) {
          const item = typeof model.usedItems.objectAt === 'function' ? model.usedItems.objectAt(i) : model.usedItems[i];
          if (item) {
            const t = typeof item.get === 'function' ? (item.get('text') || item.get('code') || '') : (item.text || item.code || '');
            const allKeys = Object.keys(item).filter(k => !k.startsWith('_'));
            // Gather all indent-related property values
            const indentProps = {};
            for (const k of allKeys) {
              if (/indent|margin|level|offset|position/i.test(k)) {
                try {
                  indentProps[k] = typeof item.get === 'function' ? item.get(k) : item[k];
                } catch (e) { indentProps[k] = '(error)'; }
              }
            }
            // Also try common names even if not in Object.keys
            for (const prop of ['indent', 'indentation', 'indentLevel', 'indentPx']) {
              if (!(prop in indentProps)) {
                try {
                  const val = typeof item.get === 'function' ? item.get(prop) : item[prop];
                  if (val !== undefined) indentProps[prop] = val;
                } catch (e) { /* ignore */ }
              }
            }
            items.push({
              text: t.substring(0, 50),
              indentProps,
              allKeys,
              hasSet: typeof item.set === 'function',
              hasGet: typeof item.get === 'function',
              type: typeof item,
              constructor: item.constructor?.name || 'unknown'
            });
          }
        }
        diagnostic.usedItems = items;
      }
      // Also check DOM block data attributes and marginLeft
      const usedList = container.querySelector('.sortable[data-list-name="used"]');
      if (usedList) {
        diagnostic.domBlocks = Array.from(usedList.querySelectorAll('.block')).map(b => ({
          text: b.textContent.trim().substring(0, 40),
          marginLeft: b.style.marginLeft,
          dataIndent: b.getAttribute('data-indent'),
          dataBlockId: b.getAttribute('data-block-id'),
          disabled: b.getAttribute('aria-disabled')
        }));
      }
      document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: true, ...diagnostic } }));
    } catch (err) {
      document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: false, error: err.message } }));
    }
  });

  // ── SORTABLE-DETECT-INDENT: Read the actual indent pixel value ──
  document.addEventListener('zyagent-sortable-detect-indent', function (e) {
    const { requestId, containerSelector } = e.detail;
    let indentPx = 31;
    try {
      const container = document.querySelector(containerSelector) || document;
      const usedList = container.querySelector('.sortable[data-list-name="used"]');
      if (usedList) {
        for (const b of usedList.querySelectorAll('.block')) {
          const ml = parseFloat(b.style.marginLeft);
          if (ml > 10 && ml < 100) { indentPx = ml; break; }
        }
        if (indentPx === 31) {
          const guide = container.querySelector('.editor-indents');
          if (guide) {
            const divs = guide.querySelectorAll('div');
            if (divs.length > 0) { const w = divs[0].getBoundingClientRect().width; if (w > 10 && w < 100) indentPx = w; }
          }
        }
      }
    } catch (err) { /* ignore */ }
    document.dispatchEvent(new CustomEvent('zyagent-ace-response', { detail: { requestId, success: true, indentPx } }));
  });

  // ── SORTABLE-KEYBOARD-MOVE: Use native zyBooks keyboard controls ──
  // zyBooks says: "Grab/release Spacebar (or Enter). Move ↑↓←→. Cancel Esc"
  // This is the most reliable approach because it uses zyBooks' own a11y handlers.
  document.addEventListener('zyagent-sortable-keyboard-move', async function (e) {
    const { requestId, sourceListSelector, targetListSelector, sourceBlockText, sourceBlockId,
            targetInsertIndex, indentLevel = 0, direction = 'unused-to-used' } = e.detail;
    let success = false;
    let method = 'none';

    try {
      const sourceList = document.querySelector(sourceListSelector);
      const targetList = document.querySelector(targetListSelector);
      if (!sourceList || !targetList) throw new Error('Cannot find source/target lists');

      // Find source block
      let sourceBlock = null;
      if (sourceBlockText) {
        for (const b of sourceList.querySelectorAll('.block.moveable:not([aria-disabled="true"])')) {
          if (b.textContent.trim() === sourceBlockText) { sourceBlock = b; break; }
        }
      }
      if (!sourceBlock && sourceBlockId) {
        sourceBlock = sourceList.querySelector('.block[data-block-id="' + sourceBlockId + '"]:not([aria-disabled="true"])');
      }
      if (!sourceBlock) throw new Error('Cannot find source block');

      const isBlockInTarget = () => {
        if (sourceBlockText) {
          for (const b of targetList.querySelectorAll('.block.moveable')) {
            if (b.textContent.trim() === sourceBlockText) return true;
          }
        }
        return false;
      };

      // Already in target?
      if (isBlockInTarget()) {
        document.dispatchEvent(new CustomEvent('zyagent-ace-response', {
          detail: { requestId, success: true, method: 'already-in-target' }
        }));
        return;
      }

      const fire = (el, key, code, keyCode) => {
        const opts = { key, code, keyCode, bubbles: true, cancelable: true, view: window };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
      };

      // Step 1: Focus the source block
      sourceBlock.setAttribute('tabindex', '0');
      sourceBlock.focus();
      await new Promise(r => setTimeout(r, 200));

      // Step 2: Grab with Space (or Enter)
      fire(sourceBlock, ' ', 'Space', 32);
      await new Promise(r => setTimeout(r, 300));

      // Check if a grab indicator appeared (zyBooks adds aria-grabbed or visual cue)
      const grabbed = sourceBlock.getAttribute('aria-grabbed') === 'true' ||
                      sourceBlock.classList.contains('is-dragging') ||
                      sourceBlock.classList.contains('grabbed');

      if (!grabbed) {
        // Try Enter as alternative grab
        fire(sourceBlock, 'Enter', 'Enter', 13);
        await new Promise(r => setTimeout(r, 300));
      }

      // Step 3: Move to target list using arrow keys
      // For unused→used: typically ArrowRight or ArrowDown depending on layout
      // The number of arrow presses needed depends on the current position
      
      // First, move the block into the target list (right arrow for unused→used)
      if (direction === 'unused-to-used') {
        // Press ArrowRight to move from unused to used list
        fire(document.activeElement || sourceBlock, 'ArrowRight', 'ArrowRight', 39);
        await new Promise(r => setTimeout(r, 300));
        
        // Also try ArrowDown as some layouts are vertical
        if (!isBlockInTarget()) {
          fire(document.activeElement || sourceBlock, 'ArrowDown', 'ArrowDown', 40);
          await new Promise(r => setTimeout(r, 300));
        }
      } else {
        // used→unused: ArrowLeft
        fire(document.activeElement || sourceBlock, 'ArrowLeft', 'ArrowLeft', 37);
        await new Promise(r => setTimeout(r, 300));
      }

      // Step 4: Navigate to correct position with ArrowUp/ArrowDown
      // We need to move the block to the targetInsertIndex position
      // Since we don't know where it landed, we'll use multiple presses
      const currentBlocks = Array.from(targetList.querySelectorAll('.block'));
      const currentIdx = currentBlocks.findIndex(b => b.textContent.trim() === sourceBlockText);
      
      if (currentIdx >= 0 && currentIdx !== targetInsertIndex) {
        const delta = targetInsertIndex - currentIdx;
        const arrowKey = delta > 0 ? 'ArrowDown' : 'ArrowUp';
        const arrowCode = delta > 0 ? 40 : 38;
        for (let i = 0; i < Math.abs(delta); i++) {
          fire(document.activeElement || sourceBlock, arrowKey, arrowKey, arrowCode);
          await new Promise(r => setTimeout(r, 150));
        }
      }

      // Step 5: Set indentation with ArrowLeft/ArrowRight
      if (indentLevel > 0) {
        for (let i = 0; i < indentLevel; i++) {
          fire(document.activeElement || sourceBlock, 'ArrowRight', 'ArrowRight', 39);
          await new Promise(r => setTimeout(r, 150));
        }
      }

      // Step 6: Drop with Space (or Enter)
      fire(document.activeElement || sourceBlock, ' ', 'Space', 32);
      await new Promise(r => setTimeout(r, 300));

      if (isBlockInTarget()) {
        success = true;
        method = 'keyboard-space-arrows';
      } else {
        // Try Enter to drop
        fire(document.activeElement || sourceBlock, 'Enter', 'Enter', 13);
        await new Promise(r => setTimeout(r, 300));
        if (isBlockInTarget()) {
          success = true;
          method = 'keyboard-enter-arrows';
        } else {
          method = 'keyboard-FAILED';
        }
      }

      document.dispatchEvent(new CustomEvent('zyagent-ace-response', {
        detail: { requestId, success, method }
      }));

    } catch (err) {
      console.error('[ZyAgent Bridge] keyboard-move error:', err);
      document.dispatchEvent(new CustomEvent('zyagent-ace-response', {
        detail: { requestId, success: false, method: 'keyboard-error', error: err.message }
      }));
    }
  });

  // ── SORTABLE-KEYBOARD-INDENT: Adjust indent using left/right arrow keys ──
  document.addEventListener('zyagent-sortable-keyboard-indent', async function (e) {
    const { requestId, containerSelector, blockText, blockId, desiredIndent } = e.detail;
    const INDENT_PX = 31;

    try {
      const container = document.querySelector(containerSelector) || document;
      const usedList = container.querySelector('.sortable[data-list-name="used"]');
      if (!usedList) throw new Error('Cannot find used list');

      let block = null;
      if (blockText) {
        for (const b of usedList.querySelectorAll('.block.moveable')) {
          if (b.textContent.trim() === blockText) { block = b; break; }
        }
      }
      if (!block && blockId) block = usedList.querySelector('.block[data-block-id="' + blockId + '"]:not([aria-disabled="true"])');
      if (!block) throw new Error('Cannot find block for indent');

      const currentMargin = parseInt(block.style.marginLeft) || 0;
      const currentIndent = Math.round(currentMargin / INDENT_PX);

      if (currentIndent === desiredIndent) {
        document.dispatchEvent(new CustomEvent('zyagent-ace-response', {
          detail: { requestId, success: true, method: 'already-correct' }
        }));
        return;
      }

      const fire = (el, key, code, keyCode) => {
        const opts = { key, code, keyCode, bubbles: true, cancelable: true, view: window };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
      };

      // Focus and grab the block
      block.setAttribute('tabindex', '0');
      block.focus();
      await new Promise(r => setTimeout(r, 200));
      fire(block, ' ', 'Space', 32);
      await new Promise(r => setTimeout(r, 300));

      // Adjust indent with arrow keys
      const delta = desiredIndent - currentIndent;
      const arrowKey = delta > 0 ? 'ArrowRight' : 'ArrowLeft';
      const arrowCode = delta > 0 ? 39 : 37;
      for (let i = 0; i < Math.abs(delta); i++) {
        fire(document.activeElement || block, arrowKey, arrowKey, arrowCode);
        await new Promise(r => setTimeout(r, 150));
      }

      // Drop
      fire(document.activeElement || block, ' ', 'Space', 32);
      await new Promise(r => setTimeout(r, 300));

      const newMargin = parseInt(block.style.marginLeft) || 0;
      const newIndent = Math.round(newMargin / INDENT_PX);
      const success = newIndent === desiredIndent;

      document.dispatchEvent(new CustomEvent('zyagent-ace-response', {
        detail: { requestId, success, method: success ? 'keyboard-indent' : 'keyboard-indent-partial', actualIndent: newIndent }
      }));

    } catch (err) {
      console.error('[ZyAgent Bridge] keyboard-indent error:', err);
      document.dispatchEvent(new CustomEvent('zyagent-ace-response', {
        detail: { requestId, success: false, error: err.message }
      }));
    }
  });

  // ── Signal that the bridge is ready ──
  window.__zyagentBridgeReady = true;
  document.documentElement.setAttribute('data-zyagent-bridge-ready', 'true');
  document.dispatchEvent(new CustomEvent('zyagent-bridge-ready'));
  console.log('[ZyAgent Bridge] Page bridge loaded and ready');

})();
