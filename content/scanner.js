// ─── ZyBook Agent — Activity Scanner ───
// Detects and classifies all interactive activities on the current zyBooks page.

(function () {
  'use strict';

  const Z = window.ZyAgent;

  // ─── Check if a single activity element is completed ───
  // IMPORTANT: Only checks actual zyBooks completion indicators.
  // Does NOT use our own 'zyagent-completed' class (that's cosmetic only).
  Z.checkCompletion = function (el) {
    // 1. Check the title-bar completion chevron (activity-level indicator).
    //    Completed: <div aria-label="Activity completed" class="... zb-chevron check orange filled ...">
    //    Not completed: <div aria-label="Activity not completed" class="... zb-chevron grey chevron-outline ...">
    const titleChevron = el.querySelector('.title-bar-chevron.zb-chevron');
    if (titleChevron) {
      const ariaLabel = (titleChevron.getAttribute('aria-label') || '').toLowerCase();
      if (ariaLabel.includes('not completed')) return false;
      if (ariaLabel.includes('completed')) return true;
      // Fallback: "check" class WITHOUT "chevron-outline" = completed
      if (titleChevron.classList.contains('check') && !titleChevron.classList.contains('chevron-outline')) return true;
      // If it has "chevron-outline" and "grey", it's not completed
      if (titleChevron.classList.contains('chevron-outline')) return false;
    }

    // 2. For question-set-question elements (individual sub-questions):
    const questionChevron = el.querySelector('.question-chevron.zb-chevron');
    if (questionChevron) {
      const ariaLabel = (questionChevron.getAttribute('aria-label') || '').toLowerCase();
      if (ariaLabel.includes('not completed')) return false;
      if (ariaLabel.includes('completed')) return true;
      if (questionChevron.classList.contains('check') && !questionChevron.classList.contains('chevron-outline')) return true;
      if (questionChevron.classList.contains('chevron-outline')) return false;
    }

    // 3. For MC containers with multiple sub-questions, check if ALL sub-question chevrons are completed.
    const questionChevrons = el.querySelectorAll('.question-chevron.zb-chevron');
    if (questionChevrons.length > 0) {
      const allComplete = Array.from(questionChevrons).every(ch => {
        const label = (ch.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('not completed')) return false;
        if (label.includes('completed')) return true;
        return ch.classList.contains('check') && !ch.classList.contains('chevron-outline');
      });
      return allComplete;
    }

    // 4. Other completion indicators
    if (el.querySelector('.zb-check-mark, .zb-check-mark-svg, .checkmark')) return true;
    if (el.querySelector('.forfeit-answer')) return true;
    if (el.classList.contains('completed')) return true;

    // 5. Lab score-based completion (e.g., "10 / 10")
    const labScore = el.querySelector('.lab-score');
    if (labScore) {
      const scoreMatch = labScore.innerText.trim().match(/(\d+)\s*\/\s*(\d+)/);
      if (scoreMatch && parseInt(scoreMatch[1]) >= parseInt(scoreMatch[2])) return true;
    }

    const progressEl = el.querySelector('.progress-bar-complete, .activity-progress');
    if (progressEl && progressEl.style.width === '100%') return true;

    return false;
  };

  // ─── Scan all activities on the page ───
  Z.scanActivities = function () {
    const activities = [];
    const seen = new Set();

    function addActivity(type, el, extra = {}) {
      if (seen.has(el)) return;
      seen.add(el);
      const isComplete = Z.checkCompletion(el);
      const titleEl = el.querySelector('.activity-title');
      const title = titleEl ? titleEl.innerText.trim() : '';
      activities.push({
        type,
        element: el,
        index: activities.length,
        completed: isComplete,
        title,
        id: el.getAttribute('content_resource_id') || el.getAttribute('data-id') || el.id || `${type}-${activities.length}`,
        ...extra
      });
    }

    // ── Primary: classify each .interactive-activity-container by its CSS classes ──
    // zyBooks wraps EVERY interactive activity in .interactive-activity-container.
    // The actual type is on the SAME element as an additional class:
    //   - animation-player-content-resource  → animation
    //   - content-tool-content-resource + .animation-player inside → animation (participation animations)
    //   - content-tool-content-resource + .challenge → challenge (multi-level code)
    //   - multiple-choice-content-resource    → multiple choice
    //   - short-answer-content-resource       → short answer
    //   - content-tool-content-resource       → interactive tools (array games)
    //   - matching-content-resource           → matching
    document.querySelectorAll('.interactive-activity-container').forEach(el => {
      // Skip collapsed/hidden containers that aren't rendered yet
      if (el.offsetParent === null && el.style.display === 'none') return;

      // Lab activities: .zystudio-content-resource WITH .lab class
      // Must be checked BEFORE other types since labs also contain iframes.
      if (el.classList.contains('lab') && el.classList.contains('zystudio-content-resource')) {
        addActivity('lab', el);
        return;
      }
      // Also detect labs by looking for ZyStudio iframe + "Submit for grading" button
      if (el.querySelector('iframe[src*="zystudio"]') &&
          Array.from(el.querySelectorAll('button.zb-button')).some(b =>
            b.textContent.toLowerCase().includes('submit') && b.textContent.toLowerCase().includes('grading')
          )) {
        addActivity('lab', el);
        return;
      }

      // Challenge activities: content-tool-content-resource WITH .challenge class
      // Must be checked BEFORE generic content-tool since it shares that class.
      // Also check for zyante-progression elements which are another form of challenge.
      if (el.classList.contains('challenge') &&
          (el.classList.contains('content-tool-content-resource') ||
           el.querySelector(':scope > .activity-payload .content-tool-content-resource'))) {
        addActivity('challenge', el);

      } else if (el.querySelector('.zyante-progression-start-button, .zyante-progression-check-button') &&
                 !el.classList.contains('animation-player-content-resource')) {
        // zyante-progression that isn't an animation → challenge
        addActivity('challenge', el);

      // Animations: either has .animation-player-content-resource class,
      // OR is a content-tool that wraps an .animation-player (common for participation animations)
      } else if (el.classList.contains('animation-player-content-resource') ||
          el.querySelector(':scope > .activity-payload .animation-player-content-resource') ||
          el.querySelector('.animation-player')) {
        addActivity('animation', el);

      } else if (el.classList.contains('multiple-choice-content-resource') ||
                 el.querySelector(':scope > .activity-payload .multiple-choice-content-resource, :scope > .activity-payload .multiple-choice-payload')) {
        addActivity('multiple-choice', el);
      } else if (el.classList.contains('short-answer-content-resource') ||
                 el.querySelector(':scope > .activity-payload .short-answer-content-resource')) {
        addActivity('short-answer', el);
      } else if (el.classList.contains('content-tool-content-resource') ||
                 el.querySelector(':scope > .activity-payload .content-tool-content-resource, :scope > .activity-payload .content-tool-resource-payload') ||
                 el.querySelector(':scope > .activity-payload .custom-tool-container')) {
        addActivity('content-tool', el);
      } else if (el.classList.contains('matching-content-resource') ||
                 el.querySelector(':scope > .activity-payload .matching-content-resource')) {
        addActivity('matching', el);
      } else if (el.querySelector('.ace_editor, .zyDE-editor, textarea.code-input, .CodeMirror, .zyDE')) {
        addActivity('coding', el);
      } else if (el.querySelector('.question-set-question')) {
        addActivity('multiple-choice', el);
      } else if (el.querySelector('.animation-canvas, .zyAnimator')) {
        addActivity('animation', el);
      } else {
        addActivity('custom-interaction', el);
      }
    });

    // ── Standalone elements not inside .interactive-activity-container ──
    document.querySelectorAll('.question-set-question').forEach(el => {
      if (seen.has(el)) return;
      const parent = el.closest('.interactive-activity-container');
      if (parent && seen.has(parent)) return;
      addActivity('multiple-choice', el);
    });

    document.querySelectorAll('.short-answer-activity').forEach(el => {
      if (!seen.has(el)) addActivity('short-answer', el);
    });

    document.querySelectorAll('.definition-activity').forEach(el => {
      if (!seen.has(el)) addActivity('short-answer', el);
    });

    document.querySelectorAll('.true-false-activity').forEach(el => {
      if (!seen.has(el)) addActivity('true-false', el);
    });

    document.querySelectorAll('.zyDE').forEach(el => {
      if (!seen.has(el)) addActivity('coding', el);
    });

    document.querySelectorAll('.matching-activity').forEach(el => {
      if (!seen.has(el)) addActivity('matching', el);
    });

    document.querySelectorAll('.participation-activity').forEach(el => {
      if (!seen.has(el)) addActivity('participation', el);
    });

    Z.activities = activities;
    return activities.map(a => ({ type: a.type, completed: a.completed, id: a.id, title: a.title }));
  };

})();
