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
   * 
   * Searches multiple locations:
   *   1. .lab-score element
   *   2. Previous submissions section (most recent submission score)
   *   3. Coding trail (aria-description with score)
   *   4. Any "X / Y" text in the results area
   */
  function readScore(el) {
    // Strategy 1: Direct lab-score element
    const scoreEl = el.querySelector('.lab-score');
    if (scoreEl) {
      const match = scoreEl.innerText.trim().match(/(\d+)\s*\/\s*(\d+)/);
      if (match) return { current: parseInt(match[1]), total: parseInt(match[2]) };
    }

    // Strategy 2: Latest submission in "Previous submissions" section
    const viewSubmissions = el.querySelector('.zb-card.view-submissions, .view-submissions');
    if (viewSubmissions) {
      // Find the first (most recent) submission row with a score
      const rows = viewSubmissions.querySelectorAll('.flex.h-9, .submission-row');
      for (const row of rows) {
        const text = row.innerText.trim();
        const match = text.match(/(\d+)\s*\/\s*(\d+)/);
        if (match) return { current: parseInt(match[1]), total: parseInt(match[2]) };
      }
      // Fallback: any score pattern in the submissions card
      const fullText = viewSubmissions.innerText;
      const match = fullText.match(/(\d+)\s*\/\s*(\d+)/);
      if (match) return { current: parseInt(match[1]), total: parseInt(match[2]) };
    }

    // Strategy 3: Coding trail — check the latest button's aria-description
    const trailButtons = el.querySelectorAll('.zylab-signature button[aria-description]');
    if (trailButtons.length > 0) {
      const lastTrail = trailButtons[trailButtons.length - 1];
      const desc = lastTrail.getAttribute('aria-description') || '';
      // e.g., "View submission at 04/05/26 7:34 PM with score of ,7"
      const scoreMatch = desc.match(/score\s+of\s+,?(\d+)/i);
      if (scoreMatch) {
        // We have the current score but need total; look for it elsewhere
        const current = parseInt(scoreMatch[1]);
        // Try to find total from the submissions section
        const totalMatch = el.innerText.match(/(\d+)\s*\/\s*(\d+)/);
        const total = totalMatch ? parseInt(totalMatch[2]) : 10;
        return { current, total };
      }
    }

    // Strategy 4: Broad search in the test results area
    const testArea = el.querySelector('.zb-card.test-results, .test-results');
    if (testArea) {
      const match = testArea.innerText.match(/(\d+)\s*\/\s*(\d+)/);
      if (match) return { current: parseInt(match[1]), total: parseInt(match[2]) };
    }

    return null;
  }

  /**
   * Read test results from the parent page after submission.
   * 
   * This function uses multiple strategies:
   *   1. Read the test-results card directly (if results have rendered)
   *   2. Click the latest "View" button in Previous submissions to expand details
   *   3. Parse individual test case pass/fail, input, expected output, actual output
   *   4. Fallback: screenshot analysis if nothing else works
   */
  async function readTestResults(el) {
    const parts = [];

    // ── Strategy 1: Direct test-results card ──
    const testResultsCard = el.querySelector('.zb-card.test-results');
    if (testResultsCard) {
      const cardText = testResultsCard.innerText.trim();
      // Skip placeholders
      if (cardText &&
          !cardText.includes('will appear here') &&
          !cardText.includes('No submissions yet') &&
          !cardText.includes('Autograded test cases are running')) {
        parts.push('=== TEST RESULTS ===');
        parts.push(cardText);
      }
    }

    // ── Strategy 2: Expand the latest submission "View" button ──
    // The real test details are hidden behind "View" buttons in the
    // "Previous submissions" section. Click the FIRST (most recent) one.
    const viewSubmissionsCard = el.querySelector('.zb-card.view-submissions, .view-submissions');
    if (viewSubmissionsCard) {
      // Find all View buttons
      const viewButtons = viewSubmissionsCard.querySelectorAll('button.zb-button');
      let latestViewBtn = null;
      for (const btn of viewButtons) {
        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        if (text.includes('view')) {
          latestViewBtn = btn;
          break; // First one = most recent submission
        }
      }

      if (latestViewBtn) {
        console.log('[ZyAgent Lab] Clicking latest View button to expand test details');
        latestViewBtn.click();
        await Z.sleep(2000);

        // After clicking View, test details should appear.
        // Look for expanded test case rows, result tables, etc.
        const expandedContent = _scrapeExpandedTestDetails(el);
        if (expandedContent) {
          parts.push('=== EXPANDED TEST DETAILS ===');
          parts.push(expandedContent);
        }
      }
    }

    // ── Strategy 3: Parse any visible test case elements in the page ──
    const testCaseDetails = _scrapeTestCaseElements(el);
    if (testCaseDetails) {
      parts.push(testCaseDetails);
    }

    // ── Strategy 4: Check for a score summary from the submission ──
    const score = readScore(el);
    if (score) {
      parts.push(`\nCurrent score: ${score.current} / ${score.total}`);
      if (score.current < score.total) {
        parts.push(`FAILED ${score.total - score.current} out of ${score.total} test cases.`);
      }
    }

    const result = parts.join('\n').substring(0, 5000);
    return result || 'No specific test feedback found.';
  }

  /**
   * Scrape expanded test case details after clicking a "View" button.
   * Looks for test result tables, pass/fail indicators, and expected vs actual output.
   */
  function _scrapeExpandedTestDetails(el) {
    const details = [];

    // Look for test case containers — zyLabs typically shows a table or list
    // with columns: Test case, Status (pass/fail), Input, Expected output, Your output
    const testCaseSelectors = [
      '.test-case-result', '.test-case', '.submission-test-result',
      '.test-result-row', '.test-result',
      'table.test-results tr', 'table tr',
      '.submission-detail .test', '.autograded-results .result',
    ];

    for (const sel of testCaseSelectors) {
      const rows = el.querySelectorAll(sel);
      if (rows.length > 0) {
        for (const row of rows) {
          const text = row.innerText.trim();
          if (text && text.length > 5) {
            details.push(text);
          }
        }
        if (details.length > 0) break;
      }
    }

    // Look for a detailed results table with header + data rows
    const tables = el.querySelectorAll('.zb-card table, .test-results table, .submission-details table');
    for (const table of tables) {
      const tableText = table.innerText.trim();
      if (tableText && tableText.length > 10) {
        details.push('Test Results Table:\n' + tableText);
      }
    }

    // Look for individual test pass/fail badges / icons
    const passFailElements = el.querySelectorAll(
      '[class*="pass"], [class*="fail"], [class*="correct"], [class*="incorrect"], ' +
      '.test-status, .result-status, [aria-label*="pass"], [aria-label*="fail"]'
    );
    if (passFailElements.length > 0) {
      const statusInfo = [];
      for (const pfEl of passFailElements) {
        const text = pfEl.innerText.trim();
        const classes = pfEl.className || '';
        const ariaLabel = pfEl.getAttribute('aria-label') || '';
        const parentText = pfEl.closest('tr, .test-case, .test-result, .flex')?.innerText?.trim() || '';
        
        let status = 'unknown';
        if (classes.includes('pass') || classes.includes('correct') || ariaLabel.includes('pass')) status = 'PASS';
        if (classes.includes('fail') || classes.includes('incorrect') || ariaLabel.includes('fail')) status = 'FAIL';
        
        statusInfo.push(`  ${status}: ${parentText || text}`);
      }
      if (statusInfo.length > 0) {
        details.push('Test case statuses:\n' + statusInfo.join('\n'));
      }
    }

    // Look for expected/actual output comparison
    const comparisonSelectors = [
      '.expected-output', '.actual-output', '.your-output', '.test-output',
      '[class*="expected"]', '[class*="actual"]', '[class*="your-output"]',
      '.programming-code-output', '.output-comparison',
    ];
    for (const sel of comparisonSelectors) {
      const outputs = el.querySelectorAll(sel);
      for (const output of outputs) {
        const text = output.innerText.trim();
        if (text) {
          const label = output.className || sel;
          details.push(`${label}: ${text}`);
        }
      }
    }

    return details.length > 0 ? details.join('\n\n') : null;
  }

  /**
   * Scrape any visible test case elements from the page.
   * This catches test results that may be rendered inline or in cards.
   */
  function _scrapeTestCaseElements(el) {
    const details = [];

    // Look for zy-specific test result containers
    // After "Submit for grading", zyLabs may render test results in various formats
    const cardContents = el.querySelectorAll('.zb-card-content');
    for (const card of cardContents) {
      // Skip cards with only placeholder text
      const text = card.innerText.trim();
      if (!text || text.includes('will appear here') || text.includes('No submissions')) continue;
      
      // Look for test case data within this card
      const testItems = card.querySelectorAll('.test-case, .test-result, tr, .flex.items-center');
      for (const item of testItems) {
        const itemText = item.innerText.trim();
        if (itemText && itemText.length > 5 && !details.includes(itemText)) {
          details.push(itemText);
        }
      }
    }

    // Look for any error messages that zyLabs might show inline
    const errorMessages = el.querySelectorAll(
      '.compilation-error, .runtime-error, [class*="error-message"], ' +
      '.error-output, [class*="stderr"]'
    );
    for (const errEl of errorMessages) {
      const text = errEl.innerText.trim();
      if (text) details.push('Error: ' + text);
    }

    return details.length > 0 ? details.join('\n') : null;
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
   * 
   * Watches for several signals:
   *   1. The "Autograded test cases are running" text to disappear
   *   2. The Submit button to become enabled again (not disabled)
   *   3. Test result content to appear in the results card
   *   4. A new entry to appear in the "Previous submissions" section
   *   5. The progress spinner to disappear
   */
  async function waitForSubmissionResults(el, timeoutMs = 90000) {
    const start = Date.now();

    // Count current submissions so we can detect when a new one appears
    const prevSubmissionCount = el.querySelectorAll('.view-submissions .flex.h-9, .view-submissions .submission-row').length;

    while (Date.now() - start < timeoutMs) {
      // Signal 1: Check if "Autograded test cases are running" is gone
      const runningText = el.querySelector('.italic');
      const isStillRunning = runningText &&
        runningText.innerText.includes('Autograded test cases are running');

      // Signal 2: Submit button became enabled again
      const submitBtn = Array.from(el.querySelectorAll('button.zb-button')).find(btn => {
        const text = (btn.innerText || '').toLowerCase().trim();
        return text.includes('submit') && text.includes('grading');
      });
      const submitEnabled = submitBtn && !submitBtn.disabled;

      // Signal 3: Test results card has real content
      const testResultsCard = el.querySelector('.zb-card.test-results');
      const hasRealResults = testResultsCard &&
        !testResultsCard.innerText.includes('will appear here') &&
        !testResultsCard.innerText.includes('No submissions yet') &&
        !testResultsCard.innerText.includes('Autograded test cases are running') &&
        testResultsCard.innerText.trim().length > 20;

      // Signal 4: New submission appeared in "Previous submissions"
      const currentSubmissionCount = el.querySelectorAll('.view-submissions .flex.h-9, .view-submissions .submission-row').length;
      const newSubmissionAppeared = currentSubmissionCount > prevSubmissionCount;

      // Signal 5: Progress spinner is gone
      const spinner = el.querySelector('.zb-progress-circular');
      const spinnerGone = !spinner || spinner.offsetParent === null;

      // We consider results ready if:
      //  - The running text is gone AND (submit is re-enabled OR new submission appeared)
      //  - OR real test results have appeared
      if (hasRealResults) {
        await Z.sleep(1000); // Extra settle time
        return true;
      }

      if (!isStillRunning && (submitEnabled || newSubmissionAppeared)) {
        await Z.sleep(2000); // Give results a moment to render
        return true;
      }

      // Special case: if spinner is gone and not still running, we're likely done
      if (spinnerGone && !isStillRunning && (Date.now() - start > 10000)) {
        await Z.sleep(1500);
        return true;
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

    const maxRetries = 5;
    let lastCode = '';
    let lastTestResults = '';
    let lastActualOutput = '';
    let lastError = '';
    let attemptHistory = []; // Track all attempts for better AI context

    // ── Pre-flight: Check if there are prior submissions with test feedback ──
    // If the user already has a partial score (e.g., 7/10), read those results
    // BEFORE the first attempt so the AI can learn from them.
    const priorScore = readScore(el);
    if (priorScore && priorScore.current > 0 && priorScore.current < priorScore.total) {
      console.log(`[ZyAgent Lab] Prior score found: ${priorScore.current}/${priorScore.total} — reading previous test results`);
      Z.sendProgress(priorScore.current, priorScore.total, 'Reading previous submission feedback…');
      
      lastTestResults = await readTestResults(el);
      console.log('[ZyAgent Lab] Prior test results:', lastTestResults.substring(0, 500));
      
      // Also read the current code (which is what got the previous score)
      if (existingCode) {
        lastCode = existingCode;
      }
      
      // Record as a "prior" attempt
      attemptHistory.push({
        attempt: 0,
        score: `${priorScore.current}/${priorScore.total}`,
        keyIssue: `Prior submission: ${priorScore.current}/${priorScore.total} tests passed`
      });
    }

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
      let retryContext = '';
      const hasPriorFeedback = !isRetry && lastTestResults && lastTestResults !== 'No specific test feedback found.';
      if (hasPriorFeedback) {
        // First attempt, but there's feedback from a PRIOR session's submissions
        retryContext = '\n\n═══ PRIOR SUBMISSION FEEDBACK ═══\n';
        retryContext += `A previous submission scored ${currentScore ? currentScore.current + '/' + currentScore.total : 'unknown'}.\n`;
        retryContext += `\nDETAILED TEST FEEDBACK FROM PRIOR ATTEMPT:\n${lastTestResults}\n`;
        retryContext += '\n═══ END FEEDBACK ═══\n';
        retryContext += '\nUse this feedback to write a CORRECT solution the first time.\n';
        retryContext += '- Fix all failing test cases identified above\n';
        retryContext += '- Pay close attention to expected vs actual output differences\n';
      } else if (isRetry) {
        retryContext = '\n\n═══ PREVIOUS ATTEMPT FAILED ═══\n';
        retryContext += `Your previous code scored ${currentScore ? currentScore.current + '/' + currentScore.total : 'unknown'}.\n`;
        if (lastTestResults && lastTestResults !== 'No specific test feedback found.') {
          retryContext += `\nDETAILED TEST FEEDBACK:\n${lastTestResults}\n`;
        }
        if (lastActualOutput) {
          retryContext += `\nYOUR CODE'S OUTPUT:\n${lastActualOutput}\n`;
        }
        if (lastError) {
          retryContext += `\nERROR MESSAGE:\n${lastError}\n`;
        }
        retryContext += '\n═══ END FEEDBACK ═══\n';
        retryContext += '\nCarefully analyze the test feedback above. Pay attention to:\n';
        retryContext += '- Which test cases PASSED and which FAILED\n';
        retryContext += '- The difference between expected output and your output\n';
        retryContext += '- Edge cases you may have missed\n';
        retryContext += '- Input values that your code handled incorrectly\n';

        // Include attempt history for persistent failures
        if (attemptHistory.length > 1) {
          retryContext += '\n\nATTEMPT HISTORY:\n';
          for (const hist of attemptHistory) {
            retryContext += `  Attempt ${hist.attempt}: Score ${hist.score || 'unknown'}\n`;
            if (hist.keyIssue) retryContext += `    Issue: ${hist.keyIssue}\n`;
          }
          retryContext += '\nYou have tried ' + attemptHistory.length + ' times. Do NOT repeat the same approach. Try a fundamentally different solution.\n';
        }
      }

      const messages = [
        {
          role: 'system',
          content: `You are an expert Python programmer solving a zyBooks lab assignment.
Write ONLY the complete Python code solution. No explanations, no markdown fences, no comments about what you changed.
The code must be complete and runnable.
If there is existing code with a template/scaffold, complete it while preserving any required structure.
Match any expected output EXACTLY including whitespace, newlines, and capitalization.
${Z.ZYBOOKS_OUTPUT_RULES}
${isRetry ? '\nIMPORTANT: Your previous attempt failed some test cases. You MUST carefully study the test feedback below and fix ALL failing test cases.' : ''}${hasPriorFeedback ? '\nIMPORTANT: There is feedback from a prior submission. Study it carefully and write a correct solution that addresses all failing test cases.' : ''}`
        },
        {
          role: 'user',
          content: [
            `Lab instructions:\n${instructions}`,
            existingCode ? `\nExisting code template:\n${existingCode}` : '',
            isRetry && lastCode ? `\nYour previous code (NEEDS FIXING):\n${lastCode}` : '',
            hasPriorFeedback && lastCode ? `\nPrior submission code (scored ${currentScore ? currentScore.current + '/' + currentScore.total : 'partial'}, NEEDS FIXING):\n${lastCode}` : '',
            retryContext,
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

      const gotResults = await waitForSubmissionResults(el, 90000);
      await Z.sleep(2000);

      // Read test results — this now expands the "View" button and scrapes details
      lastTestResults = await readTestResults(el);
      console.log('[ZyAgent Lab] Test results:', lastTestResults.substring(0, 1000));

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

      // Track attempt history
      const histEntry = {
        attempt: attempt + 1,
        score: newScore ? `${newScore.current}/${newScore.total}` : 'unknown',
        keyIssue: ''
      };
      if (lastError) histEntry.keyIssue = lastError.substring(0, 200);
      else if (lastTestResults.includes('FAIL')) histEntry.keyIssue = 'Test cases failed';
      else if (newScore && newScore.current < newScore.total) histEntry.keyIssue = `Only ${newScore.current}/${newScore.total} tests passed`;
      attemptHistory.push(histEntry);

      // If test results are still weak, try screenshot analysis for visual feedback
      if (attempt < maxRetries - 1 && (!lastTestResults || lastTestResults === 'No specific test feedback found.')) {
        try {
          const visualAnalysis = await Z.analyzeScreenshot(settings,
            'You are analyzing a zyBooks lab submission result. Look at the screenshot and describe: ' +
            '1) What is the current score? 2) Which test cases passed and which failed? ' +
            '3) What are the expected vs actual outputs shown? 4) Any error messages visible?',
            'Analyze this lab result screenshot. What went wrong with the submission?'
          );
          if (visualAnalysis) {
            lastTestResults = (lastTestResults || '') + '\n\nVISUAL ANALYSIS:\n' + visualAnalysis;
            console.log('[ZyAgent Lab] Visual analysis:', visualAnalysis.substring(0, 500));
          }
        } catch (err) {
          console.log('[ZyAgent Lab] Screenshot analysis skipped:', err.message);
        }
      }

      if (attempt < maxRetries - 1) {
        Z.sendProgress(
          newScore?.current || 0,
          totalPoints,
          `Lab: ${newScore ? newScore.current + '/' + newScore.total : 'Not all tests passed'}. Retrying with feedback…`,
          'warn'
        );
        // Small pause before retry to let the page settle
        await Z.sleep(1000);
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
