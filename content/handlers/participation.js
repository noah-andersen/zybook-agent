// ─── ZyBook Agent — Participation Activity Handler ───
// Handles simple participation / "click to complete" activities.
// Strategy: Click any button (start, reveal, continue, etc.) until completed.

(function () {
  'use strict';

  const Z = window.ZyAgent;

  Z.handleParticipation = async function (activity) {
    const el = activity.element;
    const maxAttempts = 30;
    let lastClickedText = '';
    let sameButtonCount = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (Z.checkCompletion(el)) {
        Z.sendProgress(0, 0, 'Participation activity completed');
        return;
      }

      if (Z.shouldStop) return;

      // Try various clickable elements, in priority order
      const selectors = [
        'button.start-button:not([disabled])',
        'button[aria-label="Play"]:not([disabled])',
        'button.play-button:not([disabled])',
        'button.step-button:not([disabled])',
        'button.reveal-button:not([disabled])',
        'button.next-button:not([disabled])',
        'button.continue-button:not([disabled])',
        'button.zb-button.primary:not([disabled])',
        'input[type="checkbox"]:not(:checked)',
        '.zb-checkbox-input:not(:checked)'
      ];

      let clicked = false;
      for (const sel of selectors) {
        const clickable = el.querySelector(sel);
        if (clickable && clickable.offsetParent !== null) {
          const btnText = clickable.innerText || clickable.type || sel;

          // Detect if we're stuck clicking the same element
          if (btnText === lastClickedText) {
            sameButtonCount++;
            if (sameButtonCount > 3) {
              // Skip this selector, try the next one
              continue;
            }
          } else {
            sameButtonCount = 0;
            lastClickedText = btnText;
          }

          clickable.click();
          clicked = true;
          await Z.sleep(1000);
          break;
        }
      }

      if (!clicked) {
        // Try any non-disabled button as last resort
        const anyBtn = el.querySelector('button:not([disabled])');
        if (anyBtn && anyBtn.offsetParent !== null) {
          anyBtn.click();
          await Z.sleep(800);
        } else {
          // Nothing left to click — wait and check once more
          await Z.sleep(1000);
          if (Z.checkCompletion(el)) {
            Z.sendProgress(0, 0, 'Participation activity completed');
            return;
          }
          break;
        }
      }
    }

    if (!Z.checkCompletion(el)) {
      Z.sendProgress(0, 0, 'Participation activity may not be fully complete', 'warn');
    }
  };

})();
