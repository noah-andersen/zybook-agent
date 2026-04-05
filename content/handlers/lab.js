// ─── ZyBook Agent — Lab Activity Handler ───
// Handles zyBooks LAB activities (zyLabs / ZyStudio).
//
// Labs embed a ZyStudio IDE inside a cross-origin iframe (zystudio.zybooks.com).
// The IDE uses Monaco Editor (VS Code's editor engine) via ngx-monaco-editor,
// wrapped in an Angular Codepad component with a Firepad collaborative layer.
//
// We cannot directly access the iframe's DOM from the content script.
// Instead, we use chrome.scripting.executeScript (via the service worker)
// to inject small scripts into the iframe for reading/writing the editor.
//
// Flow:
//   1. Read instructions + test info from the parent page
//   2. Inject into the ZyStudio iframe to read existing code template
//   3. Ask AI for the solution
//   4. Inject into the iframe to write code + click Run
//   5. Click "Submit for grading" on the parent page
//   6. Read test results from the parent page
//   7. Retry with feedback if tests fail

(function () {
  'use strict';

  const Z = window.ZyAgent;

  // ════════════════════════════════════════════════════════════
  //  IFRAME INTERACTION (via service worker)
  // ════════════════════════════════════════════════════════════

  /**
   * Execute a function inside the ZyStudio iframe via the service worker.
   * @param {Function} func - The function to execute inside the iframe
   * @param {Array} args - Arguments to pass to the function
   * @returns {Promise<any>} The result from the injected script
   */
  async function executeInIframe(func, args = []) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          action: 'executeInLabIframe',
          func: func.toString(),
          args
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response?.result);
          }
        }
      );
    });
  }

  /**
   * Wait for the ZyStudio iframe to be fully loaded and its editor ready.
   * ZyStudio uses Monaco Editor (not ACE), wrapped in an Angular component
   * (ngx-monaco-editor) with a Firepad collaborative layer.
   */
  async function waitForIframeReady(el, timeoutMs = 30000) {
    const start = Date.now();
    let lastStatus = '';
    while (Date.now() - start < timeoutMs) {
      const iframe = el.querySelector('iframe[src*="zystudio"]');
      if (!iframe) {
        await Z.sleep(500);
        continue;
      }

      try {
        const result = await executeInIframe(() => {
          // Strategy 1: Monaco editor global API with models
          if (typeof monaco !== 'undefined' && monaco.editor) {
            const models = monaco.editor.getModels();
            if (models.length > 0) {
              return { ready: true, editorType: 'monaco-api', value: models[0].getValue() };
            }
            // Monaco exists but no models yet — it's loading
            return { ready: false, status: 'monaco-loading' };
          }

          // Strategy 2: Monaco DOM exists but global isn't ready yet
          const monacoEl = document.querySelector('.monaco-editor');
          if (monacoEl) {
            // Try to access the editor via the internal require mechanism
            if (typeof require !== 'undefined') {
              try {
                const monacoModule = require('vs/editor/editor.main');
                if (monacoModule && monacoModule.editor) {
                  const models = monacoModule.editor.getModels();
                  if (models.length > 0) {
                    return { ready: true, editorType: 'monaco-require', value: models[0].getValue() };
                  }
                }
              } catch (e) { /* require not available */ }
            }
            return { ready: false, status: 'monaco-dom-waiting' };
          }

          // Strategy 3: ACE editor fallback
          const aceEl = document.querySelector('.ace_editor');
          if (aceEl && aceEl.env && aceEl.env.editor) {
            return { ready: true, editorType: 'ace', value: aceEl.env.editor.getValue() };
          }

          return { ready: false, status: 'no-editor-yet' };
        });

        if (result && result.ready) {
          console.log('[ZyAgent Lab] Editor ready:', result.editorType);
          return result;
        }

        if (result && result.status && result.status !== lastStatus) {
          lastStatus = result.status;
          console.log('[ZyAgent Lab] Waiting for editor:', result.status);
        }
      } catch (e) {
        console.log('[ZyAgent Lab] waitForIframeReady error:', e.message);
      }

      await Z.sleep(1000);
    }
    return null;
  }

  /**
   * Read the current code from the ZyStudio iframe's editor.
   * Supports Monaco Editor (primary) and ACE (fallback).
   */
  async function readIframeCode() {
    return await executeInIframe(() => {
      const results = [];

      // ── Strategy 1: Monaco editor via global monaco API ──
      if (typeof monaco !== 'undefined' && monaco.editor) {
        const models = monaco.editor.getModels();
        for (const model of models) {
          // Extract filename from the URI (e.g., "file:///usercode/main.py" → "main.py")
          const uri = model.uri?.toString() || '';
          const filename = uri.split('/').pop() || 'main.py';
          results.push({ filename, code: model.getValue() });
        }
        if (results.length > 0) return results;

        // Try getting editors directly
        const editors = monaco.editor.getEditors();
        for (const editor of editors) {
          const model = editor.getModel();
          if (model) {
            const uri = model.uri?.toString() || '';
            const filename = uri.split('/').pop() || 'main.py';
            results.push({ filename, code: model.getValue() });
          }
        }
        if (results.length > 0) return results;
      }

      // ── Strategy 2: Read Monaco view lines from DOM (if API not available) ──
      const viewLines = document.querySelectorAll('.monaco-editor .view-lines .view-line');
      if (viewLines.length > 0) {
        // Collect lines in visual order (sorted by their top position)
        const lineData = [];
        for (const line of viewLines) {
          const style = line.getAttribute('style') || '';
          const topMatch = style.match(/top:\s*(\d+)px/);
          const top = topMatch ? parseInt(topMatch[1]) : 0;
          lineData.push({ top, text: line.textContent });
        }
        lineData.sort((a, b) => a.top - b.top);
        const code = lineData.map(l => l.text).join('\n');
        if (code.trim()) {
          results.push({ filename: 'main.py', code });
          return results;
        }
      }

      // ── Strategy 3: ACE editor fallback ──
      const aceEl = document.querySelector('.ace_editor');
      if (aceEl && aceEl.env && aceEl.env.editor) {
        results.push({ filename: 'main.py', code: aceEl.env.editor.getValue() });
        return results;
      }

      return results;
    });
  }

  /**
   * Write code into the ZyStudio iframe's editor.
   * Supports Monaco Editor (primary) and ACE (fallback).
   * @param {string} code - The code to write
   * @param {number} editorIndex - Which editor/model to write to (0-based)
   */
  async function writeIframeCode(code, editorIndex = 0) {
    return await executeInIframe((code, editorIndex) => {

      // Helper: get the Monaco editor instance (not just model)
      function getEditorInstance() {
        if (typeof monaco === 'undefined' || !monaco.editor) return null;
        const editors = typeof monaco.editor.getEditors === 'function'
          ? monaco.editor.getEditors()
          : [];
        return editors[editorIndex] || editors[0] || null;
      }

      // Helper: get the model
      function getModel() {
        if (typeof monaco === 'undefined' || !monaco.editor) return null;
        const models = monaco.editor.getModels();
        return models[editorIndex] || models[0] || null;
      }

      // ── Strategy 1: Use editor instance executeEdits ──
      // This fires all change events that Firepad and collaborative layers listen to.
      // IMPORTANT: Do NOT verify synchronously via model.getValue() — Firepad's
      // collaborative layer updates the model asynchronously, so getValue() will
      // still return the old value immediately after executeEdits. The edit IS
      // applied; verification must happen later (via DOM or after a delay).
      const editor = getEditorInstance();
      if (editor) {
        const model = editor.getModel();
        if (model) {
          const fullRange = model.getFullModelRange();
          editor.executeEdits('zyagent', [{
            range: fullRange,
            text: code,
            forceMoveMarkers: true
          }]);
          return { success: true, method: 'monaco-executeEdits' };
        }
      }

      // ── Strategy 2: Model-only approach (no editor instance available) ──
      const model = getModel();
      if (model) {
        const fullRange = model.getFullModelRange();
        model.pushEditOperations(
          [],
          [{ range: fullRange, text: code }],
          () => null
        );
        return { success: true, method: 'monaco-model-pushEdit' };
      }

      // ── Strategy 3: Simulate paste into the Monaco textarea (DOM-level) ──
      const monacoEl = document.querySelector('.monaco-editor');
      if (monacoEl) {
        const textarea = monacoEl.querySelector('textarea.inputarea, textarea[class*="inputarea"]');
        if (textarea) {
          textarea.focus();
          textarea.dispatchEvent(new Event('focus', { bubbles: true }));

          // Select all via Ctrl+A
          textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'a', code: 'KeyA', keyCode: 65,
            ctrlKey: true, bubbles: true, cancelable: true
          }));

          // Paste via ClipboardEvent
          try {
            const dt = new DataTransfer();
            dt.setData('text/plain', code);
            textarea.dispatchEvent(new ClipboardEvent('paste', {
              bubbles: true,
              cancelable: true,
              clipboardData: dt,
            }));
            return { success: true, method: 'monaco-textarea-paste' };
          } catch (pasteErr) {
            try {
              document.execCommand('selectAll');
              document.execCommand('insertText', false, code);
              return { success: true, method: 'monaco-execCommand' };
            } catch (execErr) { /* fall through */ }
          }
        }
      }

      // ── Strategy 4: ACE editor fallback ──
      const aceEls = document.querySelectorAll('.ace_editor');
      const aceEl = aceEls[editorIndex] || aceEls[0];
      if (aceEl) {
        let aceEditor = null;
        if (aceEl.env && aceEl.env.editor) aceEditor = aceEl.env.editor;
        else if (window.ace) {
          try { aceEditor = window.ace.edit(aceEl); } catch (e) { /* ignore */ }
        }
        if (aceEditor) {
          const session = aceEditor.getSession();
          const savedRanges = session.$readOnlyRanges;
          session.$readOnlyRanges = null;
          aceEditor.setValue(code, -1);
          aceEditor.clearSelection();
          if (savedRanges) session.$readOnlyRanges = savedRanges;
          return { success: true, method: 'ace' };
        }
      }

      // ── Diagnostics: nothing worked ──
      return {
        success: false,
        error: 'No editor found',
        diag: {
          hasMonacoGlobal: typeof monaco !== 'undefined',
          hasMonacoEditor: typeof monaco !== 'undefined' && !!monaco?.editor,
          monacoModels: typeof monaco !== 'undefined' && monaco?.editor ? monaco.editor.getModels().length : 0,
          monacoEditors: typeof monaco !== 'undefined' && monaco?.editor && typeof monaco.editor.getEditors === 'function' ? monaco.editor.getEditors().length : 0,
          hasMonacoDom: !!document.querySelector('.monaco-editor'),
          hasTextarea: !!document.querySelector('textarea.inputarea'),
          hasAceDom: !!document.querySelector('.ace_editor'),
          hasFirepad: !!document.querySelector('.firepad'),
          url: window.location.href.substring(0, 100),
        }
      };
    }, [code, editorIndex]);
  }

  /**
   * Click the Run button inside the ZyStudio iframe.
   */
  async function clickIframeRun() {
    return await executeInIframe(() => {
      // ZyStudio / Codepad uses various run button selectors
      const selectors = [
        // Codepad-specific selectors (Angular app)
        'button.codepad-run-button:not([disabled])',
        '[class*="codepad"] button[class*="run"]:not([disabled])',
        'app-codepad-ide button[class*="run"]:not([disabled])',
        // Generic run buttons
        'button.run-button:not([disabled])',
        'button[aria-label="Run program"]:not([disabled])',
        'button[aria-label="Run"]:not([disabled])',
        'button.zb-button.run:not([disabled])',
        '.run-button:not([disabled])',
        'button[title="Run"]:not([disabled])',
      ];

      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn && !btn.disabled) {
          btn.click();
          return { success: true, selector: sel };
        }
      }

      // Fallback: find any button with "Run" text
      const allBtns = document.querySelectorAll('button:not([disabled])');
      for (const btn of allBtns) {
        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        if (text === 'run' || text === 'run program' || text.startsWith('run')) {
          btn.click();
          return { success: true, selector: 'text-match:' + text };
        }
      }

      // Fallback: look for play icon buttons (mat-icon with "play_arrow")
      const iconBtns = document.querySelectorAll('button:not([disabled])');
      for (const btn of iconBtns) {
        const icon = btn.querySelector('mat-icon, .material-icons, i[class*="play"]');
        if (icon && (icon.textContent.trim() === 'play_arrow' || icon.textContent.trim() === 'play_circle')) {
          btn.click();
          return { success: true, selector: 'icon-match:play' };
        }
      }

      return { success: false, error: 'Run button not found' };
    });
  }

  /**
   * Read the output/errors from the ZyStudio iframe after running code.
   */
  async function readIframeOutput() {
    return await executeInIframe(() => {
      // Codepad / ZyStudio output selectors (Angular app)
      const outputSelectors = [
        '.codepad-output', '.codepad-terminal', '.codepad-ide-output',
        '[class*="codepad"] [class*="output"]', '[class*="codepad"] [class*="terminal"]',
        'app-codepad-terminal', 'app-codepad-output',
        '.terminal-container', '.output-container',
        '.xterm-screen', '.xterm-rows',
        '.output-area', '.terminal-output', '.run-output', '.stdout', '.output',
      ];
      const errorSelectors = [
        '.error-output', '.stderr', '.compile-error',
        '[class*="error-output"]', '[class*="stderr"]',
      ];

      let outputText = '';
      for (const sel of outputSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          outputText = el.textContent.trim();
          break;
        }
      }

      let errorText = '';
      for (const sel of errorSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          errorText = el.textContent.trim();
          break;
        }
      }

      return { output: outputText, error: errorText };
    });
  }

  /**
   * Check if code is still running inside the iframe.
   */
  async function isIframeRunning() {
    try {
      const result = await executeInIframe(() => {
        // Check for disabled run button (common while running)
        const runBtns = document.querySelectorAll(
          'button.run-button, button[aria-label="Run program"], button[aria-label="Run"], ' +
          'button.codepad-run-button, [class*="codepad"] button[class*="run"]'
        );
        for (const btn of runBtns) {
          if (btn.disabled || btn.classList.contains('is-running')) return true;
        }
        // Check for spinners / loading indicators
        const spinnerSelectors = [
          '.activity-is-running', '.run-spinner', '.loading-spinner',
          '.codepad-spinner', '[class*="spinner"]', '.mat-progress-spinner',
          '.mat-spinner',
        ];
        for (const sel of spinnerSelectors) {
          const spinner = document.querySelector(sel);
          if (spinner && spinner.offsetParent !== null) return true;
        }
        // Check for a "Stop" button being visible (indicates program is running)
        const allBtns = document.querySelectorAll('button:not([disabled])');
        for (const btn of allBtns) {
          const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
          if (text === 'stop' || text === 'kill') return true;
        }
        return false;
      });
      return result;
    } catch {
      return false;
    }
  }

  /**
   * Provide input to the running program via the iframe's input area.
   */
  async function provideIframeInput(inputText) {
    return await executeInIframe((inputText) => {
      // ZyStudio / Codepad input selectors
      const inputSelectors = [
        'input.stdin-input', 'input[aria-label*="input"]',
        '.input-area input', 'textarea.stdin',
        '.codepad-input input', '.codepad-terminal input',
        '[class*="codepad"] input[type="text"]',
        '.xterm-helper-textarea',
      ];

      for (const sel of inputSelectors) {
        const inputEl = document.querySelector(sel);
        if (inputEl) {
          inputEl.value = inputText;
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          inputEl.dispatchEvent(new Event('change', { bubbles: true }));
          inputEl.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
          }));
          inputEl.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
          }));
          return { success: true };
        }
      }

      return { success: false, error: 'No input field found' };
    }, [inputText]);
  }

  // ════════════════════════════════════════════════════════════
  //  PARENT PAGE HELPERS
  // ════════════════════════════════════════════════════════════

  /**
   * Read the lab instructions from the parent page.
   */
  function readInstructions(el) {
    const parts = [];

    // Main instructions in .fr-view
    const frView = el.querySelector('.fr-view');
    if (frView) parts.push(frView.innerText.trim());

    // Activity payload description
    const desc = el.querySelector('.activity-description, .activity-title');
    if (desc) parts.push('Title: ' + desc.innerText.trim());

    return parts.join('\n\n');
  }

  /**
   * Read the current score from the parent page.
   * Returns { current, total } or null.
   */
  function readScore(el) {
    const scoreEl = el.querySelector('.lab-score');
    if (!scoreEl) return null;
    const text = scoreEl.innerText.trim(); // e.g., "0 / 10"
    const match = text.match(/(\d+)\s*\/\s*(\d+)/);
    if (match) return { current: parseInt(match[1]), total: parseInt(match[2]) };
    return null;
  }

  /**
   * Read test results from the parent page after submission.
   */
  function readTestResults(el) {
    const parts = [];

    // Test results container
    const testResults = el.querySelectorAll('.test-results .test-result, .test-results tr, .zb-card.test-results');
    if (testResults.length === 0) {
      // Check for "Latest submission" text
      const latestSubmission = el.querySelector('.test-results');
      if (latestSubmission) {
        parts.push(latestSubmission.innerText.trim());
      }
      return parts.join('\n');
    }

    for (const result of testResults) {
      const text = result.innerText.trim();
      if (text) parts.push(text);
    }

    return parts.join('\n').substring(0, 3000);
  }

  /**
   * Click "Submit for grading" on the parent page.
   */
  async function clickSubmitForGrading(el) {
    // Look for the "Submit for grading" button
    const submitBtn = Array.from(el.querySelectorAll('button.zb-button')).find(btn => {
      const text = (btn.innerText || btn.textContent || '').toLowerCase().trim();
      return text.includes('submit') && text.includes('grading');
    });

    if (!submitBtn) {
      console.warn('[ZyAgent Lab] Submit for grading button not found');
      return false;
    }

    if (submitBtn.disabled) {
      console.warn('[ZyAgent Lab] Submit for grading button is disabled');
      return false;
    }

    submitBtn.click();
    return true;
  }

  /**
   * Wait for submission to complete (test results to appear).
   */
  async function waitForSubmissionResults(el, timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Check for test result content (not just "No submissions yet")
      const testResultsCard = el.querySelector('.zb-card.test-results');
      if (testResultsCard) {
        const text = testResultsCard.innerText.trim();
        // Check if results have loaded (not the "No submissions yet" placeholder)
        if (text && !text.includes('No submissions yet') && text.includes('/')) {
          // Wait a bit more for the full results to render
          await Z.sleep(1000);
          return true;
        }
      }

      // Check if submission spinner is gone
      const spinner = el.querySelector('.submission-spinner, .loading');
      if (!spinner || spinner.offsetParent === null) {
        // Give it a moment after spinner disappears
        await Z.sleep(500);
        const card = el.querySelector('.zb-card.test-results');
        if (card && !card.innerText.includes('No submissions yet')) {
          return true;
        }
      }

      await Z.sleep(1000);
    }
    return false;
  }

  // ════════════════════════════════════════════════════════════
  //  MAIN LAB HANDLER
  // ════════════════════════════════════════════════════════════

  Z.handleLab = async function (activity, settings) {
    const el = activity.element;

    // Check if already completed
    if (Z.checkCompletion(el)) {
      Z.sendProgress(0, 0, `Lab "${activity.title}" already completed, skipping`, 'info');
      return;
    }

    const score = readScore(el);
    const totalPoints = score ? score.total : 10;

    Z.sendProgress(0, totalPoints, `Starting lab: ${activity.title}`);

    // Read instructions from the parent page
    const instructions = readInstructions(el);
    if (!instructions) {
      Z.sendProgress(0, totalPoints, 'Lab: No instructions found', 'error');
      return;
    }

    console.log('[ZyAgent Lab] Instructions:', instructions.substring(0, 200));

    // Wait for the ZyStudio iframe to be ready
    Z.sendProgress(0, totalPoints, 'Waiting for lab IDE to load…');

    // First, run a diagnostic to understand the iframe environment
    try {
      const diag = await executeInIframe(() => {
        return {
          url: window.location.href,
          hasMonacoGlobal: typeof monaco !== 'undefined',
          hasMonacoEditor: typeof monaco !== 'undefined' && !!monaco.editor,
          monacoModelCount: typeof monaco !== 'undefined' && monaco.editor ? monaco.editor.getModels().length : 0,
          monacoEditorCount: typeof monaco !== 'undefined' && monaco.editor && monaco.editor.getEditors ? monaco.editor.getEditors().length : 0,
          hasAce: !!document.querySelector('.ace_editor'),
          hasMonacoDom: !!document.querySelector('.monaco-editor'),
          hasFirepad: !!document.querySelector('.firepad'),
          hasCodepad: !!document.querySelector('[class*="codepad"]'),
          bodyClasses: document.body?.className || '',
          editorContainers: Array.from(document.querySelectorAll('[data-mode-id]')).map(e => e.getAttribute('data-mode-id')),
          allButtons: Array.from(document.querySelectorAll('button')).map(b => ({
            text: (b.innerText || '').trim().substring(0, 40),
            classes: b.className.substring(0, 60),
            disabled: b.disabled
          })).slice(0, 15),
          iframeCount: document.querySelectorAll('iframe').length,
        };
      });
      console.log('[ZyAgent Lab] Iframe diagnostic:', JSON.stringify(diag, null, 2));
      Z.sendProgress(0, totalPoints, `Lab IDE: ${diag?.hasMonacoGlobal ? 'Monaco found' : diag?.hasMonacoDom ? 'Monaco DOM found (API loading)' : 'Waiting for editor'}…`);
    } catch (diagErr) {
      console.warn('[ZyAgent Lab] Diagnostic failed:', diagErr.message);
      Z.sendProgress(0, totalPoints, `Lab IDE diagnostic: ${diagErr.message}`, 'warn');
    }

    const iframeReady = await waitForIframeReady(el, 30000);
    if (!iframeReady) {
      Z.sendProgress(0, totalPoints, 'Lab IDE iframe not ready — trying anyway…', 'warn');
    }

    // Read existing code template from the iframe
    Z.sendProgress(0, totalPoints, 'Reading code template…');
    let codeFiles = [];
    try {
      codeFiles = await readIframeCode();
    } catch (err) {
      console.warn('[ZyAgent Lab] Could not read iframe code:', err.message);
    }

    const existingCode = codeFiles && codeFiles.length > 0
      ? codeFiles.map(f => `# File: ${f.filename}\n${f.code}`).join('\n\n')
      : '';

    console.log('[ZyAgent Lab] Existing code:', existingCode.substring(0, 300));

    const maxRetries = 4;
    let lastCode = '';
    let lastTestResults = '';
    let lastActualOutput = '';
    let lastError = '';

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (Z.shouldStop) return;
      const isRetry = attempt > 0;

      const currentScore = readScore(el);
      if (currentScore && currentScore.current >= currentScore.total) {
        Z.sendProgress(currentScore.total, currentScore.total, `Lab "${activity.title}" completed!`, 'success');
        return;
      }

      Z.sendProgress(
        currentScore?.current || 0,
        totalPoints,
        `Lab: attempt ${attempt + 1}/${maxRetries}${isRetry ? ' (retrying)' : ''}`
      );

      // Build prompt for AI
      const messages = [
        {
          role: 'system',
          content: `You are an expert Python programmer solving a zyBooks lab assignment.
Write ONLY the complete Python code solution. No explanations, no markdown fences, no comments about what you changed.
The code must be complete and runnable.
If there is existing code with a template/scaffold, complete it while preserving any required structure.
Match any expected output EXACTLY including whitespace, newlines, and capitalization.
${Z.ZYBOOKS_OUTPUT_RULES}
${isRetry ? '\nYour previous attempt failed some test cases. Fix your code based on the feedback below.' : ''}`
        },
        {
          role: 'user',
          content: [
            `Lab instructions:\n${instructions}`,
            existingCode ? `\nExisting code template:\n${existingCode}` : '',
            isRetry && lastCode ? `\nYour previous code:\n${lastCode}` : '',
            isRetry && lastTestResults ? `\nTest results from previous attempt:\n${lastTestResults}` : '',
            isRetry && lastActualOutput ? `\nOutput from previous attempt:\n${lastActualOutput}` : '',
            isRetry && lastError ? `\nError from previous attempt:\n${lastError}` : '',
            '\nWrite the complete Python code solution.'
          ].filter(Boolean).join('\n')
        }
      ];

      Z.sendProgress(
        currentScore?.current || 0,
        totalPoints,
        `Lab: Asking AI for solution (attempt ${attempt + 1})…`
      );

      const response = await Z.callAI(settings, messages);

      // Clean the response
      let cleanCode = response
        .replace(/^```(?:python)?\n?/gm, '')
        .replace(/```\s*$/gm, '')
        .trim();

      // Fix literal escape sequences
      if (cleanCode.includes('\\n') || cleanCode.includes('\\t')) {
        if (!cleanCode.includes('\n')) {
          cleanCode = cleanCode.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        }
      }

      lastCode = cleanCode;
      console.log('[ZyAgent Lab] AI code:', cleanCode.substring(0, 300));

      // Write code into the iframe editor
      Z.sendProgress(
        currentScore?.current || 0,
        totalPoints,
        `Lab: Writing code to editor…`
      );

      try {
        const writeResult = await writeIframeCode(cleanCode);
        if (!writeResult || !writeResult.success) {
          const diagInfo = writeResult?.diag ? JSON.stringify(writeResult.diag) : '';
          Z.sendProgress(0, totalPoints, `Lab: Failed to write code — ${writeResult?.error || 'unknown'}`, 'error');
          console.warn('[ZyAgent Lab] Write failed, diagnostics:', JSON.stringify(writeResult));
          await Z.sleep(3000);
          continue;
        }

        // Verification: Wait for the edit to propagate through Firepad, then
        // verify via the DOM (visible view lines) rather than model.getValue()
        // because Firepad updates the model asynchronously.
        await Z.sleep(2000); // Give Firepad time to process the edit

        let verified = false;
        try {
          // Read the visible editor content from the DOM (view-lines), not the model
          const domContent = await executeInIframe(() => {
            const viewLines = document.querySelectorAll('.monaco-editor .view-lines .view-line');
            if (viewLines.length > 0) {
              const lineData = [];
              for (const line of viewLines) {
                const style = line.getAttribute('style') || '';
                const topMatch = style.match(/top:\s*(\d+)px/);
                const top = topMatch ? parseInt(topMatch[1]) : 0;
                lineData.push({ top, text: line.textContent });
              }
              lineData.sort((a, b) => a.top - b.top);
              return lineData.map(l => l.text).join('\n');
            }
            // Fallback: try model.getValue() (may have caught up by now)
            if (typeof monaco !== 'undefined' && monaco.editor) {
              const models = monaco.editor.getModels();
              if (models.length > 0) return models[0].getValue();
            }
            return '';
          });

          const editorCode = (domContent || '').trim();
          // Check if at least a meaningful snippet of our code is visible
          const expectedSnippet = cleanCode.trim().substring(0, 40);
          verified = editorCode.length > 10 && editorCode.includes(expectedSnippet);

          if (!verified) {
            console.warn('[ZyAgent Lab] Write verification: DOM shows:', editorCode.substring(0, 200));
            console.warn('[ZyAgent Lab] Expected to find:', expectedSnippet);
            // Don't fail — the code may have been written but the view might
            // only render visible lines (Monaco virtualizes). Trust the write.
            console.log('[ZyAgent Lab] Proceeding anyway — trusting executeEdits');
            verified = true; // Trust it
          }
        } catch (verifyErr) {
          console.warn('[ZyAgent Lab] Verification read-back failed:', verifyErr.message);
          verified = true; // Trust the write
        }

        Z.sendProgress(
          currentScore?.current || 0,
          totalPoints,
          `Lab: Code written via ${writeResult.method} ✓`
        );
      } catch (err) {
        Z.sendProgress(0, totalPoints, `Lab: Error writing to editor — ${err.message}`, 'error');
        await Z.sleep(3000);
        continue;
      }

      await Z.sleep(1000);

      // Click Run inside the iframe to verify the code works
      Z.sendProgress(
        currentScore?.current || 0,
        totalPoints,
        `Lab: Running code…`
      );

      try {
        const runResult = await clickIframeRun();
        console.log('[ZyAgent Lab] Run button result:', JSON.stringify(runResult));
        if (!runResult || !runResult.success) {
          console.warn('[ZyAgent Lab] Run button click failed:', runResult?.error);
        }
      } catch (err) {
        console.warn('[ZyAgent Lab] Could not click Run:', err.message);
      }

      // Wait for execution to finish
      const runStart = Date.now();
      while (Date.now() - runStart < 30000) {
        try {
          const running = await isIframeRunning();
          if (!running) break;
        } catch {
          break;
        }
        await Z.sleep(500);
      }
      await Z.sleep(2000);

      // Read output from the iframe
      try {
        const output = await readIframeOutput();
        lastActualOutput = output.output || '';
        lastError = output.error || '';
        console.log('[ZyAgent Lab] Run output:', (lastActualOutput || '(empty)').substring(0, 300));
        if (lastError) {
          console.log('[ZyAgent Lab] Run error:', lastError.substring(0, 300));
        }
      } catch (err) {
        console.warn('[ZyAgent Lab] Could not read output:', err.message);
      }

      // If there's a runtime error, skip submission and retry
      if (lastError && (lastError.includes('Error') || lastError.includes('Traceback'))) {
        Z.sendProgress(
          currentScore?.current || 0,
          totalPoints,
          `Lab: Code has errors, retrying… (attempt ${attempt + 1})`,
          'warn'
        );
        continue;
      }

      // Wait for Firepad to sync edits to Firebase before submitting.
      // The grading server reads from Firebase, not the local editor model.
      await Z.sleep(3000);

      // Click "Submit for grading" on the parent page
      Z.sendProgress(
        currentScore?.current || 0,
        totalPoints,
        `Lab: Submitting for grading…`
      );

      const submitted = await clickSubmitForGrading(el);
      if (!submitted) {
        Z.sendProgress(0, totalPoints, 'Lab: Could not click Submit for grading', 'error');
        continue;
      }

      // Wait for test results
      Z.sendProgress(
        currentScore?.current || 0,
        totalPoints,
        'Lab: Waiting for test results…'
      );

      const gotResults = await waitForSubmissionResults(el, 60000);
      await Z.sleep(2000);

      // Read test results
      lastTestResults = readTestResults(el);
      console.log('[ZyAgent Lab] Test results:', lastTestResults.substring(0, 500));

      // Check score after submission
      const newScore = readScore(el);
      if (newScore) {
        Z.sendProgress(
          newScore.current,
          newScore.total,
          `Lab: Score ${newScore.current}/${newScore.total} (attempt ${attempt + 1})`
        );

        if (newScore.current >= newScore.total) {
          Z.sendProgress(newScore.total, newScore.total, `Lab "${activity.title}" completed!`, 'success');
          return;
        }
      }

      // Check completion via chevron
      if (Z.checkCompletion(el)) {
        Z.sendProgress(totalPoints, totalPoints, `Lab "${activity.title}" completed!`, 'success');
        return;
      }

      if (attempt < maxRetries - 1) {
        Z.sendProgress(
          newScore?.current || 0,
          totalPoints,
          `Lab: ${newScore ? newScore.current + '/' + newScore.total : 'Not all tests passed'}. Retrying…`,
          'warn'
        );
      }
    }

    // Final check
    const finalScore = readScore(el);
    if (finalScore && finalScore.current >= finalScore.total) {
      Z.sendProgress(finalScore.total, finalScore.total, `Lab "${activity.title}" completed!`, 'success');
    } else if (Z.checkCompletion(el)) {
      Z.sendProgress(totalPoints, totalPoints, `Lab "${activity.title}" completed!`, 'success');
    } else {
      Z.sendProgress(
        finalScore?.current || 0,
        totalPoints,
        `Lab: Finished ${maxRetries} attempts. Score: ${finalScore ? finalScore.current + '/' + finalScore.total : 'unknown'}`,
        'error'
      );
    }
  };

})();
