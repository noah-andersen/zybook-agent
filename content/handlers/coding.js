// ─── ZyBook Agent — Coding (Develop-mode) Handler ───
// Handles zyBooks "Develop mode" coding activities — the Ace editor labs.
// Strategy: Read instructions, ask AI for code, paste into editor, run, check output.

(function () {
  'use strict';

  const Z = window.ZyAgent;

  /* ── Helper: wait for code execution to finish ── */
  async function waitForExecution(el, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const running = el.querySelector('.run-button.is-running, .run-button[disabled], .activity-is-running');
      if (!running) return true;
      await Z.sleep(500);
    }
    return false;
  }

  Z.handleCoding = async function (activity, settings) {
    const el = activity.element;

    // Gather instructions
    const instructionEl = el.querySelector(
      '.develop-instructions, .instructions, .challenge-instructions, .zybook-content'
    );
    const instructions = instructionEl ? instructionEl.innerText.trim() : '';

    // Find the ACE editor element within the container
    const aceEl = el.querySelector('.ace_editor') || el;

    // Read any existing code — save as pristine original for reset on retry
    const existingCode = await Z.getAceEditorValue(aceEl) || '';
    const originalCode = existingCode;

    // Read expected output if visible
    const expectedEl = el.querySelector('.expected-output, .test-output');
    const expectedOutput = expectedEl ? expectedEl.innerText.trim() : '';

    // Read any test case info
    const testCaseEl = el.querySelector('.test-case-description, .test-text');
    const testCaseInfo = testCaseEl ? testCaseEl.innerText.trim() : '';

    const maxRetries = 3;
    let lastCode = '';
    let lastActualOutput = '';
    let lastError = '';

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (Z.shouldStop) return;
      const isRetry = attempt > 0;

      Z.sendProgress(0, 0, `Coding: attempt ${attempt + 1}/${maxRetries}`);

      // ── Reset editor to original state before each retry ──
      // Prevents failed attempts from compounding (double code blocks).
      if (isRetry) {
        console.log('[ZyAgent] Resetting coding editor to original code before retry attempt', attempt + 1);
        await Z.setAceEditorValue(aceEl, originalCode);
        await Z.sleep(500);
      }

      const prompt = [
        {
          role: 'system',
          content: `You are an expert Python programmer solving a zyBooks coding exercise.
Write ONLY the Python code. No explanations, no markdown, no code fences.
The code must be complete and runnable.
If there is existing code, modify or complete it.
Match any expected output EXACTLY including whitespace, newlines and capitalization.

${Z.ZYBOOKS_OUTPUT_RULES}
${isRetry ? '\nYour previous attempt was WRONG. Fix it based on the feedback below.' : ''}`
        },
        {
          role: 'user',
          content: [
            `Instructions:\n${instructions}`,
            existingCode ? `\nStarting code template:\n${existingCode}` : '',
            expectedOutput ? `\nExpected output:\n${expectedOutput}` : '',
            testCaseInfo ? `\nTest case info:\n${testCaseInfo}` : '',
            isRetry && lastCode ? `\nYour previous code:\n${lastCode}` : '',
            isRetry && lastActualOutput ? `\nActual output from previous attempt:\n${lastActualOutput}` : '',
            isRetry && lastError ? `\nError from previous attempt:\n${lastError}` : '',
            '\nWrite the complete Python code solution.'
          ].filter(Boolean).join('\n')
        }
      ];

      const code = await Z.callAI(settings, prompt);
      let cleanCode = code.replace(/^```(?:python)?\n?/gm, '').replace(/```$/gm, '').trim();

      /* ── Fix literal \n / \t escape sequences the AI sometimes returns ── */
      if (cleanCode.includes('\\n') || cleanCode.includes('\\t')) {
        if (!cleanCode.includes('\n')) {
          // Entire response is on one line with literal \n — expand them all
          cleanCode = cleanCode.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        } else {
          // Mixed: expand any stray literal escapes within individual lines
          cleanCode = cleanCode.split('\n')
            .map(l => l.replace(/\\n/g, '\n').replace(/\\t/g, '\t'))
            .join('\n');
        }
        console.log('[ZyAgent] Converted literal escape sequences in coding response');
      }

      lastCode = cleanCode;

      await Z.setAceEditorValue(aceEl, cleanCode);
      await Z.sleep(500);

      // Click Run / Submit
      const runBtn = el.querySelector(
        'button.run-button:not([disabled]), button.submit-button:not([disabled]), button.zb-button.primary:not([disabled])'
      );
      if (runBtn) {
        runBtn.click();
        Z.sendProgress(0, 0, 'Running code…');
        await waitForExecution(el);
        await Z.sleep(1500);
      }

      // Check pass / fail
      if (Z.checkCompletion(el)) {
        Z.sendProgress(0, 0, 'Coding activity completed ✓', 'success');
        return;
      }

      // Gather feedback for retry
      const actualOutputEl = el.querySelector('.output, .run-output, .actual-output, .stdout');
      lastActualOutput = actualOutputEl ? actualOutputEl.innerText.trim() : '';
      const errorEl = el.querySelector('.error-output, .stderr, .compile-error');
      lastError = errorEl ? errorEl.innerText.trim() : '';

      if (attempt < maxRetries - 1 && (lastActualOutput || lastError)) {
        Z.sendProgress(0, 0, `Coding: attempt ${attempt + 1} failed, retrying...`, 'warn');
      }
    }

    if (!Z.checkCompletion(el)) {
      Z.sendProgress(0, 0, `Coding activity: failed after ${maxRetries} attempts`, 'error');
    }
  };

})();
