// ─── ZyBook Agent — Content Script Entry Point ───
// Slim entry point: creates overlay, listens for messages, routes to handlers.
// All handlers + utilities are loaded via separate files and share window.ZyAgent.

(function () {
  'use strict';

  if (window.__zyAgentLoaded) return;
  window.__zyAgentLoaded = true;

  const Z = window.ZyAgent;

  // Inline SVG for the robot icon
  const ROBOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M200,48H136V16a8,8,0,0,0-16,0V48H56A32,32,0,0,0,24,80V192a32,32,0,0,0,32,32H200a32,32,0,0,0,32-32V80A32,32,0,0,0,200,48Zm16,144a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V80A16,16,0,0,1,56,64H200a16,16,0,0,1,16,16Zm-36-56a12,12,0,1,1-12-12A12,12,0,0,1,180,136Zm-72,0a12,12,0,1,1-12-12A12,12,0,0,1,108,136Zm-4,36h48a8,8,0,0,1,0,16H104a8,8,0,0,1,0-16Z"/></svg>`;

  // ─── Overlay UI ───
  function createOverlay() {
    if (document.getElementById('zyagent-overlay')) return;
    const div = document.createElement('div');
    div.id = 'zyagent-overlay';
    div.className = 'zyagent-overlay hidden';
    div.innerHTML = `
      <div class="title">${ROBOT_SVG} ZyBook Agent</div>
      <div class="status" id="zyagent-status">Ready</div>
    `;
    document.body.appendChild(div);
  }

  function showOverlay(text) {
    const el = document.getElementById('zyagent-overlay');
    if (el) {
      el.classList.remove('hidden');
      el.querySelector('.status').textContent = text;
    }
  }

  function hideOverlay() {
    const el = document.getElementById('zyagent-overlay');
    if (el) el.classList.add('hidden');
  }

  function updateOverlay(text) {
    const el = document.getElementById('zyagent-status');
    if (el) el.textContent = text;
  }

  createOverlay();

  // ─── Message Handler ───
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'scan') {
      const activities = Z.scanActivities();
      sendResponse({ activities });
    }
    if (msg.action === 'run') {
      runAgent(msg.settings);
      sendResponse({ started: true });
    }
    if (msg.action === 'stop') {
      Z.shouldStop = true;
      Z.isRunning = false;
      hideOverlay();
      sendResponse({ stopped: true });
    }
    return true;
  });

  // ─── Handler Router ───
  async function handleActivity(activity, settings) {
    switch (activity.type) {
      case 'animation':
        return Z.handleAnimation(activity, settings);
      case 'multiple-choice':
      case 'true-false':
        return Z.handleMultipleChoice(activity, settings);
      case 'short-answer':
        return Z.handleShortAnswer(activity, settings);
      case 'content-tool':
        return Z.handleContentTool(activity, settings);
      case 'challenge':
        return Z.handleChallenge(activity, settings);
      case 'coding':
        return Z.handleCoding(activity, settings);
      case 'lab':
        return Z.handleLab(activity, settings);
      case 'matching':
        return Z.handleMatching(activity, settings);
      case 'definition-match':
        return Z.handleDefinitionMatch(activity, settings);
      case 'participation':
        return Z.handleParticipation(activity);
      default:
        return Z.handleGenericActivity(activity, settings);
    }
  }

  // ─── Agent Runner ───
  async function runAgent(settings) {
    if (Z.isRunning) return;
    Z.isRunning = true;
    Z.shouldStop = false;

    showOverlay('Starting agent…');

    // Wait for page to stabilize (zyBooks SPA renders dynamically)
    await Z.sleep(1000);

    // Initial scan
    Z.scanActivities();
    let activities = Z.activities || [];
    let incomplete = activities.filter(a => !a.completed);

    if (incomplete.length === 0) {
      Z.sendProgress(0, 0, 'All activities already completed!', 'success');
      chrome.runtime.sendMessage({ type: 'done' });
      hideOverlay();
      Z.isRunning = false;
      return;
    }

    const totalCount = incomplete.length;
    let completedCount = 0;

    for (let i = 0; i < incomplete.length; i++) {
      if (Z.shouldStop) break;

      const activity = incomplete[i];

      // Double-check completion before working on it (state may have changed)
      if (Z.checkCompletion(activity.element)) {
        completedCount++;
        Z.sendProgress(completedCount, totalCount, `${activity.type} already done, skipping`, 'info');
        continue;
      }

      const msg = `Working on ${activity.type} (${completedCount + 1}/${totalCount})`;
      Z.sendProgress(completedCount + 1, totalCount, msg);
      updateOverlay(msg);

      activity.element.classList.add('zyagent-highlight');
      activity.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await Z.sleep(800); // slightly longer wait for scroll + render

      try {
        await handleActivity(activity, settings);
        activity.element.classList.remove('zyagent-highlight');

        // Wait for zyBooks to process the submission and update the DOM
        await Z.sleep(1500);

        if (Z.checkCompletion(activity.element)) {
          completedCount++;
          activity.element.classList.add('zyagent-completed');
          Z.sendProgress(completedCount, totalCount, `Completed ${activity.type} (${completedCount}/${totalCount})`, 'success');
        } else {
          Z.sendProgress(completedCount + 1, totalCount, `Finished ${activity.type} — may not be fully complete`, 'warn');
        }
      } catch (err) {
        Z.sendProgress(completedCount + 1, totalCount, `Error on ${activity.type}: ${err.message}`, 'error');
        activity.element.classList.remove('zyagent-highlight');
        console.error('[ZyAgent] Handler error:', err);
      }

      // Delay between activities
      await Z.sleep(settings.delay * 1000);

      // Re-scan after every 3 activities to pick up newly rendered elements
      if ((i + 1) % 3 === 0 && i + 1 < incomplete.length) {
        Z.scanActivities();
        const freshActivities = Z.activities || [];
        const freshIncomplete = freshActivities.filter(a => !a.completed);

        // Merge any newly discovered activities that aren't in our existing list
        const existingElements = new Set(incomplete.map(a => a.element));
        for (const fresh of freshIncomplete) {
          if (!existingElements.has(fresh.element)) {
            incomplete.push(fresh);
            existingElements.add(fresh.element);
          }
        }
      }
    }

    // Final re-scan to report accurate completion
    await Z.sleep(1000);
    Z.scanActivities();
    const finalActivities = Z.activities || [];
    const remaining = finalActivities.filter(a => !a.completed);
    if (remaining.length > 0) {
      Z.sendProgress(completedCount, totalCount, `Done. ${remaining.length} activity(s) may still be incomplete.`, 'warn');
    } else {
      Z.sendProgress(totalCount, totalCount, 'All activities completed!', 'success');
    }

    chrome.runtime.sendMessage({ type: 'done' });
    hideOverlay();
    Z.isRunning = false;
    Z.shouldStop = false;
  }

})();
