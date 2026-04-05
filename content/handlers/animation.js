// ─── ZyBook Agent — Animation Handler ───
// Handles animation-player-content-resource activities (play-through animations).

(function () {
  'use strict';

  const Z = window.ZyAgent;

  Z.handleAnimation = async function (activity, settings) {
    const el = activity.element;

    // Skip if already completed
    if (Z.checkCompletion(el)) {
      Z.sendProgress(0, 0, `Animation "${activity.title}" already completed, skipping`, 'info');
      return;
    }

    // Step 1: Enable 2x speed checkbox
    const speedCheckboxes = el.querySelectorAll(
      '.speed-control .zb-checkbox-input, ' +
      '.speed-control input[type="checkbox"], ' +
      '.animation-speed input[type="checkbox"], ' +
      'input.speed-up'
    );
    for (const checkbox of speedCheckboxes) {
      if (!checkbox.checked) {
        checkbox.click();
        await Z.sleep(300);
        Z.sendProgress(0, 0, 'Enabled 2x speed', 'info');
      }
    }
    await Z.sleep(300);

    // Step 2: Click Start button
    const startBtn = el.querySelector(
      'button.start-button:not([disabled]), ' +
      'button.start-graphic-button:not([disabled]), ' +
      'button.zyante-progression-start-button:not([disabled])'
    );
    if (startBtn) {
      startBtn.click();
      Z.sendProgress(0, 0, 'Clicked Start', 'info');
      await Z.sleep(1500);
    }

    // Step 3: Click Play whenever it appears, detect completion via chevron.
    // zyBooks animations show a Play button between steps. After the last step,
    // the title-bar chevron changes from grey/outline to orange/check.
    const maxWaitTime = 120000; // 2 min hard timeout
    const startTime = Date.now();
    let noButtonCount = 0;

    while (Date.now() - startTime < maxWaitTime && !Z.shouldStop) {
      // Check completion via the actual zyBooks chevron
      if (Z.checkCompletion(el)) {
        Z.sendProgress(0, 0, `Animation "${activity.title}" completed!`, 'success');
        return;
      }

      // Look for Play button (expanded selectors)
      const playBtn = el.querySelector(
        'button[aria-label="Play"]:not([disabled]), ' +
        'button[aria-label="play"]:not([disabled]), ' +
        '.animation-controls .play-button:not([disabled]), ' +
        'button.play-button:not([disabled]), ' +
        '.play-btn:not([disabled]), ' +
        'button.zb-button.play:not([disabled])'
      );

      // Look for Start button (some animations re-show start)
      const remainingStart = el.querySelector(
        'button.start-button:not([disabled]), ' +
        'button.start-graphic-button:not([disabled])'
      );

      // Look for "Next" / step-forward buttons too
      const nextBtn = el.querySelector(
        'button[aria-label="Next"]:not([disabled]), ' +
        'button.step-button:not([disabled]), ' +
        'button.next-button:not([disabled])'
      );

      if (playBtn && !playBtn.disabled) {
        playBtn.click();
        noButtonCount = 0;
        await Z.sleep(1000);
      } else if (remainingStart) {
        remainingStart.click();
        noButtonCount = 0;
        await Z.sleep(1500);
      } else if (nextBtn) {
        nextBtn.click();
        noButtonCount = 0;
        await Z.sleep(1000);
      } else {
        noButtonCount++;
        // After 15s of no buttons, bail out
        if (noButtonCount > 15) {
          if (Z.checkCompletion(el)) {
            Z.sendProgress(0, 0, `Animation "${activity.title}" completed!`, 'success');
          } else {
            Z.sendProgress(0, 0, `Animation "${activity.title}" timed out waiting for buttons`, 'warn');
          }
          return;
        }
        await Z.sleep(1000);
      }
    }

    // Final check
    if (Z.checkCompletion(el)) {
      Z.sendProgress(0, 0, `Animation "${activity.title}" completed!`, 'success');
    } else {
      Z.sendProgress(0, 0, `Animation "${activity.title}" reached max wait time`, 'warn');
    }
  };

})();
