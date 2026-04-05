// ─── ZyBook Agent — Matching / Drag-and-Drop Handler ───
// Handles matching-style exercises where you drag items to targets.
// Strategy: Read all labels, ask AI to match them, simulate drag events.

(function () {
  'use strict';

  const Z = window.ZyAgent;

  Z.handleMatching = async function (activity, settings) {
    const el = activity.element;

    // Gather draggable items
    const draggables = el.querySelectorAll(
      '.draggable-object, .drag-item, .draggable, [draggable="true"]'
    );
    const dropTargets = el.querySelectorAll(
      '.drop-target, .droppable, .bucket, .matching-target'
    );

    if (draggables.length === 0 || dropTargets.length === 0) {
      // Might be a non-drag matching exercise — try checkbox/button approach
      Z.sendProgress(0, 0, 'No drag items found — trying alternative approach');
      return await handleMatchingAlternative(el, settings);
    }

    const itemLabels = Array.from(draggables).map((d, i) => ({
      index: i,
      text: d.innerText.trim() || d.getAttribute('aria-label') || `Item ${i + 1}`
    }));

    const targetLabels = Array.from(dropTargets).map((t, i) => ({
      index: i,
      text: t.innerText.trim() || t.getAttribute('aria-label') || `Target ${i + 1}`
    }));

    const prompt = [
      {
        role: 'system',
        content: `You are an expert Python tutor solving a drag-and-drop matching exercise.
Match each draggable item to its correct drop target.
Return ONLY lines in the format: ITEM_INDEX -> TARGET_INDEX (0-based indices).
Example:
0 -> 2
1 -> 0
2 -> 1`
      },
      {
        role: 'user',
        content: [
          'Draggable items:',
          ...itemLabels.map(i => `  [${i.index}] ${i.text}`),
          '',
          'Drop targets:',
          ...targetLabels.map(t => `  [${t.index}] ${t.text}`),
          '',
          'Provide the matching. Each item should map to exactly one target.'
        ].join('\n')
      }
    ];

    const response = await Z.callAI(settings, prompt);

    // Parse the AI response
    const mappings = response.split('\n')
      .map(line => {
        const match = line.match(/(\d+)\s*->\s*(\d+)/);
        return match ? { from: parseInt(match[1]), to: parseInt(match[2]) } : null;
      })
      .filter(Boolean);

    for (const mapping of mappings) {
      const source = draggables[mapping.from];
      const target = dropTargets[mapping.to];
      if (source && target) {
        Z.simulateDragDrop(source, target);
        await Z.sleep(400);
      }
    }

    await Z.sleep(500);

    // Click submit / check
    const submitBtn = el.querySelector(
      'button.check-button, button.submit-button, button.zb-button.primary'
    );
    if (submitBtn && !submitBtn.disabled) {
      submitBtn.click();
      await Z.sleep(800);
    }
  };

  /* ── Alternative: non-drag matching (button/select based) ── */
  async function handleMatchingAlternative(el, settings) {
    const questionText = el.innerText.substring(0, 1200);
    const buttons = el.querySelectorAll('button:not(:disabled)');
    const selects = el.querySelectorAll('select');

    if (selects.length > 0) {
      const selectInfo = Array.from(selects).map((sel, i) => {
        const options = Array.from(sel.options).map(o => o.text);
        return `Select ${i + 1}: options = [${options.join(', ')}]`;
      });

      const prompt = [
        {
          role: 'system',
          content: `You are an expert Python tutor. Choose the correct option for each dropdown in this zyBooks exercise.
Return ONLY lines like: SELECT_NUMBER: chosen option text
Example:
1: Output
2: Variable`
        },
        {
          role: 'user',
          content: `Exercise text:\n${questionText}\n\n${selectInfo.join('\n')}`
        }
      ];

      const response = await Z.callAI(settings, prompt);
      const choices = response.split('\n')
        .map(line => {
          const m = line.match(/(\d+):\s*(.+)/);
          return m ? { idx: parseInt(m[1]) - 1, value: m[2].trim() } : null;
        })
        .filter(Boolean);

      for (const choice of choices) {
        const sel = selects[choice.idx];
        if (!sel) continue;
        const opt = Array.from(sel.options).find(o =>
          o.text.trim().toLowerCase() === choice.value.toLowerCase()
        );
        if (opt) {
          Z.setNativeValue(sel, opt.value);
          await Z.sleep(300);
        }
      }

      await Z.sleep(300);
      await Z.clickSubmitButton(el);
    }
  }

})();
