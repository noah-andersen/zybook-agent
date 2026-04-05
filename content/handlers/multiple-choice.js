// ─── ZyBook Agent — Multiple Choice Handler ───
// Handles multiple-choice-content-resource activities.
// A single MC container can hold MULTIPLE sub-questions (.question-set-question).

(function () {
  'use strict';

  const Z = window.ZyAgent;

  Z.handleMultipleChoice = async function (activity, settings) {
    const el = activity.element;

    if (Z.checkCompletion(el)) {
      Z.sendProgress(0, 0, `MC "${activity.title}" already completed, skipping`, 'info');
      return;
    }

    // Get activity-level instructions/context
    const instructionsEl = el.querySelector('.activity-instructions');
    const activityInstructions = instructionsEl ? instructionsEl.innerText.trim() : '';

    // Find all sub-questions
    const subQuestions = el.querySelectorAll('.question-set-question');

    if (subQuestions.length > 0) {
      for (let q = 0; q < subQuestions.length; q++) {
        if (Z.shouldStop) break;
        const questionEl = subQuestions[q];

        // Check if this individual question is already completed
        const qChevron = questionEl.querySelector('.question-chevron.zb-chevron');
        if (qChevron) {
          const label = (qChevron.getAttribute('aria-label') || '').toLowerCase();
          if (label.includes('completed') && !label.includes('not completed')) continue;
          if (qChevron.classList.contains('check') && !qChevron.classList.contains('chevron-outline')) continue;
        }

        await handleSingleMCQuestion(questionEl, activityInstructions, settings);
        await Z.sleep(500);
      }
    } else {
      // Fallback: treat the whole element as a single MC question
      await handleSingleMCQuestion(el, activityInstructions, settings);
    }
  };

  // ─── Handle one sub-question ───
  async function handleSingleMCQuestion(questionEl, contextInstructions, settings) {
    // Extract question text
    const setupEl = questionEl.querySelector('.setup .text, .question-text, .question-body, .forfeit-question, .question-stem');
    const labelEl = questionEl.querySelector('.setup .label');
    const question = setupEl ? setupEl.innerText.trim() : questionEl.innerText.substring(0, 800);
    const questionLabel = labelEl ? labelEl.innerText.trim() : '';

    // Extract choices from .zb-radio-button containers
    const choicesContainer = questionEl.querySelector('.question-choices');
    const choices = [];

    if (choicesContainer) {
      choicesContainer.querySelectorAll('.zb-radio-button').forEach((rb, idx) => {
        const input = rb.querySelector('input[type="radio"]');
        const label = rb.querySelector('label');
        if (input && label) {
          choices.push({
            index: idx,
            text: label.innerText.trim(),
            element: input,
            labelElement: label
          });
        }
      });
    }

    // Fallback 1: look for any radio inputs within the question
    if (choices.length === 0) {
      questionEl.querySelectorAll('.zb-radio-button input, input[type="radio"]').forEach((input, idx) => {
        const label = input.closest('.zb-radio-button')?.querySelector('label') ||
                      input.closest('label') || input.parentElement;
        choices.push({
          index: idx,
          text: label.innerText.trim(),
          element: input,
          labelElement: label
        });
      });
    }

    // Fallback 2: look for .answer or .choice containers (some zyBooks use these)
    if (choices.length === 0) {
      questionEl.querySelectorAll('.answer, .choice, .mc-option, [class*="choice"], [class*="answer"]').forEach((choiceEl, idx) => {
        const input = choiceEl.querySelector('input[type="radio"], input[type="checkbox"]');
        const label = choiceEl.querySelector('label') || choiceEl;
        if (input) {
          choices.push({
            index: idx,
            text: label.innerText.trim(),
            element: input,
            labelElement: label
          });
        }
      });
    }

    // Fallback 3: look inside the broader container for any clickable options
    if (choices.length === 0) {
      const parentEl = questionEl.closest('.interactive-activity-container') || questionEl;
      parentEl.querySelectorAll('.zb-radio-button, input[type="radio"]').forEach((item, idx) => {
        const input = item.tagName === 'INPUT' ? item : item.querySelector('input[type="radio"]');
        const label = item.tagName === 'INPUT'
          ? (item.closest('label') || item.parentElement)
          : (item.querySelector('label') || item);
        if (input) {
          choices.push({
            index: idx,
            text: label.innerText.trim(),
            element: input,
            labelElement: label
          });
        }
      });
    }

    if (choices.length === 0) {
      Z.sendProgress(0, 0, `No choices found for question ${questionLabel}`, 'warn');
      return;
    }

    // Build context and ask AI
    const fullContext = contextInstructions ? `Context: ${contextInstructions}\n\n` : '';
    const prompt = Z.buildMCPrompt(`${fullContext}${questionLabel} ${question}`, choices);
    const response = await Z.callAI(settings, prompt);
    let answerIndex = Z.parseMCAnswer(response, choices);

    if (answerIndex !== null && answerIndex < choices.length) {
      choices[answerIndex].element.click();
      await Z.sleep(1000); // give zyBooks time to render the explanation

      // Check correctness via the explanation area
      const explanation = questionEl.querySelector('.zb-explanation');
      const isIncorrect = explanation && (
        explanation.classList.contains('incorrect') ||
        explanation.querySelector('.incorrect') ||
        explanation.innerText.toLowerCase().includes('incorrect')
      );

      if (isIncorrect) {
        Z.sendProgress(0, 0, `Question ${questionLabel}: wrong, trying alternatives...`, 'warn');
        // Try remaining options with proper waits
        for (let i = 0; i < choices.length; i++) {
          if (i === answerIndex || Z.shouldStop) continue;

          // Re-query the radio button in case DOM has changed
          const freshChoices = questionEl.querySelectorAll('.zb-radio-button input[type="radio"], input[type="radio"]');
          const targetRadio = freshChoices[i];
          if (!targetRadio) continue;

          targetRadio.click();
          await Z.sleep(1200); // longer wait for DOM to update after click

          // Re-check — need to re-query since DOM may have changed
          const freshExplanation = questionEl.querySelector('.zb-explanation');
          const stillBad = freshExplanation && (
            freshExplanation.classList.contains('incorrect') ||
            freshExplanation.querySelector('.incorrect') ||
            freshExplanation.innerText.toLowerCase().includes('incorrect')
          );
          if (!stillBad) {
            Z.sendProgress(0, 0, `Question ${questionLabel}: found correct answer`, 'success');
            break;
          }
        }
      } else {
        Z.sendProgress(0, 0, `Question ${questionLabel}: answered`, 'success');
      }
    }
  }

})();
