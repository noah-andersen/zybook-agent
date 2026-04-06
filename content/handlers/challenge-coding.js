// ─── ZyBook Agent — Challenge: Code Writing (Type A) & Output Prediction (Type B) ───
// Split from challenge.js for maintainability.
// Depends on: challenge-shared.js (loaded before this file)

(function () {
  'use strict';

  const Z = window.ZyAgent;

  // Aliases for shared helpers
  const ensureTrailingNewline       = Z._challenge_ensureTrailingNewline;
  const dismissAnyModal             = Z._challenge_dismissAnyModal;
  const dismissOrConfirmJumpModal   = Z._challenge_dismissOrConfirmJumpModal;
  const findFirstIncompleteLevel    = Z._challenge_findFirstIncompleteLevel;
  const gatherFeedback              = Z._challenge_gatherFeedback;
  const tryAutoFixFromFeedback      = Z._challenge_tryAutoFixFromFeedback;

  // ════════════════════════════════════════════════════════════
  //  TYPE B: OUTPUT PREDICTION CHALLENGES (zyante-progression)
  // ════════════════════════════════════════════════════════════

  async function waitForProgressionFeedback(el, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const checkmark = el.querySelector('.zyante-progression-checkmark');
      if (checkmark && checkmark.style.display !== 'none' && checkmark.offsetParent !== null) {
        return 'correct';
      }

      const xMark = el.querySelector('.zyante-progression-x-mark');
      if (xMark && xMark.style.display !== 'none' && xMark.offsetParent !== null) {
        return 'incorrect';
      }

      const nextBtn = el.querySelector('.zyante-progression-next-button:not(.disabled):not([disabled])');
      const xMarkForNext = el.querySelector('.zyante-progression-x-mark');
      const xMarkVisible = xMarkForNext && xMarkForNext.style.display !== 'none' && xMarkForNext.offsetParent !== null;
      if (nextBtn && nextBtn.style.display !== 'none' && !xMarkVisible) return 'correct';

      const doneEl = el.querySelector('.zyante-progression-is-done');
      if (doneEl && doneEl.style.display !== 'none') return 'correct';

      if (Z.checkCompletion(el)) return 'correct';

      await Z.sleep(400);
    }
    return 'timeout';
  }

  Z._challenge_handleOutputPrediction = async function (activity, settings) {
    const el = activity.element;

    if (Z.checkCompletion(el)) {
      Z.sendProgress(0, 0, `Challenge "${activity.title}" already completed, skipping`, 'info');
      return;
    }

    const statusDivs = el.querySelectorAll('.zyante-progression-status-bar > div[role="listitem"], .zyante-progression-status-bar > div:not([class])');
    const totalLevels = statusDivs.length || 1;
    Z.sendProgress(0, totalLevels, `Output challenge "${activity.title}" — ${totalLevels} level(s)`);

    const startBtn = await Z.waitForElement(
      '.zyante-progression-start-button:not(.disabled):not([disabled])',
      { root: el, timeout: 5000 }
    );
    if (startBtn && startBtn.style.display !== 'none') {
      startBtn.click();
      Z.sendProgress(0, totalLevels, 'Clicked Start');
      await Z.sleep(2000);
    }

    const startLevel = await findFirstIncompleteLevel(el, totalLevels);

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

        const promptEl = el.querySelector('#prompt, .tool-container > p');
        const promptText = promptEl ? promptEl.innerText.trim() : 'Type the program\'s output';
        const codeEl = el.querySelector('.tool-container .code, .code-container .code');
        const code = codeEl ? codeEl.innerText.trim() : '';
        const inputEl = el.querySelector('.input-div, .input-container .input-div');
        const inputData = inputEl ? inputEl.innerText.trim() : '';

        const outputTextarea = el.querySelector('textarea.console');
        if (!outputTextarea) {
          Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: No output textarea found`, 'error');
          break;
        }

        Z.sendProgress(level + 1, totalLevels,
          `Level ${level + 1}, attempt ${attempt + 1}: Tracing code output…`);

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
        let cleanResponse = response
          .replace(/^```(?:python|text|output)?\n?/gm, '')
          .replace(/```\s*$/gm, '');
        cleanResponse = cleanResponse.replace(/^\s*\n/, '');
        cleanResponse = cleanResponse.replace(/^[ \t]+/, '');
        cleanResponse = cleanResponse.replace(/[ \t]+$/, '');
        cleanResponse = ensureTrailingNewline(cleanResponse, code);

        console.log('[ZyAgent] AI output prediction:', JSON.stringify(cleanResponse));

        outputTextarea.removeAttribute('disabled');
        outputTextarea.focus();
        await Z.sleep(200);

        outputTextarea.value = '';
        outputTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        await Z.sleep(100);

        Z.setNativeValue(outputTextarea, cleanResponse);
        await Z.sleep(300);

        outputTextarea.value = cleanResponse;
        outputTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        outputTextarea.dispatchEvent(new Event('change', { bubbles: true }));
        outputTextarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        await Z.sleep(500);

        const checkBtn = await Z.waitForCondition(
          () => el.querySelector('.zyante-progression-check-button:not(.disabled):not([disabled])'),
          { timeout: 5000, interval: 300 }
        );
        if (!checkBtn) {
          Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Check button not available`, 'warn');
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

        const result = await waitForProgressionFeedback(el);

        if (result === 'correct') {
          passed = true;
          Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Correct! ✓`, 'success');
        } else {
          lastFeedback = gatherFeedback(el);
          console.log('[ZyAgent] Feedback gathered:', lastFeedback);

          const autoFixed = await tryAutoFixFromFeedback(el, lastFeedback);

          const tryAgainForAutoFix = el.querySelector('.zyante-progression-try-again:not(.disabled):not([disabled])');
          const tryAgainVisible = tryAgainForAutoFix && tryAgainForAutoFix.style.display !== 'none';
          const isCodeVariationReset = !tryAgainVisible &&
            el.querySelector('.zyante-progression-check-button.disabled, .zyante-progression-check-button[disabled]') &&
            el.querySelector('.zyante-progression-next-button:not(.disabled):not([disabled])');

          if (autoFixed && !isCodeVariationReset) {
            Z.sendProgress(level + 1, totalLevels,
              `Level ${level + 1}: Auto-fixing whitespace issue…`, 'info');

            if (tryAgainVisible) {
              tryAgainForAutoFix.click();
              await Z.sleep(1000);
            }

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
                  continue;
                }
                lastFeedback = gatherFeedback(el);
              }
            }
          }

          Z.sendProgress(level + 1, totalLevels,
            `Level ${level + 1}: Incorrect (attempt ${attempt + 1}/${maxRetries})`, 'warn');

          if (attempt < maxRetries - 1) {
            const tryAgainBtn = el.querySelector('.zyante-progression-try-again:not(.disabled):not([disabled])');
            if (tryAgainBtn && tryAgainBtn.style.display !== 'none') {
              tryAgainBtn.click();
              await Z.sleep(1000);
            } else {
              const checkDisabled = el.querySelector('.zyante-progression-check-button.disabled, .zyante-progression-check-button[disabled]');
              const nextBtnReset = el.querySelector('.zyante-progression-next-button:not(.disabled):not([disabled])');
              if (checkDisabled && nextBtnReset && nextBtnReset.style.display !== 'none') {
                Z.sendProgress(level + 1, totalLevels,
                  `Level ${level + 1}: Code variation changed, clicking Next to get new code…`, 'info');
                nextBtnReset.click();
                await Z.sleep(2500);
                lastFeedback = '';
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

      if (!passed) {
        Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Failed after ${maxRetries} attempts. Stopping.`, 'error');
        return;
      }

      if (level < totalLevels - 1) {
        await Z.sleep(1000);
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
  };

  // ════════════════════════════════════════════════════════════
  //  TYPE A: ACE EDITOR CODE-WRITING CHALLENGES
  // ════════════════════════════════════════════════════════════

  // Placeholder patterns — generalised to match many zyBooks variations
  const PLACEHOLDER_REGEX_STR = [
    '"""\\s*Your code goes here\\s*"""',
    "'''\\s*Your code goes here\\s*'''",
    '"""\\s*your solution goes here\\s*"""',
    "'''\\s*your solution goes here\\s*'''",
    '"""\\s*Type your code here\\s*"""',
    '/\\*\\s*Your code goes here\\s*\\*/',
    '#\\s*Your code goes here.*',
    '#\\s*Your solution goes here.*',
    // Generalised: "# Your ___ goes here" (docstring, expression, answer, etc.)
    '#\\s*Your\\s+\\w+\\s+goes\\s+here.*',
    // Generalised: "# Type your ___ here"
    '#\\s*Type\\s+your\\s+\\w+\\s+here.*',
    // Triple-quote placeholders with any content mentioning "your"
    '"""[^"]*[Yy]our[^"]*"""',
    "'''[^']*[Yy]our[^']*'''",
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
   * Uses multiple strategies (gutter-highlight, bridge, heuristic).
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
    const gutterCells = aceEl.querySelectorAll('.ace_gutter-cell');
    let readOnlyFlags = null;

    if (gutterCells.length > 0) {
      const highlightCount = Array.from(gutterCells).filter(c => c.classList.contains('gutter-highlight')).length;
      const totalGutterCells = Math.min(gutterCells.length, codeLines.length);

      if (highlightCount < totalGutterCells) {
        readOnlyFlags = [];
        for (let i = 0; i < totalGutterCells; i++) {
          readOnlyFlags.push(!gutterCells[i].classList.contains('gutter-highlight'));
        }
        console.log('[ZyAgent] Read-only detection: gutter-highlight strategy');
      } else {
        console.log('[ZyAgent] Read-only detection: ALL gutter cells highlighted — falling through');
      }
    }

    // ── Strategy 2: ACE read-only marker ranges via page bridge ──
    if (!readOnlyFlags) {
      try {
        const bridgeResult = await Z.getAceReadOnlyRanges(el);
        if (bridgeResult.success && bridgeResult.readOnlyLines && bridgeResult.readOnlyLines.length > 0) {
          const roSet = new Set(bridgeResult.readOnlyLines);
          readOnlyFlags = [];
          for (let i = 0; i < codeLines.length; i++) {
            readOnlyFlags.push(roSet.has(i));
          }
          console.log('[ZyAgent] Read-only detection: bridge strategy (' + bridgeResult.method + ')');
        }
      } catch (err) {
        console.warn('[ZyAgent] Read-only detection: bridge strategy failed:', err.message);
      }
    }

    // ── Strategy 3: Heuristic code analysis ──
    if (!readOnlyFlags) {
      readOnlyFlags = [];
      const placeholderLineIdx = codeLines.findIndex(l => PLACEHOLDER_DETECT.test(l));

      if (placeholderLineIdx >= 0) {
        for (let i = 0; i < codeLines.length; i++) {
          readOnlyFlags.push(i !== placeholderLineIdx);
        }
        console.log('[ZyAgent] Read-only detection: placeholder heuristic');
      } else {
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
          for (let i = 0; i < codeLines.length; i++) {
            readOnlyFlags.push(i < firstBlankRun || i > lastBlankRun);
          }
          console.log('[ZyAgent] Read-only detection: blank-region heuristic',
            `editable lines ${firstBlankRun}-${lastBlankRun}`);
        } else {
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
        result.allReadOnlyLineTexts.push(codeLines[i]);
      } else {
        result.editableLineNumbers.push(i + 1);
      }
    }

    result.hasReadOnlyRegions = result.readOnlyLines.length > 0;
    if (!result.hasReadOnlyRegions) return result;

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
   * Validate and clean AI-generated code before inserting into the editor.
   */
  function validateAndCleanCode(code, roInfo, originalCode) {
    let lines = code.split('\n');

    // Fix trailing colons on non-block statements
    const BLOCK_STARTERS = /^\s*(while|for|if|elif|else|def|class|try|except|finally|with)\b/;
    lines = lines.map(line => {
      const trimmed = line.trimEnd();
      if (trimmed.endsWith(':') && !BLOCK_STARTERS.test(trimmed)) {
        if (/\b(print|return|break|continue|pass)\s*\(/.test(trimmed) ||
            /[+\-*/%]=/.test(trimmed) ||
            (/=\s/.test(trimmed) && !trimmed.includes('==') && !trimmed.includes('!=') && !trimmed.includes('<=') && !trimmed.includes('>='))) {
          console.log('[ZyAgent] Fixing trailing colon on non-block statement:', trimmed);
          return line.replace(/:(\s*)$/, '$1');
        }
      }
      return line;
    });

    // Remove duplicated read-only lines
    if (roInfo && roInfo.allReadOnlyLineTexts && roInfo.allReadOnlyLineTexts.length > 0) {
      const roMap = new Map();
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
          if (roIndents.has(leadingWS)) {
            console.log('[ZyAgent] Stripping duplicated read-only line:', JSON.stringify(line));
            strippedCount++;
            continue;
          }
        }
        filtered.push(line);
      }

      if (strippedCount > 0) {
        console.log(`[ZyAgent] Stripped ${strippedCount} duplicated read-only line(s)`);
        lines = filtered;
      }
    }

    while (lines.length > 1 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }

    return lines.join('\n');
  }

  /* ── Wait for Check / Run button ── */
  async function waitForCheckEnabled(el, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const checkBtn =
        el.querySelector('.check-next-container button.check:not([disabled])') ||
        el.querySelector('.check-next-container button.zb-button.check:not([disabled])') ||
        el.querySelector('.check-next-container button.zb-button.primary:not([disabled])');
      if (checkBtn && checkBtn.innerText.trim().toLowerCase().includes('check')) return checkBtn;

      const runBtnRow = el.querySelector('.under-editor .button-row button.zb-button.primary:not([disabled])') ||
        el.querySelector('.button-row button.zb-button.primary.run-button:not([disabled])') ||
        el.querySelector('.button-row button.run-button:not([disabled])');
      if (runBtnRow) {
        const txt = runBtnRow.innerText.trim().toLowerCase();
        if (txt.includes('run') || txt.includes('submit')) return runBtnRow;
      }

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
  async function waitForCodeWritingFeedback(el, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const checkNextBtns = el.querySelectorAll('.check-next-container button.zb-button:not([disabled])');
      for (const btn of checkNextBtns) {
        if (btn.innerText.trim().toLowerCase().includes('next')) return 'correct';
      }

      const allBtns = el.querySelectorAll('button.zb-button:not([disabled])');
      for (const btn of allBtns) {
        const txt = btn.innerText.trim().toLowerCase();
        if (txt.includes('next') && !txt.includes('start')) return 'correct';
      }

      const codeExplanation = el.querySelector('.code-explanation');
      if (codeExplanation && codeExplanation.offsetParent !== null) {
        const text = codeExplanation.innerText.toLowerCase();
        if (text.includes('not all tests passed')) return 'incorrect';
        if (text.includes('error')) return 'incorrect';
      }

      const failedTests = el.querySelectorAll('.test-header.fail, .test-header[aria-label*="failed"]');
      if (failedTests.length > 0) return 'incorrect';

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
          const iconAriaLabel = headerIcon ? (headerIcon.getAttribute('aria-label') || '').toLowerCase() : '';
          const iconText = headerIcon ? (headerIcon.textContent || '').trim().toLowerCase() : '';

          if (headerClasses.includes('fail') || headerText.includes('✗') ||
              iconClass.includes('x-circle') || iconClass.includes('ph-x') ||
              iconAriaLabel === 'incorrect' || iconText === 'clear' || iconClass.includes('red')) {
            anyFailed = true;
          } else if (headerClasses.includes('pass') || headerText.includes('✓') ||
                     iconClass.includes('check-circle') || iconClass.includes('ph-check') ||
                     iconAriaLabel === 'correct' || iconText === 'check' || iconClass.includes('green')) {
            anyPassed = true;
          } else {
            allChecked = false;
          }
        }
        if (anyFailed) return 'incorrect';
        if (anyPassed && allChecked && !anyFailed) return 'correct';
      }

      const noOutputMsg = el.querySelector('.no-output-result, .expected-output-test-result');
      if (noOutputMsg && noOutputMsg.offsetParent !== null) {
        const text = noOutputMsg.innerText.toLowerCase();
        if (text.includes('no output') || text.includes('error') || text.includes('output differs')) return 'incorrect';
      }

      const iconMessage = el.querySelector('.icon-message');
      if (iconMessage) {
        const msgText = iconMessage.innerText.toLowerCase().trim();
        if (msgText.includes('no solution') || msgText.includes('no code')) return 'incorrect';
      }

      const completionChevrons = el.querySelectorAll('.chevron-container .question-chevron.zb-chevron');
      if (completionChevrons.length > 0) {
        const allComplete = Array.from(completionChevrons).every(ch => {
          const label = (ch.getAttribute('aria-label') || '').toLowerCase();
          return label.includes('completed') && !label.includes('not completed');
        });
        if (allComplete) return 'correct';
        const anyResultsShown = el.querySelector('.tests .test-result .expected-output-test-result, .tests .test-result .test-result-row');
        if (anyResultsShown && anyResultsShown.offsetParent !== null) return 'incorrect';
      }

      const errorOutputs = el.querySelectorAll('.error-output');
      for (const eo of errorOutputs) {
        if (eo.innerText.trim().length > 0 && eo.offsetParent !== null) return 'incorrect';
      }

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

  Z._challenge_handleCodeWriting = async function (activity, settings) {
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

    const startBtn = el.querySelector('button.zb-button.primary:not([disabled]):not(.check)');
    if (startBtn && startBtn.innerText.trim().toLowerCase() === 'start') {
      startBtn.click();
      Z.sendProgress(0, totalLevels, 'Clicked Start');
      await Z.sleep(1500);
    }

    const startLevel = await findFirstIncompleteLevel(el, totalLevels);

    for (let level = startLevel; level < totalLevels; level++) {
      if (Z.shouldStop) break;

      if (Z.checkCompletion(el)) {
        Z.sendProgress(totalLevels, totalLevels, `Challenge "${activity.title}" completed!`, 'success');
        return;
      }

      Z.sendProgress(level + 1, totalLevels, `Working on level ${level + 1}/${totalLevels}`);

      await dismissAnyModal(el);

      const promptEl = el.querySelector('.code-writing-prompt') ||
        el.querySelector('.challenge-instructions') ||
        el.querySelector('.activity-instructions') ||
        el.querySelector('zyinstructions') ||
        el.querySelector('.instructions') ||
        el.querySelector('.develop-instructions') ||
        el.querySelector('.activity-description');
      let currentPrompt = promptEl ? promptEl.innerText.trim() : '';

      // Extract <pre><code> blocks as explicit code/content examples
      // so the AI can distinguish instructions from literal expected content
      if (promptEl) {
        const codeBlocks = promptEl.querySelectorAll('pre code, pre');
        if (codeBlocks.length > 0) {
          const codeExamples = [];
          for (const cb of codeBlocks) {
            const codeText = cb.textContent.trim();
            if (codeText) codeExamples.push(codeText);
          }
          if (codeExamples.length > 0) {
            currentPrompt += '\n\nEXACT CONTENT from instructions:\n' + codeExamples.map(c => `>>> ${c}`).join('\n');
          }
        }
      }

      if (!currentPrompt) {
        const payloadEl = el.querySelector('.activity-payload');
        if (payloadEl) {
          const clone = payloadEl.cloneNode(true);
          clone.querySelectorAll('.ace_editor, .ace-editor-container, .tests, .under-editor').forEach(e => e.remove());
          currentPrompt = clone.innerText.trim().substring(0, 1000);
        }
      }
      if (!currentPrompt && activity.title) {
        currentPrompt = activity.title;
      }

      console.log('[ZyAgent] Challenge instructions:', currentPrompt ? currentPrompt.substring(0, 200) : '(none found)');

      const testDescriptions = [];
      const testEls = el.querySelectorAll('.tests .test-result .test-text, .test-description, .test-case-description');
      for (const te of testEls) {
        const text = te.innerText.trim();
        if (text) testDescriptions.push(text);
      }
      if (testDescriptions.length === 0) {
        const testHeaders = el.querySelectorAll('.tests .test-result .test-header, .test-result .test-title-container');
        for (const th of testHeaders) {
          const text = th.innerText.trim();
          if (text) testDescriptions.push(text);
        }
      }
      const expectedOutputs = [];
      const testResultRows = el.querySelectorAll('.test-result .test-result-row');
      for (const row of testResultRows) {
        const label = row.querySelector('.result-row-description');
        const value = row.querySelector('.programming-code-output');
        if (label && value) {
          const labelText = label.innerText.trim();
          const valueText = value.textContent.trim();
          if (labelText && valueText) {
            expectedOutputs.push(`${labelText}: ${valueText}`);
          }
        }
      }
      const testInfo = testDescriptions.length > 0 ? '\nTest cases:\n' + testDescriptions.join('\n') : '';
      const expectedOutputInfo = expectedOutputs.length > 0 ? '\nTest result details:\n' + expectedOutputs.join('\n') : '';

      await Z.sleep(1000);

      const originalCode = await Z.getAceEditorValue(el);
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
      const originalPlaceholderText = findPlaceholderMatch(originalCode);
      const originalHasPlaceholder = hasPlaceholder(originalCode);

      for (let attempt = 0; attempt < maxRetries && !passed && !Z.shouldStop; attempt++) {
        const isRetry = attempt > 0;

        if (isRetry) {
          await dismissAnyModal(el);
          console.log('[ZyAgent] Resetting editor to original code before retry attempt', attempt + 1);
          let resetSucceeded = false;

          const jumpBtn = el.querySelector('.progression-container button.zb-button.secondary');
          if (jumpBtn && jumpBtn.innerText.toLowerCase().includes('jump to level')) {
            console.log('[ZyAgent] Reset via Jump to level button');
            jumpBtn.click();
            await Z.sleep(1000);
            await dismissOrConfirmJumpModal(true);
            await Z.sleep(2000);

            const afterJump = await Z.getAceEditorValue(el);
            if (afterJump && hasPlaceholder(afterJump)) {
              resetSucceeded = true;
              console.log('[ZyAgent] Reset via Jump succeeded');
            }
          }

          if (!resetSucceeded) {
            await Z.setAceEditorValue(el, originalCode);
            await Z.sleep(800);

            const resetVerify = await Z.getAceEditorValue(el);
            if (resetVerify) {
              if (resetVerify.trim() === originalCode.trim()) {
                resetSucceeded = true;
              } else if (originalHasPlaceholder && hasPlaceholder(resetVerify)) {
                resetSucceeded = true;
              } else {
                const originalLineCount = originalCode.split('\n').length;
                const currentLineCount = resetVerify.split('\n').length;
                if (currentLineCount > originalLineCount * 3) {
                  console.error(`[ZyAgent] Editor is corrupted (${currentLineCount} lines). Attempting nuclear reset.`);
                  await Z.setAceEditorValue(el, originalCode);
                  await Z.sleep(500);
                }
              }
            }
          }

          if (!resetSucceeded) {
            console.warn('[ZyAgent] Editor reset could not be verified');
          }
        }

        const currentCode = await Z.getAceEditorValue(el) || originalCode;
        const codeHasPlaceholder = hasPlaceholder(currentCode);
        const placeholderText = findPlaceholderMatch(currentCode);

        const originalLineCount = originalCode.split('\n').length;
        const currentLineCount = currentCode.split('\n').length;
        if (currentLineCount > originalLineCount * 3) {
          console.error(`[ZyAgent] Editor appears corrupted (${currentLineCount} lines). Aborting.`);
          Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Editor corrupted, skipping`, 'error');
          break;
        }

        if (isRetry && originalHasPlaceholder && !codeHasPlaceholder) {
          console.warn('[ZyAgent] Placeholder was lost after reset');
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

          // Detect if placeholder is a comment-style hint (# Your ... goes here)
          const isCommentPlaceholder = /^#\s*/.test(placeholderText.trim());
          // Detect if the task involves writing a docstring
          const isDocstringTask = /docstring/i.test(currentPrompt) ||
            /docstring/i.test(placeholderText) ||
            /write\s+a\s+docstring/i.test(currentPrompt) ||
            /add\s+a\s+docstring/i.test(currentPrompt);

          // Determine the indentation of the placeholder line for context
          const placeholderIndent = placeholderLine.match(/^(\s*)/)?.[1] || '';

          let replacementInstructions = '';
          if (isCommentPlaceholder && isDocstringTask) {
            replacementInstructions = `
The placeholder is a comment hint: "${placeholderText}"
You must REPLACE this comment with a proper Python docstring using triple quotes.
The docstring should be on the SAME indentation level as the comment.

For a single-line docstring, use: """Your docstring content here"""
For a multi-line docstring, use:
"""
First line.
More details.
"""

Respond with ONLY the docstring (including the triple quotes). Do NOT include the comment itself.
Do NOT include surrounding code. The docstring will be placed at indent level: "${placeholderIndent}"`;
          } else if (isCommentPlaceholder) {
            replacementInstructions = `
The placeholder is a comment hint: "${placeholderText}"
You must REPLACE this entire comment with the actual code.
Respond with ONLY the replacement code. Do NOT include the comment.
The code will be placed at indent level: "${placeholderIndent}"
If the replacement is multiple lines, use ACTUAL line breaks.`;
          } else {
            replacementInstructions = `
You must respond with ONLY the text that replaces the placeholder.
Do NOT include the surrounding code. Do NOT include "${beforePlaceholder}" or "${afterPlaceholder}".`;
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
${replacementInstructions}

Do NOT wrap in backticks or code fences. Just the raw replacement text.
IMPORTANT: If the replacement is multiple lines of code, use ACTUAL line breaks.
IMPORTANT: Do NOT add trailing colons on print(), assignment, or other non-block statements.

CRITICAL: The replacement must produce VALID Python syntax when inserted into the code.
For example:
  - Placeholder: # Your docstring goes here  →  You respond: """Description of the function"""
  - Placeholder: # Your code goes here  →  You respond: result = x + y
  - Line: for i """ Your code goes here """:  →  You respond: in range(1, 10)
  - Line: while """ Your code goes here """:  →  You respond: x < 10
  - Line: x = """ Your code goes here """  →  You respond: int(input())
${isRetry ? `\nYour previous answer was WRONG. Study the DETAILED FEEDBACK below carefully.
Fix your answer based on the feedback:` : ''}`
            },
            {
              role: 'user',
              content: [
                `TASK: ${currentPrompt}`,
                testInfo,
                expectedOutputInfo,
                `\nFULL CODE:\n${currentCode}`,
                `\nPLACEHOLDER: ${placeholderText}`,
                `LINE: ${placeholderLine.trim()}`,
                isRetry && lastFeedback ? `\n=== DETAILED FEEDBACK FROM WRONG ANSWER ===\n${lastFeedback}\n=== END FEEDBACK ===` : '',
                `\nRespond with ONLY the replacement. Nothing else.`
              ].filter(Boolean).join('\n')
            }
          ];
        } else if (roInfo.hasReadOnlyRegions) {
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

          const roLinesList = roInfo.allReadOnlyLineTexts.filter(t => t.trim() !== '').map(t => `"${t.trim()}"`);

          messages = [
            {
              role: 'system',
              content: `You are an expert Python programmer solving a zyBooks challenge activity.

RESPONSE FORMAT: Raw Python code ONLY. No markdown, no backticks, no explanations.

CRITICAL RULES:
1. The editor has PRE-FILLED READ-ONLY code that CANNOT be edited.
2. You must write ONLY the code for the EDITABLE section.
3. DO NOT repeat ANY of these read-only lines: ${roLinesList.join(', ')}
4. Your code will be INSERTED between the read-only prefix and suffix.
5. Use proper Python indentation (spaces, not tabs).
6. Do NOT add trailing colons on non-block statements.

${Z.ZYBOOKS_OUTPUT_RULES}
${isRetry ? `\nYour previous attempt was WRONG. Study the feedback VERY carefully.
Write a CLEAN, CORRECT solution from scratch.` : ''}`
            },
            {
              role: 'user',
              content: [
                `TASK: ${currentPrompt}`,
                testInfo,
                expectedOutputInfo,
                `\nEDITOR STRUCTURE:\n${structureDisplay.join('\n')}`,
                `\nREMEMBER: Write ONLY the code for the "YOUR CODE GOES HERE" section.`,
                `These lines are read-only: ${roLinesList.join(', ')}`,
                isRetry && lastFeedback ? `\n=== DETAILED FEEDBACK ===\n${lastFeedback}\n=== END FEEDBACK ===` : '',
                `\nYour response (ONLY the editable code):`
              ].filter(Boolean).join('\n')
            }
          ];
        } else {
          messages = [
            {
              role: 'system',
              content: `You are an expert Python programmer. Return COMPLETE corrected Python code.
No markdown, no backticks. ONLY raw Python code.
Do NOT add trailing colons on non-block statements.

${Z.ZYBOOKS_OUTPUT_RULES}
${isRetry ? `\nPrevious answer was WRONG. Study the DETAILED FEEDBACK below carefully.
Write a CLEAN solution from scratch.` : ''}`
            },
            {
              role: 'user',
              content: [
                `TASK: ${currentPrompt}`,
                testInfo,
                expectedOutputInfo,
                `\nCurrent code:\n${currentCode}`,
                isRetry && lastFeedback ? `\n=== DETAILED FEEDBACK ===\n${lastFeedback}\n=== END FEEDBACK ===` : '',
                `\nReturn corrected code.`
              ].filter(Boolean).join('\n')
            }
          ];
        }

        const response = await Z.callAI(settings, messages);
        let cleanResponse = response
          .replace(/^```(?:python)?\n?/gm, '')
          .replace(/```\s*$/gm, '')
          .trim();

        if (cleanResponse.includes('\\n') && !cleanResponse.includes('\n')) {
          console.log('[ZyAgent] Code response has literal \\n — converting');
          cleanResponse = cleanResponse.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        } else if (cleanResponse.includes('\\n')) {
          const lines = cleanResponse.split('\n');
          const fixedLines = lines.map(line => {
            if (line.includes('\\n')) {
              return line.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
            }
            return line;
          });
          cleanResponse = fixedLines.join('\n');
        }

        cleanResponse = validateAndCleanCode(cleanResponse, roInfo, originalCode);
        console.log('[ZyAgent] AI code response (cleaned):', JSON.stringify(cleanResponse));

        // Safety: for docstring tasks, ensure the AI response has triple quotes
        if (codeHasPlaceholder && placeholderText && /docstring/i.test(placeholderText + ' ' + currentPrompt)) {
          if (!cleanResponse.includes('"""') && !cleanResponse.includes("'''")) {
            console.log('[ZyAgent] Docstring task but AI response lacks triple quotes — wrapping');
            cleanResponse = '"""' + cleanResponse + '"""';
          }
        }

        let writeSuccess = false;

        if (codeHasPlaceholder && placeholderText) {
          writeSuccess = await Z.aceEditorFindReplace(el, placeholderText, cleanResponse);
          console.log('[ZyAgent] Method 1 (find-replace):', writeSuccess ? 'SUCCESS' : 'failed');

          if (!writeSuccess) {
            const fallbackCode = currentCode.replace(placeholderText, cleanResponse);
            writeSuccess = await Z.setAceEditorValue(el, fallbackCode);
            console.log('[ZyAgent] Method 2 (setValue):', writeSuccess ? 'SUCCESS' : 'failed');
          }

          if (!writeSuccess) {
            const variations = [
              '""" Your code goes here """', "''' Your code goes here '''",
              '"""Your code goes here"""', "'''Your code goes here'''",
              '""" your code goes here """', "''' your code goes here '''",
              '""" Your solution goes here """', "''' Your solution goes here '''",
              '# Your code goes here', '# your code goes here',
              '# Your docstring goes here', '# your docstring goes here',
              '# Your expression goes here', '# your expression goes here',
              '# Your answer goes here', '# your answer goes here',
              '# Type your code here', '# type your code here',
            ];
            for (const variant of variations) {
              writeSuccess = await Z.aceEditorFindReplace(el, variant, cleanResponse);
              if (writeSuccess) {
                console.log('[ZyAgent] Placeholder replaced via variant:', variant);
                break;
              }
            }
          }

          // Extra fallback: regex-search for any "# Your ... goes/here" comment in the editor
          if (!writeSuccess) {
            const freshCode = await Z.getAceEditorValue(el);
            if (freshCode) {
              const commentMatch = freshCode.match(/#\s*[Yy]our\s+\w+\s+(goes\s+here|here).*/);
              if (commentMatch) {
                console.log('[ZyAgent] Found comment placeholder via regex:', JSON.stringify(commentMatch[0]));
                writeSuccess = await Z.aceEditorFindReplace(el, commentMatch[0], cleanResponse);
                if (!writeSuccess) {
                  const fixedCode = freshCode.replace(commentMatch[0], cleanResponse);
                  writeSuccess = await Z.setAceEditorValue(el, fixedCode);
                }
              }
            }
          }

          if (!writeSuccess) {
            const freshCode = await Z.getAceEditorValue(el);
            if (freshCode) {
              const placeholderMatch = freshCode.match(/"""[^"]*"""|'''[^']*'''|#\s*[Yy]our\s+\w+\s+goes\s+here.*/);
              if (placeholderMatch) {
                console.log('[ZyAgent] Found actual placeholder:', JSON.stringify(placeholderMatch[0]));
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
            Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: placeholder still present`, 'warn');
            if (verifyCode) {
              const phMatch = verifyCode.match(/"""[^"]*"""|'''[^']*'''|#\s*[Yy]our\s+\w+\s+goes\s+here.*/);
              if (phMatch) {
                const fullCode = verifyCode.replace(phMatch[0], cleanResponse);
                writeSuccess = await Z.setAceEditorValue(el, fullCode);
                await Z.sleep(500);
                const recheck = await Z.getAceEditorValue(el);
                if (hasPlaceholder(recheck)) {
                  Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: all replacement methods failed`, 'error');
                  lastFeedback = 'Placeholder was not replaced.';
                  break;
                }
              } else {
                lastFeedback = 'Placeholder was not replaced.';
                break;
              }
            } else {
              lastFeedback = 'Cannot read editor content.';
              break;
            }
          }
        } else if (roInfo.hasReadOnlyRegions) {
          const prefixLines = roInfo.prefixCode ? roInfo.prefixCode.split('\n') : [];
          const suffixLines = roInfo.suffixCode ? roInfo.suffixCode.split('\n') : [];
          let aiLines = cleanResponse.split('\n');

          const roNormalized = new Set(
            (roInfo.allReadOnlyLineTexts || []).map(t => t.trim()).filter(t => t !== '')
          );
          const roIndentMap = new Map();
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
              if (trimmed === '') return true;
              if (roIndentMap.has(trimmed)) {
                const lineWS = line.match(/^(\s*)/)[1];
                if (roIndentMap.get(trimmed).has(lineWS)) {
                  console.log(`[ZyAgent] Assembly: stripping read-only duplicate: "${trimmed}"`);
                  return false;
                }
              }
              return true;
            });
            if (aiLines.length < beforeCount) {
              console.log(`[ZyAgent] Assembly: stripped ${beforeCount - aiLines.length} read-only duplicates`);
            }
          }

          const assembledLines = [];
          if (prefixLines.length > 0) assembledLines.push(...prefixLines);
          assembledLines.push(...aiLines);
          if (suffixLines.length > 0) assembledLines.push(...suffixLines);

          const assembledCode = assembledLines.join('\n');
          console.log('[ZyAgent] Assembled code with read-only regions preserved');

          writeSuccess = await Z.setAceEditorValue(el, assembledCode);

          if (writeSuccess) {
            await Z.sleep(300);
            const verifyCode = await Z.getAceEditorValue(el);
            if (verifyCode) {
              let needsEmergencyDedup = false;
              for (const roLine of roNormalized) {
                const originalIndents = roIndentMap.get(roLine) || new Set(['']);
                const count = verifyCode.split('\n').filter(l => {
                  if (l.trim() !== roLine) return false;
                  const ws = l.match(/^(\s*)/)[1];
                  return originalIndents.has(ws);
                }).length;
                if (count > 1) {
                  needsEmergencyDedup = true;
                  break;
                }
              }
              if (needsEmergencyDedup) {
                const dedupedLines = [];
                const seenRO = new Map();
                for (const line of verifyCode.split('\n')) {
                  const trimmed = line.trim();
                  if (roNormalized.has(trimmed) && trimmed !== '') {
                    const ws = line.match(/^(\s*)/)[1];
                    const originalIndents = roIndentMap.get(trimmed) || new Set(['']);
                    if (originalIndents.has(ws)) {
                      const key = trimmed + '|' + ws;
                      if (seenRO.has(key)) {
                        console.log(`[ZyAgent] Emergency dedup: removing "${trimmed}"`);
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

        const postWriteCode = await Z.getAceEditorValue(el);
        if (postWriteCode && hasPlaceholder(postWriteCode)) {
          console.error('[ZyAgent] SAFETY CHECK FAILED: placeholder still present!');
          Z.sendProgress(level + 1, totalLevels,
            `Level ${level + 1}: Code not written to editor — retrying`, 'warn');

          const freshPH = findPlaceholderMatch(postWriteCode);
          if (freshPH) {
            const emergencyCode = postWriteCode.replace(freshPH, cleanResponse);
            const emergencySuccess = await Z.setAceEditorValue(el, emergencyCode);
            await Z.sleep(500);
            const emergencyVerify = await Z.getAceEditorValue(el);
            if (!emergencySuccess || (emergencyVerify && hasPlaceholder(emergencyVerify))) {
              console.error('[ZyAgent] Emergency write also failed.');
              lastFeedback = 'Could not write code to editor.';
              continue;
            }
            console.log('[ZyAgent] Emergency write succeeded');
          } else {
            lastFeedback = 'Placeholder present but could not locate it.';
            continue;
          }
        }

        const preCheckCode = postWriteCode || await Z.getAceEditorValue(el);
        if (preCheckCode) {
          const preCheckLineCount = preCheckCode.split('\n').length;
          if (preCheckLineCount > originalLineCount * 4) {
            console.error(`[ZyAgent] Editor corrupted before Check (${preCheckLineCount} lines).`);
            Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Editor corrupted, aborting`, 'error');
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
          retryCheck.click();
          clickedBtn = retryCheck;
        } else {
          checkBtn.click();
        }

        const clickedBtnText = clickedBtn ? clickedBtn.innerText.trim().toLowerCase() : '';
        const isRunButton = clickedBtnText.includes('run');

        Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: ${isRunButton ? 'Running' : 'Checking'}… (attempt ${attempt + 1}/${maxRetries})`);

        if (isRunButton) {
          const execStart = Date.now();
          await Z.sleep(1000);
          while (Date.now() - execStart < 30000) {
            const runningBtn = el.querySelector('.button-row button.zb-button.primary[disabled]') ||
              el.querySelector('.button-row button.run-button[disabled]') ||
              el.querySelector('.button-row .is-running');
            if (!runningBtn) break;
            await Z.sleep(500);
          }
          await Z.sleep(1500);
        } else {
          await Z.sleep(3500);
        }

        const result = await waitForCodeWritingFeedback(el);

        if (result === 'correct') {
          passed = true;
          Z.sendProgress(level + 1, totalLevels, `Level ${level + 1}: Correct! ✓`, 'success');
        } else {
          lastFeedback = gatherFeedback(el);
          try {
            const submittedCode = await Z.getAceEditorValue(el);
            if (submittedCode) {
              lastFeedback += '\n\n=== YOUR SUBMITTED CODE ===\n' + submittedCode + '\n=== END SUBMITTED CODE ===';
            }
          } catch (e) { /* Not critical */ }
          console.log('[ZyAgent] Code-writing feedback:', lastFeedback);

          if (attempt < maxRetries - 1) {
            try {
              const visualAnalysis = await Z.analyzeScreenshot(settings,
                'You are analyzing a zyBooks code challenge result. Look at the screenshot and describe: 1) What error or test failure is shown? 2) Expected vs actual output? 3) Any hints visible?',
                'Analyze this code challenge result screenshot. What went wrong?'
              );
              if (visualAnalysis) {
                lastFeedback += '\n\nVISUAL ANALYSIS:\n' + visualAnalysis;
              }
            } catch (err) { /* Optional */ }
          }

          Z.sendProgress(level + 1, totalLevels,
            `Level ${level + 1}: Incorrect (attempt ${attempt + 1}/${maxRetries})`, 'warn');

          if (attempt < maxRetries - 1) {
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
        const nextBtn = await Z.waitForCondition(() => {
          const checkNextBtns = el.querySelectorAll('.check-next-container button.zb-button:not([disabled])');
          for (const btn of checkNextBtns) {
            if (btn.innerText.trim().toLowerCase().includes('next')) return btn;
          }
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
          await Z.sleep(2500);
        } else {
          Z.sendProgress(level + 1, totalLevels, `Could not find Next button`, 'warn');
        }
      }
    }

    if (Z.checkCompletion(el)) {
      Z.sendProgress(totalLevels, totalLevels, `Challenge "${activity.title}" completed!`, 'success');
    }
  };

})();
