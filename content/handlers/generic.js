// ─── ZyBook Agent — Generic / Fallback Handler ───
// Handles activity types that don't have a dedicated handler.
// Strategy: Try to detect interactive elements, use AI to decide what to do.

(function () {
  'use strict';

  const Z = window.ZyAgent;

  Z.handleGenericActivity = async function (activity, settings) {
    const el = activity.element;

    // Gather context about what's on screen
    const text = el.innerText.substring(0, 1200);
    const buttons = el.querySelectorAll('button:not(:disabled)');
    const inputs = el.querySelectorAll('input:not(:disabled), textarea, select');
    const checkboxes = el.querySelectorAll('input[type="checkbox"]:not(:checked)');
    const radioButtons = el.querySelectorAll('.zb-radio-button, input[type="radio"]');

    // 1) If it looks like a multiple-choice, treat it as one
    if (radioButtons.length > 0) {
      const questionText = el.querySelector('.question-text, .question-body, p')?.innerText?.trim() || text.substring(0, 600);
      const choices = Array.from(radioButtons).map((rb, i) => {
        const label = rb.querySelector('label') || rb.closest('label') || rb.parentElement;
        return { index: i, text: label.innerText.trim(), element: rb };
      });
      const mcPrompt = Z.buildMCPrompt(questionText, choices);
      if (mcPrompt) {
        const response = await Z.callAI(settings, mcPrompt);
        const choiceIdx = Z.parseMCAnswer(response, choices);
        if (choiceIdx !== null && choiceIdx < choices.length) {
          choices[choiceIdx].element.click();
          await Z.sleep(300);
          await Z.clickSubmitButton(el);
          return;
        }
      }
    }

    // 2) If there are checkboxes, try to check them intelligently
    if (checkboxes.length > 0) {
      const prompt = [
        {
          role: 'system',
          content: `You are an expert Python tutor. Given a zyBooks exercise, decide which checkboxes should be checked.
Return ONLY a comma-separated list of 1-based checkbox numbers.
Example: 1, 3, 4`
        },
        {
          role: 'user',
          content: `Exercise:\n${text}\n\nThere are ${checkboxes.length} checkboxes. Which should be checked?`
        }
      ];
      const response = await Z.callAI(settings, prompt);
      const indices = response.match(/\d+/g);
      if (indices) {
        for (const idx of indices) {
          const cb = checkboxes[parseInt(idx) - 1];
          if (cb) { cb.click(); await Z.sleep(200); }
        }
        await Z.sleep(300);
        await Z.clickSubmitButton(el);
        return;
      }
    }

    // 3) If there are text inputs, try to fill them
    if (inputs.length > 0) {
      const prompt = [
        {
          role: 'system',
          content: `You are an expert Python tutor. Fill in the input fields for this zyBooks exercise.
Return answers one per line, numbered. Example:
1) answer1
2) answer2`
        },
        {
          role: 'user',
          content: `Exercise:\n${text}\n\nThere are ${inputs.length} input field(s). What should go in each?`
        }
      ];
      const response = await Z.callAI(settings, prompt);
      const answers = response.split('\n')
        .map(line => line.replace(/^\d+[\).\s]+/, '').trim())
        .filter(l => l.length > 0);

      for (let i = 0; i < Math.min(inputs.length, answers.length); i++) {
        Z.setNativeValue(inputs[i], answers[i]);
        await Z.sleep(200);
      }
      await Z.sleep(300);
      await Z.clickSubmitButton(el);
      return;
    }

    // 4) Last resort — just click buttons
    if (buttons.length > 0) {
      Z.sendProgress(0, 0, 'Trying button clicks for generic activity');
      for (const btn of buttons) {
        if (Z.checkCompletion(el)) break;
        btn.click();
        await Z.sleep(600);
      }
    } else {
      Z.sendProgress(0, 0, `No interactive elements found for "${activity.type}"`, 'warn');
    }
  };

})();
