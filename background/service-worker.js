// ─── Background Service Worker ───
// Handles OpenAI API communication so API keys stay out of content scripts.
// Also opens the side panel when the toolbar icon is clicked.

// Open the side panel when the extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'callOpenAI') {
    handleOpenAICall(msg.payload)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true; // async response
  }

  if (msg.action === 'executeInLabIframe') {
    handleLabIframeExecution(msg, sender)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true; // async response
  }

  if (msg.action === 'captureScreenshot') {
    // Capture the visible tab as a data URL (PNG or JPEG)
    // The content script can then use this for AI vision analysis
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: 'No tab ID available' });
      return;
    }
    chrome.tabs.captureVisibleTab(sender.tab.windowId, {
      format: msg.format || 'jpeg',
      quality: msg.quality || 60 // Lower quality for smaller payload to AI
    })
      .then(dataUrl => sendResponse({ dataUrl }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // async response
  }

  if (msg.action === 'callOpenAIVision') {
    // Call OpenAI with a screenshot image for visual analysis
    handleOpenAIVisionCall(msg.payload)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

/**
 * Execute a function inside the ZyStudio lab iframe.
 * Finds the zystudio iframe in the sender's tab and injects the given function.
 */
async function handleLabIframeExecution(msg, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) throw new Error('No tab ID available');

  const { func, args } = msg;

  // Get all frames in the tab to find the ZyStudio iframe
  const frames = await chrome.webNavigation.getAllFrames({ tabId });

  // Log all frames for debugging
  console.log('[ZyAgent SW] All frames in tab:', frames.map(f => ({
    frameId: f.frameId,
    parentFrameId: f.parentFrameId,
    url: f.url?.substring(0, 120)
  })));

  // Find the ZyStudio iframe — check multiple URL patterns
  let zyStudioFrame = frames.find(f =>
    f.url && f.frameId !== 0 && (
      f.url.includes('zystudio.zybooks.com') ||
      f.url.includes('zystudio') ||
      f.url.includes('codepad') ||
      f.url.includes('coral.zybooks.com')
    )
  );

  // If not found, try any non-top-level frame that isn't about:blank
  if (!zyStudioFrame) {
    zyStudioFrame = frames.find(f =>
      f.frameId !== 0 &&
      f.url &&
      !f.url.startsWith('about:') &&
      !f.url.startsWith('chrome:') &&
      f.url.includes('zybooks')
    );
  }

  if (!zyStudioFrame) {
    const frameUrls = frames.map(f => f.url).join(', ');
    throw new Error(`ZyStudio iframe not found. Frames: ${frameUrls}`);
  }

  console.log('[ZyAgent SW] Injecting into frame:', zyStudioFrame.frameId, zyStudioFrame.url?.substring(0, 120));

  // Inject the function into the iframe
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [zyStudioFrame.frameId] },
    func: (funcStr, funcArgs) => {
      try {
        // Reconstruct the function from its string representation
        const fn = new Function('return (' + funcStr + ')')();
        return fn(...funcArgs);
      } catch (err) {
        return { error: err.message };
      }
    },
    args: [func, args],
    world: 'MAIN' // Run in the page's JS context to access Monaco/ACE editor APIs
  });

  if (results && results[0]) {
    const result = results[0].result;
    if (result && result.error) {
      throw new Error(result.error);
    }
    return { result };
  }

  throw new Error('No result from iframe script injection');
}

async function handleOpenAICall({ apiKey, model, messages, temperature = 0.2, maxTokens = 2048 }) {
  const maxRetries = 3;
  let lastError = null;

  // Reasoning models (o-series) don't support temperature or max_tokens;
  // they use max_completion_tokens and only accept "developer" + "user" roles.
  const isReasoning = /^(o1|o3|o4)/.test(model);

  // GPT-5 series models (gpt-5, gpt-5.4, etc.) are also reasoning-capable.
  // They only support temperature=1 (default), use max_completion_tokens,
  // and require "developer" role instead of "system".
  const isGPT5 = /^gpt-5/.test(model);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const body = { model, messages };

      if (isReasoning || isGPT5) {
        body.max_completion_tokens = maxTokens;
        // These models don't accept system messages — convert to developer role
        // and don't support custom temperature (only default=1)
        body.messages = messages.map(m =>
          m.role === 'system' ? { ...m, role: 'developer' } : m
        );
      } else {
        body.temperature = temperature;
        body.max_tokens = maxTokens;
      }

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });

      // Don't retry on auth errors or bad requests
      if (response.status === 401 || response.status === 403 || response.status === 400) {
        const errBody = await response.text();
        throw new Error(`OpenAI API ${response.status}: ${errBody}`);
      }

      // Retry on rate limits and server errors
      if (response.status === 429 || response.status >= 500) {
        const errBody = await response.text();
        lastError = new Error(`OpenAI API ${response.status}: ${errBody}`);
        // Exponential backoff: 2s, 4s, 8s
        const delay = Math.pow(2, attempt + 1) * 1000;
        console.warn(`[ZyAgent] OpenAI ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`OpenAI API ${response.status}: ${errBody}`);
      }

      const data = await response.json();
      return {
        content: data.choices[0].message.content,
        usage: data.usage
      };
    } catch (err) {
      lastError = err;
      // Network errors — retry
      if (err.name === 'TypeError' && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt + 1) * 1000;
        console.warn(`[ZyAgent] Network error, retrying in ${delay}ms:`, err.message);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('OpenAI API call failed after retries');
}

/**
 * Call OpenAI with an image (screenshot) for visual analysis.
 * Uses the chat completions API with image_url content parts.
 * Supports GPT-4o, GPT-4.1, and GPT-5 models with vision.
 */
async function handleOpenAIVisionCall({ apiKey, model, systemPrompt, userPrompt, imageDataUrl, maxTokens = 1024 }) {
  // Vision-capable models: gpt-4o, gpt-4.1, gpt-5.4 series
  // For reasoning models, fall back to gpt-4.1 for vision
  const visionModel = /^(o1|o3|o4)/.test(model) ? 'gpt-4.1' : model;

  const isReasoning = /^(o1|o3|o4)/.test(visionModel);
  const isGPT5 = /^gpt-5/.test(visionModel);

  const messages = [
    {
      role: (isReasoning || isGPT5) ? 'developer' : 'system',
      content: systemPrompt
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: userPrompt },
        {
          type: 'image_url',
          image_url: {
            url: imageDataUrl,
            detail: 'low' // 'low' = cheaper, 'high' = more detail
          }
        }
      ]
    }
  ];

  const body = { model: visionModel, messages };

  if (isReasoning || isGPT5) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.temperature = 0.2;
    body.max_tokens = maxTokens;
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`OpenAI Vision API ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  return {
    content: data.choices[0].message.content,
    usage: data.usage
  };
}
