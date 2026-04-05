// ─── ZyBook Agent — Shared Utilities ───
// Common helper functions used across all content script modules.

(function () {
  'use strict';

  // Create the shared namespace
  window.ZyAgent = window.ZyAgent || {};

  // ─── State ───
  ZyAgent.isRunning = false;
  ZyAgent.shouldStop = false;

  // ─── Sleep ───
  ZyAgent.sleep = function (ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  };

  // ─── Wait for Element (MutationObserver-based, Playwright-style) ───
  ZyAgent.waitForElement = function (selector, { timeout = 10000, root = document, visible = false } = {}) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const el = root.querySelector(selector);
        if (el && (!visible || (el.offsetParent !== null && !el.hidden && el.style.display !== 'none'))) {
          return el;
        }
        return null;
      };

      const existing = check();
      if (existing) return resolve(existing);

      const observer = new MutationObserver(() => {
        const el = check();
        if (el) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });

      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(null); // resolve with null instead of rejecting to avoid breaking loops
      }, timeout);

      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'disabled', 'aria-label'] });
    });
  };

  // ─── Wait for a condition to become true ───
  ZyAgent.waitForCondition = async function (fn, { timeout = 10000, interval = 300 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = fn();
      if (result) return result;
      await ZyAgent.sleep(interval);
    }
    return null;
  };

  // ─── AI Communication ───
  ZyAgent.callAI = function (settings, messages) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          action: 'callOpenAI',
          payload: {
            apiKey: settings.apiKey,
            model: settings.model,
            messages
          }
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.error) {
            reject(new Error(response.error));
          } else if (response && response.content) {
            resolve(response.content);
          } else {
            reject(new Error('Empty response from AI'));
          }
        }
      );
    });
  };

  // ─── Progress Reporting ───
  ZyAgent.sendProgress = function (current, total, message, level = 'info') {
    try {
      chrome.runtime.sendMessage({ type: 'progress', current, total, message, level });
    } catch (e) {
      // Extension context may be invalidated
    }
  };

  // ─── zyBooks Output Formatting Context ───
  // Shared pre-context injected into AI calls that produce program output.
  // zyBooks compares output character-by-character including trailing whitespace.
  ZyAgent.ZYBOOKS_OUTPUT_RULES = `
CRITICAL — zyBooks OUTPUT FORMATTING RULES:
zyBooks checks output character-by-character. Whitespace MUST be exact.

1. TRAILING NEWLINE: Python's print() ALWAYS appends a newline character (\\n) at the end unless end="" is used.
   zyBooks EXPECTS that trailing newline. You MUST include it.
   Example: if code ends with print("No discount"), the output is:
   No discount
   <-- there is a blank line here because print() added \\n

2. MULTIPLE PRINTS: Each print() adds its own \\n.
   print("A")
   print("B")
   produces: "A\\nB\\n" — two lines of text, each ending with \\n.

3. ONLY OMIT trailing newline if the code explicitly uses end="".
   print("hello", end="") produces "hello" with NO trailing newline.

4. DO NOT add extra blank lines that the code doesn't produce.

5. Preserve exact spacing — no extra/missing spaces within lines.

When you respond, your answer must contain the trailing newline as an actual newline character at the end of your response. Do not explain — just output the exact text.`;

  // ─── Click Submit / Check Button (with wait-for-enabled) ───
  ZyAgent.clickSubmitButton = async function (container, { timeout = 8000 } = {}) {
    const selectors = [
      'button.check-button:not([disabled])',
      'button.submit-button:not([disabled])',
      'button[aria-label="Check"]:not([disabled])',
      'button[aria-label="Submit"]:not([disabled])',
      '.check-button:not([disabled])',
      '.submit-btn:not([disabled])',
      'button.action-button:not([disabled])',
      'button.zb-button.check:not([disabled])'
    ];

    // First attempt: immediate check
    for (const sel of selectors) {
      const btn = container.querySelector(sel);
      if (btn && !btn.disabled && !ZyAgent.isDangerousButton(btn)) {
        btn.click();
        await ZyAgent.sleep(1000);
        return true;
      }
    }

    // Second attempt: wait for any submit-like button to become enabled
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const sel of selectors) {
        const btn = container.querySelector(sel);
        if (btn && !btn.disabled && !ZyAgent.isDangerousButton(btn)) {
          btn.click();
          await ZyAgent.sleep(1000);
          return true;
        }
      }

      // Fallback: find any button with "check" or "submit" text
      const allBtns = container.querySelectorAll('button:not([disabled])');
      for (const btn of allBtns) {
        const text = btn.innerText.toLowerCase();
        if ((text.includes('check') || text.includes('submit')) && !btn.disabled && !ZyAgent.isDangerousButton(btn)) {
          btn.click();
          await ZyAgent.sleep(1000);
          return true;
        }
      }

      await ZyAgent.sleep(500);
    }

    return false;
  };

  // ─── Set Value on Input (React/Ember compatible) ───
  ZyAgent.setNativeValue = function (el, value) {
    // Handle <select> elements
    if (el.tagName === 'SELECT') {
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }

    // Dispatch events in the order frameworks expect
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  };

  // ─── Dangerous Button Check ───
  // Returns true if the button would reset/destroy activity state.
  // All click helpers should check this before clicking.
  ZyAgent.isDangerousButton = function (btn) {
    if (!btn) return false;
    const text = (btn.innerText || btn.textContent || '').toLowerCase().trim();
    const classList = btn.className || '';
    // "Load default template" resets Parsons problems
    if (text.includes('load default template')) return true;
    if (classList.includes('reset-template-button')) return true;
    // Other dangerous patterns
    if (text.includes('reset') && !text.includes('password')) return true;
    return false;
  };

  // ─── ACE Editor Helpers (via page bridge) ───
  // The ACE editor lives in the page's JS context (MAIN world).
  // Content scripts run in an ISOLATED world and cannot access window.ace
  // or aceEl.env.editor. We communicate via CustomEvents through the DOM.

  let _bridgeRequestId = 0;
  let _bridgeReady = false;

  // Wait for the MAIN world bridge to signal it's ready
  ZyAgent.waitForBridge = async function (timeoutMs = 10000) {
    if (_bridgeReady) return true;

    // Check if already ready (bridge may have loaded before us)
    if (document.documentElement.getAttribute('data-zyagent-bridge-ready') === 'true') {
      _bridgeReady = true;
      return true;
    }

    return new Promise((resolve) => {
      const handler = () => {
        _bridgeReady = true;
        document.removeEventListener('zyagent-bridge-ready', handler);
        clearTimeout(timer);
        resolve(true);
      };
      document.addEventListener('zyagent-bridge-ready', handler);

      const timer = setTimeout(() => {
        document.removeEventListener('zyagent-bridge-ready', handler);
        // Still try — bridge may be loaded but event was missed
        _bridgeReady = true;
        resolve(true);
      }, timeoutMs);

      // Also poll for the window flag
      const poll = setInterval(() => {
        // The bridge sets __zyagentBridgeReady on window, but we're in isolated world.
        // Instead, poll for any ace_editor existing — if they exist, bridge should be loaded
        if (document.querySelector('.ace_editor')) {
          clearInterval(poll);
          _bridgeReady = true;
          document.removeEventListener('zyagent-bridge-ready', handler);
          clearTimeout(timer);
          resolve(true);
        }
      }, 500);

      setTimeout(() => clearInterval(poll), timeoutMs);
    });
  };

  // Send a request to the page bridge and wait for a response
  ZyAgent.bridgeRequest = async function (eventName, detail, timeoutMs = 5000) {
    // Ensure bridge is ready before sending requests
    await ZyAgent.waitForBridge(5000);

    return new Promise((resolve) => {
      const requestId = 'zyagent-' + (++_bridgeRequestId);
      detail.requestId = requestId;

      const handler = function (e) {
        if (e.detail && e.detail.requestId === requestId) {
          document.removeEventListener('zyagent-ace-response', handler);
          resolve(e.detail);
        }
      };
      document.addEventListener('zyagent-ace-response', handler);

      // Timeout fallback
      setTimeout(() => {
        document.removeEventListener('zyagent-ace-response', handler);
        resolve({ success: false, value: '', error: 'timeout' });
      }, timeoutMs);

      document.dispatchEvent(new CustomEvent(eventName, { detail }));
    });
  };

  // Tag an ACE editor element with a unique ID for the bridge to find it
  ZyAgent.tagAceEditor = function (containerEl) {
    const aceEl = containerEl.querySelector('.ace_editor');
    if (!aceEl) return null;
    if (!aceEl.getAttribute('data-zyagent-id')) {
      const id = 'zyagent-ace-' + (++_bridgeRequestId);
      aceEl.setAttribute('data-zyagent-id', id);
    }
    return aceEl.getAttribute('data-zyagent-id');
  };

  ZyAgent.getAceEditorValue = async function (containerEl) {
    const tag = ZyAgent.tagAceEditor(containerEl);
    if (!tag) {
      // Fallback: read from text layer
      const textLayer = containerEl.querySelector('.ace_text-layer');
      if (textLayer) {
        const lines = textLayer.querySelectorAll('.ace_line, .ace_line_group');
        return Array.from(lines).map(l => l.textContent).join('\n');
      }
      return '';
    }
    const result = await ZyAgent.bridgeRequest('zyagent-ace-get-value', {
      editorSelector: tag
    });
    if (result.success) return result.value;
    // Fallback: text layer
    const textLayer = containerEl.querySelector('.ace_text-layer');
    if (textLayer) {
      const lines = textLayer.querySelectorAll('.ace_line, .ace_line_group');
      return Array.from(lines).map(l => l.textContent).join('\n');
    }
    return '';
  };

  ZyAgent.setAceEditorValue = async function (containerEl, value) {
    const tag = ZyAgent.tagAceEditor(containerEl);
    if (!tag) return false;
    const result = await ZyAgent.bridgeRequest('zyagent-ace-set-value', {
      editorSelector: tag,
      code: value
    });
    return result.success;
  };

  ZyAgent.aceEditorFindReplace = async function (containerEl, needle, replacement) {
    const tag = ZyAgent.tagAceEditor(containerEl);
    if (!tag) return false;
    const result = await ZyAgent.bridgeRequest('zyagent-ace-find-replace', {
      editorSelector: tag,
      needle,
      replacement
    });
    return result.success;
  };

  /**
   * Query the ACE editor via the page bridge to get authoritative read-only line ranges.
   * Returns { success, readOnlyLines: number[], editableLines: number[], method: string }
   * Line numbers are 0-based.
   */
  ZyAgent.getAceReadOnlyRanges = async function (containerEl) {
    const tag = ZyAgent.tagAceEditor(containerEl);
    if (!tag) return { success: false, readOnlyLines: [], editableLines: [], method: 'no-tag' };
    const result = await ZyAgent.bridgeRequest('zyagent-ace-get-readonly', {
      editorSelector: tag
    }, 10000); // longer timeout for probe-based detection
    return result;
  };

  // ─── Drag and Drop Simulation ───
  // Strategy 1: Full mouse-event sequence (for ember-sortable / Sortable.js)
  // ember-sortable uses mousedown → mousemove (sustained) → mouseup, NOT DragEvent.
  ZyAgent.simulateDragDrop = async function (source, target, { overrideTargetX } = {}) {
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();

    const sx = sourceRect.x + sourceRect.width / 2;
    const sy = sourceRect.y + sourceRect.height / 2;
    const tx = overrideTargetX != null ? overrideTargetX : (targetRect.x + targetRect.width / 2);
    const ty = targetRect.y + targetRect.height / 2;

    // ── Attempt A: Pointer / mouse events (ember-sortable style) ──
    // ember-sortable listens for mousedown, then tracks mousemove on document,
    // then mouseup to finalise the drop. We must move gradually so it registers.

    // 1. Press down on source
    source.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0, pointerId: 1
    }));
    source.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0
    }));

    // 2. Small initial move to trigger drag recognition (many libs need this)
    await ZyAgent.sleep(80);
    document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, cancelable: true, clientX: sx, clientY: sy + 5, button: 0, pointerId: 1
    }));
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, clientX: sx, clientY: sy + 5, button: 0
    }));
    await ZyAgent.sleep(80);

    // 3. Animate move from source to target in steps (ember-sortable needs this)
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const ratio = i / steps;
      const cx = sx + (tx - sx) * ratio;
      const cy = sy + (ty - sy) * ratio;
      document.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, pointerId: 1
      }));
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0
      }));
      await ZyAgent.sleep(30);
    }

    // 4. Hover over target briefly
    await ZyAgent.sleep(100);
    target.dispatchEvent(new PointerEvent('pointerover', {
      bubbles: true, cancelable: true, clientX: tx, clientY: ty, pointerId: 1
    }));
    target.dispatchEvent(new MouseEvent('mouseover', {
      bubbles: true, cancelable: true, clientX: tx, clientY: ty
    }));
    target.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, cancelable: true, clientX: tx, clientY: ty, button: 0, pointerId: 1
    }));
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, clientX: tx, clientY: ty, button: 0
    }));
    await ZyAgent.sleep(100);

    // 5. Release
    target.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, clientX: tx, clientY: ty, button: 0, pointerId: 1
    }));
    target.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, clientX: tx, clientY: ty, button: 0
    }));

    await ZyAgent.sleep(150);

    // ── Attempt B: HTML5 DragEvent fallback (some sortable libs still use these) ──
    const dataTransfer = new DataTransfer();

    source.dispatchEvent(new DragEvent('dragstart', {
      bubbles: true, dataTransfer, clientX: sx, clientY: sy
    }));
    await ZyAgent.sleep(50);

    target.dispatchEvent(new DragEvent('dragenter', {
      bubbles: true, dataTransfer, clientX: tx, clientY: ty
    }));
    target.dispatchEvent(new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer, clientX: tx, clientY: ty
    }));
    await ZyAgent.sleep(50);

    target.dispatchEvent(new DragEvent('drop', {
      bubbles: true, dataTransfer, clientX: tx, clientY: ty
    }));
    source.dispatchEvent(new DragEvent('dragend', {
      bubbles: true, dataTransfer
    }));
  };

  // ─── Sortable List Helpers (via page bridge, for Parsons problems) ───
  // Moves a block from one sortable list to another using the MAIN-world bridge.
  // This is needed because ember-sortable manages state internally and synthetic
  // events from the ISOLATED world often don't trigger it.
  ZyAgent.sortableMoveBlock = async function (sourceListSelector, targetListSelector, sourceBlockId, targetInsertIndex, indentLevel = 0, sourceBlockText = '') {
    const result = await ZyAgent.bridgeRequest('zyagent-sortable-move', {
      sourceListSelector,
      targetListSelector,
      sourceBlockId: String(sourceBlockId),
      sourceBlockText,
      targetInsertIndex,
      indentLevel
    }, 20000); // longer timeout for animated drag with retries
    return result;
  };

  // Read the current state of sortable lists from MAIN world
  ZyAgent.sortableReadState = async function (containerSelector) {
    const result = await ZyAgent.bridgeRequest('zyagent-sortable-read', {
      containerSelector
    }, 5000);
    return result;
  };

  // Adjust the indentation of a block in the used list via MAIN world
  ZyAgent.sortableAdjustIndent = async function (containerSelector, blockText, blockId, desiredIndent) {
    const result = await ZyAgent.bridgeRequest('zyagent-sortable-adjust-indent', {
      containerSelector,
      blockText,
      blockId: String(blockId),
      desiredIndent
    }, 10000);
    return result;
  };

  // Reorder a block within the used list (move it to a different position)
  ZyAgent.sortableReorder = async function (containerSelector, blockText, blockId, targetIndex) {
    const result = await ZyAgent.bridgeRequest('zyagent-sortable-reorder', {
      containerSelector,
      blockText,
      blockId: String(blockId),
      targetIndex
    }, 10000);
    return result;
  };

  /**
   * Bulk-reorder ALL blocks in the used list to match desiredOrder.
   * desiredOrder = [ { text: "...", isLocked: bool }, ... ] in final order.
   * Uses sequential mouse-drag with DOM-manipulation fallback.
   */
  ZyAgent.sortableReorderAll = async function (containerSelector, desiredOrder) {
    const result = await ZyAgent.bridgeRequest('zyagent-sortable-reorder-all', {
      containerSelector,
      desiredOrder
    }, 30000); // generous timeout for multi-block reorder
    return result;
  };

  // Run Ember diagnostic introspection for debugging Parsons block model
  ZyAgent.sortableEmberDiagnostic = async function (containerSelector) {
    const result = await ZyAgent.bridgeRequest('zyagent-sortable-ember-diagnostic', {
      containerSelector
    }, 10000);
    return result;
  };

  // Detect the actual indent pixel value used in the Parsons editor
  ZyAgent.sortableDetectIndent = async function (containerSelector) {
    const result = await ZyAgent.bridgeRequest('zyagent-sortable-detect-indent', {
      containerSelector
    }, 5000);
    return result;
  };

  // ── Keyboard-based sortable operations (zyBooks native a11y) ──
  // Uses "Grab/release Spacebar. Move ↑↓←→" — the most reliable method.
  ZyAgent.sortableKeyboardMove = async function (sourceListSelector, targetListSelector,
    sourceBlockText, sourceBlockId, targetInsertIndex, indentLevel = 0, direction = 'unused-to-used') {
    const result = await ZyAgent.bridgeRequest('zyagent-sortable-keyboard-move', {
      sourceListSelector,
      targetListSelector,
      sourceBlockText,
      sourceBlockId: String(sourceBlockId || ''),
      targetInsertIndex,
      indentLevel,
      direction
    }, 15000);
    return result;
  };

  ZyAgent.sortableKeyboardIndent = async function (containerSelector, blockText, blockId, desiredIndent) {
    const result = await ZyAgent.bridgeRequest('zyagent-sortable-keyboard-indent', {
      containerSelector,
      blockText,
      blockId: String(blockId || ''),
      desiredIndent
    }, 10000);
    return result;
  };

  // ─── MC Prompt Builders (shared between MC and generic handlers) ───
  ZyAgent.buildMCPrompt = function (question, choices) {
    const choiceText = choices.map((c, i) => `${i}) ${c.text}`).join('\n');
    return [
      {
        role: 'system',
        content: `You are an expert Python programming tutor helping with a zyBooks assignment.
Answer multiple choice questions accurately.
Respond with ONLY the index number (0-based) of the correct answer. Nothing else — just the number.
If you're not sure, make your best educated guess.`
      },
      {
        role: 'user',
        content: `Question: ${question}\n\nChoices:\n${choiceText}\n\nRespond with ONLY the number of the correct choice.`
      }
    ];
  };

  ZyAgent.parseMCAnswer = function (response, choices) {
    const text = response.trim();
    const match = text.match(/\d+/);
    if (match) {
      const idx = parseInt(match[0]);
      if (idx >= 0 && idx < choices.length) return idx;
    }
    const letterMatch = text.match(/^[A-Za-z]/);
    if (letterMatch) {
      const idx = letterMatch[0].toUpperCase().charCodeAt(0) - 65;
      if (idx >= 0 && idx < choices.length) return idx;
    }
    return 0;
  };

  // ─── Screenshot Capability ───
  /**
   * Capture a screenshot of the visible browser tab.
   * Returns a data URL (base64 JPEG) or null on failure.
   */
  ZyAgent.captureScreenshot = async function () {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'captureScreenshot',
        format: 'jpeg',
        quality: 60
      });
      if (response.error) {
        console.warn('[ZyAgent] Screenshot failed:', response.error);
        return null;
      }
      return response.dataUrl;
    } catch (err) {
      console.warn('[ZyAgent] Screenshot error:', err.message);
      return null;
    }
  };

  /**
   * Capture a screenshot and ask AI to analyze it visually.
   * Useful when DOM scraping misses important visual context.
   * @param {object} settings - { apiKey, model }
   * @param {string} systemPrompt - Instructions for the AI
   * @param {string} userPrompt - The specific question about the screenshot
   * @returns {string|null} AI response or null on failure
   */
  ZyAgent.analyzeScreenshot = async function (settings, systemPrompt, userPrompt) {
    const screenshot = await ZyAgent.captureScreenshot();
    if (!screenshot) return null;

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'callOpenAIVision',
        payload: {
          apiKey: settings.apiKey,
          model: settings.model,
          systemPrompt,
          userPrompt,
          imageDataUrl: screenshot,
          maxTokens: 1024
        }
      });
      if (response.error) {
        console.warn('[ZyAgent] Vision analysis failed:', response.error);
        return null;
      }
      return response.content;
    } catch (err) {
      console.warn('[ZyAgent] Vision analysis error:', err.message);
      return null;
    }
  };

})();
