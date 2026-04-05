// ─── ZyBook Agent — Short Answer Handler ───
// Handles short-answer / fill-in-the-blank activities.
// Supports single-question and multi-question (question-set) layouts.
// Strategy: Try "Show Answer" button first (forfeit), else use AI.

(function () {
  'use strict';

  const Z = window.ZyAgent;

  /**
   * Solve a single short-answer sub-question element.
   * @param {HTMLElement} questionEl - The .question-set-question or activity root
   * @param {HTMLElement} activityEl - The top-level activity element (for context)
   * @param {object} settings
   * @param {string} globalInstructions - Instructions from the activity header
   * @returns {boolean} true if answered successfully
   */
  async function solveSingleQuestion(questionEl, activityEl, settings, globalInstructions) {
    // ── Skip if already completed ──
    const chevron = questionEl.querySelector('.question-chevron.zb-chevron');
    if (chevron) {
      const label = (chevron.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('completed') && !label.includes('not completed')) {
        console.log('[ZyAgent] Short answer: sub-question already completed, skipping');
        return true;
      }
    }

    // ── Read question text and code context ──
    const setupEl = questionEl.querySelector('.setup .text, .question-text, .question-body');
    const questionText = setupEl ? setupEl.innerText.trim() : '';

    // Read code context around the input (the <pre> block with syntax highlighting)
    const preEl = questionEl.querySelector('pre, .highlight');
    const codeContext = preEl ? preEl.innerText.trim() : '';

    // Find the input field(s) within this sub-question
    const inputs = Array.from(questionEl.querySelectorAll(
      'input[type="text"]:not([disabled]), input.zb-input:not([disabled]), textarea:not([disabled])'
    ));

    if (inputs.length === 0) {
      console.warn('[ZyAgent] Short answer: no input fields found in sub-question');
      return false;
    }

    // ── Strategy 1: Try "Show Answer" / forfeit button ──
    const showAnswerBtn = questionEl.querySelector('button.show-answer-button:not([disabled]), button.forfeit-button:not([disabled])');
    if (showAnswerBtn) {
      showAnswerBtn.click();
      await Z.sleep(800);

      // Check if answer was immediately revealed (some zyBooks versions auto-complete on Show Answer)
      let forfeitEl = questionEl.querySelector('.forfeit-answer, .zb-explanation .answer');

      if (!forfeitEl) {
        // zyBooks may show a confirmation dialog — try clicking again
        const confirmBtn = questionEl.querySelector('button.show-answer-button:not([disabled]), button.forfeit-button:not([disabled])');
        if (confirmBtn) {
          confirmBtn.click();
          await Z.sleep(800);
          forfeitEl = questionEl.querySelector('.forfeit-answer, .zb-explanation .answer');
        }
      }

      // Check if "Show Answer" already marked the question as complete
      const chevronAfterShow = questionEl.querySelector('.question-chevron.zb-chevron');
      if (chevronAfterShow) {
        const labelAfter = (chevronAfterShow.getAttribute('aria-label') || '').toLowerCase();
        if (labelAfter.includes('completed') && !labelAfter.includes('not completed')) {
          console.log('[ZyAgent] Short answer: Show Answer completed the sub-question');
          return true;
        }
      }

      if (forfeitEl) {
        const answerText = forfeitEl.innerText.trim();
        if (answerText && inputs.length === 1) {
          Z.setNativeValue(inputs[0], answerText);
          await Z.sleep(300);

          // Click the Check button for this specific sub-question
          const checkBtn = questionEl.querySelector('button.check-button:not([disabled])');
          if (checkBtn) {
            checkBtn.click();
            await Z.sleep(1000);
          }
          return true;
        }
      }
    }

    // ── Strategy 2: Use AI ──
    const fullContext = [
      globalInstructions ? `Activity instructions: ${globalInstructions}` : '',
      questionText ? `Question: ${questionText}` : '',
      codeContext ? `Code context:\n${codeContext}` : ''
    ].filter(Boolean).join('\n\n');

    if (inputs.length === 1) {
      // Single input field
      const maxRetries = 2;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const isRetry = attempt > 0;

        // Read any feedback from previous attempt
        let feedbackText = '';
        if (isRetry) {
          const explanationEl = questionEl.querySelector('.zb-explanation');
          if (explanationEl) feedbackText = explanationEl.innerText.trim();
        }

        const prompt = [
          {
            role: 'system',
            content: `You are an expert Python programming tutor helping with a zyBooks assignment.
Answer the question as concisely as possible. Give ONLY the answer, no explanation.
If it asks for a Python expression or value, give the exact expression or value.
Keep answers very short — typically one word, number, or short phrase.
Do NOT include quotes unless they are part of the answer.
${isRetry ? `Your previous answer was WRONG. ${feedbackText ? 'Feedback: ' + feedbackText : 'Think more carefully.'}` : ''}`
          },
          {
            role: 'user',
            content: `${fullContext}\n\nProvide ONLY the answer for the input field, nothing else.`
          }
        ];

        const answer = await Z.callAI(settings, prompt);
        const cleanAnswer = answer.trim().replace(/^["']|["']$/g, ''); // strip wrapping quotes
        Z.setNativeValue(inputs[0], cleanAnswer);
        await Z.sleep(300);

        // Click the Check button for this specific sub-question
        const checkBtn = questionEl.querySelector('button.check-button:not([disabled])');
        if (checkBtn) {
          checkBtn.click();
          await Z.sleep(1200);

          // Check if this sub-question is now completed
          const chevronAfter = questionEl.querySelector('.question-chevron.zb-chevron');
          if (chevronAfter) {
            const label = (chevronAfter.getAttribute('aria-label') || '').toLowerCase();
            if (label.includes('completed') && !label.includes('not completed')) {
              return true;
            }
          }

          // Check for correct explanation
          const explanation = questionEl.querySelector('.zb-explanation.correct');
          if (explanation) return true;

          // Check for incorrect — retry if possible
          const incorrect = questionEl.querySelector('.zb-explanation.incorrect, .zb-explanation:not(.correct):not(:empty)');
          if (incorrect && attempt < maxRetries - 1) {
            console.log('[ZyAgent] Short answer: attempt', attempt + 1, 'incorrect, retrying...');
            Z.sendProgress(0, 0, `Short answer attempt ${attempt + 1} incorrect, retrying...`, 'warn');
            continue;
          }
        }
        break;
      }
    } else {
      // Multiple input fields within a single sub-question
      const blanksContext = inputs.map((inp, i) => {
        const container = inp.closest('.zb-input-container') || inp.parentElement;
        const surrounding = container?.parentElement?.innerText?.substring(0, 200) || '';
        return `Blank ${i + 1} (context: "${surrounding}")`;
      });

      const prompt = [
        {
          role: 'system',
          content: `You are an expert Python tutor. Fill in the blanks in a zyBooks exercise.
Return ONLY the answers, one per line, numbered. Example:
1) answer1
2) answer2
Do NOT include quotes unless they are part of the answer.`
        },
        {
          role: 'user',
          content: `${fullContext}\n\nBlanks:\n${blanksContext.join('\n')}\n\nProvide the answer for each blank, one per line, numbered.`
        }
      ];

      const response = await Z.callAI(settings, prompt);
      const answers = response.split('\n')
        .map(line => line.replace(/^\d+[\).\s]+/, '').trim())
        .filter(line => line.length > 0);

      for (let i = 0; i < Math.min(inputs.length, answers.length); i++) {
        const cleanAnswer = answers[i].replace(/^["']|["']$/g, '');
        Z.setNativeValue(inputs[i], cleanAnswer);
        await Z.sleep(200);
      }

      // Click Check for this sub-question
      const checkBtn = questionEl.querySelector('button.check-button:not([disabled])');
      if (checkBtn) {
        checkBtn.click();
        await Z.sleep(1200);
      }
    }

    return false; // Couldn't confirm completion
  }

  // ════════════════════════════════════════════════════════════
  //  MAIN ENTRY POINT
  // ════════════════════════════════════════════════════════════
  Z.handleShortAnswer = async function (activity, settings) {
    const el = activity.element;

    if (Z.checkCompletion(el)) {
      Z.sendProgress(0, 0, `Short answer "${activity.title}" already completed, skipping`, 'info');
      return;
    }

    // Read global activity instructions
    const instrEl = el.querySelector('.activity-instructions');
    const globalInstructions = instrEl ? instrEl.innerText.trim() : '';

    // ── Detect multi-question layout (question-set) ──
    const subQuestions = el.querySelectorAll('.question-set-question');

    if (subQuestions.length > 1) {
      // Multi-question set — iterate each sub-question individually
      console.log(`[ZyAgent] Short answer: detected ${subQuestions.length} sub-questions`);
      const totalQs = subQuestions.length;

      for (let qi = 0; qi < totalQs; qi++) {
        if (Z.shouldStop) break;

        // Check if the whole activity is already done
        if (Z.checkCompletion(el)) {
          Z.sendProgress(totalQs, totalQs, `Short answer "${activity.title}" completed!`, 'success');
          return;
        }

        const subQ = subQuestions[qi];
        Z.sendProgress(qi + 1, totalQs, `Question ${qi + 1}/${totalQs}`);

        await solveSingleQuestion(subQ, el, settings, globalInstructions);
        await Z.sleep(500);
      }

      // Final completion check
      if (Z.checkCompletion(el)) {
        Z.sendProgress(totalQs, totalQs, `Short answer "${activity.title}" completed!`, 'success');
      }

    } else if (subQuestions.length === 1) {
      // Single sub-question in a wrapper
      await solveSingleQuestion(subQuestions[0], el, settings, globalInstructions);

    } else {
      // No .question-set-question wrapper — treat the activity element itself as the question
      // (legacy layout or non-standard structure)
      await solveSingleQuestion(el, el, settings, globalInstructions);
    }
  };

})();
