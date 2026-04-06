// ─── ZyBook Agent — Definition Match Handler ───
// Handles definition-match exercises (custom-content-resource with zb-sortable).
// Terms live in a .term-bank; each definition row has a .term-bucket drop target.
// Strategy: Scrape terms and definitions, ask AI to match, use keyboard a11y.

(function () {
  'use strict';

  const Z = window.ZyAgent;

  /**
   * Scrape the definition-match activity structure.
   * Returns { terms: [...], definitions: [...], instructions: string }
   */
  function scrapeDefinitionMatch(el) {
    const result = {
      instructions: '',
      terms: [],         // { index, text, element }
      definitions: [],   // { index, text, bucketElement, currentTerm }
      alreadyPlaced: []  // terms already in buckets
    };

    // Instructions
    const instrEl = el.querySelector('.instructions, .activity-instructions, zyinstructions, .reorderable-lists-instructions');
    result.instructions = instrEl ? instrEl.innerText.trim() : '';

    // Terms in the bank (available to drag)
    const termBank = el.querySelector('.term-bank, .zb-sortable .term-bank');
    if (termBank) {
      const termItems = termBank.querySelectorAll('.definition-match-term, .zb-sortable-item, .draggable-object');
      result.terms = Array.from(termItems).map((t, i) => ({
        index: i,
        text: t.textContent.trim(),
        element: t
      }));
    }

    // Definition rows — each has a definition text and a bucket for the matching term
    const defRows = el.querySelectorAll('.definition-row, .match-row, .definition-match-row');
    if (defRows.length > 0) {
      result.definitions = Array.from(defRows).map((row, i) => {
        const defText = row.querySelector('.definition, .definition-text, .match-text');
        const bucket = row.querySelector('.term-bucket, .drop-target, .droppable');
        const placedTerm = bucket ? bucket.querySelector('.definition-match-term, .zb-sortable-item') : null;
        return {
          index: i,
          text: defText ? defText.textContent.trim() : row.textContent.trim(),
          bucketElement: bucket || row,
          currentTerm: placedTerm ? placedTerm.textContent.trim() : null
        };
      });
    }

    // Fallback: try generic sortable structure
    if (result.definitions.length === 0) {
      const buckets = el.querySelectorAll('.term-bucket, .drop-target');
      result.definitions = Array.from(buckets).map((bucket, i) => {
        // The definition text is usually a sibling or parent's text
        const row = bucket.closest('.definition-row, .match-row, tr, li') || bucket.parentElement;
        let defText = '';
        if (row) {
          const defEl = row.querySelector('.definition, .definition-text');
          defText = defEl ? defEl.textContent.trim() : '';
          if (!defText) {
            // Get text not inside the bucket
            const clone = row.cloneNode(true);
            const bucketClone = clone.querySelector('.term-bucket, .drop-target');
            if (bucketClone) bucketClone.remove();
            defText = clone.textContent.trim();
          }
        }
        const placedTerm = bucket.querySelector('.definition-match-term, .zb-sortable-item');
        return {
          index: i,
          text: defText,
          bucketElement: bucket,
          currentTerm: placedTerm ? placedTerm.textContent.trim() : null
        };
      });
    }

    // Track already-placed terms
    result.alreadyPlaced = result.definitions
      .filter(d => d.currentTerm)
      .map(d => d.currentTerm);

    return result;
  }

  /**
   * Attempt to move a term from the bank to a definition bucket.
   * Strategy cascade:
   *   1. Keyboard: focus term, Space to grab, arrows to navigate, Space to drop
   *   2. Mouse drag simulation
   *   3. HTML5 DragEvent
   */
  async function moveTermToBucket(termEl, bucketEl) {
    // ── Strategy 1: Keyboard approach ──
    // zyBooks sortable supports: "Grab/release Spacebar (or Enter). Move ↑↓←→"
    try {
      termEl.scrollIntoView({ behavior: 'instant', block: 'center' });
      await Z.sleep(150);

      // Focus the term
      termEl.focus();
      await Z.sleep(100);
      termEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Z.sleep(100);

      // Grab with Space
      termEl.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
      termEl.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
      await Z.sleep(300);

      // Calculate how many arrow presses needed
      // We need to navigate to the target bucket
      // Direction: typically ArrowRight moves between lists, ArrowDown moves within
      const termRect = termEl.getBoundingClientRect();
      const bucketRect = bucketEl.getBoundingClientRect();

      // Move right to get into the definitions area
      termEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
      termEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
      await Z.sleep(200);

      // Move down/up to reach the correct bucket
      const deltaY = bucketRect.top - termRect.top;
      const arrowKey = deltaY > 0 ? 'ArrowDown' : 'ArrowUp';
      const steps = Math.max(1, Math.round(Math.abs(deltaY) / 50));
      for (let i = 0; i < steps; i++) {
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: arrowKey, code: arrowKey, bubbles: true }));
        document.activeElement.dispatchEvent(new KeyboardEvent('keyup', { key: arrowKey, code: arrowKey, bubbles: true }));
        await Z.sleep(100);
      }

      // Drop with Space
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
      document.activeElement.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
      await Z.sleep(300);

      // Check if the term landed in the bucket
      const placed = bucketEl.querySelector('.definition-match-term, .zb-sortable-item');
      if (placed && placed.textContent.trim() === termEl.textContent.trim()) {
        return true;
      }
    } catch (err) {
      console.warn('[ZyAgent] DefMatch: Keyboard move error:', err.message);
    }

    // ── Strategy 2: Mouse drag simulation ──
    try {
      await Z.simulateDragDrop(termEl, bucketEl);
      await Z.sleep(400);

      const placed = bucketEl.querySelector('.definition-match-term, .zb-sortable-item');
      if (placed && placed.textContent.trim() === termEl.textContent.trim()) {
        return true;
      }
    } catch (err) {
      console.warn('[ZyAgent] DefMatch: Mouse drag error:', err.message);
    }

    // ── Strategy 3: Bridge-based sortable move ──
    try {
      const termText = termEl.textContent.trim();
      const termId = termEl.getAttribute('data-block-id') || termEl.getAttribute('data-id') || '';
      const container = termEl.closest('.interactive-activity-container, .definition-match-payload, [content_resource_id]');
      const resourceId = container?.getAttribute('content_resource_id')
        || container?.closest('[content_resource_id]')?.getAttribute('content_resource_id');
      const containerSel = resourceId
        ? `[content_resource_id="${resourceId}"]`
        : '.definition-match-payload';

      const bankSel = `${containerSel} .term-bank`;
      const bucketSel = `${containerSel} .term-bucket`;

      const result = await Z.sortableMoveBlock(bankSel, bucketSel, termId, 0, 0, termText);
      if (result.success) return true;
    } catch (err) {
      console.warn('[ZyAgent] DefMatch: Bridge move error:', err.message);
    }

    return false;
  }

  Z.handleDefinitionMatch = async function (activity, settings) {
    const el = activity.element;

    if (Z.checkCompletion(el)) {
      Z.sendProgress(0, 0, `Definition match "${activity.title}" already completed, skipping`, 'info');
      return;
    }

    Z.sendProgress(0, 1, `Definition match "${activity.title}"`);

    const ctx = scrapeDefinitionMatch(el);

    if (ctx.terms.length === 0 && ctx.definitions.length === 0) {
      Z.sendProgress(0, 0, 'No terms or definitions found — trying generic handler', 'warn');
      return Z.handleGenericActivity(activity, settings);
    }

    // Filter out terms that are already placed
    const availableTerms = ctx.terms.filter(t => !ctx.alreadyPlaced.includes(t.text));
    const emptyDefs = ctx.definitions.filter(d => !d.currentTerm);

    if (availableTerms.length === 0) {
      Z.sendProgress(0, 0, 'All terms already placed — checking if complete', 'info');
      await Z.clickSubmitButton(el);
      return;
    }

    // Ask AI to match terms to definitions
    const termList = availableTerms.map((t, i) => `  [${i}] "${t.text}"`).join('\n');
    const defList = ctx.definitions.map((d, i) => {
      const status = d.currentTerm ? ` (already has: "${d.currentTerm}")` : ' (empty)';
      return `  [${i}] "${d.text}"${status}`;
    }).join('\n');

    const messages = [
      {
        role: 'system',
        content: `You are an expert programmer/tutor matching terms to their definitions in a zyBooks exercise.

Match each available term to the correct definition.
Return ONLY lines in the format: TERM_INDEX -> DEF_INDEX
Use 0-based indices from the lists below.

Example response:
0 -> 2
1 -> 0
2 -> 1

${ctx.instructions ? `Exercise instructions: ${ctx.instructions}` : ''}
Do NOT include explanations. Just the index mappings.`
      },
      {
        role: 'user',
        content: [
          'Available terms (to be placed):',
          termList,
          '',
          'Definitions:',
          defList,
          '',
          `Match each term to the correct definition. Only match to empty definitions (indices: ${emptyDefs.map(d => d.index).join(', ')}).`
        ].join('\n')
      }
    ];

    const response = await Z.callAI(settings, messages);
    console.log('[ZyAgent] DefMatch AI response:', response);

    // Parse mappings
    const mappings = response.split('\n')
      .map(line => {
        const match = line.match(/(\d+)\s*->\s*(\d+)/);
        return match ? { termIdx: parseInt(match[1]), defIdx: parseInt(match[2]) } : null;
      })
      .filter(Boolean);

    if (mappings.length === 0) {
      Z.sendProgress(0, 1, 'AI returned no valid mappings', 'error');
      return;
    }

    Z.sendProgress(0, mappings.length, `Placing ${mappings.length} term(s)…`);

    let placed = 0;
    for (const mapping of mappings) {
      if (Z.shouldStop) break;

      const term = availableTerms[mapping.termIdx];
      const def = ctx.definitions[mapping.defIdx];

      if (!term || !def) {
        console.warn('[ZyAgent] DefMatch: Invalid mapping', mapping);
        continue;
      }

      // Skip if this definition already has a term
      if (def.currentTerm) {
        console.log('[ZyAgent] DefMatch: Definition', mapping.defIdx, 'already filled — skipping');
        continue;
      }

      Z.sendProgress(placed + 1, mappings.length,
        `Placing "${term.text.substring(0, 30)}" → "${def.text.substring(0, 30)}"`);

      // Re-find the term element (it may have moved in the DOM)
      const termBank = el.querySelector('.term-bank, .zb-sortable .term-bank');
      let termEl = term.element;
      if (termBank) {
        const freshTerms = termBank.querySelectorAll('.definition-match-term, .zb-sortable-item, .draggable-object');
        const found = Array.from(freshTerms).find(t => t.textContent.trim() === term.text);
        if (found) termEl = found;
      }

      const success = await moveTermToBucket(termEl, def.bucketElement);
      if (success) {
        placed++;
        console.log('[ZyAgent] DefMatch: Placed term', mapping.termIdx, '→ def', mapping.defIdx);
      } else {
        console.warn('[ZyAgent] DefMatch: Failed to place term', mapping.termIdx, `"${term.text}"`);
      }

      await Z.sleep(500);
    }

    Z.sendProgress(placed, mappings.length, `Placed ${placed}/${mappings.length} terms`);

    // Click Check / Submit
    await Z.sleep(500);
    const submitted = await Z.clickSubmitButton(el);

    if (!submitted) {
      // Try finding any check button
      const checkBtn = el.querySelector('button.check-button:not([disabled]), button.zb-button.primary:not([disabled])');
      if (checkBtn) {
        checkBtn.click();
        await Z.sleep(1000);
      }
    }

    await Z.sleep(1500);

    if (Z.checkCompletion(el)) {
      Z.sendProgress(1, 1, `Definition match "${activity.title}" completed!`, 'success');
    } else {
      Z.sendProgress(0, 1, `Definition match "${activity.title}" may not be complete — check manually`, 'warn');
    }
  };

})();
