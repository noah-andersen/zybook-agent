// ─── ZyBook Agent — Challenge Activity Handler ───
// Handles three types of challenge activities:
//
// TYPE A: "Code-writing" challenges (ACE editor with placeholder)
//   - Has an ACE editor with read-only regions and """ Your code goes here """
//   - Uses .check-next-container, .levels-bar, .code-writing-prompt
//   - We use the page bridge to find-replace the placeholder
//
// TYPE B: "Output prediction" / "Trace the code" challenges (zyante-progression)
//   - Has a read-only <div class="code"> showing a program
//   - Has <div class="input-div"> showing sample input
//   - Has a <textarea class="console"> where you type the expected output
//   - Uses .zyante-progression-start-button, .zyante-progression-check-button,
//     .zyante-progression-next-button, .zyante-progression-status-bar
//
// TYPE C: "Parsons Problem" / drag-and-drop code ordering challenges
//   - Has .two-reorderable-lists / .parsons-coding-pa container
//   - "Unused" sortable list with candidate code blocks
//   - "main.py" sortable list (solution area) with some locked blocks
//   - Drag correct block(s) from Unused into the right position
//   - Uses button.check-button
//
// Detection: .two-reorderable-lists → Type C
//            .zyante-progression-* + textarea.console → Type B
//            .ace_editor → Type A

(function () {
  'use strict';

  const Z = window.ZyAgent;

  // ════════════════════════════════════════════════════════════
  //  DETERMINISTIC OUTPUT POST-PROCESSING
  // ════════════════════════════════════════════════════════════

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
  function ensureTrailingNewline(text, code) {
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
  }

  // ════════════════════════════════════════════════════════════
  //  SHARED HELPERS
  // ════════════════════════════════════════════════════════════

  /**
   * Dismiss any visible modal dialogs (e.g., "Level jump" confirmation).
   * Clicks "No" / "Cancel" / close buttons to get rid of them.
   * This prevents modals from blocking the retry flow.
   */
  async function dismissAnyModal(el) {
    // Search the entire document — modals are often appended to body, not inside the activity
    const modals = document.querySelectorAll('.zb-modal-content');
    for (const modal of modals) {
      // Check if the modal is actually visible
      const isVisible = modal.offsetParent !== null ||
        modal.closest('.zb-modal.visible, .zb-modal.show, [style*="display: block"], [style*="display:block"]');
      if (!isVisible) continue;

      console.log('[ZyAgent] Found visible modal:', modal.textContent.substring(0, 100).trim());

      // Look for "No" / "Cancel" / "Don't" / dismiss buttons
      const dismissBtn = Array.from(modal.querySelectorAll('button.zb-button')).find(btn => {
        const text = btn.innerText.toLowerCase().trim();
        return text.includes('no') || text.includes('cancel') || text.includes("don't") || text.includes('close');
      });

      if (dismissBtn) {
        console.log('[ZyAgent] Dismissing modal via:', dismissBtn.innerText.trim());
        dismissBtn.click();
        await Z.sleep(800);
      } else {
        // Try clicking any warn/secondary button (usually the cancel action)
        const warnBtn = modal.querySelector('button.zb-button.warn');
        if (warnBtn) {
          console.log('[ZyAgent] Dismissing modal via warn button:', warnBtn.innerText.trim());
          warnBtn.click();
          await Z.sleep(800);
        }
      }
    }
  }

  /**
   * Handle the "Level jump" confirmation modal.
   * @param {boolean} confirm - true to click "Yes, jump", false to click "No, don't jump"
   */
  async function dismissOrConfirmJumpModal(confirm) {
    const modal = await Z.waitForCondition(() => {
      const modals = document.querySelectorAll('.zb-modal-content');
      for (const m of modals) {
        if (m.offsetParent !== null || m.closest('.zb-modal.visible, .zb-modal.show, [style*="display: block"]')) {
          if (m.textContent.toLowerCase().includes('jump') || m.textContent.toLowerCase().includes('level')) {
            return m;
          }
        }
      }
      return null;
    }, { timeout: 3000, interval: 200 });

    if (!modal) return;

    if (confirm) {
      // Click "Yes, jump" — it's the secondary button
      const yesBtn = Array.from(modal.querySelectorAll('button.zb-button')).find(btn =>
        btn.innerText.toLowerCase().includes('yes') || btn.innerText.toLowerCase().includes('jump')
      ) || modal.querySelector('button.zb-button.secondary.raised');
      if (yesBtn) {
        yesBtn.click();
        await Z.sleep(800);
      }
    } else {
      // Click "No, don't jump" — it's the warn button
      const noBtn = Array.from(modal.querySelectorAll('button.zb-button')).find(btn =>
        btn.innerText.toLowerCase().includes('no') || btn.innerText.toLowerCase().includes("don't")
      ) || modal.querySelector('button.zb-button.warn');
      if (noBtn) {
        noBtn.click();
        await Z.sleep(800);
      }
    }
  }

  /**
   * Determine which levels are already completed by reading the chevron indicators.
   * Returns the 0-based index of the first incomplete level, or 0 if none found.
   * Also navigates to that level by clicking its level button + handling the jump modal.
   *
   * @param {HTMLElement} el - The activity element
   * @param {number} totalLevels - Total number of levels
   * @returns {number} 0-based index of the first incomplete level
   */
  async function findFirstIncompleteLevel(el, totalLevels) {
    // Read completion state from chevrons
    const chevrons = el.querySelectorAll('.chevron-container .question-chevron.zb-chevron');
    const levelButtons = el.querySelectorAll('.levels-bar .level button');
    let firstIncomplete = 0;

    if (chevrons.length > 0) {
      for (let i = 0; i < Math.min(chevrons.length, totalLevels); i++) {
        const label = (chevrons[i].getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('completed') && !label.includes('not completed')) {
          firstIncomplete = i + 1; // This one is done — next one might be incomplete
        } else {
          firstIncomplete = i;
          break;
        }
      }
      // Clamp to valid range
      if (firstIncomplete >= totalLevels) firstIncomplete = totalLevels - 1;
    }

    if (firstIncomplete > 0) {
      console.log(`[ZyAgent] Levels 1-${firstIncomplete} already completed. Skipping to level ${firstIncomplete + 1}.`);
      Z.sendProgress(firstIncomplete, totalLevels, `Levels 1-${firstIncomplete} already done, jumping to level ${firstIncomplete + 1}`);

      // Click the level button to jump there
      if (levelButtons[firstIncomplete]) {
        levelButtons[firstIncomplete].click();
        await Z.sleep(1000);

        // Handle the "Level jump" confirmation modal if it appears
        await dismissOrConfirmJumpModal(true);
        await Z.sleep(1500);
      }
    }

    return firstIncomplete;
  }

  /* ── Gather STRUCTURED feedback from the explanation area ── */
  /* Returns a detailed object with parsed fields so AI gets maximum context */
  function gatherFeedback(el) {
    const parts = [];

    // ─── zyante-progression style (output prediction challenges) ───
    const progExplanation = el.querySelector('.zyante-progression-explanation');
    if (progExplanation) {
      // 1. Grab the top-level summary message (e.g. "Output is nearly correct. Whitespace differs.")
      //    This is direct text content before the explanation-table.
      const explanationText = progExplanation.querySelector('.explanation-text, p.explanation-text');
      if (explanationText) {
        parts.push('Feedback: ' + explanationText.innerText.trim());
      } else {
        // The summary text may be a direct text node before the table
        const firstTextNode = Array.from(progExplanation.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())
          .map(n => n.textContent.trim())
          .join(' ');
        if (firstTextNode) {
          parts.push('Feedback: ' + firstTextNode);
        }
      }

      // 2. Extract structured "Yours" vs "Expected" from .explanation-table
      const explanationTable = progExplanation.querySelector('.explanation-table, table.explanation-table');
      if (explanationTable) {
        const userOutputEl = explanationTable.querySelector('.user-output, .output:not(.expected-output)');
        const expectedOutputEl = explanationTable.querySelector('.expected-output');

        if (userOutputEl) {
          // Use textContent to preserve whitespace/newlines
          const userOut = userOutputEl.textContent;
          parts.push('Your output: ' + JSON.stringify(userOut));
        }
        if (expectedOutputEl) {
          const expectedOut = expectedOutputEl.textContent;
          parts.push('Expected output: ' + JSON.stringify(expectedOut));
        }

        // 3. Check for diff highlights — these show exactly what's different
        const diffHighlights = explanationTable.querySelectorAll('.string-diff-highlight');
        if (diffHighlights.length > 0) {
          const diffs = Array.from(diffHighlights).map(d => {
            const text = d.textContent;
            const isNewline = d.classList.contains('newline');
            const isSpace = d.classList.contains('space');
            if (isNewline) return 'MISSING NEWLINE (\\n)';
            if (isSpace) return 'MISSING/EXTRA SPACE';
            return `DIFF: ${JSON.stringify(text)}`;
          });
          parts.push('Differences: ' + diffs.join(', '));
        }

        // 4. Newline messaging (e.g., "Create your missing newline by pressing Enter")
        const newlineMsg = explanationTable.querySelector('.newline-message');
        if (newlineMsg) {
          parts.push('Hint: ' + newlineMsg.innerText.trim());
        }

        // 5. Extract all rows generically (catches "Input", "Your output", etc.)
        const rows = explanationTable.querySelectorAll('tr');
        for (const row of rows) {
          const descCell = row.querySelector('.explanation-description, td:first-child');
          const valueCell = row.querySelector('.output, .no-result-value, td:last-child .output');
          if (descCell && valueCell) {
            const desc = descCell.innerText.trim();
            const val = valueCell.textContent;
            // Only add if not already captured above
            if (desc.toLowerCase() !== 'yours' && desc.toLowerCase() !== 'expected') {
              parts.push(`${desc}: ${JSON.stringify(val)}`);
            }
          }
        }
      }

      // 6. No-result / error values
      const noResult = progExplanation.querySelector('.no-result-value');
      if (noResult) {
        parts.push('Error: ' + noResult.innerText.trim());
      }

      // 7. Fallback: if we didn't extract anything structured, use full text
      if (parts.length === 0 && progExplanation.innerText.trim()) {
        parts.push(progExplanation.innerText.trim());
      }
    }

    // ─── code-explanation style (ACE / code-writing challenges) ───
    const codeExplanation = el.querySelector('.code-explanation');
    if (codeExplanation) {
      const hint = codeExplanation.querySelector('.mb-6, p, .explanation-text');
      if (hint) parts.push('Hint: ' + hint.innerText.trim());

      // Extract "Your output" vs "Expected output" if present
      const yourOutput = codeExplanation.querySelector('.user-output, .your-output');
      const expectedOutput = codeExplanation.querySelector('.expected-output');
      if (yourOutput) parts.push('Your output: ' + JSON.stringify(yourOutput.textContent));
      if (expectedOutput) parts.push('Expected output: ' + JSON.stringify(expectedOutput.textContent));
    }

    // ─── Test results (code-writing challenges with test cases) ───
    const testResults = el.querySelectorAll('.test-result');
    let testCount = 0;
    let hasSyntaxError = false;
    let syntaxErrorDetails = '';
    let hasWrongOutput = false;

    for (const test of testResults) {
      if (testCount >= 5) break;
      const header = test.querySelector('.test-header');
      const errorOut = test.querySelector('.error-output');
      const rows = test.querySelectorAll('.test-result-row');

      let testInfo = '';
      if (header) testInfo += header.innerText.trim() + '\n';

      if (errorOut && errorOut.innerText.trim()) {
        const errorText = errorOut.innerText.trim();
        testInfo += 'Error: ' + errorText + '\n';

        // Detect and highlight syntax errors specifically
        if (/SyntaxError|IndentationError|TabError/i.test(errorText)) {
          hasSyntaxError = true;
          syntaxErrorDetails = errorText;
        }
      }

      for (const row of rows) {
        const label = row.querySelector('.result-row-description');
        const value = row.querySelector('.programming-code-output, .no-output-result');
        if (label && value) {
          const labelText = label.innerText.trim();
          const valueText = value.textContent;
          testInfo += labelText + ': ' + JSON.stringify(valueText) + '\n';

          // Detect wrong output (produced output but doesn't match)
          if (labelText.toLowerCase().includes('your output') && valueText.trim()) {
            hasWrongOutput = true;
          }
        }
      }

      if (testInfo) parts.push(testInfo);
      testCount++;
    }

    // ─── Add a summary of the error type at the top for clarity ───
    if (hasSyntaxError) {
      parts.unshift(`ERROR TYPE: SYNTAX ERROR — Your code has a Python syntax error and could not run at all.\n` +
        `The exact error is: ${syntaxErrorDetails}\n` +
        `IMPORTANT: Fix the syntax error. Common causes: missing 'in' keyword in for loops, missing colons, mismatched parentheses, bad indentation.`);
    } else if (hasWrongOutput) {
      parts.unshift(`ERROR TYPE: WRONG OUTPUT — Your code ran but produced incorrect output. Compare your output with the expected output carefully.`);
    }

    // ─── Specific hints (shown in some progression challenges) ───
    const specificHint = el.querySelector('.specific-hint, .zyante-progression-hint');
    if (specificHint && specificHint.innerText.trim() && specificHint.style.display !== 'none') {
      parts.push('Specific hint: ' + specificHint.innerText.trim());
    }

    // ─── Solution area (sometimes shown after failures) ───
    const solutionEl = el.querySelector('.zyante-progression-solution-area .solution');
    if (solutionEl && solutionEl.innerText.trim() && solutionEl.closest('.zyante-progression-solution-area')?.style.display !== 'none') {
      parts.push('Solution: ' + solutionEl.innerText.trim());
    }

    // ─── aria-live feedback area (Parsons, etc.) ───
    const ariaLive = el.querySelector('[aria-live="polite"]:not(.zyante-progression-explanation-area)');
    if (ariaLive && ariaLive.innerText.trim()) {
      parts.push('Feedback: ' + ariaLive.innerText.trim());
    }

    // ─── Run-button style: expected output test results ───
    const expectedOutputTests = el.querySelectorAll('.expected-output-test-result');
    for (const eot of expectedOutputTests) {
      if (eot.innerText.trim() && eot.offsetParent !== null) {
        parts.push('Expected output test: ' + eot.innerText.trim());
      }
    }

    // ─── Run-button style: program output / no-output messages ───
    const noOutputResults = el.querySelectorAll('.no-output-result');
    for (const nor of noOutputResults) {
      if (nor.innerText.trim()) {
        parts.push('No output: ' + nor.innerText.trim());
      }
    }

    return parts.join('\n').substring(0, 2500);
  }

  // ════════════════════════════════════════════════════════════
  //  SMART AUTO-FIX FROM FEEDBACK
  // ════════════════════════════════════════════════════════════
  // When zyBooks shows "Yours" vs "Expected" output, we can often
  // extract the expected output directly from the DOM and use it
  // without needing another AI call. This handles:
  //  - Missing trailing newlines (most common)
  //  - Extra/missing spaces
  //  - Minor whitespace differences

  async function tryAutoFixFromFeedback(el, feedbackText) {
    try {
      const explanationArea = el.querySelector('.zyante-progression-explanation');
      if (!explanationArea) return null;

      const explanationTable = explanationArea.querySelector('.explanation-table, table.explanation-table');
      if (!explanationTable) return null;

      // Extract the expected output directly from the DOM
      const expectedOutputEl = explanationTable.querySelector('.expected-output');
      const userOutputEl = explanationTable.querySelector('.user-output, .output:not(.expected-output)');

      if (!expectedOutputEl || !userOutputEl) return null;

      const expectedText = expectedOutputEl.textContent;
      const userText = userOutputEl.textContent;

      // Only auto-fix if the core content is the same and only whitespace differs
      const expectedTrimmed = expectedText.trim();
      const userTrimmed = userText.trim();

      if (expectedTrimmed === userTrimmed) {
        // The actual content matches — it's purely a whitespace difference.
        // Return the exact expected output (including its trailing newline)
        console.log('[ZyAgent] Auto-fix: content matches, fixing whitespace. Expected:', JSON.stringify(expectedText));
        return expectedText;
      }

      // Check if the diff is just newline-related
      const diffHighlights = explanationTable.querySelectorAll('.string-diff-highlight.newline');
      if (diffHighlights.length > 0 && expectedTrimmed === userTrimmed) {
        return expectedText;
      }

      // If expected output is available and short enough, just use it directly
      // (this is safe — zyBooks is literally showing us the answer)
      if (expectedText && expectedText.length < 500) {
        console.log('[ZyAgent] Auto-fix: using expected output directly:', JSON.stringify(expectedText));
        return expectedText;
      }

      return null;
    } catch (err) {
      console.warn('[ZyAgent] Auto-fix error:', err);
      return null;
    }
  }

  // ════════════════════════════════════════════════════════════
  //  TYPE B: OUTPUT PREDICTION CHALLENGES (zyante-progression)
  // ════════════════════════════════════════════════════════════

  async function handleOutputPrediction(activity, settings) {
    const el = activity.element;

    if (Z.checkCompletion(el)) {
      Z.sendProgress(0, 0, `Challenge "${activity.title}" already completed, skipping`, 'info');
      return;
    }

    // Count levels from the status bar
    const statusDivs = el.querySelectorAll('.zyante-progression-status-bar > div[role="listitem"], .zyante-progression-status-bar > div:not([class])');
    const totalLevels = statusDivs.length || 1;
    Z.sendProgress(0, totalLevels, `Output challenge "${activity.title}" — ${totalLevels} level(s)`);

    // Click Start — wait for button to appear
    const startBtn = await Z.waitForElement(
      '.zyante-progression-start-button:not(.disabled):not([disabled])',
      { root: el, timeout: 5000 }
    );
    if (startBtn && startBtn.style.display !== 'none') {
      startBtn.click();
      Z.sendProgress(0, totalLevels, 'Clicked Start');
      await Z.sleep(2000); // longer wait after start for state to initialize
    }

    // ── Skip already-completed levels (if chevron/level UI is present) ──
    const startLevel = await findFirstIncompleteLevel(el, totalLevels);

    // Iterate through levels
    for (let level = startLevel; level < totalLevels; level++) {
      if (Z.shouldStop) break;

      if (Z.checkCompletion(el)) {
        Z.sendProgress(totalLevels, totalLevels, `Challenge "${activity.title}" completed!`, 'success');
        return;
      }

      Z.sendProgress(level + 1, totalLevels, `Working on level ${level + 1}/${totalLevels}`);
      await Z.sleep(800);

      const maxRetries = 3;
      let passed = false;
      let lastFeedback = '';

      for (let attempt = 0; attempt < maxRetries && !passed && !Z.shouldStop; attempt++) {
        const isRetry = attempt > 0;

        // Read the prompt text (e.g., "Type the program's output")
        const promptEl = el.querySelector('#prompt, .tool-container > p');
        const promptText = promptEl ? promptEl.innerText.trim() : 'Type the program\'s output';

        // Read the code
        const codeEl = el.querySelector('.tool-container .code, .code-container .code');
        const code = codeEl ? codeEl.innerText.trim() : '';

        // Read the input
        const inputEl = el.querySelector('.input-div, .input-container .input-div');
        const inputData = inputEl ? inputEl.innerText.trim() : '';

        // Find the output textarea
        const outputTextarea = el.querySelector('textarea.console');
        if (!outputTextarea) {
          Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: No output textarea found`, 'error');
          break;
        }

        Z.sendProgress(level + 1, totalLevels,
          `Level ${level + 1}, attempt ${attempt + 1}: Tracing code output…`);

        // Ask AI to trace the code
        const messages = [
          {
            role: 'system',
            content: `You are an expert Python programmer. You must trace through the given Python code with the given input and determine EXACTLY what the program outputs.
${Z.ZYBOOKS_OUTPUT_RULES}

ADDITIONAL RULES:
- Respond with ONLY the program's output text, nothing else.
- Do NOT include any explanation, commentary, or labels.
- If the program prints nothing, respond with an empty string.
- Simulate the program step by step with the given input values.
- input() reads one line at a time from the input.
- After tracing, double-check: does the last executed statement use print()? If yes, your response MUST end with a newline.
${isRetry ? `\nYour previous answer was WRONG. Here is the detailed feedback showing exactly what was wrong. Pay very careful attention to whitespace and newlines:` : ''}`
          },
          {
            role: 'user',
            content: [
              `Task: ${promptText}`,
              `\nPython code:\n${code}`,
              inputData ? `\nInput (each line is one input() call):\n${inputData}` : '\nNo input.',
              isRetry && lastFeedback ? `\n=== FEEDBACK FROM WRONG ANSWER ===\n${lastFeedback}\n=== END FEEDBACK ===` : '',
              `\nWhat does this program output? Respond with ONLY the exact output (including the trailing newline from print).`
            ].filter(Boolean).join('\n')
          }
        ];

        const response = await Z.callAI(settings, messages);
        // Clean: remove markdown fences if any, but PRESERVE trailing newlines
        // Only strip leading whitespace and markdown artifacts
        let cleanResponse = response
          .replace(/^```(?:python|text|output)?\n?/gm, '')
          .replace(/```\s*$/gm, '');

        // Strip only LEADING whitespace (not trailing — trailing newlines matter!)
        cleanResponse = cleanResponse.replace(/^\s*\n/, '');
        // Remove leading spaces on first line only
        cleanResponse = cleanResponse.replace(/^[ \t]+/, '');
        // But DO trim trailing spaces/tabs on the last line (not newlines)
        cleanResponse = cleanResponse.replace(/[ \t]+$/, '');

        // ─── Deterministic trailing newline fix ───
        // Analyze the Python code to determine if the last print() adds a newline.
        // If the code's last executed print() uses default end='\n', ensure
        // our response ends with \n — even if the AI forgot it.
        cleanResponse = ensureTrailingNewline(cleanResponse, code);

        console.log('[ZyAgent] AI output prediction:', JSON.stringify(cleanResponse));

        // Enable the textarea (it may be disabled)
        outputTextarea.removeAttribute('disabled');
        outputTextarea.focus();
        await Z.sleep(200);

        // Clear existing content and type new answer
        outputTextarea.value = '';
        outputTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        await Z.sleep(100);

        // Use setNativeValue for React/Ember compatibility
        Z.setNativeValue(outputTextarea, cleanResponse);
        await Z.sleep(300);

        // Also try direct value set + events
        outputTextarea.value = cleanResponse;
        outputTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        outputTextarea.dispatchEvent(new Event('change', { bubbles: true }));
        outputTextarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        await Z.sleep(500);

        // Click Check — wait for it to become enabled
        const checkBtn = await Z.waitForCondition(
          () => el.querySelector('.zyante-progression-check-button:not(.disabled):not([disabled])'),
          { timeout: 5000, interval: 300 }
        );
        if (!checkBtn) {
          Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Check button not available`, 'warn');
          // Extra wait and retry
          await Z.sleep(3000);
          const retryCheck = el.querySelector('.zyante-progression-check-button:not(.disabled):not([disabled])');
          if (!retryCheck) {
            Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Check button still disabled`, 'error');
            continue;
          }
          retryCheck.click();
        } else {
          checkBtn.click();
        }

        Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Checking… (attempt ${attempt + 1}/${maxRetries})`);
        await Z.sleep(2000);

        // Check feedback
        // The zyante-progression uses:
        //   - checkmark image (display: inline) = correct
        //   - x-mark span (display: inline) = incorrect
        //   - Next button becomes enabled = correct
        const result = await waitForProgressionFeedback(el);

        if (result === 'correct') {
          passed = true;
          Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Correct! ✓`, 'success');
        } else {
          lastFeedback = gatherFeedback(el);
          console.log('[ZyAgent] Feedback gathered:', lastFeedback);

          // ─── Smart auto-fix for common whitespace issues ───
          // If the feedback shows "Yours" vs "Expected" and the only diff is
          // whitespace (trailing newline, extra space, etc.), fix it directly
          // without burning an AI retry.
          const autoFixed = await tryAutoFixFromFeedback(el, lastFeedback);

          // Don't attempt auto-fix if the zybook has swapped in a new code variation
          // (Check disabled + no Try Again + Next visible means the code will change)
          const tryAgainForAutoFix = el.querySelector('.zyante-progression-try-again:not(.disabled):not([disabled])');
          const tryAgainVisible = tryAgainForAutoFix && tryAgainForAutoFix.style.display !== 'none';
          const isCodeVariationReset = !tryAgainVisible &&
            el.querySelector('.zyante-progression-check-button.disabled, .zyante-progression-check-button[disabled]') &&
            el.querySelector('.zyante-progression-next-button:not(.disabled):not([disabled])');

          if (autoFixed && !isCodeVariationReset) {
            Z.sendProgress(level + 1, totalLevels,
              `Level ${level + 1}: Auto-fixing whitespace issue…`, 'info');

            // Click "Try again" first to re-enable the form
            if (tryAgainVisible) {
              tryAgainForAutoFix.click();
              await Z.sleep(1000);
            }

            // Write the corrected value
            const retryTextarea = el.querySelector('textarea.console');
            if (retryTextarea) {
              retryTextarea.removeAttribute('disabled');
              retryTextarea.focus();
              await Z.sleep(200);
              Z.setNativeValue(retryTextarea, autoFixed);
              retryTextarea.value = autoFixed;
              retryTextarea.dispatchEvent(new Event('input', { bubbles: true }));
              retryTextarea.dispatchEvent(new Event('change', { bubbles: true }));
              await Z.sleep(500);

              // Click Check
              const checkBtnRetry = await Z.waitForCondition(
                () => el.querySelector('.zyante-progression-check-button:not(.disabled):not([disabled])'),
                { timeout: 5000, interval: 300 }
              );
              if (checkBtnRetry) {
                checkBtnRetry.click();
                await Z.sleep(2000);
                const retryResult = await waitForProgressionFeedback(el);
                if (retryResult === 'correct') {
                  passed = true;
                  Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Correct after auto-fix! ✓`, 'success');
                  continue; // skip normal retry flow
                }
                // Auto-fix didn't fully work, update feedback for AI retry
                lastFeedback = gatherFeedback(el);
              }
            }
          }

          Z.sendProgress(level + 1, totalLevels,
            `Level ${level + 1}: Incorrect (attempt ${attempt + 1}/${maxRetries})`, 'warn');

          // Reset for the next attempt if we have retries left
          if (attempt < maxRetries - 1) {
            // Strategy 1: Click "Try again" if it's available and visible
            const tryAgainBtn = el.querySelector('.zyante-progression-try-again:not(.disabled):not([disabled])');
            if (tryAgainBtn && tryAgainBtn.style.display !== 'none') {
              tryAgainBtn.click();
              await Z.sleep(1000);
            } else {
              // Strategy 2: The zybook has disabled Check and hidden Try Again,
              // but shows "Next" to reset the level with a new code variation.
              // Detect this: Check is disabled AND Next is enabled AND we're NOT passed.
              const checkDisabled = el.querySelector('.zyante-progression-check-button.disabled, .zyante-progression-check-button[disabled]');
              const nextBtnReset = el.querySelector('.zyante-progression-next-button:not(.disabled):not([disabled])');
              if (checkDisabled && nextBtnReset && nextBtnReset.style.display !== 'none') {
                Z.sendProgress(level + 1, totalLevels,
                  `Level ${level + 1}: Code variation changed, clicking Next to get new code…`, 'info');
                nextBtnReset.click();
                await Z.sleep(2500);

                // After clicking Next for a reset, the level stays the same but
                // the code changes. Clear any stale feedback so the AI gets fresh context.
                lastFeedback = '';

                // Wait for the new code and textarea to be ready
                await Z.waitForCondition(
                  () => el.querySelector('textarea.console') && el.querySelector('.tool-container .code, .code-container .code'),
                  { timeout: 5000, interval: 300 }
                );
                await Z.sleep(500);
              }
            }
          }
        }
      }

      // NEVER advance if not passed
      if (!passed) {
        Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Failed after ${maxRetries} attempts. Stopping.`, 'error');
        return;
      }

      // Click Next to advance
      if (level < totalLevels - 1) {
        await Z.sleep(1000);
        // Wait for Next button to become enabled
        const nextBtn = await Z.waitForCondition(
          () => el.querySelector('.zyante-progression-next-button:not(.disabled):not([disabled])'),
          { timeout: 8000 }
        );
        if (nextBtn) {
          nextBtn.click();
          Z.sendProgress(level + 1, totalLevels, `Advancing to level ${level + 2}`);
          await Z.sleep(2000);
        } else {
          Z.sendProgress(level + 1, totalLevels, `Next button not found after level ${level + 1}`, 'warn');
        }
      }
    }

    if (Z.checkCompletion(el)) {
      Z.sendProgress(totalLevels, totalLevels, `Challenge "${activity.title}" completed!`, 'success');
    }
  }

  /* ── Wait for zyante-progression feedback ── */
  async function waitForProgressionFeedback(el, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Checkmark visible = correct
      const checkmark = el.querySelector('.zyante-progression-checkmark');
      if (checkmark && checkmark.style.display !== 'none' && checkmark.offsetParent !== null) {
        return 'correct';
      }

      // X-mark visible = incorrect
      const xMark = el.querySelector('.zyante-progression-x-mark');
      if (xMark && xMark.style.display !== 'none' && xMark.offsetParent !== null) {
        return 'incorrect';
      }

      // Next button enabled = correct (but ONLY if no X-mark is showing,
      // because in a code-variation-reset scenario the Next button is enabled
      // even when the answer was wrong — it resets the level with new code)
      const nextBtn = el.querySelector('.zyante-progression-next-button:not(.disabled):not([disabled])');
      const xMarkForNext = el.querySelector('.zyante-progression-x-mark');
      const xMarkVisible = xMarkForNext && xMarkForNext.style.display !== 'none' && xMarkForNext.offsetParent !== null;
      if (nextBtn && nextBtn.style.display !== 'none' && !xMarkVisible) return 'correct';

      // "Done" message visible = complete
      const doneEl = el.querySelector('.zyante-progression-is-done');
      if (doneEl && doneEl.style.display !== 'none') return 'correct';

      // Activity fully complete
      if (Z.checkCompletion(el)) return 'correct';

      await Z.sleep(400);
    }
    return 'timeout';
  }

  // ════════════════════════════════════════════════════════════
  //  TYPE C: PARSONS PROBLEM / DRAG-AND-DROP CODE ORDERING
  // ════════════════════════════════════════════════════════════

  /**
   * Try to move a block from the unused list into the used list.
   * Uses a cascade of strategies:
   *   0. KEYBOARD: zyBooks native Space-grab → Arrow-move → Space-drop (most reliable)
   *   1. MAIN-world bridge (ember-sortable mouse events from page context)
   *   2. ISOLATED-world mouse/pointer simulation (async)
   *   3. ARIA keyboard approach (legacy space-click)
   *   4. Touch events (mobile fallback)
   *
   * Returns true if the block ended up in the used list.
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
    // zyBooks says: "Grab/release Spacebar (or Enter). Move ↑↓←→. Cancel Esc"
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

  /**
   * After a block has been placed in the used list, check if its indentation
   * (margin-left) matches the desired indent level. If not, try to nudge it
   * by simulating a short horizontal drag within the used list.
   *
   * zyBooks determines indent by the X position of the block. When the user
   * drags a block left/right within the used list, the margin-left updates.
   *
   * Strategy cascade:
   *   1. Try MAIN-world bridge (most reliable since events come from page context)
   *   2. Fall back to ISOLATED-world mouse simulation
   *   3. Last resort: directly set style.marginLeft on the DOM element
   */
  async function adjustBlockIndentation(el, blockId, desiredIndent, blockText = '') {
    const INDENT_PX = 31; // ~31px per indent level in zyBooks
    const usedList = el.querySelector('.sortable[data-list-name="used"]');
    if (!usedList) return false;

    // Find the block — prefer text match to avoid duplicate-ID issues
    let block = null;
    if (blockText) {
      const candidates = usedList.querySelectorAll(`.block.moveable`);
      for (const b of candidates) {
        if (b.textContent.trim() === blockText) { block = b; break; }
      }
    }
    if (!block) {
      block = usedList.querySelector(`.block[data-block-id="${blockId}"]:not([aria-disabled="true"])`);
    }
    if (!block) return false;

    // Read current indent
    const currentMargin = parseInt(block.style.marginLeft) || 0;
    const currentIndent = Math.round(currentMargin / INDENT_PX);

    if (currentIndent === desiredIndent) {
      console.log('[ZyAgent] Parsons: Block', blockId, 'already at correct indent', desiredIndent);
      return true;
    }

    const desiredMargin = desiredIndent * INDENT_PX;
    console.log('[ZyAgent] Parsons: Block', blockId, `"${blockText.substring(0, 30)}"`, 'at indent', currentIndent, '→ adjusting to', desiredIndent);

    // ── Strategy 1: MAIN-world bridge (most reliable) ──
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
      console.log('[ZyAgent] Parsons: Bridge indent adjustment returned failure');
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

      // Small initial move to trigger drag recognition
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, clientX: startX + 2, clientY: startY, button: 0
      }));
      await Z.sleep(80);

      // Move horizontally in steps
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

    // Check if mouse simulation worked
    const postMouseMargin = parseInt(block.style.marginLeft) || 0;
    if (Math.round(postMouseMargin / INDENT_PX) === desiredIndent) {
      console.log('[ZyAgent] Parsons: ISOLATED mouse indent adjustment succeeded');
      return true;
    }

    // ── Strategy 3: Direct DOM manipulation (last resort) ──
    // If mouse simulation didn't work, directly set marginLeft.
    // This may not update Ember's internal model, but zyBooks appears to read
    // the indent from the DOM style when the Check button is clicked.
    console.log('[ZyAgent] Parsons: Mouse simulation failed — trying direct DOM style.marginLeft');
    block.style.marginLeft = desiredMargin + 'px';

    // Also try triggering change events so Ember/Glimmer picks it up
    block.dispatchEvent(new Event('change', { bubbles: true }));
    block.dispatchEvent(new Event('input', { bubbles: true }));

    // Try to find and update Ember's internal state via data attributes
    // Some ember-sortable implementations read indent from a data attribute
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
   * Analyze blocks currently in the used list and fix their indentation.
   * Uses a smarter algorithm that:
   *   - Respects locked blocks' current indentation as anchor points.
   *   - Tracks indent depth using a stack (handles de-indentation after blocks).
   *   - Lines after a colon-line (while:, for:, if:, def:) go indent+1.
   *   - Lines at the same or lesser indent as a colon-line mean the body ended.
   *
   * Optionally accepts AI-provided indent overrides which take priority.
   */
  async function fixIndentationInUsedList(el, usedInfo, INDENT_PX_PER_LEVEL, aiIndentOverrides = null) {
    const usedList = el.querySelector('.sortable[data-list-name="used"]');
    if (!usedList) return false;

    // If we have AI-provided indent overrides, use those directly
    // (the AI already figured out the correct indentation)
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
    // Use locked blocks' indent levels as anchor points.
    // Track indent depth with a stack so we de-indent correctly.
    const desiredIndents = [];
    let indentStack = [0]; // stack of indent levels; top = current scope level

    for (let i = 0; i < usedInfo.length; i++) {
      const block = usedInfo[i];
      const text = block.text.trim();

      // If this block is locked, use its ACTUAL indent as the truth
      if (block.isLocked) {
        const lockedIndent = Math.round((parseInt(block.indent) || 0) / INDENT_PX_PER_LEVEL);
        desiredIndents.push(lockedIndent);
        // Reset our stack to match the locked block's indent level
        indentStack = [];
        for (let j = 0; j <= lockedIndent; j++) indentStack.push(j);
      } else {
        // Current scope indent is top of stack
        const currentScope = indentStack[indentStack.length - 1] || 0;
        desiredIndents.push(currentScope);
      }

      // If this block ends with ':', next block should be indented deeper
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

    // Now adjust each moveable block's indent
    let anyAdjusted = false;
    const usedBlocks = Array.from(usedList.querySelectorAll('.block'));
    for (let i = 0; i < usedBlocks.length; i++) {
      const block = usedBlocks[i];
      const isLocked = block.getAttribute('aria-disabled') === 'true';
      if (isLocked) continue; // can't adjust locked blocks

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

  /**
   * Reset a Parsons problem back to its initial state by clicking the
   * reset/template button and handling the confirmation modal.
   * Falls back to manual drag if no reset button exists.
   */
  async function resetParsonsBlocks(el) {
    // Look for reset/template buttons
    const resetBtn = el.querySelector('button.reset-button, .reset-button, a.reset-button') ||
      el.querySelector('button[aria-label*="reset" i], button[aria-label*="template" i]') ||
      Array.from(el.querySelectorAll('button, a.action-button, a')).find(
        btn => /reset|default|template|start over/i.test(btn.innerText)
      );

    if (resetBtn) {
      console.log('[ZyAgent] Parsons: Clicking reset button:', resetBtn.innerText.trim());
      resetBtn.click();
      await Z.sleep(1000);

      // Handle the "Use default template" confirmation modal
      const confirmModal = await Z.waitForCondition(() => {
        const modals = document.querySelectorAll('.zb-modal-content');
        for (const modal of modals) {
          // Check visibility
          if (modal.offsetParent !== null ||
              modal.closest('.zb-modal.visible, .zb-modal.show, [style*="display: block"], [style*="display:block"]')) {
            return modal;
          }
          // Check text content
          if (modal.textContent.includes('default template') || modal.textContent.includes('put back in unused')) {
            return modal;
          }
        }
        return null;
      }, { timeout: 3000, interval: 200 });

      if (confirmModal) {
        console.log('[ZyAgent] Parsons: Found confirmation modal');
        // Find the confirm button (NOT "Cancel")
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
        } else {
          console.warn('[ZyAgent] Parsons: Could not find confirm button in modal');
        }
      } else {
        console.log('[ZyAgent] Parsons: No modal appeared — reset may have been instant');
        await Z.sleep(1000);
      }
    } else {
      // No reset button — try manual drag back
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

  async function handleParsons(activity, settings) {
    const el = activity.element;

    if (Z.checkCompletion(el)) {
      Z.sendProgress(0, 0, `Challenge "${activity.title}" already completed, skipping`, 'info');
      return;
    }

    Z.sendProgress(0, 1, `Parsons challenge "${activity.title}"`);

    const maxAttempts = 6;
    const INDENT_PX_PER_LEVEL = 31;
    let attemptHistory = []; // Accumulate reasoning across attempts

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
        indentGuideCount: 0
      };

      const instrEl = el.querySelector('.reorderable-lists-instructions');
      ctx.instructions = instrEl ? instrEl.innerText.trim() : '';

      // Check for distractor hints
      const fullText = el.innerText || '';
      if (/distractor|not.+needed|extra.+block|unnecessary/i.test(fullText)) {
        ctx.hasDistractors = true;
        ctx.distractorHint = 'WARNING: Some blocks may be DISTRACTORS (not needed). Do NOT use every block.';
      }
      const distractorEl = el.querySelector('.distractor-info, .parsons-hint');
      if (distractorEl) {
        ctx.distractorHint = 'DISTRACTOR INFO: ' + distractorEl.innerText.trim();
        ctx.hasDistractors = true;
      }

      // Unused blocks
      const unusedList = el.querySelector('.sortable[data-list-name="unused"]');
      if (unusedList) {
        const blocks = unusedList.querySelectorAll('.block.moveable:not([aria-disabled="true"])');
        ctx.unusedBlocks = Array.from(blocks).map((b, i) => ({
          domIndex: i,
          blockId: b.getAttribute('data-block-id'),
          text: b.textContent.trim(),
          element: b
        }));
      }

      // Used blocks (including locked)
      const usedList = el.querySelector('.sortable[data-list-name="used"]');
      if (usedList) {
        const blocks = usedList.querySelectorAll('.block');
        ctx.usedBlocks = Array.from(blocks).map((b, i) => ({
          index: i,
          blockId: b.getAttribute('data-block-id'),
          text: b.textContent.trim(),
          isLocked: b.getAttribute('aria-disabled') === 'true',
          indent: Math.round((parseInt(b.style.marginLeft) || 0) / INDENT_PX_PER_LEVEL)
        }));
      }

      // Indent guides
      const indentGuide = el.querySelector('.editor-indents');
      if (indentGuide) {
        ctx.indentGuideCount = indentGuide.querySelectorAll('div').length;
      }

      // Test results / feedback
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

      // ━━━ SCRAPE FULL CONTEXT each attempt ━━━
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
          })), INDENT_PX_PER_LEVEL);
          if (!anyChanged && attempt > 0) {
            Z.sendProgress(0, 1, 'Indentation adjustment not taking effect', 'error');
            break;
          }
        }

        await Z.sleep(300);
        const checkBtn = el.querySelector('button.check-button:not([disabled])');
        if (checkBtn) { checkBtn.click(); await Z.sleep(3000); }
        if (Z.checkCompletion(el)) {
          Z.sendProgress(1, 1, `Challenge "${activity.title}" completed!`, 'success');
          return;
        }
        continue;
      }

      Z.sendProgress(0, 1, `Attempt ${attempt + 1}/${maxAttempts}: ${ctx.unusedBlocks.length} block(s) to place`);

      // ━━━ BUILD AI PROMPT with full context ━━━
      const messages = buildParsonsPrompt(ctx, attemptHistory, attempt);
      const response = await Z.callAI(settings, messages);
      console.log('[ZyAgent] Parsons AI response:', response);

      attemptHistory.push({
        attempt: attempt + 1,
        response: response.substring(0, 1500),
        feedback: ctx.errorSummary || ctx.feedbackText || '',
        testResults: ctx.testResults
      });

      // ━━━ PARSE AI RESPONSE ━━━
      const { moves, aiIndentOverrides } = parseParsonsResponse(response, ctx);

      if (moves.length === 0) {
        Z.sendProgress(0, 1, `Attempt ${attempt + 1}: AI returned no valid moves`, 'warn');
        continue;
      }

      // Ensure all unused blocks are covered
      for (const unused of ctx.unusedBlocks) {
        if (!moves.find(m => m.text === unused.text)) {
          console.warn('[ZyAgent] Parsons: AI missed block', unused.domIndex, `"${unused.text}" — appending at end`);
          const lastPos = ctx.usedBlocks.length + moves.length;
          let inferredIndent = 0;
          if (ctx.indentGuideCount > 0) {
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
        const success = await moveBlockToUsedList(el, sourceBlock, move.insertPos, move.blockId, 0);
        if (success) {
          movesMade++;
          console.log('[ZyAgent] Parsons: Moved block', mi, `"${move.text.substring(0, 40)}"`);
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

      // Check for blocks that failed to move
      const finalUnusedBlocks = Array.from(
        el.querySelector('.sortable[data-list-name="unused"]').querySelectorAll('.block.moveable:not([aria-disabled="true"])')
      );
      if (finalUnusedBlocks.length > 0 && attempt < maxAttempts - 1) {
        Z.sendProgress(0, 1, `${finalUnusedBlocks.length} blocks failed to move — resetting…`, 'warn');
        await resetParsonsBlocks(el);
        await Z.sleep(1000);
        continue;
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
      await fixIndentationInUsedList(el, updatedUsedInfo, INDENT_PX_PER_LEVEL, aiIndentOverrides);

      // Keyboard-based indent fallback for blocks that didn't change
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

      // ════ CHECK answer ════
      const checkBtn = el.querySelector('button.check-button:not([disabled])');
      if (checkBtn) {
        checkBtn.click();
        Z.sendProgress(0, 1, `Checking attempt ${attempt + 1}…`);
        await Z.sleep(4000);
      }

      if (Z.checkCompletion(el)) {
        Z.sendProgress(1, 1, `Challenge "${activity.title}" completed!`, 'success');
        return;
      }

      // ━━━ POST-CHECK: Scrape feedback ━━━
      const postCtx = scrapeFullParsonsContext();
      const allFeedback = (postCtx.errorSummary + ' ' + postCtx.feedbackText).toLowerCase();

      // Quick indent fix for IndentationError
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
        // Also try keyboard indent
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

      // Capture screenshot for visual context
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

      // Reset for next attempt
      if (attempt < maxAttempts - 1) {
        Z.sendProgress(0, 1, `Resetting for attempt ${attempt + 2}…`);
        await resetParsonsBlocks(el);
        await Z.sleep(1000);
      }
    }

    if (!Z.checkCompletion(el)) {
      Z.sendProgress(0, 1, `Parsons challenge "${activity.title}" failed after ${maxAttempts} attempts`, 'error');
    }
  }

  // ─── Parsons AI Prompt Builder ───
  function buildParsonsPrompt(ctx, attemptHistory, attempt) {
    const usedDisplay = ctx.usedBlocks.map((b, i) => {
      const prefix = '    '.repeat(b.indent);
      return `  [${i}] ${b.isLocked ? '🔒LOCKED' : '🔓moveable'} indent=${b.indent} | ${prefix}${b.text}`;
    }).join('\n');

    const unusedDisplay = ctx.unusedBlocks.map(b =>
      `  [UNUSED_INDEX ${b.domIndex}] "${b.text}"`
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
      }
      historyContext += '\n\nDo NOT repeat the same mistake. Carefully analyze what went wrong.';
    }

    let distractorContext = '';
    if (ctx.hasDistractors) {
      distractorContext = `\n\n⚠️ ${ctx.distractorHint}\nNot all blocks need to be placed. Mark unused distractors as: UNUSED_INDEX -> SKIP`;
    }

    const indentHint = ctx.indentGuideCount > 0
      ? `\nINDENTATION: Editor shows ${ctx.indentGuideCount} indent guide(s). Use indent=1+ for indented code.`
      : '';

    return [
      {
        role: 'system',
        content: `You are an expert Python programmer solving a zyBooks Parsons Problem (drag-and-drop code ordering).

TASK: Arrange the code blocks to form a correct Python program.
${ctx.instructions ? `\nExercise instructions:\n"${ctx.instructions}"` : ''}

CURRENT CODE AREA (blocks already in the solution, in order):
${usedDisplay || '  (empty — nothing placed yet)'}

🔒LOCKED blocks CANNOT be moved. They are fixed anchors.
🔓moveable blocks were previously placed and could be in the wrong spot.

UNUSED BLOCKS available to place:
${unusedDisplay}
${indentHint}${distractorContext}

THINK STEP BY STEP:
1. Read ALL blocks carefully (locked + placed + unused).
2. Identify the COMPLETE correct Python program.
3. Locked blocks are fixed — build around them.
4. Check if any unused blocks are DISTRACTORS that should NOT be used.
5. Determine the correct ORDER and INDENTATION of all blocks.

INDENTATION RULES:
- indent=0: top-level code
- indent=1: inside a while/for/if/def/elif/else/try/except block
- indent=2: doubly nested
- Lines directly after "while:", "for:", "if:", "def:", "elif:", "else:", "try:", "except:" must be indented +1
- Lines at the same indent or less mean the body ended

RESPONSE FORMAT:
First, write the COMPLETE PROGRAM:
PROGRAM:
  0: indent=0 | some_code        [LOCKED]
  1: indent=0 | while condition: [UNUSED_INDEX 2]
  2: indent=1 |     body_line    [UNUSED_INDEX 0]

Then, list the placements:
PLACEMENTS:
  UNUSED_INDEX -> POSITION @ INDENT_LEVEL

To skip a distractor: UNUSED_INDEX -> SKIP

CRITICAL RULES:
- POSITION = 0-based line number in your COMPLETE program.
- Each POSITION must be unique.
- Double-check Python syntax and logical flow.
${historyContext}`
      },
      {
        role: 'user',
        content: `Write the complete correct program, then list the placements for the ${ctx.unusedBlocks.length} unused block(s).`
      }
    ];
  }

  // ─── Parsons indent-fix prompt ───
  function buildIndentFixPrompt(ctx, attemptHistory) {
    const usedDisplay = ctx.usedBlocks.map((b, i) => {
      const prefix = '    '.repeat(b.indent);
      return `  [${i}] ${b.isLocked ? 'LOCKED' : 'MOVEABLE'} current_indent=${b.indent} | ${prefix}${b.text}`;
    }).join('\n');

    let feedbackInfo = '';
    if (ctx.errorSummary) feedbackInfo += `\nError: ${ctx.errorSummary}`;
    if (ctx.feedbackText) feedbackInfo += `\nFeedback: ${ctx.feedbackText}`;
    if (ctx.testResults.length > 0) {
      feedbackInfo += '\nTest Results:';
      for (const t of ctx.testResults) feedbackInfo += '\n  ' + JSON.stringify(t);
    }

    return [
      {
        role: 'system',
        content: `You are fixing INDENTATION in a zyBooks Parsons problem. The blocks are in the correct ORDER but their indentation is wrong.
Current code in the solution area:
${usedDisplay}
${feedbackInfo}

For each MOVEABLE block that needs a different indent level, output:
INDENT_FIX: "block text" -> INDENT_LEVEL

Only output lines that need to CHANGE. Do not output locked blocks.
indent=0 = no indentation, indent=1 = inside a block body, etc.`
      },
      { role: 'user', content: 'Fix the indentation for the blocks listed above.' }
    ];
  }

  // ─── Parse AI indent fix response ───
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

  // ─── Parse AI Parsons response ───
  function parseParsonsResponse(response, ctx) {
    const moves = [];
    const aiIndentOverrides = {};

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

      let matchingBlock = ctx.unusedBlocks.find(b => b.domIndex === unusedIndex);
      if (!matchingBlock) matchingBlock = ctx.unusedBlocks.find(b => parseInt(b.blockId) === unusedIndex);
      if (!matchingBlock) continue;

      // Infer indent if not specified
      if (indentLevel === 0 && ctx.indentGuideCount > 0 && !line.includes('@')) {
        for (let k = insertPos - 1; k >= 0; k--) {
          const blk = ctx.usedBlocks[k];
          if (!blk) break;
          if (blk.text.trimEnd().endsWith(':')) { indentLevel = blk.indent + 1; break; }
          if (blk.indent > 0 && k === insertPos - 1) { indentLevel = blk.indent; break; }
        }
      }

      aiIndentOverrides[matchingBlock.text] = indentLevel;
      moves.push({
        unusedIndex: matchingBlock.domIndex, blockId: matchingBlock.blockId, text: matchingBlock.text,
        insertPos, indentLevel
      });
    }

    // Also extract indent from PROGRAM section
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

    return { moves, aiIndentOverrides: Object.keys(aiIndentOverrides).length > 0 ? aiIndentOverrides : null };
  }

  // ════════════════════════════════════════════════════════════
  //  TYPE A: ACE EDITOR CODE-WRITING CHALLENGES
  // ════════════════════════════════════════════════════════════

  // Placeholder patterns for detection
  const PLACEHOLDER_REGEX_STR = [
    '"""\\s*Your code goes here\\s*"""',
    "'''\\s*Your code goes here\\s*'''",
    '"""\\s*your solution goes here\\s*"""',
    "'''\\s*your solution goes here\\s*'''",
    '"""\\s*Type your code here\\s*"""',
    '/\\*\\s*Your code goes here\\s*\\*/',
    '#\\s*Your code goes here.*',
    '#\\s*Your solution goes here.*',
  ];

  const PLACEHOLDER_DETECT = new RegExp(PLACEHOLDER_REGEX_STR.join('|'), 'i');

  function hasPlaceholder(code) {
    return PLACEHOLDER_DETECT.test(code);
  }

  function findPlaceholderMatch(code) {
    for (const pat of PLACEHOLDER_REGEX_STR) {
      const re = new RegExp(pat, 'i');
      const m = code.match(re);
      if (m) return m[0];
    }
    return null;
  }

  /**
   * Identify read-only (pre-filled) lines in a code-writing challenge.
   *
   * Uses MULTIPLE strategies (cascading) since no single one is reliable:
   *   Strategy 1: ACE gutter-highlight analysis (works when NOT all lines share the class)
   *   Strategy 2: ACE read-only marker ranges via page bridge
   *   Strategy 3: Heuristic analysis of code content (placeholder, blank lines, known patterns)
   *
   * Returns an object: { readOnlyLines: string[], editableLineNumbers: number[],
   *   prefixCode: string, suffixCode: string, allReadOnlyLineTexts: string[] }
   *
   * prefixCode = the read-only lines BEFORE the editable region
   * suffixCode = the read-only lines AFTER the editable region
   * allReadOnlyLineTexts = original text (with indentation) of every read-only line (for indentation-aware duplicate detection)
   */
  async function identifyReadOnlyRegions(el, code) {
    const result = {
      readOnlyLines: [],
      editableLineNumbers: [],
      prefixCode: '',
      suffixCode: '',
      hasReadOnlyRegions: false,
      allReadOnlyLineTexts: []
    };

    const aceEl = el.querySelector('.ace_editor');
    if (!aceEl) return result;

    const codeLines = code.split('\n');
    if (codeLines.length === 0) return result;

    // ── Strategy 1: Gutter-highlight analysis ──
    // zyBooks marks the EDITABLE region with `gutter-highlight` (the lines
    // the student should fill in). Non-highlighted lines are the read-only
    // scaffolding code.
    // If ALL cells are highlighted, the highlight is decorative — fall through.
    const gutterCells = aceEl.querySelectorAll('.ace_gutter-cell');
    let readOnlyFlags = null;

    if (gutterCells.length > 0) {
      const highlightCount = Array.from(gutterCells).filter(c => c.classList.contains('gutter-highlight')).length;
      const totalGutterCells = Math.min(gutterCells.length, codeLines.length);

      // If ALL gutter cells are highlighted, the highlight is decorative, not semantic.
      // Fall through to heuristic analysis.
      if (highlightCount < totalGutterCells) {
        readOnlyFlags = [];
        for (let i = 0; i < totalGutterCells; i++) {
          // INVERTED: gutter-highlight = EDITABLE, so NOT highlighted = read-only
          readOnlyFlags.push(!gutterCells[i].classList.contains('gutter-highlight'));
        }
        console.log('[ZyAgent] Read-only detection: gutter-highlight strategy (highlight = editable)');
      } else {
        console.log('[ZyAgent] Read-only detection: ALL gutter cells highlighted — falling through to heuristic');
      }
    }

    // ── Strategy 2: ACE read-only marker ranges via page bridge ──
    // The bridge can probe the ACE editor API for actual read-only markers/ranges.
    // This is more authoritative than CSS class analysis.
    if (!readOnlyFlags) {
      try {
        const bridgeResult = await Z.getAceReadOnlyRanges(el);
        if (bridgeResult.success && bridgeResult.readOnlyLines && bridgeResult.readOnlyLines.length > 0) {
          const roSet = new Set(bridgeResult.readOnlyLines); // 0-based line numbers
          readOnlyFlags = [];
          for (let i = 0; i < codeLines.length; i++) {
            readOnlyFlags.push(roSet.has(i));
          }
          console.log('[ZyAgent] Read-only detection: bridge strategy (' + bridgeResult.method + ')',
            '— RO lines:', bridgeResult.readOnlyLines.length, 'editable:', bridgeResult.editableLines.length);
        }
      } catch (err) {
        console.warn('[ZyAgent] Read-only detection: bridge strategy failed:', err.message);
      }
    }

    // ── Strategy 3: Heuristic code analysis ──
    // If gutter analysis didn't work, analyze the code structure:
    //   - Lines containing a placeholder (""" Your code goes here """) are editable.
    //   - Blank lines adjacent to placeholders are editable.
    //   - Lines with actual code BEFORE the placeholder region are read-only prefix.
    //   - Lines with actual code AFTER the editable region are read-only suffix.
    //   - If no placeholder, look for editable blank-line regions between code.
    if (!readOnlyFlags) {
      readOnlyFlags = [];

      // Check for placeholder
      const placeholderLineIdx = codeLines.findIndex(l => PLACEHOLDER_DETECT.test(l));

      if (placeholderLineIdx >= 0) {
        // Mark everything outside the placeholder line as read-only
        for (let i = 0; i < codeLines.length; i++) {
          readOnlyFlags.push(i !== placeholderLineIdx);
        }
        console.log('[ZyAgent] Read-only detection: placeholder heuristic');
      } else {
        // No placeholder — look for contiguous blank/comment-only lines that form the editable region.
        // In zyBooks challenge activities, the pattern is usually:
        //   [read-only prefix lines]
        //   [blank lines or "# Your code here" — editable region]
        //   [read-only suffix lines (optional)]
        //
        // We identify the editable region by finding:
        //   - Blank lines or lines with only a comment like "# ..."
        //   - The region between the last non-blank prefix line and first non-blank suffix line
        //
        // Additional heuristic: if the prompt area says "Write a loop that..." and the code
        // has setup variables followed by blank lines, those blanks are the editable area.

        let firstBlankRun = -1;
        let lastBlankRun = -1;

        for (let i = 0; i < codeLines.length; i++) {
          const trimmed = codeLines[i].trim();
          if (trimmed === '' || trimmed.startsWith('# Your') || trimmed.startsWith('# your') || trimmed === '#') {
            if (firstBlankRun === -1) firstBlankRun = i;
            lastBlankRun = i;
          }
        }

        if (firstBlankRun >= 0) {
          // Everything before first blank run is prefix, everything after last blank run is suffix
          for (let i = 0; i < codeLines.length; i++) {
            readOnlyFlags.push(i < firstBlankRun || i > lastBlankRun);
          }
          console.log('[ZyAgent] Read-only detection: blank-region heuristic',
            `editable lines ${firstBlankRun}-${lastBlankRun}`);
        } else {
          // Can't determine read-only regions — treat entire code as editable
          for (let i = 0; i < codeLines.length; i++) {
            readOnlyFlags.push(false);
          }
          console.log('[ZyAgent] Read-only detection: no read-only regions detected');
        }
      }
    }

    // Build result from readOnlyFlags
    for (let i = 0; i < readOnlyFlags.length && i < codeLines.length; i++) {
      if (readOnlyFlags[i]) {
        result.readOnlyLines.push(codeLines[i]);
        // Store original text (with indentation) so dedup can be indentation-aware
        result.allReadOnlyLineTexts.push(codeLines[i]);
      } else {
        result.editableLineNumbers.push(i + 1); // 1-based
      }
    }

    result.hasReadOnlyRegions = result.readOnlyLines.length > 0;

    if (!result.hasReadOnlyRegions) return result;

    // Find the first and last editable line to determine prefix/suffix
    const firstEditable = readOnlyFlags.indexOf(false);
    const lastEditable = readOnlyFlags.lastIndexOf(false);

    if (firstEditable > 0) {
      result.prefixCode = codeLines.slice(0, firstEditable).join('\n');
    }
    if (lastEditable >= 0 && lastEditable < codeLines.length - 1) {
      result.suffixCode = codeLines.slice(lastEditable + 1).join('\n');
    }

    return result;
  }

  /**
   * Validate and clean AI-generated Python code before inserting into the editor.
   * Catches common AI mistakes:
   *   - Trailing colons after print()/return/assignment statements
   *   - Duplicated read-only lines
   *   - Obvious syntax issues
   *
   * @param {string} code - The AI-generated code
   * @param {object} roInfo - Read-only region info from identifyReadOnlyRegions
   * @param {string} originalCode - The original editor code (for duplicate detection)
   * @returns {string} Cleaned code
   */
  function validateAndCleanCode(code, roInfo, originalCode) {
    let lines = code.split('\n');

    // ── Fix trailing colons on non-block statements ──
    // AI sometimes adds colons after print(), return, assignment, etc.
    // Valid colon-ending lines: while, for, if, elif, else, def, class, try, except, finally, with
    const BLOCK_STARTERS = /^\s*(while|for|if|elif|else|def|class|try|except|finally|with)\b/;
    lines = lines.map(line => {
      const trimmed = line.trimEnd();
      if (trimmed.endsWith(':') && !BLOCK_STARTERS.test(trimmed)) {
        // Check it's not a slice, dict literal, or lambda
        // Simple heuristic: if the line has print(, =, return, or similar, strip the colon
        if (/\b(print|return|break|continue|pass)\s*\(/.test(trimmed) ||
            /[+\-*/%]=/.test(trimmed) ||
            (/=\s/.test(trimmed) && !trimmed.includes('==') && !trimmed.includes('!=') && !trimmed.includes('<=') && !trimmed.includes('>='))) {
          console.log('[ZyAgent] Fixing trailing colon on non-block statement:', trimmed);
          return line.replace(/:(\s*)$/, '$1');
        }
      }
      return line;
    });

    // ── Remove duplicated read-only lines ──
    // AI often includes the read-only prefix/suffix lines in its response,
    // causing them to be doubled when assembled. We strip ANY occurrence of
    // an exact read-only line from the AI response.
    if (roInfo && roInfo.allReadOnlyLineTexts && roInfo.allReadOnlyLineTexts.length > 0) {
      // Build a map of read-only lines: trimmed text → set of original indentation levels
      const roMap = new Map(); // trimmed → Set of leading-whitespace strings
      for (const t of roInfo.allReadOnlyLineTexts) {
        if (t.trim() === '') continue;
        const trimmed = t.trim();
        if (!roMap.has(trimmed)) roMap.set(trimmed, new Set());
        const leadingWS = t.match(/^(\s*)/)[1];
        roMap.get(trimmed).add(leadingWS);
      }

      const filtered = [];
      let strippedCount = 0;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') { filtered.push(line); continue; }

        if (roMap.has(trimmed)) {
          const leadingWS = line.match(/^(\s*)/)[1];
          const roIndents = roMap.get(trimmed);

          // Only strip if the line has the SAME indentation as the read-only original.
          // This prevents stripping intentional re-use of a statement at a deeper
          // indentation level (e.g., `input_word = input()` inside a while loop body
          // when the same statement is also a read-only prefix line at col 0).
          if (roIndents.has(leadingWS)) {
            console.log('[ZyAgent] Stripping duplicated read-only line from AI response:', JSON.stringify(line));
            strippedCount++;
            continue;
          }
        }
        filtered.push(line);
      }

      if (strippedCount > 0) {
        console.log(`[ZyAgent] Stripped ${strippedCount} duplicated read-only line(s) from AI response`);
        lines = filtered;
      }
    }

    // ── Remove empty trailing lines (but keep one trailing newline) ──
    while (lines.length > 1 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }

    return lines.join('\n');
  }

  /* ── Wait for Check / Run button (code-writing style) ── */
  // Some challenges use a "Check" button inside .check-next-container,
  // while others use a "Run" button inside .under-editor .button-row.
  // This function finds whichever is available and enabled.
  async function waitForCheckEnabled(el, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Strategy 1: Classic "Check" button in .check-next-container
      const checkBtn =
        el.querySelector('.check-next-container button.check:not([disabled])') ||
        el.querySelector('.check-next-container button.zb-button.check:not([disabled])') ||
        el.querySelector('.check-next-container button.zb-button.primary:not([disabled])');
      if (checkBtn && checkBtn.innerText.trim().toLowerCase().includes('check')) return checkBtn;

      // Strategy 2: "Run" button in .button-row (under-editor style)
      const runBtnRow = el.querySelector('.under-editor .button-row button.zb-button.primary:not([disabled])') ||
        el.querySelector('.button-row button.zb-button.primary.run-button:not([disabled])') ||
        el.querySelector('.button-row button.run-button:not([disabled])');
      if (runBtnRow) {
        const txt = runBtnRow.innerText.trim().toLowerCase();
        if (txt.includes('run') || txt.includes('submit')) return runBtnRow;
      }

      // Strategy 3: Any primary enabled button whose text is "Check" or "Run"
      const allBtns = el.querySelectorAll('button.zb-button.primary:not([disabled])');
      for (const btn of allBtns) {
        const txt = btn.innerText.trim().toLowerCase();
        if (txt === 'check' || txt === 'run') return btn;
      }

      await Z.sleep(300);
    }
    return null;
  }

  /* ── Wait for feedback (code-writing style) ── */
  // Handles both "Check" style (feedback in .check-next-container) and
  // "Run" style (test results in .tests, feedback in .under-editor).
  async function waitForCodeWritingFeedback(el, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // "Next level" button enabled = PASSED (classic check-next-container)
      const checkNextBtns = el.querySelectorAll('.check-next-container button.zb-button:not([disabled])');
      for (const btn of checkNextBtns) {
        if (btn.innerText.trim().toLowerCase().includes('next')) return 'correct';
      }

      // "Next" button anywhere in the activity (for Run-style challenges)
      const allBtns = el.querySelectorAll('button.zb-button:not([disabled])');
      for (const btn of allBtns) {
        const txt = btn.innerText.trim().toLowerCase();
        if (txt.includes('next') && !txt.includes('start')) return 'correct';
      }

      // code-explanation feedback
      const codeExplanation = el.querySelector('.code-explanation');
      if (codeExplanation && codeExplanation.offsetParent !== null) {
        const text = codeExplanation.innerText.toLowerCase();
        if (text.includes('not all tests passed')) return 'incorrect';
        if (text.includes('error')) return 'incorrect';
      }

      // Failed tests — .test-header with fail/X icon
      const failedTests = el.querySelectorAll('.test-header.fail, .test-header[aria-label*="failed"]');
      if (failedTests.length > 0) return 'incorrect';

      // Test results with clear/X icons (Run-style challenges)
      // Look for test results that have appeared with pass/fail indicators
      const testResults = el.querySelectorAll('.tests .test-result, .test-result');
      if (testResults.length > 0) {
        let anyFailed = false;
        let anyPassed = false;
        let allChecked = true;
        for (const tr of testResults) {
          const header = tr.querySelector('.test-header');
          if (!header) { allChecked = false; continue; }
          const headerText = header.innerText.toLowerCase();
          const headerClasses = header.className.toLowerCase();
          const headerIcon = header.querySelector('i, .ph-x-circle, .ph-check-circle, .ph-x, .ph-check');
          const iconClass = headerIcon ? headerIcon.className.toLowerCase() : '';

          if (headerClasses.includes('fail') || headerText.includes('✗') ||
              iconClass.includes('x-circle') || iconClass.includes('ph-x')) {
            anyFailed = true;
          } else if (headerClasses.includes('pass') || headerText.includes('✓') ||
                     iconClass.includes('check-circle') || iconClass.includes('ph-check')) {
            anyPassed = true;
          } else {
            allChecked = false;
          }
        }
        // Only return once we've seen feedback for at least some tests
        if (anyFailed) return 'incorrect';
        if (anyPassed && allChecked && !anyFailed) return 'correct';
      }

      // "Your program produced no output" or similar messages
      const noOutputMsg = el.querySelector('.no-output-result, .expected-output-test-result');
      if (noOutputMsg && noOutputMsg.offsetParent !== null) {
        const text = noOutputMsg.innerText.toLowerCase();
        if (text.includes('no output') || text.includes('error')) return 'incorrect';
      }

      // Error output
      const errorOutputs = el.querySelectorAll('.error-output');
      for (const eo of errorOutputs) {
        if (eo.innerText.trim().length > 0 && eo.offsetParent !== null) return 'incorrect';
      }

      // Level chevron completed
      const activeLevel = el.querySelector('.levels-bar .level.active-level');
      if (activeLevel) {
        const levelIdx = Array.from(el.querySelectorAll('.levels-bar .level')).indexOf(activeLevel);
        const chevrons = el.querySelectorAll('.chevron-container .question-chevron.zb-chevron');
        if (chevrons[levelIdx]) {
          const label = (chevrons[levelIdx].getAttribute('aria-label') || '').toLowerCase();
          if (label.includes('completed') && !label.includes('not completed')) return 'correct';
        }
      }

      if (Z.checkCompletion(el)) return 'correct';
      await Z.sleep(500);
    }
    return 'timeout';
  }

  async function handleCodeWriting(activity, settings) {
    const el = activity.element;

    if (Z.checkCompletion(el)) {
      Z.sendProgress(0, 0, `Challenge "${activity.title}" already completed, skipping`, 'info');
      return;
    }

    const levelButtons = el.querySelectorAll('.levels-bar .level');
    const totalLevels = levelButtons.length || 1;
    Z.sendProgress(0, totalLevels, `Code challenge "${activity.title}" — ${totalLevels} level(s)`);

    const aceTag = Z.tagAceEditor(el);
    if (!aceTag) {
      Z.sendProgress(0, totalLevels, 'No ACE editor found in challenge', 'error');
      return;
    }

    // Click Start if present
    const startBtn = el.querySelector('button.zb-button.primary:not([disabled]):not(.check)');
    if (startBtn && startBtn.innerText.trim().toLowerCase() === 'start') {
      startBtn.click();
      Z.sendProgress(0, totalLevels, 'Clicked Start');
      await Z.sleep(1500);
    }

    // ── Skip already-completed levels ──
    const startLevel = await findFirstIncompleteLevel(el, totalLevels);

    for (let level = startLevel; level < totalLevels; level++) {
      if (Z.shouldStop) break;

      if (Z.checkCompletion(el)) {
        Z.sendProgress(totalLevels, totalLevels, `Challenge "${activity.title}" completed!`, 'success');
        return;
      }

      Z.sendProgress(level + 1, totalLevels, `Working on level ${level + 1}/${totalLevels}`);

      // Dismiss any stale modal dialogs before starting the level
      await dismissAnyModal(el);

      const promptEl = el.querySelector('.code-writing-prompt') ||
        el.querySelector('.challenge-instructions') ||
        el.querySelector('.instructions') ||
        el.querySelector('.develop-instructions');
      const currentPrompt = promptEl ? promptEl.innerText.trim() : '';

      // Also gather test case descriptions if present (Run-button style)
      const testDescriptions = [];
      const testEls = el.querySelectorAll('.tests .test-result .test-text, .test-description, .test-case-description');
      for (const te of testEls) {
        const text = te.innerText.trim();
        if (text) testDescriptions.push(text);
      }
      const testInfo = testDescriptions.length > 0 ? '\nTest cases:\n' + testDescriptions.join('\n') : '';

      await Z.sleep(1000);

      // Read the original/pristine code for this level ONCE — used for reset on retry
      const originalCode = await Z.getAceEditorValue(el);

      // Identify read-only regions (pre-filled code that cannot be edited)
      const roInfo = await identifyReadOnlyRegions(el, originalCode);
      if (roInfo.hasReadOnlyRegions) {
        console.log('[ZyAgent] Detected read-only regions:',
          'prefix:', JSON.stringify(roInfo.prefixCode),
          'suffix:', JSON.stringify(roInfo.suffixCode),
          'editable lines:', roInfo.editableLineNumbers);
      }

      const maxRetries = 3;
      let passed = false;
      let lastFeedback = '';
      // Track the placeholder text from the original code — used for all attempts
      const originalPlaceholderText = findPlaceholderMatch(originalCode);
      const originalHasPlaceholder = hasPlaceholder(originalCode);

      for (let attempt = 0; attempt < maxRetries && !passed && !Z.shouldStop; attempt++) {
        const isRetry = attempt > 0;

        // ── CRITICAL: Reset editor to original state before each retry ──
        // This prevents failed attempts from compounding (double code blocks).
        if (isRetry) {
          // Dismiss any modal dialogs that may be lingering from the failed attempt
          await dismissAnyModal(el);

          console.log('[ZyAgent] Resetting editor to original code before retry attempt', attempt + 1);
          let resetSucceeded = false;

          // Strategy 1: Use "Jump to level N" button (the most reliable reset for
          // editors with read-only regions, since setValue may not work)
          const jumpBtn = el.querySelector('.progression-container button.zb-button.secondary');
          if (jumpBtn && jumpBtn.innerText.toLowerCase().includes('jump to level')) {
            console.log('[ZyAgent] Reset via Jump to level button');
            jumpBtn.click();
            await Z.sleep(1000);

            // Handle the "Level jump" confirmation modal
            await dismissOrConfirmJumpModal(true); // true = confirm the jump
            await Z.sleep(2000);

            // Verify the placeholder is back
            const afterJump = await Z.getAceEditorValue(el);
            if (afterJump && hasPlaceholder(afterJump)) {
              resetSucceeded = true;
              console.log('[ZyAgent] Reset via Jump succeeded — placeholder restored');
            }
          }

          // Strategy 2: Direct setValue (works for editors without read-only regions)
          if (!resetSucceeded) {
            await Z.setAceEditorValue(el, originalCode);
            await Z.sleep(800);

            const resetVerify = await Z.getAceEditorValue(el);
            if (resetVerify) {
              // Check 1: does it match the original?
              if (resetVerify.trim() === originalCode.trim()) {
                resetSucceeded = true;
              }
              // Check 2: does it at least have the placeholder?
              else if (originalHasPlaceholder && hasPlaceholder(resetVerify)) {
                resetSucceeded = true;
              }
              // Check 3: is the line count sane? (detect runaway concatenation)
              else {
                const originalLineCount = originalCode.split('\n').length;
                const currentLineCount = resetVerify.split('\n').length;
                if (currentLineCount > originalLineCount * 3) {
                  console.error(`[ZyAgent] Editor is corrupted (${currentLineCount} lines vs expected ${originalLineCount}). Attempting nuclear reset.`);
                  // Try setValue one more time
                  await Z.setAceEditorValue(el, originalCode);
                  await Z.sleep(500);
                }
              }
            }
          }

          if (!resetSucceeded) {
            console.warn('[ZyAgent] Editor reset could not be verified — reading actual editor state');
          }
        }

        // ── Always read the ACTUAL editor content for this attempt ──
        // On retry, don't trust originalCode — read what's actually in the editor,
        // because setValue may have silently failed on read-only editors.
        const currentCode = await Z.getAceEditorValue(el) || originalCode;
        const codeHasPlaceholder = hasPlaceholder(currentCode);
        const placeholderText = findPlaceholderMatch(currentCode);

        // ── Sanity check: detect runaway code (editor corruption) ──
        const originalLineCount = originalCode.split('\n').length;
        const currentLineCount = currentCode.split('\n').length;
        if (currentLineCount > originalLineCount * 3) {
          console.error(`[ZyAgent] Editor appears corrupted (${currentLineCount} lines). Aborting level.`);
          Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Editor corrupted, skipping`, 'error');
          break;
        }

        // ── If placeholder is gone on retry, we can't use find-replace ──
        // Fall back to treating it as a non-placeholder code replacement
        if (isRetry && originalHasPlaceholder && !codeHasPlaceholder) {
          console.warn('[ZyAgent] Placeholder was lost after reset — treating as full code replacement');
        }

        Z.sendProgress(level + 1, totalLevels,
          `Level ${level + 1}, attempt ${attempt + 1}: ${codeHasPlaceholder ? 'Found placeholder' : 'Writing full code'}`);

        let messages;

        if (codeHasPlaceholder) {
          const lines = currentCode.split('\n');
          const placeholderLineIdx = lines.findIndex(l => l.includes(placeholderText));
          const placeholderLine = placeholderLineIdx >= 0 ? lines[placeholderLineIdx] : '';

          let beforePlaceholder = '';
          let afterPlaceholder = '';
          if (placeholderLine && placeholderText) {
            const phIdx = placeholderLine.indexOf(placeholderText);
            beforePlaceholder = placeholderLine.substring(0, phIdx).trim();
            afterPlaceholder = placeholderLine.substring(phIdx + placeholderText.length).trim();
          }

          messages = [
            {
              role: 'system',
              content: `You are an expert Python programmer solving a zyBooks challenge.

${Z.ZYBOOKS_OUTPUT_RULES}

The editor has code with a placeholder: ${placeholderText}
The placeholder appears on this line: ${placeholderLine.trim()}

${beforePlaceholder ? `Text BEFORE the placeholder on the same line: "${beforePlaceholder}"` : ''}
${afterPlaceholder ? `Text AFTER the placeholder on the same line: "${afterPlaceholder}"` : ''}

You must respond with ONLY the text that replaces the placeholder.
Do NOT include the surrounding code. Do NOT include "${beforePlaceholder}" or "${afterPlaceholder}".
Do NOT wrap in backticks or code fences. Just the raw replacement text.
IMPORTANT: If the replacement is multiple lines of code, use ACTUAL line breaks — do NOT write literal "\\n" escape sequences. Each line of Python code must be on its own line in your response, with proper indentation using spaces (not tabs).
IMPORTANT: Do NOT add trailing colons on print(), assignment, or other non-block statements. Only while, for, if, elif, else, def, class, try, except, finally, with end with colons.

CRITICAL: The replacement must produce VALID Python syntax when inserted into the line.
For example:
  - Line: for i """ Your code goes here """:  →  You respond: in range(1, 10)
    (Note: "in" keyword is REQUIRED for a valid for loop)
  - Line: while """ Your code goes here """:  →  You respond: x < 10
  - Line: x = """ Your code goes here """  →  You respond: int(input())

EXAMPLE: if the line is: while """ Your code goes here """:
And the task says "loop while x < 10", respond with ONLY: x < 10
${isRetry ? `\nYour previous answer was WRONG. Study the DETAILED FEEDBACK below carefully.
The feedback includes the error message, test case results, and your submitted code.
IMPORTANT: Look at the EXACT error. If it's a SyntaxError, your replacement created invalid Python.
Check that the line reads correctly when your replacement is inserted.
Fix your answer based on the feedback:` : ''}`
            },
            {
              role: 'user',
              content: [
                `TASK: ${currentPrompt}`,
                testInfo,
                `\nFULL CODE:\n${currentCode}`,
                `\nPLACEHOLDER: ${placeholderText}`,
                `LINE: ${placeholderLine.trim()}`,
                isRetry && lastFeedback ? `\n=== DETAILED FEEDBACK FROM WRONG ANSWER ===\n${lastFeedback}\n=== END FEEDBACK ===` : '',
                `\nRespond with ONLY the replacement. Nothing else.`
              ].filter(Boolean).join('\n')
            }
          ];
        } else {
          // No placeholder found — the editor has blank/editable lines for the user to fill in.
          // If there are read-only regions, we must tell the AI to write ONLY the editable part.

          if (roInfo.hasReadOnlyRegions) {
            // ── Read-only aware prompt ──
            // The editor has pre-filled read-only code (prefix and/or suffix).
            // The AI must write ONLY the editable portion — the read-only code
            // will already be executed and MUST NOT be repeated.

            // Build clear structural representation showing prefix → editable → suffix
            const prefixLines = roInfo.prefixCode ? roInfo.prefixCode.split('\n') : [];
            const suffixLines = roInfo.suffixCode ? roInfo.suffixCode.split('\n') : [];
            const editableLines = currentCode.split('\n').filter((_, i) =>
              roInfo.editableLineNumbers.includes(i + 1)
            );

            const structureDisplay = [];
            if (prefixLines.length > 0) {
              structureDisplay.push('--- READ-ONLY PREFIX (already exists, do NOT repeat) ---');
              prefixLines.forEach(l => structureDisplay.push(`  ${l}`));
            }
            structureDisplay.push('--- YOUR CODE GOES HERE (write ONLY this part) ---');
            editableLines.forEach(l => structureDisplay.push(`  ${l || '(blank line to fill)'}`));
            structureDisplay.push('--- END YOUR CODE ---');
            if (suffixLines.length > 0) {
              structureDisplay.push('--- READ-ONLY SUFFIX (already exists, do NOT repeat) ---');
              suffixLines.forEach(l => structureDisplay.push(`  ${l}`));
            }

            // List the exact lines that are read-only so the AI knows to avoid them
            const roLinesList = roInfo.allReadOnlyLineTexts.filter(t => t.trim() !== '').map(t => `"${t.trim()}"`);

            messages = [
              {
                role: 'system',
                content: `You are an expert Python programmer solving a zyBooks challenge activity.

RESPONSE FORMAT: Raw Python code ONLY. No markdown, no backticks, no explanations.

CRITICAL RULES:
1. The editor has PRE-FILLED READ-ONLY code that CANNOT be edited and is ALREADY present.
2. You must write ONLY the code for the EDITABLE section.
3. DO NOT repeat ANY of these read-only lines in your response: ${roLinesList.join(', ')}
4. If you include read-only lines, they will be DUPLICATED causing the code to be wrong.
5. Your code will be INSERTED between the read-only prefix and suffix.
6. Use proper Python indentation (spaces, not tabs).
7. Do NOT add trailing colons on print(), assignment, or non-block statements.
8. Each line of Python code must be on its own line (use real line breaks, not \\n).

${Z.ZYBOOKS_OUTPUT_RULES}
${isRetry ? `\nYour previous attempt was WRONG. Study the feedback VERY carefully.
The feedback includes your submitted code and the exact error messages or wrong output.
If there's a SyntaxError, your code has invalid Python syntax — check for missing keywords, parentheses, etc.
If the output is wrong, compare your output line-by-line with expected output.
IMPORTANT: Do NOT just keep adding more code — write a CLEAN, CORRECT solution from scratch.` : ''}`
              },
              {
                role: 'user',
                content: [
                  `TASK: ${currentPrompt}`,
                  testInfo,
                  `\nEDITOR STRUCTURE:\n${structureDisplay.join('\n')}`,
                  `\nREMEMBER: Write ONLY the code for the "YOUR CODE GOES HERE" section.`,
                  `These specific lines are read-only and MUST NOT appear in your answer: ${roLinesList.join(', ')}`,
                  isRetry && lastFeedback ? `\n=== DETAILED FEEDBACK FROM WRONG ANSWER ===\n${lastFeedback}\n=== END FEEDBACK ===` : '',
                  `\nYour response (ONLY the editable code, nothing else):`
                ].filter(Boolean).join('\n')
              }
            ];
          } else {
            // No read-only regions and no placeholder — full code replacement
            messages = [
              {
                role: 'system',
                content: `You are an expert Python programmer. Return COMPLETE corrected Python code.
No markdown, no backticks. ONLY raw Python code.
Do NOT add trailing colons on print(), assignment, or other non-block statements.
IMPORTANT: Do NOT duplicate any existing setup code. Write clean, minimal code.

${Z.ZYBOOKS_OUTPUT_RULES}
${isRetry ? `\nPrevious answer was WRONG. Study the DETAILED FEEDBACK below carefully.
It includes your submitted code and the exact error messages or test results.
If there's a SyntaxError, your code has invalid Python syntax — fix it.
If the output is wrong, compare your output line-by-line with expected output.
IMPORTANT: Write a CLEAN solution from scratch. Do NOT keep appending code from previous attempts.` : ''}`
              },
              {
                role: 'user',
                content: [
                  `TASK: ${currentPrompt}`,
                  testInfo,
                  `\nCurrent code:\n${currentCode}`,
                  isRetry && lastFeedback ? `\n=== DETAILED FEEDBACK FROM WRONG ANSWER ===\n${lastFeedback}\n=== END FEEDBACK ===` : '',
                  `\nReturn corrected code.`
                ].filter(Boolean).join('\n')
              }
            ];
          }
        }

        const response = await Z.callAI(settings, messages);
        let cleanResponse = response
          .replace(/^```(?:python)?\n?/gm, '')
          .replace(/```\s*$/gm, '')
          .trim();

        // ── Fix literal escape sequences ──
        // The AI sometimes returns literal "\n" (backslash + n) instead of actual
        // newlines, especially for multi-line placeholder replacements. Convert
        // common escape sequences to their real characters.
        // Only do this if the response contains literal \n but no actual newlines
        // (i.e., everything is on one line when it shouldn't be).
        if (cleanResponse.includes('\\n') && !cleanResponse.includes('\n')) {
          console.log('[ZyAgent] Code response has literal \\n — converting to real newlines');
          cleanResponse = cleanResponse
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t');
        }
        // Also handle the case where SOME lines are real and some have \n embedded
        // e.g., "line1\n    line2\n    line3" mixed in with real newlines
        else if (cleanResponse.includes('\\n')) {
          // Check if any single line contains \n — that line likely has collapsed code
          const lines = cleanResponse.split('\n');
          const fixedLines = lines.map(line => {
            if (line.includes('\\n')) {
              // This line has literal \n — expand it
              return line.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
            }
            return line;
          });
          cleanResponse = fixedLines.join('\n');
        }

        // ── Validate and clean the AI response ──
        // Fix common issues: trailing colons on non-block statements,
        // duplicated read-only lines, etc.
        cleanResponse = validateAndCleanCode(cleanResponse, roInfo, originalCode);

        console.log('[ZyAgent] AI code response (cleaned):', JSON.stringify(cleanResponse));

        let writeSuccess = false;

        if (codeHasPlaceholder && placeholderText) {
          // Method 1: ACE find-replace (best — preserves read-only regions)
          writeSuccess = await Z.aceEditorFindReplace(el, placeholderText, cleanResponse);
          console.log('[ZyAgent] Method 1 (find-replace):', writeSuccess ? 'SUCCESS' : 'failed', '| needle:', JSON.stringify(placeholderText));

          // Method 2: Full code replacement via setValue
          if (!writeSuccess) {
            Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: find-replace failed — trying setValue`, 'warn');
            const fallbackCode = currentCode.replace(placeholderText, cleanResponse);
            writeSuccess = await Z.setAceEditorValue(el, fallbackCode);
            console.log('[ZyAgent] Method 2 (setValue full code):', writeSuccess ? 'SUCCESS' : 'failed');
          }

          // Method 3: Try variations of the placeholder text
          // (zyBooks sometimes uses different quote styles or whitespace)
          if (!writeSuccess) {
            const variations = [
              '""" Your code goes here """',
              "''' Your code goes here '''",
              '"""Your code goes here"""',
              "'''Your code goes here'''",
              '""" your code goes here """',
              "''' your code goes here '''",
              '""" Your solution goes here """',
              "''' Your solution goes here '''",
              '"""Your solution goes here"""',
              "'''Your solution goes here'''",
              '""" your solution goes here """',
              "''' your solution goes here '''",
              '# Your code goes here',
              '# your code goes here',
              '# Your solution goes here',
              '# your solution goes here',
            ];
            for (const variant of variations) {
              writeSuccess = await Z.aceEditorFindReplace(el, variant, cleanResponse);
              if (writeSuccess) {
                console.log('[ZyAgent] Placeholder replaced via variant:', variant);
                break;
              }
            }
          }

          // Method 4: Read fresh from editor and try string replace
          if (!writeSuccess) {
            const freshCode = await Z.getAceEditorValue(el);
            if (freshCode) {
              // Find anything that looks like a placeholder
              const placeholderMatch = freshCode.match(/"""[^"]*"""|'''[^']*'''|#\s*[Yy]our\s+code\s+goes\s+here.*/);
              if (placeholderMatch) {
                console.log('[ZyAgent] Found actual placeholder in editor:', JSON.stringify(placeholderMatch[0]));
                writeSuccess = await Z.aceEditorFindReplace(el, placeholderMatch[0], cleanResponse);
                if (!writeSuccess) {
                  const fixedCode = freshCode.replace(placeholderMatch[0], cleanResponse);
                  writeSuccess = await Z.setAceEditorValue(el, fixedCode);
                }
              }
            }
          }

          await Z.sleep(500);
          const verifyCode = await Z.getAceEditorValue(el);
          if (hasPlaceholder(verifyCode)) {
            console.log('[ZyAgent] Placeholder STILL present. Editor content:', JSON.stringify(verifyCode.substring(0, 500)));
            Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: placeholder still present — trying full replace`, 'warn');
            // Last resort: replace the entire editor content
            // Build the full code with AI response where placeholder was
            if (verifyCode) {
              const phMatch = verifyCode.match(/"""[^"]*"""|'''[^']*'''|#\s*[Yy]our\s+(?:code|solution)\s+goes\s+here.*/);
              if (phMatch) {
                const fullCode = verifyCode.replace(phMatch[0], cleanResponse);
                writeSuccess = await Z.setAceEditorValue(el, fullCode);
                await Z.sleep(500);
                const recheck = await Z.getAceEditorValue(el);
                if (hasPlaceholder(recheck)) {
                  Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: all replacement methods failed — cannot write to editor`, 'error');
                  lastFeedback = 'Placeholder was not replaced — editor may be read-only or bridge broken.';
                  // BREAK instead of continue — no point retrying if we can't write to the editor
                  break;
                }
              } else {
                Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: placeholder lost and no replacement target found`, 'error');
                lastFeedback = 'Placeholder was not replaced.';
                break;
              }
            } else {
              lastFeedback = 'Cannot read editor content.';
              break;
            }
          }
        } else if (roInfo.hasReadOnlyRegions) {
          // ── Read-only aware writing ──
          // The AI returned ONLY the editable lines. We must splice them back
          // into the full code, preserving the read-only prefix and suffix.
          // The validateAndCleanCode() call above already stripped duplicated
          // read-only lines, but we do a final safety pass here.

          const prefixLines = roInfo.prefixCode ? roInfo.prefixCode.split('\n') : [];
          const suffixLines = roInfo.suffixCode ? roInfo.suffixCode.split('\n') : [];
          let aiLines = cleanResponse.split('\n');

          // ── Safety: strip any read-only lines the AI may have STILL included ──
          // This catches lines that validateAndCleanCode may have missed
          // (e.g., slightly different whitespace).
          // Build indentation-aware map: trimmed text → set of leading whitespace
          const roNormalized = new Set(
            (roInfo.allReadOnlyLineTexts || []).map(t => t.trim()).filter(t => t !== '')
          );
          const roIndentMap = new Map(); // trimmed → Set of leading-whitespace strings
          for (const t of (roInfo.allReadOnlyLineTexts || [])) {
            if (t.trim() === '') continue;
            const trimmed = t.trim();
            if (!roIndentMap.has(trimmed)) roIndentMap.set(trimmed, new Set());
            const ws = t.match(/^(\s*)/)[1];
            roIndentMap.get(trimmed).add(ws);
          }

          if (roIndentMap.size > 0) {
            const beforeCount = aiLines.length;
            aiLines = aiLines.filter(line => {
              const trimmed = line.trim();
              // Keep blank lines (they might be intentional)
              if (trimmed === '') return true;
              // Only strip if it exactly matches a read-only line AND has the same indentation.
              // This avoids stripping e.g. `input_word = input()` inside a while loop body
              // when the same statement is a read-only prefix at column 0.
              if (roIndentMap.has(trimmed)) {
                const lineWS = line.match(/^(\s*)/)[1];
                if (roIndentMap.get(trimmed).has(lineWS)) {
                  console.log(`[ZyAgent] Assembly: stripping read-only duplicate: "${trimmed}" (indent="${lineWS}")`);
                  return false;
                }
              }
              return true;
            });
            if (aiLines.length < beforeCount) {
              console.log(`[ZyAgent] Assembly: stripped ${beforeCount - aiLines.length} read-only duplicates`);
            }
          }

          // Build the complete code: prefix + AI editable code + suffix
          const assembledLines = [];
          if (prefixLines.length > 0) assembledLines.push(...prefixLines);
          assembledLines.push(...aiLines);
          if (suffixLines.length > 0) assembledLines.push(...suffixLines);

          const assembledCode = assembledLines.join('\n');
          console.log('[ZyAgent] Assembled code with read-only regions preserved:', JSON.stringify(assembledCode));

          // Verify assembled code doesn't have obvious duplications
          // Count how many times each read-only line appears at the SAME indentation
          const assembledCodeLines = assembledCode.split('\n');
          for (const roLine of roNormalized) {
            // Find the original indentation(s) for this RO line
            const originalIndents = roIndentMap.get(roLine) || new Set(['']);
            const count = assembledCodeLines.filter(l => {
              if (l.trim() !== roLine) return false;
              const ws = l.match(/^(\s*)/)[1];
              return originalIndents.has(ws);
            }).length;
            if (count > 1) {
              console.warn(`[ZyAgent] WARNING: Read-only line "${roLine}" appears ${count} times at same indent in assembled code`);
            }
          }

          writeSuccess = await Z.setAceEditorValue(el, assembledCode);

          // ── Verify the write succeeded and code looks correct ──
          if (writeSuccess) {
            await Z.sleep(300);
            const verifyCode = await Z.getAceEditorValue(el);
            if (verifyCode) {
              const verifyCodeLines = verifyCode.split('\n');
              let needsEmergencyDedup = false;
              for (const roLine of roNormalized) {
                const originalIndents = roIndentMap.get(roLine) || new Set(['']);
                const count = verifyCodeLines.filter(l => {
                  if (l.trim() !== roLine) return false;
                  const ws = l.match(/^(\s*)/)[1];
                  return originalIndents.has(ws);
                }).length;
                if (count > 1) {
                  console.warn(`[ZyAgent] Post-write verification: "${roLine}" duplicated ${count}x at same indent — rewriting without duplicates`);
                  needsEmergencyDedup = true;
                  break;
                }
              }
              if (needsEmergencyDedup) {
                // Emergency fix: rebuild code by deduplicating ONLY at same indentation
                const dedupedLines = [];
                const seenRO = new Map(); // "trimmed|indent" → boolean
                for (const line of verifyCodeLines) {
                  const trimmed = line.trim();
                  if (roNormalized.has(trimmed) && trimmed !== '') {
                    const ws = line.match(/^(\s*)/)[1];
                    const originalIndents = roIndentMap.get(trimmed) || new Set(['']);
                    if (originalIndents.has(ws)) {
                      const key = trimmed + '|' + ws;
                      if (seenRO.has(key)) {
                        console.log(`[ZyAgent] Emergency dedup: removing duplicate "${trimmed}" at indent="${ws}"`);
                        continue;
                      }
                      seenRO.set(key, true);
                    }
                  }
                  dedupedLines.push(line);
                }
                await Z.setAceEditorValue(el, dedupedLines.join('\n'));
              }
            }
          }
        } else {
          writeSuccess = await Z.setAceEditorValue(el, cleanResponse);
        }

        if (!writeSuccess) {
          Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Could not write code`, 'error');
          continue;
        }

        await Z.sleep(800);

        // ── CRITICAL: Verify placeholder was actually replaced before submitting ──
        // Without this check, we may submit with the placeholder still in place,
        // which wastes an attempt and produces "no output" results.
        const postWriteCode = await Z.getAceEditorValue(el);
        if (postWriteCode && hasPlaceholder(postWriteCode)) {
          console.error('[ZyAgent] SAFETY CHECK FAILED: placeholder still present after all write methods!');
          console.error('[ZyAgent] Editor content:', JSON.stringify(postWriteCode.substring(0, 500)));
          Z.sendProgress(level + 1, totalLevels,
            `Level ${level + 1}: Code not written to editor (placeholder still present) — retrying`, 'warn');

          // Try one more emergency write: read fresh, do raw string replacement, setValue
          const freshPH = findPlaceholderMatch(postWriteCode);
          if (freshPH) {
            const emergencyCode = postWriteCode.replace(freshPH, cleanResponse);
            const emergencySuccess = await Z.setAceEditorValue(el, emergencyCode);
            await Z.sleep(500);
            const emergencyVerify = await Z.getAceEditorValue(el);
            if (!emergencySuccess || (emergencyVerify && hasPlaceholder(emergencyVerify))) {
              console.error('[ZyAgent] Emergency write also failed. Skipping this attempt.');
              lastFeedback = 'Could not write code to editor — all methods failed.';
              continue; // Skip to next attempt without clicking Check
            }
            console.log('[ZyAgent] Emergency write succeeded');
          } else {
            lastFeedback = 'Placeholder present but could not locate it for replacement.';
            continue;
          }
        }

        // ── Pre-check sanity: verify the editor isn't corrupted ──
        const preCheckCode = postWriteCode || await Z.getAceEditorValue(el);
        if (preCheckCode) {
          const preCheckLineCount = preCheckCode.split('\n').length;
          if (preCheckLineCount > originalLineCount * 4) {
            console.error(`[ZyAgent] Editor corrupted before Check (${preCheckLineCount} lines). Aborting.`);
            Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Editor corrupted (${preCheckLineCount} lines), aborting`, 'error');
            break;
          }
        }

        const checkBtn = await waitForCheckEnabled(el);
        let clickedBtn = checkBtn;
        if (!checkBtn) {
          const aceEl = el.querySelector('.ace_editor');
          if (aceEl) aceEl.click();
          await Z.sleep(1000);
          const retryCheck = await waitForCheckEnabled(el, 8000);
          if (!retryCheck) {
            Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: No Check/Run button found`, 'error');
            continue;
          }
          console.log('[ZyAgent] Found button after ace click:', retryCheck.innerText.trim());
          retryCheck.click();
          clickedBtn = retryCheck;
        } else {
          console.log('[ZyAgent] Clicking button:', checkBtn.innerText.trim());
          checkBtn.click();
        }

        // Determine if this was a "Run" button — may need to wait for execution
        const clickedBtnText = clickedBtn ? clickedBtn.innerText.trim().toLowerCase() : '';
        const isRunButton = clickedBtnText.includes('run');

        Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: ${isRunButton ? 'Running' : 'Checking'}… (attempt ${attempt + 1}/${maxRetries})`);

        if (isRunButton) {
          // For Run-button activities, wait for execution to finish first
          // (the Run button may become disabled during execution)
          const execStart = Date.now();
          await Z.sleep(1000); // Let execution start
          while (Date.now() - execStart < 30000) {
            const runningBtn = el.querySelector('.button-row button.zb-button.primary[disabled]') ||
              el.querySelector('.button-row button.run-button[disabled]') ||
              el.querySelector('.button-row .is-running');
            if (!runningBtn) break;
            await Z.sleep(500);
          }
          await Z.sleep(1500); // Extra time for test results to render
        } else {
          // Classic Check button — wait for server-side execution
          await Z.sleep(3500);
        }

        const result = await waitForCodeWritingFeedback(el);

        if (result === 'correct') {
          passed = true;
          Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Correct! ✓`, 'success');
        } else {
          lastFeedback = gatherFeedback(el);

          // Also capture the actual submitted code so the AI can see exactly what it wrote
          try {
            const submittedCode = await Z.getAceEditorValue(el);
            if (submittedCode) {
              lastFeedback += '\n\n=== YOUR SUBMITTED CODE ===\n' + submittedCode + '\n=== END SUBMITTED CODE ===';
            }
          } catch (e) {
            // Not critical
          }

          console.log('[ZyAgent] Code-writing feedback:', lastFeedback);

          // Capture screenshot for additional visual context on retry
          if (attempt < maxRetries - 1) {
            try {
              const visualAnalysis = await Z.analyzeScreenshot(settings,
                'You are analyzing a zyBooks code challenge result. Look at the screenshot and describe: 1) What error or test failure is shown? 2) What is the expected vs actual output? 3) Any hints visible?',
                'Analyze this code challenge result screenshot. What went wrong?'
              );
              if (visualAnalysis) {
                lastFeedback += '\n\nVISUAL ANALYSIS:\n' + visualAnalysis;
              }
            } catch (err) {
              // Screenshot is optional — continue without it
            }
          }

          Z.sendProgress(level + 1, totalLevels,
            `Level ${level + 1}: Incorrect (attempt ${attempt + 1}/${maxRetries})`, 'warn');

          if (attempt < maxRetries - 1) {
            // NOTE: We do NOT click "Jump to level" button here.
            // It triggers a modal dialog that disrupts the retry flow.
            // Instead, the editor is reset via setAceEditorValue at the
            // top of the retry loop, which is cleaner and more reliable.

            // Dismiss any modal dialogs that may be open
            // (e.g., "Level jump" confirmation from accidental clicks)
            await dismissAnyModal(el);

            await Z.sleep(500);
          }
        }
      }

      if (!passed) {
        Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Failed after ${maxRetries} attempts. Stopping.`, 'error');
        return;
      }

      if (level < totalLevels - 1) {
        await Z.sleep(1500);
        // Wait for Next button to become enabled — check multiple locations
        const nextBtn = await Z.waitForCondition(() => {
          // Classic: .check-next-container
          const checkNextBtns = el.querySelectorAll('.check-next-container button.zb-button:not([disabled])');
          for (const btn of checkNextBtns) {
            if (btn.innerText.trim().toLowerCase().includes('next')) return btn;
          }
          // Broader: any "Next" button in the activity
          const allBtns = el.querySelectorAll('button.zb-button:not([disabled])');
          for (const btn of allBtns) {
            const txt = btn.innerText.trim().toLowerCase();
            if (txt.includes('next') && !txt.includes('start')) return btn;
          }
          return null;
        }, { timeout: 8000 });

        if (nextBtn) {
          nextBtn.click();
          Z.sendProgress(level + 1, totalLevels, `Advancing to level ${level + 2}`);
          await Z.sleep(2500); // longer wait for next level to render
        } else {
          Z.sendProgress(level + 1, totalLevels, `Could not find Next button after level ${level + 1}`, 'warn');
        }
      }
    }

    if (Z.checkCompletion(el)) {
      Z.sendProgress(totalLevels, totalLevels, `Challenge "${activity.title}" completed!`, 'success');
    }
  }

  // ════════════════════════════════════════════════════════════
  //  MAIN ENTRY POINT — detect sub-type and dispatch
  // ════════════════════════════════════════════════════════════

  Z.handleChallenge = async function (activity, settings) {
    const el = activity.element;

    // Detect sub-type:
    const hasProgression = el.querySelector('.zyante-progression-start-button, .zyante-progression-check-button');
    const hasAceEditor = el.querySelector('.ace_editor');
    const hasOutputTextarea = el.querySelector('textarea.console');
    const hasParsons = el.querySelector('.two-reorderable-lists, .parsons-coding-pa');

    if (hasParsons) {
      // Type C: Parsons Problem (drag-and-drop code ordering)
      console.log('[ZyAgent] Challenge sub-type: Parsons Problem (drag-and-drop)');
      return handleParsons(activity, settings);
    } else if (hasProgression && hasOutputTextarea && !hasAceEditor) {
      // Type B: Output prediction / trace-the-code
      console.log('[ZyAgent] Challenge sub-type: Output Prediction (zyante-progression)');
      return handleOutputPrediction(activity, settings);
    } else if (hasAceEditor) {
      // Type A: ACE editor code-writing
      console.log('[ZyAgent] Challenge sub-type: Code Writing (ACE editor)');
      return handleCodeWriting(activity, settings);
    } else if (hasProgression) {
      // Progression without ACE editor and without textarea — try output prediction anyway
      console.log('[ZyAgent] Challenge sub-type: Progression (unknown format, trying output prediction)');
      return handleOutputPrediction(activity, settings);
    } else {
      Z.sendProgress(0, 0, `Challenge "${activity.title}": unknown sub-type — skipping`, 'error');
      console.error('[ZyAgent] Unknown challenge sub-type:', el.innerHTML.substring(0, 500));
    }
  };

})();
