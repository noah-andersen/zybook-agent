// ─── ZyBook Agent — Challenge: Parsons Problems (Type C) ───
// Handles drag-and-drop code ordering challenges.
// Split from challenge.js for maintainability.
// Depends on: challenge-shared.js (loaded before this file)

(function () {
  'use strict';

  const Z = window.ZyAgent;
  const INDENT_PX_PER_LEVEL = 31;

  // ────────────────────────────────────────────────────────────
  //  BLOCK MOVEMENT
  // ────────────────────────────────────────────────────────────

  /**
   * Try to move a block from the unused list into the used list.
   * Uses a cascade of strategies:
   *   0. KEYBOARD: zyBooks native Space-grab → Arrow-move → Space-drop
   *   1. MAIN-world bridge (ember-sortable mouse events from page context)
   *   2. ISOLATED-world mouse/pointer simulation
   *   3. Touch events (mobile fallback)
   */
  async function moveBlockToUsedList(el, sourceBlock, targetInsertIndex, sourceBlockId, indentLevel = 0) {
    const unusedListSel = '.sortable[data-list-name="unused"]';
    const usedListSel   = '.sortable[data-list-name="used"]';
    const blockText = sourceBlock.textContent.trim();

    const isBlockInUsed = () => {
      const usedList = el.querySelector(usedListSel);
      if (!usedList) return false;
      const usedBlocks = usedList.querySelectorAll('.block.moveable');
      for (const b of usedBlocks) {
        if (b.textContent.trim() === blockText) return true;
      }
      return false;
    };

    const isSourceStillInUnused = () => {
      const unusedList = el.querySelector(unusedListSel);
      return unusedList && unusedList.contains(sourceBlock);
    };

    if (!isSourceStillInUnused() && isBlockInUsed()) return true;

    // ── Strategy 0: KEYBOARD (zyBooks native a11y) ──
    console.log('[ZyAgent] Parsons: Trying KEYBOARD (native a11y) approach');
    try {
      sourceBlock.scrollIntoView({ behavior: 'instant', block: 'center' });
      await Z.sleep(200);

      const resourceId = el.getAttribute('content_resource_id')
        || el.closest('[content_resource_id]')?.getAttribute('content_resource_id')
        || el.querySelector('[content_resource_id]')?.getAttribute('content_resource_id');
      const containerSel = resourceId
        ? `[content_resource_id="${resourceId}"]`
        : '.two-reorderable-lists';

      const kbResult = await Z.sortableKeyboardMove(
        `${containerSel} ${unusedListSel}`,
        `${containerSel} ${usedListSel}`,
        blockText,
        sourceBlockId,
        targetInsertIndex,
        indentLevel,
        'unused-to-used'
      );
      await Z.sleep(300);
      if (kbResult.success || isBlockInUsed()) {
        console.log('[ZyAgent] Parsons: Keyboard move succeeded via', kbResult.method);
        return true;
      }
      console.log('[ZyAgent] Parsons: Keyboard move reported:', kbResult.method);
    } catch (err) {
      console.warn('[ZyAgent] Parsons: Keyboard move error:', err.message);
    }
    if (isBlockInUsed()) return true;

    // ── Strategy 1: MAIN-world bridge mouse drag ──
    console.log('[ZyAgent] Parsons: Trying MAIN-world bridge drag');
    try {
      sourceBlock.scrollIntoView({ behavior: 'instant', block: 'center' });
      await Z.sleep(200);

      const resourceId = el.getAttribute('content_resource_id')
        || el.closest('[content_resource_id]')?.getAttribute('content_resource_id')
        || el.querySelector('[content_resource_id]')?.getAttribute('content_resource_id');
      const containerSel = resourceId
        ? `[content_resource_id="${resourceId}"]`
        : '.two-reorderable-lists';

      const result = await Z.sortableMoveBlock(
        `${containerSel} ${unusedListSel}`,
        `${containerSel} ${usedListSel}`,
        sourceBlockId,
        targetInsertIndex,
        indentLevel,
        blockText
      );

      await Z.sleep(300);
      if (result.success || isBlockInUsed()) {
        console.log('[ZyAgent] Parsons: Bridge drag succeeded via', result.method);
        return true;
      }
      console.log('[ZyAgent] Parsons: Bridge drag reported failure');
    } catch (err) {
      console.warn('[ZyAgent] Parsons: Bridge drag error:', err.message);
    }
    await Z.sleep(300);
    if (isBlockInUsed()) return true;

    // ── Strategy 2: ISOLATED-world mouse + pointer simulation ──
    console.log('[ZyAgent] Parsons: Trying ISOLATED-world mouse simulation');
    {
      const usedList = el.querySelector(usedListSel);
      const usedBlocks = Array.from(usedList.querySelectorAll('.block'));
      let target;
      if (targetInsertIndex <= 0 || usedBlocks.length === 0) {
        target = usedBlocks[0] || usedList;
      } else if (targetInsertIndex >= usedBlocks.length) {
        target = usedBlocks[usedBlocks.length - 1];
      } else {
        target = usedBlocks[targetInsertIndex];
      }
      const INDENT_PX = 31;
      const listRect = usedList.getBoundingClientRect();
      const indentOffsetX = indentLevel > 0
        ? listRect.x + 20 + (indentLevel * INDENT_PX)
        : undefined;

      await Z.simulateDragDrop(sourceBlock, target, { overrideTargetX: indentOffsetX });
      await Z.sleep(600);
      if (isBlockInUsed()) {
        console.log('[ZyAgent] Parsons: ISOLATED mouse simulation succeeded');
        return true;
      }
    }

    // ── Strategy 3: Touch events ──
    console.log('[ZyAgent] Parsons: Trying touch event simulation');
    try {
      const sourceRect = sourceBlock.getBoundingClientRect();
      const usedList = el.querySelector(usedListSel);
      const usedBlocks = Array.from(usedList.querySelectorAll('.block'));
      const targetEl = usedBlocks[targetInsertIndex] || usedBlocks[usedBlocks.length - 1] || usedList;
      const targetRect = targetEl.getBoundingClientRect();

      const createTouch = (touchEl, x, y) => new Touch({
        identifier: Date.now(), target: touchEl, clientX: x, clientY: y,
        pageX: x + window.scrollX, pageY: y + window.scrollY
      });

      const sx = sourceRect.x + sourceRect.width / 2;
      const sy = sourceRect.y + sourceRect.height / 2;
      const tx = targetRect.x + targetRect.width / 2;
      const ty = targetRect.y + targetRect.height / 2;

      const startTouch = createTouch(sourceBlock, sx, sy);
      sourceBlock.dispatchEvent(new TouchEvent('touchstart', {
        bubbles: true, cancelable: true, touches: [startTouch], targetTouches: [startTouch], changedTouches: [startTouch]
      }));
      await Z.sleep(150);
      for (let i = 1; i <= 6; i++) {
        const ratio = i / 6;
        const moveTouch = createTouch(sourceBlock, sx + (tx - sx) * ratio, sy + (ty - sy) * ratio);
        document.dispatchEvent(new TouchEvent('touchmove', {
          bubbles: true, cancelable: true, touches: [moveTouch], targetTouches: [moveTouch], changedTouches: [moveTouch]
        }));
        await Z.sleep(30);
      }
      await Z.sleep(100);
      const endTouch = createTouch(sourceBlock, tx, ty);
      document.dispatchEvent(new TouchEvent('touchend', {
        bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [endTouch]
      }));
      await Z.sleep(500);
      if (isBlockInUsed()) {
        console.log('[ZyAgent] Parsons: Touch simulation succeeded');
        return true;
      }
    } catch (err) {
      console.warn('[ZyAgent] Parsons: Touch simulation error:', err.message);
    }

    console.warn('[ZyAgent] Parsons: ALL drag strategies failed for block', sourceBlockId);
    return false;
  }

  // ────────────────────────────────────────────────────────────
  //  INDENTATION
  // ────────────────────────────────────────────────────────────

  /**
   * Adjust a single block's indentation via multiple strategies.
   */
  async function adjustBlockIndentation(el, blockId, desiredIndent, blockText = '') {
    const INDENT_PX = INDENT_PX_PER_LEVEL;
    const usedList = el.querySelector('.sortable[data-list-name="used"]');
    if (!usedList) return false;

    // Find the block — prefer text match
    let block = null;
    if (blockText) {
      const candidates = usedList.querySelectorAll('.block.moveable');
      for (const b of candidates) {
        if (b.textContent.trim() === blockText) { block = b; break; }
      }
    }
    if (!block) {
      block = usedList.querySelector(`.block[data-block-id="${blockId}"]:not([aria-disabled="true"])`);
    }
    if (!block) return false;

    const currentMargin = parseInt(block.style.marginLeft) || 0;
    const currentIndent = Math.round(currentMargin / INDENT_PX);

    if (currentIndent === desiredIndent) {
      console.log('[ZyAgent] Parsons: Block', blockId, 'already at correct indent', desiredIndent);
      return true;
    }

    const desiredMargin = desiredIndent * INDENT_PX;
    console.log('[ZyAgent] Parsons: Block', blockId, `"${blockText.substring(0, 30)}"`, 'at indent', currentIndent, '→ adjusting to', desiredIndent);

    // ── Strategy 1: MAIN-world bridge ──
    try {
      const resourceId = el.getAttribute('content_resource_id')
        || el.closest('[content_resource_id]')?.getAttribute('content_resource_id')
        || el.querySelector('[content_resource_id]')?.getAttribute('content_resource_id');
      const containerSel = resourceId
        ? `[content_resource_id="${resourceId}"]`
        : '.two-reorderable-lists';

      const result = await Z.sortableAdjustIndent(containerSel, blockText, blockId, desiredIndent);
      if (result.success) {
        console.log('[ZyAgent] Parsons: Bridge indent adjustment succeeded for block', blockId);
        return true;
      }
    } catch (err) {
      console.warn('[ZyAgent] Parsons: Bridge indent error:', err.message);
    }

    // Re-check in case bridge partially worked
    const postBridgeMargin = parseInt(block.style.marginLeft) || 0;
    if (Math.round(postBridgeMargin / INDENT_PX) === desiredIndent) return true;

    // ── Strategy 2: ISOLATED-world mouse simulation ──
    console.log('[ZyAgent] Parsons: Trying ISOLATED-world mouse simulation for indent');
    {
      const deltaX = desiredMargin - (parseInt(block.style.marginLeft) || 0);
      const blockRect = block.getBoundingClientRect();
      const startX = blockRect.x + blockRect.width / 2;
      const startY = blockRect.y + blockRect.height / 2;
      const endX = startX + deltaX;

      block.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, clientX: startX, clientY: startY, button: 0
      }));
      await Z.sleep(150);

      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, clientX: startX + 2, clientY: startY, button: 0
      }));
      await Z.sleep(80);

      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const cx = startX + (deltaX * i / steps);
        document.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, cancelable: true, clientX: cx, clientY: startY, button: 0
        }));
        await Z.sleep(30);
      }
      await Z.sleep(100);

      document.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, cancelable: true, clientX: endX, clientY: startY, button: 0
      }));
      await Z.sleep(400);
    }

    const postMouseMargin = parseInt(block.style.marginLeft) || 0;
    if (Math.round(postMouseMargin / INDENT_PX) === desiredIndent) {
      console.log('[ZyAgent] Parsons: ISOLATED mouse indent adjustment succeeded');
      return true;
    }

    // ── Strategy 3: Direct DOM manipulation (last resort) ──
    console.log('[ZyAgent] Parsons: Mouse simulation failed — trying direct DOM style.marginLeft');
    block.style.marginLeft = desiredMargin + 'px';
    block.dispatchEvent(new Event('change', { bubbles: true }));
    block.dispatchEvent(new Event('input', { bubbles: true }));

    const currentDataIndent = block.getAttribute('data-indent');
    if (currentDataIndent !== null) {
      block.setAttribute('data-indent', String(desiredIndent));
    }

    await Z.sleep(200);

    const finalMargin = parseInt(block.style.marginLeft) || 0;
    const finalIndent = Math.round(finalMargin / INDENT_PX);
    if (finalIndent === desiredIndent) {
      console.log('[ZyAgent] Parsons: Direct DOM indent set succeeded for block', blockId);
      return true;
    }

    console.warn('[ZyAgent] Parsons: ALL indent strategies failed for block', blockId,
      '— final indent', finalIndent, 'wanted', desiredIndent);
    return false;
  }

  /**
   * Analyze blocks in the used list and fix their indentation.
   * Optionally accepts AI-provided indent overrides which take priority.
   */
  async function fixIndentationInUsedList(el, usedInfo, aiIndentOverrides = null) {
    const usedList = el.querySelector('.sortable[data-list-name="used"]');
    if (!usedList) return false;

    // If we have AI-provided indent overrides, use those directly
    if (aiIndentOverrides && Object.keys(aiIndentOverrides).length > 0) {
      console.log('[ZyAgent] Parsons: Using AI-provided indent overrides');
      let anyAdjusted = false;
      const usedBlocks = Array.from(usedList.querySelectorAll('.block'));
      for (let i = 0; i < usedBlocks.length; i++) {
        const block = usedBlocks[i];
        const isLocked = block.getAttribute('aria-disabled') === 'true';
        if (isLocked) continue;

        const blockText = block.textContent.trim();
        const desiredLevel = aiIndentOverrides[blockText];
        if (desiredLevel === undefined) continue;

        const currentMarginPx = parseInt(block.style.marginLeft) || 0;
        const currentLevel = Math.round(currentMarginPx / INDENT_PX_PER_LEVEL);

        if (currentLevel !== desiredLevel) {
          const blockId = block.getAttribute('data-block-id');
          console.log(`[ZyAgent] Parsons: AI override — adjusting "${blockText.substring(0, 40)}" from indent ${currentLevel} → ${desiredLevel}`);
          await adjustBlockIndentation(el, blockId, desiredLevel, blockText);
          anyAdjusted = true;
          await Z.sleep(400);
        }
      }
      return anyAdjusted;
    }

    // ── Structural analysis: build desired indent map ──
    const desiredIndents = [];
    let indentStack = [0];

    for (let i = 0; i < usedInfo.length; i++) {
      const block = usedInfo[i];
      const text = block.text.trim();

      if (block.isLocked) {
        const lockedIndent = Math.round((parseInt(block.indent) || 0) / INDENT_PX_PER_LEVEL);
        desiredIndents.push(lockedIndent);
        indentStack = [];
        for (let j = 0; j <= lockedIndent; j++) indentStack.push(j);
      } else {
        const currentScope = indentStack[indentStack.length - 1] || 0;
        desiredIndents.push(currentScope);
      }

      if (text.endsWith(':')) {
        const thisIndent = desiredIndents[i];
        indentStack.push(thisIndent + 1);
      }
    }

    console.log('[ZyAgent] Parsons: Code structure analysis:');
    for (let i = 0; i < usedInfo.length; i++) {
      const block = usedInfo[i];
      const currentMarginPx = parseInt(block.indent) || 0;
      const currentLevel = Math.round(currentMarginPx / INDENT_PX_PER_LEVEL);
      console.log(`  [${i}] "${block.text.substring(0, 40)}" current=${currentLevel} desired=${desiredIndents[i]} ${block.isLocked ? '(LOCKED)' : ''}`);
    }

    let anyAdjusted = false;
    const usedBlocks = Array.from(usedList.querySelectorAll('.block'));
    for (let i = 0; i < usedBlocks.length; i++) {
      const block = usedBlocks[i];
      const isLocked = block.getAttribute('aria-disabled') === 'true';
      if (isLocked) continue;

      const currentMarginPx = parseInt(block.style.marginLeft) || 0;
      const currentLevel = Math.round(currentMarginPx / INDENT_PX_PER_LEVEL);
      const desiredLevel = desiredIndents[i];

      if (desiredLevel !== undefined && currentLevel !== desiredLevel) {
        const blockId = block.getAttribute('data-block-id');
        const blockText = block.textContent.trim();
        console.log(`[ZyAgent] Parsons: Adjusting "${blockText.substring(0, 40)}" from indent ${currentLevel} → ${desiredLevel}`);
        await adjustBlockIndentation(el, blockId, desiredLevel, blockText);
        anyAdjusted = true;
        await Z.sleep(400);
      }
    }

    return anyAdjusted;
  }

  // ────────────────────────────────────────────────────────────
  //  RESET
  // ────────────────────────────────────────────────────────────

  async function resetParsonsBlocks(el) {
    const resetBtn = el.querySelector('button.reset-button, .reset-button, a.reset-button') ||
      el.querySelector('button[aria-label*="reset" i], button[aria-label*="template" i]') ||
      Array.from(el.querySelectorAll('button, a.action-button, a')).find(
        btn => /reset|default|template|start over/i.test(btn.innerText)
      );

    if (resetBtn) {
      console.log('[ZyAgent] Parsons: Clicking reset button:', resetBtn.innerText.trim());
      resetBtn.click();
      await Z.sleep(1000);

      const confirmModal = await Z.waitForCondition(() => {
        const modals = document.querySelectorAll('.zb-modal-content');
        for (const modal of modals) {
          if (modal.offsetParent !== null ||
              modal.closest('.zb-modal.visible, .zb-modal.show, [style*="display: block"], [style*="display:block"]')) {
            return modal;
          }
          if (modal.textContent.includes('default template') || modal.textContent.includes('put back in unused')) {
            return modal;
          }
        }
        return null;
      }, { timeout: 3000, interval: 200 });

      if (confirmModal) {
        console.log('[ZyAgent] Parsons: Found confirmation modal');
        const confirmBtn = Array.from(confirmModal.querySelectorAll('button.zb-button')).find(
          btn => /use default template/i.test(btn.innerText)
        );
        const fallbackBtn = confirmModal.querySelector('button.zb-button.secondary.raised') ||
          confirmModal.querySelector('button.zb-button:not(.error)');

        const btnToClick = confirmBtn || fallbackBtn;
        if (btnToClick) {
          btnToClick.click();
          console.log('[ZyAgent] Parsons: Clicked confirm:', btnToClick.innerText.trim());
          await Z.sleep(2000);
        }
      } else {
        await Z.sleep(1000);
      }
    } else {
      console.log('[ZyAgent] Parsons: No reset button found — manual block reset');
      const usedListEl = el.querySelector('.sortable[data-list-name="used"]');
      const unusedListEl = el.querySelector('.sortable[data-list-name="unused"]');
      if (usedListEl && unusedListEl) {
        const moveableBlocks = Array.from(usedListEl.querySelectorAll('.block.moveable:not([aria-disabled="true"])'));
        for (const block of moveableBlocks) {
          try {
            const unusedRect = unusedListEl.getBoundingClientRect();
            await Z.simulateDragDrop(block, unusedListEl, {
              overrideTargetX: unusedRect.x + unusedRect.width / 2
            });
            await Z.sleep(400);
          } catch (err) {
            console.warn('[ZyAgent] Parsons: Failed to drag block back:', err.message);
          }
        }
        await Z.sleep(500);
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  //  AI PROMPT BUILDERS
  // ────────────────────────────────────────────────────────────

  function buildParsonsPrompt(ctx, attemptHistory, attempt) {
    const usedDisplay = ctx.usedBlocks.map((b, i) => {
      const prefix = '    '.repeat(b.indent);
      return `  [${i}] ${b.isLocked ? '🔒LOCKED' : '🔓moveable'} indent=${b.indent} dataIndent=${b.dataIndent} | ${prefix}${b.text}`;
    }).join('\n');

    const unusedDisplay = ctx.unusedBlocks.map(b =>
      `  [UNUSED_INDEX ${b.domIndex}] dataIndent=${b.dataIndent} draggable=${b.isDraggable} | "${b.text}"`
    ).join('\n');

    let historyContext = '';
    if (attemptHistory.length > 0) {
      historyContext = '\n\n══ PREVIOUS ATTEMPTS (learn from these mistakes!) ══\n';
      for (const hist of attemptHistory) {
        historyContext += `\nAttempt ${hist.attempt}:`;
        if (hist.feedback) historyContext += `\n  Feedback: ${hist.feedback}`;
        if (hist.testResults && hist.testResults.length > 0) {
          historyContext += '\n  Test Results:';
          for (const t of hist.testResults) historyContext += '\n    ' + JSON.stringify(t);
        }
        if (hist.visualAnalysis) historyContext += `\n  Visual: ${hist.visualAnalysis.substring(0, 500)}`;
        historyContext += `\n  Your previous response (WRONG): ${hist.response.substring(0, 500)}`;
        if (hist.skippedBlocks && hist.skippedBlocks.length > 0) {
          historyContext += `\n  Blocks you skipped: ${hist.skippedBlocks.join(', ')}`;
        }
        if (hist.usedBlockCount !== undefined) {
          historyContext += `\n  Blocks you used: ${hist.usedBlockCount}`;
        }
      }
      historyContext += '\n\nDo NOT repeat the same mistake. Carefully analyze what went wrong.';
    }

    let distractorContext = '';
    if (ctx.hasDistractors) {
      distractorContext = `\n\n⚠️ DISTRACTOR WARNING ⚠️
${ctx.distractorHint}

CRITICAL: You MUST NOT use all blocks. Some blocks are WRONG/UNNECESSARY distractors.
For each block you decide NOT to use, write: UNUSED_INDEX -> SKIP
Placing ALL blocks will result in FAILURE.`;
      if (ctx.expectedBlockCount !== null) {
        distractorContext += `\nThe solution expects EXACTLY ${ctx.expectedBlockCount} moveable blocks.`;
        const currentMoveable = ctx.usedBlocks.filter(b => !b.isLocked).length;
        const totalAvailable = ctx.unusedBlocks.length + currentMoveable;
        const numDistractors = totalAvailable - ctx.expectedBlockCount;
        if (numDistractors > 0) {
          distractorContext += ` That means ${numDistractors} of the ${totalAvailable} available block(s) are DISTRACTORS.`;
        }
      }
    }

    const indentHint = ctx.indentGuideCount > 0
      ? `\nINDENTATION: Editor shows ${ctx.indentGuideCount} indent guide(s). Use indent=1+ for indented code.`
      : '';

    // Build extra context from examples and expanded sections
    let extraContext = '';
    if (ctx.exampleDetails) {
      extraContext += `\n\nEXAMPLE (from exercise):\n${ctx.exampleDetails.substring(0, 1000)}`;
    }
    if (ctx.howToUseContent) {
      extraContext += `\n\nHOW TO USE THIS TOOL:\n${ctx.howToUseContent.substring(0, 500)}`;
    }
    if (ctx.lockedBlocksCode) {
      extraContext += `\n\nLOCKED CODE (already in place, CANNOT be changed):\n${ctx.lockedBlocksCode}`;
    }

    // Analyze blocks for similar/confusing pairs
    let similarBlocksNote = '';
    const unusedTexts = ctx.unusedBlocks.map(b => b.text);
    for (let i = 0; i < unusedTexts.length; i++) {
      for (let j = i + 1; j < unusedTexts.length; j++) {
        const a = unusedTexts[i].replace(/\s+/g, ' ').trim();
        const b = unusedTexts[j].replace(/\s+/g, ' ').trim();
        // Same function/variable name but different parameters/values
        if ((a.startsWith('def ') && b.startsWith('def ') && a.split('(')[0] === b.split('(')[0]) ||
            (a.split('=')[0].trim() === b.split('=')[0].trim() && a !== b)) {
          similarBlocksNote += `\n⚠️ LOOK CAREFULLY: Block "${a}" vs Block "${b}" — only ONE is correct!`;
        }
      }
    }

    return [
      {
        role: 'system',
        content: `You are an expert Python programmer solving a zyBooks Parsons Problem (drag-and-drop code ordering).

TASK: Arrange ONLY the CORRECT code blocks to form a correct Python program. Leave distractors unused.
${ctx.instructions ? `\nExercise instructions:\n"${ctx.instructions}"` : ''}
${extraContext}

CURRENT CODE AREA (blocks already in the solution, in order):
${usedDisplay || '  (empty — nothing placed yet)'}

🔒LOCKED blocks CANNOT be moved. They are fixed anchors.
🔓moveable blocks were previously placed and could be in the wrong spot.

UNUSED BLOCKS available to place:
${unusedDisplay}
${similarBlocksNote}
${indentHint}${distractorContext}

THINK STEP BY STEP:
1. Read ALL instructions carefully, including examples.
2. Read ALL blocks carefully (locked + placed + unused).
3. Identify which blocks are DISTRACTORS that should NOT be used.
   - Look for blocks with wrong default parameters vs correct ones.
   - Look for blocks that duplicate functionality but are subtly wrong.
   - Check if using all blocks would create duplicate logic or wrong syntax.
4. Identify the COMPLETE correct Python program using ONLY correct blocks.
5. Locked blocks are fixed — build around them.
6. Determine the correct ORDER and INDENTATION of all blocks.

INDENTATION RULES:
- indent=0: top-level code (function definitions, global statements)
- indent=1: inside a def/while/for/if/elif/else/try/except block body
- indent=2: doubly nested
- Lines directly after "while:", "for:", "if:", "def:", "elif:", "else:", "try:", "except:" must be indented +1
- Lines at the same indent or less mean the body ended
- The dataIndent value on each block suggests its default indent level

RESPONSE FORMAT:
First, write the COMPLETE PROGRAM:
PROGRAM:
  0: indent=0 | some_code        [LOCKED]
  1: indent=0 | while condition: [UNUSED_INDEX 2]
  2: indent=1 |     body_line    [UNUSED_INDEX 0]

Then, list the placements:
PLACEMENTS:
  UNUSED_INDEX -> POSITION @ INDENT_LEVEL

To SKIP a distractor (block that should NOT be used):
  UNUSED_INDEX -> SKIP

CRITICAL RULES:
- POSITION = 0-based line number in your COMPLETE program.
- Each POSITION must be unique.
- You MUST explicitly mark distractors as SKIP.
- Do NOT place blocks that would create duplicate or wrong code.
- Double-check Python syntax and logical flow.
- Verify your solution matches the expected output from the examples.
${historyContext}`
      },
      {
        role: 'user',
        content: `Write the complete correct program, then list the placements for the unused blocks. Remember: some blocks may be DISTRACTORS that should be SKIPPED.`
      }
    ];
  }

  function buildIndentFixPrompt(ctx, attemptHistory) {
    const usedDisplay = ctx.usedBlocks.map((b, i) => {
      const prefix = '    '.repeat(b.indent);
      return `  [${i}] ${b.isLocked ? 'LOCKED' : 'MOVEABLE'} current_indent=${b.indent} dataIndent=${b.dataIndent || 0} | ${prefix}${b.text}`;
    }).join('\n');

    let feedbackInfo = '';
    if (ctx.errorSummary) feedbackInfo += `\nError: ${ctx.errorSummary}`;
    if (ctx.feedbackText) feedbackInfo += `\nFeedback: ${ctx.feedbackText}`;
    if (ctx.testResults.length > 0) {
      feedbackInfo += '\nTest Results:';
      for (const t of ctx.testResults) feedbackInfo += '\n  ' + JSON.stringify(t);
    }

    let instrContext = '';
    if (ctx.instructions) instrContext += `\nInstructions: ${ctx.instructions.substring(0, 500)}`;
    if (ctx.exampleDetails) instrContext += `\nExample: ${ctx.exampleDetails.substring(0, 500)}`;

    return [
      {
        role: 'system',
        content: `You are fixing INDENTATION in a zyBooks Parsons problem. The blocks are in the correct ORDER but their indentation is wrong.
${instrContext}

Current code in the solution area:
${usedDisplay}
${feedbackInfo}

For each MOVEABLE block that needs a different indent level, output:
INDENT_FIX: "block text" -> INDENT_LEVEL

Only output lines that need to CHANGE. Do not output locked blocks.
indent=0 = no indentation (top level), indent=1 = inside a block body (def, if, for, while, etc.), indent=2 = doubly nested, etc.

RULES:
- Lines after "def ...:, while ...:, for ...:, if ...:, elif ...:, else:, try:, except ...:" must be indented +1
- Return statements inside a function body should be indent=1
- Variable assignments inside a function body should be indent=1`
      },
      { role: 'user', content: 'Fix the indentation for the blocks listed above.' }
    ];
  }

  // ────────────────────────────────────────────────────────────
  //  AI RESPONSE PARSERS
  // ────────────────────────────────────────────────────────────

  function parseIndentResponse(response, usedBlocks) {
    const fixes = [];
    for (const line of response.split('\n')) {
      const m = line.match(/"([^"]+)"\s*->\s*(\d+)/);
      if (!m) continue;
      const text = m[1];
      const indent = parseInt(m[2]);
      const block = usedBlocks.find(b => b.text === text || b.text.includes(text) || text.includes(b.text));
      if (block && !block.isLocked) {
        fixes.push({ text: block.text, blockId: block.blockId, indent });
      }
    }
    return fixes;
  }

  function parseParsonsResponse(response, ctx) {
    const moves = [];
    const aiIndentOverrides = {};
    const skippedIndices = new Set();

    // First pass: collect explicit SKIPs
    for (const line of response.split('\n')) {
      const skipMatch = line.match(/(\d+)\s*->\s*SKIP/i);
      if (skipMatch) {
        const unusedIndex = parseInt(skipMatch[1]);
        skippedIndices.add(unusedIndex);
        console.log(`[ZyAgent] Parsons: AI explicitly skipped UNUSED_INDEX ${unusedIndex}`);
      }
    }

    // Second pass: collect placements
    for (const line of response.split('\n')) {
      if (/(\d+)\s*->\s*SKIP/i.test(line)) continue;

      let m = line.match(/(\d+)\s*->\s*(-?\d+)\s*@\s*(\d+)/);
      let indentLevel = 0;
      if (m) {
        indentLevel = parseInt(m[3]);
      } else {
        m = line.match(/(\d+)\s*->\s*(-?\d+)/);
      }
      if (!m) continue;

      const unusedIndex = parseInt(m[1]);
      const insertPos = parseInt(m[2]);

      // Don't process if this index was also marked as SKIP (contradictory)
      if (skippedIndices.has(unusedIndex)) continue;

      let matchingBlock = ctx.unusedBlocks.find(b => b.domIndex === unusedIndex);
      if (!matchingBlock) matchingBlock = ctx.unusedBlocks.find(b => parseInt(b.blockId) === unusedIndex);
      if (!matchingBlock) continue;

      if (indentLevel === 0 && ctx.indentGuideCount > 0 && !line.includes('@')) {
        // Try to infer indent from the block's data-indent attribute
        if (matchingBlock.dataIndent > 0) {
          indentLevel = matchingBlock.dataIndent;
        } else {
          for (let k = insertPos - 1; k >= 0; k--) {
            const blk = ctx.usedBlocks[k];
            if (!blk) break;
            if (blk.text.trimEnd().endsWith(':')) { indentLevel = blk.indent + 1; break; }
            if (blk.indent > 0 && k === insertPos - 1) { indentLevel = blk.indent; break; }
          }
        }
      }

      aiIndentOverrides[matchingBlock.text] = indentLevel;
      moves.push({
        unusedIndex: matchingBlock.domIndex, blockId: matchingBlock.blockId, text: matchingBlock.text,
        insertPos, indentLevel
      });
    }

    // Extract indent from PROGRAM section
    for (const pLine of response.split('\n')) {
      const pm = pLine.match(/indent\s*=\s*(\d+)\s*\|\s*(.+?)(?:\s*\[(?:UNUSED|LOCKED))/i);
      if (pm) {
        const indent = parseInt(pm[1]);
        const codeText = pm[2].trim();
        const block = ctx.unusedBlocks.find(b => b.text.trim() === codeText || codeText.includes(b.text.trim()));
        if (block) {
          aiIndentOverrides[block.text] = indent;
          const existing = moves.find(m => m.text === block.text);
          if (existing) existing.indentLevel = indent;
        }
      }
    }

    return {
      moves,
      aiIndentOverrides: Object.keys(aiIndentOverrides).length > 0 ? aiIndentOverrides : null,
      skippedIndices
    };
  }

  // ────────────────────────────────────────────────────────────
  //  MAIN HANDLER
  // ────────────────────────────────────────────────────────────

  Z._challenge_handleParsons = async function (activity, settings) {
    const el = activity.element;

    if (Z.checkCompletion(el)) {
      Z.sendProgress(0, 0, `Challenge "${activity.title}" already completed, skipping`, 'info');
      return;
    }

    Z.sendProgress(0, 1, `Parsons challenge "${activity.title}"`);

    const maxAttempts = 6;
    let attemptHistory = [];

    // ─── Helper: Scrape the FULL page context for the AI ───
    function scrapeFullParsonsContext() {
      const ctx = {
        instructions: '',
        unusedBlocks: [],
        usedBlocks: [],
        hasDistractors: false,
        distractorHint: '',
        testResults: [],
        feedbackText: '',
        errorSummary: '',
        indentGuideCount: 0,
        expectedBlockCount: null,  // How many blocks are expected (from feedback)
        exampleDetails: '',         // Content from expandable <details> sections
        howToUseContent: '',        // Content from "How to use this tool" section
        lockedBlocksCode: ''        // Existing locked code for full context
      };

      // ── 1. Read main instructions ──
      const instrEl = el.querySelector('.reorderable-lists-instructions');
      ctx.instructions = instrEl ? instrEl.innerText.trim() : '';

      // ── 2. Expand and read <details> sections (examples, hints) ──
      const detailsEls = el.querySelectorAll('details');
      for (const details of detailsEls) {
        // Force open so we can read content
        if (!details.open) details.open = true;
        const detailText = details.innerText.trim();
        if (detailText) {
          ctx.exampleDetails += '\n' + detailText;
        }
      }

      // ── 3. Expand and read "How to use this tool" section ──
      const expandableSections = el.querySelectorAll('.zb-simple-expandable');
      for (const section of expandableSections) {
        const toggleBtn = section.querySelector('.toggle-button');
        if (toggleBtn && toggleBtn.getAttribute('aria-expanded') === 'false') {
          toggleBtn.click(); // Expand it
        }
        const content = section.querySelector('.expandable-content');
        if (content && content.innerText.trim()) {
          ctx.howToUseContent += content.innerText.trim() + '\n';
        }
        // Also read the title for context
        const title = section.querySelector('.title');
        if (title) {
          ctx.howToUseContent = (title.innerText.trim() + ': ' + ctx.howToUseContent).trim();
        }
      }

      // ── 4. Detect distractors (blocks that should NOT be used) ──
      const fullText = el.innerText || '';
      // Broad pattern matching for distractor hints
      if (/not\s+all\s+(lines|blocks|code)/i.test(fullText) ||
          /not.+needed|not.+be\s+used|extra.+block|unnecessary|distractor/i.test(fullText) ||
          /should\s+not\s+be\s+used/i.test(fullText) ||
          /will\s+not\s+(end\s+up\s+)?us(e|ing)\s+all/i.test(fullText) ||
          /won't\s+use\s+all/i.test(fullText) ||
          /some.+blocks?.+(?:are|is)\s+(?:not|un)/i.test(fullText)) {
        ctx.hasDistractors = true;
        ctx.distractorHint = 'WARNING: NOT ALL blocks should be used. Some are DISTRACTORS. You MUST identify which blocks are incorrect/unnecessary and leave them in the Unused list. Using all blocks will produce a WRONG answer.';
      }
      const distractorEl = el.querySelector('.distractor-info, .parsons-hint');
      if (distractorEl) {
        ctx.distractorHint = 'DISTRACTOR INFO: ' + distractorEl.innerText.trim();
        ctx.hasDistractors = true;
      }

      // Also check for expected block count from prior feedback
      const blockCountMatch = fullText.match(/added\s+(\d+)\s+blocks?,\s+but\s+(\d+)\s+(?:were|was)\s+expected/i);
      if (blockCountMatch) {
        ctx.expectedBlockCount = parseInt(blockCountMatch[2]);
        ctx.hasDistractors = true;
        ctx.distractorHint = `WARNING: The solution expects exactly ${ctx.expectedBlockCount} blocks. You placed ${blockCountMatch[1]} last time, which was too many. Some blocks are DISTRACTORS — do NOT use them.`;
      }

      // ── 5. Read unused blocks with their data-indent attribute ──
      const unusedList = el.querySelector('.sortable[data-list-name="unused"]');
      if (unusedList) {
        const blocks = unusedList.querySelectorAll('.block.moveable:not([aria-disabled="true"])');
        ctx.unusedBlocks = Array.from(blocks).map((b, i) => ({
          domIndex: i,
          blockId: b.getAttribute('data-block-id'),
          text: b.textContent.trim(),
          dataIndent: parseInt(b.getAttribute('data-indent')) || 0,
          isDraggable: b.getAttribute('draggable') !== 'false',
          element: b
        }));
      }

      // ── 6. Read used blocks (locked code provides critical context) ──
      const usedList = el.querySelector('.sortable[data-list-name="used"]');
      if (usedList) {
        const blocks = usedList.querySelectorAll('.block');
        ctx.usedBlocks = Array.from(blocks).map((b, i) => ({
          index: i,
          blockId: b.getAttribute('data-block-id'),
          text: b.textContent.trim(),
          isLocked: b.getAttribute('aria-disabled') === 'true',
          indent: Math.round((parseInt(b.style.marginLeft) || 0) / INDENT_PX_PER_LEVEL),
          dataIndent: parseInt(b.getAttribute('data-indent')) || 0
        }));

        // Collect locked blocks as code context
        ctx.lockedBlocksCode = ctx.usedBlocks
          .filter(b => b.isLocked)
          .map(b => '    '.repeat(b.indent) + b.text)
          .join('\n');
      }

      // ── 7. Indent guides ──
      const indentGuide = el.querySelector('.editor-indents');
      if (indentGuide) {
        ctx.indentGuideCount = indentGuide.querySelectorAll('div').length;
      }

      // ── 8. Test results / feedback ──
      const codeExplanation = el.querySelector('.code-explanation');
      if (codeExplanation) {
        const testResults = codeExplanation.querySelectorAll('.test-result');
        for (const test of testResults) {
          const testInfo = {};
          const header = test.querySelector('.test-header');
          if (header) testInfo.header = header.innerText.trim();
          const errorOut = test.querySelector('.error-output');
          if (errorOut && errorOut.innerText.trim()) testInfo.error = errorOut.innerText.trim();
          const rows = test.querySelectorAll('.test-result-row');
          for (const row of rows) {
            const label = row.querySelector('.result-row-description');
            const value = row.querySelector('.programming-code-output');
            if (label && value) {
              testInfo[label.innerText.trim().replace(/[:\s]+$/, '')] = value.textContent.trim();
            }
          }
          if (Object.keys(testInfo).length > 0) ctx.testResults.push(testInfo);
        }
        const summaryEl = codeExplanation.querySelector('.mb-6[role="alert"], .mb-6, [role="alert"]');
        if (summaryEl) ctx.errorSummary = summaryEl.innerText.trim();
      }

      const liveRegion = el.querySelector('[aria-live="polite"]');
      if (liveRegion && liveRegion.innerText.trim()) {
        ctx.feedbackText = liveRegion.innerText.trim().substring(0, 800);
      }

      // ── 9. Detect similar/confusing blocks (potential distractors) ──
      if (ctx.unusedBlocks.length > 0) {
        const allBlockTexts = [...ctx.unusedBlocks.map(b => b.text), ...ctx.usedBlocks.filter(b => !b.isLocked).map(b => b.text)];
        const duplicateGroups = [];
        for (let i = 0; i < allBlockTexts.length; i++) {
          for (let j = i + 1; j < allBlockTexts.length; j++) {
            // Check for blocks that are very similar (same function name, similar structure)
            const a = allBlockTexts[i].replace(/\s+/g, ' ');
            const b = allBlockTexts[j].replace(/\s+/g, ' ');
            if (a.split('(')[0] === b.split('(')[0] && a !== b) {
              duplicateGroups.push(`"${a}" vs "${b}"`);
            }
          }
        }
        if (duplicateGroups.length > 0) {
          ctx.hasDistractors = true;
          const dupNote = `\n⚠️ SIMILAR BLOCKS DETECTED (one is likely a distractor): ${duplicateGroups.join('; ')}`;
          ctx.distractorHint = (ctx.distractorHint || '') + dupNote;
        }
      }

      return ctx;
    }

    // ─── Container selector helper ───
    function getContainerSel() {
      const resourceId = el.getAttribute('content_resource_id')
        || el.closest('[content_resource_id]')?.getAttribute('content_resource_id')
        || el.querySelector('[content_resource_id]')?.getAttribute('content_resource_id');
      return resourceId ? `[content_resource_id="${resourceId}"]` : '.two-reorderable-lists';
    }

    for (let attempt = 0; attempt < maxAttempts && !Z.shouldStop; attempt++) {
      if (Z.checkCompletion(el)) {
        Z.sendProgress(1, 1, `Challenge "${activity.title}" completed!`, 'success');
        return;
      }

      const ctx = scrapeFullParsonsContext();

      if (ctx.unusedBlocks.length === 0 && ctx.usedBlocks.length === 0) {
        Z.sendProgress(0, 1, 'Cannot find any Parsons blocks', 'error');
        return;
      }

      if (ctx.unusedBlocks.length === 0) {
        // All blocks already placed — only indentation might be wrong
        Z.sendProgress(0, 1, 'All blocks placed — verifying order & indentation', 'info');

        if (attempt > 0 && (ctx.testResults.length > 0 || ctx.feedbackText || ctx.errorSummary)) {
          Z.sendProgress(0, 1, 'Using AI to analyze feedback and fix indentation…');
          const indentFixMessages = buildIndentFixPrompt(ctx, attemptHistory);
          const indentResponse = await Z.callAI(settings, indentFixMessages);
          console.log('[ZyAgent] Parsons indent-fix AI response:', indentResponse);
          const indentMoves = parseIndentResponse(indentResponse, ctx.usedBlocks);
          if (indentMoves.length > 0) {
            for (const fix of indentMoves) {
              await adjustBlockIndentation(el, fix.blockId, fix.indent, fix.text);
              await Z.sleep(400);
            }
          }
        } else {
          const anyChanged = await fixIndentationInUsedList(el, ctx.usedBlocks.map(b => ({
            ...b, indent: (b.indent * INDENT_PX_PER_LEVEL) + 'px'
          })));
          if (!anyChanged && attempt > 0) {
            Z.sendProgress(0, 1, 'Indentation adjustment not taking effect', 'error');
            break;
          }
        }

        await Z.sleep(300);

        // Arm XHR interception with current indent state before Check
        {
          const indentOnlyDesired = {};
          const usedBlocks = Array.from(el.querySelector('.sortable[data-list-name="used"]').querySelectorAll('.block'));
          for (const b of usedBlocks) {
            if (b.getAttribute('aria-disabled') === 'true') continue;
            const domIndent = Math.round((parseInt(b.style.marginLeft) || 0) / INDENT_PX_PER_LEVEL);
            indentOnlyDesired[b.textContent.trim()] = domIndent;
          }
          try {
            const containerSel = getContainerSel();
            await Z.sortableForceEmberIndent(containerSel, indentOnlyDesired);
            await Z.sortableSetDesiredIndents(indentOnlyDesired);
            console.log('[ZyAgent] Parsons: Indent-only path — armed XHR interception:', JSON.stringify(indentOnlyDesired));
          } catch (err) {
            console.warn('[ZyAgent] Parsons: Failed to arm XHR interception:', err.message);
          }
        }

        const checkBtn = el.querySelector('button.check-button:not([disabled])');
        if (checkBtn) { checkBtn.click(); await Z.sleep(3000); }

        // Capture XHR log for diagnostics
        try {
          const xhrLog = await Z.getXHRLog();
          if (xhrLog && xhrLog.log && xhrLog.log.length > 0) {
            console.log('[ZyAgent] Parsons: Indent-only XHR log (' + xhrLog.log.length + ' requests):');
            for (const entry of xhrLog.log) {
              console.log('[ZyAgent] Parsons: XHR', entry.method, entry.url, '| body:', entry.bodyPreview?.substring(0, 500));
            }
          }
        } catch (err) { /* non-fatal */ }

        if (Z.checkCompletion(el)) {
          Z.sendProgress(1, 1, `Challenge "${activity.title}" completed!`, 'success');
          return;
        }
        continue;
      }

      Z.sendProgress(0, 1, `Attempt ${attempt + 1}/${maxAttempts}: ${ctx.unusedBlocks.length} block(s) to place`);

      const messages = buildParsonsPrompt(ctx, attemptHistory, attempt);
      const response = await Z.callAI(settings, messages);
      console.log('[ZyAgent] Parsons AI response:', response);

      attemptHistory.push({
        attempt: attempt + 1,
        response: response.substring(0, 1500),
        feedback: ctx.errorSummary || ctx.feedbackText || '',
        testResults: ctx.testResults
      });

      const { moves, aiIndentOverrides, skippedIndices } = parseParsonsResponse(response, ctx);

      if (moves.length === 0) {
        Z.sendProgress(0, 1, `Attempt ${attempt + 1}: AI returned no valid moves`, 'warn');
        continue;
      }

      // Log skipped blocks
      const skippedBlockTexts = [];
      for (const idx of skippedIndices) {
        const block = ctx.unusedBlocks.find(b => b.domIndex === idx);
        if (block) {
          skippedBlockTexts.push(block.text.substring(0, 50));
          console.log(`[ZyAgent] Parsons: Skipping distractor block [${idx}]: "${block.text.substring(0, 60)}"`);
        }
      }

      // Track which blocks are intentionally skipped for attempt history
      attemptHistory[attemptHistory.length - 1].skippedBlocks = skippedBlockTexts;
      attemptHistory[attemptHistory.length - 1].usedBlockCount = moves.length;

      // Validate: if distractors are expected, warn if AI is trying to use ALL blocks
      if (ctx.hasDistractors && skippedIndices.size === 0 && moves.length === ctx.unusedBlocks.length) {
        console.warn('[ZyAgent] Parsons: Distractors expected but AI wants to use ALL blocks — this is likely wrong');
        // On second+ attempts, if we know the expected count, force a re-prompt
        if (ctx.expectedBlockCount !== null && attempt < maxAttempts - 1) {
          const totalMoveable = ctx.usedBlocks.filter(b => !b.isLocked).length + moves.length;
          if (totalMoveable > ctx.expectedBlockCount) {
            console.warn(`[ZyAgent] Parsons: Would place ${totalMoveable} blocks but only ${ctx.expectedBlockCount} expected — skipping this attempt`);
            Z.sendProgress(0, 1, `AI tried to use all blocks but ${ctx.expectedBlockCount} expected — retrying…`, 'warn');
            continue;
          }
        }
      }

      // Do NOT force-include blocks the AI explicitly skipped.
      // Only warn about blocks that the AI neither placed NOR skipped (possibly missed).
      for (const unused of ctx.unusedBlocks) {
        const isPlaced = moves.find(m => m.text === unused.text);
        const isSkipped = skippedIndices.has(unused.domIndex);
        if (!isPlaced && !isSkipped) {
          // The AI didn't mention this block at all — treat as implicitly skipped
          // if distractors are expected, otherwise warn
          if (ctx.hasDistractors) {
            console.log(`[ZyAgent] Parsons: Block [${unused.domIndex}] "${unused.text.substring(0, 40)}" not mentioned by AI — treating as implicit distractor skip`);
          } else {
            console.warn(`[ZyAgent] Parsons: AI missed block [${unused.domIndex}] "${unused.text.substring(0, 40)}" — appending at end (no distractors detected)`);
            const lastPos = ctx.usedBlocks.length + moves.length;
            let inferredIndent = unused.dataIndent || 0;
            if (inferredIndent === 0 && ctx.indentGuideCount > 0) {
              const allTexts = [...ctx.usedBlocks.map(b => b.text), ...moves.map(m => m.text)];
              for (const t of allTexts) {
                if (t.trimEnd().endsWith(':')) { inferredIndent = 1; break; }
              }
            }
            moves.push({
              unusedIndex: unused.domIndex, blockId: unused.blockId, text: unused.text,
              insertPos: lastPos, indentLevel: inferredIndent
            });
          }
        }
      }

      moves.sort((a, b) => a.insertPos - b.insertPos);
      console.log('[ZyAgent] Parsons: Planned moves:', moves.map(m =>
        `[unused ${m.unusedIndex}] "${m.text.substring(0, 40)}" → pos ${m.insertPos} @ indent ${m.indentLevel}`
      ));

      // ════ PHASE 1: Drag all unused blocks into used ════
      let movesMade = 0;
      for (let mi = 0; mi < moves.length; mi++) {
        const move = moves[mi];
        if (Z.shouldStop) break;

        const currentUnusedList = el.querySelector('.sortable[data-list-name="unused"]');
        const currentUnusedBlocks = Array.from(
          currentUnusedList.querySelectorAll('.block.moveable:not([aria-disabled="true"])')
        );
        let sourceBlock = currentUnusedBlocks.find(b => b.textContent.trim() === move.text);
        if (!sourceBlock) sourceBlock = currentUnusedBlocks[move.unusedIndex] || null;
        if (!sourceBlock) {
          console.log('[ZyAgent] Parsons: Block "' + move.text.substring(0, 40) + '" no longer in unused — skipping');
          continue;
        }

        Z.sendProgress(0, 1, `Moving block ${mi + 1}/${moves.length}: "${move.text.substring(0, 50)}"`);
        const success = await moveBlockToUsedList(el, sourceBlock, move.insertPos, move.blockId, move.indentLevel || 0);
        if (success) {
          movesMade++;
          console.log('[ZyAgent] Parsons: Moved block', mi, `"${move.text.substring(0, 40)}" with indent=${move.indentLevel}`);

          if (move.indentLevel > 0) {
            await Z.sleep(300);
            const usedList = el.querySelector('.sortable[data-list-name="used"]');
            if (usedList) {
              let placedBlock = null;
              for (const b of usedList.querySelectorAll('.block.moveable')) {
                if (b.textContent.trim() === move.text) { placedBlock = b; break; }
              }
              if (placedBlock) {
                const actualIndent = Math.round((parseInt(placedBlock.style.marginLeft) || 0) / INDENT_PX_PER_LEVEL);
                if (actualIndent !== move.indentLevel) {
                  console.log(`[ZyAgent] Parsons: Block "${move.text.substring(0, 30)}" placed at indent=${actualIndent}, need ${move.indentLevel} — fixing immediately`);
                  await adjustBlockIndentation(el, move.blockId, move.indentLevel, move.text);
                }
              }
            }
          }
        } else {
          console.warn('[ZyAgent] Parsons: Failed to move block', mi, `"${move.text.substring(0, 40)}"`);
        }
        await Z.sleep(400);
      }

      if (movesMade === 0) {
        Z.sendProgress(0, 1, `Attempt ${attempt + 1}: Could not move any blocks`, 'warn');
        if (attempt < maxAttempts - 1) { await resetParsonsBlocks(el); }
        continue;
      }

      Z.sendProgress(0, 1, `Moved ${movesMade}/${moves.length} blocks`);
      await Z.sleep(300);

      const finalUnusedBlocks = Array.from(
        el.querySelector('.sortable[data-list-name="unused"]').querySelectorAll('.block.moveable:not([aria-disabled="true"])')
      );
      if (finalUnusedBlocks.length > 0) {
        // Check if the remaining unused blocks are intentionally skipped distractors
        const remainingTexts = Array.from(finalUnusedBlocks).map(b => b.textContent.trim());
        const allIntentionallySkipped = remainingTexts.every(text => {
          // Check if AI explicitly skipped this block or if distractors are expected
          const unusedBlock = ctx.unusedBlocks.find(b => b.text === text);
          if (!unusedBlock) return false;
          return skippedIndices.has(unusedBlock.domIndex) ||
                 (ctx.hasDistractors && !moves.find(m => m.text === text));
        });

        if (allIntentionallySkipped) {
          console.log(`[ZyAgent] Parsons: ${finalUnusedBlocks.length} block(s) remain unused — these are intentional distractor skips`);
        } else if (attempt < maxAttempts - 1) {
          // Some blocks that should have been moved weren't — reset and retry
          const failedBlocks = remainingTexts.filter(text => {
            const unusedBlock = ctx.unusedBlocks.find(b => b.text === text);
            return unusedBlock && moves.find(m => m.text === text);
          });
          if (failedBlocks.length > 0) {
            Z.sendProgress(0, 1, `${failedBlocks.length} block(s) failed to move — resetting…`, 'warn');
            await resetParsonsBlocks(el);
            await Z.sleep(1000);
            continue;
          }
        }
      }

      // ════ PHASE 2: Reorder blocks within used list ════
      Z.sendProgress(0, 1, 'Reordering blocks…');
      const currentUsedBlocks = Array.from(
        el.querySelector('.sortable[data-list-name="used"]').querySelectorAll('.block')
      );
      const totalSlots = currentUsedBlocks.length;
      const finalOrder = new Array(totalSlots).fill(null);

      for (let i = 0; i < currentUsedBlocks.length; i++) {
        if (currentUsedBlocks[i].getAttribute('aria-disabled') === 'true') {
          finalOrder[i] = { text: currentUsedBlocks[i].textContent.trim(), isLocked: true };
        }
      }
      for (const move of moves) {
        const pos = move.insertPos;
        if (pos >= 0 && pos < finalOrder.length && finalOrder[pos] === null) {
          finalOrder[pos] = { text: move.text, isLocked: false };
        } else {
          let placed = false;
          for (let k = Math.max(0, pos); k < finalOrder.length; k++) {
            if (finalOrder[k] === null) { finalOrder[k] = { text: move.text, isLocked: false }; placed = true; break; }
          }
          if (!placed) {
            for (let k = Math.min(pos, finalOrder.length - 1); k >= 0; k--) {
              if (finalOrder[k] === null) { finalOrder[k] = { text: move.text, isLocked: false }; placed = true; break; }
            }
          }
        }
      }
      const placedTexts = new Set(finalOrder.filter(x => x).map(x => x.text));
      const unmatched = [];
      for (const b of currentUsedBlocks) {
        const txt = b.textContent.trim();
        if (!placedTexts.has(txt) && b.getAttribute('aria-disabled') !== 'true') unmatched.push(txt);
      }
      for (let i = 0; i < finalOrder.length; i++) {
        if (finalOrder[i] === null && unmatched.length > 0) {
          finalOrder[i] = { text: unmatched.shift(), isLocked: false };
        }
      }

      const currentTexts = currentUsedBlocks.map(b => b.textContent.trim());
      const desiredTexts = finalOrder.filter(x => x).map(x => x.text);
      if (JSON.stringify(currentTexts) !== JSON.stringify(desiredTexts)) {
        const containerSel = getContainerSel();
        try {
          const result = await Z.sortableReorderAll(containerSel, finalOrder.filter(x => x));
          console.log('[ZyAgent] Parsons: Bulk reorder result:', result.method);
        } catch (err) {
          console.warn('[ZyAgent] Parsons: Bulk reorder error:', err.message);
        }
        await Z.sleep(400);
      }

      // ════ PHASE 3: Fix indentation ════
      Z.sendProgress(0, 1, 'Setting indentation…');
      const updatedUsedBlocks = Array.from(el.querySelector('.sortable[data-list-name="used"]').querySelectorAll('.block'));
      const updatedUsedInfo = updatedUsedBlocks.map((b, i) => ({
        index: i,
        blockId: b.getAttribute('data-block-id'),
        text: b.textContent.trim(),
        disabled: b.getAttribute('aria-disabled') === 'true',
        indent: b.style.marginLeft || '0px',
        isLocked: b.getAttribute('aria-disabled') === 'true'
      }));
      await fixIndentationInUsedList(el, updatedUsedInfo, aiIndentOverrides);

      // Keyboard-based indent fallback
      const containerSel = getContainerSel();
      for (const block of updatedUsedBlocks) {
        if (block.getAttribute('aria-disabled') === 'true') continue;
        const text = block.textContent.trim();
        const desiredIndent = aiIndentOverrides ? aiIndentOverrides[text] : undefined;
        if (desiredIndent === undefined) continue;
        const currentIndent = Math.round((parseInt(block.style.marginLeft) || 0) / INDENT_PX_PER_LEVEL);
        if (currentIndent !== desiredIndent) {
          console.log(`[ZyAgent] Parsons: Keyboard indent fallback "${text.substring(0, 30)}" ${currentIndent}→${desiredIndent}`);
          try {
            await Z.sortableKeyboardIndent(containerSel, text, block.getAttribute('data-block-id'), desiredIndent);
            await Z.sleep(300);
          } catch (err) {
            console.warn('[ZyAgent] Parsons: Keyboard indent error:', err.message);
          }
        }
      }

      // Log final state
      const finalUsedBlocks = Array.from(el.querySelector('.sortable[data-list-name="used"]').querySelectorAll('.block'));
      console.log('[ZyAgent] Parsons: Final state:', finalUsedBlocks.map(b => {
        const indent = Math.round((parseInt(b.style.marginLeft) || 0) / INDENT_PX_PER_LEVEL);
        return `${'  '.repeat(indent)}${b.textContent.trim().substring(0, 40)}`;
      }).join('\n  '));

      // ════ FINAL EMBER SYNC + XHR INTERCEPTION ════
      {
        const syncContainerSel = getContainerSel();

        const desiredIndents = {};
        for (const block of finalUsedBlocks) {
          if (block.getAttribute('aria-disabled') === 'true') continue;
          const bText = block.textContent.trim();
          if (aiIndentOverrides && bText in aiIndentOverrides) {
            desiredIndents[bText] = aiIndentOverrides[bText];
          } else {
            desiredIndents[bText] = Math.round((parseInt(block.style.marginLeft) || 0) / INDENT_PX_PER_LEVEL);
          }
        }
        console.log('[ZyAgent] Parsons: Desired indents for submission:', JSON.stringify(desiredIndents));

        try {
          const diag = await Z.sortableEmberDiagnostic(syncContainerSel);
          console.log('[ZyAgent] Parsons: Pre-check Ember diagnostic:', JSON.stringify(diag));
        } catch (err) {
          console.warn('[ZyAgent] Parsons: Ember diagnostic failed:', err.message);
        }

        try {
          const forceResult = await Z.sortableForceEmberIndent(syncContainerSel, desiredIndents);
          console.log('[ZyAgent] Parsons: Force Ember indent results:', JSON.stringify(forceResult));
        } catch (err) {
          console.warn('[ZyAgent] Parsons: Force Ember indent error:', err.message);
        }

        try {
          await Z.sortableSetDesiredIndents(desiredIndents);
          console.log('[ZyAgent] Parsons: XHR interception armed with desired indents');
        } catch (err) {
          console.warn('[ZyAgent] Parsons: Set desired indents failed:', err.message);
        }

        for (const block of finalUsedBlocks) {
          if (block.getAttribute('aria-disabled') === 'true') continue;
          const domIndent = Math.round((parseInt(block.style.marginLeft) || 0) / INDENT_PX_PER_LEVEL);
          if (domIndent > 0) {
            const bText = block.textContent.trim();
            const bId = block.getAttribute('data-block-id');
            try {
              await Z.sortableAdjustIndent(syncContainerSel, bText, bId, domIndent);
              await Z.sleep(200);
            } catch (err) { /* Non-fatal */ }
          }
        }

        try {
          const diag2 = await Z.sortableEmberDiagnostic(syncContainerSel);
          console.log('[ZyAgent] Parsons: Post-sync Ember diagnostic:', JSON.stringify(diag2));
        } catch (err) {
          console.warn('[ZyAgent] Parsons: Ember diagnostic failed:', err.message);
        }
      }

      // ════ CHECK answer ════
      const checkBtn = el.querySelector('button.check-button:not([disabled])');
      if (checkBtn) {
        checkBtn.click();
        Z.sendProgress(0, 1, `Checking attempt ${attempt + 1}…`);
        await Z.sleep(4000);
      }

      // ════ POST-CHECK: Capture XHR log ════
      try {
        const xhrLog = await Z.getXHRLog();
        if (xhrLog && xhrLog.log && xhrLog.log.length > 0) {
          console.log('[ZyAgent] Parsons: XHR log after Check (' + xhrLog.log.length + ' requests):');
          for (const entry of xhrLog.log) {
            console.log('[ZyAgent] Parsons: XHR', entry.method, entry.url, '| bodyLen:', entry.bodyLen, '| armed:', entry.armed);
            if (entry.bodyPreview) {
              console.log('[ZyAgent] Parsons: XHR body:', entry.bodyPreview.substring(0, 500));
            }
          }
        } else {
          console.log('[ZyAgent] Parsons: No XHR requests captured after Check');
        }
      } catch (err) {
        console.warn('[ZyAgent] Parsons: XHR log retrieval failed:', err.message);
      }

      if (Z.checkCompletion(el)) {
        Z.sendProgress(1, 1, `Challenge "${activity.title}" completed!`, 'success');
        return;
      }

      // ━━━ POST-CHECK: Scrape feedback ━━━
      const postCtx = scrapeFullParsonsContext();
      const allFeedback = (postCtx.errorSummary + ' ' + postCtx.feedbackText).toLowerCase();

      if (allFeedback.includes('indentationerror') || allFeedback.includes('indented block') ||
          allFeedback.includes('unexpected indent')) {
        console.log('[ZyAgent] Parsons: IndentationError — trying quick indent fix');
        Z.sendProgress(0, 1, 'IndentationError — fixing indentation…');

        const indentFixMessages = buildIndentFixPrompt(postCtx, attemptHistory);
        const indentResponse = await Z.callAI(settings, indentFixMessages);
        const indentMoves = parseIndentResponse(indentResponse, postCtx.usedBlocks);
        for (const fix of indentMoves) {
          await adjustBlockIndentation(el, fix.blockId, fix.indent, fix.text);
          await Z.sleep(400);
        }
        for (const fix of indentMoves) {
          try {
            await Z.sortableKeyboardIndent(containerSel, fix.text, fix.blockId, fix.indent);
            await Z.sleep(300);
          } catch (err) { /* ignore */ }
        }

        const retryCheckBtn = el.querySelector('button.check-button:not([disabled])');
        if (retryCheckBtn) { retryCheckBtn.click(); await Z.sleep(4000); }
        if (Z.checkCompletion(el)) {
          Z.sendProgress(1, 1, `Challenge "${activity.title}" completed after indent fix!`, 'success');
          return;
        }
      }

      // Screenshot for visual context
      try {
        const screenshot = await Z.captureScreenshot();
        if (screenshot) {
          const analysis = await Z.analyzeScreenshot(settings,
            'You are analyzing a zyBooks Parsons problem. Describe: 1) What blocks are in the solution area and their order? 2) What error/feedback is visible? 3) What does the error suggest?',
            'What is the current state and what went wrong?'
          );
          if (analysis && attemptHistory.length > 0) {
            attemptHistory[attemptHistory.length - 1].visualAnalysis = analysis;
          }
        }
      } catch (err) {
        console.log('[ZyAgent] Screenshot skipped:', err.message);
      }

      if (attempt < maxAttempts - 1) {
        Z.sendProgress(0, 1, `Resetting for attempt ${attempt + 2}…`);
        await resetParsonsBlocks(el);
        await Z.sleep(1000);
      }
    }

    if (!Z.checkCompletion(el)) {
      Z.sendProgress(0, 1, `Parsons challenge "${activity.title}" failed after ${maxAttempts} attempts`, 'error');
    }
  };

})();
