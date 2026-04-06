// ─── ZyBook Agent — Challenge Shared Helpers ───
// Common utilities used by challenge-coding.js and challenge-parsons.js.
// Split from challenge.js for maintainability.

(function () {
  'use strict';

  const Z = window.ZyAgent;

  // ────────────────────────────────────────────────────────────
  //  DETERMINISTIC OUTPUT POST-PROCESSING
  // ────────────────────────────────────────────────────────────

  /**
   * Analyse the Python source to decide whether the final executed statement
   * produces a trailing newline, and if so make sure our predicted output
   * ends with '\n'.
   *
   * Rules:
   *   • A bare `print()` or `print(x)` with no `end=` always appends '\n'.
   *   • `print(x, end="")` suppresses the trailing newline.
   *   • `print(x, end="something")` — the output ends with "something",
   *     NOT an implicit newline.
   *   • If there is NO print at all, don't touch the response.
   */
  Z._challenge_ensureTrailingNewline = function (text, code) {
    if (!code) return text;

    // Grab only non-blank, non-comment lines
    const lines = code.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));

    if (lines.length === 0) return text;

    // Walk backwards to find the last line that contains a print() call
    let lastPrintLine = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/\bprint\s*\(/.test(lines[i])) {
        lastPrintLine = lines[i];
        break;
      }
    }

    if (!lastPrintLine) return text;          // no print found — leave as-is

    // Does this print explicitly set end=""?
    const endMatch = lastPrintLine.match(/\bend\s*=\s*(["'])(.*?)\1/);
    if (endMatch) {
      const endValue = endMatch[2];
      if (endValue === '') {
        // end="" → no trailing newline; strip any accidental one
        return text.replace(/\n$/, '');
      }
      // end="<something>" — make sure text ends with that something
      if (!text.endsWith(endValue)) {
        return text.replace(/\n$/, '') + endValue;
      }
      return text;
    }

    // Default print() → must end with exactly one '\n'
    if (!text.endsWith('\n')) {
      return text + '\n';
    }
    return text;
  };

  // ────────────────────────────────────────────────────────────
  //  SHARED HELPERS
  // ────────────────────────────────────────────────────────────

  /**
   * Dismiss any visible modal dialogs (e.g., "Level jump" confirmation).
   * Clicks "No" / "Cancel" / close buttons to get rid of them.
   */
  Z._challenge_dismissAnyModal = async function (el) {
    const modals = document.querySelectorAll('.zb-modal-content');
    for (const modal of modals) {
      if (modal.offsetParent === null &&
          !modal.closest('.zb-modal.visible, .zb-modal.show, [style*="display: block"], [style*="display:block"]')) {
        continue;
      }
      // Try "No" or "Cancel" buttons
      const cancelBtn = Array.from(modal.querySelectorAll('button.zb-button')).find(
        btn => /\b(no|cancel|close|dismiss)\b/i.test(btn.innerText)
      );
      if (cancelBtn) {
        cancelBtn.click();
        await Z.sleep(500);
        return true;
      }
      // Try close icon
      const closeIcon = modal.querySelector('.zb-modal-close, .close-button, [aria-label="Close"]');
      if (closeIcon) {
        closeIcon.click();
        await Z.sleep(500);
        return true;
      }
    }
    return false;
  };

  /**
   * Dismiss OR confirm a "Level jump" modal dialog.
   * @param {boolean} confirm — true = click the confirm button, false = cancel
   */
  Z._challenge_dismissOrConfirmJumpModal = async function (confirm) {
    const modal = await Z.waitForCondition(() => {
      const modals = document.querySelectorAll('.zb-modal-content');
      for (const m of modals) {
        if (m.offsetParent !== null || m.closest('.zb-modal.visible, .zb-modal.show, [style*="display: block"]')) {
          if (m.textContent.includes('jump') || m.textContent.includes('level')) return m;
        }
      }
      return null;
    }, { timeout: 3000, interval: 200 });

    if (!modal) return;

    if (confirm) {
      // Find "Yes" or "Jump to level" button
      const yesBtn = Array.from(modal.querySelectorAll('button.zb-button')).find(
        btn => /\b(yes|jump|confirm|ok)\b/i.test(btn.innerText)
      );
      if (yesBtn) { yesBtn.click(); await Z.sleep(1000); return; }
    }

    // Cancel
    const cancelBtn = Array.from(modal.querySelectorAll('button.zb-button')).find(
      btn => /\b(no|cancel|close)\b/i.test(btn.innerText)
    );
    if (cancelBtn) { cancelBtn.click(); await Z.sleep(500); }
  };

  /**
   * Find the first incomplete level in a multi-level challenge.
   * Returns the 0-based level index to start from.
   */
  Z._challenge_findFirstIncompleteLevel = async function (el, totalLevels) {
    // Check each level's chevron for completion status
    const chevrons = el.querySelectorAll('.chevron-container .question-chevron.zb-chevron');
    if (chevrons.length === 0) return 0;

    for (let i = 0; i < Math.min(chevrons.length, totalLevels); i++) {
      const label = (chevrons[i].getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('not completed') || !label.includes('completed')) {
        // This level is incomplete — but only skip to it if i > 0
        if (i > 0) {
          console.log(`[ZyAgent] Skipping ${i} already-completed levels, starting at level ${i + 1}`);
          // Click on this level to navigate to it
          const levelBtns = el.querySelectorAll('.levels-bar .level');
          if (levelBtns[i]) {
            levelBtns[i].click();
            await Z.sleep(1500);
          }
        }
        return i;
      }
    }

    // All levels complete
    return totalLevels;
  };

  /**
   * Gather feedback from the activity element after a Check.
   * Scrapes error messages, test results, expected/actual output, etc.
   */
  Z._challenge_gatherFeedback = function (el) {
    const feedbackParts = [];

    // zyante-progression explanation table (output prediction)
    const explanationArea = el.querySelector('.zyante-progression-explanation');
    if (explanationArea) {
      feedbackParts.push(explanationArea.innerText.trim().substring(0, 1500));
    }

    // Code explanation area (code-writing challenges)
    const codeExplanation = el.querySelector('.code-explanation');
    if (codeExplanation && codeExplanation.offsetParent !== null) {
      feedbackParts.push(codeExplanation.innerText.trim().substring(0, 1500));
    }

    // Test results
    const testResults = el.querySelectorAll('.test-result');
    for (const test of testResults) {
      const testInfo = [];
      const header = test.querySelector('.test-header');
      if (header) testInfo.push('Test: ' + header.innerText.trim());
      const rows = test.querySelectorAll('.test-result-row');
      for (const row of rows) {
        testInfo.push('  ' + row.innerText.trim());
      }
      const errorOut = test.querySelector('.error-output');
      if (errorOut && errorOut.innerText.trim()) {
        testInfo.push('  Error: ' + errorOut.innerText.trim());
      }
      if (testInfo.length > 0) feedbackParts.push(testInfo.join('\n'));
    }

    // Error output
    const errorOutputs = el.querySelectorAll('.error-output');
    for (const eo of errorOutputs) {
      const text = eo.innerText.trim();
      if (text && !feedbackParts.some(p => p.includes(text))) {
        feedbackParts.push('Error output: ' + text);
      }
    }

    // Icon message (e.g., "No solution code provided")
    const iconMessage = el.querySelector('.icon-message');
    if (iconMessage) {
      feedbackParts.push('Message: ' + iconMessage.innerText.trim());
    }

    // Alert area
    const alert = el.querySelector('[role="alert"]');
    if (alert && alert.innerText.trim()) {
      const alertText = alert.innerText.trim();
      if (!feedbackParts.some(p => p.includes(alertText))) {
        feedbackParts.push('Alert: ' + alertText);
      }
    }

    // Live region
    const liveRegion = el.querySelector('[aria-live="polite"]');
    if (liveRegion && liveRegion.innerText.trim()) {
      const liveText = liveRegion.innerText.trim();
      if (!feedbackParts.some(p => p.includes(liveText))) {
        feedbackParts.push('Feedback: ' + liveText);
      }
    }

    return feedbackParts.join('\n\n') || 'No specific feedback found.';
  };

  /**
   * Smart auto-fix: when zyBooks shows "Yours" vs "Expected" output and the
   * difference is only whitespace, extract the expected output directly.
   */
  Z._challenge_tryAutoFixFromFeedback = async function (el, feedbackText) {
    try {
      const explanationArea = el.querySelector('.zyante-progression-explanation');
      if (!explanationArea) return null;

      const explanationTable = explanationArea.querySelector('.explanation-table, table.explanation-table');
      if (!explanationTable) return null;

      const expectedOutputEl = explanationTable.querySelector('.expected-output');
      const userOutputEl = explanationTable.querySelector('.user-output, .output:not(.expected-output)');

      if (!expectedOutputEl || !userOutputEl) return null;

      const expectedText = expectedOutputEl.textContent;
      const userText = userOutputEl.textContent;

      const expectedTrimmed = expectedText.trim();
      const userTrimmed = userText.trim();

      if (expectedTrimmed === userTrimmed) {
        console.log('[ZyAgent] Auto-fix: content matches, fixing whitespace. Expected:', JSON.stringify(expectedText));
        return expectedText;
      }

      const diffHighlights = explanationTable.querySelectorAll('.string-diff-highlight.newline');
      if (diffHighlights.length > 0 && expectedTrimmed === userTrimmed) {
        return expectedText;
      }

      if (expectedText && expectedText.length < 500) {
        console.log('[ZyAgent] Auto-fix: using expected output directly:', JSON.stringify(expectedText));
        return expectedText;
      }

      return null;
    } catch (err) {
      console.warn('[ZyAgent] Auto-fix error:', err);
      return null;
    }
  };

})();
